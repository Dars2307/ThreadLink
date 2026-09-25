-- ===========================================================================
-- Team Mode: rooms, team jobs and their structured, claim-gated state.
--
-- Contract: docs/design/team-mode.md sections 2, 4 and 5. The enumerations and
-- bounds below mirror runtime/src/team/types.ts EXACTLY; tests assert both.
--
-- Shape of the trust model:
--   * A team job travels as an ordinary task (task_type = 'team') over the
--     room's existing active link, so routing, the lease, acknowledgement and
--     notifications are all reused unchanged.
--   * Controller calls authenticate with the connection credential plus the
--     controller's own session (like create_task).
--   * Every Runtime write is authorised by the CARRIER TASK'S CLAIM
--     (require_claimed_task): only the agent session holding the claim, with
--     its claim_ref, may write that job's state. No new trust path.
--   * Owner (dashboard) calls authenticate with Clerk as `authenticated`.
--
-- Additive only: no existing column, function or row changes meaning. The
-- one existing object touched is the audit action allow-list, which is
-- RE-STATED IN FULL as a superset of the previous list.
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
  -- New in Team Mode.
  'room.created', 'room.renamed', 'room.archived', 'room.restored', 'room.deleted',
  'team.job_started', 'team.job_finished', 'team.decision',
  'provider.profile_updated'
));

-- ---------------------------------------------------------------------------
-- 1. Vocabulary (mirrors runtime/src/team/types.ts)
-- ---------------------------------------------------------------------------
create function threadlink_private.team_providers() returns text[]
language sql immutable set search_path = '' as $$ select array['claude-code', 'codex'] $$;
create function threadlink_private.team_roles() returns text[]
language sql immutable set search_path = '' as $$
  select array['coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer', 'test_reviewer',
               'integrator', 'investigator'] $$;
create function threadlink_private.team_job_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
               'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled'] $$;
create function threadlink_private.team_verdicts() returns text[]
language sql immutable set search_path = '' as $$
  select array['PASS', 'NEEDS_FIX', 'BLOCKED', 'NEEDS_USER_DECISION'] $$;
create function threadlink_private.team_node_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['pending', 'ready', 'running', 'in_review', 'changes_requested', 'approved', 'integrated',
               'failed', 'skipped'] $$;
create function threadlink_private.team_message_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['proposal', 'review', 'finding', 'response', 'handoff', 'question', 'decision', 'completion'] $$;
create function threadlink_private.team_finding_severities() returns text[]
language sql immutable set search_path = '' as $$ select array['blocking', 'important', 'non_blocking'] $$;
create function threadlink_private.team_finding_categories() returns text[]
language sql immutable set search_path = '' as $$
  select array['correctness', 'security', 'architecture', 'edge_case', 'tests', 'performance', 'requirements'] $$;
create function threadlink_private.team_finding_statuses() returns text[]
language sql immutable set search_path = '' as $$ select array['open', 'resolved', 'wont_fix'] $$;
create function threadlink_private.team_model_classes() returns text[]
language sql immutable set search_path = '' as $$ select array['FAST', 'BALANCED', 'STRONG', 'FRONTIER'] $$;
create function threadlink_private.team_usage_policies() returns text[]
language sql immutable set search_path = '' as $$
  select array['conservative', 'balanced', 'maximum_quality', 'manual'] $$;
create function threadlink_private.team_claude_plans() returns text[]
language sql immutable set search_path = '' as $$
  select array['free', 'pro', 'max_5x', 'max_20x', 'team', 'enterprise', 'unknown'] $$;
create function threadlink_private.team_chatgpt_plans() returns text[]
language sql immutable set search_path = '' as $$
  select array['free', 'go', 'plus', 'pro', 'business_standard', 'business_premium', 'enterprise', 'edu',
               'unknown'] $$;
create function threadlink_private.team_arbitration_bases() returns text[]
language sql immutable set search_path = '' as $$
  select array['user_decision', 'project_decision', 'security', 'data_integrity', 'correctness',
               'architecture', 'maintainability', 'performance', 'style'] $$;
-- Runner outcomes (design 3.1 `failure`, plus 'ok').
create function threadlink_private.team_usage_outcomes() returns text[]
language sql immutable set search_path = '' as $$
  select array['ok', 'model_mismatch', 'access_mismatch', 'quota_exhausted', 'not_authenticated',
               'not_installed', 'timeout', 'provider_error'] $$;

-- Size limits. The Runtime redacts before sending; the server enforces size.
create function threadlink_private.team_body_max_bytes() returns integer
language sql immutable set search_path = '' as $$ select 8192 $$;
create function threadlink_private.team_max_nodes_per_job() returns integer
language sql immutable set search_path = '' as $$ select 100 $$;
create function threadlink_private.team_max_rooms_per_owner() returns integer
language sql immutable set search_path = '' as $$ select 100 $$;
create function threadlink_private.team_max_entries_per_job() returns integer
language sql immutable set search_path = '' as $$ select 5000 $$;

-- Test commands ThreadLink itself runs after integration: at most 10, each one
-- line of at most 300 characters (no newline, no NUL, no control character).
create function threadlink_private.valid_verify_commands(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and cardinality(p) <= 10
     and not exists (
       select 1 from unnest(p) c
       where c is null or char_length(c) not between 1 and 300 or c ~ '[[:cntrl:]]' or pg_catalog.btrim(c) = '')
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- A project: a name bound to a workspace and the agent session the creating
-- controller's link pointed at. Deleting a room is a status change and a
-- detach; it never touches repository files (the server has none).
create table public.rooms (
  id text primary key
    default threadlink_private.generate_id('tlrom')
    constraint rooms_id_format check (id ~ '^tlrom_[0-9a-f]{32}$'),
  owner_user_id text not null,
  name text not null
    constraint rooms_name_length check (char_length(name) between 1 and 100 and name !~ '[[:cntrl:]]'),
  workspace_id text not null,
  agent_session_id text,
  status text not null default 'active'
    constraint rooms_status_check check (status in ('active', 'archived', 'deleted')),
  parallel_agents integer not null default 2
    constraint rooms_parallel_agents_check check (parallel_agents between 1 and 4),
  max_planning_rounds integer not null default 2
    constraint rooms_planning_rounds_check check (max_planning_rounds between 1 and 5),
  max_review_rounds integer not null default 3
    constraint rooms_review_rounds_check check (max_review_rounds between 1 and 6),
  usage_policy text not null default 'balanced'
    constraint rooms_usage_policy_check
      check (usage_policy in ('conservative', 'balanced', 'maximum_quality', 'manual')),
  cross_review boolean not null default true,
  final_inspection boolean not null default true,
  worktree_isolation boolean not null default true,
  verify_commands text[] not null default '{}'
    constraint rooms_verify_commands_check check (threadlink_private.valid_verify_commands(verify_commands)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  constraint rooms_workspace_owner_fkey foreign key (workspace_id, owner_user_id)
    references public.runtime_workspaces (id, owner_user_id) on delete cascade,
  constraint rooms_agent_session_owner_fkey foreign key (agent_session_id, owner_user_id)
    references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint rooms_id_owner_key unique (id, owner_user_id),
  constraint rooms_attached check (status = 'deleted' or agent_session_id is not null),
  constraint rooms_archived_consistency check ((status = 'archived') = (archived_at is not null)),
  constraint rooms_deleted_consistency check ((status = 'deleted') = (deleted_at is not null))
);
comment on table public.rooms is
  'Team Mode project: a workspace plus the agent session that carries its team jobs. Deleted = detached, never files.';
create index rooms_owner_idx on public.rooms (owner_user_id, status);
create unique index rooms_owner_name_live_idx on public.rooms (owner_user_id, lower(name))
  where status <> 'deleted';

create table public.room_agents (
  owner_user_id text not null,
  room_id text not null,
  provider text not null
    constraint room_agents_provider_check check (provider in ('claude-code', 'codex')),
  display_name text not null
    constraint room_agents_name_length check (char_length(display_name) between 1 and 60),
  default_roles text[] not null
    constraint room_agents_roles_check check (
      cardinality(default_roles) between 1 and 8
      and default_roles <@ array['coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer',
                                 'test_reviewer', 'integrator', 'investigator']::text[]),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (room_id, provider),
  constraint room_agents_room_owner_fkey foreign key (room_id, owner_user_id)
    references public.rooms (id, owner_user_id) on delete cascade
);
comment on table public.room_agents is 'Which providers take part in a room, their friendly name and default roles.';
create index room_agents_owner_idx on public.room_agents (owner_user_id);

create table public.team_jobs (
  id text primary key
    default threadlink_private.generate_id('tljob')
    constraint team_jobs_id_format check (id ~ '^tljob_[0-9a-f]{32}$'),
  owner_user_id text not null,
  room_id text not null,
  task_id text not null constraint team_jobs_task_key unique,
  goal text not null
    constraint team_jobs_goal_size check (octet_length(goal) between 1 and 8000),
  -- What the controller asked for, and the normalised spec the Runtime stores
  -- once (agents receive it verbatim and may not reinterpret it).
  spec_input jsonb
    constraint team_jobs_spec_input_shape
      check (jsonb_typeof(spec_input) = 'object' and octet_length(spec_input::text) <= 32768),
  spec jsonb
    constraint team_jobs_spec_shape check (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 32768),
  plan jsonb
    constraint team_jobs_plan_shape check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 65536),
  plan_hash text constraint team_jobs_plan_hash_format check (plan_hash ~ '^[0-9a-f]{64}$'),
  -- The hash the plan had when it was agreed. Any later edit changes plan_hash
  -- and so invalidates the approval.
  plan_approved_hash text constraint team_jobs_plan_approved_format check (plan_approved_hash ~ '^[0-9a-f]{64}$'),
  plan_approved_by text[] not null default '{}'
    constraint team_jobs_plan_approved_by_check check (plan_approved_by <@ array['claude-code', 'codex']::text[]),
  -- The Runtime's own hash of the plan, kept as evidence. plan_hash (computed
  -- here) is the one that gates a PASS.
  client_plan_hash text constraint team_jobs_client_plan_hash_format check (client_plan_hash ~ '^[0-9a-f]{64}$'),
  -- One short human line about what the job is doing now.
  status_line text constraint team_jobs_status_line_length
    check (char_length(status_line) between 1 and 200 and status_line !~ '[[:cntrl:]]'),
  summary text constraint team_jobs_summary_size check (octet_length(summary) between 1 and 4000),
  status text not null default 'queued'
    constraint team_jobs_status_check check (status in (
      'queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
      'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled')),
  verdict text
    constraint team_jobs_verdict_check check (verdict in ('PASS', 'NEEDS_FIX', 'BLOCKED', 'NEEDS_USER_DECISION')),
  evidence jsonb
    constraint team_jobs_evidence_shape
      check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 32768),
  planning_round integer not null default 0,
  review_round integer not null default 0,
  max_planning_rounds integer not null default 2
    constraint team_jobs_max_planning_check check (max_planning_rounds between 1 and 5),
  max_review_rounds integer not null default 3
    constraint team_jobs_max_review_check check (max_review_rounds between 1 and 6),
  parallel_agents integer not null default 2
    constraint team_jobs_parallel_check check (parallel_agents between 1 and 4),
  verify_commands text[] not null default '{}'
    constraint team_jobs_verify_commands_check check (threadlink_private.valid_verify_commands(verify_commands)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_jobs_room_owner_fkey foreign key (room_id, owner_user_id)
    references public.rooms (id, owner_user_id) on delete cascade,
  constraint team_jobs_task_owner_fkey foreign key (task_id, owner_user_id)
    references public.tasks (id, owner_user_id) on delete cascade,
  constraint team_jobs_id_owner_key unique (id, owner_user_id),
  -- Budgets are hard: a counter can never pass its budget.
  constraint team_jobs_planning_budget check (planning_round between 0 and max_planning_rounds),
  constraint team_jobs_review_budget check (review_round between 0 and max_review_rounds),
  -- The verdict and the status agree, and only a PASS completes a job.
  constraint team_jobs_verdict_status check (
    (verdict is null and status not in ('completed', 'needs_fix', 'blocked', 'needs_user_decision'))
    or (verdict = 'PASS' and status = 'completed')
    or (verdict = 'NEEDS_FIX' and status = 'needs_fix')
    or (verdict = 'BLOCKED' and status = 'blocked')
    or (verdict = 'NEEDS_USER_DECISION' and status = 'needs_user_decision')),
  constraint team_jobs_finished_consistency check (
    (finished_at is not null)
      = (status in ('completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled'))),
  constraint team_jobs_plan_consistency check ((plan is null) = (plan_hash is null))
);
comment on table public.team_jobs is
  'One team goal carried by one task (task_type team). Round counters never exceed their budgets.';
create index team_jobs_room_idx on public.team_jobs (room_id, created_at desc);
create index team_jobs_owner_idx on public.team_jobs (owner_user_id, created_at desc);

create table public.team_nodes (
  id text primary key
    default threadlink_private.generate_id('tlnod')
    constraint team_nodes_id_format check (id ~ '^tlnod_[0-9a-f]{32}$'),
  owner_user_id text not null,
  job_id text not null,
  node_key text not null constraint team_nodes_key_format check (node_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  title text not null constraint team_nodes_title_length check (char_length(title) between 1 and 200),
  description text constraint team_nodes_description_size check (octet_length(description) between 1 and 4000),
  owner_provider text not null
    constraint team_nodes_owner_provider_check check (owner_provider in ('claude-code', 'codex')),
  reviewer_provider text
    constraint team_nodes_reviewer_provider_check check (reviewer_provider in ('claude-code', 'codex')),
  depends_on text[] not null default '{}'
    constraint team_nodes_depends_on_size check (cardinality(depends_on) <= 32),
  scope text constraint team_nodes_scope_size check (octet_length(scope) between 1 and 2000),
  files text[] not null default '{}'
    constraint team_nodes_files_size check (cardinality(files) <= 200),
  worktree_branch text constraint team_nodes_branch_format check (worktree_branch ~ '^[A-Za-z0-9._/+-]{1,200}$'),
  authorship text not null default 'single' constraint team_nodes_authorship_check check (authorship in ('single', 'mixed')),
  status text not null default 'pending'
    constraint team_nodes_status_check check (status in (
      'pending', 'ready', 'running', 'in_review', 'changes_requested', 'approved', 'integrated', 'failed', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_nodes_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint team_nodes_job_key unique (job_id, node_key),
  constraint team_nodes_id_job_key unique (id, job_id),
  -- Safety invariant: the reviewer of a node is never its author provider.
  constraint team_nodes_cross_review check (reviewer_provider is null or reviewer_provider <> owner_provider),
  constraint team_nodes_no_self_dependency check (not (node_key = any (depends_on)))
);
comment on table public.team_nodes is 'One unit of work in a job DAG. depends_on holds node keys of the same job.';
create index team_nodes_owner_idx on public.team_nodes (owner_user_id);

create table public.team_messages (
  id text primary key
    default threadlink_private.generate_id('tlamg')
    constraint team_messages_id_format check (id ~ '^tlamg_[0-9a-f]{32}$'),
  owner_user_id text not null,
  job_id text not null,
  node_id text,
  sender text not null constraint team_messages_sender_check check (sender in ('claude-code', 'codex', 'threadlink')),
  sender_role text constraint team_messages_role_check check (sender_role in (
    'coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer', 'test_reviewer', 'integrator', 'investigator')),
  receiver text constraint team_messages_receiver_check check (receiver in ('claude-code', 'codex', 'threadlink')),
  message_type text not null constraint team_messages_type_check check (message_type in (
    'proposal', 'review', 'finding', 'response', 'handoff', 'question', 'decision', 'completion')),
  round integer not null default 0 constraint team_messages_round_check check (round between 0 and 6),
  body text not null constraint team_messages_body_size check (octet_length(body) between 1 and 8192),
  created_at timestamptz not null default now(),
  constraint team_messages_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint team_messages_node_fkey foreign key (node_id, job_id)
    references public.team_nodes (id, job_id) on delete cascade
);
comment on table public.team_messages is 'Agent-to-agent messages and the review log. Redacted by the Runtime, bounded here.';
create index team_messages_job_idx on public.team_messages (job_id, created_at);
create index team_messages_owner_idx on public.team_messages (owner_user_id);

create table public.team_findings (
  id text primary key
    default threadlink_private.generate_id('tlfnd')
    constraint team_findings_id_format check (id ~ '^tlfnd_[0-9a-f]{32}$'),
  owner_user_id text not null,
  job_id text not null,
  node_id text,
  severity text not null constraint team_findings_severity_check
    check (severity in ('blocking', 'important', 'non_blocking')),
  category text not null constraint team_findings_category_check check (category in (
    'correctness', 'security', 'architecture', 'edge_case', 'tests', 'performance', 'requirements')),
  status text not null default 'open' constraint team_findings_status_check
    check (status in ('open', 'resolved', 'wont_fix')),
  title text not null constraint team_findings_title_length check (char_length(title) between 1 and 200),
  body text not null constraint team_findings_body_size check (octet_length(body) between 1 and 8192),
  location text constraint team_findings_location_length check (char_length(location) between 1 and 512),
  raised_by text not null constraint team_findings_raised_by_check check (raised_by in ('claude-code', 'codex', 'threadlink')),
  phase text constraint team_findings_phase_check check (phase in ('planning', 'review', 'inspection')),
  raised_round integer not null constraint team_findings_raised_round_check check (raised_round between 0 and 6),
  resolved_round integer constraint team_findings_resolved_round_check check (resolved_round between 0 and 6),
  resolution text constraint team_findings_resolution_size check (octet_length(resolution) between 1 and 4000),
  decision_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_findings_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint team_findings_node_fkey foreign key (node_id, job_id)
    references public.team_nodes (id, job_id) on delete cascade,
  constraint team_findings_id_job_key unique (id, job_id),
  constraint team_findings_resolution_consistency check ((status = 'open') = (resolved_round is null))
);
comment on table public.team_findings is 'Structured review findings. Only blocking/important findings reopen a round.';
create index team_findings_job_idx on public.team_findings (job_id, status, severity);
create index team_findings_owner_idx on public.team_findings (owner_user_id);

create table public.team_decisions (
  id text primary key
    default threadlink_private.generate_id('tldec')
    constraint team_decisions_id_format check (id ~ '^tldec_[0-9a-f]{32}$'),
  owner_user_id text not null,
  job_id text not null,
  -- Per-owner sequence, rendered TL-%05d by the view layer.
  number integer not null constraint team_decisions_number_check check (number between 1 and 9999999),
  title text not null constraint team_decisions_title_length check (char_length(title) between 1 and 200),
  proposals jsonb not null default '[]'::jsonb
    constraint team_decisions_proposals_shape check (
      jsonb_typeof(proposals) = 'array' and jsonb_array_length(proposals) <= 10
      and octet_length(proposals::text) <= 16384),
  evidence jsonb
    constraint team_decisions_evidence_shape check (
      jsonb_typeof(evidence) in ('object', 'array') and octet_length(evidence::text) <= 16384),
  resolution text constraint team_decisions_resolution_size check (octet_length(resolution) between 1 and 4000),
  basis text constraint team_decisions_basis_check check (basis in (
    'user_decision', 'project_decision', 'security', 'data_integrity', 'correctness', 'architecture',
    'maintainability', 'performance', 'style')),
  requires_user boolean not null default false,
  approved_by text[] not null default '{}'
    constraint team_decisions_approved_by_check check (approved_by <@ array['claude-code', 'codex']::text[]),
  created_at timestamptz not null default now(),
  constraint team_decisions_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint team_decisions_id_job_key unique (id, job_id),
  constraint team_decisions_owner_number_key unique (owner_user_id, number)
);
comment on table public.team_decisions is 'Decision log. number is a per-owner sequence shown as TL-00042.';
create index team_decisions_job_idx on public.team_decisions (job_id, number);

alter table public.team_findings add constraint team_findings_decision_fkey
  foreign key (decision_id, job_id) references public.team_decisions (id, job_id) on delete cascade;

create table public.model_usage_events (
  id text primary key
    default threadlink_private.generate_id('tlmue')
    constraint model_usage_events_id_format check (id ~ '^tlmue_[0-9a-f]{32}$'),
  owner_user_id text not null,
  job_id text not null,
  node_id text,
  provider text not null constraint model_usage_events_provider_check check (provider in ('claude-code', 'codex')),
  role text not null constraint model_usage_events_role_check check (role in (
    'coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer', 'test_reviewer', 'integrator', 'investigator')),
  requested_model text not null
    constraint model_usage_events_requested_format check (requested_model ~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$'),
  observed_model text
    constraint model_usage_events_observed_format check (observed_model ~ '^[A-Za-z0-9._:/@\[\]-]{1,200}$'),
  model_class text not null constraint model_usage_events_class_check
    check (model_class in ('FAST', 'BALANCED', 'STRONG', 'FRONTIER')),
  effort text constraint model_usage_events_effort_format check (effort ~ '^[A-Za-z0-9_-]{1,40}$'),
  reason text not null constraint model_usage_events_reason_size check (octet_length(reason) between 1 and 1000),
  escalated_from text constraint model_usage_events_escalated_check
    check (escalated_from in ('FAST', 'BALANCED', 'STRONG', 'FRONTIER')),
  escalation_reason text
    constraint model_usage_events_escalation_size check (octet_length(escalation_reason) between 1 and 1000),
  outcome text not null constraint model_usage_events_outcome_check check (outcome in (
    'ok', 'model_mismatch', 'access_mismatch', 'quota_exhausted', 'not_authenticated', 'not_installed',
    'timeout', 'provider_error')),
  input_tokens bigint constraint model_usage_events_input_check check (input_tokens between 0 and 1000000000),
  output_tokens bigint constraint model_usage_events_output_check check (output_tokens between 0 and 1000000000),
  created_at timestamptz not null default now(),
  constraint model_usage_events_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint model_usage_events_node_fkey foreign key (node_id, job_id)
    references public.team_nodes (id, job_id) on delete cascade
);
comment on table public.model_usage_events is 'Requested vs observed model per run, with the routing reason and outcome.';
create index model_usage_events_job_idx on public.model_usage_events (job_id, created_at);
create index model_usage_events_owner_idx on public.model_usage_events (owner_user_id, created_at desc);

-- Plans, policy and detected capabilities per owner+provider. Deliberately NO
-- column for an email, org id, token, key or any other credential: the
-- Runtime drops those at the boundary and the check below refuses them even
-- inside the detected document.
create function threadlink_private.valid_provider_detection(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and octet_length(p::text) <= 16384
     and not exists (
       select 1 from jsonb_object_keys(p) as k
       where k not in ('installed', 'version', 'authenticated', 'authMethod', 'detectedPlan', 'models',
                       'currentModel', 'capabilities', 'usage', 'detectedAt')
     )
     -- No credential- or identity-shaped key anywhere in the document.
     and p::text !~* '"[^"]*(email|org|organi[sz]ation|account|uuid|user_?id|token|secret|password|api_?key|credential|cookie)[^"]*"[[:space:]]*:'
     -- ...and no email address as a value, under any key.
     and p::text !~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
$$;

create table public.provider_profiles (
  id text primary key
    default threadlink_private.generate_id('tlprv')
    constraint provider_profiles_id_format check (id ~ '^tlprv_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  provider text not null constraint provider_profiles_provider_check check (provider in ('claude-code', 'codex')),
  declared_plan text not null default 'unknown',
  usage_policy text not null default 'balanced'
    constraint provider_profiles_usage_policy_check
      check (usage_policy in ('conservative', 'balanced', 'maximum_quality', 'manual')),
  -- Off by default. Only the explicit owner call set_provider_profile sets it.
  paid_usage_enabled boolean not null default false,
  detected jsonb not null default '{}'::jsonb
    constraint provider_profiles_detected_valid check (threadlink_private.valid_provider_detection(detected)),
  detected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_profiles_owner_provider_key unique (owner_user_id, provider),
  -- Claude plans for Claude Code; ChatGPT plans for Codex.
  constraint provider_profiles_plan_check check (
    (provider = 'claude-code'
      and declared_plan in ('free', 'pro', 'max_5x', 'max_20x', 'team', 'enterprise', 'unknown'))
    or (provider = 'codex'
      and declared_plan in ('free', 'go', 'plus', 'pro', 'business_standard', 'business_premium',
                            'enterprise', 'edu', 'unknown')))
);
comment on table public.provider_profiles is
  'Per owner+provider plan, usage policy, detected capabilities and paid usage (default off). No credentials.';

-- ---------------------------------------------------------------------------
-- 3. Integrity triggers (hold even for privileged writers)
-- ---------------------------------------------------------------------------
create function threadlink_private.rooms_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.workspace_id is distinct from old.workspace_id
     or new.created_at is distinct from old.created_at then
    raise exception 'room identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'deleted' then
    raise exception 'a deleted room cannot change' using errcode = '42501';
  end if;
  if new.agent_session_id is distinct from old.agent_session_id
     and not (new.status = 'deleted' and new.agent_session_id is null) then
    raise exception 'a room only detaches when it is deleted' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rooms_guard_update before update on public.rooms
  for each row execute function threadlink_private.rooms_guard_update();
create trigger rooms_touch_updated_at before update on public.rooms
  for each row execute function threadlink_private.touch_updated_at();

create function threadlink_private.team_jobs_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.room_id is distinct from old.room_id
     or new.task_id is distinct from old.task_id
     or new.goal is distinct from old.goal
     or new.spec_input is distinct from old.spec_input
     or new.max_planning_rounds is distinct from old.max_planning_rounds
     or new.max_review_rounds is distinct from old.max_review_rounds
     or new.parallel_agents is distinct from old.parallel_agents
     or new.verify_commands is distinct from old.verify_commands
     or new.created_at is distinct from old.created_at then
    raise exception 'team job identity and budgets are immutable' using errcode = '42501';
  end if;
  if old.finished_at is not null then
    raise exception 'team job is finished' using errcode = '42501';
  end if;
  if old.spec is not null and new.spec is distinct from old.spec then
    raise exception 'the job spec is stored once' using errcode = '42501';
  end if;
  if new.planning_round < old.planning_round or new.review_round < old.review_round then
    raise exception 'round counters never decrease' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger team_jobs_guard_update before update on public.team_jobs
  for each row execute function threadlink_private.team_jobs_guard_update();
create trigger team_jobs_touch_updated_at before update on public.team_jobs
  for each row execute function threadlink_private.touch_updated_at();

create trigger team_nodes_touch_updated_at before update on public.team_nodes
  for each row execute function threadlink_private.touch_updated_at();
create trigger team_findings_touch_updated_at before update on public.team_findings
  for each row execute function threadlink_private.touch_updated_at();
create trigger provider_profiles_touch_updated_at before update on public.provider_profiles
  for each row execute function threadlink_private.touch_updated_at();

create function threadlink_private.team_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger team_messages_append_only before update on public.team_messages
  for each row execute function threadlink_private.team_append_only();
create trigger team_decisions_append_only before update on public.team_decisions
  for each row execute function threadlink_private.team_append_only();
create trigger model_usage_events_append_only before update on public.model_usage_events
  for each row execute function threadlink_private.team_append_only();

-- ---------------------------------------------------------------------------
-- 4. Row level security: owner SELECT only; every write is an RPC
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.room_agents enable row level security;
alter table public.team_jobs enable row level security;
alter table public.team_nodes enable row level security;
alter table public.team_messages enable row level security;
alter table public.team_findings enable row level security;
alter table public.team_decisions enable row level security;
alter table public.model_usage_events enable row level security;
alter table public.provider_profiles enable row level security;

revoke all on table public.rooms, public.room_agents, public.team_jobs, public.team_nodes,
  public.team_messages, public.team_findings, public.team_decisions, public.model_usage_events,
  public.provider_profiles
  from public, anon, authenticated;

grant select on table public.rooms, public.room_agents, public.team_jobs, public.team_nodes,
  public.team_messages, public.team_findings, public.team_decisions, public.model_usage_events,
  public.provider_profiles
  to authenticated;

create policy rooms_select_own on public.rooms for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy room_agents_select_own on public.room_agents for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy team_jobs_select_own on public.team_jobs for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy team_nodes_select_own on public.team_nodes for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy team_messages_select_own on public.team_messages for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy team_findings_select_own on public.team_findings for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy team_decisions_select_own on public.team_decisions for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy model_usage_events_select_own on public.model_usage_events for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy provider_profiles_select_own on public.provider_profiles for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 5. Payload helpers (strict: wrong type, unknown key or oversize -> 22023)
-- ---------------------------------------------------------------------------
create function threadlink_private.tj_invalid(p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  raise exception 'invalid %', p_what using errcode = '22023';
end;
$$;

create function threadlink_private.tj_keys(p jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or exists (select 1 from jsonb_object_keys(p) k where not (k = any (p_allowed))) then
    perform threadlink_private.tj_invalid('payload');
  end if;
end;
$$;

-- Text by byte size. Blank text counts as missing.
create function threadlink_private.tj_text(p jsonb, p_key text, p_max_bytes integer, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
  t text;
begin
  if v is null or v = 'null'::jsonb then
    if p_required then perform threadlink_private.tj_invalid(p_key); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  t := v #>> '{}';
  if pg_catalog.btrim(t) = '' then
    if p_required then perform threadlink_private.tj_invalid(p_key); end if;
    return null;
  end if;
  if octet_length(t) > p_max_bytes then
    perform threadlink_private.tj_invalid(p_key || ' (too large)');
  end if;
  return t;
end;
$$;

create function threadlink_private.tj_enum(p jsonb, p_key text, p_allowed text[], p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := threadlink_private.tj_text(p, p_key, 64, p_required);
begin
  if t is not null and not (t = any (p_allowed)) then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  return t;
end;
$$;

create function threadlink_private.tj_int(p jsonb, p_key text, p_min bigint, p_max bigint, p_required boolean)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
  n numeric;
begin
  if v is null or v = 'null'::jsonb then
    if p_required then perform threadlink_private.tj_invalid(p_key); end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  n := (v #>> '{}')::numeric;
  if n <> pg_catalog.trunc(n) or n < p_min or n > p_max then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  return n::bigint;
end;
$$;

create function threadlink_private.tj_bool(p jsonb, p_key text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or v = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(v) <> 'boolean' then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  return (v #>> '{}')::boolean;
end;
$$;

-- An array of strings matching a pattern.
create function threadlink_private.tj_strings(
  p jsonb, p_key text, p_max_items integer, p_max_chars integer, p_pattern text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
  r text[];
begin
  if v is null or v = 'null'::jsonb then
    return '{}';
  end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > p_max_items
     or exists (
       select 1 from jsonb_array_elements(v) e
       where jsonb_typeof(e) <> 'string'
          or char_length(e #>> '{}') not between 1 and p_max_chars
          or (e #>> '{}') ~ '[[:cntrl:]]'
          or (p_pattern is not null and (e #>> '{}') !~ p_pattern)) then
    perform threadlink_private.tj_invalid(p_key);
  end if;
  select coalesce(array_agg(distinct e #>> '{}'), '{}') into r from jsonb_array_elements(v) e;
  return r;
end;
$$;

-- A (partial) TeamSpec: known keys only. `goal` is a string; every other field
-- is a bounded list of strings. Same shape the Runtime's TeamSpec uses.
create function threadlink_private.valid_team_spec(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and jsonb_typeof(p) = 'object'
     and octet_length(p::text) <= 32768
     and not exists (
       select 1 from jsonb_each(p) as e(k, v)
       where not (
         (e.k = 'goal' and jsonb_typeof(e.v) = 'string' and octet_length(e.v #>> '{}') between 1 and 8000)
         or (e.k in ('requirements', 'constraints', 'architectureConstraints', 'securityConstraints',
                     'filesAndSystems', 'testsRequired', 'doNotChange', 'deploymentRules', 'definitionOfDone')
             and jsonb_typeof(e.v) = 'array' and jsonb_array_length(e.v) <= 50
             and not exists (
               select 1 from jsonb_array_elements(e.v) x
               where jsonb_typeof(x) <> 'string' or octet_length(x #>> '{}') not between 1 and 2000))
       )
     )
$$;

-- Coarse phase order, so ordinary writes can move a job forward without an
-- explicit status call. Never moves backwards, never reaches a verdict.
create function threadlink_private.team_phase_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'queued' then 0 when 'normalising' then 1 when 'planning' then 2 when 'building' then 3
    when 'reviewing' then 4 when 'integrating' then 5 when 'inspecting' then 6 else null end
$$;

create function threadlink_private.team_advance(p_job_id text, p_status text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.team_jobs set status = p_status
  where id = p_job_id and finished_at is null
    and threadlink_private.team_phase_rank(status) < threadlink_private.team_phase_rank(p_status)
$$;

create function threadlink_private.team_node_key_pattern()
returns text language sql immutable set search_path = '' as $$ select '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' $$;

-- ---------------------------------------------------------------------------
-- 6. Access helpers
-- ---------------------------------------------------------------------------

-- A room of the caller's account that is not deleted; otherwise "not found".
create function threadlink_private.require_controller_room(p_connection public.connections, p_room_id text)
returns public.rooms
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms;
begin
  select * into v from public.rooms
  where id = p_room_id and owner_user_id = p_connection.owner_user_id and status <> 'deleted'
  for update;
  if not found then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

-- A job the calling controller session started (it is the carrier task's
-- origin). A job id from another account, another chat or another room is
-- indistinguishable from one that does not exist.
create function threadlink_private.require_controller_job(
  p_connection public.connections, p_session public.session_bindings, p_job_id text, p_room_id text
)
returns public.team_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.team_jobs;
begin
  select j.* into v
  from public.team_jobs j
  join public.tasks t on t.id = j.task_id and t.owner_user_id = j.owner_user_id
  join public.rooms r on r.id = j.room_id and r.owner_user_id = j.owner_user_id
  where j.id = p_job_id
    and j.owner_user_id = p_connection.owner_user_id
    and t.origin_session_id = p_session.id
    and r.status <> 'deleted'
    and (p_room_id is null or j.room_id = p_room_id);
  if not found then
    raise exception 'team job not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

create function threadlink_private.room_json(p_room_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'room_id', r.id,
    'name', r.name,
    'status', r.status,
    'workspace_id', r.workspace_id,
    'workspace_name', w.display_name,
    'agent_session_id', r.agent_session_id,
    'agent_name', s.display_name,
    'policy', jsonb_build_object(
      'parallel_agents', r.parallel_agents,
      'max_planning_rounds', r.max_planning_rounds,
      'max_review_rounds', r.max_review_rounds,
      'usage_policy', r.usage_policy,
      'cross_review', r.cross_review,
      'final_inspection', r.final_inspection,
      'worktree_isolation', r.worktree_isolation,
      'verify_commands', to_jsonb(r.verify_commands)),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', a.provider, 'name', a.display_name, 'roles', to_jsonb(a.default_roles), 'enabled', a.enabled)
        order by a.provider)
      from public.room_agents a where a.room_id = r.id), '[]'::jsonb),
    'open_jobs', (select count(*) from public.team_jobs j where j.room_id = r.id and j.finished_at is null),
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
  from public.rooms r
  join public.runtime_workspaces w on w.id = r.workspace_id
  left join public.session_bindings s on s.id = r.agent_session_id
  where r.id = p_room_id
$$;

-- The concise status: what a controller needs, and no more.
create function threadlink_private.team_status_json(p_job_id text)
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
    'rounds', jsonb_build_object(
      'planning', jsonb_build_object('n', j.planning_round, 'max', j.max_planning_rounds),
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
                   where f.job_id = j.id and f.status = 'open' and f.severity = 'blocking'),
      'important', (select count(*) from public.team_findings f
                    where f.job_id = j.id and f.status = 'open' and f.severity = 'important'),
      'non_blocking', (select count(*) from public.team_findings f
                       where f.job_id = j.id and f.status = 'open' and f.severity = 'non_blocking')),
    'decisions_needing_user', (select count(*) from public.team_decisions d
                               where d.job_id = j.id and d.requires_user),
    'created_at', j.created_at,
    'updated_at', j.updated_at,
    'finished_at', j.finished_at
  )
  from public.team_jobs j
  join public.rooms r on r.id = j.room_id
  join public.tasks t on t.id = j.task_id
  where j.id = p_job_id
$$;

-- ---------------------------------------------------------------------------
-- 7. Controller RPCs (connection credential + the controller's own session)
-- ---------------------------------------------------------------------------
create function public.list_rooms(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings :=
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
begin
  perform threadlink_private.touch_session(v_session.id);
  return coalesce((
    select jsonb_agg(threadlink_private.room_json(r.id) order by r.status, r.updated_at desc)
    from (select id, status, updated_at from public.rooms
          where owner_user_id = v_connection.owner_user_id and status <> 'deleted'
          order by status, updated_at desc
          limit 100) r
  ), '[]'::jsonb);
end;
$$;

/*
 * Creates a room bound to the workspace of the agent session the caller's
 * active link points at. With several active links the caller names one; the
 * database never guesses. Idempotent by name: the same name on the same agent
 * session returns the existing room.
 */
create function public.create_room(
  p_token_hash text, p_session_id text, p_name text, p_thread_link_id text default null
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
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_name text := pg_catalog.btrim(p_name);
  v_links integer;
  v_link public.thread_links;
  v_agent public.session_bindings;
  v_existing public.rooms;
  v_room_id text;
begin
  if v_name is null or char_length(v_name) not between 1 and 100 or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid room name' using errcode = '22023';
  end if;

  if p_thread_link_id is null then
    select count(*) into v_links from public.thread_links
    where controller_session_id = v_session.id and owner_user_id = v_connection.owner_user_id
      and status = 'active';
    if v_links = 0 then
      raise exception 'thread link not found' using errcode = 'P0002';
    elsif v_links > 1 then
      raise exception 'choose a thread link' using errcode = '22023';
    end if;
  end if;
  select * into v_link from public.thread_links
  where controller_session_id = v_session.id and owner_user_id = v_connection.owner_user_id
    and status = 'active' and (p_thread_link_id is null or id = p_thread_link_id)
  for share;
  if not found or not threadlink_private.session_is_usable(v_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  select * into v_agent from public.session_bindings where id = v_link.agent_session_id;
  if v_agent.workspace_id is null then
    -- A room is a project on a Runtime workspace; a bare agent has none.
    raise exception 'agent session has no workspace' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('threadlink:rooms:' || v_connection.owner_user_id, 0));

  select * into v_existing from public.rooms
  where owner_user_id = v_connection.owner_user_id and lower(name) = lower(v_name) and status <> 'deleted';
  if found then
    if v_existing.agent_session_id is distinct from v_agent.id then
      raise exception 'a room with this name already exists' using errcode = '55000';
    end if;
    return threadlink_private.room_json(v_existing.id) || jsonb_build_object('created', false);
  end if;

  if (select count(*) from public.rooms
      where owner_user_id = v_connection.owner_user_id and status <> 'deleted')
     >= threadlink_private.team_max_rooms_per_owner() then
    raise exception 'room limit reached' using errcode = '54000';
  end if;

  insert into public.rooms (owner_user_id, name, workspace_id, agent_session_id)
  values (v_connection.owner_user_id, v_name, v_agent.workspace_id, v_agent.id)
  returning id into v_room_id;

  insert into public.room_agents (owner_user_id, room_id, provider, display_name, default_roles)
  values
    (v_connection.owner_user_id, v_room_id, 'claude-code', 'Claude',
     array['planner', 'builder', 'reviewer', 'integrator']),
    (v_connection.owner_user_id, v_room_id, 'codex', 'Codex',
     array['builder', 'reviewer', 'security_reviewer', 'test_reviewer']);

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'room.created', 'room', v_room_id,
    jsonb_build_object('workspace_id', v_agent.workspace_id));
  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.room_json(v_room_id) || jsonb_build_object('created', true);
end;
$$;

create function public.get_room(p_token_hash text, p_session_id text, p_room_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings :=
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_room public.rooms := threadlink_private.require_controller_room(v_connection, p_room_id);
begin
  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.room_json(v_room.id) || jsonb_build_object(
    'recent_jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'job_id', j.id, 'goal', pg_catalog.left(j.goal, 120), 'status', j.status, 'verdict', j.verdict,
        'started_here', t.origin_session_id = v_session.id, 'created_at', j.created_at)
        order by j.created_at desc)
      -- Only the jobs this chat started: another chat's goals are its own,
      -- even within the same account (the same rule as get_task_result).
      from (select tj.* from public.team_jobs tj
            join public.tasks tt on tt.id = tj.task_id
            where tj.room_id = v_room.id and tt.origin_session_id = v_session.id
            order by tj.created_at desc limit 10) j
      join public.tasks t on t.id = j.task_id
    ), '[]'::jsonb));
end;
$$;

/*
 * Creates the carrier task (task_type 'team') over the room's existing active
 * link and the team job, atomically. The carrier is made by create_task
 * itself, so every routing rule (active link, paused link, available agent,
 * rate limits, idempotency) applies unchanged.
 */
-- True when a Runtime version (major.minor[.patch...]) is at least major.minor.
-- Anything unparseable is false: an unknown Runtime is not a Team-capable one.
create function threadlink_private.version_at_least(p_version text, p_major integer, p_minor integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select case
       when m[1]::integer <> p_major then m[1]::integer > p_major
       else m[2]::integer >= p_minor
     end
     from (select pg_catalog.regexp_match(p_version, '^([0-9]{1,6})\.([0-9]{1,6})') as m) v
     where m is not null),
    false);
$$;
revoke all on function threadlink_private.version_at_least(text, integer, integer) from public, anon, authenticated;

-- A task of type "team" reaches the Runtime's Team Mode, so it must have a real
-- job behind it. Only start_team_job may create one: it sets a transaction-local
-- flag for the length of its own call. A controller asking create_task for a
-- "team" task directly is refused.
create function threadlink_private.tasks_reserve_team_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.task_type = 'team'
     and coalesce(pg_catalog.current_setting('threadlink.creating_team_job', true), '') <> 'on' then
    raise exception 'the team task type is reserved for team jobs' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.tasks_reserve_team_type() from public, anon, authenticated;

create trigger tasks_reserve_team_type
  before insert on public.tasks
  for each row execute function threadlink_private.tasks_reserve_team_type();

create function public.start_team_job(
  p_token_hash text,
  p_session_id text,
  p_room_id text,
  p_goal text,
  p_spec jsonb default null,
  p_max_planning_rounds integer default null,
  p_max_review_rounds integer default null,
  p_parallel_agents integer default null,
  p_verify_commands text[] default null,
  p_idempotency_key text default null
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
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_room public.rooms := threadlink_private.require_controller_room(v_connection, p_room_id);
  v_link public.thread_links;
  v_goal text := pg_catalog.btrim(p_goal);
  -- Budgets are clamped to their bounds; the table re-checks them.
  v_planning integer := least(greatest(coalesce(p_max_planning_rounds, v_room.max_planning_rounds), 1), 5);
  v_review integer := least(greatest(coalesce(p_max_review_rounds, v_room.max_review_rounds), 1), 6);
  v_parallel integer := least(greatest(coalesce(p_parallel_agents, v_room.parallel_agents), 1), 4);
  -- ThreadLink runs these itself, with the owner's privileges and outside any
  -- agent sandbox, so only the owner sets them (the room policy). A command
  -- from the controller would let a prompt-injected chat run shell commands.
  v_verify text[] := v_room.verify_commands;
  v_runtime_version text;
  v_paid boolean;
  v_job_id text := threadlink_private.generate_id('tljob');
  v_content jsonb;
  v_task jsonb;
  v_existing text;
begin
  if p_verify_commands is not null then
    raise exception 'test commands are set by the project owner in the project settings'
      using errcode = '42501';
  end if;
  if v_room.status <> 'active' then
    raise exception 'room is not active' using errcode = '55000';
  end if;
  if v_goal is null or octet_length(v_goal) not between 1 and 8000 then
    raise exception 'invalid goal' using errcode = '22023';
  end if;
  if p_spec is not null and not threadlink_private.valid_team_spec(p_spec) then
    raise exception 'invalid spec' using errcode = '22023';
  end if;
  if not threadlink_private.valid_verify_commands(v_verify) then
    raise exception 'invalid verify commands' using errcode = '22023';
  end if;

  -- The room's route: the caller's own active link to the room's agent session.
  select * into v_link from public.thread_links
  where controller_session_id = v_session.id and agent_session_id = v_room.agent_session_id
    and owner_user_id = v_connection.owner_user_id and status = 'active';
  if not found then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  -- A team job is only started for a Runtime that can run one. Only a
  -- Team-capable Runtime reports provider detection, so an older Runtime --
  -- which would claim a team job and hand its definition to Claude as an
  -- ordinary prompt -- never receives one. Every agent in the room must have
  -- been reported installed and signed in by that Runtime.
  -- The Runtime this room's conversation lives on must itself be Team-capable.
  -- Checked per Runtime: another, newer computer on the same account reporting
  -- in says nothing about this one.
  select r.version into v_runtime_version
  from public.session_bindings sb
  join public.runtimes r on r.id = sb.runtime_id
  where sb.id = v_room.agent_session_id and sb.owner_user_id = v_connection.owner_user_id;
  if not threadlink_private.version_at_least(v_runtime_version, 0, 7) then
    raise exception 'team mode unavailable: update the ThreadLink app on the computer this project runs on'
      using errcode = '55000';
  end if;

  -- And every agent must have been reported installed and signed in with a
  -- subscription. An API-key sign-in bills per token: paid usage the owner did
  -- not switch on.
  if exists (
    select 1
    from public.room_agents a
    left join public.provider_profiles pp
      on pp.owner_user_id = a.owner_user_id and pp.provider = a.provider
    where a.room_id = v_room.id and a.enabled
      and not (
        coalesce((pp.detected ->> 'installed')::boolean, false)
        and coalesce((pp.detected ->> 'authenticated')::boolean, false)
        and (pp.detected ->> 'authMethod') = case a.provider when 'claude-code' then 'claude.ai'
                                                                 when 'codex' then 'chatgpt' end
      )
  ) then
    raise exception 'team mode unavailable: update the ThreadLink app and sign in to every agent in this room'
      using errcode = '55000';
  end if;

  -- Paid usage comes ONLY from the owner's provider profiles, never from the
  -- controller. It is on for the job only if every enabled agent's provider
  -- has it switched on; a missing profile means off.
  select coalesce(bool_and(coalesce(pp.paid_usage_enabled, false)), false) into v_paid
  from public.room_agents a
  left join public.provider_profiles pp
    on pp.owner_user_id = a.owner_user_id and pp.provider = a.provider
  where a.room_id = v_room.id and a.enabled;

  -- The carrier content: everything the Runtime needs to run the job, built
  -- here. Only goal, spec, budgets and verifyCommands come from the controller.
  v_content := jsonb_build_object(
    'kind', 'threadlink.team_job',
    'version', 1,
    'jobId', v_job_id,
    'roomId', v_room.id,
    'roomName', v_room.name,
    'goal', v_goal,
    'spec', coalesce(p_spec, '{}'::jsonb),
    'budgets', jsonb_build_object(
      'maxPlanningRounds', v_planning, 'maxReviewRounds', v_review, 'parallelAgents', v_parallel),
    'policy', jsonb_build_object(
      'usagePolicy', v_room.usage_policy,
      'paidUsage', v_paid,
      'crossReview', v_room.cross_review,
      'finalInspection', v_room.final_inspection,
      'worktreeIsolation', v_room.worktree_isolation,
      'overrides', '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', a.provider, 'displayName', a.display_name, 'roles', to_jsonb(a.default_roles))
        order by a.provider)
      from public.room_agents a where a.room_id = v_room.id and a.enabled), '[]'::jsonb),
    'verifyCommands', to_jsonb(v_verify)
  );
  if octet_length(v_content::text) > 65536 then
    raise exception 'team job is too large' using errcode = '22023';
  end if;

  -- The "team" task type is reserved (see tasks_reserve_team_type): only this
  -- function may create one, and only for the length of this call.
  perform pg_catalog.set_config('threadlink.creating_team_job', 'on', true);
  v_task := public.create_task(
    p_token_hash, v_session.id, v_link.id,
    pg_catalog.left(pg_catalog.regexp_replace(v_goal, '[[:space:]]+', ' ', 'g'), 255),
    v_content::text,
    'C', 'team', p_idempotency_key, 604800);
  perform pg_catalog.set_config('threadlink.creating_team_job', '', true);

  if not (v_task ->> 'created')::boolean then
    -- Idempotent replay: return the job the first call made.
    select id into v_existing from public.team_jobs
    where task_id = v_task ->> 'task_id' and owner_user_id = v_connection.owner_user_id;
    if v_existing is null then
      raise exception 'idempotency key already used' using errcode = '55000';
    end if;
    return threadlink_private.team_status_json(v_existing) || jsonb_build_object('created', false);
  end if;

  insert into public.team_jobs
    (id, owner_user_id, room_id, task_id, goal, spec_input,
     max_planning_rounds, max_review_rounds, parallel_agents, verify_commands)
  values
    (v_job_id, v_connection.owner_user_id, v_room.id, v_task ->> 'task_id', v_goal, p_spec,
     v_planning, v_review, v_parallel, v_verify);

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'team.job_started', 'team_job', v_job_id,
    jsonb_build_object('room_id', v_room.id, 'task_id', v_task ->> 'task_id'));
  return threadlink_private.team_status_json(v_job_id) || jsonb_build_object('created', true);
end;
$$;

create function public.get_team_status(
  p_token_hash text, p_session_id text, p_job_id text, p_room_id text default null
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
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_job public.team_jobs := threadlink_private.require_controller_job(v_connection, v_session, p_job_id, p_room_id);
begin
  perform threadlink_private.sweep_task(v_job.task_id);
  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.team_status_json(v_job.id);
end;
$$;

-- The full structured log, bounded and paginated (offset/limit, oldest first).
create function public.get_team_log(
  p_token_hash text, p_session_id text, p_job_id text, p_room_id text default null,
  p_offset integer default 0, p_limit integer default 50
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
    threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_job public.team_jobs := threadlink_private.require_controller_job(v_connection, v_session, p_job_id, p_room_id);
  v_offset integer := coalesce(p_offset, 0);
  v_limit integer := coalesce(p_limit, 50);
  v_total integer;
  v_entries jsonb;
begin
  if v_offset < 0 or v_offset > 100000 or v_limit < 1 or v_limit > 100 then
    raise exception 'invalid page' using errcode = '22023';
  end if;

  with entries as (
    select m.created_at, m.id, jsonb_build_object(
      'kind', 'message', 'id', m.id, 'node', n.node_key, 'sender', m.sender, 'sender_role', m.sender_role,
      'receiver', m.receiver, 'type', m.message_type, 'round', m.round, 'body', m.body,
      'at', m.created_at) as entry
    from public.team_messages m left join public.team_nodes n on n.id = m.node_id
    where m.job_id = v_job.id
    union all
    select f.created_at, f.id, jsonb_build_object(
      'kind', 'finding', 'id', f.id, 'node', n.node_key, 'severity', f.severity, 'category', f.category,
      'status', f.status, 'title', f.title, 'body', f.body, 'location', f.location, 'raised_by', f.raised_by,
      'raised_round', f.raised_round, 'resolved_round', f.resolved_round, 'resolution', f.resolution,
      'at', f.created_at)
    from public.team_findings f left join public.team_nodes n on n.id = f.node_id
    where f.job_id = v_job.id
    union all
    select d.created_at, d.id, jsonb_build_object(
      'kind', 'decision', 'id', d.id, 'number', d.number, 'title', d.title, 'proposals', d.proposals,
      'evidence', d.evidence, 'resolution', d.resolution, 'basis', d.basis, 'requires_user', d.requires_user,
      'at', d.created_at)
    from public.team_decisions d
    where d.job_id = v_job.id
    union all
    select u.created_at, u.id, jsonb_build_object(
      'kind', 'usage', 'id', u.id, 'node', n.node_key, 'provider', u.provider, 'role', u.role,
      'requested_model', u.requested_model, 'observed_model', u.observed_model, 'model_class', u.model_class,
      'effort', u.effort, 'reason', u.reason, 'escalated_from', u.escalated_from,
      'escalation_reason', u.escalation_reason, 'outcome', u.outcome,
      'input_tokens', u.input_tokens, 'output_tokens', u.output_tokens, 'at', u.created_at)
    from public.model_usage_events u left join public.team_nodes n on n.id = u.node_id
    where u.job_id = v_job.id
  )
  select (select count(*) from entries),
         coalesce((select jsonb_agg(e.entry order by e.created_at, e.id)
                   from (select * from entries order by created_at, id offset v_offset limit v_limit) e),
                  '[]'::jsonb)
  into v_total, v_entries;

  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.team_status_json(v_job.id) || jsonb_build_object(
    'spec_input', v_job.spec_input,
    'spec', v_job.spec,
    'plan', v_job.plan,
    'evidence', v_job.evidence,
    'nodes_detail', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', n.node_key, 'title', n.title, 'description', n.description, 'owner', n.owner_provider,
        'reviewer', n.reviewer_provider, 'depends_on', to_jsonb(n.depends_on), 'scope', n.scope,
        'files', to_jsonb(n.files), 'worktree_branch', n.worktree_branch, 'authorship', n.authorship,
        'status', n.status) order by n.created_at, n.node_key)
      from public.team_nodes n where n.job_id = v_job.id), '[]'::jsonb),
    'entries', v_entries,
    'total', v_total,
    'offset', v_offset,
    'next_offset', case when v_offset + v_limit < v_total then v_offset + v_limit end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Runtime write: ONE RPC, a discriminated set of operations, all gated by
--    the carrier task's claim
-- ---------------------------------------------------------------------------
create function threadlink_private.team_node_id(p_job_id text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_key is null then
    return null;
  end if;
  select id into v from public.team_nodes where job_id = p_job_id and node_key = p_key;
  if v is null then
    raise exception 'unknown node' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Unknown dependencies and cycles are refused (Kahn's algorithm, <= 100 nodes).
create function threadlink_private.team_assert_dag(p_job_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_remaining text[];
  v_ready text[];
begin
  if exists (
    select 1 from public.team_nodes n cross join lateral unnest(n.depends_on) d(dep)
    where n.job_id = p_job_id
      and not exists (select 1 from public.team_nodes m where m.job_id = p_job_id and m.node_key = d.dep)
  ) then
    raise exception 'unknown dependency' using errcode = '22023';
  end if;

  select coalesce(array_agg(node_key), '{}') into v_remaining from public.team_nodes where job_id = p_job_id;
  while cardinality(v_remaining) > 0 loop
    select array_agg(node_key) into v_ready from public.team_nodes
    where job_id = p_job_id and node_key = any (v_remaining) and not (depends_on && v_remaining);
    if v_ready is null then
      raise exception 'dependency cycle' using errcode = '22023';
    end if;
    select coalesce(array_agg(k), '{}') into v_remaining
    from unnest(v_remaining) k where not (k = any (v_ready));
  end loop;
end;
$$;

create function threadlink_private.team_decision_for(p_job_id text, p_number bigint)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  select id into v from public.team_decisions where job_id = p_job_id and number = p_number;
  if v is null then
    raise exception 'unknown decision' using errcode = '22023';
  end if;
  return v;
end;
$$;

create function public.team_job_write(
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
  if jsonb_typeof(v_p) <> 'object' or octet_length(v_p::text) > 131072 then
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
      -- Approval is a review outcome and goes through set_node_status (which
      -- checks findings). A snapshot may repeat a status the node already has.
      if v_status in ('approved', 'integrated') and (v_node.id is null or v_status is distinct from v_node.status) then
        raise exception 'a node is approved through set_node_status' using errcode = '22023';
      end if;
      if found then
        -- Once a unit has started, what it is -- its scope, files, reviewer --
        -- is what was reviewed. Rewriting it afterwards would let an approval
        -- stand for work nobody looked at.
        if v_node.status not in ('pending', 'ready') then
          raise exception 'node has started; its definition is fixed' using errcode = '55000';
        end if;
        -- Ownership is committed: it changes only through a recorded decision.
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
    -- A unit's life runs one way. Failed is as final as integrated: a failed
    -- unit cannot be quietly moved to skipped or approved on the way to a PASS.
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
      if v_node.reviewer_provider is null then
        raise exception 'a node is approved only by a reviewer' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_findings
                 where node_id = v_id and status = 'open' and severity in ('blocking', 'important')) then
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
  when 'add_message' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'sender', 'sender_role', 'receiver', 'type',
                                                  'round', 'body']);
    insert into public.team_messages
      (owner_user_id, job_id, node_id, sender, sender_role, receiver, message_type, round, body)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       threadlink_private.tj_enum(v_p, 'sender', array['claude-code', 'codex', 'threadlink'], true),
       threadlink_private.tj_enum(v_p, 'sender_role', threadlink_private.team_roles(), false),
       threadlink_private.tj_enum(v_p, 'receiver', array['claude-code', 'codex', 'threadlink'], false),
       threadlink_private.tj_enum(v_p, 'type', threadlink_private.team_message_types(), true),
       coalesce(threadlink_private.tj_int(v_p, 'round', 0, 6, false),
                greatest(v_job.planning_round, v_job.review_round)),
       threadlink_private.tj_text(v_p, 'body', threadlink_private.team_body_max_bytes(), true))
    returning id into v_id;
    v_result := jsonb_build_object('message_id', v_id);

  -- ------------------------------------------------------------- add_finding
  when 'add_finding' then
    perform threadlink_private.tj_keys(v_p, array['node_key', 'severity', 'category', 'title', 'body',
                                                  'location', 'raised_by', 'round', 'phase']);
    insert into public.team_findings
      (owner_user_id, job_id, node_id, severity, category, title, body, location, raised_by, raised_round, phase)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       threadlink_private.tj_enum(v_p, 'severity', threadlink_private.team_finding_severities(), true),
       threadlink_private.tj_enum(v_p, 'category', threadlink_private.team_finding_categories(), true),
       threadlink_private.tj_text(v_p, 'title', 800, true),
       threadlink_private.tj_text(v_p, 'body', threadlink_private.team_body_max_bytes(), true),
       threadlink_private.tj_text(v_p, 'location', 2048, false),
       threadlink_private.tj_enum(v_p, 'raised_by', array['claude-code', 'codex', 'threadlink'], true),
       coalesce(threadlink_private.tj_int(v_p, 'round', 0, 6, false), v_job.review_round),
       threadlink_private.tj_enum(v_p, 'phase', array['planning', 'review', 'inspection'], false))
    returning id into v_id;
    v_result := jsonb_build_object('finding_id', v_id);

  -- ------------------------------------------------------ set_finding_status
  when 'set_finding_status' then
    perform threadlink_private.tj_keys(v_p, array['finding_id', 'status', 'resolution', 'decision_number', 'round']);
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
    -- Declining to fix a blocking/important finding is a decision, recorded.
    if v_status = 'wont_fix' and v_decision_id is null
       and (select severity from public.team_findings where id = v_id) in ('blocking', 'important') then
      raise exception 'wont_fix on a blocking finding needs a decision' using errcode = '55000';
    end if;
    update public.team_findings
    set status = v_status,
        resolved_round = case when v_status = 'open' then null else coalesce(v_round, v_job.review_round) end,
        resolution = case when v_status = 'open' then null
                          else coalesce(threadlink_private.tj_text(v_p, 'resolution', 4000, false), resolution) end,
        decision_id = coalesce(v_decision_id, decision_id)
    where id = v_id;

  -- ------------------------------------------------------------ add_decision
  when 'add_decision' then
    perform threadlink_private.tj_keys(v_p, array['title', 'proposals', 'evidence', 'resolution', 'basis',
                                                  'requires_user', 'approved_by']);
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
      (owner_user_id, job_id, number, title, proposals, evidence, resolution, basis, requires_user, approved_by)
    values
      (v_job.owner_user_id, v_job.id, v_number,
       threadlink_private.tj_text(v_p, 'title', 800, true),
       coalesce(v_p -> 'proposals', '[]'::jsonb),
       v_p -> 'evidence',
       threadlink_private.tj_text(v_p, 'resolution', 4000, false),
       threadlink_private.tj_enum(v_p, 'basis', threadlink_private.team_arbitration_bases(), false),
       coalesce(threadlink_private.tj_bool(v_p, 'requires_user'), false),
       v_strings)
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
    -- A retried call naming a round that is already open changes nothing.
    if v_round is not null and v_round <= v_count then
      return threadlink_private.team_status_json(v_job.id)
        || jsonb_build_object('op', p_op, 'result', jsonb_build_object('round', v_count, 'opened', false));
    end if;
    if v_round is not null and v_round <> v_count + 1 then
      raise exception 'rounds open one at a time' using errcode = '22023';
    end if;
    -- Refused past the budget: the orchestrator must then record NEEDS_FIX or
    -- needs_user_decision, never a PASS.
    if (v_text = 'planning' and v_job.planning_round >= v_job.max_planning_rounds)
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
    -- Phase moves only. The four verdict statuses are reachable ONLY through
    -- set_final, so a status can never claim a result it has not earned.
    -- 'failed' comes from the carrier task failing (see the tasks trigger).
    perform threadlink_private.tj_keys(v_p, array['status', 'line']);
    v_status := threadlink_private.tj_enum(v_p, 'status', threadlink_private.team_job_statuses(), true);
    if v_status not in ('normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
                        'cancelled') then
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
    perform threadlink_private.tj_keys(v_p, array['verdict', 'evidence', 'summary']);
    v_text := threadlink_private.tj_enum(v_p, 'verdict', threadlink_private.team_verdicts(), true);
    if v_p -> 'evidence' is null or jsonb_typeof(v_p -> 'evidence') <> 'object'
       or octet_length((v_p -> 'evidence')::text) > 32768 then
      raise exception 'invalid evidence' using errcode = '22023';
    end if;
    if v_text = 'PASS' then
      -- Hard rules. A PASS is never manufactured.
      if exists (select 1 from public.team_findings
                 where job_id = v_job.id and status = 'open' and severity in ('blocking', 'important')) then
        raise exception 'PASS refused: open blocking or important findings' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_nodes where job_id = v_job.id and status = 'failed') then
        raise exception 'PASS refused: a node failed' using errcode = '55000';
      end if;
      if exists (select 1 from public.team_nodes
                 where job_id = v_job.id and status not in ('approved', 'integrated', 'skipped')) then
        raise exception 'PASS refused: unfinished nodes' using errcode = '55000';
      end if;
      -- A PASS needs an agreed plan and at least one unit of work: a job with
      -- neither has not been done, however it is reported.
      if v_job.plan_hash is null or v_job.plan_approved_hash is distinct from v_job.plan_hash then
        raise exception 'PASS refused: no approved plan, or the plan changed after approval'
          using errcode = '55000';
      end if;
      if not exists (select 1 from public.team_nodes where job_id = v_job.id) then
        raise exception 'PASS refused: no units of work' using errcode = '55000';
      end if;
      -- A question for the owner stays open until the owner answers it. Text an
      -- agent wrote into it does not answer it.
      if exists (select 1 from public.team_decisions where job_id = v_job.id and requires_user) then
        raise exception 'PASS refused: a decision is waiting for the user' using errcode = '55000';
      end if;
    end if;
    update public.team_jobs
    set verdict = v_text,
        evidence = v_p -> 'evidence',
        summary = threadlink_private.tj_text(v_p, 'summary', 4000, false),
        status = case v_text when 'PASS' then 'completed' when 'NEEDS_FIX' then 'needs_fix'
                             when 'BLOCKED' then 'blocked' else 'needs_user_decision' end,
        finished_at = pg_catalog.now()
    where id = v_job.id;
    perform threadlink_private.record_event(
      v_job.owner_user_id, v_connection.id, 'team.job_finished', 'team_job', v_job.id,
      jsonb_build_object('verdict', v_text));

  else
    raise exception 'invalid op' using errcode = '22023';
  end case;

  return threadlink_private.team_status_json(v_job.id) || jsonb_build_object('op', p_op, 'result', v_result);
end;
$$;

-- A carrier task that fails, expires or is cancelled (link revoked, route
-- invalid) ends its job too, so a job never looks alive on a dead route.
-- Additive: a new trigger on tasks; it only touches team_jobs rows.
create function threadlink_private.tasks_finish_team_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.task_type = 'team' and new.status in ('failed', 'cancelled', 'expired')
     and old.status is distinct from new.status then
    update public.team_jobs
    set status = case when new.status = 'cancelled' then 'cancelled' else 'failed' end,
        finished_at = pg_catalog.now()
    where task_id = new.id and finished_at is null;
  end if;
  return null;
end;
$$;
create trigger tasks_finish_team_job
  after update of status on public.tasks
  for each row execute function threadlink_private.tasks_finish_team_job();

-- ---------------------------------------------------------------------------
-- 9. Runtime provider profile: read the owner's settings, report detection.
--    The Runtime can never change plan, policy or paid usage.
-- ---------------------------------------------------------------------------
create function threadlink_private.provider_profile_json(p_owner text, p_provider text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'provider', p_provider,
    'declared_plan', coalesce(pp.declared_plan, 'unknown'),
    'usage_policy', coalesce(pp.usage_policy, 'balanced'),
    'paid_usage_enabled', coalesce(pp.paid_usage_enabled, false),
    'detected', coalesce(pp.detected, '{}'::jsonb),
    'detected_at', pp.detected_at,
    'updated_at', pp.updated_at)
  from (select 1) one
  left join public.provider_profiles pp on pp.owner_user_id = p_owner and pp.provider = p_provider
$$;

create function public.get_provider_profiles(p_token_hash text)
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
  return jsonb_build_array(
    threadlink_private.provider_profile_json(v_runtime.owner_user_id, 'claude-code'),
    threadlink_private.provider_profile_json(v_runtime.owner_user_id, 'codex'));
end;
$$;

create function public.report_provider_detection(p_token_hash text, p_provider text, p_detected jsonb)
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
  if p_provider is null or not (p_provider = any (threadlink_private.team_providers())) then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if p_detected is null or not threadlink_private.valid_provider_detection(p_detected) then
    raise exception 'invalid detection' using errcode = '22023';
  end if;
  insert into public.provider_profiles (owner_user_id, provider, detected, detected_at)
  values (v_runtime.owner_user_id, p_provider, p_detected, pg_catalog.now())
  on conflict (owner_user_id, provider) do update
    set detected = excluded.detected, detected_at = excluded.detected_at;
  return threadlink_private.provider_profile_json(v_runtime.owner_user_id, p_provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Owner (dashboard, Clerk-authenticated) operations
-- ---------------------------------------------------------------------------
create function threadlink_private.require_owned_room(p_room_id text)
returns public.rooms
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v public.rooms;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v from public.rooms where id = p_room_id and owner_user_id = v_owner for update;
  if not found or v.status = 'deleted' then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

create function public.rename_room(p_room_id text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms := threadlink_private.require_owned_room(p_room_id);
  v_name text := pg_catalog.btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 100 or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid room name' using errcode = '22023';
  end if;
  if exists (select 1 from public.rooms where owner_user_id = v.owner_user_id and id <> v.id
             and status <> 'deleted' and lower(name) = lower(v_name)) then
    raise exception 'a room with this name already exists' using errcode = '55000';
  end if;
  update public.rooms set name = v_name where id = v.id;
  perform threadlink_private.record_event(v.owner_user_id, null, 'room.renamed', 'room', v.id);
  return threadlink_private.room_json(v.id);
end;
$$;

create function public.archive_room(p_room_id text, p_archived boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms := threadlink_private.require_owned_room(p_room_id);
begin
  if p_archived is null then
    raise exception 'invalid archived flag' using errcode = '22023';
  end if;
  if p_archived and v.status = 'active' then
    update public.rooms set status = 'archived', archived_at = pg_catalog.now() where id = v.id;
    perform threadlink_private.record_event(v.owner_user_id, null, 'room.archived', 'room', v.id);
  elsif not p_archived and v.status = 'archived' then
    update public.rooms set status = 'active', archived_at = null where id = v.id;
    perform threadlink_private.record_event(v.owner_user_id, null, 'room.restored', 'room', v.id);
  end if;
  return threadlink_private.room_json(v.id);
end;
$$;

/*
 * Deleting a room is a status change and a detach. It never touches repository
 * files (the server has none), and it never deletes the carrier tasks: their
 * history stays exactly where it was. Open jobs stop accepting writes.
 */
create function public.delete_room(p_room_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms := threadlink_private.require_owned_room(p_room_id);
begin
  update public.team_jobs set status = 'cancelled', finished_at = pg_catalog.now()
  where room_id = v.id and finished_at is null;
  update public.rooms
  set status = 'deleted', deleted_at = pg_catalog.now(), archived_at = null, agent_session_id = null
  where id = v.id;
  perform threadlink_private.record_event(v.owner_user_id, null, 'room.deleted', 'room', v.id);
  return jsonb_build_object('room_id', v.id, 'status', 'deleted');
end;
$$;

-- Room policy (owner-set). Null leaves a field unchanged. Applies to jobs
-- started afterwards; a running job keeps the budgets it was started with.
create function public.update_room_policy(
  p_room_id text,
  p_parallel_agents integer default null,
  p_max_planning_rounds integer default null,
  p_max_review_rounds integer default null,
  p_usage_policy text default null,
  p_cross_review boolean default null,
  p_final_inspection boolean default null,
  p_verify_commands text[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.rooms := threadlink_private.require_owned_room(p_room_id);
begin
  if (p_parallel_agents is not null and p_parallel_agents not between 1 and 4)
     or (p_max_planning_rounds is not null and p_max_planning_rounds not between 1 and 5)
     or (p_max_review_rounds is not null and p_max_review_rounds not between 1 and 6)
     or (p_usage_policy is not null and not (p_usage_policy = any (threadlink_private.team_usage_policies())))
     or (p_verify_commands is not null and not threadlink_private.valid_verify_commands(p_verify_commands)) then
    raise exception 'invalid room policy' using errcode = '22023';
  end if;
  update public.rooms
  set parallel_agents = coalesce(p_parallel_agents, parallel_agents),
      max_planning_rounds = coalesce(p_max_planning_rounds, max_planning_rounds),
      max_review_rounds = coalesce(p_max_review_rounds, max_review_rounds),
      usage_policy = coalesce(p_usage_policy, usage_policy),
      cross_review = coalesce(p_cross_review, cross_review),
      final_inspection = coalesce(p_final_inspection, final_inspection),
      verify_commands = coalesce(p_verify_commands, verify_commands)
  where id = v.id;
  return threadlink_private.room_json(v.id);
end;
$$;

/*
 * Plan, usage policy and paid usage for one provider. Paid usage can only be
 * switched on HERE, by the signed-in owner, explicitly: null leaves it as is.
 */
create function public.set_provider_profile(
  p_provider text,
  p_declared_plan text default null,
  p_usage_policy text default null,
  p_paid_usage_enabled boolean default null
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
  if p_provider is null or not (p_provider = any (threadlink_private.team_providers())) then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if p_declared_plan is not null and not (p_declared_plan = any (
       case p_provider when 'claude-code' then threadlink_private.team_claude_plans()
                       else threadlink_private.team_chatgpt_plans() end)) then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  if p_usage_policy is not null and not (p_usage_policy = any (threadlink_private.team_usage_policies())) then
    raise exception 'invalid usage policy' using errcode = '22023';
  end if;

  insert into public.provider_profiles (owner_user_id, provider, declared_plan, usage_policy, paid_usage_enabled)
  values (v_owner, p_provider, coalesce(p_declared_plan, 'unknown'), coalesce(p_usage_policy, 'balanced'),
          coalesce(p_paid_usage_enabled, false))
  on conflict (owner_user_id, provider) do update
    set declared_plan = coalesce(p_declared_plan, public.provider_profiles.declared_plan),
        usage_policy = coalesce(p_usage_policy, public.provider_profiles.usage_policy),
        paid_usage_enabled = coalesce(p_paid_usage_enabled, public.provider_profiles.paid_usage_enabled);

  perform threadlink_private.record_event(v_owner, null, 'provider.profile_updated', 'provider_profile',
    (select id from public.provider_profiles where owner_user_id = v_owner and provider = p_provider),
    jsonb_build_object('provider', p_provider, 'declared_plan', p_declared_plan,
                       'usage_policy', p_usage_policy, 'paid_usage_enabled', p_paid_usage_enabled));
  return threadlink_private.provider_profile_json(v_owner, p_provider);
end;
$$;

/*
 * "Remove from ThreadLink": retires the session binding, which revokes its
 * links (cascade) and so cancels their open tasks, exactly like a client's own
 * retire_session. It does NOT and cannot delete the provider's native history:
 * ThreadLink never had it. Idempotent.
 */
create function public.remove_conversation(p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_session public.session_bindings;
  v_links integer;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into v_session from public.session_bindings
  where id = p_session_id and owner_user_id = v_owner
  for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  select count(*) into v_links from public.thread_links
  where owner_user_id = v_owner and status in ('pending', 'active')
    and (controller_session_id = v_session.id or agent_session_id = v_session.id);
  if v_session.status in ('active', 'idle') then
    update public.session_bindings set status = 'retired' where id = v_session.id;
    perform threadlink_private.record_event(v_owner, null, 'session.retired', 'session', v_session.id,
      jsonb_build_object('by', 'owner'));
  else
    v_links := 0;
  end if;
  return jsonb_build_object(
    'session_id', v_session.id,
    'status', (select status from public.session_bindings where id = v_session.id),
    'links_revoked', v_links,
    'native_history_deleted', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Privileges
--
-- Supabase default privileges grant EXECUTE on new public functions to
-- `anon` and `authenticated`, so every function here is revoked from all
-- client roles first and then granted to exactly its audience:
--   * credential (controller/runtime) RPCs -> anon only: the server calls them
--     with an identity-less client; a signed-in dashboard user has no use for
--     them and does not get them;
--   * owner RPCs -> authenticated only.
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.team_providers()', 'threadlink_private.team_roles()',
    'threadlink_private.team_job_statuses()', 'threadlink_private.team_verdicts()',
    'threadlink_private.team_node_statuses()', 'threadlink_private.team_message_types()',
    'threadlink_private.team_finding_severities()', 'threadlink_private.team_finding_categories()',
    'threadlink_private.team_finding_statuses()', 'threadlink_private.team_model_classes()',
    'threadlink_private.team_usage_policies()', 'threadlink_private.team_claude_plans()',
    'threadlink_private.team_chatgpt_plans()', 'threadlink_private.team_arbitration_bases()',
    'threadlink_private.team_usage_outcomes()', 'threadlink_private.team_body_max_bytes()',
    'threadlink_private.team_max_nodes_per_job()', 'threadlink_private.team_max_rooms_per_owner()',
    'threadlink_private.team_max_entries_per_job()',
    'threadlink_private.valid_provider_detection(jsonb)',
    'threadlink_private.rooms_guard_update()', 'threadlink_private.team_jobs_guard_update()',
    'threadlink_private.team_append_only()',
    'threadlink_private.tj_invalid(text)', 'threadlink_private.tj_keys(jsonb, text[])',
    'threadlink_private.tj_text(jsonb, text, integer, boolean)',
    'threadlink_private.tj_enum(jsonb, text, text[], boolean)',
    'threadlink_private.tj_int(jsonb, text, bigint, bigint, boolean)',
    'threadlink_private.tj_bool(jsonb, text)',
    'threadlink_private.tj_strings(jsonb, text, integer, integer, text)',
    'threadlink_private.valid_team_spec(jsonb)', 'threadlink_private.team_node_key_pattern()',
    'threadlink_private.require_controller_room(public.connections, text)',
    'threadlink_private.require_controller_job(public.connections, public.session_bindings, text, text)',
    'threadlink_private.room_json(text)', 'threadlink_private.team_status_json(text)',
    'threadlink_private.team_node_id(text, text)', 'threadlink_private.team_assert_dag(text)',
    'threadlink_private.team_decision_for(text, bigint)',
    'threadlink_private.provider_profile_json(text, text)',
    'threadlink_private.require_owned_room(text)',
    'threadlink_private.valid_verify_commands(text[])',
    'threadlink_private.team_phase_rank(text)', 'threadlink_private.team_advance(text, text)',
    'threadlink_private.tasks_finish_team_job()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.list_rooms(text, text)',
    'public.create_room(text, text, text, text)',
    'public.get_room(text, text, text)',
    'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text)',
    'public.get_team_status(text, text, text, text)',
    'public.get_team_log(text, text, text, text, integer, integer)',
    'public.team_job_write(text, text, text, text, text, jsonb)',
    'public.get_provider_profiles(text)',
    'public.report_provider_detection(text, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;

  foreach f in array array[
    'public.rename_room(text, text)',
    'public.archive_room(text, boolean)',
    'public.delete_room(text)',
    'public.set_provider_profile(text, text, text, boolean)',
    'public.update_room_policy(text, integer, integer, integer, text, boolean, boolean, text[])',
    'public.remove_conversation(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$grants$;
