-- ThreadLink Phase 3: connection credentials, registration, revocation, audit.
--
-- Human identity: Clerk -> users. Client identity: connection -> credential.
-- Raw credentials NEVER reach the database: the application computes
-- HMAC-SHA256(THREADLINK_CONNECTION_SECRET, token) and passes only the hex
-- digest plus a short non-secret display prefix.

-- ---------------------------------------------------------------------------
-- Alpha limits
-- ---------------------------------------------------------------------------
create function threadlink_private.max_active_connections()
returns integer
language sql
immutable
set search_path = ''
as $$ select 10 $$;

comment on function threadlink_private.max_active_connections() is
  'Alpha abuse limit: maximum active/idle connections per ThreadLink user.';

-- Minimum interval between last_used_at / last_seen_at writes.
create function threadlink_private.usage_write_interval()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '60 seconds' $$;

revoke all on function threadlink_private.max_active_connections() from public;
revoke all on function threadlink_private.usage_write_interval() from public;

-- ---------------------------------------------------------------------------
-- connections: registration/revocation now go through functions only
-- ---------------------------------------------------------------------------
-- Direct INSERT would bypass the per-user cap, credential issuance and audit.
-- Direct status UPDATE would bypass credential revocation and audit.
-- DELETE would destroy revocation history.
revoke insert, delete on table public.connections from authenticated;
revoke update on table public.connections from authenticated;
grant update (display_name) on table public.connections to authenticated;

drop policy connections_insert_own on public.connections;
drop policy connections_delete_own on public.connections;

-- Lets credentials reference (connection, owner) so owners can never diverge.
alter table public.connections
  add constraint connections_id_owner_key unique (id, owner_user_id);

-- ---------------------------------------------------------------------------
-- connection_credentials
-- ---------------------------------------------------------------------------
create table public.connection_credentials (
  id text primary key
    default threadlink_private.generate_id('tlcrd')
    constraint connection_credentials_id_format check (id ~ '^tlcrd_[0-9a-f]{32}$'),
  connection_id text not null,
  owner_user_id text not null,
  -- hex HMAC-SHA256 of the raw token. Never selectable by API roles.
  token_hash text not null
    constraint connection_credentials_token_hash_key unique
    constraint connection_credentials_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  -- first 10 chars of the token (tlc_ + 6): display fingerprint only.
  token_prefix text not null
    constraint connection_credentials_token_prefix_format check (token_prefix ~ '^tlc_[A-Za-z0-9_-]{6}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint connection_credentials_connection_owner_fkey
    foreign key (connection_id, owner_user_id)
    references public.connections (id, owner_user_id) on delete cascade
);

comment on table public.connection_credentials is
  'Revocable bearer credentials for connections. Stores only a keyed hash; the raw token is shown once.';

create unique index connection_credentials_one_active_idx
  on public.connection_credentials (connection_id)
  where revoked_at is null;
create index connection_credentials_owner_idx on public.connection_credentials (owner_user_id);

-- Only last_used_at and a one-way revoked_at transition may change.
create function threadlink_private.connection_credentials_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.connection_id is distinct from old.connection_id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.token_hash is distinct from old.token_hash
     or new.token_prefix is distinct from old.token_prefix
     or new.created_at is distinct from old.created_at then
    raise exception 'credential identity columns are immutable' using errcode = '42501';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'credential revocation is terminal' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.connection_credentials_guard_update() from public;

create trigger connection_credentials_guard_update
  before update on public.connection_credentials
  for each row execute function threadlink_private.connection_credentials_guard_update();

alter table public.connection_credentials enable row level security;
revoke all on table public.connection_credentials from public, anon, authenticated;
-- Column-scoped SELECT: token_hash is deliberately excluded.
grant select (id, connection_id, owner_user_id, token_prefix, created_at, last_used_at, revoked_at)
  on table public.connection_credentials to authenticated;

create policy connection_credentials_select_own
  on public.connection_credentials
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- audit_events (minimal; append-only)
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id text primary key
    default threadlink_private.generate_id('tlevt')
    constraint audit_events_id_format check (id ~ '^tlevt_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  actor_connection_id text,
  action text not null
    constraint audit_events_action_check check (action in (
      'connection.created',
      'connection.revoked',
      'connection.credential_rotated',
      'connection.auth_failed'
    )),
  resource_type text not null,
  resource_id text not null,
  outcome text not null constraint audit_events_outcome_check check (outcome in ('success', 'denied')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_events is
  'Append-only security audit trail. Never contains tokens, hashes or authorization headers.';

create index audit_events_owner_created_idx on public.audit_events (owner_user_id, created_at desc);

create function threadlink_private.audit_events_block_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit events are append-only' using errcode = '42501';
end;
$$;
revoke all on function threadlink_private.audit_events_block_update() from public;

create trigger audit_events_block_update
  before update on public.audit_events
  for each row execute function threadlink_private.audit_events_block_update();

alter table public.audit_events enable row level security;
revoke all on table public.audit_events from public, anon, authenticated;
grant select on table public.audit_events to authenticated;

create policy audit_events_select_own
  on public.audit_events
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

create function threadlink_private.record_audit(
  p_owner_user_id text,
  p_actor_connection_id text,
  p_action text,
  p_resource_id text,
  p_outcome text,
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
    (p_owner_user_id, p_actor_connection_id, p_action, 'connection', p_resource_id, p_outcome, p_metadata);
$$;
revoke all on function threadlink_private.record_audit(text, text, text, text, text, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Shared validation + result shape
-- ---------------------------------------------------------------------------
create function threadlink_private.assert_credential_material(p_token_hash text, p_token_prefix text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_token_prefix is null or p_token_prefix !~ '^tlc_[A-Za-z0-9_-]{6}$' then
    raise exception 'invalid credential material' using errcode = '22023';
  end if;
end;
$$;
revoke all on function threadlink_private.assert_credential_material(text, text) from public;

create function threadlink_private.connection_json(p_connection_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'owner_user_id', c.owner_user_id,
    'platform', c.platform,
    'role', c.role,
    'status', c.status,
    'display_name', c.display_name,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'last_seen_at', c.last_seen_at,
    'revoked_at', c.revoked_at,
    'credential', (
      select jsonb_build_object(
        'id', k.id,
        'token_prefix', k.token_prefix,
        'created_at', k.created_at,
        'last_used_at', k.last_used_at,
        'revoked_at', k.revoked_at)
      from public.connection_credentials as k
      where k.connection_id = c.id
      order by k.created_at desc
      limit 1
    )
  )
  from public.connections as c
  where c.id = p_connection_id
$$;
revoke all on function threadlink_private.connection_json(text) from public;

-- ---------------------------------------------------------------------------
-- register_connection: create connection + first credential atomically
-- ---------------------------------------------------------------------------
create function public.register_connection(
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

  -- Serialize registrations per owner so the cap cannot be raced.
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
  values (v_connection_id, v_owner, p_token_hash, p_token_prefix);

  perform threadlink_private.record_audit(
    v_owner, null, 'connection.created', v_connection_id, 'success',
    jsonb_build_object('platform', p_platform, 'role', p_role));

  return threadlink_private.connection_json(v_connection_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_connection: idempotent; other users' IDs look nonexistent
-- ---------------------------------------------------------------------------
create function public.revoke_connection(p_connection_id text)
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
  from public.connections
  where id = p_connection_id and owner_user_id = v_owner
  for update;

  if not found then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;

  if v_status not in ('revoked', 'retired') then
    update public.connections set status = 'revoked' where id = p_connection_id;
    perform threadlink_private.record_audit(
      v_owner, null, 'connection.revoked', p_connection_id, 'success', '{}'::jsonb);
  end if;

  -- Always ensure no credential remains usable (idempotent).
  update public.connection_credentials
  set revoked_at = pg_catalog.now()
  where connection_id = p_connection_id and revoked_at is null;

  return threadlink_private.connection_json(p_connection_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- rotate_connection_credential: revoke current credential, issue a new one
-- ---------------------------------------------------------------------------
create function public.rotate_connection_credential(
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
  values (p_connection_id, v_owner, p_token_hash, p_token_prefix);

  perform threadlink_private.record_audit(
    v_owner, null, 'connection.credential_rotated', p_connection_id, 'success', '{}'::jsonb);

  return threadlink_private.connection_json(p_connection_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- authenticate_connection: resolve a credential hash to a trusted identity
--
-- Callable without a Clerk session (clients use their connection token).
-- Returns NULL for every failure so callers cannot distinguish unknown,
-- revoked or inactive credentials. Guessing requires a 256-bit keyed hash.
-- ---------------------------------------------------------------------------
create function public.authenticate_connection(p_token_hash text)
returns jsonb
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
  where k.token_hash = p_token_hash;

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

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'owner_user_id', v_connection.owner_user_id,
    'platform', v_connection.platform,
    'role', v_connection.role,
    'status', v_connection.status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on function public.register_connection(text, text, text, text, text) from public, anon;
revoke all on function public.revoke_connection(text) from public, anon;
revoke all on function public.rotate_connection_credential(text, text, text) from public, anon;
revoke all on function public.authenticate_connection(text) from public;

grant execute on function public.register_connection(text, text, text, text, text) to authenticated;
grant execute on function public.revoke_connection(text) to authenticated;
grant execute on function public.rotate_connection_credential(text, text, text) to authenticated;
grant execute on function public.authenticate_connection(text) to anon, authenticated;
