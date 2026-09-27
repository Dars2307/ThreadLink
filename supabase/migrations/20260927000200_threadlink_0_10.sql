-- ===========================================================================
-- ThreadLink 0.10: provider-neutral identity (agent_providers), agent runs and
-- message provenance, replies and references, structured chat cards
-- (code changes, findings, decisions, choices, job summaries, phases,
-- timeouts, interruptions, control requests), user choices, chat artifacts,
-- job control, owner-note delivery states, the per-chat cursor (chat_seq),
-- search, unread rules, the Runtime protocol version and host status.
--
-- Contract: docs/design/threadlink-0.10.md sections 1-8 (server side).
-- Shared TS types: lib/chat/types.ts (0.10 additions).
--
-- Additive, like every migration since Production has real data:
--   * new tables agent_providers, agent_runs, user_choices, chat_artifacts;
--     new nullable columns on chat_events, chats, team_jobs, team_messages,
--     team_findings, team_decisions and runtimes; nothing existing is dropped;
--   * the audit action allow-list is RE-STATED IN FULL as a superset, and so
--     are the chat event-type, job-status and finding-status checks;
--   * provider checks on chat_events.author_provider / audience and
--     room_agents.provider become registry references (FK / pattern + trigger);
--   * functions from earlier migrations are replaced in place (same
--     signatures, grants preserved) or gain new overloads;
--   * backfill: chat_seq for every existing chat row (per chat, in seq
--     order), chats.last_event_seq and last_read_chat_seq. Existing agent
--     rows keep run_id null (legacy: "Unverified (recorded before 0.10)").
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Audit actions (first: everything below writes some of these)
-- ---------------------------------------------------------------------------
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created', 'connection.revoked', 'connection.credential_rotated', 'connection.auth_failed',
  'connection.reclassified',
  'session.registered', 'session.retired', 'session.revoked', 'session.native_attached',
  'link.requested', 'link.approved', 'link.revoked', 'link.paused', 'link.resumed',
  'task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired',
  'task.requeued', 'task.acknowledged', 'task.blocked',
  'oauth.token_issued', 'device.approved', 'device.denied',
  'runtime.registered', 'runtime.updated', 'runtime.revoked',
  'room.created', 'room.renamed', 'room.archived', 'room.restored', 'room.deleted',
  'team.job_started', 'team.job_finished', 'team.decision',
  'provider.profile_updated',
  'provider.plan_set_from_device', 'provider.plan_migrated', 'team.stop_requested',
  'chat.created', 'chat.updated', 'chat.archived', 'chat.restored', 'chat.deleted',
  'chat_group.created', 'chat_group.renamed', 'chat_group.deleted',
  'team.job_retried',
  -- New in 0.10.
  'team.choice_requested', 'team.choice_decided', 'team.control_requested',
  'chat.attachment_added', 'chat.artifact_deleted', 'team.native_session_revealed'
));

-- The Runtime protocol (section 8). First: the functions below read it.
alter table public.runtimes
  add column protocol integer constraint runtimes_protocol_check check (protocol between 1 and 1000);
comment on column public.runtimes.protocol is
  'RUNTIME_PROTOCOL the Runtime last reported (null: it did not report one; its minor version counts).';

-- ---------------------------------------------------------------------------
-- 1. Vocabulary and bounds (mirrors lib/chat/types.ts 0.10 additions)
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_event_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status',
               'plan_agreed', 'unit_status', 'finding', 'decision', 'job_verdict', 'task_started',
               'task_progress', 'task_completed', 'task_failed', 'task_cancelled', 'owner_routed',
               'stop_requested', 'model_used', 'model_mismatch', 'mode_changed', 'provider_blocked',
               'code_change', 'decision_card', 'choice', 'job_summary', 'phase', 'timeout', 'interrupted',
               'control_requested'] $$;
-- Superset: 0.10 adds interrupted and paused (both non-terminal).
create or replace function threadlink_private.team_job_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
               'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled',
               'interrupted', 'paused'] $$;
-- Superset: wont_fix stays readable (it reads as dismissed).
create or replace function threadlink_private.team_finding_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['open', 'resolved', 'wont_fix', 'accepted', 'disputed', 'fixed', 'dismissed'] $$;
-- A finding in one of these states still blocks a PASS and a node approval.
create function threadlink_private.finding_open_states() returns text[]
language sql immutable set search_path = '' as $$ select array['open', 'accepted', 'disputed', 'fixed'] $$;
create function threadlink_private.run_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] $$;
create function threadlink_private.run_activities() returns text[]
language sql immutable set search_path = '' as $$
  select array['queued', 'reading', 'planning', 'building', 'reviewing', 'testing', 'waiting', 'responding',
               'integrating'] $$;
create function threadlink_private.run_failures() returns text[]
language sql immutable set search_path = '' as $$
  select array['not_authenticated', 'quota_exhausted', 'timeout', 'model_mismatch', 'access_mismatch',
               'cancelled', 'crashed', 'provider_error'] $$;
create function threadlink_private.choice_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['provider_failure', 'timeout', 'plan_disagreement', 'interrupted', 'migration',
               'production_deploy', 'destructive_action', 'security_action', 'paid_usage',
               'permission_expansion', 'secret_change'] $$;
create function threadlink_private.job_controls() returns text[]
language sql immutable set search_path = '' as $$
  select array['pause_after_step', 'stop_after_review', 'stop_before_integration', 'stop_now', 'cancel_queued',
               'resume'] $$;
create function threadlink_private.artifact_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['report', 'plan', 'diff', 'test_report', 'notes', 'export', 'user_attachment'] $$;
create function threadlink_private.artifact_mimes() returns text[]
language sql immutable set search_path = '' as $$
  select array['text/plain', 'text/markdown', 'text/x-diff', 'application/json'] $$;
create function threadlink_private.ref_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['finding', 'decision', 'node', 'artifact', 'message', 'choice'] $$;
-- The fixed decision titles a Runtime may record as ThreadLink's own
-- (title_source 'threadlink'). Anything else must be attributed to an agent run.
create function threadlink_private.decision_fixed_titles() returns text[]
language sql immutable set search_path = '' as $$
  select array['Roles chosen', 'Plan agreed', 'Plan changed', 'Work split into units', 'Unit owner changed',
               'Reviewer chosen', 'Finding dismissed', 'Finding disputed', 'Disagreement settled',
               'Integration order chosen', 'Merge conflict resolved', 'Model chosen', 'Timeout extended',
               'Retry chosen', 'Agent replaced', 'Stopped by you', 'Resumed after interruption',
               'Plan not agreed', 'Agents disagree', 'Out-of-scope changes undone', 'Unit cannot start', 'Merge conflict', 'No model available'] $$;
create function threadlink_private.provider_id_pattern() returns text
language sql immutable set search_path = '' as $$ select '^[a-z][a-z0-9-]{1,39}$' $$;
-- "codex:coordinator", "claude-code:reviewer:2": provider, role, optional index.
create function threadlink_private.participant_key_pattern() returns text
language sql immutable set search_path = '' as $$ select '^[a-z][a-z0-9-]{1,39}:[a-z_]{1,40}(:[0-9]{1,3})?$' $$;
create function threadlink_private.run_key_pattern() returns text
language sql immutable set search_path = '' as $$ select '^[A-Za-z0-9._:-]{1,128}$' $$;
-- Starts with a letter or digit (never '-', so it can never read as an option).
create function threadlink_private.native_session_pattern() returns text
language sql immutable set search_path = '' as $$ select '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' $$;
-- A Claude Code session id is a UUID.
create function threadlink_private.uuid_pattern() returns text
language sql immutable set search_path = '' as $$
  select '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' $$;
create function threadlink_private.runtime_protocol_current() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
create function threadlink_private.runs_per_job() returns integer
language sql immutable set search_path = '' as $$ select 500 $$;
create function threadlink_private.run_activity_interval() returns interval
language sql immutable set search_path = '' as $$ select interval '5 seconds' $$;
create function threadlink_private.choice_ttl() returns interval
language sql immutable set search_path = '' as $$ select interval '24 hours' $$;
create function threadlink_private.artifact_max_bytes() returns integer
language sql immutable set search_path = '' as $$ select 524288 $$;
create function threadlink_private.attachment_max_bytes() returns integer
language sql immutable set search_path = '' as $$ select 65536 $$;
create function threadlink_private.artifacts_per_chat() returns integer
language sql immutable set search_path = '' as $$ select 500 $$;
create function threadlink_private.chat_payload_max_bytes() returns integer
language sql immutable set search_path = '' as $$ select 16384 $$;

/*
 * The oldest Runtime protocol that may run a feature. Job starts keep the
 * 0.8/0.9 rule (team 7, solo/pair 8), so a 0.9 Runtime still runs work while
 * it updates; the 0.10-only controls need protocol 10. A Runtime that never
 * reported a protocol counts as its minor version (0.9.x -> 9).
 */
create function threadlink_private.min_protocol_for(p_feature text) returns integer
language sql immutable set search_path = '' as $$
  select case p_feature
    when 'team' then 7
    when 'solo' then 8
    when 'pair' then 8
    when 'job_control' then 10
    when 'choices' then 10
    when 'runs' then 10
    else 10 end $$;

create function threadlink_private.runtime_protocol_of(p_version text, p_protocol integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  -- The highest of the protocol ever reported and what the version implies.
  select greatest(
    coalesce(p_protocol, 0),
    coalesce((select case when m[1]::integer = 0 then least(m[2]::integer, 1000) else 10 end
              from (select pg_catalog.regexp_match(p_version, '^([0-9]{1,6})\.([0-9]{1,6})') as m) v
              where m is not null), 0))
$$;

-- The protocol of the Runtime behind an agent connection (0: none, or unknown).
create function threadlink_private.connection_protocol(p_connection_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select threadlink_private.runtime_protocol_of(r.version, r.protocol)
                   from public.runtimes r where r.connection_id = p_connection_id and r.status = 'active'), 0)
$$;

-- A JSON object whose keys are all in spec and whose values have the listed
-- types ("string|null"); a type prefixed "!" marks a required key.
create function threadlink_private.json_shape_ok(p jsonb, spec jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
       where not (spec ? e.key)
          or not (jsonb_typeof(e.value) = any (
                    pg_catalog.string_to_array(pg_catalog.ltrim(spec ->> e.key, '!'), '|'))))
     and not exists (
       select 1 from jsonb_each_text(spec) s where pg_catalog.left(s.value, 1) = '!' and not (p ? s.key))
$$;

/*
 * Structured chat payloads, per event type. Only the types below carry one;
 * every other row has none. Bounded, known keys only, typed values. The UI
 * renders these fields as data (never HTML), and every value is written by
 * SQL from trusted state (see the writers below).
 */
create function threadlink_private.valid_chat_payload(p_type text, p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 16384
    and coalesce(case p_type
      when 'code_change' then threadlink_private.json_shape_ok(p,
        '{"runId":"!string","nodeKey":"string|null","filesChanged":"!number","insertions":"!number",
          "deletions":"!number","files":"!array","branch":"string|null","commit":"string|null",
          "tests":"!array","testsRun":"!number","testsPassed":"!number","artifactId":"string|null"}')
      when 'finding' then threadlink_private.json_shape_ok(p,
        '{"findingId":"!string","severity":"!string","category":"!string","status":"!string",
          "raisedBy":"!string","raisedRunId":"string|null","ownerParticipant":"string|null",
          "filePath":"string|null","line":"number|null","nodeKey":"string|null"}')
      when 'decision_card' then threadlink_private.json_shape_ok(p,
        '{"decisionId":"!string","number":"!number","titleSource":"!string","requiresUser":"!boolean",
          "authorRunId":"string|null"}')
      when 'choice' then threadlink_private.json_shape_ok(p,
        '{"choiceId":"!string","kind":"!string","status":"!string","options":"!array",
          "chosenKey":"string|null","expiresAt":"string|null"}')
      when 'job_summary' then threadlink_private.json_shape_ok(p,
        '{"verdict":"!string","findings":"!object","units":"!object","tests":"object|null","agents":"!array",
          "finalVerifier":"string|null","openItems":"!number","pendingChoices":"!number",
          "reportArtifactId":"string|null","changes":"!number"}')
      when 'phase' then threadlink_private.json_shape_ok(p, '{"phase":"!string"}')
      when 'timeout' then threadlink_private.json_shape_ok(p,
        '{"runId":"!string","provider":"!string","minutes":"!number","step":"string|null","nodeKey":"string|null"}')
      when 'interrupted' then threadlink_private.json_shape_ok(p, '{"status":"!string"}')
      when 'control_requested' then threadlink_private.json_shape_ok(p, '{"action":"!string"}')
      else false end, false))
$$;

-- ---------------------------------------------------------------------------
-- 2. The provider registry (section 1): public metadata, written by no client
-- ---------------------------------------------------------------------------
create function threadlink_private.valid_mention_aliases(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and cardinality(p) <= 10
     and not exists (select 1 from unnest(p) a where a is null or a !~ '^[a-z][a-z0-9-]{1,39}$')
$$;

create table public.agent_providers (
  id text primary key
    constraint agent_providers_id_format check (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  display_name text not null
    constraint agent_providers_display_name_check check (char_length(display_name) between 1 and 60
                                                          and display_name !~ '[[:cntrl:]]'),
  short_name text not null
    constraint agent_providers_short_name_check check (char_length(short_name) between 1 and 30
                                                        and short_name !~ '[[:cntrl:]]'),
  mention_aliases text[] not null default '{}'
    constraint agent_providers_aliases_check check (threadlink_private.valid_mention_aliases(mention_aliases)),
  supported boolean not null default false,
  sort integer not null default 0 constraint agent_providers_sort_check check (sort between 0 and 10000),
  created_at timestamptz not null default now()
);
comment on table public.agent_providers is
  'Provider registry (public metadata). The UI renders providers from here, never from a per-provider switch.';
insert into public.agent_providers (id, display_name, short_name, mention_aliases, supported, sort) values
  ('claude-code', 'Claude Code', 'Claude', array['claude', 'claudecode'], true, 10),
  ('codex', 'Codex', 'Codex', array['codex'], true, 20),
  ('cursor', 'Cursor', 'Cursor', array['cursor'], false, 30),
  ('windsurf', 'Windsurf', 'Windsurf', array['windsurf'], false, 40),
  ('gemini-cli', 'Gemini CLI', 'Gemini', array['gemini'], false, 50);
-- RLS on and no policy (the schema keeps its rule: no permissive policy on any
-- table); everyone reads the registry through public.agent_providers_list().
alter table public.agent_providers enable row level security;
revoke all on table public.agent_providers from public, anon, authenticated;

create function public.agent_providers_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'display_name', p.display_name, 'short_name', p.short_name,
           'mention_aliases', to_jsonb(p.mention_aliases), 'supported', p.supported)
         order by p.sort, p.id), '[]'::jsonb)
  from public.agent_providers p
$$;
revoke all on function public.agent_providers_list() from public, anon, authenticated;
grant execute on function public.agent_providers_list() to anon, authenticated;

-- Provider checks become registry references (section 1). Older team tables
-- keep their fixed checks in 0.10 (see the contract, section 12).
alter table public.chat_events drop constraint chat_events_author_provider_check;
alter table public.chat_events add constraint chat_events_author_provider_fkey
  foreign key (author_provider) references public.agent_providers (id);
alter table public.chat_events drop constraint chat_events_audience_check;
alter table public.chat_events add constraint chat_events_audience_check
  check (audience = 'team' or audience ~ '^[a-z][a-z0-9-]{1,39}$');
alter table public.room_agents drop constraint room_agents_provider_check;
alter table public.room_agents add constraint room_agents_provider_fkey
  foreign key (provider) references public.agent_providers (id);

-- ---------------------------------------------------------------------------
-- 3. Agent runs (section 2): one provider execution, with its native session
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id text primary key
    default threadlink_private.generate_id('tlarn')
    constraint agent_runs_id_format check (id ~ '^tlarn_[0-9a-f]{32}$'),
  owner_user_id text not null,
  chat_id text,
  job_id text not null,
  node_id text,
  -- The execution host (the Runtime whose credential started the run).
  runtime_id text,
  provider text not null constraint agent_runs_provider_fkey references public.agent_providers (id),
  participant_key text not null
    constraint agent_runs_participant_key_format
      check (participant_key ~ '^[a-z][a-z0-9-]{1,39}:[a-z_]{1,40}(:[0-9]{1,3})?$'),
  role text not null constraint agent_runs_role_check check (role in (
    'coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer', 'test_reviewer', 'integrator',
    'investigator')),
  run_key text not null constraint agent_runs_run_key_format check (run_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  requested_model text
    constraint agent_runs_requested_model_format check (requested_model ~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$'),
  observed_model text
    constraint agent_runs_observed_model_format check (observed_model ~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$'),
  model_verified boolean not null default false,
  effort text constraint agent_runs_effort_format check (effort ~ '^[A-Za-z0-9_-]{1,40}$'),
  access text constraint agent_runs_access_check check (access in ('read-only', 'workspace-write')),
  access_verified boolean not null default false,
  native_session_id text
    constraint agent_runs_native_session_format
      check (native_session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  native_session_kind text
    constraint agent_runs_native_session_kind_check check (native_session_kind in (
      'claude_session', 'codex_thread', 'other')),
  native_session_continuity text not null default 'fresh'
    constraint agent_runs_continuity_check check (native_session_continuity in ('fresh', 'resumed', 'forked')),
  resumed_from_run_id text,
  worktree_label text
    constraint agent_runs_worktree_label_check check (char_length(worktree_label) between 1 and 120
                                                       and worktree_label !~ '[[:cntrl:]]'),
  status text not null default 'running'
    constraint agent_runs_status_check check (status in (
      'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted')),
  activity text constraint agent_runs_activity_check check (activity in (
    'queued', 'reading', 'planning', 'building', 'reviewing', 'testing', 'waiting', 'responding', 'integrating')),
  last_activity_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  timeout_ms integer constraint agent_runs_timeout_check check (timeout_ms between 1000 and 7200000),
  failure text constraint agent_runs_failure_check check (failure in (
    'not_authenticated', 'quota_exhausted', 'timeout', 'model_mismatch', 'access_mismatch', 'cancelled',
    'crashed', 'provider_error')),
  verification jsonb not null default '{}'::jsonb
    constraint agent_runs_verification_shape check (threadlink_private.json_shape_ok(verification,
      '{"model":"boolean","access":"boolean","nativeSession":"boolean","exitClean":"boolean"}')),
  created_at timestamptz not null default now(),
  constraint agent_runs_id_owner_key unique (id, owner_user_id),
  constraint agent_runs_id_job_key unique (id, job_id),
  constraint agent_runs_job_run_key unique (job_id, run_key),
  constraint agent_runs_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  -- No ON DELETE action (chats are only soft-deleted); checked at statement end.
  constraint agent_runs_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id),
  constraint agent_runs_node_fkey foreign key (node_id, job_id)
    references public.team_nodes (id, job_id) on delete cascade,
  constraint agent_runs_runtime_owner_fkey foreign key (runtime_id, owner_user_id)
    references public.runtimes (id, owner_user_id) on delete set null (runtime_id),
  -- A run resumes only a session of its own job.
  constraint agent_runs_resumed_from_fkey foreign key (resumed_from_run_id, job_id)
    references public.agent_runs (id, job_id) on delete cascade,
  constraint agent_runs_participant_provider check (pg_catalog.split_part(participant_key, ':', 1) = provider),
  constraint agent_runs_resumed_consistency check ((resumed_from_run_id is not null)
                                                   = (native_session_continuity in ('resumed', 'forked'))),
  constraint agent_runs_finished_consistency check (
    (finished_at is not null) = (status in ('completed', 'failed', 'cancelled', 'timed_out', 'interrupted'))),
  constraint agent_runs_native_kind_needs_id check (native_session_kind is null or native_session_id is not null),
  constraint agent_runs_model_verified_needs_observed check (not model_verified or observed_model is not null)
);
comment on table public.agent_runs is
  'One provider execution inside a job. Written only by the Runtime through team_job_write (claim-gated).';
create index agent_runs_job_idx on public.agent_runs (job_id, created_at);
create index agent_runs_chat_live_idx on public.agent_runs (chat_id, created_at)
  where status in ('queued', 'running');
create index agent_runs_owner_idx on public.agent_runs (owner_user_id);
create index agent_runs_native_session_idx on public.agent_runs (owner_user_id, provider, native_session_id)
  where native_session_id is not null;
create index agent_runs_runtime_idx on public.agent_runs (runtime_id) where status in ('queued', 'running');

-- Identity is fixed at start; a finished run never changes again.
create function threadlink_private.agent_runs_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The one change a finished run allows: its Runtime row went away (SET NULL).
  if new.runtime_id is null and old.runtime_id is not null
     and (to_jsonb(new) - 'runtime_id') = (to_jsonb(old) - 'runtime_id') then
    return new;
  end if;
  if new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id
     or new.job_id is distinct from old.job_id or new.chat_id is distinct from old.chat_id
     or new.node_id is distinct from old.node_id
     or new.runtime_id is distinct from old.runtime_id
     or new.provider is distinct from old.provider or new.participant_key is distinct from old.participant_key
     or new.role is distinct from old.role or new.run_key is distinct from old.run_key
     or new.requested_model is distinct from old.requested_model or new.effort is distinct from old.effort
     or new.access is distinct from old.access
     or new.native_session_continuity is distinct from old.native_session_continuity
     or new.resumed_from_run_id is distinct from old.resumed_from_run_id
     or new.created_at is distinct from old.created_at then
    raise exception 'agent run identity is immutable' using errcode = '42501';
  end if;
  if old.finished_at is not null then
    raise exception 'agent run is finished' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger agent_runs_guard_update before update on public.agent_runs
  for each row execute function threadlink_private.agent_runs_guard_update();

/*
 * A native session is never reused across ThreadLink chats or projects
 * (section 2): the same (owner, provider, native_session_id) may only appear on
 * runs of ONE chat and ONE project. Serialised per session id.
 */
create function threadlink_private.agent_runs_native_session_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room text;
begin
  if new.native_session_id is null
     or (tg_op = 'UPDATE' and new.native_session_id is not distinct from old.native_session_id) then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'threadlink:native-session:' || new.owner_user_id || ':' || new.provider || ':' || new.native_session_id, 0));
  select room_id into v_room from public.team_jobs where id = new.job_id;
  if exists (
       select 1 from public.agent_runs r
       join public.team_jobs j on j.id = r.job_id
       where r.owner_user_id = new.owner_user_id and r.provider = new.provider
         and r.native_session_id = new.native_session_id and r.id <> new.id
         and (r.chat_id is distinct from new.chat_id or j.room_id is distinct from v_room)) then
    raise exception 'a native session is never reused across chats or projects'
      using errcode = '42501', hint = 'native_session_reused';
  end if;
  return new;
end;
$$;
create trigger agent_runs_native_session_guard before insert or update of native_session_id on public.agent_runs
  for each row execute function threadlink_private.agent_runs_native_session_guard();

alter table public.agent_runs enable row level security;
revoke all on table public.agent_runs from public, anon, authenticated;
-- Every column except the native session id: that one is only ever handed out
-- by the audited owner RPC reveal_run_native_session.
grant select (id, owner_user_id, chat_id, job_id, node_id, runtime_id, provider, participant_key, role, run_key,
              requested_model, observed_model, model_verified, effort, access, access_verified,
              native_session_kind, native_session_continuity, resumed_from_run_id, worktree_label, status,
              activity, last_activity_at, started_at, finished_at, timeout_ms, failure, verification, created_at)
  on table public.agent_runs to authenticated;
create policy agent_runs_select_own on public.agent_runs for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 4. Columns on existing tables
-- ---------------------------------------------------------------------------
-- Jobs: owner controls (section 5); interrupted / paused statuses (section 6).
alter table public.team_jobs
  add column control text constraint team_jobs_control_check check (control in (
    'pause_after_step', 'stop_after_review', 'stop_before_integration', 'stop_now', 'cancel_queued', 'resume')),
  add column control_requested_at timestamptz,
  add constraint team_jobs_control_consistency check ((control is null) = (control_requested_at is null));
-- One more planning round per owner "Allow one more planning round" answer
-- (a plan_disagreement choice), on top of the job's own budget.
alter table public.team_jobs
  add column extra_planning_rounds integer not null default 0
    constraint team_jobs_extra_planning_check check (extra_planning_rounds between 0 and 5);
alter table public.team_jobs drop constraint team_jobs_planning_budget;
alter table public.team_jobs add constraint team_jobs_planning_budget
  check (planning_round between 0 and max_planning_rounds + extra_planning_rounds);
alter table public.team_jobs drop constraint team_jobs_status_check;
alter table public.team_jobs add constraint team_jobs_status_check check (status in (
  'queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
  'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled', 'interrupted', 'paused'));

-- Messages: the run that wrote them, and what they reply to / refer to.
alter table public.team_messages
  add column run_id text,
  add column reply_to_event_id text
    constraint team_messages_reply_to_format check (reply_to_event_id ~ '^tlcev_[0-9a-f]{32}$'),
  add column ref_kind text
    constraint team_messages_ref_kind_check check (ref_kind in ('finding', 'decision', 'node', 'artifact',
                                                                'message', 'choice')),
  add column ref_id text constraint team_messages_ref_id_format check (ref_id ~ '^tl[a-z]{3,4}_[0-9a-f]{32}$'),
  add constraint team_messages_ref_pair check ((ref_kind is null) = (ref_id is null)),
  add constraint team_messages_run_fkey foreign key (run_id, job_id)
    references public.agent_runs (id, job_id) on delete cascade;

-- Findings: the 0.10 states, the owner, a file:line, the runs.
alter table public.team_findings drop constraint team_findings_status_check;
alter table public.team_findings add constraint team_findings_status_check check (status in (
  'open', 'resolved', 'wont_fix', 'accepted', 'disputed', 'fixed', 'dismissed'));
alter table public.team_findings drop constraint team_findings_resolution_consistency;
alter table public.team_findings add constraint team_findings_resolution_consistency check (
  (status in ('open', 'accepted', 'disputed', 'fixed')) = (resolved_round is null));
alter table public.team_findings
  add column owner_participant text
    constraint team_findings_owner_participant_format
      check (owner_participant ~ '^[a-z][a-z0-9-]{1,39}:[a-z_]{1,40}(:[0-9]{1,3})?$'),
  add column file_path text
    constraint team_findings_file_path_check check (char_length(file_path) between 1 and 512
                                                     and file_path !~ '[[:cntrl:]]'),
  add column line integer constraint team_findings_line_check check (line between 1 and 10000000),
  add column raised_run_id text,
  add column resolved_run_id text,
  add constraint team_findings_raised_run_fkey foreign key (raised_run_id, job_id)
    references public.agent_runs (id, job_id) on delete cascade,
  add constraint team_findings_resolved_run_fkey foreign key (resolved_run_id, job_id)
    references public.agent_runs (id, job_id) on delete cascade;

-- Decisions: who titled it.
alter table public.team_decisions
  add column title_source text constraint team_decisions_title_source_check
    check (title_source in ('threadlink', 'agent')),
  add column author_run_id text,
  add constraint team_decisions_author_run_fkey foreign key (author_run_id, job_id)
    references public.agent_runs (id, job_id) on delete cascade,
  add constraint team_decisions_agent_title_has_run check (title_source is distinct from 'agent'
                                                           or author_run_id is not null);

-- Projects: step timeouts in minutes per step kind (section 6), set by the
-- owner, sent to the Runtime in the carrier as `timeouts`.
create function threadlink_private.step_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['normalise', 'plan', 'plan_review', 'build', 'review', 'security_review', 'inspection',
               'verify'] $$;
create function threadlink_private.valid_step_timeouts(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
       where not (e.key = any (threadlink_private.step_kinds()))
          or case when jsonb_typeof(e.value) <> 'number' then true
                  else (e.value #>> '{}')::numeric <> pg_catalog.trunc((e.value #>> '{}')::numeric)
                       or (e.value #>> '{}')::numeric not between 2 and 120 end)
$$;
alter table public.rooms
  add column step_timeouts jsonb not null default '{}'::jsonb
    constraint rooms_step_timeouts_check check (threadlink_private.valid_step_timeouts(step_timeouts));

-- Chats: the per-chat cursor (section 7).
alter table public.chats
  add column last_event_seq bigint not null default 0 constraint chats_last_event_seq_check check (last_event_seq >= 0),
  add column last_read_chat_seq bigint not null default 0
    constraint chats_last_read_chat_seq_check check (last_read_chat_seq >= 0);

-- Chat rows: cursor, provenance, replies/references, structured payload,
-- owner-note delivery.
alter table public.chat_events
  add column chat_seq bigint constraint chat_events_chat_seq_check check (chat_seq >= 1),
  add column run_id text,
  add column reply_to_event_id text
    constraint chat_events_reply_to_format check (reply_to_event_id ~ '^tlcev_[0-9a-f]{32}$'),
  add column ref_kind text
    constraint chat_events_ref_kind_check check (ref_kind in ('finding', 'decision', 'node', 'artifact', 'message',
                                                             'choice')),
  add column ref_id text constraint chat_events_ref_id_format check (ref_id ~ '^tl[a-z]{3,4}_[0-9a-f]{32}$'),
  add column payload jsonb,
  add column team_message_id text
    constraint chat_events_team_message_format check (team_message_id ~ '^tlamg_[0-9a-f]{32}$'),
  add column queued_for text[]
    constraint chat_events_queued_for_check check (cardinality(queued_for) <= 10),
  add column consumed_by_run_id text,
  add constraint chat_events_ref_pair check ((ref_kind is null) = (ref_id is null)),
  add constraint chat_events_run_owner_fkey foreign key (run_id, owner_user_id)
    references public.agent_runs (id, owner_user_id) on delete cascade,
  add constraint chat_events_consumed_run_owner_fkey foreign key (consumed_by_run_id, owner_user_id)
    references public.agent_runs (id, owner_user_id),
  add constraint chat_events_payload_valid check (threadlink_private.valid_chat_payload(event_type, payload)),
  -- A run and a delivery state mean what they say: a run only on agent and
  -- ThreadLink rows, delivery only on owner rows.
  add constraint chat_events_run_author check (run_id is null or author_kind in ('agent', 'threadlink')),
  add constraint chat_events_delivery_owner_v10 check (
    (queued_for is null and consumed_by_run_id is null) or author_kind = 'owner');
create unique index chat_events_chat_seq_key on public.chat_events (chat_id, chat_seq) where chat_seq is not null;
create unique index chat_events_team_message_key on public.chat_events (team_message_id)
  where team_message_id is not null;
create index chat_events_run_idx on public.chat_events (run_id) where run_id is not null;

alter table public.chat_events drop constraint chat_events_event_type_check;
alter table public.chat_events add constraint chat_events_event_type_check check (event_type in (
      'request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status', 'plan_agreed',
      'unit_status', 'finding', 'decision', 'job_verdict', 'task_started', 'task_progress', 'task_completed',
      'task_failed', 'task_cancelled', 'owner_routed', 'stop_requested', 'model_used', 'model_mismatch',
      'mode_changed', 'provider_blocked', 'code_change', 'decision_card', 'choice', 'job_summary', 'phase',
      'timeout', 'interrupted', 'control_requested'));
-- Each author kind still writes only its own kinds of event. An agent may now
-- also author a code-change card and a decision card (tied to its run).
alter table public.chat_events drop constraint chat_events_author_event;
alter table public.chat_events add constraint chat_events_author_event check (
  (author_kind = 'controller' and event_type = 'request')
  or (author_kind = 'owner' and event_type in ('request', 'message'))
  or (author_kind = 'agent' and event_type in ('agent_message', 'agent_result', 'task_progress', 'code_change',
                                               'decision_card'))
  or (author_kind = 'threadlink' and event_type not in ('request', 'message', 'agent_message', 'agent_result',
                                                        'task_progress', 'code_change')));
-- An agent's card is always tied to its run.
alter table public.chat_events add constraint chat_events_agent_card_has_run check (
  not (author_kind = 'agent' and event_type in ('code_change', 'decision_card')) or run_id is not null);

-- ---------------------------------------------------------------------------
-- 5. User choices (section 4) and chat artifacts
-- ---------------------------------------------------------------------------
create table public.user_choices (
  id text primary key
    default threadlink_private.generate_id('tlchc')
    constraint user_choices_id_format check (id ~ '^tlchc_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  chat_id text,
  job_id text,
  run_id text,
  kind text not null constraint user_choices_kind_check check (kind in (
    'provider_failure', 'timeout', 'plan_disagreement', 'interrupted', 'migration', 'production_deploy',
    'destructive_action', 'security_action', 'paid_usage', 'permission_expansion', 'secret_change')),
  -- Fixed per kind, filled from trusted parameters only (never agent text).
  title text not null
    constraint user_choices_title_check check (char_length(title) between 1 and 300 and title !~ '[[:cntrl:]]'),
  params jsonb not null default '{}'::jsonb
    constraint user_choices_params_shape check (threadlink_private.json_shape_ok(params,
      '{"provider":"string","otherProvider":"string","step":"string","minutes":"number","nodeKey":"string"}')),
  -- [{key, label}] from the per-kind allow-list.
  options jsonb not null
    constraint user_choices_options_shape check (jsonb_typeof(options) = 'array'
                                                 and jsonb_array_length(options) between 1 and 6
                                                 and octet_length(options::text) <= 2048),
  status text not null default 'pending'
    constraint user_choices_status_check check (status in ('pending', 'chosen', 'expired', 'cancelled')),
  chosen_key text constraint user_choices_chosen_key_format check (chosen_key ~ '^[a-z_]{1,40}$'),
  decided_at timestamptz,
  decided_by text,
  request_key text constraint user_choices_request_key_format check (request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  constraint user_choices_id_owner_key unique (id, owner_user_id),
  constraint user_choices_job_request_key unique (job_id, request_key),
  constraint user_choices_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id),
  constraint user_choices_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint user_choices_run_fkey foreign key (run_id, owner_user_id)
    references public.agent_runs (id, owner_user_id) on delete cascade,
  constraint user_choices_chosen_consistency check (
    (status = 'chosen') = (chosen_key is not null)
    and (status = 'chosen') = (decided_at is not null)
    and (status = 'chosen') = (decided_by is not null)),
  constraint user_choices_chosen_in_options check (
    chosen_key is null or options @> jsonb_build_array(jsonb_build_object('key', chosen_key)))
);
comment on table public.user_choices is
  'A durable question to the owner (options from a per-kind allow-list). Decided only by the owner (decide_choice).';
create index user_choices_job_idx on public.user_choices (job_id, created_at);
create index user_choices_chat_idx on public.user_choices (chat_id, created_at desc);
create index user_choices_owner_pending_idx on public.user_choices (owner_user_id) where status = 'pending';

create function threadlink_private.user_choices_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.owner_user_id is distinct from old.owner_user_id
     or new.chat_id is distinct from old.chat_id or new.job_id is distinct from old.job_id
     or new.run_id is distinct from old.run_id or new.kind is distinct from old.kind
     or new.title is distinct from old.title or new.params is distinct from old.params
     or new.options is distinct from old.options or new.request_key is distinct from old.request_key
     or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    raise exception 'a choice is fixed once asked' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'this choice is already settled' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger user_choices_guard_update before update on public.user_choices
  for each row execute function threadlink_private.user_choices_guard_update();

alter table public.user_choices enable row level security;
revoke all on table public.user_choices from public, anon, authenticated;
grant select on table public.user_choices to authenticated;
create policy user_choices_select_own on public.user_choices for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

create table public.chat_artifacts (
  id text primary key
    default threadlink_private.generate_id('tlart')
    constraint chat_artifacts_id_format check (id ~ '^tlart_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  chat_id text not null,
  job_id text,
  run_id text,
  kind text not null constraint chat_artifacts_kind_check check (kind in (
    'report', 'plan', 'diff', 'test_report', 'notes', 'export', 'user_attachment')),
  title text not null
    constraint chat_artifacts_title_check check (char_length(title) between 1 and 200 and title !~ '[[:cntrl:]]'),
  mime text not null constraint chat_artifacts_mime_check check (mime in (
    'text/plain', 'text/markdown', 'text/x-diff', 'application/json')),
  -- Redacted plain text; newline and tab are the only control characters.
  content text not null
    constraint chat_artifacts_content_check check (
      octet_length(content) between 1 and 524288
      and pg_catalog.translate(content, E'\n\t', '') !~ '[[:cntrl:]]'),
  bytes integer not null constraint chat_artifacts_bytes_check check (bytes between 1 and 524288),
  created_by text not null constraint chat_artifacts_created_by_check check (created_by in ('runtime', 'owner')),
  request_key text constraint chat_artifacts_request_key_format check (request_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint chat_artifacts_id_owner_key unique (id, owner_user_id),
  constraint chat_artifacts_job_request_key unique (job_id, request_key),
  constraint chat_artifacts_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id) on delete cascade,
  constraint chat_artifacts_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint chat_artifacts_run_owner_fkey foreign key (run_id, owner_user_id)
    references public.agent_runs (id, owner_user_id) on delete cascade,
  constraint chat_artifacts_bytes_match check (bytes = octet_length(content)),
  -- The owner attaches text; the Runtime writes everything else.
  constraint chat_artifacts_attachment_owner check ((kind = 'user_attachment') = (created_by = 'owner')),
  constraint chat_artifacts_attachment_size check (kind <> 'user_attachment' or bytes <= 65536)
);
comment on table public.chat_artifacts is
  'Text artifacts of a chat (reports, diffs, notes, owner attachments). Redacted; never rendered as HTML.';
create index chat_artifacts_chat_idx on public.chat_artifacts (chat_id, created_at desc) where deleted_at is null;
create index chat_artifacts_job_idx on public.chat_artifacts (job_id, created_at desc) where deleted_at is null;

create function threadlink_private.chat_artifacts_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at')
     or old.deleted_at is not null then
    raise exception 'artifacts are immutable (only a soft delete is allowed)' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger chat_artifacts_guard_update before update on public.chat_artifacts
  for each row execute function threadlink_private.chat_artifacts_guard_update();

alter table public.chat_artifacts enable row level security;
revoke all on table public.chat_artifacts from public, anon, authenticated;
grant select on table public.chat_artifacts to authenticated;
create policy chat_artifacts_select_own on public.chat_artifacts for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 6. Backfill (Production has data): chat_seq per chat in seq order, each
--    chat's last_event_seq, and the read cursor in chat_seq terms. Nothing
--    else is rewritten; agent rows keep run_id null (legacy).
-- ---------------------------------------------------------------------------
/*
 * Idempotent: rows that already have a chat_seq keep it; new numbers continue
 * after the chat's highest one. Kept as a function so the database tests can
 * run it against fixture data shaped like Production before this migration.
 */
create function threadlink_private.v10_backfill()
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_events integer;
  v_chats integer;
begin
  -- chat_events are append-only by trigger; this one update is the
  -- migration's own and sets only chat_seq.
  execute 'alter table public.chat_events disable trigger chat_events_guard_update';
  update public.chat_events e
  set chat_seq = n.base + n.rn
  from (
    select ce.id,
           row_number() over (partition by ce.chat_id order by ce.seq) as rn,
           coalesce((select max(x.chat_seq) from public.chat_events x where x.chat_id = ce.chat_id), 0) as base
    from public.chat_events ce
    where ce.chat_id is not null and ce.chat_seq is null
  ) n
  where e.id = n.id;
  get diagnostics v_events = row_count;
  execute 'alter table public.chat_events enable trigger chat_events_guard_update';

  update public.chats c
  set last_event_seq = greatest(c.last_event_seq,
        coalesce((select max(e.chat_seq) from public.chat_events e where e.chat_id = c.id), 0)),
      last_read_chat_seq = greatest(c.last_read_chat_seq,
        coalesce((select max(e.chat_seq) from public.chat_events e
                  where e.chat_id = c.id and e.seq <= c.last_read_seq), 0));
  get diagnostics v_chats = row_count;
  return jsonb_build_object('events', v_events, 'chats', v_chats);
end;
$$;
revoke all on function threadlink_private.v10_backfill() from public, anon, authenticated, service_role;
select threadlink_private.v10_backfill();

-- ---------------------------------------------------------------------------
-- 7. Chat rows: the per-chat cursor, registry audiences, note delivery
-- ---------------------------------------------------------------------------

-- The providers taking part in a job (the server-built carrier's agents).
create function threadlink_private.job_participants(p_job_id text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct a ->> 'provider' order by a ->> 'provider'), '{}')
  from public.team_jobs j
  join public.tasks t on t.id = j.task_id
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(t.content::jsonb -> 'agents') = 'array' then t.content::jsonb -> 'agents'
         else '[]'::jsonb end) a
  where j.id = p_job_id and jsonb_typeof(a -> 'provider') = 'string'
$$;

-- A provider's display name, from the registry for any provider id.
create function threadlink_private.provider_label(p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(threadlink_private.chat_provider_label(p_provider),
                  (select p.display_name from public.agent_providers p where p.id = p_provider))
$$;

/*
 * Before every chat row (after chat_events_assign_chat, by name order):
 *   * an audience is 'team' or a provider of the registry;
 *   * an owner note to a running job records who it is queued for;
 *   * a row in a chat gets the chat's next chat_seq (the chat row is locked,
 *     so the per-chat sequence has no gaps and no duplicates).
 */
create function threadlink_private.chat_events_v10_prepare()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.audience is not null and new.audience <> 'team'
     and not exists (select 1 from public.agent_providers p where p.id = new.audience) then
    raise exception 'unknown audience' using errcode = '23514';
  end if;
  if new.author_kind = 'owner' and new.event_type = 'message' and new.job_id is not null
     and new.delivered_at is null and new.queued_for is null then
    new.queued_for := case when new.audience is null or new.audience = 'team'
                           then threadlink_private.job_participants(new.job_id)
                           else array[new.audience] end;
  end if;
  if new.chat_id is not null then
    -- The chat row lock serialises writers; the max() (an index probe) keeps
    -- the sequence ahead of any row that reached this chat another way.
    update public.chats
    set last_event_seq = greatest(last_event_seq,
          coalesce((select max(e.chat_seq) from public.chat_events e where e.chat_id = new.chat_id), 0)) + 1
    where id = new.chat_id
    returning last_event_seq into new.chat_seq;
  end if;
  return new;
end;
$$;
create trigger chat_events_v10_prepare before insert on public.chat_events
  for each row execute function threadlink_private.chat_events_v10_prepare();

-- Append-only, except the facts that arrive later: delivery (once), the job an
-- owner's starting message created (once), the chat (once), and which run
-- consumed an owner note (once).
create or replace function threadlink_private.chat_events_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'delivered_at' - 'job_id' - 'chat_id' - 'consumed_by_run_id')
       is distinct from (to_jsonb(old) - 'delivered_at' - 'job_id' - 'chat_id' - 'consumed_by_run_id')
     or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
     or (old.job_id is not null and new.job_id is distinct from old.job_id)
     or (old.chat_id is not null and new.chat_id is distinct from old.chat_id)
     or (old.consumed_by_run_id is not null and new.consumed_by_run_id is distinct from old.consumed_by_run_id) then
    raise exception 'chat events are append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- A card in a job's chat: a ThreadLink row (p_run optional, for provenance)
-- or an agent row tied to its run (provider, label, role, model from the run).
create function threadlink_private.chat_card(
  p_job public.team_jobs,
  p_author_kind text,
  p_run public.agent_runs,
  p_event_type text,
  p_body text,
  p_visibility text,
  p_payload jsonb,
  p_node_id text default null,
  p_ref_kind text default null,
  p_ref_id text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_body text := threadlink_private.chat_clean(p_body, 2000);
  v_id text;
  v_agent boolean := p_author_kind = 'agent';
begin
  if v_body is null then
    return null;
  end if;
  if v_agent and p_run.id is null then
    raise exception 'an agent card needs its run' using errcode = '22023';
  end if;
  insert into public.chat_events
    (owner_user_id, room_id, agent_session_id, job_id, task_id, node_id, author_kind, author_provider,
     author_label, author_role, event_type, model_observed, body, visibility, run_id, payload, ref_kind, ref_id)
  values
    (p_job.owner_user_id, p_job.room_id,
     (select t.target_session_id from public.tasks t where t.id = p_job.task_id),
     p_job.id, p_job.task_id, p_node_id, p_author_kind,
     case when v_agent then p_run.provider end,
     case when v_agent then coalesce(threadlink_private.provider_label(p_run.provider), 'Agent')
          else 'ThreadLink' end,
     case when v_agent then p_run.role end,
     p_event_type,
     case when v_agent and p_run.observed_model ~ threadlink_private.chat_model_pattern()
          then p_run.observed_model end,
     v_body, p_visibility, p_run.id, p_payload, p_ref_kind, p_ref_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Triggers replaced in place: agent messages carry their run and reply;
--    findings and decisions become cards; job updates add phases, the
--    interruption row and the final summary.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_on_team_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_run public.agent_runs;
  v_body text;
  v_model text;
begin
  if new.sender not in ('claude-code', 'codex') then
    return null;
  end if;
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    -- Only an enabled agent of the room that takes part in THIS job.
    if not exists (select 1 from public.room_agents a
                   where a.room_id = v_job.room_id and a.provider = new.sender and a.enabled)
       or not (new.sender = any (threadlink_private.job_participants(v_job.id))) then
      return null;
    end if;
    if new.run_id is not null then
      select * into v_run from public.agent_runs where id = new.run_id and job_id = new.job_id;
    end if;
    v_body := threadlink_private.chat_clean(new.body, 8192);
    if v_body is null then
      return null;
    end if;
    v_model := coalesce(new.model_observed, v_run.observed_model);
    insert into public.chat_events
      (owner_user_id, room_id, agent_session_id, job_id, task_id, node_id, author_kind, author_provider,
       author_label, author_role, audience, event_type, message_type, round, model_observed, body, visibility,
       run_id, reply_to_event_id, ref_kind, ref_id, team_message_id)
    values
      (v_job.owner_user_id, v_job.room_id,
       (select t.target_session_id from public.tasks t where t.id = v_job.task_id),
       v_job.id, v_job.task_id, new.node_id, 'agent', new.sender,
       threadlink_private.chat_provider_label(new.sender), new.sender_role,
       case new.receiver when 'claude-code' then 'claude-code' when 'codex' then 'codex'
                         when 'threadlink' then null else 'team' end,
       'agent_message', new.message_type, new.round,
       case when v_model ~ threadlink_private.chat_model_pattern() then v_model end,
       v_body,
       case when new.message_type in ('handoff', 'finding') then 'technical' else 'visible' end,
       v_run.id, new.reply_to_event_id, new.ref_kind, new.ref_id, new.id);
  exception when others then
    raise warning 'threadlink chat: agent message not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

create or replace function threadlink_private.chat_on_team_finding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_key text;
begin
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    select n.node_key into v_key from public.team_nodes n where n.id = new.node_id;
    perform threadlink_private.chat_card(v_job, 'threadlink',
      (select r from public.agent_runs r where r.id = new.raised_run_id), 'finding',
      case new.severity when 'blocking' then 'Blocking finding' when 'important' then 'Important finding'
                        else 'Minor finding' end
      || ' from ' || coalesce(threadlink_private.chat_provider_label(new.raised_by), 'ThreadLink')
      || ' (' || pg_catalog.replace(new.category, '_', ' ') || ')'
      -- Trusted fields only: the title and body are agent text.
      || coalesce(' on unit ' || v_key, ''),
      case when new.severity in ('blocking', 'important') then 'visible' else 'technical' end,
      jsonb_build_object('findingId', new.id, 'severity', new.severity, 'category', new.category,
                         'status', new.status, 'raisedBy', new.raised_by, 'raisedRunId', new.raised_run_id,
                         'ownerParticipant', new.owner_participant, 'filePath', new.file_path, 'line', new.line,
                         'nodeKey', v_key),
      new.node_id, 'finding', new.id);
  exception when others then
    raise warning 'threadlink chat: finding not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

create or replace function threadlink_private.chat_on_team_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_run public.agent_runs;
  v_payload jsonb;
begin
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    if new.title_source is null then
      -- 0.9 and older Runtimes: the number and the flag only (the title is agent text).
      perform threadlink_private.chat_job_event(v_job, 'decision',
        'Decision TL-' || pg_catalog.lpad(new.number::text, 5, '0')
        || case when new.requires_user then E'\nThis needs your decision.' else '' end,
        'visible');
    else
      v_payload := jsonb_build_object('decisionId', new.id, 'number', new.number, 'titleSource', new.title_source,
                                      'requiresUser', new.requires_user, 'authorRunId', new.author_run_id);
      if new.title_source = 'agent' then
        -- The agent's own title, shown as that agent's words (tied to its run).
        select * into v_run from public.agent_runs where id = new.author_run_id and job_id = new.job_id;
        perform threadlink_private.chat_card(v_job, 'agent', v_run, 'decision_card',
          new.title || case when new.requires_user then E'\nThis needs your decision.' else '' end,
          'visible', v_payload, null, 'decision', new.id);
      else
        -- A fixed ThreadLink title (decision_fixed_titles, checked on write).
        perform threadlink_private.chat_card(v_job, 'threadlink', null, 'decision_card',
          new.title || case when new.requires_user then E'\nThis needs your decision.' else '' end,
          'visible', v_payload, null, 'decision', new.id);
      end if;
    end if;
  exception when others then
    raise warning 'threadlink chat: decision not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

create or replace function threadlink_private.chat_job_status_label(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'queued' then 'Waiting for the Runtime' when 'normalising' then 'Understanding the goal'
    when 'planning' then 'Planning' when 'building' then 'Building' when 'reviewing' then 'Reviewing'
    when 'integrating' then 'Integrating' when 'inspecting' then 'Final inspection'
    when 'completed' then 'Passed' when 'needs_fix' then 'Needs fixes' when 'blocked' then 'Blocked'
    when 'needs_user_decision' then 'Needs your decision' when 'failed' then 'Failed'
    when 'cancelled' then 'Cancelled' when 'interrupted' then 'Interrupted' when 'paused' then 'Paused'
    else p_status end
$$;

-- The phase separator a status opens (section 3), or null.
create function threadlink_private.chat_phase_of(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status when 'planning' then 'planning' when 'building' then 'build' when 'reviewing' then 'review'
                       when 'integrating' then 'integration' when 'inspecting' then 'final_check' end
$$;

/*
 * The final summary (section 4), built from job data only: the verdict,
 * findings by severity and state, units done, tests from the evidence (counts
 * only), the agents that ran, the final verifier, what is still open, and
 * links (report artifact, number of code-change cards).
 */
create function threadlink_private.job_summary_payload(p_job public.team_jobs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'verdict', p_job.verdict,
    'findings', jsonb_build_object(
      'bySeverity', jsonb_build_object(
        'blocking', (select count(*) from public.team_findings f where f.job_id = p_job.id and f.severity = 'blocking'),
        'important', (select count(*) from public.team_findings f where f.job_id = p_job.id and f.severity = 'important'),
        'non_blocking', (select count(*) from public.team_findings f
                         where f.job_id = p_job.id and f.severity = 'non_blocking')),
      'byState', jsonb_build_object(
        'open', (select count(*) from public.team_findings f
                 where f.job_id = p_job.id and f.status = any (threadlink_private.finding_open_states())),
        'resolved', (select count(*) from public.team_findings f where f.job_id = p_job.id and f.status = 'resolved'),
        'dismissed', (select count(*) from public.team_findings f
                      where f.job_id = p_job.id and f.status in ('dismissed', 'wont_fix')))),
    'units', jsonb_build_object(
      'done', (select count(*) from public.team_nodes n
               where n.job_id = p_job.id and n.status in ('approved', 'integrated')),
      'skipped', (select count(*) from public.team_nodes n where n.job_id = p_job.id and n.status = 'skipped'),
      'total', (select count(*) from public.team_nodes n where n.job_id = p_job.id)),
    'tests', case when jsonb_typeof(p_job.evidence -> 'tests') = 'array' then jsonb_build_object(
      'run', jsonb_array_length(p_job.evidence -> 'tests'),
      'passed', (select count(*) from jsonb_array_elements(p_job.evidence -> 'tests') t
                 where jsonb_typeof(t) = 'object' and t -> 'ok' = 'true'::jsonb)) end,
    'agents', coalesce((select jsonb_agg(distinct r.provider) from public.agent_runs r where r.job_id = p_job.id),
                       to_jsonb(threadlink_private.job_participants(p_job.id))),
    'finalVerifier', (select r.provider from public.agent_runs r
                      where r.job_id = p_job.id and r.status = 'completed'
                        and r.role in ('reviewer', 'security_reviewer', 'test_reviewer', 'integrator')
                      order by r.finished_at desc, r.created_at desc limit 1),
    'openItems', (select count(*) from public.team_findings f
                  where f.job_id = p_job.id and f.status = any (threadlink_private.finding_open_states())),
    'pendingChoices', (select count(*) from public.user_choices c where c.job_id = p_job.id and c.status = 'pending'),
    'reportArtifactId', (select a.id from public.chat_artifacts a
                         where a.job_id = p_job.id and a.kind = 'report' and a.deleted_at is null
                         order by a.created_at desc limit 1),
    'changes', (select count(*) from public.chat_events e where e.job_id = p_job.id and e.event_type = 'code_change'))
$$;

-- The summary sentence: fixed words and numbers from the payload only.
create function threadlink_private.job_summary_text(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Summary: ' || (p ->> 'verdict') || '.'
    || ' Units done: ' || (p #>> '{units,done}') || ' of ' || (p #>> '{units,total}') || '.'
    || case when jsonb_typeof(p -> 'tests') = 'object'
            then ' Tests: ' || (p #>> '{tests,passed}') || ' of ' || (p #>> '{tests,run}') || ' passed.'
            else ' No tests were run.' end
    || ' Findings: ' || (p #>> '{findings,byState,resolved}') || ' resolved, '
    || (p #>> '{findings,byState,dismissed}') || ' dismissed, ' || (p #>> '{findings,byState,open}') || ' open.'
    || case when jsonb_array_length(coalesce(p -> 'agents', '[]'::jsonb)) > 0
            then ' Agents: ' || (select string_agg(coalesce(threadlink_private.chat_provider_label(a), 'an agent'), ', '
                                                   order by a)
                                 from jsonb_array_elements_text(p -> 'agents') a) || '.'
            else '' end
    || case when p ->> 'finalVerifier' is not null
            then ' Final check by ' || coalesce(threadlink_private.chat_provider_label(p ->> 'finalVerifier'),
                                                'an agent') || '.'
            else '' end
$$;

create or replace function threadlink_private.chat_on_job_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_summary jsonb;
begin
  -- A finished job: runs still open are cancelled and pending choices lapse.
  if new.finished_at is not null and old.finished_at is null then
    begin
      update public.agent_runs
      set status = 'cancelled', failure = coalesce(failure, 'cancelled'), finished_at = pg_catalog.now()
      where job_id = new.id and status in ('queued', 'running');
      update public.user_choices set status = 'cancelled' where job_id = new.id and status = 'pending';
    exception when others then
      raise warning 'threadlink: open runs/choices not closed (%)', sqlstate;
    end;
  end if;
  begin
    if old.stop_requested_at is null and new.stop_requested_at is not null then
      perform threadlink_private.chat_job_event(new, 'stop_requested',
        'Stop requested. The team will finish the current round and stop.', 'visible');
    end if;
    if new.verdict is not null and old.verdict is null then
      -- Every word from the job's columns. The Runtime-written summary is NOT
      -- quoted here (it may carry agent text); it stays on the Progress tab.
      perform threadlink_private.chat_job_event(new, 'job_verdict',
        'Result: ' || new.verdict
        || case when new.verdict_reason is not null and new.verdict <> 'PASS'
                then E'\n' || coalesce(
                  threadlink_private.chat_provider_reason_text(new.verdict_reason, new.verdict_provider),
                  threadlink_private.chat_reason_text(new.verdict_reason))
                when new.stop_requested_at is not null and new.verdict = 'NEEDS_USER_DECISION'
                then E'\nStopped by you.' else '' end
        || E'\n' || case new.mode
             when 'solo' then 'Solo job: ' || threadlink_private.chat_provider_label(new.builder_provider)
                              || ' built it, with no reviewer.'
             when 'pair' then 'Builder + Reviewer: ' || threadlink_private.chat_provider_label(new.builder_provider)
                              || ' built it, ' || threadlink_private.chat_provider_label(
                                case new.builder_provider when 'codex' then 'claude-code' else 'codex' end)
                              || ' reviewed it.'
             else 'Team Mode job.' end
        || case when cardinality(new.verify_commands) = 0 then ' No project checks are set.'
                else ' Project checks: ' || cardinality(new.verify_commands) || '.' end,
        'visible');
      -- 0.10: the final summary, from job data only.
      v_summary := threadlink_private.job_summary_payload(new);
      perform threadlink_private.chat_card(new, 'threadlink', null, 'job_summary',
        threadlink_private.job_summary_text(v_summary), 'visible', v_summary);
    elsif new.status is distinct from old.status then
      if new.status in ('failed', 'cancelled') then
        perform threadlink_private.chat_job_event(new, 'job_status',
          case new.status when 'failed' then 'The job failed.' else 'The job was cancelled.' end, 'visible');
      elsif old.status = 'planning' and new.status = 'building' then
        perform threadlink_private.chat_job_event(new, 'plan_agreed', 'Plan agreed. Building now.', 'visible');
      else
        perform threadlink_private.chat_job_event(new, 'job_status',
          'Status: ' || threadlink_private.chat_job_status_label(new.status), 'technical');
      end if;
      -- 0.10: a phase separator (Planning, Build, Review, Integration, Final check).
      if threadlink_private.chat_phase_of(new.status) is not null
         and threadlink_private.chat_phase_of(new.status)
             is distinct from threadlink_private.chat_phase_of(old.status)
         -- Solo and Builder + Reviewer have no planning council.
         and not (new.status = 'planning' and new.mode in ('solo', 'pair')) then
        perform threadlink_private.chat_card(new, 'threadlink', null, 'phase',
          case new.status when 'planning' then 'Planning' when 'building' then 'Build' when 'reviewing' then 'Review'
                          when 'integrating' then 'Integration' else 'Final check' end,
          'visible', jsonb_build_object('phase', threadlink_private.chat_phase_of(new.status)));
      end if;
      if new.status = 'interrupted' then
        perform threadlink_private.chat_card(new, 'threadlink', null, 'interrupted',
          'This work was interrupted while a step was running. ThreadLink will not re-run it on its own.',
          'visible', jsonb_build_object('status', 'interrupted'));
      end if;
    end if;
  exception when others then
    raise warning 'threadlink chat: job update not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Team status: + control and the 0.10 open-finding states
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.team_status_json(p_job_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'job_id', j.id,
    'room_id', j.room_id,
    'room_name', r.name,
    'task_id', j.task_id,
    'task_status', t.status,
    'status', j.status,
    'verdict', j.verdict,
    'line', j.status_line,
    'summary', j.summary,
    'goal', pg_catalog.left(j.goal, 200),
    'mode', j.mode,
    'builder', j.builder_provider,
    'origin', j.origin,
    'stop_requested_at', j.stop_requested_at,
    'chat_id', j.chat_id,
    'last_phase', j.last_phase,
    'role_overrides', j.role_overrides,
    'verdict_reason', j.verdict_reason,
    'verdict_provider', j.verdict_provider,
    'retried_from_job_id', j.retried_from_job_id,
    'control', j.control,
    'control_requested_at', j.control_requested_at,
    'rounds', jsonb_build_object(
      'planning', jsonb_build_object('n', j.planning_round, 'max', j.max_planning_rounds + j.extra_planning_rounds),
      'review', jsonb_build_object('n', j.review_round, 'max', j.max_review_rounds)),
    'parallel_agents', j.parallel_agents,
    'plan_hash', j.plan_hash,
    'plan_approved', coalesce(j.plan_hash is not null and j.plan_approved_hash = j.plan_hash, false),
    'nodes_total', (select count(*) from public.team_nodes n where n.job_id = j.id),
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', n.node_key, 'owner', n.owner_provider, 'reviewer', n.reviewer_provider, 'status', n.status)
        order by n.created_at, n.node_key)
      from (select * from public.team_nodes where job_id = j.id order by created_at, node_key limit 50) n
    ), '[]'::jsonb),
    'open_findings', jsonb_build_object(
      'blocking', (select count(*) from public.team_findings f
                   where f.job_id = j.id and f.status = any (threadlink_private.finding_open_states())
                     and f.severity = 'blocking'),
      'important', (select count(*) from public.team_findings f
                    where f.job_id = j.id and f.status = any (threadlink_private.finding_open_states())
                      and f.severity = 'important'),
      'non_blocking', (select count(*) from public.team_findings f
                       where f.job_id = j.id and f.status = any (threadlink_private.finding_open_states())
                         and f.severity = 'non_blocking')),
    'decisions_needing_user', (select count(*) from public.team_decisions d
                               where d.job_id = j.id and d.requires_user),
    'pending_choices', (select count(*) from public.user_choices c where c.job_id = j.id and c.status = 'pending'),
    'created_at', j.created_at,
    'updated_at', j.updated_at,
    'finished_at', j.finished_at
  )
  from public.team_jobs j
  join public.rooms r on r.id = j.room_id
  join public.tasks t on t.id = j.task_id
  where j.id = p_job_id
$$;

-- The carrier of a new team job carries the project's step timeouts (minutes
-- per step kind) as `timeouts`, when the owner set any.
create function threadlink_private.tasks_v10_carrier_timeouts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content jsonb;
  v_timeouts jsonb;
begin
  if new.task_type <> 'team' then
    return new;
  end if;
  begin
    v_content := new.content::jsonb;
  exception when others then
    return new;
  end;
  select r.step_timeouts into v_timeouts from public.rooms r
  where r.id = v_content ->> 'roomId' and r.owner_user_id = new.owner_user_id;
  if v_timeouts is not null and v_timeouts <> '{}'::jsonb then
    new.content := (v_content || jsonb_build_object('timeouts', v_timeouts))::text;
  end if;
  return new;
end;
$$;
create trigger tasks_v10_carrier_timeouts before insert on public.tasks
  for each row execute function threadlink_private.tasks_v10_carrier_timeouts();

-- ---------------------------------------------------------------------------
-- 10. Job starts: + the protocol gate (section 8). Same checks as 0.9 first.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.team_route_check(
  p_owner text, p_room public.rooms, p_link public.thread_links, p_mode text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_runtime public.runtimes;
  v_protocol integer;
  v_needed integer := threadlink_private.min_protocol_for(p_mode);
begin
  if p_link.id is null or p_link.owner_user_id <> p_owner or p_link.status <> 'active'
     or p_link.agent_session_id is distinct from p_room.agent_session_id
     or not threadlink_private.session_is_usable(p_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002', hint = 'route_missing';
  end if;
  if p_link.paused then
    raise exception 'link is paused' using errcode = '55000', hint = 'link_paused';
  end if;
  select r.* into v_runtime
  from public.session_bindings sb
  join public.runtimes r on r.id = sb.runtime_id
  where sb.id = p_room.agent_session_id and sb.owner_user_id = p_owner;
  if not threadlink_private.version_at_least(v_runtime.version, 0,
                                             threadlink_private.team_min_runtime_minor(p_mode)) then
    raise exception 'team mode unavailable: update the ThreadLink app on the computer this project runs on'
      using errcode = '55000', hint = 'runtime_outdated',
            detail = 'protocol=' || threadlink_private.runtime_protocol_of(v_runtime.version, v_runtime.protocol)
                     || ',required=' || v_needed;
  end if;
  v_protocol := threadlink_private.runtime_protocol_of(v_runtime.version, v_runtime.protocol);
  if v_protocol < v_needed then
    raise exception 'ThreadLink on this computer needs an update before this work can start'
      using errcode = '55000', hint = 'runtime_outdated', detail = 'protocol=' || v_protocol || ',required=' || v_needed;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Runtime protocol reports: the old calls mean "no protocol reported"; the
--     new overloads record it (section 8). Every answer says the protocol in
--     force and whether this Runtime needs an update.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.runtime_json(p_runtime_id text)
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
    'created_at', r.created_at, 'last_seen_at', r.last_seen_at,
    -- 0.10
    'protocol', threadlink_private.runtime_protocol_of(r.version, r.protocol),
    'protocol_reported', r.protocol is not null,
    'min_protocol', threadlink_private.runtime_protocol_current(),
    'update_required', threadlink_private.runtime_protocol_of(r.version, r.protocol)
                       < threadlink_private.runtime_protocol_current())
  from public.runtimes r where r.id = p_runtime_id
$$;

create or replace function public.register_runtime(
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
        -- The stored protocol is the highest ever reported: never lowered.
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

create function public.register_runtime(
  p_token_hash text, p_label text, p_platform text, p_kind text, p_version text, p_protocol integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_protocol is null or p_protocol not between 1 and 1000 then
    raise exception 'invalid protocol' using errcode = '22023';
  end if;
  v_result := public.register_runtime(p_token_hash, p_label, p_platform, p_kind, p_version);
  update public.runtimes set protocol = greatest(coalesce(protocol, 0), p_protocol) where id = v_result ->> 'id';
  return threadlink_private.runtime_json(v_result ->> 'id');
end;
$$;

create or replace function public.runtime_heartbeat(
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
  -- No protocol in this call: the stored (highest ever) protocol stays.
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

create function public.runtime_heartbeat(
  p_token_hash text, p_version text, p_capabilities jsonb, p_busy_session_ids text[], p_protocol integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_protocol is null or p_protocol not between 1 and 1000 then
    raise exception 'invalid protocol' using errcode = '22023';
  end if;
  v_result := public.runtime_heartbeat(p_token_hash, p_version, p_capabilities, p_busy_session_ids);
  update public.runtimes set protocol = greatest(coalesce(protocol, 0), p_protocol) where id = v_result ->> 'id';
  return threadlink_private.runtime_json(v_result ->> 'id');
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Helpers for the Runtime write path
-- ---------------------------------------------------------------------------

-- A run of THIS job (and provider, when given) in one of the given states.
-- Every mismatch reads the same: "invalid run_id" (hint invalid_run).
create function threadlink_private.tj_run(p_job_id text, p_run_id text, p_provider text, p_statuses text[])
returns public.agent_runs
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.agent_runs;
begin
  if p_run_id is null or p_run_id !~ '^tlarn_[0-9a-f]{32}$' then
    raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
  end if;
  select * into v from public.agent_runs where id = p_run_id and job_id = p_job_id;
  if not found or (p_provider is not null and v.provider <> p_provider) or not (v.status = any (p_statuses)) then
    raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
  end if;
  return v;
end;
$$;

/*
 * Artifact text: newlines normalised, control characters except newline and
 * tab removed, invisible characters removed, redacted. Never clipped (the
 * caller refuses what is too large). NULL when nothing is left.
 */
create function threadlink_private.artifact_clean(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text;
begin
  if p is null then
    return null;
  end if;
  t := pg_catalog.translate(p, U&'\E000\E001', '');
  t := pg_catalog.replace(pg_catalog.replace(t, E'\r\n', E'\n'), E'\r', E'\n');
  t := pg_catalog.translate(t, E'\n\t', U&'\E000\E001');
  t := pg_catalog.regexp_replace(t, '[[:cntrl:]]', '', 'g');
  t := pg_catalog.translate(t, U&'\E000\E001', E'\n\t');
  t := threadlink_private.chat_strip_invisible(t);
  t := threadlink_private.redact_text(t);
  if pg_catalog.btrim(t, E' \n\t') = '' then
    return null;
  end if;
  return t;
end;
$$;

-- A repository-relative path: no absolute path, drive, backslash or "..".
create function threadlink_private.valid_repo_path(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and char_length(p) between 1 and 512 and p !~ '[[:cntrl:]]'
     and p !~ '^/' and p !~ '\\' and p !~ '^[A-Za-z]:' and p !~ '(^|/)\.\.(/|$)'
$$;

-- The fixed words a choice may use for the step it is about.
create function threadlink_private.choice_steps() returns text[]
language sql immutable set search_path = '' as $$
  select array['understanding the request', 'planning', 'reviewing the plan', 'building', 'reviewing',
               'security review', 'inspection', 'testing', 'integrating'] $$;

-- Every option a kind allows, in order ([{key, label}]). Labels are fixed
-- words and provider names from the registry; never agent text.
create function threadlink_private.choice_options(p_kind text, p_params jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select coalesce(threadlink_private.provider_label(p_params ->> 'provider'), 'the agent') as who,
           threadlink_private.provider_label(p_params ->> 'otherProvider') as other
  ),
  o as (
    select x.ord, x.key, x.label from v cross join lateral (values
      (1, case when p_kind = 'provider_failure' then 'retry' end, 'Retry ' || v.who),
      (2, case when p_kind = 'provider_failure' and v.other is not null then 'use_other' end,
          'Use ' || v.other || ' instead'),
      (3, case when p_kind = 'timeout' then 'retry' end, 'Retry this step'),
      (4, case when p_kind = 'timeout' and v.other is not null then 'retry_other' end, 'Retry with ' || v.other),
      (5, case when p_kind = 'timeout' then 'increase_timeout' end, 'Give it more time'),
      (6, case when p_kind = 'plan_disagreement' then 'accept_proposal' end, 'Go with ' || v.who || '''s plan'),
      (7, case when p_kind = 'plan_disagreement' and v.other is not null then 'accept_other' end,
          'Go with ' || v.other || '''s plan'),
      (8, case when p_kind = 'plan_disagreement' then 'extra_round' end, 'Allow one more planning round'),
      (9, case when p_kind = 'interrupted' then 'resume' end, 'Resume from the last safe step'),
      (10, case when p_kind in ('migration', 'production_deploy', 'destructive_action', 'security_action',
                                'paid_usage', 'permission_expansion', 'secret_change') then 'approve' end, 'Approve'),
      (11, case when p_kind in ('migration', 'production_deploy', 'destructive_action', 'security_action',
                                'paid_usage', 'permission_expansion', 'secret_change') then 'deny' end,
           'Don''t approve'),
      (12, case when p_kind in ('provider_failure', 'timeout', 'plan_disagreement', 'interrupted') then 'stop' end,
           'Stop')
    ) as x(ord, key, label)
    where x.key is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', o.key, 'label', o.label) order by o.ord), '[]'::jsonb) from o
$$;

-- The fixed question per kind, filled from trusted parameters only.
create function threadlink_private.choice_title(p_kind text, p_params jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'provider_failure' then
      coalesce(threadlink_private.provider_label(p_params ->> 'provider'), 'An agent') || ' could not finish'
      || coalesce(' while ' || (p_params ->> 'step'), '') || coalesce(' on ' || (p_params ->> 'nodeKey'), '')
      || '. What should ThreadLink do?'
    when 'timeout' then
      coalesce(threadlink_private.provider_label(p_params ->> 'provider'), 'An agent') || ' timed out'
      || coalesce(' after ' || (p_params ->> 'minutes') || ' min', '')
      || coalesce(' while ' || (p_params ->> 'step'), '') || coalesce(' on ' || (p_params ->> 'nodeKey'), '')
      || '. What should ThreadLink do?'
    when 'plan_disagreement' then 'The agents could not agree on a plan within the round limit.'
    when 'interrupted' then 'This work was interrupted while a step was running. What should ThreadLink do?'
    when 'migration' then 'A database migration needs your approval.'
    when 'production_deploy' then 'A production deployment needs your approval.'
    when 'destructive_action' then 'A destructive action needs your approval.'
    when 'security_action' then 'A security-sensitive action needs your approval.'
    when 'paid_usage' then 'This step would use paid usage. Do you approve?'
    when 'permission_expansion' then 'An agent needs more access than this project allows.'
    when 'secret_change' then 'A change to secrets needs your approval.'
  end
$$;

create function threadlink_private.choice_json(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'choice_id', c.id, 'chat_id', c.chat_id, 'job_id', c.job_id, 'run_id', c.run_id, 'kind', c.kind,
    'title', c.title, 'options', c.options, 'status', c.status, 'chosen_key', c.chosen_key,
    'decided_at', c.decided_at, 'expires_at', c.expires_at, 'created_at', c.created_at)
  from public.user_choices c where c.id = p_id
$$;

create function threadlink_private.artifact_json(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'artifact_id', a.id, 'chat_id', a.chat_id, 'job_id', a.job_id, 'run_id', a.run_id, 'kind', a.kind,
    'title', a.title, 'mime', a.mime, 'bytes', a.bytes, 'created_by', a.created_by, 'created_at', a.created_at)
  from public.chat_artifacts a where a.id = p_id
$$;

-- The step a run was on, in the fixed words of a timeout row.
create function threadlink_private.run_step_text(p_activity text, p_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(case p_activity
    when 'reading' then 'reading the project' when 'planning' then 'planning' when 'building' then 'building'
    when 'reviewing' then 'reviewing' when 'testing' then 'testing' when 'responding' then 'responding'
    when 'integrating' then 'integrating' end,
    case p_role
    when 'coordinator' then 'coordinating' when 'planner' then 'planning' when 'builder' then 'building'
    when 'reviewer' then 'reviewing' when 'security_reviewer' then 'reviewing security'
    when 'test_reviewer' then 'reviewing tests' when 'integrator' then 'integrating'
    when 'investigator' then 'investigating' end)
$$;

-- Verified = completed, model and access verified, a native session, on the
-- project's own Runtime. Anything missing is at most "partially verified".
create function threadlink_private.run_is_verified(p_run public.agent_runs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_run.status = 'completed' and p_run.model_verified and p_run.access_verified
     and p_run.native_session_id is not null and p_run.runtime_id is not null
     and p_run.runtime_id = (select threadlink_private.room_runtime(j.room_id)
                             from public.team_jobs j where j.id = p_run.job_id)
$$;

-- The chat row a message replies to: a team message id (tlamg_) or a chat row
-- id (tlcev_) of THIS job or its chat. Anything else is "invalid reply_to".
create function threadlink_private.tj_reply(p_job public.team_jobs, p_ref text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_ref is null then
    return null;
  end if;
  if p_ref ~ '^tlamg_[0-9a-f]{32}$' then
    select e.id into v from public.chat_events e where e.team_message_id = p_ref and e.job_id = p_job.id;
  elsif p_ref ~ '^tlcev_[0-9a-f]{32}$' then
    select e.id into v from public.chat_events e
    where e.id = p_ref and e.owner_user_id = p_job.owner_user_id
      and (e.job_id = p_job.id or (p_job.chat_id is not null and e.chat_id = p_job.chat_id));
  end if;
  if v is null then
    raise exception 'invalid reply_to' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- What a message refers to, inside THIS job (or its chat, for artifacts and
-- chat rows). A node may be named by its key. Returns the referenced id.
create function threadlink_private.tj_ref(p_job public.team_jobs, p_kind text, p_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_kind is null and p_id is null then
    return null;
  end if;
  if p_kind is null or p_id is null then
    raise exception 'invalid ref' using errcode = '22023';
  end if;
  case p_kind
    when 'finding' then
      select id into v from public.team_findings where id = p_id and job_id = p_job.id;
    when 'decision' then
      select id into v from public.team_decisions where id = p_id and job_id = p_job.id;
    when 'node' then
      if p_id ~ '^tlnod_[0-9a-f]{32}$' then
        select id into v from public.team_nodes where id = p_id and job_id = p_job.id;
      elsif p_id ~ threadlink_private.team_node_key_pattern() then
        select id into v from public.team_nodes where node_key = p_id and job_id = p_job.id;
      end if;
    when 'artifact' then
      select id into v from public.chat_artifacts
      where id = p_id and owner_user_id = p_job.owner_user_id and deleted_at is null
        and (job_id = p_job.id or (p_job.chat_id is not null and chat_id = p_job.chat_id));
    when 'message' then
      select id into v from public.chat_events
      where id = p_id and owner_user_id = p_job.owner_user_id
        and (job_id = p_job.id or (p_job.chat_id is not null and chat_id = p_job.chat_id));
    when 'choice' then
      select id into v from public.user_choices where id = p_id and job_id = p_job.id;
    else
      v := null;
  end case;
  if v is null then
    raise exception 'invalid ref' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Runtime write (claim-gated): the 0.9 ops plus run_started, run_activity,
--     run_finished, request_choice, read_choices, add_change, add_artifact and
--     ack_control; add_message / add_finding / set_finding_status /
--     add_decision / read_owner_notes / set_status / set_final extended.
--     Replaced in place (same signature, grants preserved).
-- ---------------------------------------------------------------------------
create or replace function public.team_job_write(
  p_token_hash text,
  p_session_id text,
  p_job_id text,
  p_claim_ref text,
  p_op text,
  p_payload jsonb
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
  v_job public.team_jobs;
  v_room public.rooms;
  v_task public.tasks;
  v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_result jsonb := '{}'::jsonb;
  v_id text;
  v_node public.team_nodes;
  v_item jsonb;
  v_text text;
  v_hash text;
  v_status text;
  v_number integer;
  v_decision_id text;
  v_approved boolean;
  v_count integer;
  v_strings text[];
  v_round integer;
  v_note record;
  v_notes jsonb;
  v_provider text;
  -- 0.10
  v_run public.agent_runs;
  v_prev_run public.agent_runs;
  v_protocol integer := threadlink_private.connection_protocol(v_connection.id);
  v_run_id text;
  v_reply text;
  v_ref_kind text;
  v_ref_id text;
  v_payload jsonb;
  v_choice public.user_choices;
  v_artifact_id text;
  v_participant text;
  v_kind text;
  v_options jsonb;
  v_params jsonb;
  v_title text;
  v_other text;
  v_step text;
  v_node_id text;
  v_node_key text;
  v_content text;
  v_tests jsonb;
  v_int1 bigint;
  v_int2 bigint;
  v_int3 bigint;
  v_bool1 boolean;
  v_bool2 boolean;
  v_event_id text;
begin
  select * into v_job from public.team_jobs
  where id = p_job_id and owner_user_id = v_connection.owner_user_id
  for update;
  if not found then
    raise exception 'team job not found' using errcode = 'P0002';
  end if;
  -- The authority: this exact agent session holds the carrier task's claim.
  -- A different session gets "not found"; a wrong claim_ref gets 55000.
  v_task := threadlink_private.require_claimed_task(
    v_session, v_job.task_id, p_claim_ref, array['claimed', 'working']);

  select * into v_room from public.rooms where id = v_job.room_id;
  if v_room.status = 'deleted' then
    raise exception 'room was deleted' using errcode = '55000';
  end if;
  if v_job.finished_at is not null then
    raise exception 'team job is finished' using errcode = '55000';
  end if;
  -- The claim that is doing the work. A Runtime whose lease lapsed during a
  -- long step and that claims its own job again is not a crash (see
  -- tasks_v10_reclaim_guard); only a different claimant is.
  if v_job.last_claim_ref is distinct from p_claim_ref then
    update public.team_jobs set last_claim_ref = p_claim_ref where id = v_job.id;
    v_job.last_claim_ref := p_claim_ref;
  end if;
  -- Artifacts and diffs carry up to 512 KiB of text; everything else stays small.
  v_int1 := 131072;
  if p_op in ('add_artifact', 'add_change') then
    v_int1 := 1048576;
  end if;
  if jsonb_typeof(v_p) <> 'object' or octet_length(v_p::text) > v_int1 then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if (select count(*) from public.team_messages where job_id = v_job.id)
     + (select count(*) from public.team_findings where job_id = v_job.id)
     + (select count(*) from public.model_usage_events where job_id = v_job.id)
     >= threadlink_private.team_max_entries_per_job()
     and p_op in ('add_message', 'add_finding', 'record_usage') then
    raise exception 'team log limit reached' using errcode = '54000';
  end if;

  case p_op
  -- ---------------------------------------------------------------- set_spec
  when 'set_spec' then
    perform threadlink_private.tj_keys(v_p, array['spec']);
    if not threadlink_private.valid_team_spec(v_p -> 'spec') then
      raise exception 'invalid spec' using errcode = '22023';
    end if;
    if v_job.spec is not null then
      if v_job.spec is distinct from v_p -> 'spec' then
        raise exception 'the job spec is stored once' using errcode = '55000';
      end if;
    else
      update public.team_jobs set spec = v_p -> 'spec' where id = v_job.id;
    end if;
    perform threadlink_private.team_advance(v_job.id, 'normalising');

  -- ---------------------------------------------------------------- set_plan
  when 'set_plan' then
    perform threadlink_private.tj_keys(v_p, array['plan', 'approved_by', 'client_hash', 'round']);
    if v_p -> 'plan' is null or jsonb_typeof(v_p -> 'plan') <> 'object'
       or octet_length((v_p -> 'plan')::text) > 65536 then
      raise exception 'invalid plan' using errcode = '22023';
    end if;
    perform threadlink_private.tj_int(v_p, 'round', 0, 5, false);
    v_text := threadlink_private.tj_text(v_p, 'client_hash', 64, false);
    if v_text is not null and v_text !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid client_hash' using errcode = '22023';
    end if;
    v_strings := threadlink_private.tj_strings(v_p, 'approved_by', 2, 20, '^(claude-code|codex)$');
    v_approved := cardinality(v_strings) > 0;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_p -> 'plan')::text, 'UTF8')), 'hex');
    update public.team_jobs
    set plan = v_p -> 'plan',
        plan_hash = v_hash,
        client_plan_hash = v_text,
        -- Approval belongs to one exact plan: any edit drops it.
        plan_approved_hash = case when v_approved then v_hash
                                  when plan_approved_hash = v_hash then plan_approved_hash
                                  else null end,
        plan_approved_by = case when v_approved then v_strings
                                when plan_approved_hash = v_hash then plan_approved_by
                                else '{}' end
    where id = v_job.id;
    perform threadlink_private.team_advance(v_job.id, 'planning');
    v_result := jsonb_build_object('plan_hash', v_hash);

  -- ------------------------------------------------------------ upsert_nodes
  when 'upsert_nodes' then
    perform threadlink_private.tj_keys(v_p, array['nodes', 'decision_number']);
    if v_p -> 'nodes' is null or jsonb_typeof(v_p -> 'nodes') <> 'array'
       or jsonb_array_length(v_p -> 'nodes') not between 1 and 100 then
      raise exception 'invalid nodes' using errcode = '22023';
    end if;
    v_number := threadlink_private.tj_int(v_p, 'decision_number', 1, 9999999, false);
    for v_item in select value from jsonb_array_elements(v_p -> 'nodes') loop
      perform threadlink_private.tj_keys(v_item, array['key', 'title', 'description', 'owner_provider',
        'reviewer_provider', 'depends_on', 'scope', 'files', 'worktree_branch', 'status']);
      v_status := threadlink_private.tj_enum(v_item, 'status', threadlink_private.team_node_statuses(), false);
      v_text := threadlink_private.tj_text(v_item, 'key', 64, true);
      if v_text !~ threadlink_private.team_node_key_pattern() then
        raise exception 'invalid node key' using errcode = '22023';
      end if;
      select * into v_node from public.team_nodes where job_id = v_job.id and node_key = v_text for update;
      if v_status in ('approved', 'integrated') and (v_node.id is null or v_status is distinct from v_node.status) then
        raise exception 'a node is approved through set_node_status' using errcode = '22023';
      end if;
      if found then
        if v_node.status not in ('pending', 'ready') then
          raise exception 'node has started; its definition is fixed' using errcode = '55000';
        end if;
        if (v_item ->> 'owner_provider') is distinct from v_node.owner_provider and v_number is null then
          raise exception 'changing a node owner needs a decision' using errcode = '55000';
        end if;
        if v_number is not null then
          perform threadlink_private.team_decision_for(v_job.id, v_number);
        end if;
        update public.team_nodes set
          title = threadlink_private.tj_text(v_item, 'title', 800, true),
          description = threadlink_private.tj_text(v_item, 'description', 4000, false),
          owner_provider = threadlink_private.tj_enum(v_item, 'owner_provider',
                             threadlink_private.team_providers(), true),
          reviewer_provider = threadlink_private.tj_enum(v_item, 'reviewer_provider',
                                threadlink_private.team_providers(), false),
          depends_on = threadlink_private.tj_strings(v_item, 'depends_on', 32, 64,
                         threadlink_private.team_node_key_pattern()),
          scope = threadlink_private.tj_text(v_item, 'scope', 2000, false),
          files = threadlink_private.tj_strings(v_item, 'files', 200, 512, null),
          worktree_branch = threadlink_private.tj_text(v_item, 'worktree_branch', 200, false),
          status = coalesce(v_status, status)
        where id = v_node.id;
      else
        if (select count(*) from public.team_nodes where job_id = v_job.id)
           >= threadlink_private.team_max_nodes_per_job() then
          raise exception 'node limit reached' using errcode = '54000';
        end if;
        insert into public.team_nodes
          (owner_user_id, job_id, node_key, title, description, owner_provider, reviewer_provider,
           depends_on, scope, files, worktree_branch, status)
        values
          (v_job.owner_user_id, v_job.id, v_text,
           threadlink_private.tj_text(v_item, 'title', 800, true),
           threadlink_private.tj_text(v_item, 'description', 4000, false),
           threadlink_private.tj_enum(v_item, 'owner_provider', threadlink_private.team_providers(), true),
           threadlink_private.tj_enum(v_item, 'reviewer_provider', threadlink_private.team_providers(), false),
           threadlink_private.tj_strings(v_item, 'depends_on', 32, 64, threadlink_private.team_node_key_pattern()),
           threadlink_private.tj_text(v_item, 'scope', 2000, false),
           threadlink_private.tj_strings(v_item, 'files', 200, 512, null),
           threadlink_private.tj_text(v_item, 'worktree_branch', 200, false),
           coalesce(v_status, 'pending'));
      end if;
    end loop;
    perform threadlink_private.team_assert_dag(v_job.id);

  -- --------------------------------------------------------- set_node_status
  when 'set_node_status' then
    perform threadlink_private.tj_keys(v_p, array['key', 'status', 'authorship', 'worktree_branch']);
    v_id := threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'key', 64, true));
    v_status := threadlink_private.tj_enum(v_p, 'status', threadlink_private.team_node_statuses(), true);
    select * into v_node from public.team_nodes where id = v_id for update;
    if v_node.status in ('integrated', 'skipped', 'failed') and v_status is distinct from v_node.status then
      raise exception 'node is finished' using errcode = '55000';
    end if;
    if v_node.status = 'approved' and v_status not in ('approved', 'integrated') then
      raise exception 'an approved node can only be integrated' using errcode = '55000';
    end if;
    if v_status = 'integrated' and v_node.status not in ('approved', 'integrated') then
      raise exception 'only an approved node can be integrated' using errcode = '55000';
    end if;
    if v_status = 'skipped' and v_node.status not in ('pending', 'ready', 'skipped') then
      raise exception 'only a node that has not started can be skipped' using errcode = '55000';
    end if;
    if v_status in ('approved', 'integrated') then
      -- A solo job has no reviewer by design (one agent, no cross-review);
      -- every other mode still needs the node's reviewer to approve it.
      if v_node.reviewer_provider is null and v_job.mode <> 'solo' then
        raise exception 'a node is approved only by a reviewer' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_findings
                 where node_id = v_id and status = any (threadlink_private.finding_open_states())
                   and severity in ('blocking', 'important')) then
        raise exception 'node has open blocking findings' using errcode = '55000';
      end if;
    end if;
    if v_status = 'running' then
      perform threadlink_private.team_advance(v_job.id, 'building');
    end if;
    update public.team_nodes
    set status = v_status,
        authorship = coalesce(threadlink_private.tj_enum(v_p, 'authorship', array['single', 'mixed'], false),
                              authorship),
        worktree_branch = coalesce(threadlink_private.tj_text(v_p, 'worktree_branch', 200, false),
                                   worktree_branch)
    where id = v_id;

  -- ------------------------------------------------------------- add_message
  -- 0.10: an agent's message names the run that wrote it (same job, same
  -- provider, running or completed). A Runtime of protocol 10 or later can no
  -- longer write a runless agent message; older Runtimes still can (legacy
  -- rows, shown as unverified). Replies and references stay inside the job.
  when 'add_message' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'sender', 'sender_role', 'receiver', 'type',
                                                  'round', 'body', 'model_observed', 'run_id', 'reply_to',
                                                  'ref_kind', 'ref_id']);
    -- What the Runtime observed the model to be (never what it asked for).
    v_text := threadlink_private.tj_text(v_p, 'model_observed', 100, false);
    if v_text is not null and v_text !~ threadlink_private.chat_model_pattern() then
      raise exception 'invalid model_observed' using errcode = '22023';
    end if;
    v_provider := threadlink_private.tj_enum(v_p, 'sender', array['claude-code', 'codex', 'threadlink'], true);
    v_status := threadlink_private.tj_enum(v_p, 'sender_role', threadlink_private.team_roles(), false);
    v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
    if v_provider = 'threadlink' then
      if v_run_id is not null then
        raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
      end if;
    elsif v_run_id is null then
      if v_protocol >= threadlink_private.min_protocol_for('runs') then
        raise exception 'an agent message needs the run that wrote it' using errcode = '22023',
          hint = 'run_required';
      end if;
    else
      v_run := threadlink_private.tj_run(v_job.id, v_run_id, v_provider, array['running', 'completed']);
      if v_status is not null and v_status <> v_run.role then
        raise exception 'invalid sender_role' using errcode = '22023';
      end if;
      v_status := v_run.role;
      -- The model is the run's observed model, never a separate claim.
      if v_text is not null and v_run.observed_model is not null and v_text <> v_run.observed_model then
        raise exception 'model_observed differs from the run' using errcode = '22023', hint = 'model_mismatch';
      end if;
      v_text := case when v_run.observed_model ~ threadlink_private.chat_model_pattern()
                     then v_run.observed_model end;
    end if;
    v_reply := threadlink_private.tj_reply(v_job, threadlink_private.tj_text(v_p, 'reply_to', 64, false));
    v_ref_kind := threadlink_private.tj_enum(v_p, 'ref_kind', threadlink_private.ref_kinds(), false);
    v_ref_id := threadlink_private.tj_ref(v_job, v_ref_kind, threadlink_private.tj_text(v_p, 'ref_id', 64, false));
    -- A reply to a finding, decision or choice replies to its card in the chat.
    if v_reply is null and v_ref_kind in ('finding', 'decision', 'choice') then
      select e.id into v_reply from public.chat_events e
      where e.job_id = v_job.id and e.ref_kind = v_ref_kind and e.ref_id = v_ref_id
      order by e.seq
      limit 1;
    end if;
    insert into public.team_messages
      (owner_user_id, job_id, node_id, sender, sender_role, receiver, message_type, round, body, model_observed,
       run_id, reply_to_event_id, ref_kind, ref_id)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       v_provider, v_status,
       threadlink_private.tj_enum(v_p, 'receiver', array['claude-code', 'codex', 'threadlink'], false),
       threadlink_private.tj_enum(v_p, 'type', threadlink_private.team_message_types(), true),
       coalesce(threadlink_private.tj_int(v_p, 'round', 0, 6, false),
                greatest(v_job.planning_round, v_job.review_round)),
       threadlink_private.tj_text(v_p, 'body', threadlink_private.team_body_max_bytes(), true),
       v_text, v_run.id, v_reply, v_ref_kind, v_ref_id)
    returning id into v_id;
    v_result := jsonb_build_object('message_id', v_id,
      'event_id', (select e.id from public.chat_events e where e.team_message_id = v_id));

  -- ------------------------------------------------------------- add_finding
  -- 0.10: + the raising run (required from protocol 10 for an agent), the
  -- owning participant and a file:line.
  when 'add_finding' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'severity', 'category', 'title', 'body',
                                                  'location', 'raised_by', 'round', 'phase', 'run_id',
                                                  'owner_participant', 'file_path', 'line']);
    v_provider := threadlink_private.tj_enum(v_p, 'raised_by', array['claude-code', 'codex', 'threadlink'], true);
    v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
    if v_provider = 'threadlink' then
      if v_run_id is not null then
        raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
      end if;
    elsif v_run_id is null then
      if v_protocol >= threadlink_private.min_protocol_for('runs') then
        raise exception 'a finding needs the run that raised it' using errcode = '22023', hint = 'run_required';
      end if;
    else
      v_run := threadlink_private.tj_run(v_job.id, v_run_id, v_provider, array['running', 'completed']);
    end if;
    v_participant := threadlink_private.tj_text(v_p, 'owner_participant', 120, false);
    if v_participant is not null and (v_participant !~ threadlink_private.participant_key_pattern()
       or not (pg_catalog.split_part(v_participant, ':', 1) = any (threadlink_private.job_participants(v_job.id)))) then
      raise exception 'invalid owner_participant' using errcode = '22023';
    end if;
    v_text := threadlink_private.tj_text(v_p, 'file_path', 512, false);
    if v_text is not null and (v_text ~ '[[:cntrl:]]' or char_length(v_text) > 512) then
      raise exception 'invalid file_path' using errcode = '22023';
    end if;
    v_text := threadlink_private.redact_text(v_text);
    v_int1 := threadlink_private.tj_int(v_p, 'line', 1, 10000000, false);
    if v_int1 is not null and v_text is null then
      raise exception 'invalid line' using errcode = '22023';
    end if;
    insert into public.team_findings
      (owner_user_id, job_id, node_id, severity, category, title, body, location, raised_by, raised_round, phase,
       raised_run_id, owner_participant, file_path, line)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       threadlink_private.tj_enum(v_p, 'severity', threadlink_private.team_finding_severities(), true),
       threadlink_private.tj_enum(v_p, 'category', threadlink_private.team_finding_categories(), true),
       threadlink_private.tj_text(v_p, 'title', 800, true),
       threadlink_private.tj_text(v_p, 'body', threadlink_private.team_body_max_bytes(), true),
       coalesce(threadlink_private.tj_text(v_p, 'location', 2048, false),
                pg_catalog.left(v_text || coalesce(':' || v_int1, ''), 512)),
       v_provider,
       coalesce(threadlink_private.tj_int(v_p, 'round', 0, 6, false), v_job.review_round),
       threadlink_private.tj_enum(v_p, 'phase', array['planning', 'review', 'inspection'], false),
       v_run.id, v_participant, v_text, v_int1)
    returning id into v_id;
    v_result := jsonb_build_object('finding_id', v_id);

  -- ------------------------------------------------------ set_finding_status
  when 'set_finding_status' then
    perform threadlink_private.tj_keys(v_p, array['finding_id', 'status', 'resolution', 'decision_number', 'round',
                                                  'run_id']);
    v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
    if v_run_id is not null then
      v_run := threadlink_private.tj_run(v_job.id, v_run_id, null, array['running', 'completed']);
    end if;
    v_round := threadlink_private.tj_int(v_p, 'round', 0, 6, false);
    v_text := threadlink_private.tj_text(v_p, 'finding_id', 64, true);
    v_status := threadlink_private.tj_enum(v_p, 'status', threadlink_private.team_finding_statuses(), true);
    v_number := threadlink_private.tj_int(v_p, 'decision_number', 1, 9999999, false);
    select id into v_id from public.team_findings where id = v_text and job_id = v_job.id for update;
    if v_id is null then
      raise exception 'finding not found' using errcode = 'P0002';
    end if;
    v_decision_id := case when v_number is not null
                          then threadlink_private.team_decision_for(v_job.id, v_number) end;
    -- Dismissing (or the legacy wont_fix of) a blocking/important finding needs a decision.
    if v_status in ('wont_fix', 'dismissed') and v_decision_id is null
       and (select severity from public.team_findings where id = v_id) in ('blocking', 'important') then
      raise exception 'dismissing a blocking finding needs a decision' using errcode = '55000';
    end if;
    update public.team_findings
    set status = v_status,
        resolved_round = case when v_status = any (threadlink_private.finding_open_states()) then null
                              else coalesce(v_round, v_job.review_round) end,
        resolution = case when v_status = 'open' then null
                          else coalesce(threadlink_private.tj_text(v_p, 'resolution', 4000, false), resolution) end,
        decision_id = coalesce(v_decision_id, decision_id),
        resolved_run_id = coalesce(v_run.id, resolved_run_id)
    where id = v_id;

  -- ------------------------------------------------------------ add_decision
  when 'add_decision' then
    perform threadlink_private.tj_keys(v_p, array['title', 'proposals', 'evidence', 'resolution', 'basis',
                                                  'requires_user', 'approved_by', 'title_source', 'run_id']);
    -- 0.10: who titled it. A ThreadLink title is one of the fixed titles; an
    -- agent's title is attributed to that agent's run.
    v_kind := threadlink_private.tj_enum(v_p, 'title_source', array['threadlink', 'agent'], false);
    v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
    if v_kind is null and v_protocol >= threadlink_private.min_protocol_for('runs') then
      raise exception 'a decision needs its title source' using errcode = '22023', hint = 'title_source_required';
    end if;
    if v_kind = 'threadlink' then
      if v_run_id is not null
         or not (threadlink_private.tj_text(v_p, 'title', 800, true) = any (threadlink_private.decision_fixed_titles())) then
        raise exception 'invalid title' using errcode = '22023';
      end if;
    elsif v_kind = 'agent' then
      v_run := threadlink_private.tj_run(v_job.id, v_run_id, null, array['running', 'completed']);
    elsif v_run_id is not null then
      raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
    end if;
    v_strings := threadlink_private.tj_strings(v_p, 'approved_by', 2, 20, '^(claude-code|codex)$');
    if v_p -> 'proposals' is not null and (jsonb_typeof(v_p -> 'proposals') <> 'array'
       or jsonb_array_length(v_p -> 'proposals') > 10 or octet_length((v_p -> 'proposals')::text) > 16384) then
      raise exception 'invalid proposals' using errcode = '22023';
    end if;
    if v_p -> 'evidence' is not null and (jsonb_typeof(v_p -> 'evidence') not in ('object', 'array')
       or octet_length((v_p -> 'evidence')::text) > 16384) then
      raise exception 'invalid evidence' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('threadlink:decisions:' || v_job.owner_user_id, 0));
    select coalesce(max(number), 0) + 1 into v_number
    from public.team_decisions where owner_user_id = v_job.owner_user_id;
    if v_number > 9999999 then
      raise exception 'decision limit reached' using errcode = '54000';
    end if;
    insert into public.team_decisions
      (owner_user_id, job_id, number, title, proposals, evidence, resolution, basis, requires_user, approved_by,
       title_source, author_run_id)
    values
      (v_job.owner_user_id, v_job.id, v_number,
       threadlink_private.tj_text(v_p, 'title', 800, true),
       coalesce(v_p -> 'proposals', '[]'::jsonb),
       v_p -> 'evidence',
       threadlink_private.tj_text(v_p, 'resolution', 4000, false),
       threadlink_private.tj_enum(v_p, 'basis', threadlink_private.team_arbitration_bases(), false),
       coalesce(threadlink_private.tj_bool(v_p, 'requires_user'), false),
       v_strings, v_kind, v_run.id)
    returning id into v_id;
    perform threadlink_private.record_event(
      v_job.owner_user_id, v_connection.id, 'team.decision', 'team_decision', v_id,
      jsonb_build_object('job_id', v_job.id, 'number', v_number));
    v_result := jsonb_build_object('decision_id', v_id, 'number', v_number);

  -- -------------------------------------------------------------- open_round
  when 'open_round' then
    perform threadlink_private.tj_keys(v_p, array['kind', 'round', 'node_key']);
    v_text := threadlink_private.tj_enum(v_p, 'kind', array['planning', 'review'], true);
    v_round := threadlink_private.tj_int(v_p, 'round', 1, 100, false);
    perform threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false));
    v_count := case when v_text = 'planning' then v_job.planning_round else v_job.review_round end;
    if v_round is not null and v_round <= v_count then
      return threadlink_private.team_status_json(v_job.id)
        || jsonb_build_object('op', p_op, 'result', jsonb_build_object('round', v_count, 'opened', false));
    end if;
    if v_round is not null and v_round <> v_count + 1 then
      raise exception 'rounds open one at a time' using errcode = '22023';
    end if;
    -- 0.10: each "Allow one more planning round" the owner chose (a
    -- plan_disagreement choice of this job) adds one round to the budget.
    if v_text = 'planning' and v_job.planning_round >= v_job.max_planning_rounds + v_job.extra_planning_rounds
       and (select count(*) from public.user_choices
            where job_id = v_job.id and kind = 'plan_disagreement' and status = 'chosen'
              and chosen_key = 'extra_round') > v_job.extra_planning_rounds then
      update public.team_jobs set extra_planning_rounds = extra_planning_rounds + 1 where id = v_job.id
      returning * into v_job;
    end if;
    if (v_text = 'planning' and v_job.planning_round >= v_job.max_planning_rounds + v_job.extra_planning_rounds)
       or (v_text = 'review' and v_job.review_round >= v_job.max_review_rounds) then
      raise exception '% round budget exhausted', v_text using errcode = '54000';
    end if;
    v_result := jsonb_build_object('round', v_count + 1, 'opened', true);
    update public.team_jobs
    set planning_round = planning_round + case when v_text = 'planning' then 1 else 0 end,
        review_round = review_round + case when v_text = 'review' then 1 else 0 end
    where id = v_job.id;
    perform threadlink_private.team_advance(v_job.id, case when v_text = 'planning' then 'planning'
                                                           else 'reviewing' end);

  -- ------------------------------------------------------------ record_usage
  when 'record_usage' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'provider', 'role', 'requested_model',
      'observed_model', 'model_class', 'effort', 'reason', 'escalated_from', 'escalation_reason', 'outcome',
      'input_tokens', 'output_tokens']);
    insert into public.model_usage_events
      (owner_user_id, job_id, node_id, provider, role, requested_model, observed_model, model_class, effort,
       reason, escalated_from, escalation_reason, outcome, input_tokens, output_tokens)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       threadlink_private.tj_enum(v_p, 'provider', threadlink_private.team_providers(), true),
       threadlink_private.tj_enum(v_p, 'role', threadlink_private.team_roles(), true),
       threadlink_private.tj_text(v_p, 'requested_model', 200, true),
       threadlink_private.tj_text(v_p, 'observed_model', 200, false),
       threadlink_private.tj_enum(v_p, 'model_class', threadlink_private.team_model_classes(), true),
       threadlink_private.tj_text(v_p, 'effort', 40, false),
       threadlink_private.tj_text(v_p, 'reason', 1000, true),
       threadlink_private.tj_enum(v_p, 'escalated_from', threadlink_private.team_model_classes(), false),
       threadlink_private.tj_text(v_p, 'escalation_reason', 1000, false),
       threadlink_private.tj_enum(v_p, 'outcome', threadlink_private.team_usage_outcomes(), true),
       threadlink_private.tj_int(v_p, 'input_tokens', 0, 1000000000, false),
       threadlink_private.tj_int(v_p, 'output_tokens', 0, 1000000000, false))
    returning id into v_id;
    v_result := jsonb_build_object('usage_event_id', v_id);

  -- -------------------------------------------------------------- set_status
  when 'set_status' then
    perform threadlink_private.tj_keys(v_p, array['status', 'line']);
    v_status := threadlink_private.tj_enum(v_p, 'status', threadlink_private.team_job_statuses(), true);
    if v_status not in ('normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
                        'cancelled', 'interrupted', 'paused') then
      raise exception 'status % is set only by set_final', v_status using errcode = '22023';
    end if;
    v_text := threadlink_private.tj_text(v_p, 'line', 800, false);
    if v_text is not null and (char_length(v_text) > 200 or v_text ~ '[[:cntrl:]]') then
      raise exception 'invalid line' using errcode = '22023';
    end if;
    update public.team_jobs
    set status = v_status,
        status_line = coalesce(v_text, status_line),
        finished_at = case when v_status = 'cancelled' then pg_catalog.now() end
    where id = v_job.id;
    if v_status = 'cancelled' then
      perform threadlink_private.record_event(
        v_job.owner_user_id, v_connection.id, 'team.job_finished', 'team_job', v_job.id,
        jsonb_build_object('status', v_status));
    end if;

  -- --------------------------------------------------------------- set_final
  when 'set_final' then
    perform threadlink_private.tj_keys(v_p, array['verdict', 'evidence', 'summary', 'reason', 'provider']);
    -- The provider the reason is about (chat-first): a participant of this job.
    v_provider := threadlink_private.tj_enum(v_p, 'provider', threadlink_private.team_providers(), false);
    if v_provider is not null and not exists (
         select 1 from public.tasks t
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(t.content::jsonb -> 'agents') = 'array'
                then t.content::jsonb -> 'agents' else '[]'::jsonb end) a
         where t.id = v_job.task_id and a ->> 'provider' = v_provider) then
      raise exception 'invalid provider' using errcode = '22023';
    end if;
    if v_p ? 'reason' and (jsonb_typeof(v_p -> 'reason') <> 'string'
        or threadlink_private.chat_reason_text(v_p ->> 'reason') is null) then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
    v_text := threadlink_private.tj_enum(v_p, 'verdict', threadlink_private.team_verdicts(), true);
    if v_p -> 'evidence' is null or jsonb_typeof(v_p -> 'evidence') <> 'object'
       or octet_length((v_p -> 'evidence')::text) > 32768 then
      raise exception 'invalid evidence' using errcode = '22023';
    end if;
    if v_text = 'PASS' then
      -- A solo job has no reviewer; with no project checks either, nothing
      -- independent looked at the work. The Runtime reports NEEDS_USER_DECISION.
      if v_job.mode = 'solo' and cardinality(v_job.verify_commands) = 0 then
        raise exception 'PASS refused: nothing reviewed or tested this solo job'
          using errcode = '55000', hint = 'solo_unverified';
      end if;
      if exists (select 1 from public.team_findings
                 where job_id = v_job.id and status = any (threadlink_private.finding_open_states())
                   and severity in ('blocking', 'important')) then
        raise exception 'PASS refused: open blocking or important findings' using errcode = '55000';
      end if;
      if exists (select 1 from public.user_choices where job_id = v_job.id and status = 'pending') then
        raise exception 'PASS refused: a choice is waiting for the user' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_nodes where job_id = v_job.id and status = 'failed') then
        raise exception 'PASS refused: a node failed' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_nodes
                 where job_id = v_job.id and status not in ('approved', 'integrated', 'skipped')) then
        raise exception 'PASS refused: unfinished nodes' using errcode = '55000';
      end if;
      if v_job.plan_hash is null or v_job.plan_approved_hash is distinct from v_job.plan_hash then
        raise exception 'PASS refused: no approved plan, or the plan changed after approval'
          using errcode = '55000';
      end if;
      if not exists (select 1 from public.team_nodes where job_id = v_job.id) then
        raise exception 'PASS refused: no units of work' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_decisions where job_id = v_job.id and requires_user) then
        raise exception 'PASS refused: a decision is waiting for the user' using errcode = '55000';
      end if;
    end if;
    update public.team_jobs
    set verdict = v_text,
        evidence = v_p -> 'evidence',
        summary = threadlink_private.tj_text(v_p, 'summary', 4000, false),
        verdict_reason = case when v_text = 'PASS' then null else v_p ->> 'reason' end,
        verdict_provider = case when v_text = 'PASS' then null else v_provider end,
        status = case v_text when 'PASS' then 'completed' when 'NEEDS_FIX' then 'needs_fix'
                             when 'BLOCKED' then 'blocked' else 'needs_user_decision' end,
        finished_at = pg_catalog.now()
    where id = v_job.id;
    perform threadlink_private.record_event(
      v_job.owner_user_id, v_connection.id, 'team.job_finished', 'team_job', v_job.id,
      jsonb_build_object('verdict', v_text));

  -- -------------------------------------------------------- read_owner_notes
  -- The owner's undelivered notes to THIS job (posted in its room after it
  -- started), oldest first. Reading marks them delivered and tells the chat.
  -- The Runtime passes them to the addressed agent(s) as clearly delimited,
  -- untrusted-for-instructions user notes.
  when 'read_owner_notes' then
    perform threadlink_private.tj_keys(v_p, array['limit', 'run_id', 'note_ids']);
    v_count := coalesce(threadlink_private.tj_int(v_p, 'limit', 1, 20, false), 20);
    -- 0.10: the run that reads (or read) the notes (delivery: "seen by <participant>").
    v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
    if v_run_id is not null then
      v_run := threadlink_private.tj_run(v_job.id, v_run_id, null, threadlink_private.run_statuses());
    end if;
    if v_p ? 'note_ids' then
      -- Consumption mode: record which run consumed notes this job already
      -- received (once per note); nothing new is delivered.
      v_strings := threadlink_private.tj_strings(v_p, 'note_ids', 20, 64, '^tlcev_[0-9a-f]{32}$');
      if v_run.id is null or cardinality(v_strings) = 0 then
        raise exception 'invalid note_ids' using errcode = '22023';
      end if;
      update public.chat_events set consumed_by_run_id = v_run.id
      where id = any (v_strings) and owner_user_id = v_job.owner_user_id and job_id = v_job.id
        and author_kind = 'owner' and event_type = 'message' and delivered_at is not null
        and consumed_by_run_id is null;
      get diagnostics v_count = row_count;
      return threadlink_private.team_status_json(v_job.id)
        || jsonb_build_object('op', p_op, 'result', jsonb_build_object('notes', '[]'::jsonb, 'consumed', v_count));
    end if;
    v_notes := '[]'::jsonb;
    for v_note in
      select e.* from public.chat_events e
      where e.owner_user_id = v_job.owner_user_id
        and e.job_id = v_job.id
        and e.room_id = v_job.room_id
        and e.author_kind = 'owner'
        and e.event_type = 'message'
        and e.delivered_at is null
        and e.created_at >= v_job.created_at
      order by e.seq
      limit v_count
      for update
    loop
      update public.chat_events set delivered_at = pg_catalog.now(), consumed_by_run_id = v_run.id
      where id = v_note.id;
      v_notes := v_notes || jsonb_build_array(jsonb_build_object(
        'id', v_note.id, 'seq', v_note.seq, 'chat_seq', v_note.chat_seq, 'audience', v_note.audience,
        'body', v_note.body, 'created_at', v_note.created_at, 'consumed_by_run_id', v_run.id));
      perform threadlink_private.chat_job_event(v_job, 'owner_routed',
        'Your note was passed to ' || case when v_run.id is not null
            then coalesce(threadlink_private.provider_label(v_run.provider), 'the agent')
          when v_note.audience = 'team' then 'the team'
          else coalesce(threadlink_private.chat_provider_label(v_note.audience), 'the team') end || '.',
        'visible');
    end loop;
    v_result := jsonb_build_object('notes', v_notes);


  -- ------------------------------------------------------------- run_started
  -- 0.10 (section 2): a provider execution starts. Idempotent by run_key: the
  -- same key returns the same run (and refuses a different identity).
  when 'run_started' then
    perform threadlink_private.tj_keys(v_p, array['run_key', 'provider', 'participant_key', 'role',
      'requested_model', 'effort', 'access', 'node_key', 'worktree_label', 'timeout_ms', 'continuity',
      'resumed_from_run_key', 'activity']);
    v_text := threadlink_private.tj_text(v_p, 'run_key', 128, true);
    if v_text !~ threadlink_private.run_key_pattern() then
      raise exception 'invalid run_key' using errcode = '22023';
    end if;
    v_provider := threadlink_private.tj_text(v_p, 'provider', 64, true);
    if not (v_provider = any (threadlink_private.job_participants(v_job.id)))
       or not exists (select 1 from public.agent_providers p where p.id = v_provider and p.supported) then
      raise exception 'invalid provider' using errcode = '22023';
    end if;
    v_participant := threadlink_private.tj_text(v_p, 'participant_key', 120, true);
    v_status := threadlink_private.tj_enum(v_p, 'role', threadlink_private.team_roles(), true);
    if v_participant !~ threadlink_private.participant_key_pattern()
       or pg_catalog.split_part(v_participant, ':', 1) <> v_provider then
      raise exception 'invalid participant_key' using errcode = '22023';
    end if;
    select * into v_run from public.agent_runs where job_id = v_job.id and run_key = v_text;
    if found then
      if v_run.provider <> v_provider or v_run.participant_key <> v_participant or v_run.role <> v_status then
        raise exception 'run key already used' using errcode = '55000', hint = 'conflict';
      end if;
      v_result := jsonb_build_object('run_id', v_run.id, 'created', false, 'status', v_run.status);
    else
      if (select count(*) from public.agent_runs where job_id = v_job.id) >= threadlink_private.runs_per_job() then
        raise exception 'run limit reached' using errcode = '54000';
      end if;
      -- After the carrier was re-claimed mid-work (server backstop, section 6),
      -- nothing writes again until the owner chose "Resume".
      if v_status in ('builder', 'integrator') and exists (
           select 1 from (
             select c.status, c.chosen_key from public.user_choices c
             where c.job_id = v_job.id and c.kind = 'interrupted' and c.request_key like 'server:reclaim:%'
             order by c.created_at desc limit 1) last
           where not (last.status = 'chosen' and last.chosen_key = 'resume')) then
        raise exception 'this work was interrupted; the owner decides whether to resume'
          using errcode = '55000', hint = 'interrupted_needs_owner';
      end if;
      v_kind := coalesce(threadlink_private.tj_enum(v_p, 'continuity', array['fresh', 'resumed', 'forked'], false),
                         'fresh');
      v_title := threadlink_private.tj_text(v_p, 'resumed_from_run_key', 128, false);
      if v_kind = 'fresh' and v_title is not null then
        raise exception 'invalid resumed_from_run_key' using errcode = '22023';
      end if;
      if v_kind <> 'fresh' then
        -- A participant resumes only its own session, inside this job.
        select * into v_prev_run from public.agent_runs
        where job_id = v_job.id and run_key = v_title and provider = v_provider
          and participant_key = v_participant;
        if not found then
          raise exception 'invalid resumed_from_run_key' using errcode = '22023';
        end if;
      end if;
      v_title := threadlink_private.tj_text(v_p, 'requested_model', 200, false);
      if v_title is not null and v_title !~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$' then
        raise exception 'invalid requested_model' using errcode = '22023';
      end if;
      v_step := threadlink_private.tj_text(v_p, 'effort', 40, false);
      if v_step is not null and v_step !~ '^[A-Za-z0-9_-]{1,40}$' then
        raise exception 'invalid effort' using errcode = '22023';
      end if;
      v_content := threadlink_private.chat_strip_invisible(threadlink_private.tj_text(v_p, 'worktree_label', 480, false));
      if v_content is not null and (char_length(v_content) > 120 or v_content ~ '[[:cntrl:]]') then
        raise exception 'invalid worktree_label' using errcode = '22023';
      end if;
      insert into public.agent_runs
        (owner_user_id, chat_id, job_id, node_id, runtime_id, provider, participant_key, role, run_key,
         requested_model, effort, access, native_session_continuity, resumed_from_run_id, worktree_label, status,
         activity, last_activity_at, started_at, timeout_ms)
      values
        (v_job.owner_user_id, v_job.chat_id, v_job.id,
         threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
         (select r.id from public.runtimes r where r.connection_id = v_connection.id and r.status = 'active'),
         v_provider, v_participant, v_status, v_text, v_title, v_step,
         threadlink_private.tj_enum(v_p, 'access', array['read-only', 'workspace-write'], false),
         v_kind, v_prev_run.id, threadlink_private.redact_text(v_content), 'running',
         coalesce(threadlink_private.tj_enum(v_p, 'activity', threadlink_private.run_activities(), false), 'queued'),
         pg_catalog.now(), pg_catalog.now(),
         threadlink_private.tj_int(v_p, 'timeout_ms', 1000, 7200000, false))
      returning id into v_id;
      v_result := jsonb_build_object('run_id', v_id, 'created', true, 'status', 'running');
    end if;

  -- ------------------------------------------------------------ run_activity
  -- What a running agent is doing now. At most one change per run every 5 s:
  -- a faster report is accepted and ignored (throttled), never an error.
  when 'run_activity' then
    perform threadlink_private.tj_keys(v_p, array['run_id', 'activity']);
    v_run := threadlink_private.tj_run(v_job.id, threadlink_private.tj_text(v_p, 'run_id', 64, true), null,
                                       array['queued', 'running']);
    v_text := threadlink_private.tj_enum(v_p, 'activity', threadlink_private.run_activities(), true);
    select * into v_run from public.agent_runs where id = v_run.id for update;
    if v_run.last_activity_at is not null
       and v_run.last_activity_at > pg_catalog.now() - threadlink_private.run_activity_interval() then
      v_result := jsonb_build_object('run_id', v_run.id, 'updated', false, 'throttled', true);
    else
      update public.agent_runs
      set activity = v_text, last_activity_at = pg_catalog.now(), status = 'running'
      where id = v_run.id;
      v_result := jsonb_build_object('run_id', v_run.id, 'updated', true, 'throttled', false);
    end if;

  -- ------------------------------------------------------------ run_finished
  -- The run's outcome and evidence: observed model, verification flags and the
  -- native session. Idempotent (the same status again is a no-op). A timeout
  -- writes the ThreadLink timeout row from trusted state only.
  when 'run_finished' then
    perform threadlink_private.tj_keys(v_p, array['run_id', 'status', 'observed_model', 'model_verified',
      'access_verified', 'native_session_id', 'native_session_kind', 'failure', 'exit_clean']);
    v_run := threadlink_private.tj_run(v_job.id, threadlink_private.tj_text(v_p, 'run_id', 64, true), null,
                                       threadlink_private.run_statuses());
    select * into v_run from public.agent_runs where id = v_run.id for update;
    v_status := threadlink_private.tj_enum(v_p, 'status',
                  array['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'], true);
    if v_run.finished_at is not null then
      if v_run.status <> v_status then
        raise exception 'run already finished' using errcode = '55000', hint = 'conflict';
      end if;
      v_result := jsonb_build_object('run_id', v_run.id, 'finished', false, 'status', v_run.status,
                                     'verified', threadlink_private.run_is_verified(v_run));
    else
      v_title := threadlink_private.tj_text(v_p, 'observed_model', 200, false);
      if v_title is not null and v_title !~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$' then
        raise exception 'invalid observed_model' using errcode = '22023';
      end if;
      v_bool1 := coalesce(threadlink_private.tj_bool(v_p, 'model_verified'), false);
      v_bool2 := coalesce(threadlink_private.tj_bool(v_p, 'access_verified'), false);
      if v_bool1 and v_title is null then
        raise exception 'a model is verified only against an observed model' using errcode = '22023';
      end if;
      v_text := threadlink_private.tj_text(v_p, 'native_session_id', 200, false);
      if v_text is not null and v_text !~ threadlink_private.native_session_pattern() then
        raise exception 'invalid native_session_id' using errcode = '22023';
      end if;
      v_kind := threadlink_private.tj_enum(v_p, 'native_session_kind',
                                           array['claude_session', 'codex_thread', 'other'], false);
      if v_kind is not null and v_text is null then
        raise exception 'invalid native_session_kind' using errcode = '22023';
      end if;
      if v_kind = 'claude_session' and v_text !~ threadlink_private.uuid_pattern() then
        raise exception 'invalid native_session_id' using errcode = '22023';
      end if;
      update public.agent_runs
      set status = v_status,
          observed_model = v_title,
          model_verified = v_bool1,
          access_verified = v_bool2,
          native_session_id = v_text,
          native_session_kind = v_kind,
          failure = threadlink_private.tj_enum(v_p, 'failure', threadlink_private.run_failures(), false),
          finished_at = pg_catalog.now(),
          last_activity_at = pg_catalog.now(),
          verification = jsonb_build_object(
            'model', v_bool1, 'access', v_bool2, 'nativeSession', v_text is not null,
            'exitClean', coalesce(threadlink_private.tj_bool(v_p, 'exit_clean'), v_status = 'completed'))
      where id = v_run.id
      returning * into v_run;
      if v_status = 'timed_out' then
        select n.node_key into v_node_key from public.team_nodes n where n.id = v_run.node_id;
        v_int1 := greatest(1, ceil(coalesce(v_run.timeout_ms::numeric,
                                            extract(epoch from (v_run.finished_at - v_run.started_at)) * 1000)
                                   / 60000.0)::bigint);
        v_step := threadlink_private.run_step_text(null, v_run.role);
        perform threadlink_private.chat_card(v_job, 'threadlink', v_run, 'timeout',
          coalesce(threadlink_private.provider_label(v_run.provider), 'An agent') || ' timed out after '
          || v_int1 || ' min' || coalesce(' while ' || v_step, '')
          || case when v_job.mode = 'team' then coalesce(' on ' || v_node_key, '') else '' end || '.',
          'visible',
          jsonb_build_object('runId', v_run.id, 'provider', v_run.provider, 'minutes', v_int1, 'step', v_step,
                             'nodeKey', v_node_key),
          v_run.node_id);
      end if;
      v_result := jsonb_build_object('run_id', v_run.id, 'finished', true, 'status', v_status,
                                     'verified', threadlink_private.run_is_verified(v_run));
    end if;

  -- ---------------------------------------------------------- request_choice
  -- 0.10 (section 4): ask the owner. The title and the options come from the
  -- per-kind allow-list; the Runtime may only narrow the options and fill
  -- trusted parameters (participants, fixed step words, minutes, a node key).
  when 'request_choice' then
    perform threadlink_private.tj_keys(v_p, array['request_key', 'kind', 'run_id', 'provider', 'other_provider',
                                                  'step', 'minutes', 'node_key', 'options']);
    v_text := threadlink_private.tj_text(v_p, 'request_key', 128, true);
    if v_text !~ '^[A-Za-z0-9._:-]{1,128}$' then
      raise exception 'invalid request_key' using errcode = '22023';
    end if;
    v_kind := threadlink_private.tj_enum(v_p, 'kind', threadlink_private.choice_kinds(), true);
    select * into v_choice from public.user_choices where job_id = v_job.id and request_key = v_text;
    if found then
      if v_choice.kind <> v_kind then
        raise exception 'request key already used' using errcode = '55000', hint = 'conflict';
      end if;
      v_result := jsonb_build_object('choice_id', v_choice.id, 'created', false, 'status', v_choice.status);
    else
      v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
      if v_run_id is not null then
        v_run := threadlink_private.tj_run(v_job.id, v_run_id, null, threadlink_private.run_statuses());
      end if;
      v_provider := threadlink_private.tj_text(v_p, 'provider', 64, false);
      v_other := threadlink_private.tj_text(v_p, 'other_provider', 64, false);
      if (v_provider is not null and not (v_provider = any (threadlink_private.job_participants(v_job.id))))
         or (v_other is not null and (not (v_other = any (threadlink_private.job_participants(v_job.id)))
                                      or v_other = v_provider)) then
        raise exception 'invalid provider' using errcode = '22023';
      end if;
      v_step := threadlink_private.tj_enum(v_p, 'step', threadlink_private.choice_steps(), false);
      v_node_key := threadlink_private.tj_text(v_p, 'node_key', 64, false);
      perform threadlink_private.team_node_id(v_job.id, v_node_key);
      v_params := jsonb_strip_nulls(jsonb_build_object(
        'provider', v_provider, 'otherProvider', v_other, 'step', v_step,
        'minutes', threadlink_private.tj_int(v_p, 'minutes', 1, 1440, false), 'nodeKey', v_node_key));
      v_options := threadlink_private.choice_options(v_kind, v_params);
      if v_p ? 'options' then
        v_strings := threadlink_private.tj_strings(v_p, 'options', 6, 40, '^[a-z_]{1,40}$');
        if cardinality(v_strings) = 0 or exists (
             select 1 from unnest(v_strings) k
             where not (v_options @> jsonb_build_array(jsonb_build_object('key', k)))) then
          raise exception 'invalid options' using errcode = '22023', hint = 'invalid_choice';
        end if;
        select coalesce(jsonb_agg(o order by ord), '[]'::jsonb) into v_options
        from jsonb_array_elements(v_options) with ordinality as x(o, ord)
        where (o ->> 'key') = any (v_strings);
      end if;
      if jsonb_array_length(v_options) = 0 then
        raise exception 'invalid options' using errcode = '22023', hint = 'invalid_choice';
      end if;
      if (select count(*) from public.user_choices where job_id = v_job.id) >= 50 then
        raise exception 'choice limit reached' using errcode = '54000';
      end if;
      v_title := threadlink_private.choice_title(v_kind, v_params);
      insert into public.user_choices
        (owner_user_id, chat_id, job_id, run_id, kind, title, params, options, request_key, expires_at)
      values
        (v_job.owner_user_id, v_job.chat_id, v_job.id, v_run.id, v_kind, v_title, v_params, v_options, v_text,
         pg_catalog.now() + threadlink_private.choice_ttl())
      returning * into v_choice;
      perform threadlink_private.chat_card(v_job, 'threadlink', v_run, 'choice',
        v_title || E'\n' || (select string_agg(o ->> 'label', ' · ' order by ord)
                             from jsonb_array_elements(v_options) with ordinality as x(o, ord)),
        'visible',
        jsonb_build_object('choiceId', v_choice.id, 'kind', v_kind, 'status', 'pending', 'options', v_options,
                           'chosenKey', null, 'expiresAt', v_choice.expires_at),
        null, 'choice', v_choice.id);
      perform threadlink_private.record_event(
        v_job.owner_user_id, v_connection.id, 'team.choice_requested', 'user_choice', v_choice.id,
        jsonb_build_object('job_id', v_job.id, 'kind', v_kind));
      -- The job waits for the owner (needs_user_decision is a verdict, so the
      -- wait is `paused`); the Runtime sets the phase again after the answer.
      update public.team_jobs set status = 'paused' where id = v_job.id and status <> 'paused';
      v_result := jsonb_build_object('choice_id', v_choice.id, 'created', true, 'status', 'pending');
    end if;

  -- ------------------------------------------------------------ read_choices
  -- The owner's answers. A pending choice past its expiry becomes expired.
  when 'read_choices' then
    perform threadlink_private.tj_keys(v_p, array['choice_ids']);
    v_strings := threadlink_private.tj_strings(v_p, 'choice_ids', 20, 64, '^tlchc_[0-9a-f]{32}$');
    update public.user_choices set status = 'expired'
    where job_id = v_job.id and status = 'pending' and expires_at < pg_catalog.now();
    v_result := jsonb_build_object('choices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'choice_id', c.id, 'kind', c.kind, 'status', c.status, 'chosen_key', c.chosen_key,
        'decided_at', c.decided_at, 'expires_at', c.expires_at, 'request_key', c.request_key)
        order by c.created_at)
      from (select * from public.user_choices
            where job_id = v_job.id and (cardinality(v_strings) = 0 or id = any (v_strings))
            order by created_at desc limit 50) c), '[]'::jsonb));

  -- -------------------------------------------------------------- add_change
  -- A unit's code change, as the builder run's card: numbers, repo-relative
  -- files (redacted), branch, commit, test results; plus a diff artifact when
  -- the Runtime sends the diff text.
  when 'add_change' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'run_id', 'files_changed', 'insertions', 'deletions',
                                                  'files', 'branch', 'commit', 'tests', 'diff']);
    v_run := threadlink_private.tj_run(v_job.id, threadlink_private.tj_text(v_p, 'run_id', 64, true), null,
                                       array['running', 'completed']);
    if v_run.role not in ('builder', 'integrator') then
      raise exception 'invalid run_id' using errcode = '22023', hint = 'invalid_run';
    end if;
    v_node_key := threadlink_private.tj_text(v_p, 'node_key', 64, false);
    v_node_id := threadlink_private.team_node_id(v_job.id, v_node_key);
    if v_node_id is not null and v_run.node_id is not null and v_node_id <> v_run.node_id then
      raise exception 'invalid node_key' using errcode = '22023';
    end if;
    v_int1 := threadlink_private.tj_int(v_p, 'files_changed', 0, 100000, true);
    v_int2 := threadlink_private.tj_int(v_p, 'insertions', 0, 100000000, true);
    v_int3 := threadlink_private.tj_int(v_p, 'deletions', 0, 100000000, true);
    v_strings := threadlink_private.tj_strings(v_p, 'files', 200, 512, null);
    if exists (select 1 from unnest(v_strings) f where not threadlink_private.valid_repo_path(f)) then
      raise exception 'invalid files' using errcode = '22023';
    end if;
    select coalesce(array_agg(threadlink_private.redact_text(f) order by f), '{}') into v_strings
    from unnest(v_strings) f;
    v_text := threadlink_private.tj_text(v_p, 'branch', 200, false);
    if v_text is not null and v_text !~ '^[A-Za-z0-9._/+-]{1,200}$' then
      raise exception 'invalid branch' using errcode = '22023';
    end if;
    v_title := threadlink_private.tj_text(v_p, 'commit', 64, false);
    if v_title is not null and v_title !~ '^[0-9a-f]{7,64}$' then
      raise exception 'invalid commit' using errcode = '22023';
    end if;
    v_tests := coalesce(v_p -> 'tests', '[]'::jsonb);
    if jsonb_typeof(v_tests) <> 'array' or jsonb_array_length(v_tests) > 20 or exists (
         select 1 from jsonb_array_elements(v_tests) t
         where not threadlink_private.json_shape_ok(t, '{"command":"!string","ok":"!boolean"}')
            or char_length(t ->> 'command') not between 1 and 300 or (t ->> 'command') ~ '[[:cntrl:]]') then
      raise exception 'invalid tests' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('command', threadlink_private.redact_text(t ->> 'command'),
                                                 'ok', (t -> 'ok')) order by ord), '[]'::jsonb)
    into v_tests from jsonb_array_elements(v_tests) with ordinality as x(t, ord);
    v_content := threadlink_private.tj_text(v_p, 'diff', threadlink_private.artifact_max_bytes(), false);
    v_artifact_id := null;
    if v_content is not null then
      v_content := threadlink_private.artifact_clean(v_content);
      if v_content is not null then
        if octet_length(v_content) > threadlink_private.artifact_max_bytes() then
          raise exception 'diff too large' using errcode = '22023', hint = 'too_long';
        end if;
        if (select count(*) from public.chat_artifacts where chat_id = v_job.chat_id and deleted_at is null)
           >= threadlink_private.artifacts_per_chat() then
          raise exception 'artifact limit reached' using errcode = '54000';
        end if;
        insert into public.chat_artifacts
          (owner_user_id, chat_id, job_id, run_id, kind, title, mime, content, bytes, created_by)
        values
          (v_job.owner_user_id, v_job.chat_id, v_job.id, v_run.id, 'diff',
           'Changes' || coalesce(' in ' || v_node_key, ''), 'text/x-diff', v_content, octet_length(v_content),
           'runtime')
        returning id into v_artifact_id;
      end if;
    end if;
    v_count := (select count(*) from jsonb_array_elements(v_tests) t where t -> 'ok' = 'true'::jsonb);
    v_event_id := threadlink_private.chat_card(v_job, 'agent', v_run, 'code_change',
      'Changed ' || v_int1 || case when v_int1 = 1 then ' file' else ' files' end
      || ' (+' || v_int2 || ' ' || U&'\2212' || v_int3 || ')' || '.'
      || case when jsonb_array_length(v_tests) = 0 then ' No tests run.'
              else ' Tests: ' || v_count || ' of ' || jsonb_array_length(v_tests) || ' passed.' end,
      'visible',
      jsonb_build_object('runId', v_run.id, 'nodeKey', v_node_key, 'filesChanged', v_int1, 'insertions', v_int2,
                         'deletions', v_int3, 'files', to_jsonb(v_strings), 'branch', v_text, 'commit', v_title,
                         'tests', v_tests, 'testsRun', jsonb_array_length(v_tests), 'testsPassed', v_count,
                         'artifactId', v_artifact_id),
      v_node_id,
      case when v_artifact_id is not null then 'artifact' end, v_artifact_id);
    v_result := jsonb_build_object('event_id', v_event_id, 'artifact_id', v_artifact_id);

  -- ------------------------------------------------------------ add_artifact
  -- A text artifact of this job (report, plan, diff, test report, notes,
  -- export). Redacted, at most 512 KiB, idempotent by request_key (optional).
  when 'add_artifact' then
    perform threadlink_private.tj_keys(v_p, array['request_key', 'kind', 'title', 'mime', 'content', 'run_id',
                                                  'node_key']);
    v_text := threadlink_private.tj_text(v_p, 'request_key', 128, false);
    if v_text !~ '^[A-Za-z0-9._:-]{1,128}$' then
      raise exception 'invalid request_key' using errcode = '22023';
    end if;
    v_kind := threadlink_private.tj_enum(v_p, 'kind',
                array['report', 'plan', 'diff', 'test_report', 'notes', 'export'], true);
    v_artifact_id := null;
    if v_text is not null then
      select id into v_artifact_id from public.chat_artifacts where job_id = v_job.id and request_key = v_text;
    end if;
    if v_artifact_id is not null then
      v_result := jsonb_build_object('artifact_id', v_artifact_id, 'created', false);
    else
      v_title := threadlink_private.chat_strip_invisible(threadlink_private.tj_text(v_p, 'title', 800, true));
      if char_length(v_title) > 200 or v_title ~ '[[:cntrl:]]' then
        raise exception 'invalid title' using errcode = '22023';
      end if;
      v_run_id := threadlink_private.tj_text(v_p, 'run_id', 64, false);
      if v_run_id is not null then
        v_run := threadlink_private.tj_run(v_job.id, v_run_id, null, threadlink_private.run_statuses());
      end if;
      perform threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false));
      v_content := threadlink_private.artifact_clean(
        threadlink_private.tj_text(v_p, 'content', threadlink_private.artifact_max_bytes(), true));
      if v_content is null then
        raise exception 'invalid content' using errcode = '22023';
      end if;
      if octet_length(v_content) > threadlink_private.artifact_max_bytes() then
        raise exception 'content too large' using errcode = '22023', hint = 'too_long';
      end if;
      if (select count(*) from public.chat_artifacts where chat_id = v_job.chat_id and deleted_at is null)
         >= threadlink_private.artifacts_per_chat() then
        raise exception 'artifact limit reached' using errcode = '54000';
      end if;
      insert into public.chat_artifacts
        (owner_user_id, chat_id, job_id, run_id, kind, title, mime, content, bytes, created_by, request_key)
      values
        (v_job.owner_user_id, v_job.chat_id, v_job.id, v_run.id, v_kind,
         threadlink_private.redact_text(v_title),
         threadlink_private.tj_enum(v_p, 'mime', threadlink_private.artifact_mimes(), true),
         v_content, octet_length(v_content), 'runtime', v_text)
      returning id into v_artifact_id;
      v_result := jsonb_build_object('artifact_id', v_artifact_id, 'created', true);
    end if;

  -- ------------------------------------------------------------- ack_control
  -- The Runtime has honoured the owner's control (section 5): it clears it,
  -- but only if it is still the same request.
  when 'ack_control' then
    perform threadlink_private.tj_keys(v_p, array['control']);
    v_text := threadlink_private.tj_enum(v_p, 'control', threadlink_private.job_controls(), true);
    update public.team_jobs set control = null, control_requested_at = null
    where id = v_job.id and control = v_text;
    v_result := jsonb_build_object('cleared', found);

  else
    raise exception 'invalid op' using errcode = '22023';
  end case;

  return threadlink_private.team_status_json(v_job.id) || jsonb_build_object('op', p_op, 'result', v_result);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Owner RPCs (Clerk-authenticated; auth.uid() owns everything)
-- ---------------------------------------------------------------------------

-- The caller, or 28000 unauthenticated.
create function threadlink_private.require_owner()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text := threadlink_private.current_user_id();
begin
  if v is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  return v;
end;
$$;

/*
 * The owner answers a choice (section 4). Only a pending, unexpired choice of
 * a running job, and only one of its own options. The same answer again is a
 * replay; another account's choice is "not found". Writes a ThreadLink row
 * "You chose: <label>." and an audit event.
 */
create function public.decide_choice(p_choice_id text, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
  v public.user_choices;
  v_job public.team_jobs;
  v_label text;
begin
  if p_choice_id is null or p_choice_id !~ '^tlchc_[0-9a-f]{32}$' then
    raise exception 'choice not found' using errcode = 'P0002', hint = 'choice_not_found';
  end if;
  select * into v from public.user_choices where id = p_choice_id and owner_user_id = v_owner for update;
  if not found
     or exists (select 1 from public.chats c where c.id = v.chat_id and c.deleted_at is not null)
     or exists (select 1 from public.team_jobs j join public.rooms r on r.id = j.room_id
                where j.id = v.job_id and r.status = 'deleted') then
    raise exception 'choice not found' using errcode = 'P0002', hint = 'choice_not_found';
  end if;
  if v.status = 'chosen' and v.chosen_key is not distinct from p_key then
    return threadlink_private.choice_json(v.id) || jsonb_build_object('replayed', true);
  end if;
  if v.status <> 'pending' then
    raise exception 'this choice is closed' using errcode = '55000', hint = 'choice_closed';
  end if;
  if v.expires_at < pg_catalog.now() then
    raise exception 'this choice has expired' using errcode = '55000', hint = 'choice_expired';
  end if;
  if v.job_id is not null then
    select * into v_job from public.team_jobs where id = v.job_id;
    if v_job.finished_at is not null then
      raise exception 'this choice is closed' using errcode = '55000', hint = 'choice_closed';
    end if;
  end if;
  if p_key is null or p_key !~ '^[a-z_]{1,40}$'
     or not (v.options @> jsonb_build_array(jsonb_build_object('key', p_key))) then
    raise exception 'that is not one of the options' using errcode = '22023', hint = 'invalid_choice';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'choice_decide', 30);
  update public.user_choices
  set status = 'chosen', chosen_key = p_key, decided_at = pg_catalog.now(), decided_by = v_owner
  where id = v.id;
  select o ->> 'label' into v_label from jsonb_array_elements(v.options) o where o ->> 'key' = p_key;
  if v_job.id is not null then
    perform threadlink_private.chat_card(v_job, 'threadlink', null, 'choice', 'You chose: ' || v_label || '.',
      'visible',
      jsonb_build_object('choiceId', v.id, 'kind', v.kind, 'status', 'chosen', 'options', v.options,
                         'chosenKey', p_key, 'expiresAt', v.expires_at),
      null, 'choice', v.id);
  end if;
  perform threadlink_private.record_event(v_owner, null, 'team.choice_decided', 'user_choice', v.id,
    jsonb_build_object('job_id', v.job_id, 'kind', v.kind, 'key', p_key));
  return threadlink_private.choice_json(v.id);
end;
$$;

-- The fixed sentence a control writes into the chat.
create function threadlink_private.control_text(p_action text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_action
    when 'pause_after_step' then 'Pause requested: after the current step.'
    when 'stop_after_review' then 'Stop requested: after the current review.'
    when 'stop_before_integration' then 'Stop requested: before integration.'
    when 'stop_now' then 'Stop requested: now. ThreadLink stops the agents it started.'
    when 'cancel_queued' then 'Cancel requested: work that has not started yet.'
    when 'resume' then 'Resume requested.' end
$$;

/*
 * The owner steers a running job (section 5). Stored on team_jobs.control;
 * the Runtime honours it at the named boundary and acknowledges it
 * (ack_control). A Runtime older than protocol 10 knows only the stop request,
 * so there stop_now also sets stop_requested_at and every other control is
 * refused (runtime_outdated).
 */
create function public.control_job(p_job_id text, p_action text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
  v_job public.team_jobs;
  v_protocol integer;
begin
  if p_job_id is null or p_job_id !~ '^tljob_[0-9a-f]{32}$' then
    raise exception 'job not found' using errcode = 'P0002', hint = 'job_not_found';
  end if;
  select * into v_job from public.team_jobs where id = p_job_id and owner_user_id = v_owner for update;
  if not found
     or exists (select 1 from public.chats c where c.id = v_job.chat_id and c.deleted_at is not null)
     or exists (select 1 from public.rooms r where r.id = v_job.room_id and r.status = 'deleted') then
    raise exception 'job not found' using errcode = 'P0002', hint = 'job_not_found';
  end if;
  if p_action is null or not (p_action = any (threadlink_private.job_controls())) then
    raise exception 'invalid control' using errcode = '22023', hint = 'invalid_control';
  end if;
  if v_job.finished_at is not null then
    raise exception 'this work has finished' using errcode = '55000', hint = 'job_finished';
  end if;
  select threadlink_private.runtime_protocol_of(r.version, r.protocol) into v_protocol
  from public.tasks t
  join public.session_bindings sb on sb.id = t.target_session_id
  join public.runtimes r on r.id = sb.runtime_id
  where t.id = v_job.task_id;
  v_protocol := coalesce(v_protocol, 0);
  if v_protocol < threadlink_private.min_protocol_for('job_control') and p_action <> 'stop_now' then
    raise exception 'ThreadLink on this computer needs an update for this control'
      using errcode = '55000', hint = 'runtime_outdated',
            detail = 'protocol=' || v_protocol || ',required=' || threadlink_private.min_protocol_for('job_control');
  end if;
  if p_action = 'resume' and v_job.control is null and v_job.status not in ('paused', 'interrupted') then
    raise exception 'nothing to resume' using errcode = '55000', hint = 'nothing_to_resume';
  end if;
  if v_job.control is not distinct from p_action then
    return jsonb_build_object('job_id', v_job.id, 'control', v_job.control,
                              'control_requested_at', v_job.control_requested_at, 'status', v_job.status,
                              'replayed', true);
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'job_control', 20);
  update public.team_jobs
  set control = p_action,
      control_requested_at = pg_catalog.now(),
      stop_requested_at = case when p_action = 'stop_now' and v_protocol < threadlink_private.min_protocol_for('job_control')
                               then coalesce(stop_requested_at, pg_catalog.now()) else stop_requested_at end
  where id = v_job.id
  returning * into v_job;
  perform threadlink_private.chat_card(v_job, 'threadlink', null, 'control_requested',
    threadlink_private.control_text(p_action), 'visible', jsonb_build_object('action', p_action));
  perform threadlink_private.record_event(v_owner, null, 'team.control_requested', 'team_job', v_job.id,
    jsonb_build_object('action', p_action, 'chat_id', v_job.chat_id));
  return jsonb_build_object('job_id', v_job.id, 'control', v_job.control,
                            'control_requested_at', v_job.control_requested_at, 'status', v_job.status);
end;
$$;

/*
 * The owner attaches text to a chat (section 4): at most 64 KiB, plain text
 * or markdown, redacted before it is stored. Never forwarded to a provider by
 * the server.
 */
create function public.add_chat_attachment(p_chat_id text, p_title text, p_content text, p_mime text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
  v_title text := threadlink_private.chat_valid_name(p_title, 200);
  v_content text;
  v_id text;
begin
  if p_mime is null or p_mime not in ('text/plain', 'text/markdown') then
    raise exception 'invalid type' using errcode = '22023', hint = 'invalid';
  end if;
  if p_content is null or octet_length(p_content) > threadlink_private.attachment_max_bytes() then
    raise exception 'attachment too large' using errcode = '22023', hint = 'too_long';
  end if;
  v_content := threadlink_private.artifact_clean(p_content);
  if v_content is null then
    raise exception 'empty attachment' using errcode = '22023', hint = 'empty';
  end if;
  if octet_length(v_content) > threadlink_private.attachment_max_bytes() then
    raise exception 'attachment too large' using errcode = '22023', hint = 'too_long';
  end if;
  perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_attach', 20);
  if (select count(*) from public.chat_artifacts where chat_id = v.id and deleted_at is null)
     >= threadlink_private.artifacts_per_chat() then
    raise exception 'artifact limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  insert into public.chat_artifacts
    (owner_user_id, chat_id, kind, title, mime, content, bytes, created_by)
  values
    (v.owner_user_id, v.id, 'user_attachment', threadlink_private.redact_text(v_title), p_mime, v_content,
     octet_length(v_content), 'owner')
  returning id into v_id;
  perform threadlink_private.record_event(v.owner_user_id, null, 'chat.attachment_added', 'chat_artifact', v_id,
    jsonb_build_object('chat_id', v.id, 'bytes', octet_length(v_content)));
  return threadlink_private.artifact_json(v_id);
end;
$$;

-- Hides an artifact of the caller's chat (soft delete; the audit trail stays).
create function public.delete_chat_artifact(p_artifact_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
  v public.chat_artifacts;
begin
  if p_artifact_id is null or p_artifact_id !~ '^tlart_[0-9a-f]{32}$' then
    raise exception 'artifact not found' using errcode = 'P0002', hint = 'artifact_not_found';
  end if;
  select * into v from public.chat_artifacts
  where id = p_artifact_id and owner_user_id = v_owner and deleted_at is null
  for update;
  if not found then
    raise exception 'artifact not found' using errcode = 'P0002', hint = 'artifact_not_found';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'chat_organise', threadlink_private.chat_updates_per_minute());
  update public.chat_artifacts set deleted_at = pg_catalog.now() where id = v.id;
  perform threadlink_private.record_event(v_owner, null, 'chat.artifact_deleted', 'chat_artifact', v.id,
    jsonb_build_object('chat_id', v.chat_id));
  return jsonb_build_object('artifact_id', v.id, 'deleted', true);
end;
$$;

/*
 * The native session id of one of the caller's runs, for the owner's explicit
 * "copy" in Details/Provenance only (never shown in normal UI). Audited and
 * rate-limited. "Open in provider" is a command to copy, only where verified
 * (Claude Code: claude --resume <id> in the project folder).
 */
create function public.reveal_run_native_session(p_run_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
  v public.agent_runs;
begin
  if p_run_id is null or p_run_id !~ '^tlarn_[0-9a-f]{32}$' then
    raise exception 'run not found' using errcode = 'P0002', hint = 'run_not_found';
  end if;
  select * into v from public.agent_runs where id = p_run_id and owner_user_id = v_owner;
  if not found then
    raise exception 'run not found' using errcode = 'P0002', hint = 'run_not_found';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'native_reveal', 30);
  perform threadlink_private.record_event(v_owner, null, 'team.native_session_revealed', 'agent_run', v.id,
    jsonb_build_object('provider', v.provider, 'available', v.native_session_id is not null));
  return jsonb_build_object(
    'run_id', v.id, 'provider', v.provider, 'available', v.native_session_id is not null,
    'native_session_id', v.native_session_id, 'native_session_kind', v.native_session_kind,
    'resume_command', case when v.provider = 'claude-code' and v.native_session_kind = 'claude_session'
                           then 'claude --resume ' || v.native_session_id end);
end;
$$;

/*
 * The owner sets a project's step timeouts (section 6): minutes per step kind
 * (normalise, plan, plan_review, build, review, security_review, inspection,
 * verify), each 2-120. Replaces the whole set; {} = the Runtime's defaults.
 * Only future jobs are affected (the carrier is built at the job's start).
 */
create function public.set_room_step_timeouts(p_room_id text, p_timeouts jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms := threadlink_private.require_owned_room(p_room_id);
begin
  if p_timeouts is null or not threadlink_private.valid_step_timeouts(p_timeouts) then
    raise exception 'invalid step timeouts' using errcode = '22023', hint = 'invalid';
  end if;
  perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  update public.rooms set step_timeouts = p_timeouts where id = v.id;
  return jsonb_build_object('room_id', v.id, 'step_timeouts', p_timeouts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. The per-chat read cursor (section 7). The 0.9 global-seq call keeps
--     working and keeps both cursors in step.
-- ---------------------------------------------------------------------------
create or replace function public.mark_chat_read(p_chat_id text, p_seq bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
  v_max bigint;
  v_new bigint;
begin
  if p_seq is null or p_seq < 0 then
    raise exception 'invalid cursor' using errcode = '22023', hint = 'invalid';
  end if;
  select coalesce(max(seq), 0) into v_max from public.chat_events where chat_id = v.id;
  v_new := least(p_seq, v_max);
  -- Only a call that moves the cursor counts (the page marks read as it polls).
  if v_new > v.last_read_seq then
    perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_read',
                                                threadlink_private.chat_reads_per_minute());
    update public.chats
    set last_read_seq = v_new,
        last_read_chat_seq = greatest(last_read_chat_seq,
          coalesce((select max(e.chat_seq) from public.chat_events e where e.chat_id = v.id and e.seq <= v_new), 0))
    where id = v.id;
  end if;
  return (select jsonb_build_object('chat_id', c.id, 'last_read_seq', c.last_read_seq,
                                    'last_read_chat_seq', c.last_read_chat_seq)
          from public.chats c where c.id = v.id);
end;
$$;

-- 0.10: read up to a chat_seq (never past the chat's newest row, never back).
create function public.mark_chat_read_seq(p_chat_id text, p_chat_seq bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
  v_new bigint;
begin
  if p_chat_seq is null or p_chat_seq < 0 then
    raise exception 'invalid cursor' using errcode = '22023', hint = 'invalid';
  end if;
  v_new := least(p_chat_seq, v.last_event_seq);
  if v_new > v.last_read_chat_seq then
    perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_read',
                                                threadlink_private.chat_reads_per_minute());
    update public.chats
    set last_read_chat_seq = v_new,
        last_read_seq = greatest(last_read_seq,
          coalesce((select max(e.seq) from public.chat_events e where e.chat_id = v.id and e.chat_seq <= v_new), 0))
    where id = v.id;
  end if;
  return (select jsonb_build_object('chat_id', c.id, 'last_read_seq', c.last_read_seq,
                                    'last_read_chat_seq', c.last_read_chat_seq)
          from public.chats c where c.id = v.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Reads for the chat list and search (definer, filtered to the caller)
-- ---------------------------------------------------------------------------

-- Section 7: what counts as unread. Visible rows by agents or the controller,
-- and ThreadLink's important rows; never phases, statuses or model notes.
create function threadlink_private.chat_counts_unread(p_author_kind text, p_event_type text, p_visibility text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_visibility = 'visible'
     and (p_author_kind in ('agent', 'controller')
          or (p_author_kind = 'threadlink'
              and p_event_type in ('job_summary', 'job_verdict', 'choice', 'finding', 'provider_blocked', 'timeout',
                                   'interrupted')))
$$;

-- For each of the caller's chats (explicit owner filter; another account's
-- chat id returns nothing): the newest visible row (clipped, with its
-- chat_seq), the controller labels seen recently, and the unread count (at
-- most 100) under the 0.10 rules. At most 500 chats per call.
create function public.chat_list_extras_v2(p_chat_ids text[])
returns table (chat_id text, last_chat_seq bigint, last_body text, last_at timestamptz,
               controller_labels text[], unread_count integer, last_read_chat_seq bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
begin
  if p_chat_ids is null or cardinality(p_chat_ids) > 500 then
    raise exception 'too many chats' using errcode = '22023', hint = 'invalid';
  end if;
  return query
  select c.id,
         e.chat_seq,
         pg_catalog.left(e.body, 200),
         e.created_at,
         coalesce((select array_agg(distinct s.author_label)
                   from (select ce.author_label from public.chat_events ce
                         where ce.chat_id = c.id and ce.author_kind = 'controller'
                         order by ce.seq desc limit 50) s), '{}'::text[]),
         (select count(*)::integer from (
            select 1 from public.chat_events u
            where u.chat_id = c.id and u.chat_seq > c.last_read_chat_seq
              and threadlink_private.chat_counts_unread(u.author_kind, u.event_type, u.visibility)
            limit 100) n),
         c.last_read_chat_seq
  from public.chats c
  left join lateral (
    select ev.chat_seq, ev.body, ev.created_at from public.chat_events ev
    where ev.chat_id = c.id and ev.visibility = 'visible'
    order by ev.seq desc
    limit 1) e on true
  where c.id = any (p_chat_ids) and c.owner_user_id = v_owner;
end;
$$;

/*
 * Section 7: search the caller's chats: chat names, project names, visible
 * message bodies, finding titles, decision titles and artifact titles. A
 * plain substring (ILIKE with the wildcards escaped), 2-100 characters, at
 * most 50 results, newest first. Every branch filters on the caller's own
 * owner_user_id (definer); deleted chats never appear.
 */
create function public.search_my_chats(p_query text, p_limit integer default 20)
returns table (kind text, chat_id text, chat_name text, ref_id text, snippet text, chat_seq bigint,
               at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_q text := pg_catalog.btrim(threadlink_private.chat_strip_invisible(coalesce(p_query, '')));
  v_pat text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if char_length(v_q) not between 2 and 100 or v_q ~ '[[:cntrl:]]' then
    raise exception 'invalid query' using errcode = '22023', hint = 'invalid';
  end if;
  -- 30 searches per owner per minute.
  perform threadlink_private.owner_rate_limit(v_owner, 'chat_search', 30);
  v_pat := '%' || pg_catalog.regexp_replace(v_q, '([\\%_])', '\\\1', 'g') || '%';
  return query
  with hits as (
    (select 'chat'::text as kind, c.id as chat_id, c.name as chat_name, c.id as ref_id, c.name as snippet,
            null::bigint as chat_seq, c.last_activity_at as at
     from public.chats c
     where c.owner_user_id = v_owner and c.deleted_at is null and c.name ilike v_pat
     order by c.last_activity_at desc limit v_limit)
    union all
    (select 'project', c.id, c.name, r.id, r.name, null::bigint, c.last_activity_at
     from public.chats c join public.rooms r on r.id = c.room_id
     where c.owner_user_id = v_owner and c.deleted_at is null and r.status <> 'deleted' and r.name ilike v_pat
     order by c.last_activity_at desc limit v_limit)
    union all
    (select 'message', e.chat_id, c.name, e.id,
            pg_catalog.substr(e.body,
              greatest(pg_catalog.strpos(lower(e.body), lower(v_q)) - 60, 1), 200),
            e.chat_seq, e.created_at
     -- Bounded: the owner's newest 5000 visible rows are searched.
     from (select ev.* from public.chat_events ev
           where ev.owner_user_id = v_owner and ev.visibility = 'visible'
           order by ev.seq desc limit 5000) e
     join public.chats c on c.id = e.chat_id
     where c.deleted_at is null and e.body ilike v_pat
     order by e.created_at desc limit v_limit)
    union all
    (select 'finding', j.chat_id, c.name, f.id, f.title, null::bigint, f.created_at
     from public.team_findings f
     join public.team_jobs j on j.id = f.job_id
     join public.chats c on c.id = j.chat_id
     where f.owner_user_id = v_owner and c.deleted_at is null and f.title ilike v_pat
     order by f.created_at desc limit v_limit)
    union all
    (select 'decision', j.chat_id, c.name, d.id, d.title, null::bigint, d.created_at
     from public.team_decisions d
     join public.team_jobs j on j.id = d.job_id
     join public.chats c on c.id = j.chat_id
     where d.owner_user_id = v_owner and c.deleted_at is null and d.title ilike v_pat
     order by d.created_at desc limit v_limit)
    union all
    (select 'artifact', a.chat_id, c.name, a.id, a.title, null::bigint, a.created_at
     from public.chat_artifacts a join public.chats c on c.id = a.chat_id
     where a.owner_user_id = v_owner and a.deleted_at is null and c.deleted_at is null and a.title ilike v_pat
     order by a.created_at desc limit v_limit)
  )
  select h.kind, h.chat_id, h.chat_name, h.ref_id, h.snippet, h.chat_seq, h.at
  from hits h
  order by h.at desc
  limit v_limit;
end;
$$;

/*
 * The same search with filters (all optional):
 *   {projectId: tlrom_..., provider: <registry id>, mode: solo|pair|team,
 *    status: running|idle, from: <timestamptz>, to: <timestamptz>}
 * projectId: chats of that project; provider: chats whose project has that
 * agent enabled; mode: the chat's mode; status: a job is running in the chat
 * (running) or not (idle); from/to: the hit's time. Filters apply to the
 * newest 50 hits per kind.
 */
create function public.search_my_chats(p_query text, p_limit integer, p_filters jsonb)
returns table (kind text, chat_id text, chat_name text, ref_id text, snippet text, chat_seq bigint,
               at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_owner text := threadlink_private.require_owner();
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if jsonb_typeof(f) <> 'object' or not threadlink_private.json_shape_ok(f,
       '{"projectId":"string|null","provider":"string|null","mode":"string|null","status":"string|null",
         "from":"string|null","to":"string|null"}')
     or (f ->> 'projectId') !~ '^tlrom_[0-9a-f]{32}$'
     or (f ->> 'provider') !~ '^[a-z][a-z0-9-]{1,39}$'
     or (f ->> 'mode') not in ('solo', 'pair', 'team')
     or (f ->> 'status') not in ('running', 'idle') then
    raise exception 'invalid filters' using errcode = '22023', hint = 'invalid';
  end if;
  begin
    v_from := (f ->> 'from')::timestamptz;
    v_to := (f ->> 'to')::timestamptz;
  exception when others then
    raise exception 'invalid filters' using errcode = '22023', hint = 'invalid';
  end;
  return query
  select h.kind, h.chat_id, h.chat_name, h.ref_id, h.snippet, h.chat_seq, h.at
  from public.search_my_chats(p_query, 50) h
  join public.chats c on c.id = h.chat_id and c.owner_user_id = v_owner
  where (f ->> 'projectId' is null or c.room_id = f ->> 'projectId')
    and (f ->> 'mode' is null or c.mode = f ->> 'mode')
    and (f ->> 'provider' is null or exists (
           select 1 from public.room_agents a
           where a.room_id = c.room_id and a.provider = f ->> 'provider' and a.enabled))
    and (f ->> 'status' is null
         or (f ->> 'status' = 'running') = exists (
              select 1 from public.team_jobs j where j.chat_id = c.id and j.finished_at is null))
    and (v_from is null or h.at >= v_from)
    and (v_to is null or h.at <= v_to)
  order by h.at desc
  limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- 17. Health, execution host and presence for a chat (section 8): ONE
--     freshness calculation, with the time of the check, so the UI can say
--     "Ready · checked 23 s ago" or "Stale · last checked 2 h ago".
-- ---------------------------------------------------------------------------
-- When a stored report was checked: the earlier of the Runtime's check and
-- the server's receipt (null: never checked).
create function threadlink_private.provider_checked_at(p_detected jsonb, p_received_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v timestamptz;
begin
  if p_detected is null or jsonb_typeof(p_detected -> 'healthCheckedAt') <> 'string' then
    return null;
  end if;
  begin
    v := (p_detected ->> 'healthCheckedAt')::timestamptz;
  exception when others then
    return null;
  end;
  return least(v, p_received_at);
end;
$$;

create function public.chat_host_status(p_chat_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
  v_chat public.chats;
  v_room public.rooms;
  v_runtime public.runtimes;
  v_presence text;
begin
  select * into v_chat from public.chats where id = p_chat_id and owner_user_id = v_owner and deleted_at is null;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into v_room from public.rooms where id = v_chat.room_id and status <> 'deleted';
  if v_room.id is not null then
    select r.* into v_runtime from public.runtimes r where r.id = threadlink_private.room_runtime(v_room.id);
  end if;
  if v_runtime.id is not null then
    v_presence := case
      when v_runtime.status <> 'active' or v_runtime.last_seen_at is null
           or v_runtime.last_seen_at < pg_catalog.now() - interval '2 minutes' then 'offline'
      when exists (select 1 from public.agent_runs ar join public.team_jobs j on j.id = ar.job_id
                   where ar.runtime_id = v_runtime.id and ar.status in ('queued', 'running')
                     and j.finished_at is null) then 'working'
      else 'online' end;
  end if;
  return jsonb_build_object(
    'chat_id', v_chat.id,
    'room_id', v_room.id,
    'now', pg_catalog.now(),
    'runtime', case when v_runtime.id is null then null else jsonb_build_object(
      'runtime_id', v_runtime.id, 'label', v_runtime.label, 'presence', v_presence,
      'last_seen_at', v_runtime.last_seen_at,
      'protocol', threadlink_private.runtime_protocol_of(v_runtime.version, v_runtime.protocol),
      'needs_update', threadlink_private.runtime_protocol_of(v_runtime.version, v_runtime.protocol)
                      < threadlink_private.runtime_protocol_current()) end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', a.provider,
        'name', coalesce(p.display_name, a.provider),
        'short_name', coalesce(p.short_name, a.provider),
        'health', threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at),
        -- ready, stale (a ready report older than 2 h), or the failing health.
        'state', case
          when threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at) = 'unknown'
               and h.detected ->> 'health' = 'ready'
               and threadlink_private.provider_checked_at(h.detected, h.received_at) is not null then 'stale'
          else threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at) end,
        'checked_at', threadlink_private.provider_checked_at(h.detected, h.received_at))
        order by coalesce(p.sort, 10000), a.provider)
      from public.room_agents a
      left join public.agent_providers p on p.id = a.provider
      left join public.runtime_provider_health h on h.runtime_id = v_runtime.id and h.provider = a.provider
      where a.room_id = v_room.id and a.enabled), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. Privileges: revoke everything new from every client role, then grant
--     exactly its audience (owner RPCs -> authenticated; the new credential
--     overloads -> anon + authenticated like their originals). Replaced
--     functions keep their existing grants.
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.finding_open_states()', 'threadlink_private.run_statuses()',
    'threadlink_private.run_activities()', 'threadlink_private.run_failures()',
    'threadlink_private.choice_kinds()', 'threadlink_private.job_controls()',
    'threadlink_private.artifact_kinds()', 'threadlink_private.artifact_mimes()',
    'threadlink_private.ref_kinds()', 'threadlink_private.decision_fixed_titles()',
    'threadlink_private.provider_id_pattern()', 'threadlink_private.participant_key_pattern()',
    'threadlink_private.run_key_pattern()', 'threadlink_private.native_session_pattern()',
    'threadlink_private.runtime_protocol_current()', 'threadlink_private.runs_per_job()',
    'threadlink_private.run_activity_interval()', 'threadlink_private.choice_ttl()',
    'threadlink_private.artifact_max_bytes()', 'threadlink_private.attachment_max_bytes()',
    'threadlink_private.artifacts_per_chat()', 'threadlink_private.chat_payload_max_bytes()',
    'threadlink_private.min_protocol_for(text)', 'threadlink_private.runtime_protocol_of(text, integer)',
    'threadlink_private.connection_protocol(text)', 'threadlink_private.json_shape_ok(jsonb, jsonb)',
    'threadlink_private.valid_chat_payload(text, jsonb)', 'threadlink_private.valid_mention_aliases(text[])',
    'threadlink_private.agent_runs_guard_update()', 'threadlink_private.agent_runs_native_session_guard()',
    'threadlink_private.user_choices_guard_update()', 'threadlink_private.chat_artifacts_guard_update()',
    'threadlink_private.v10_backfill()',
    'threadlink_private.job_participants(text)', 'threadlink_private.provider_label(text)',
    'threadlink_private.chat_events_v10_prepare()',
    'threadlink_private.chat_card(public.team_jobs, text, public.agent_runs, text, text, text, jsonb, text, text, text)',
    'threadlink_private.chat_phase_of(text)', 'threadlink_private.job_summary_payload(public.team_jobs)',
    'threadlink_private.job_summary_text(jsonb)',
    'threadlink_private.tj_run(text, text, text, text[])', 'threadlink_private.artifact_clean(text)',
    'threadlink_private.valid_repo_path(text)', 'threadlink_private.choice_steps()',
    'threadlink_private.choice_options(text, jsonb)', 'threadlink_private.choice_title(text, jsonb)',
    'threadlink_private.choice_json(text)', 'threadlink_private.artifact_json(text)',
    'threadlink_private.run_step_text(text, text)', 'threadlink_private.run_is_verified(public.agent_runs)',
    'threadlink_private.tj_reply(public.team_jobs, text)', 'threadlink_private.tj_ref(public.team_jobs, text, text)',
    'threadlink_private.require_owner()', 'threadlink_private.control_text(text)',
    'threadlink_private.chat_counts_unread(text, text, text)',
    'threadlink_private.provider_checked_at(jsonb, timestamptz)',
    'threadlink_private.step_kinds()', 'threadlink_private.valid_step_timeouts(jsonb)',
    'threadlink_private.tasks_v10_carrier_timeouts()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;

  -- Credential (Runtime) overloads: the same audience as the originals.
  foreach f in array array[
    'public.register_runtime(text, text, text, text, text, integer)',
    'public.runtime_heartbeat(text, text, jsonb, text[], integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;

  -- Owner RPCs.
  foreach f in array array[
    'public.decide_choice(text, text)',
    'public.control_job(text, text)',
    'public.add_chat_attachment(text, text, text, text)',
    'public.delete_chat_artifact(text)',
    'public.reveal_run_native_session(text)',
    'public.mark_chat_read_seq(text, bigint)',
    'public.chat_list_extras_v2(text[])',
    'public.search_my_chats(text, integer)',
    'public.chat_host_status(text)',
    'public.set_room_step_timeouts(text, jsonb)',
    'public.search_my_chats(text, integer, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$grants$;


-- ---------------------------------------------------------------------------
-- Chat wording for single-unit jobs (0.10 chat quality): Solo and Builder +
-- Reviewer have exactly one unit, so its internal key is not shown.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_on_node_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_state text;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    v_state := case new.status
        when 'pending' then 'pending' when 'ready' then 'ready' when 'running' then 'in progress'
        when 'in_review' then 'in review' when 'changes_requested' then 'changes requested'
        when 'approved' then 'approved' when 'integrated' then 'integrated' when 'failed' then 'failed'
        when 'skipped' then 'skipped' else new.status end;
    perform threadlink_private.chat_job_event(v_job, 'unit_status',
      case when v_job.mode in ('solo', 'pair') then 'Work ' || v_state
           else 'Unit ' || new.node_key || ': ' || v_state end,
      case when new.status in ('approved', 'changes_requested', 'integrated', 'failed')
           then 'visible' else 'technical' end,
      new.id);
  exception when others then
    raise warning 'threadlink chat: unit status not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Security review fixes (0.10)
-- ---------------------------------------------------------------------------

/*
 * I4: redaction also catches credentials assigned by NAME in env, shell,
 * YAML and JSON forms: DB_PASS=..., export MY_CREDS=..., STRIPE_KEY: ...,
 * "db_pass": "...", credentials = ..., pass: ... . Upper-case and
 * underscore-suffixed names only for KEY/PASS/CREDS, so prose ("keyboard: ",
 * "passing: 3") is left alone. Everything the 0.8 rules caught still is.
 */
create or replace function threadlink_private.redact_text(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := p;
  r constant text := '[redacted]';
begin
  if t is null then
    return null;
  end if;
  -- PEM private keys (base64 bodies contain no '-').
  t := pg_catalog.regexp_replace(t,
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[^-]*(-----END[A-Z ]*PRIVATE KEY-----)?', r, 'g');
  -- Slack incoming-webhook URLs are credentials in themselves.
  t := pg_catalog.regexp_replace(t, 'https?://hooks\.slack\.com/(services|workflows)/[A-Za-z0-9/_-]+', r, 'gi');
  -- Credentials inside a URL: scheme://user:password@host, including an empty user.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]/:@]*:[^[:space:]/@]+@', '\1' || r || '@', 'g');
  -- Authorization: Bearer / Basic <token>.
  t := pg_catalog.regexp_replace(t, '(bearer|basic)([[:space:]]+)[A-Za-z0-9._~+/=-]{8,}', '\1\2' || r, 'gi');
  -- Cookie headers: the rest of the line.
  t := pg_catalog.regexp_replace(t, '((set-)?cookie[[:space:]]*:)[^\n]*', '\1 ' || r, 'gi');
  -- AWS CLI style: `aws_secret_access_key <value>` (whitespace, no '=').
  t := pg_catalog.regexp_replace(t,
    '((aws_secret_access_key|aws_session_token|aws_access_key_id)[[:space:]]+)[^[:space:]=:]+', '\1' || r, 'gi');
  -- "the password is X".
  t := pg_catalog.regexp_replace(t,
    '((password|passphrase|passwd|secret|token|api[ _-]?key)[[:space:]]+(is|was)[[:space:]]+)[^[:space:]]+',
    '\1' || r, 'gi');
  -- key = value / key: value where the key names a secret; the value runs to
  -- the end of the line.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z0-9_-]*(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)'
    || '[A-Za-z0-9_-]*["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'gi');
  -- 0.10: env / shell / YAML / JSON names ending in KEY, PASS, CREDS,
  -- CREDENTIALS (upper case, or lower case after an underscore).
  t := pg_catalog.regexp_replace(t,
    '(\m[A-Za-z0-9_]*(KEY|PASS|CREDS?|CREDENTIALS?|Key|Pass|Creds?|Credentials?|_key|_pass|_creds?|_credentials?)'
    || '["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'g');
  -- ...and credential(s) / creds / a bare pass in any case.
  t := pg_catalog.regexp_replace(t,
    '(\m([A-Za-z0-9_-]*(credentials?|creds)|pass)["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'gi');
  -- Provider keys.
  t := pg_catalog.regexp_replace(t, '\m(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}', r, 'gi');
  t := pg_catalog.regexp_replace(t, '\mgithub_pat_[A-Za-z0-9_]{20,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mgh[pousr]_[A-Za-z0-9]{16,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mxox[abprse]-[A-Za-z0-9-]{10,}', r, 'gi');
  t := pg_catalog.regexp_replace(t, '\m(AKIA|ASIA)[0-9A-Z]{12,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mAIza[0-9A-Za-z_-]{30,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mglpat-[A-Za-z0-9_-]{20,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mnpm_[A-Za-z0-9]{30,}', r, 'g');
  -- ThreadLink connection credentials.
  t := pg_catalog.regexp_replace(t, '\mtlc_[A-Za-z0-9_-]{16,}', r, 'g');
  -- JWTs.
  t := pg_catalog.regexp_replace(t, '\meyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', r, 'g');
  -- A home directory names a person.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z]:[\\/](Users|Documents and Settings)[\\/])[^\\/[:space:]"''<>|]+', '\1' || U&'\2026', 'gi');
  t := pg_catalog.regexp_replace(t, '(/(home|Users)/)[^/[:space:]"''<>|]+', '\1' || U&'\2026', 'g');
  return t;
end;
$$;

/*
 * I3 server backstop: a carrier task claimed AGAIN (the lease ran out, a new
 * claim ref) while its job had started write work (a builder or integrator
 * run) or still had a run going. What was running is marked interrupted, the
 * job becomes `interrupted` and the owner gets an `interrupted` choice; until
 * that choice is answered "Resume", run_started refuses write roles
 * (interrupted_needs_owner). Nothing is re-run on its own.
 */
alter table public.team_jobs add column last_claim_ref text
  constraint team_jobs_last_claim_ref_format check (last_claim_ref ~ '^[A-Za-z0-9._:-]{1,128}$');
comment on column public.team_jobs.last_claim_ref is
  'The claim that last wrote to this job. A re-claim by the same claim is a lapsed lease, not a crash.';

create function threadlink_private.tasks_v10_reclaim_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_choice public.user_choices;
  v_options jsonb := threadlink_private.choice_options('interrupted', '{}'::jsonb);
begin
  if new.task_type <> 'team' or new.claim_ref is null or new.claim_ref is not distinct from old.claim_ref
     or coalesce(new.attempt_count, 0) <= 1 then
    return null;
  end if;
  select * into v_job from public.team_jobs where task_id = new.id;
  if not found or v_job.finished_at is not null then
    return null;
  end if;
  -- The same Runtime process re-claiming its own job after its lease lapsed
  -- (a long step on a slow machine): nothing was lost, so nothing to recover.
  if v_job.last_claim_ref is not null and new.claim_ref = v_job.last_claim_ref then
    return null;
  end if;
  if not exists (select 1 from public.agent_runs r
                 where r.job_id = v_job.id
                   and (r.role in ('builder', 'integrator') or r.status in ('queued', 'running'))) then
    return null;
  end if;
  update public.agent_runs
  set status = 'interrupted', failure = coalesce(failure, 'crashed'), finished_at = pg_catalog.now()
  where job_id = v_job.id and status in ('queued', 'running');
  update public.team_jobs set status = 'interrupted' where id = v_job.id and status <> 'interrupted'
  returning * into v_job;
  if v_job.id is null then
    select * into v_job from public.team_jobs where task_id = new.id;
  end if;
  insert into public.user_choices
    (owner_user_id, chat_id, job_id, kind, title, params, options, request_key, expires_at)
  values
    (v_job.owner_user_id, v_job.chat_id, v_job.id, 'interrupted',
     threadlink_private.choice_title('interrupted', '{}'::jsonb), '{}'::jsonb, v_options,
     'server:reclaim:' || new.attempt_count, pg_catalog.now() + threadlink_private.choice_ttl())
  on conflict (job_id, request_key) do nothing
  returning * into v_choice;
  if v_choice.id is not null then
    perform threadlink_private.chat_card(v_job, 'threadlink', null, 'choice',
      v_choice.title || E'\n' || (select string_agg(o ->> 'label', ' · ' order by ord)
                                  from jsonb_array_elements(v_options) with ordinality as x(o, ord)),
      'visible',
      jsonb_build_object('choiceId', v_choice.id, 'kind', 'interrupted', 'status', 'pending',
                         'options', v_options, 'chosenKey', null, 'expiresAt', v_choice.expires_at),
      null, 'choice', v_choice.id);
    perform threadlink_private.record_event(v_job.owner_user_id, null, 'team.choice_requested', 'user_choice',
      v_choice.id, jsonb_build_object('job_id', v_job.id, 'kind', 'interrupted', 'server', true));
  end if;
  return null;
end;
$$;
create trigger tasks_v10_reclaim_guard after update of claim_ref on public.tasks
  for each row execute function threadlink_private.tasks_v10_reclaim_guard();

revoke all on function threadlink_private.tasks_v10_reclaim_guard() from public, anon, authenticated, service_role;
revoke all on function threadlink_private.uuid_pattern() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Account deletion (found by the 0.10 real-agent run): the chat foreign keys
-- added without an ON DELETE action made deleting an account fail. The account's
-- chats and its jobs are removed through different cascade paths, and a
-- "no action" check can run before the other path has finished. Chats are only
-- ever soft-deleted by the owner, so a cascade can only happen when the whole
-- account is deleted, which is exactly when these rows must go too.
-- ---------------------------------------------------------------------------
alter table public.team_jobs drop constraint team_jobs_chat_owner_fkey;
alter table public.team_jobs add constraint team_jobs_chat_owner_fkey foreign key (chat_id, owner_user_id)
  references public.chats (id, owner_user_id) on delete cascade;
alter table public.team_jobs drop constraint team_jobs_retried_from_fkey;
alter table public.team_jobs add constraint team_jobs_retried_from_fkey foreign key (retried_from_job_id, owner_user_id)
  references public.team_jobs (id, owner_user_id) on delete cascade;
alter table public.tasks drop constraint tasks_chat_owner_fkey;
alter table public.tasks add constraint tasks_chat_owner_fkey foreign key (chat_id, owner_user_id)
  references public.chats (id, owner_user_id) on delete cascade;
alter table public.agent_runs drop constraint agent_runs_chat_owner_fkey;
alter table public.agent_runs add constraint agent_runs_chat_owner_fkey foreign key (chat_id, owner_user_id)
  references public.chats (id, owner_user_id) on delete cascade;
alter table public.user_choices drop constraint user_choices_chat_owner_fkey;
alter table public.user_choices add constraint user_choices_chat_owner_fkey foreign key (chat_id, owner_user_id)
  references public.chats (id, owner_user_id) on delete cascade;