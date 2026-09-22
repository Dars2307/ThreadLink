-- ThreadLink Phase 6: claim leases + bounded retries, OAuth for the ChatGPT MCP
-- connector, owner-initiated pairing, controller task listing, Alpha rate limits.

-- ===========================================================================
-- 1. Claim leases and bounded retries
-- ===========================================================================
alter table public.tasks
  add column claimed_until timestamptz,
  add column attempt_count integer not null default 0
    constraint tasks_attempt_count_check check (attempt_count between 0 and 10),
  add column max_attempts integer not null default 3
    constraint tasks_max_attempts_check check (max_attempts between 1 and 10),
  add column failure_reason text
    constraint tasks_failure_reason_check check (failure_reason in ('lease_exhausted'));

create function threadlink_private.task_lease_duration()
returns interval language sql immutable set search_path = '' as $$ select interval '5 minutes' $$;
revoke all on function threadlink_private.task_lease_duration() from public;

-- State machine (replaces Phase 5): adds lease-expiry requeue, monotonic attempts.
create or replace function threadlink_private.tasks_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.thread_link_id is distinct from old.thread_link_id
     or new.origin_session_id is distinct from old.origin_session_id
     or new.target_session_id is distinct from old.target_session_id
     or new.priority is distinct from old.priority
     or new.task_type is distinct from old.task_type
     or new.title is distinct from old.title
     or new.content is distinct from old.content
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at
     or new.max_attempts is distinct from old.max_attempts then
    raise exception 'task identity and payload are immutable' using errcode = '42501';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'attempt count cannot decrease' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('completed', 'failed', 'cancelled', 'expired') then
      raise exception 'task status % is terminal', old.status using errcode = '42501';
    end if;
    if not (
         (old.status = 'queued'  and new.status in ('claimed', 'cancelled', 'expired'))
      or (old.status = 'claimed' and new.status in ('working', 'completed', 'failed', 'cancelled'))
      or (old.status = 'working' and new.status in ('completed', 'failed', 'cancelled'))
      -- Lease expiry: the only way back to queued, and it drops the claim.
      or (old.status in ('claimed', 'working') and new.status = 'queued'
          and old.claimed_until is not null and old.claimed_until <= pg_catalog.now()
          and new.claim_ref is null)
    ) then
      raise exception 'invalid task transition % -> %', old.status, new.status using errcode = '42501';
    end if;
    case new.status
      when 'claimed' then new.claimed_at := pg_catalog.now();
      when 'working' then new.started_at := pg_catalog.now();
      when 'completed' then new.completed_at := pg_catalog.now();
      when 'failed' then new.failed_at := pg_catalog.now();
      when 'cancelled' then new.cancelled_at := pg_catalog.now();
      when 'expired' then new.expired_at := pg_catalog.now();
      when 'queued' then new.claimed_until := null;
      else null;
    end case;
    if new.status in ('completed', 'failed', 'cancelled') then
      new.claimed_until := null;
    end if;
  elsif new.claim_ref is distinct from old.claim_ref then
    raise exception 'task claim cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created', 'connection.revoked', 'connection.credential_rotated', 'connection.auth_failed',
  'session.registered', 'session.retired', 'session.revoked',
  'link.requested', 'link.approved', 'link.revoked',
  'task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired',
  'task.requeued', 'oauth.token_issued'
));

-- Sweep (replaces Phase 5): expiry, route validity, then lease expiry.
create or replace function threadlink_private.sweep_task(p_task_id text)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    return null;
  end if;

  if v_task.status = 'queued' and v_task.expires_at <= pg_catalog.now() then
    update public.tasks set status = 'expired' where id = v_task.id returning * into v_task;
    perform threadlink_private.record_event(v_task.owner_user_id, null, 'task.expired', 'task', v_task.id);
  elsif v_task.status in ('queued', 'claimed', 'working')
        and not threadlink_private.task_route_is_valid(v_task.id) then
    update public.tasks set status = 'cancelled', cancel_reason = 'route_invalid'
    where id = v_task.id returning * into v_task;
    perform threadlink_private.record_event(
      v_task.owner_user_id, null, 'task.cancelled', 'task', v_task.id,
      jsonb_build_object('reason', 'route_invalid'));
  elsif v_task.status in ('claimed', 'working')
        and v_task.claimed_until is not null and v_task.claimed_until <= pg_catalog.now() then
    if v_task.attempt_count >= v_task.max_attempts then
      insert into public.messages
        (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
         message_type, content, in_reply_to)
      values
        (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id,
         v_task.origin_session_id, 'error',
         'Claim lease expired ' || v_task.attempt_count || ' time(s); no worker completed the task.',
         (select id from public.messages where task_id = v_task.id and message_type = 'task'));
      update public.tasks set status = 'failed', failure_reason = 'lease_exhausted'
      where id = v_task.id returning * into v_task;
      perform threadlink_private.record_event(
        v_task.owner_user_id, null, 'task.failed', 'task', v_task.id,
        jsonb_build_object('reason', 'lease_exhausted'));
    else
      update public.tasks set status = 'queued', claim_ref = null
      where id = v_task.id returning * into v_task;
      perform threadlink_private.record_event(
        v_task.owner_user_id, null, 'task.requeued', 'task', v_task.id,
        jsonb_build_object('attempt_count', v_task.attempt_count));
    end if;
  end if;
  return v_task;
end;
$$;

-- Envelope (replaces Phase 5): adds lease/attempt metadata.
create or replace function threadlink_private.task_json(p_task_id text, p_include_content boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'task_id', t.id,
    'message_id', (select m.id from public.messages m where m.task_id = t.id and m.message_type = 'task'),
    'thread_link_id', t.thread_link_id,
    'origin_session_id', t.origin_session_id,
    'target_session_id', t.target_session_id,
    'type', 'task',
    'task_type', t.task_type,
    'priority', t.priority,
    'title', t.title,
    'content', case when p_include_content then t.content end,
    'status', t.status,
    'cancel_reason', t.cancel_reason,
    'failure_reason', t.failure_reason,
    'attempt_count', t.attempt_count,
    'max_attempts', t.max_attempts,
    'claimed_until', t.claimed_until,
    'created_at', t.created_at,
    'claimed_at', t.claimed_at,
    'started_at', t.started_at,
    'completed_at', t.completed_at,
    'failed_at', t.failed_at,
    'cancelled_at', t.cancelled_at,
    'expired_at', t.expired_at,
    'expires_at', t.expires_at
  )
  from public.tasks t
  where t.id = p_task_id
$$;

-- Agent steps renew the lease (replaces Phase 5).
create or replace function threadlink_private.require_claimed_task(
  p_session public.session_bindings,
  p_task_id text,
  p_claim_ref text,
  p_allowed_statuses text[]
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_task public.tasks := threadlink_private.require_target_task(p_session, p_task_id);
begin
  if v_task.status in ('queued', 'claimed', 'working')
     and (v_task.claim_ref is null or v_task.claim_ref is distinct from p_claim_ref) then
    raise exception 'task is not claimed by this worker' using errcode = '55000';
  end if;
  if not (v_task.status = any (p_allowed_statuses)) then
    raise exception 'task is %', v_task.status using errcode = '55000';
  end if;
  update public.tasks
  set claimed_until = pg_catalog.now() + threadlink_private.task_lease_duration()
  where id = v_task.id
  returning * into v_task;
  return v_task;
end;
$$;

-- Claim (replaces Phase 5): grants a lease and counts the attempt.
create or replace function public.claim_task(p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'agent');
  v_task public.tasks;
begin
  if p_claim_ref is null or p_claim_ref !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid claim_ref' using errcode = '22023';
  end if;
  v_task := threadlink_private.require_target_task(v_session, p_task_id);

  if v_task.status in ('claimed', 'working') and v_task.claim_ref = p_claim_ref then
    update public.tasks
    set claimed_until = pg_catalog.now() + threadlink_private.task_lease_duration()
    where id = v_task.id;
    return threadlink_private.task_json(v_task.id, true) || jsonb_build_object('claim_ref', v_task.claim_ref);
  end if;
  if v_task.status <> 'queued' then
    raise exception 'task is not claimable' using errcode = '55000';
  end if;

  update public.tasks
  set status = 'claimed',
      claim_ref = p_claim_ref,
      attempt_count = attempt_count + 1,
      claimed_until = pg_catalog.now() + threadlink_private.task_lease_duration()
  where id = v_task.id;
  update public.messages set delivered_at = coalesce(delivered_at, pg_catalog.now()), read_at = pg_catalog.now()
  where task_id = v_task.id and message_type = 'task' and read_at is null;

  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.claimed', 'task', v_task.id);
  return threadlink_private.task_json(v_task.id, true) || jsonb_build_object('claim_ref', p_claim_ref);
end;
$$;

-- Heartbeat: renew the lease without other side effects.
create function public.renew_task_lease(p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text)
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
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

-- ===========================================================================
-- 2. Alpha rate limits (replaces Phase 4/5 functions with added caps)
-- ===========================================================================
create function threadlink_private.max_tasks_per_window() returns integer
language sql immutable set search_path = '' as $$ select 30 $$;
create function threadlink_private.task_rate_window() returns interval
language sql immutable set search_path = '' as $$ select interval '10 minutes' $$;
create function threadlink_private.max_pending_links_per_session() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
revoke all on function threadlink_private.max_tasks_per_window() from public;
revoke all on function threadlink_private.task_rate_window() from public;
revoke all on function threadlink_private.max_pending_links_per_session() from public;

create or replace function public.create_task(
  p_token_hash text,
  p_origin_session_id text,
  p_thread_link_id text,
  p_title text,
  p_content text,
  p_priority text default 'C',
  p_task_type text default 'general',
  p_idempotency_key text default null,
  p_expires_in_seconds integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_origin public.session_bindings := threadlink_private.require_role_session(v_connection, p_origin_session_id, 'controller');
  v_link public.thread_links;
  v_task_id text;
  v_open integer;
  v_recent integer;
  v_expires_at timestamptz;
begin
  if p_idempotency_key is not null then
    select id into v_task_id from public.tasks
    where owner_user_id = v_connection.owner_user_id
      and origin_session_id = v_origin.id
      and idempotency_key = p_idempotency_key;
    if v_task_id is not null then
      return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', false);
    end if;
  end if;

  select * into v_link from public.thread_links
  where id = p_thread_link_id
    and owner_user_id = v_connection.owner_user_id
    and controller_session_id = v_origin.id
  for share;
  if not found or v_link.status <> 'active'
     or not threadlink_private.session_is_usable(v_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  if p_expires_in_seconds is not null and (p_expires_in_seconds < 60 or p_expires_in_seconds > 604800) then
    raise exception 'expires_in_seconds must be between 60 and 604800' using errcode = '22023';
  end if;
  v_expires_at := pg_catalog.now()
    + coalesce(pg_catalog.make_interval(secs => p_expires_in_seconds), threadlink_private.default_task_ttl());

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:tasks:' || v_link.id, 0));
  select count(*) into v_open from public.tasks
  where thread_link_id = v_link.id and status in ('queued', 'claimed', 'working');
  if v_open >= threadlink_private.max_open_tasks_per_link() then
    raise exception 'open task limit reached for this link' using errcode = '54000';
  end if;
  select count(*) into v_recent from public.tasks
  where origin_session_id = v_origin.id
    and created_at > pg_catalog.now() - threadlink_private.task_rate_window();
  if v_recent >= threadlink_private.max_tasks_per_window() then
    raise exception 'task creation rate limit reached' using errcode = '54000';
  end if;

  insert into public.tasks
    (owner_user_id, thread_link_id, origin_session_id, target_session_id,
     priority, task_type, title, content, idempotency_key, expires_at)
  values
    (v_connection.owner_user_id, v_link.id, v_origin.id, v_link.agent_session_id,
     coalesce(p_priority, 'C'), coalesce(p_task_type, 'general'), p_title, p_content,
     p_idempotency_key, v_expires_at)
  on conflict (owner_user_id, origin_session_id, idempotency_key) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select id into v_task_id from public.tasks
    where owner_user_id = v_connection.owner_user_id
      and origin_session_id = v_origin.id
      and idempotency_key = p_idempotency_key;
    return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', false);
  end if;

  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id, message_type)
  values
    (v_connection.owner_user_id, v_task_id, v_link.id, v_origin.id, v_link.agent_session_id, 'task');

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'task.created', 'task', v_task_id,
    jsonb_build_object('thread_link_id', v_link.id));
  perform threadlink_private.touch_session(v_origin.id);

  return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', true);
end;
$$;

-- Shared pairing validation + insert (used by the controller client and the owner dashboard).
create function threadlink_private.open_pairing_request(
  p_owner text,
  p_actor_connection_id text,
  p_controller_session_id text,
  p_agent_session_id text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link_id text;
  v_pending integer;
begin
  if not exists (
    select 1 from public.session_bindings s join public.connections c on c.id = s.connection_id
    where s.id = p_controller_session_id and s.owner_user_id = p_owner and c.role = 'controller'
  ) or not threadlink_private.session_is_usable(p_controller_session_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.session_bindings s join public.connections c on c.id = s.connection_id
    where s.id = p_agent_session_id and s.owner_user_id = p_owner and c.role = 'agent'
  ) or not threadlink_private.session_is_usable(p_agent_session_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  select id into v_link_id from public.thread_links
  where controller_session_id = p_controller_session_id and agent_session_id = p_agent_session_id
    and status in ('pending', 'active');
  if v_link_id is not null then
    return v_link_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:pairing:' || p_controller_session_id, 0));
  select count(*) into v_pending from public.thread_links
  where controller_session_id = p_controller_session_id and status = 'pending';
  if v_pending >= threadlink_private.max_pending_links_per_session() then
    raise exception 'pending pairing limit reached' using errcode = '54000';
  end if;

  insert into public.thread_links (owner_user_id, controller_session_id, agent_session_id)
  values (p_owner, p_controller_session_id, p_agent_session_id)
  on conflict (controller_session_id, agent_session_id) where status in ('pending', 'active') do nothing
  returning id into v_link_id;

  if v_link_id is null then
    select id into v_link_id from public.thread_links
    where controller_session_id = p_controller_session_id and agent_session_id = p_agent_session_id
      and status in ('pending', 'active');
  else
    perform threadlink_private.record_event(
      p_owner, p_actor_connection_id, 'link.requested', 'thread_link', v_link_id,
      jsonb_build_object('controller_session_id', p_controller_session_id, 'agent_session_id', p_agent_session_id));
  end if;
  return v_link_id;
end;
$$;
revoke all on function threadlink_private.open_pairing_request(text, text, text, text) from public;

create or replace function public.request_pairing(
  p_token_hash text,
  p_controller_session_id text,
  p_agent_session_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_controller public.session_bindings;
  v_link_id text;
begin
  if v_connection.role <> 'controller' then
    raise exception 'controller connection required' using errcode = '42501';
  end if;
  v_controller := threadlink_private.require_own_session(v_connection, p_controller_session_id);
  if not threadlink_private.session_is_usable(v_controller.id) then
    raise exception 'session is not active' using errcode = '55000';
  end if;
  v_link_id := threadlink_private.open_pairing_request(
    v_connection.owner_user_id, v_connection.id, v_controller.id, p_agent_session_id);
  perform threadlink_private.touch_session(v_controller.id);
  return threadlink_private.link_json(v_link_id);
end;
$$;

-- Human owner (Clerk session) opens a pairing from the dashboard. The agent
-- session must still approve: nothing is auto-activated.
create function public.owner_request_pairing(p_controller_session_id text, p_agent_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_link_id text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Separate statement: link_json is STABLE and must see the row just inserted.
  v_link_id := threadlink_private.open_pairing_request(v_owner, null, p_controller_session_id, p_agent_session_id);
  return threadlink_private.link_json(v_link_id);
end;
$$;

-- Links carry safe counterpart labels so clients can present choices (replaces Phase 4).
create or replace function threadlink_private.link_json(p_link_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id,
    'controller_session_id', l.controller_session_id,
    'agent_session_id', l.agent_session_id,
    'controller_display_name', cs.display_name,
    'agent_display_name', ag.display_name,
    'status', l.status,
    'revoked_reason', l.revoked_reason,
    'requested_at', l.requested_at,
    'approved_at', l.approved_at,
    'revoked_at', l.revoked_at
  )
  from public.thread_links as l
  join public.session_bindings cs on cs.id = l.controller_session_id
  join public.session_bindings ag on ag.id = l.agent_session_id
  where l.id = p_link_id
$$;

-- Controller's own recent tasks (metadata only), for result polling.
create function public.list_origin_tasks(p_token_hash text, p_session_id text, p_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  return coalesce((
    select jsonb_agg(threadlink_private.task_json(t.id, false) order by t.created_at desc)
    from (
      select id, created_at from public.tasks
      where origin_session_id = v_session.id and owner_user_id = v_connection.owner_user_id
      order by created_at desc
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 3. OAuth 2.1 for the ChatGPT MCP connector
--
-- ThreadLink is the authorization server for its own MCP resource; Clerk is
-- the identity step (the consent page requires a Clerk session). The access
-- token issued is a ThreadLink connection credential for a chatgpt/controller
-- connection, so MCP calls use the existing connection-authenticated path.
-- ===========================================================================
create table public.oauth_clients (
  id text primary key
    default threadlink_private.generate_id('tlcli')
    constraint oauth_clients_id_format check (id ~ '^tlcli_[0-9a-f]{32}$'),
  client_name text not null
    constraint oauth_clients_name_length check (char_length(client_name) between 1 and 100),
  redirect_uris text[] not null
    constraint oauth_clients_redirect_count check (cardinality(redirect_uris) between 1 and 5),
  created_at timestamptz not null default now()
);
comment on table public.oauth_clients is 'Dynamically registered OAuth public clients (RFC 7591). Not tenant data.';
alter table public.oauth_clients enable row level security;
revoke all on table public.oauth_clients from public, anon, authenticated;

create table public.oauth_authorization_codes (
  code_hash text primary key
    constraint oauth_codes_hash_format check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null references public.oauth_clients (id) on delete cascade,
  owner_user_id text not null references public.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null
    constraint oauth_codes_challenge_format check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  used_at timestamptz
);
comment on table public.oauth_authorization_codes is
  'One-time, 5-minute, PKCE(S256)-bound authorization codes. Only sha256(code) is stored.';
create index oauth_codes_owner_idx on public.oauth_authorization_codes (owner_user_id, created_at);
alter table public.oauth_authorization_codes enable row level security;
revoke all on table public.oauth_authorization_codes from public, anon, authenticated;

alter table public.connections
  add column oauth_client_id text references public.oauth_clients (id) on delete set null;
-- One live ChatGPT connection per (user, OAuth client): re-authorizing reuses it.
create unique index connections_one_live_oauth_grant_idx
  on public.connections (owner_user_id, oauth_client_id)
  where oauth_client_id is not null and status in ('active', 'idle');

create function threadlink_private.redirect_uri_is_allowed(p_uri text)
returns boolean language sql immutable set search_path = '' as $$
  select p_uri is not null and char_length(p_uri) <= 512 and (
    p_uri ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\s#]*)?$'
    or p_uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[^\s#]*)?$'
  )
$$;
revoke all on function threadlink_private.redirect_uri_is_allowed(text) from public;

-- RFC 7591 dynamic registration (unauthenticated by design). Globally rate-limited.
create function public.register_oauth_client(p_client_name text, p_redirect_uris text[])
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
  insert into public.oauth_clients (client_name, redirect_uris)
  values (left(coalesce(nullif(btrim(p_client_name), ''), 'MCP client'), 100), p_redirect_uris)
  returning id into v_id;
  return jsonb_build_object('client_id', v_id);
end;
$$;

-- Consent-page lookup (signed-in human only).
create function public.get_oauth_client(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('client_id', c.id, 'client_name', c.client_name, 'redirect_uris', to_jsonb(c.redirect_uris))
  from public.oauth_clients c
  where c.id = p_client_id and threadlink_private.current_user_id() is not null
$$;

-- Consent: the signed-in human (Clerk JWT) authorizes a client. Owner from JWT only.
create function public.create_oauth_authorization(
  p_client_id text,
  p_redirect_uri text,
  p_code_hash text,
  p_code_challenge text,
  p_resource text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.oauth_clients where id = p_client_id and p_redirect_uri = any (redirect_uris)) then
    raise exception 'unknown client or redirect_uri' using errcode = 'P0002';
  end if;
  if (select count(*) from public.oauth_authorization_codes
      where owner_user_id = v_owner and created_at > pg_catalog.now() - interval '10 minutes') >= 20 then
    raise exception 'authorization rate limit reached' using errcode = '54000';
  end if;
  insert into public.oauth_authorization_codes (code_hash, client_id, owner_user_id, redirect_uri, code_challenge, resource)
  values (p_code_hash, p_client_id, v_owner, p_redirect_uri, p_code_challenge, p_resource);
  return jsonb_build_object('ok', true);
end;
$$;

-- Token endpoint backend. One-time code + PKCE verified HERE (the verifier is
-- required, so a leaked code + public challenge cannot be redeemed). Issues the
-- connection credential (server-computed HMAC) for a reused or new
-- chatgpt/controller connection bound to (owner, client).
create function public.exchange_oauth_code(
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

  select id into v_connection_id from public.connections
  where owner_user_id = v_code.owner_user_id and oauth_client_id = v_code.client_id
    and status in ('active', 'idle')
  for update;

  if v_connection_id is not null then
    -- Re-authorization: same connection identity, fresh credential.
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
    select v_code.owner_user_id, 'chatgpt', 'controller', left(c.client_name, 100), c.id
    from public.oauth_clients c where c.id = v_code.client_id
    returning id into v_connection_id;
    perform threadlink_private.record_audit(
      v_code.owner_user_id, null, 'connection.created', v_connection_id, 'success',
      jsonb_build_object('platform', 'chatgpt', 'role', 'controller', 'via', 'oauth'));
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
-- 4. Privileges
-- ===========================================================================
revoke all on function public.renew_task_lease(text, text, text, text) from public;
revoke all on function public.owner_request_pairing(text, text) from public, anon;
revoke all on function public.list_origin_tasks(text, text, integer) from public;
revoke all on function public.register_oauth_client(text, text[]) from public;
revoke all on function public.get_oauth_client(text) from public, anon;
revoke all on function public.create_oauth_authorization(text, text, text, text, text) from public, anon;
revoke all on function public.exchange_oauth_code(text, text, text, text, text, text, text) from public;

grant execute on function public.renew_task_lease(text, text, text, text) to anon, authenticated;
grant execute on function public.list_origin_tasks(text, text, integer) to anon, authenticated;
grant execute on function public.owner_request_pairing(text, text) to authenticated;
grant execute on function public.register_oauth_client(text, text[]) to anon, authenticated;
grant execute on function public.get_oauth_client(text) to authenticated;
grant execute on function public.create_oauth_authorization(text, text, text, text, text) to authenticated;
grant execute on function public.exchange_oauth_code(text, text, text, text, text, text, text) to anon, authenticated;
