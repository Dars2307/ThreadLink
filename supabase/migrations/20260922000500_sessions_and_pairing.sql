-- ThreadLink Phase 4: session bindings and controller<->agent pairing.
--
-- Clients (connections) call the functions below as `anon`, presenting
-- H = HMAC-SHA256(THREADLINK_CONNECTION_SECRET, token), computed by the
-- ThreadLink server. The database resolves the connection from H itself; no
-- caller-supplied connection, owner, role or platform is ever trusted.

-- ===========================================================================
-- 0. Credential storage hardening (Phase 3 fix)
--
-- Phase 3 stored H directly. Because H is exactly what clients present to the
-- database, a leaked dump would let an attacker call client functions. Store
-- sha256(H) instead; H itself never rests in the database.
-- ===========================================================================
create function threadlink_private.credential_digest(p_token_hash text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token_hash, 'UTF8')), 'hex')
$$;
revoke all on function threadlink_private.credential_digest(text) from public;

alter table public.connection_credentials disable trigger connection_credentials_guard_update;
update public.connection_credentials
set token_hash = threadlink_private.credential_digest(token_hash);
alter table public.connection_credentials enable trigger connection_credentials_guard_update;

comment on column public.connection_credentials.token_hash is
  'sha256 of the server-computed HMAC of the token. Neither the token nor the HMAC is stored.';

-- Resolves a presented credential to its connection row, or NULL.
-- Records failed use of revoked/superseded credentials; throttles usage writes.
create function threadlink_private.resolve_connection(p_token_hash text)
returns public.connections
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_credential_id text;
  v_credential_revoked timestamptz;
  v_connection public.connections;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select k.id, k.revoked_at into v_credential_id, v_credential_revoked
  from public.connection_credentials as k
  where k.token_hash = threadlink_private.credential_digest(p_token_hash);

  if not found then
    return null;
  end if;

  select c.* into v_connection
  from public.connections as c
  join public.connection_credentials as k
    on k.connection_id = c.id and k.owner_user_id = c.owner_user_id
  where k.id = v_credential_id;

  if v_credential_revoked is not null or v_connection.status not in ('active', 'idle') then
    perform threadlink_private.record_audit(
      v_connection.owner_user_id, v_connection.id, 'connection.auth_failed', v_connection.id,
      'denied', jsonb_build_object('reason', 'credential_revoked'));
    return null;
  end if;

  update public.connection_credentials
  set last_used_at = pg_catalog.now()
  where id = v_credential_id
    and (last_used_at is null or last_used_at < pg_catalog.now() - threadlink_private.usage_write_interval());

  update public.connections
  set last_seen_at = pg_catalog.now()
  where id = v_connection.id
    and (last_seen_at is null or last_seen_at < pg_catalog.now() - threadlink_private.usage_write_interval());

  return v_connection;
end;
$$;
revoke all on function threadlink_private.resolve_connection(text) from public;

-- Same contract as Phase 3; now delegates to resolve_connection.
create or replace function public.authenticate_connection(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.resolve_connection(p_token_hash);
begin
  if v_connection.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'connection_id', v_connection.id,
    'owner_user_id', v_connection.owner_user_id,
    'platform', v_connection.platform,
    'role', v_connection.role,
    'status', v_connection.status
  );
end;
$$;

-- register/rotate must store the digest, not H.
create or replace function public.register_connection(
  p_platform text,
  p_role text,
  p_display_name text,
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
  v_owner text := threadlink_private.current_user_id();
  v_active integer;
  v_connection_id text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  perform threadlink_private.assert_credential_material(p_token_hash, p_token_prefix);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:connections:' || v_owner, 0));

  select count(*) into v_active
  from public.connections
  where owner_user_id = v_owner and status in ('active', 'idle');

  if v_active >= threadlink_private.max_active_connections() then
    raise exception 'active connection limit reached' using errcode = '54000';
  end if;

  insert into public.connections (owner_user_id, platform, role, display_name)
  values (v_owner, p_platform, p_role, nullif(btrim(p_display_name), ''))
  returning id into v_connection_id;

  insert into public.connection_credentials (connection_id, owner_user_id, token_hash, token_prefix)
  values (v_connection_id, v_owner, threadlink_private.credential_digest(p_token_hash), p_token_prefix);

  perform threadlink_private.record_audit(
    v_owner, null, 'connection.created', v_connection_id, 'success',
    jsonb_build_object('platform', p_platform, 'role', p_role));

  return threadlink_private.connection_json(v_connection_id);
end;
$$;

create or replace function public.rotate_connection_credential(
  p_connection_id text,
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
  v_owner text := threadlink_private.current_user_id();
  v_status text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  perform threadlink_private.assert_credential_material(p_token_hash, p_token_prefix);

  select status into v_status
  from public.connections
  where id = p_connection_id and owner_user_id = v_owner
  for update;

  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if v_status not in ('active', 'idle') then
    raise exception 'connection is not active' using errcode = '55000';
  end if;

  update public.connection_credentials
  set revoked_at = pg_catalog.now()
  where connection_id = p_connection_id and revoked_at is null;

  insert into public.connection_credentials (connection_id, owner_user_id, token_hash, token_prefix)
  values (p_connection_id, v_owner, threadlink_private.credential_digest(p_token_hash), p_token_prefix);

  perform threadlink_private.record_audit(
    v_owner, null, 'connection.credential_rotated', p_connection_id, 'success', '{}'::jsonb);

  return threadlink_private.connection_json(p_connection_id);
end;
$$;

-- ===========================================================================
-- 1. Audit events: new actions + generic writer
-- ===========================================================================
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created',
  'connection.revoked',
  'connection.credential_rotated',
  'connection.auth_failed',
  'session.registered',
  'session.retired',
  'session.revoked',
  'link.requested',
  'link.approved',
  'link.revoked'
));

create function threadlink_private.record_event(
  p_owner_user_id text,
  p_actor_connection_id text,
  p_action text,
  p_resource_type text,
  p_resource_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events
    (owner_user_id, actor_connection_id, action, resource_type, resource_id, outcome, metadata)
  values
    (p_owner_user_id, p_actor_connection_id, p_action, p_resource_type, p_resource_id, 'success', p_metadata);
$$;
revoke all on function threadlink_private.record_event(text, text, text, text, text, jsonb) from public;

-- ===========================================================================
-- 2. session_bindings
-- ===========================================================================
create function threadlink_private.max_active_sessions_per_connection()
returns integer
language sql
immutable
set search_path = ''
as $$ select 50 $$;
revoke all on function threadlink_private.max_active_sessions_per_connection() from public;

create table public.session_bindings (
  id text primary key
    default threadlink_private.generate_id('tlses')
    constraint session_bindings_id_format check (id ~ '^tlses_[0-9a-f]{32}$'),
  owner_user_id text not null,
  connection_id text not null,
  -- Optional, opaque provider metadata. NEVER an identity or lookup key.
  provider_session_ref text
    constraint session_bindings_provider_ref_format
      check (provider_session_ref ~ '^[A-Za-z0-9._:/@#-]{1,255}$'),
  -- Optional client-chosen stable handle, unique per connection (idempotency key).
  local_binding_ref text
    constraint session_bindings_local_ref_format
      check (local_binding_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  display_name text
    constraint session_bindings_display_name_length check (char_length(display_name) between 1 and 100),
  status text not null default 'active'
    constraint session_bindings_status_check check (status in ('active', 'idle', 'retired', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  constraint session_bindings_connection_owner_fkey
    foreign key (connection_id, owner_user_id)
    references public.connections (id, owner_user_id) on delete cascade,
  constraint session_bindings_id_owner_key unique (id, owner_user_id),
  -- Across ALL statuses: a retired/revoked binding's ref is never silently reused.
  constraint session_bindings_local_ref_key unique (connection_id, local_binding_ref),
  constraint session_bindings_retired_consistency check ((status = 'retired') = (retired_at is not null)),
  constraint session_bindings_revoked_consistency check ((status = 'revoked') = (revoked_at is not null))
);

comment on table public.session_bindings is
  'ThreadLink-owned identity (tlses_) for one logical client session. Provider refs and names are metadata only.';

create index session_bindings_owner_idx on public.session_bindings (owner_user_id);
create index session_bindings_connection_idx on public.session_bindings (connection_id);

create function threadlink_private.session_bindings_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.connection_id is distinct from old.connection_id
     or new.local_binding_ref is distinct from old.local_binding_ref
     or new.created_at is distinct from old.created_at then
    raise exception 'session binding identity columns are immutable' using errcode = '42501';
  end if;
  if old.status in ('retired', 'revoked') and new.status is distinct from old.status then
    raise exception 'session binding status % is terminal', old.status using errcode = '42501';
  end if;
  if new.status = 'retired' and old.status <> 'retired' then
    new.retired_at := pg_catalog.now();
  end if;
  if new.status = 'revoked' and old.status <> 'revoked' then
    new.revoked_at := pg_catalog.now();
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.session_bindings_guard_update() from public;

create trigger session_bindings_guard_update
  before update on public.session_bindings
  for each row execute function threadlink_private.session_bindings_guard_update();

create trigger session_bindings_touch_updated_at
  before update on public.session_bindings
  for each row execute function threadlink_private.touch_updated_at();

alter table public.session_bindings enable row level security;
revoke all on table public.session_bindings from public, anon, authenticated;
grant select on table public.session_bindings to authenticated;

create policy session_bindings_select_own
  on public.session_bindings
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ===========================================================================
-- 3. thread_links
-- ===========================================================================
create table public.thread_links (
  id text primary key
    default threadlink_private.generate_id('tllnk')
    constraint thread_links_id_format check (id ~ '^tllnk_[0-9a-f]{32}$'),
  owner_user_id text not null,
  controller_session_id text not null,
  agent_session_id text not null,
  status text not null default 'pending'
    constraint thread_links_status_check check (status in ('pending', 'active', 'revoked')),
  revoked_reason text
    constraint thread_links_revoked_reason_check check (revoked_reason in (
      'revoked_by_controller', 'revoked_by_agent', 'revoked_by_owner',
      'controller_session_ended', 'agent_session_ended'
    )),
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Both sessions must belong to the link owner: cross-user links are unrepresentable.
  constraint thread_links_controller_fkey
    foreign key (controller_session_id, owner_user_id)
    references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint thread_links_agent_fkey
    foreign key (agent_session_id, owner_user_id)
    references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint thread_links_distinct_sessions check (controller_session_id <> agent_session_id),
  constraint thread_links_revoked_consistency
    check ((status = 'revoked') = (revoked_at is not null and revoked_reason is not null)),
  constraint thread_links_approved_consistency
    check (status <> 'active' or approved_at is not null)
);

comment on table public.thread_links is
  'Authorized routing relationship between one exact controller session and one exact agent session. No conversation data.';

-- One live (pending or active) link per exact pair; revoked links stay as history.
create unique index thread_links_one_live_pair_idx
  on public.thread_links (controller_session_id, agent_session_id)
  where status in ('pending', 'active');
create index thread_links_owner_idx on public.thread_links (owner_user_id);
create index thread_links_agent_idx on public.thread_links (agent_session_id);

-- Role integrity, even for privileged writers.
create function threadlink_private.thread_links_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
       select 1 from public.session_bindings s join public.connections c on c.id = s.connection_id
       where s.id = new.controller_session_id and c.role = 'controller')
     or not exists (
       select 1 from public.session_bindings s join public.connections c on c.id = s.connection_id
       where s.id = new.agent_session_id and c.role = 'agent') then
    raise exception 'thread link requires a controller session and an agent session' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.thread_links_guard_insert() from public;

create trigger thread_links_guard_insert
  before insert on public.thread_links
  for each row execute function threadlink_private.thread_links_guard_insert();

create function threadlink_private.thread_links_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.controller_session_id is distinct from old.controller_session_id
     or new.agent_session_id is distinct from old.agent_session_id
     or new.requested_at is distinct from old.requested_at
     or new.created_at is distinct from old.created_at then
    raise exception 'thread link identity columns are immutable' using errcode = '42501';
  end if;
  if old.status = 'revoked' and new.status is distinct from old.status then
    raise exception 'thread link revocation is terminal' using errcode = '42501';
  end if;
  if old.status = 'active' and new.status = 'pending' then
    raise exception 'active thread link cannot return to pending' using errcode = '42501';
  end if;
  if new.status = 'active' and old.status = 'pending' then
    new.approved_at := pg_catalog.now();
  end if;
  if new.status = 'revoked' and old.status <> 'revoked' then
    new.revoked_at := pg_catalog.now();
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.thread_links_guard_update() from public;

create trigger thread_links_guard_update
  before update on public.thread_links
  for each row execute function threadlink_private.thread_links_guard_update();

create trigger thread_links_touch_updated_at
  before update on public.thread_links
  for each row execute function threadlink_private.touch_updated_at();

alter table public.thread_links enable row level security;
revoke all on table public.thread_links from public, anon, authenticated;
grant select on table public.thread_links to authenticated;

create policy thread_links_select_own
  on public.thread_links
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ===========================================================================
-- 4. Revocation cascade (explicit historical state)
--    connection revoked/retired -> its sessions revoked
--    session retired/revoked    -> its pending/active links revoked
-- ===========================================================================
create function threadlink_private.cascade_connection_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('revoked', 'retired') and old.status not in ('revoked', 'retired') then
    update public.session_bindings
    set status = 'revoked'
    where connection_id = new.id and status in ('active', 'idle');
  end if;
  return null;
end;
$$;
revoke all on function threadlink_private.cascade_connection_end() from public;

create trigger connections_cascade_end
  after update of status on public.connections
  for each row execute function threadlink_private.cascade_connection_end();

create function threadlink_private.cascade_session_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('retired', 'revoked') and old.status not in ('retired', 'revoked') then
    update public.thread_links
    set status = 'revoked', revoked_reason = 'controller_session_ended'
    where controller_session_id = new.id and status in ('pending', 'active');
    update public.thread_links
    set status = 'revoked', revoked_reason = 'agent_session_ended'
    where agent_session_id = new.id and status in ('pending', 'active');
  end if;
  return null;
end;
$$;
revoke all on function threadlink_private.cascade_session_end() from public;

create trigger session_bindings_cascade_end
  after update of status on public.session_bindings
  for each row execute function threadlink_private.cascade_session_end();

-- ===========================================================================
-- 5. Shared helpers for connection-authenticated functions
-- ===========================================================================
create function threadlink_private.require_connection(p_token_hash text)
returns public.connections
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.resolve_connection(p_token_hash);
begin
  if v_connection.id is null then
    raise exception 'connection authentication required' using errcode = '28000';
  end if;
  return v_connection;
end;
$$;
revoke all on function threadlink_private.require_connection(text) from public;

-- A session owned by the given connection that is still usable, else not-found.
create function threadlink_private.require_own_session(p_connection public.connections, p_session_id text)
returns public.session_bindings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.session_bindings;
begin
  select * into v_session
  from public.session_bindings
  where id = p_session_id and connection_id = p_connection.id and owner_user_id = p_connection.owner_user_id
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  return v_session;
end;
$$;
revoke all on function threadlink_private.require_own_session(public.connections, text) from public;

create function threadlink_private.session_json(p_session_id text)
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
    'revoked_at', s.revoked_at
  )
  from public.session_bindings as s
  join public.connections as c on c.id = s.connection_id
  where s.id = p_session_id
$$;
revoke all on function threadlink_private.session_json(text) from public;

create function threadlink_private.link_json(p_link_id text)
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
    'status', l.status,
    'revoked_reason', l.revoked_reason,
    'requested_at', l.requested_at,
    'approved_at', l.approved_at,
    'revoked_at', l.revoked_at
  )
  from public.thread_links as l
  where l.id = p_link_id
$$;
revoke all on function threadlink_private.link_json(text) from public;

-- True only if the session and its connection are both currently usable.
create function threadlink_private.session_is_usable(p_session_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_bindings s
    join public.connections c on c.id = s.connection_id and c.owner_user_id = s.owner_user_id
    where s.id = p_session_id
      and s.status in ('active', 'idle')
      and c.status in ('active', 'idle')
  )
$$;
revoke all on function threadlink_private.session_is_usable(text) from public;

create function threadlink_private.touch_session(p_session_id text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.session_bindings
  set last_seen_at = pg_catalog.now()
  where id = p_session_id
    and (last_seen_at is null or last_seen_at < pg_catalog.now() - threadlink_private.usage_write_interval());
$$;
revoke all on function threadlink_private.touch_session(text) from public;

-- ===========================================================================
-- 6. Session functions (connection-authenticated; callable as anon)
-- ===========================================================================

-- Idempotent on (connection, local_binding_ref). Without a local ref, always new.
create function public.register_session(
  p_token_hash text,
  p_display_name text default null,
  p_provider_session_ref text default null,
  p_local_binding_ref text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_display_name text := nullif(btrim(p_display_name), '');
  v_session public.session_bindings;
  v_active integer;
begin
  if p_local_binding_ref is not null then
    select * into v_session
    from public.session_bindings
    where connection_id = v_connection.id and local_binding_ref = p_local_binding_ref
    for update;

    if found then
      if v_session.status in ('retired', 'revoked') then
        raise exception 'session binding is no longer active' using errcode = '55000';
      end if;
      -- Reconnect: same identity. Metadata may change; identity never does.
      update public.session_bindings
      set display_name = coalesce(v_display_name, display_name),
          provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
          status = 'active',
          last_seen_at = pg_catalog.now()
      where id = v_session.id;
      return threadlink_private.session_json(v_session.id) || jsonb_build_object('created', false);
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:sessions:' || v_connection.id, 0));

  select count(*) into v_active
  from public.session_bindings
  where connection_id = v_connection.id and status in ('active', 'idle');
  if v_active >= threadlink_private.max_active_sessions_per_connection() then
    raise exception 'active session limit reached' using errcode = '54000';
  end if;

  insert into public.session_bindings
    (owner_user_id, connection_id, provider_session_ref, local_binding_ref, display_name, last_seen_at)
  values
    (v_connection.owner_user_id, v_connection.id, p_provider_session_ref, p_local_binding_ref,
     v_display_name, pg_catalog.now())
  on conflict (connection_id, local_binding_ref) do nothing
  returning * into v_session;

  if v_session.id is null then
    -- Lost a concurrent race for the same local ref: return the winner.
    select * into v_session
    from public.session_bindings
    where connection_id = v_connection.id and local_binding_ref = p_local_binding_ref;
    if v_session.status in ('retired', 'revoked') then
      raise exception 'session binding is no longer active' using errcode = '55000';
    end if;
    return threadlink_private.session_json(v_session.id) || jsonb_build_object('created', false);
  end if;

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'session.registered', 'session', v_session.id,
    jsonb_build_object('platform', v_connection.platform, 'role', v_connection.role));

  return threadlink_private.session_json(v_session.id) || jsonb_build_object('created', true);
end;
$$;

create function public.get_session(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_own_session(v_connection, p_session_id);
begin
  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.session_json(v_session.id);
end;
$$;

-- Idempotent. Retirement is terminal and cascades to links.
create function public.retire_session(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_own_session(v_connection, p_session_id);
begin
  if v_session.status in ('active', 'idle') then
    update public.session_bindings set status = 'retired' where id = v_session.id;
    perform threadlink_private.record_event(
      v_connection.owner_user_id, v_connection.id, 'session.retired', 'session', v_session.id);
  end if;
  return threadlink_private.session_json(v_session.id);
end;
$$;

-- ===========================================================================
-- 7. Pairing functions (connection-authenticated; callable as anon)
-- ===========================================================================

-- Controller-only. Idempotent for an existing pending/active link of the same pair.
create function public.request_pairing(
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

  -- Target: same owner, agent role, usable. Anything else is indistinguishable from nonexistent.
  if not exists (
    select 1
    from public.session_bindings s
    join public.connections c on c.id = s.connection_id and c.owner_user_id = s.owner_user_id
    where s.id = p_agent_session_id
      and s.owner_user_id = v_connection.owner_user_id
      and c.role = 'agent'
  ) or not threadlink_private.session_is_usable(p_agent_session_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  select id into v_link_id
  from public.thread_links
  where controller_session_id = v_controller.id
    and agent_session_id = p_agent_session_id
    and status in ('pending', 'active');

  if v_link_id is null then
    insert into public.thread_links (owner_user_id, controller_session_id, agent_session_id)
    values (v_connection.owner_user_id, v_controller.id, p_agent_session_id)
    on conflict (controller_session_id, agent_session_id) where status in ('pending', 'active') do nothing
    returning id into v_link_id;

    if v_link_id is null then
      select id into v_link_id
      from public.thread_links
      where controller_session_id = v_controller.id
        and agent_session_id = p_agent_session_id
        and status in ('pending', 'active');
    else
      perform threadlink_private.record_event(
        v_connection.owner_user_id, v_connection.id, 'link.requested', 'thread_link', v_link_id,
        jsonb_build_object('controller_session_id', v_controller.id, 'agent_session_id', p_agent_session_id));
    end if;
  end if;

  perform threadlink_private.touch_session(v_controller.id);
  return threadlink_private.link_json(v_link_id);
end;
$$;

-- Agent-only; the approving session must be the link's exact agent session.
create function public.approve_pairing(
  p_token_hash text,
  p_agent_session_id text,
  p_link_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_agent public.session_bindings;
  v_link public.thread_links;
begin
  if v_connection.role <> 'agent' then
    raise exception 'agent connection required' using errcode = '42501';
  end if;

  v_agent := threadlink_private.require_own_session(v_connection, p_agent_session_id);

  select * into v_link
  from public.thread_links
  where id = p_link_id and agent_session_id = v_agent.id and owner_user_id = v_connection.owner_user_id
  for update;
  if not found then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  if v_link.status = 'active' then
    return threadlink_private.link_json(v_link.id);
  end if;
  if v_link.status <> 'pending' then
    raise exception 'thread link is not pending' using errcode = '55000';
  end if;

  -- Re-validate both sides at approval time (fail closed).
  if not threadlink_private.session_is_usable(v_link.controller_session_id)
     or not threadlink_private.session_is_usable(v_link.agent_session_id) then
    raise exception 'thread link participants are not active' using errcode = '55000';
  end if;

  update public.thread_links set status = 'active' where id = v_link.id;
  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'link.approved', 'thread_link', v_link.id);
  perform threadlink_private.touch_session(v_agent.id);
  return threadlink_private.link_json(v_link.id);
end;
$$;

-- Either participant may revoke. Idempotent; terminal.
create function public.revoke_pairing(
  p_token_hash text,
  p_session_id text,
  p_link_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_own_session(v_connection, p_session_id);
  v_link public.thread_links;
begin
  select * into v_link
  from public.thread_links
  where id = p_link_id
    and owner_user_id = v_connection.owner_user_id
    and (controller_session_id = v_session.id or agent_session_id = v_session.id)
  for update;
  if not found then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  if v_link.status <> 'revoked' then
    update public.thread_links
    set status = 'revoked',
        revoked_reason = case when v_link.controller_session_id = v_session.id
                              then 'revoked_by_controller' else 'revoked_by_agent' end
    where id = v_link.id;
    perform threadlink_private.record_event(
      v_connection.owner_user_id, v_connection.id, 'link.revoked', 'thread_link', v_link.id);
  end if;
  return threadlink_private.link_json(v_link.id);
end;
$$;

-- Links involving one of the caller's sessions (pending requests, active pairing, history).
create function public.list_session_links(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_own_session(v_connection, p_session_id);
begin
  perform threadlink_private.touch_session(v_session.id);
  return coalesce((
    select jsonb_agg(threadlink_private.link_json(l.id) order by l.requested_at desc)
    from public.thread_links l
    where l.owner_user_id = v_connection.owner_user_id
      and (l.controller_session_id = v_session.id or l.agent_session_id = v_session.id)
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 8. Human (Clerk-authenticated) owner action: revoke a link from the dashboard
-- ===========================================================================
create function public.revoke_thread_link(p_link_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_status text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select status into v_status
  from public.thread_links
  where id = p_link_id and owner_user_id = v_owner
  for update;
  if not found then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;
  if v_status <> 'revoked' then
    update public.thread_links
    set status = 'revoked', revoked_reason = 'revoked_by_owner'
    where id = p_link_id;
    perform threadlink_private.record_event(v_owner, null, 'link.revoked', 'thread_link', p_link_id);
  end if;
  return threadlink_private.link_json(p_link_id);
end;
$$;

-- ===========================================================================
-- 9. Function privileges
-- ===========================================================================
revoke all on function public.register_session(text, text, text, text) from public;
revoke all on function public.get_session(text, text) from public;
revoke all on function public.retire_session(text, text) from public;
revoke all on function public.request_pairing(text, text, text) from public;
revoke all on function public.approve_pairing(text, text, text) from public;
revoke all on function public.revoke_pairing(text, text, text) from public;
revoke all on function public.list_session_links(text, text) from public;
revoke all on function public.revoke_thread_link(text) from public, anon;

-- Client functions: the credential (via its server-computed HMAC) is the authority.
grant execute on function public.register_session(text, text, text, text) to anon, authenticated;
grant execute on function public.get_session(text, text) to anon, authenticated;
grant execute on function public.retire_session(text, text) to anon, authenticated;
grant execute on function public.request_pairing(text, text, text) to anon, authenticated;
grant execute on function public.approve_pairing(text, text, text) to anon, authenticated;
grant execute on function public.revoke_pairing(text, text, text) to anon, authenticated;
grant execute on function public.list_session_links(text, text) to anon, authenticated;

grant execute on function public.revoke_thread_link(text) to authenticated;
