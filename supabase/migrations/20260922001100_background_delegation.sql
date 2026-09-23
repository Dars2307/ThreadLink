-- ===========================================================================
-- Phase 6.7 — Background delegation
--
-- Exact-conversation mode refuses to write into a Claude Code session that is
-- open. That rule is right and stays exactly as it is. But it made the normal
-- case unusable: a task sent while the user had Claude Code open failed with
-- session_busy, so delegating meant closing your editor first.
--
-- Background worker mode is the everyday alternative. ThreadLink keeps its own
-- Claude conversation for a workspace, branched once from the user's (verified:
-- `--resume <id> --fork-session` succeeds even while the source is running, and
-- leaves the source transcript byte-identical), and resumes that worker for
-- later tasks so forks do not pile up.
--
-- A worker is never presented as the user's conversation. Which mode actually
-- ran a task, and in which native conversation, is recorded on the task itself
-- so the activity feed can say so plainly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Sessions: a third mode, and the worker's own native conversation
-- ---------------------------------------------------------------------------
alter table public.session_bindings
  drop constraint session_bindings_native_mode_check;
alter table public.session_bindings
  add constraint session_bindings_native_mode_check
    check (native_session_mode in ('fresh', 'resume', 'continue', 'worker'));

-- 'resume' still means "we have the user's exact conversation". Worker mode may
-- also carry one: the conversation it was branched from, for context.
alter table public.session_bindings
  drop constraint session_bindings_native_mode_consistency;
alter table public.session_bindings
  add constraint session_bindings_native_mode_consistency
    check (
      (native_session_mode = 'resume') <= (native_provider_session_id is not null)
      and (native_provider_session_id is not null)
          <= (native_session_mode in ('resume', 'worker'))
    );

alter table public.session_bindings
  add column worker_native_session_id text
    constraint session_bindings_worker_native_id_format
      check (worker_native_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- A worker id only means something in worker mode.
  add constraint session_bindings_worker_only
    check (worker_native_session_id is null or native_session_mode = 'worker');

comment on column public.session_bindings.worker_native_session_id is
  'Worker mode: the Claude conversation ThreadLink created for this workspace. '
  'Provider metadata, never a ThreadLink identity.';

-- ---------------------------------------------------------------------------
-- 2. Tasks: how the work actually ran
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column execution_mode text
    constraint tasks_execution_mode_check
      check (execution_mode in ('exact_conversation', 'background_worker', 'fresh_conversation')),
  add column worker_native_session_id text
    constraint tasks_worker_native_id_format
      check (worker_native_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

comment on column public.tasks.execution_mode is
  'Which execution mode ran this task. Null until an agent claims it. A task run '
  'by a background worker must never be shown as the user''s own conversation.';

-- ---------------------------------------------------------------------------
-- 3. Registration accepts worker mode
-- ---------------------------------------------------------------------------
create or replace function public.register_runtime_session(
  p_token_hash text, p_workspace_id text, p_local_binding_ref text, p_display_name text,
  p_provider text, p_mode text, p_native_session_id text,
  p_worker_native_session_id text default null
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
  -- 'resume' requires the exact conversation. 'worker' may name one (what it was
  -- branched from) but does not need it. Nothing else may carry one.
  if p_mode is null or p_mode not in ('fresh', 'resume', 'continue', 'worker')
     or (p_mode = 'resume' and p_native_session_id is null)
     or (p_native_session_id is not null and p_mode not in ('resume', 'worker')) then
    raise exception 'invalid native session mode' using errcode = '22023';
  end if;
  if p_worker_native_session_id is not null and p_mode <> 'worker' then
    raise exception 'worker session requires worker mode' using errcode = '22023';
  end if;

  v_session := public.register_session(p_token_hash, p_display_name, null, p_local_binding_ref);
  v_id := v_session ->> 'id';
  update public.session_bindings
  set runtime_id = v_runtime.id, workspace_id = v_workspace.id, provider = p_provider,
      native_session_mode = p_mode, native_provider_session_id = p_native_session_id,
      worker_native_session_id = p_worker_native_session_id,
      workspace_path = v_workspace.path,
      native_attached_at = case when p_mode = 'resume' then coalesce(native_attached_at, pg_catalog.now()) else null end
  where id = v_id;
  return threadlink_private.session_json(v_id) || jsonb_build_object('created', (v_session ->> 'created')::boolean);
end;
$$;

revoke all on function public.register_runtime_session(text, text, text, text, text, text, text, text) from public;
grant execute on function public.register_runtime_session(text, text, text, text, text, text, text, text)
  to anon, authenticated;

-- The 7-argument version is replaced by the 8-argument one above.
drop function if exists public.register_runtime_session(text, text, text, text, text, text, text);

-- ---------------------------------------------------------------------------
-- 4. The agent records how it ran the task
-- ---------------------------------------------------------------------------
create function public.report_execution_mode(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text,
  p_execution_mode text, p_worker_native_session_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings :=
    threadlink_private.require_role_session(v_connection, p_session_id, 'agent');
  v_task public.tasks;
begin
  if p_execution_mode is null
     or p_execution_mode not in ('exact_conversation', 'background_worker', 'fresh_conversation') then
    raise exception 'invalid execution mode' using errcode = '22023';
  end if;
  if p_worker_native_session_id is not null and p_execution_mode <> 'background_worker' then
    raise exception 'worker session requires background worker mode' using errcode = '22023';
  end if;
  -- Only the agent holding the claim may say how it is running the task.
  v_task := threadlink_private.require_claimed_task(
    v_session, p_task_id, p_claim_ref, array['claimed', 'working']);
  update public.tasks
  set execution_mode = p_execution_mode,
      worker_native_session_id = coalesce(p_worker_native_session_id, worker_native_session_id)
  where id = v_task.id;
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

revoke all on function public.report_execution_mode(text, text, text, text, text, text) from public;
grant execute on function public.report_execution_mode(text, text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Expose the new facts to readers
-- ---------------------------------------------------------------------------
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
    -- New in Phase 6.7: how the work actually ran.
    'execution_mode', t.execution_mode,
    'worker_native_session_id', t.worker_native_session_id,
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
revoke all on function threadlink_private.task_json(text, boolean) from public;

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
    -- New in Phase 6.7: the background conversation, once one exists.
    'worker_native_session_id', s.worker_native_session_id,
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
revoke all on function threadlink_private.session_json(text) from public;
