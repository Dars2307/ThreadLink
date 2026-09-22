-- Phase 6.6: ThreadLink Runtimes (devices/environments), their workspaces, and
-- exact per-conversation agent sessions.
--
-- Model: account -> runtime (tlrun_) -> workspace (tlwsp_) -> provider conversation
--        (native id, metadata) -> ThreadLink session (tlses_, canonical) -> link (tllnk_)
--
-- Trust: a runtime IS an agent connection (1:1). Everything a runtime reports
-- (label, platform, capabilities, workspaces, busy state) is self-description,
-- validated for shape and never used for ownership: owner and connection always
-- come from the verified credential. Revoking a runtime revokes its connection,
-- which cascades to its sessions, links and open tasks.

-- ===========================================================================
-- 0. Audit actions
-- ===========================================================================
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created', 'connection.revoked', 'connection.credential_rotated', 'connection.auth_failed',
  'connection.reclassified',
  'session.registered', 'session.retired', 'session.revoked', 'session.native_attached',
  'link.requested', 'link.approved', 'link.revoked', 'link.paused', 'link.resumed',
  'task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired',
  'task.requeued', 'oauth.token_issued', 'device.approved', 'device.denied',
  'runtime.registered', 'runtime.updated', 'runtime.revoked'
));

-- ===========================================================================
-- 1. Runtimes
-- ===========================================================================
create table public.runtimes (
  id text primary key
    default threadlink_private.generate_id('tlrun')
    constraint runtimes_id_format check (id ~ '^tlrun_[0-9a-f]{32}$'),
  owner_user_id text not null,
  connection_id text not null constraint runtimes_connection_key unique,
  label text not null constraint runtimes_label_length check (char_length(label) between 1 and 100),
  platform text not null constraint runtimes_platform_check check (platform in ('windows', 'macos', 'linux', 'other')),
  kind text not null constraint runtimes_kind_check check (kind in ('desktop', 'cli', 'remote')),
  version text constraint runtimes_version_format check (version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  capabilities jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{"autoStart": true, "autoReconnect": true, "notifications": true}'::jsonb,
  paused boolean not null default false,
  restart_requested_at timestamptz,
  status text not null default 'active' constraint runtimes_status_check check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint runtimes_connection_owner_fkey foreign key (connection_id, owner_user_id)
    references public.connections (id, owner_user_id) on delete cascade,
  constraint runtimes_id_owner_key unique (id, owner_user_id),
  constraint runtimes_revoked_consistency check ((status = 'revoked') = (revoked_at is not null))
);
comment on table public.runtimes is
  'A machine/environment running the ThreadLink Runtime. 1:1 with its agent connection.';
create index runtimes_owner_idx on public.runtimes (owner_user_id);

alter table public.runtimes enable row level security;
revoke all on table public.runtimes from public, anon, authenticated;
grant select on table public.runtimes to authenticated;
create policy runtimes_select_own on public.runtimes for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- Workspaces live on one runtime. The path is runtime-local display metadata; the
-- identity is (runtime, workspace_key). repo_fingerprint lets the UI group the same
-- repository across runtimes without treating paths as global IDs.
create table public.runtime_workspaces (
  id text primary key
    default threadlink_private.generate_id('tlwsp')
    constraint runtime_workspaces_id_format check (id ~ '^tlwsp_[0-9a-f]{32}$'),
  owner_user_id text not null,
  runtime_id text not null,
  workspace_key text not null constraint runtime_workspaces_key_format check (workspace_key ~ '^[0-9a-f]{64}$'),
  display_name text not null constraint runtime_workspaces_name_length check (char_length(display_name) between 1 and 100),
  path text constraint runtime_workspaces_path_format
    check (char_length(path) between 1 and 1024 and path !~ '[[:cntrl:]]'),
  repo_remote text constraint runtime_workspaces_remote_format check (char_length(repo_remote) between 1 and 300 and repo_remote ~ '^[A-Za-z0-9._~/-]+$'),
  repo_fingerprint text constraint runtime_workspaces_fingerprint_format check (repo_fingerprint ~ '^[0-9a-f]{64}$'),
  branch text constraint runtime_workspaces_branch_format check (branch ~ '^[A-Za-z0-9._/+-]{1,200}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  constraint runtime_workspaces_runtime_owner_fkey foreign key (runtime_id, owner_user_id)
    references public.runtimes (id, owner_user_id) on delete cascade,
  constraint runtime_workspaces_key unique (runtime_id, workspace_key),
  constraint runtime_workspaces_id_owner_key unique (id, owner_user_id)
);
create index runtime_workspaces_owner_idx on public.runtime_workspaces (owner_user_id);
alter table public.runtime_workspaces enable row level security;
revoke all on table public.runtime_workspaces from public, anon, authenticated;
grant select on table public.runtime_workspaces to authenticated;
create policy runtime_workspaces_select_own on public.runtime_workspaces for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- Agent sessions: one tlses_ per provider conversation, placed on a runtime workspace.
alter table public.session_bindings
  add column runtime_id text,
  add column workspace_id text,
  add column provider text constraint session_bindings_provider_check check (provider in ('claude-code', 'codex', 'nova')),
  add column native_busy boolean not null default false,
  add column native_busy_at timestamptz,
  add constraint session_bindings_runtime_owner_fkey foreign key (runtime_id, owner_user_id)
    references public.runtimes (id, owner_user_id) on delete cascade,
  add constraint session_bindings_workspace_owner_fkey foreign key (workspace_id, owner_user_id)
    references public.runtime_workspaces (id, owner_user_id) on delete cascade;
create index session_bindings_workspace_idx on public.session_bindings (workspace_id);

-- Links can be paused by the owner (no new tasks while paused).
alter table public.thread_links add column paused boolean not null default false;

-- ===========================================================================
-- 2. Helpers
-- ===========================================================================
create function threadlink_private.valid_capabilities(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) <= 20
     and not exists (
       select 1 from jsonb_each(p) as e(k, v)
       where not (
         (e.k in ('claude-code', 'claude-resume', 'interactive-session-discovery', 'codex', 'nova')
            and e.v in ('"available"'::jsonb, '"unavailable"'::jsonb))
         or (e.k = 'filesystem' and e.v in ('"local"'::jsonb, '"remote"'::jsonb))
         or (e.k = 'platform' and e.v in ('"windows"'::jsonb, '"macos"'::jsonb, '"linux"'::jsonb, '"other"'::jsonb))
       )
     )
$$;
revoke all on function threadlink_private.valid_capabilities(jsonb) from public;
alter table public.runtimes add constraint runtimes_capabilities_valid
  check (threadlink_private.valid_capabilities(capabilities));

create function threadlink_private.valid_runtime_settings(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) as e(k, v)
       where e.k not in ('autoStart', 'autoReconnect', 'notifications') or jsonb_typeof(e.v) <> 'boolean'
     )
$$;
revoke all on function threadlink_private.valid_runtime_settings(jsonb) from public;
alter table public.runtimes add constraint runtimes_settings_valid
  check (threadlink_private.valid_runtime_settings(settings));

create function threadlink_private.runtime_json(p_runtime_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'label', r.label, 'platform', r.platform, 'kind', r.kind, 'version', r.version,
    'capabilities', r.capabilities, 'settings', r.settings, 'paused', r.paused,
    'restart_requested_at', r.restart_requested_at, 'status', r.status,
    'created_at', r.created_at, 'last_seen_at', r.last_seen_at)
  from public.runtimes r where r.id = p_runtime_id
$$;
revoke all on function threadlink_private.runtime_json(text) from public;

create function threadlink_private.require_runtime(p_connection public.connections)
returns public.runtimes
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.runtimes;
begin
  if p_connection.role <> 'agent' then
    raise exception 'agent connection required' using errcode = '42501';
  end if;
  select * into v from public.runtimes where connection_id = p_connection.id and status = 'active';
  if not found then
    raise exception 'runtime not registered' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function threadlink_private.require_runtime(public.connections) from public;

-- Session json gains runtime placement and busy state.
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
    'native_attached_at', s.native_attached_at,
    'runtime_id', s.runtime_id,
    'workspace_id', s.workspace_id,
    'provider', s.provider,
    'native_busy', s.native_busy
  )
  from public.session_bindings as s
  join public.connections as c on c.id = s.connection_id
  where s.id = p_session_id
$$;

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
    'paused', l.paused,
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

-- ===========================================================================
-- 3. Runtime (agent-credential) operations
-- ===========================================================================
create function public.register_runtime(
  p_token_hash text, p_label text, p_platform text, p_kind text, p_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_id text;
  v_new boolean;
begin
  if v_connection.role <> 'agent' then
    raise exception 'agent connection required' using errcode = '42501';
  end if;
  insert into public.runtimes (owner_user_id, connection_id, label, platform, kind, version, last_seen_at)
  values (v_connection.owner_user_id, v_connection.id,
          left(coalesce(nullif(btrim(p_label), ''), 'ThreadLink Runtime'), 100),
          p_platform, p_kind, p_version, pg_catalog.now())
  on conflict (connection_id) do update
    set label = excluded.label, platform = excluded.platform, kind = excluded.kind,
        version = excluded.version, last_seen_at = excluded.last_seen_at
    where public.runtimes.status = 'active'
  returning id, (xmax = 0) into v_id, v_new;
  if v_id is null then
    raise exception 'runtime revoked' using errcode = '42501';
  end if;
  if v_new then
    perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id,
      'runtime.registered', 'runtime', v_id, jsonb_build_object('platform', p_platform, 'kind', p_kind));
  end if;
  return threadlink_private.runtime_json(v_id);
end;
$$;

create function public.runtime_heartbeat(
  p_token_hash text, p_version text, p_capabilities jsonb, p_busy_session_ids text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes := threadlink_private.require_runtime(v_connection);
begin
  if p_capabilities is null or not threadlink_private.valid_capabilities(p_capabilities) then
    raise exception 'invalid capabilities' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_busy_session_ids), 0) > 200 then
    raise exception 'too many sessions' using errcode = '22023';
  end if;
  update public.runtimes
  set last_seen_at = pg_catalog.now(), version = coalesce(p_version, version), capabilities = p_capabilities
  where id = v_runtime.id;
  -- Busy state only for THIS connection's sessions; foreign IDs are ignored.
  update public.session_bindings
  set native_busy = (id = any(coalesce(p_busy_session_ids, '{}'))), native_busy_at = pg_catalog.now()
  where connection_id = v_connection.id and runtime_id = v_runtime.id;
  update public.session_bindings set last_seen_at = pg_catalog.now()
  where connection_id = v_connection.id and status in ('active', 'idle')
    and (last_seen_at is null or last_seen_at < pg_catalog.now() - threadlink_private.usage_write_interval());
  return threadlink_private.runtime_json(v_runtime.id);
end;
$$;

create function public.upsert_runtime_workspace(
  p_token_hash text, p_workspace_key text, p_display_name text, p_path text,
  p_repo_remote text, p_repo_fingerprint text, p_branch text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes := threadlink_private.require_runtime(v_connection);
  v_id text;
begin
  if (select count(*) from public.runtime_workspaces where runtime_id = v_runtime.id) >= 200
     and not exists (select 1 from public.runtime_workspaces where runtime_id = v_runtime.id and workspace_key = p_workspace_key) then
    raise exception 'workspace limit reached' using errcode = '54000';
  end if;
  insert into public.runtime_workspaces
    (owner_user_id, runtime_id, workspace_key, display_name, path, repo_remote, repo_fingerprint, branch, last_seen_at)
  values (v_runtime.owner_user_id, v_runtime.id, p_workspace_key,
          left(coalesce(nullif(btrim(p_display_name), ''), 'Workspace'), 100),
          nullif(btrim(p_path), ''), p_repo_remote, p_repo_fingerprint, p_branch, pg_catalog.now())
  on conflict (runtime_id, workspace_key) do update
    set display_name = excluded.display_name, path = excluded.path, repo_remote = excluded.repo_remote,
        repo_fingerprint = excluded.repo_fingerprint, branch = excluded.branch, last_seen_at = excluded.last_seen_at
  returning id into v_id;
  return (select jsonb_build_object('id', w.id, 'display_name', w.display_name, 'workspace_key', w.workspace_key)
          from public.runtime_workspaces w where w.id = v_id);
end;
$$;

-- One tlses_ per provider conversation. The runtime chooses the local binding ref;
-- ownership, runtime and workspace membership are verified here.
create function public.register_runtime_session(
  p_token_hash text, p_workspace_id text, p_local_binding_ref text, p_display_name text,
  p_provider text, p_mode text, p_native_session_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes := threadlink_private.require_runtime(v_connection);
  v_workspace public.runtime_workspaces;
  v_session jsonb;
  v_id text;
begin
  select * into v_workspace from public.runtime_workspaces
  where id = p_workspace_id and runtime_id = v_runtime.id;
  if not found then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  if p_provider is null or p_provider not in ('claude-code', 'codex', 'nova') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('fresh', 'resume', 'continue')
     or ((p_mode = 'resume') <> (p_native_session_id is not null)) then
    raise exception 'invalid native session mode' using errcode = '22023';
  end if;

  v_session := public.register_session(p_token_hash, p_display_name, null, p_local_binding_ref);
  v_id := v_session ->> 'id';
  update public.session_bindings
  set runtime_id = v_runtime.id, workspace_id = v_workspace.id, provider = p_provider,
      native_session_mode = p_mode, native_provider_session_id = p_native_session_id,
      workspace_path = v_workspace.path,
      native_attached_at = case when p_mode = 'resume' then coalesce(native_attached_at, pg_catalog.now()) else null end
  where id = v_id;
  return threadlink_private.session_json(v_id) || jsonb_build_object('created', (v_session ->> 'created')::boolean);
end;
$$;

-- The runtime rotates its own credential (the old one stops working immediately).
create function public.rotate_own_credential(p_token_hash text, p_new_token_hash text, p_new_token_prefix text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
begin
  perform threadlink_private.assert_credential_material(p_new_token_hash, p_new_token_prefix);
  update public.connection_credentials set revoked_at = pg_catalog.now()
  where connection_id = v_connection.id and revoked_at is null;
  insert into public.connection_credentials (connection_id, owner_user_id, token_hash, token_prefix)
  values (v_connection.id, v_connection.owner_user_id,
          threadlink_private.credential_digest(p_new_token_hash), p_new_token_prefix);
  perform threadlink_private.record_audit(v_connection.owner_user_id, v_connection.id,
    'connection.credential_rotated', v_connection.id, 'success', jsonb_build_object('by', 'runtime'));
  return jsonb_build_object('connection_id', v_connection.id);
end;
$$;

-- ===========================================================================
-- 4. Controller view of linkable Claude conversations (replaces Phase 6.5)
-- ===========================================================================
create or replace function public.list_agent_sessions(p_token_hash text, p_session_id text)
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
      'workspace_name', coalesce(w.display_name, pg_catalog.regexp_replace(s.workspace_path, '^.*[\\/]', '')),
      'runtime_label', r.label,
      'runtime_online', r.last_seen_at is not null and r.last_seen_at > pg_catalog.now() - interval '3 minutes',
      'busy', s.native_busy,
      'native_session_mode', s.native_session_mode,
      'last_seen_at', s.last_seen_at,
      'link_status', (select l.status from public.thread_links l
                      where l.controller_session_id = v_session.id and l.agent_session_id = s.id
                        and l.status in ('pending', 'active') limit 1)
    ) order by s.last_seen_at desc nulls last)
    from public.session_bindings s
    join public.connections c on c.id = s.connection_id and c.owner_user_id = s.owner_user_id
    left join public.runtimes r on r.id = s.runtime_id
    left join public.runtime_workspaces w on w.id = s.workspace_id
    where s.owner_user_id = v_connection.owner_user_id
      and c.role = 'agent'
      and threadlink_private.session_is_usable(s.id)
      and (r.id is null or (r.status = 'active' and not r.paused))
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 5. Owner (dashboard) operations
-- ===========================================================================
create function threadlink_private.require_owned_runtime(p_runtime_id text)
returns public.runtimes
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v public.runtimes;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v from public.runtimes where id = p_runtime_id and owner_user_id = v_owner for update;
  if not found then
    raise exception 'runtime not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function threadlink_private.require_owned_runtime(text) from public;

create function public.update_runtime(
  p_runtime_id text, p_label text, p_settings jsonb, p_paused boolean, p_request_restart boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.runtimes := threadlink_private.require_owned_runtime(p_runtime_id);
begin
  if v.status <> 'active' then
    raise exception 'runtime revoked' using errcode = '55000';
  end if;
  if p_settings is not null and not threadlink_private.valid_runtime_settings(p_settings) then
    raise exception 'invalid settings' using errcode = '22023';
  end if;
  update public.runtimes
  set label = coalesce(left(nullif(btrim(p_label), ''), 100), label),
      settings = case when p_settings is null then settings else settings || p_settings end,
      paused = coalesce(p_paused, paused),
      restart_requested_at = case when p_request_restart then pg_catalog.now() else restart_requested_at end
  where id = v.id;
  perform threadlink_private.record_event(v.owner_user_id, null, 'runtime.updated', 'runtime', v.id,
    jsonb_build_object('paused', p_paused, 'restart', coalesce(p_request_restart, false)));
  return threadlink_private.runtime_json(v.id);
end;
$$;

create function public.revoke_runtime(p_runtime_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.runtimes := threadlink_private.require_owned_runtime(p_runtime_id);
begin
  -- Revoking the connection revokes the runtime (trigger) and cascades to
  -- sessions -> links -> open tasks.
  perform public.revoke_connection(v.connection_id);
  return threadlink_private.runtime_json(v.id);
end;
$$;

create function public.set_link_paused(p_link_id text, p_paused boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_link public.thread_links;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v_link from public.thread_links where id = p_link_id and owner_user_id = v_owner for update;
  if not found then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  if v_link.status <> 'active' then
    raise exception 'link is not active' using errcode = '55000';
  end if;
  update public.thread_links set paused = coalesce(p_paused, false) where id = v_link.id;
  perform threadlink_private.record_event(v_owner, null,
    case when p_paused then 'link.paused' else 'link.resumed' end, 'thread_link', v_link.id);
  return threadlink_private.link_json(v_link.id);
end;
$$;

-- ===========================================================================
-- 6. Enforcement triggers
-- ===========================================================================
create function threadlink_private.connections_revoke_runtime()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('revoked', 'retired') and old.status not in ('revoked', 'retired') then
    update public.runtimes set status = 'revoked', revoked_at = pg_catalog.now()
    where connection_id = new.id and status = 'active';
    if found then
      perform threadlink_private.record_event(new.owner_user_id, null, 'runtime.revoked', 'runtime',
        (select id from public.runtimes where connection_id = new.id));
    end if;
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.connections_revoke_runtime() from public;
create trigger connections_revoke_runtime
  after update of status on public.connections
  for each row execute function threadlink_private.connections_revoke_runtime();

-- Route only to compatible, unpaused destinations.
create function threadlink_private.tasks_runtime_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.session_bindings;
  v_runtime public.runtimes;
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.thread_links where id = new.thread_link_id and paused) then
      raise exception 'link is paused' using errcode = '55000';
    end if;
  end if;
  select * into v_session from public.session_bindings where id = new.target_session_id;
  if v_session.runtime_id is null then
    return new;
  end if;
  select * into v_runtime from public.runtimes where id = v_session.runtime_id;
  if tg_op = 'INSERT' then
    if v_runtime.status <> 'active' or v_session.provider is null
       or coalesce(v_runtime.capabilities ->> v_session.provider, 'unavailable') <> 'available' then
      raise exception 'agent unavailable' using errcode = '55000';
    end if;
  elsif new.status = 'claimed' and old.status = 'queued' and v_runtime.paused then
    raise exception 'runtime paused' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.tasks_runtime_guard() from public;
create trigger tasks_runtime_guard_insert
  before insert on public.tasks
  for each row execute function threadlink_private.tasks_runtime_guard();
create trigger tasks_runtime_guard_claim
  before update of status on public.tasks
  for each row execute function threadlink_private.tasks_runtime_guard();

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================
revoke all on function public.register_runtime(text, text, text, text, text) from public;
revoke all on function public.runtime_heartbeat(text, text, jsonb, text[]) from public;
revoke all on function public.upsert_runtime_workspace(text, text, text, text, text, text, text) from public;
revoke all on function public.register_runtime_session(text, text, text, text, text, text, text) from public;
revoke all on function public.rotate_own_credential(text, text, text) from public;
revoke all on function public.update_runtime(text, text, jsonb, boolean, boolean) from public, anon;
revoke all on function public.revoke_runtime(text) from public, anon;
revoke all on function public.set_link_paused(text, boolean) from public, anon;

grant execute on function public.register_runtime(text, text, text, text, text) to anon, authenticated;
grant execute on function public.runtime_heartbeat(text, text, jsonb, text[]) to anon, authenticated;
grant execute on function public.upsert_runtime_workspace(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.register_runtime_session(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.rotate_own_credential(text, text, text) to anon, authenticated;
grant execute on function public.update_runtime(text, text, jsonb, boolean, boolean) to authenticated;
grant execute on function public.revoke_runtime(text) to authenticated;
grant execute on function public.set_link_paused(text, boolean) to authenticated;
