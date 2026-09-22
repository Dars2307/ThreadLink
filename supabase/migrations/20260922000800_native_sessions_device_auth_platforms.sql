-- Phase 6.5: existing Claude Code session attachment, device authorization for
-- the bridge, OAuth client platform classification, agent-reported failure reasons.
--
-- Security notes
-- * Native provider session IDs are adapter METADATA. tlses_ stays canonical and
--   nothing routes or authorizes by a native ID.
-- * Platform labels are never taken from client-supplied names. OAuth clients are
--   classified from their registered redirect URIs: authorization codes can only be
--   delivered to those URIs, so only the real provider can complete that flow.
-- * Device authorization (RFC 8628 shape): the bridge never sees a Clerk session;
--   a signed-in human approves a short user code in the browser, the bridge redeems
--   its (hashed) device code for a fresh claude-code/agent credential.

-- ===========================================================================
-- 1. Platforms
-- ===========================================================================
alter table public.connections drop constraint connections_platform_check;
alter table public.connections add constraint connections_platform_check
  check (platform in ('chatgpt', 'claude-desktop', 'claude-code', 'generic-mcp'));

-- Agents are Claude Code bridges; every other platform is a controller.
alter table public.connections add constraint connections_platform_role_check
  check ((platform = 'claude-code') = (role = 'agent')) not valid;

create function threadlink_private.classify_oauth_platform(p_redirect_uris text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when bool_and(h in ('chatgpt.com', 'chat.openai.com')) then 'chatgpt'
    when bool_and(h in ('claude.ai', 'claude.com')) then 'claude-desktop'
    else 'generic-mcp'
  end
  from (
    select lower(substring(u from '^https://([^/:]+)')) as h
    from pg_catalog.unnest(p_redirect_uris) as u
  ) hosts
$$;
revoke all on function threadlink_private.classify_oauth_platform(text[]) from public;

alter table public.oauth_clients add column platform text not null default 'generic-mcp'
  constraint oauth_clients_platform_check check (platform in ('chatgpt', 'claude-desktop', 'generic-mcp'));
update public.oauth_clients set platform = threadlink_private.classify_oauth_platform(redirect_uris);

-- Reclassify existing OAuth-created connections (Phase 6 stored all of them as
-- chatgpt). Platform is otherwise immutable; this one-off correction is audited.
alter table public.connections disable trigger connections_guard_update;
with changed as (
  update public.connections c
  set platform = oc.platform
  from public.oauth_clients oc
  where c.oauth_client_id = oc.id and c.platform <> oc.platform
  returning c.id, c.owner_user_id, c.platform
)
insert into public.audit_events (owner_user_id, actor_connection_id, action, resource_type, resource_id, outcome, metadata)
select owner_user_id, null, 'connection.reclassified', 'connection', id, 'success',
       jsonb_build_object('platform', platform, 'reason', 'oauth redirect classification')
from changed;
alter table public.connections enable trigger connections_guard_update;

alter table public.connections validate constraint connections_platform_role_check;

-- ===========================================================================
-- 2. Audit actions
-- ===========================================================================
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created', 'connection.revoked', 'connection.credential_rotated', 'connection.auth_failed',
  'connection.reclassified',
  'session.registered', 'session.retired', 'session.revoked', 'session.native_attached',
  'link.requested', 'link.approved', 'link.revoked',
  'task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired',
  'task.requeued', 'oauth.token_issued', 'device.approved', 'device.denied'
));

-- ===========================================================================
-- 3. OAuth: classify at registration, use it at exchange
-- ===========================================================================
create or replace function public.register_oauth_client(p_client_name text, p_redirect_uris text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_uri text;
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 5 then
    raise exception 'redirect_uris must contain 1 to 5 entries' using errcode = '22023';
  end if;
  foreach v_uri in array p_redirect_uris loop
    if not threadlink_private.redirect_uri_is_allowed(v_uri) then
      raise exception 'redirect_uri not allowed' using errcode = '22023';
    end if;
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:oauth:register', 0));
  if (select count(*) from public.oauth_clients where created_at > pg_catalog.now() - interval '1 hour') >= 100 then
    raise exception 'client registration rate limit reached' using errcode = '54000';
  end if;
  insert into public.oauth_clients (client_name, redirect_uris, platform)
  values (left(coalesce(nullif(btrim(p_client_name), ''), 'MCP client'), 100), p_redirect_uris,
          threadlink_private.classify_oauth_platform(p_redirect_uris))
  returning id into v_id;
  return jsonb_build_object('client_id', v_id);
end;
$$;

create or replace function public.get_oauth_client(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('client_id', c.id, 'client_name', c.client_name,
                            'redirect_uris', to_jsonb(c.redirect_uris), 'platform', c.platform)
  from public.oauth_clients c
  where c.id = p_client_id and threadlink_private.current_user_id() is not null
$$;

create or replace function public.exchange_oauth_code(
  p_code_hash text,
  p_code_verifier text,
  p_client_id text,
  p_redirect_uri text,
  p_resource text,
  p_token_hash text,
  p_token_prefix text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code public.oauth_authorization_codes;
  v_client public.oauth_clients;
  v_connection_id text;
  v_active integer;
  v_challenge text;
begin
  perform threadlink_private.assert_credential_material(p_token_hash, p_token_prefix);
  if p_code_verifier is null or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then
    raise exception 'invalid_grant' using errcode = '22023';
  end if;

  select * into v_code from public.oauth_authorization_codes where code_hash = p_code_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= pg_catalog.now()
     or v_code.client_id <> p_client_id or v_code.redirect_uri <> p_redirect_uri
     or (v_code.resource is not null and p_resource is not null and v_code.resource <> p_resource) then
    raise exception 'invalid_grant' using errcode = '22023';
  end if;

  v_challenge := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code_verifier, 'UTF8')), 'base64'), '='),
    '+/', '-_');
  if v_challenge <> v_code.code_challenge then
    raise exception 'invalid_grant' using errcode = '22023';
  end if;

  update public.oauth_authorization_codes set used_at = pg_catalog.now() where code_hash = p_code_hash;
  select * into v_client from public.oauth_clients where id = v_code.client_id;

  select id into v_connection_id from public.connections
  where owner_user_id = v_code.owner_user_id and oauth_client_id = v_code.client_id
    and status in ('active', 'idle')
  for update;

  if v_connection_id is not null then
    update public.connection_credentials set revoked_at = pg_catalog.now()
    where connection_id = v_connection_id and revoked_at is null;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:connections:' || v_code.owner_user_id, 0));
    select count(*) into v_active from public.connections
    where owner_user_id = v_code.owner_user_id and status in ('active', 'idle');
    if v_active >= threadlink_private.max_active_connections() then
      raise exception 'active connection limit reached' using errcode = '54000';
    end if;
    insert into public.connections (owner_user_id, platform, role, display_name, oauth_client_id)
    values (v_code.owner_user_id, v_client.platform, 'controller', left(v_client.client_name, 100), v_client.id)
    returning id into v_connection_id;
    perform threadlink_private.record_audit(
      v_code.owner_user_id, null, 'connection.created', v_connection_id, 'success',
      jsonb_build_object('platform', v_client.platform, 'role', 'controller', 'via', 'oauth'));
  end if;

  insert into public.connection_credentials (connection_id, owner_user_id, token_hash, token_prefix)
  values (v_connection_id, v_code.owner_user_id, threadlink_private.credential_digest(p_token_hash), p_token_prefix);

  perform threadlink_private.record_event(
    v_code.owner_user_id, null, 'oauth.token_issued', 'connection', v_connection_id,
    jsonb_build_object('client_id', v_code.client_id));
  return jsonb_build_object('connection_id', v_connection_id);
end;
$$;

-- ===========================================================================
-- 4. Native (provider) session attachment on session bindings
-- ===========================================================================
alter table public.session_bindings
  add column native_provider_session_id text
    constraint session_bindings_native_id_format
      check (native_provider_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  add column native_session_mode text not null default 'fresh'
    constraint session_bindings_native_mode_check check (native_session_mode in ('fresh', 'resume', 'continue')),
  add column workspace_path text
    constraint session_bindings_workspace_path_format
      check (char_length(workspace_path) between 1 and 1024 and workspace_path !~ '[[:cntrl:]]'),
  add column native_attached_at timestamptz,
  add constraint session_bindings_native_mode_consistency
    check ((native_session_mode = 'resume') = (native_provider_session_id is not null));

comment on column public.session_bindings.native_provider_session_id is
  'Adapter metadata (e.g. Claude Code session UUID). Never an identity, lookup or routing key.';

create or replace function threadlink_private.session_json(p_session_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'connection_id', s.connection_id,
    'platform', c.platform,
    'role', c.role,
    'display_name', s.display_name,
    'provider_session_ref', s.provider_session_ref,
    'local_binding_ref', s.local_binding_ref,
    'status', s.status,
    'created_at', s.created_at,
    'last_seen_at', s.last_seen_at,
    'retired_at', s.retired_at,
    'revoked_at', s.revoked_at,
    'native_provider_session_id', s.native_provider_session_id,
    'native_session_mode', s.native_session_mode,
    'workspace_path', s.workspace_path,
    'native_attached_at', s.native_attached_at
  )
  from public.session_bindings as s
  join public.connections as c on c.id = s.connection_id
  where s.id = p_session_id
$$;

-- Agent-only: record which native Claude Code session this tlses_ resumes.
create function public.set_native_session(
  p_token_hash text,
  p_session_id text,
  p_mode text,
  p_native_session_id text,
  p_workspace_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings;
begin
  if v_connection.role <> 'agent' then
    raise exception 'agent connection required' using errcode = '42501';
  end if;
  v_session := threadlink_private.require_own_session(v_connection, p_session_id);
  if not threadlink_private.session_is_usable(v_session.id) then
    raise exception 'session is not active' using errcode = '55000';
  end if;
  if p_mode is null or p_mode not in ('fresh', 'resume', 'continue')
     or ((p_mode = 'resume') <> (p_native_session_id is not null)) then
    raise exception 'invalid native session mode' using errcode = '22023';
  end if;

  update public.session_bindings
  set native_session_mode = p_mode,
      native_provider_session_id = p_native_session_id,
      workspace_path = nullif(btrim(p_workspace_path), ''),
      native_attached_at = case when p_mode = 'resume' then pg_catalog.now() else null end,
      last_seen_at = pg_catalog.now()
  where id = v_session.id;

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'session.native_attached', 'session', v_session.id,
    jsonb_build_object('mode', p_mode));
  return threadlink_private.session_json(v_session.id);
end;
$$;

-- Controller-only: the owner's usable Claude Code sessions this conversation could
-- link to (display name + workspace folder name only; never full paths or native IDs).
create function public.list_agent_sessions(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings;
begin
  if v_connection.role <> 'controller' then
    raise exception 'controller connection required' using errcode = '42501';
  end if;
  v_session := threadlink_private.require_own_session(v_connection, p_session_id);
  perform threadlink_private.touch_session(v_session.id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'display_name', s.display_name,
      'workspace_name', pg_catalog.regexp_replace(s.workspace_path, '^.*[\\/]', ''),
      'native_session_mode', s.native_session_mode,
      'last_seen_at', s.last_seen_at,
      'link_status', (select l.status from public.thread_links l
                      where l.controller_session_id = v_session.id and l.agent_session_id = s.id
                        and l.status in ('pending', 'active') limit 1)
    ) order by s.last_seen_at desc nulls last)
    from public.session_bindings s
    join public.connections c on c.id = s.connection_id and c.owner_user_id = s.owner_user_id
    where s.owner_user_id = v_connection.owner_user_id
      and c.role = 'agent'
      and threadlink_private.session_is_usable(s.id)
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 5. Agent-reported failure reasons (session busy, native session missing)
-- ===========================================================================
alter table public.tasks drop constraint tasks_failure_reason_check;
alter table public.tasks add constraint tasks_failure_reason_check
  check (failure_reason in ('lease_exhausted', 'session_busy', 'native_session_unavailable'));

drop function public.fail_task(text, text, text, text, text);
create function public.fail_task(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text, p_error text,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'agent');
  v_task public.tasks := threadlink_private.require_claimed_task(v_session, p_task_id, p_claim_ref, array['claimed', 'working']);
begin
  if p_failure_reason is not null and p_failure_reason not in ('session_busy', 'native_session_unavailable') then
    raise exception 'invalid failure reason' using errcode = '22023';
  end if;
  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
     message_type, content, in_reply_to)
  values
    (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id, v_task.origin_session_id,
     'error', p_error,
     (select id from public.messages where task_id = v_task.id and message_type = 'task'));
  update public.tasks set status = 'failed', failure_reason = p_failure_reason where id = v_task.id;
  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.failed', 'task', v_task.id,
    case when p_failure_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_failure_reason) end);
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

-- ===========================================================================
-- 6. Device authorization for the Claude Code bridge
-- ===========================================================================
create table public.device_authorizations (
  device_code_hash text primary key
    constraint device_auth_code_hash_format check (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code text not null
    constraint device_auth_user_code_format check (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  display_name text not null
    constraint device_auth_display_name_length check (char_length(display_name) between 1 and 100),
  status text not null default 'pending'
    constraint device_auth_status_check check (status in ('pending', 'approved', 'denied', 'consumed')),
  owner_user_id text references public.users (id) on delete cascade,
  connection_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  decided_at timestamptz,
  consumed_at timestamptz,
  constraint device_auth_owner_consistency check ((status = 'pending') = (owner_user_id is null))
);
comment on table public.device_authorizations is
  'Short-lived bridge sign-in requests. Only sha256(device_code) is stored; the user code is shown in the terminal.';
create unique index device_auth_pending_user_code_idx on public.device_authorizations (user_code)
  where status = 'pending';
create index device_auth_created_idx on public.device_authorizations (created_at);
alter table public.device_authorizations enable row level security;
revoke all on table public.device_authorizations from public, anon, authenticated;

-- Per-user lookup/decision attempts (brute-force limit on user codes).
create table threadlink_private.device_code_attempts (
  owner_user_id text not null references public.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index device_code_attempts_idx on threadlink_private.device_code_attempts (owner_user_id, attempted_at);
revoke all on table threadlink_private.device_code_attempts from public;

create function threadlink_private.note_device_code_attempt(p_owner text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:device-attempts:' || p_owner, 0));
  if (select count(*) from threadlink_private.device_code_attempts
      where owner_user_id = p_owner and attempted_at > pg_catalog.now() - interval '10 minutes') >= 30 then
    raise exception 'too many attempts' using errcode = '54000';
  end if;
  insert into threadlink_private.device_code_attempts (owner_user_id) values (p_owner);
end;
$$;
revoke all on function threadlink_private.note_device_code_attempt(text) from public;

-- Unauthenticated: the bridge starts a request. Globally rate-limited.
create function public.start_device_authorization(p_device_code_hash text, p_user_code text, p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  if p_device_code_hash is null or p_device_code_hash !~ '^[0-9a-f]{64}$'
     or p_user_code is null or p_user_code !~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$' then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:device:start', 0));
  if (select count(*) from public.device_authorizations where created_at > pg_catalog.now() - interval '1 hour') >= 200 then
    raise exception 'device authorization rate limit reached' using errcode = '54000';
  end if;
  insert into public.device_authorizations (device_code_hash, user_code, display_name)
  values (p_device_code_hash, p_user_code,
          left(coalesce(nullif(btrim(p_display_name), ''), 'Claude Code bridge'), 100))
  returning expires_at into v_expires;
  return jsonb_build_object('expires_at', v_expires);
end;
$$;

-- Signed-in human: look up a pending request by the code shown in the terminal.
create function public.get_device_authorization(p_user_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_row public.device_authorizations;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  perform threadlink_private.note_device_code_attempt(v_owner);
  select * into v_row from public.device_authorizations
  where user_code = p_user_code and status = 'pending' and expires_at > pg_catalog.now();
  if not found then
    raise exception 'device code not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('display_name', v_row.display_name, 'expires_at', v_row.expires_at);
end;
$$;

create function public.decide_device_authorization(p_user_code text, p_approve boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_hash text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  perform threadlink_private.note_device_code_attempt(v_owner);
  update public.device_authorizations
  set status = case when p_approve then 'approved' else 'denied' end,
      owner_user_id = v_owner,
      decided_at = pg_catalog.now()
  where user_code = p_user_code and status = 'pending' and expires_at > pg_catalog.now()
  returning device_code_hash into v_hash;
  if v_hash is null then
    raise exception 'device code not found' using errcode = 'P0002';
  end if;
  perform threadlink_private.record_event(v_owner, null,
    case when p_approve then 'device.approved' else 'device.denied' end, 'device_authorization', left(v_hash, 12));
  return jsonb_build_object('status', case when p_approve then 'approved' else 'denied' end);
end;
$$;

-- Unauthenticated: the bridge redeems its device code for a claude-code/agent credential.
create function public.redeem_device_authorization(p_device_code_hash text, p_token_hash text, p_token_prefix text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.device_authorizations;
  v_active integer;
  v_connection_id text;
  v_email text;
begin
  perform threadlink_private.assert_credential_material(p_token_hash, p_token_prefix);
  select * into v_row from public.device_authorizations where device_code_hash = p_device_code_hash for update;
  if not found or v_row.status = 'consumed' then
    raise exception 'invalid_grant' using errcode = '22023';
  end if;
  if v_row.status = 'denied' then
    raise exception 'access_denied' using errcode = 'TLD02';
  end if;
  if v_row.expires_at <= pg_catalog.now() then
    raise exception 'expired_token' using errcode = 'TLD03';
  end if;
  if v_row.status = 'pending' then
    raise exception 'authorization_pending' using errcode = 'TLD01';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:connections:' || v_row.owner_user_id, 0));
  select count(*) into v_active from public.connections
  where owner_user_id = v_row.owner_user_id and status in ('active', 'idle');
  if v_active >= threadlink_private.max_active_connections() then
    raise exception 'active connection limit reached' using errcode = '54000';
  end if;

  insert into public.connections (owner_user_id, platform, role, display_name)
  values (v_row.owner_user_id, 'claude-code', 'agent', v_row.display_name)
  returning id into v_connection_id;
  insert into public.connection_credentials (connection_id, owner_user_id, token_hash, token_prefix)
  values (v_connection_id, v_row.owner_user_id, threadlink_private.credential_digest(p_token_hash), p_token_prefix);
  update public.device_authorizations
  set status = 'consumed', consumed_at = pg_catalog.now(), connection_id = v_connection_id
  where device_code_hash = p_device_code_hash;
  perform threadlink_private.record_audit(
    v_row.owner_user_id, null, 'connection.created', v_connection_id, 'success',
    jsonb_build_object('platform', 'claude-code', 'role', 'agent', 'via', 'device'));

  select primary_email into v_email from public.users where id = v_row.owner_user_id;
  return jsonb_build_object(
    'connection_id', v_connection_id,
    'account_hint', case when v_email is null then null
                         else left(v_email, 1) || '***@' || split_part(v_email, '@', 2) end);
end;
$$;

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================
revoke all on function public.set_native_session(text, text, text, text, text) from public;
revoke all on function public.list_agent_sessions(text, text) from public;
revoke all on function public.fail_task(text, text, text, text, text, text) from public;
revoke all on function public.start_device_authorization(text, text, text) from public;
revoke all on function public.get_device_authorization(text) from public, anon;
revoke all on function public.decide_device_authorization(text, boolean) from public, anon;
revoke all on function public.redeem_device_authorization(text, text, text) from public;

grant execute on function public.set_native_session(text, text, text, text, text) to anon, authenticated;
grant execute on function public.list_agent_sessions(text, text) to anon, authenticated;
grant execute on function public.fail_task(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.start_device_authorization(text, text, text) to anon, authenticated;
grant execute on function public.get_device_authorization(text) to authenticated;
grant execute on function public.decide_device_authorization(text, boolean) to authenticated;
grant execute on function public.redeem_device_authorization(text, text, text) to anon, authenticated;
