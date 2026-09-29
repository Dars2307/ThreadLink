-- ===========================================================================
-- ThreadLink 0.11: execution lanes (Fast Chat / Engineering Work), owner
-- failover settings, quota-aware choices, natural choice answers, presence v2,
-- work-as-liveness, the wake long-poll, and the 0.11 team_job_write ops.
--
-- Contract: docs/design/threadlink-0.11.md (sections 2-6, 12).
-- Shared TS types: lib/chat/types.ts (0.11 section).
--
-- Additive, like every migration since Production has real data:
--   * new table user_settings; new nullable / defaulted columns on team_jobs,
--     agent_runs and runtime_provider_health; nothing existing is dropped;
--   * check constraints that enumerate values are RE-STATED as supersets
--     (audit actions, chat event types, job statuses and verdicts, choice kinds
--     and params);
--   * functions from earlier migrations are replaced in place (same
--     signatures, grants preserved) or gain new overloads. public.team_job_write
--     is moved to threadlink_private.team_job_write_v10 and wrapped by a new
--     public.team_job_write with the same signature and audience;
--   * the old post overloads keep their 0.10 behaviour exactly (lane work).
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
  'team.choice_requested', 'team.choice_decided', 'team.control_requested',
  'chat.attachment_added', 'chat.artifact_deleted', 'team.native_session_revealed',
  -- New in 0.11.
  'settings.updated', 'team.failover_notice'
));

-- ---------------------------------------------------------------------------
-- 1. Vocabulary and bounds (mirrors lib/chat/types.ts 0.11 section)
-- ---------------------------------------------------------------------------
-- The protocol a 0.11 Runtime reports. A 0.10 Runtime (protocol 10) keeps
-- working: the minimum stays 10 (runtime_protocol_min), it just never
-- receives Fast Chat work (chat lane needs min_protocol_for('chat_lane')).
create or replace function threadlink_private.runtime_protocol_current() returns integer
language sql immutable set search_path = '' as $$ select 11 $$;
create function threadlink_private.runtime_protocol_min() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
create or replace function threadlink_private.min_protocol_for(p_feature text) returns integer
language sql immutable set search_path = '' as $$
  select case p_feature
    when 'team' then 7
    when 'solo' then 8
    when 'pair' then 8
    when 'job_control' then 10
    when 'choices' then 10
    when 'runs' then 10
    when 'chat_lane' then 11
    when 'failover' then 11
    when 'review_check' then 11
    else 10 end $$;

create or replace function threadlink_private.chat_event_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status',
               'plan_agreed', 'unit_status', 'finding', 'decision', 'job_verdict', 'task_started',
               'task_progress', 'task_completed', 'task_failed', 'task_cancelled', 'owner_routed',
               'stop_requested', 'model_used', 'model_mismatch', 'mode_changed', 'provider_blocked',
               'code_change', 'decision_card', 'choice', 'job_summary', 'phase', 'timeout', 'interrupted',
               'control_requested', 'failover'] $$;
-- Superset: 0.11 adds review_pending (terminal: work done, independent review pending).
create or replace function threadlink_private.team_job_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
               'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled',
               'interrupted', 'paused', 'review_pending'] $$;
create or replace function threadlink_private.team_verdicts() returns text[]
language sql immutable set search_path = '' as $$
  select array['PASS', 'NEEDS_FIX', 'BLOCKED', 'NEEDS_USER_DECISION', 'REVIEW_PENDING'] $$;
create or replace function threadlink_private.choice_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['provider_failure', 'timeout', 'plan_disagreement', 'interrupted', 'migration',
               'production_deploy', 'destructive_action', 'security_action', 'paid_usage',
               'permission_expansion', 'secret_change', 'start_work', 'usage_exhausted'] $$;
-- Choices that only the card may answer (never natural language, never a controller).
create function threadlink_private.approval_choice_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['migration', 'production_deploy', 'destructive_action', 'security_action', 'paid_usage',
               'permission_expansion', 'secret_change'] $$;
create function threadlink_private.lanes() returns text[]
language sql immutable set search_path = '' as $$ select array['chat', 'work'] $$;
-- Mirrors LANE_REASONS in lib/chat/types.ts.
create function threadlink_private.lane_reasons() returns text[]
language sql immutable set search_path = '' as $$
  select array['explicit_chat', 'explicit_work', 'small_talk', 'negated', 'edit_requested',
               'tests_requested', 'repo_action', 'repo_review', 'question', 'discussion', 'status',
               'continuation', 'default_chat', 'runtime_outdated', 'choice_answer'] $$;
create function threadlink_private.failover_policies() returns text[]
language sql immutable set search_path = '' as $$ select array['auto', 'ask', 'wait'] $$;
create function threadlink_private.session_reasons() returns text[]
language sql immutable set search_path = '' as $$
  select array['resumed', 'fresh_first_turn', 'fresh_rotated', 'fresh_resume_failed'] $$;
create function threadlink_private.timing_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['queueMs', 'spawnMs', 'contextMs', 'firstEventMs', 'providerMs', 'persistMs'] $$;
-- Unfinished Fast Chat jobs one chat may queue (the Runtime runs them FIFO).
create function threadlink_private.chat_lane_max_open_per_chat() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;
-- Runtime liveness writes from work calls (section 3.1) are throttled to this.
create function threadlink_private.runtime_touch_interval() returns interval
language sql immutable set search_path = '' as $$ select interval '10 seconds' $$;
-- Wake long-poll requests per owner per minute (section 3.2).
create function threadlink_private.runtime_wakes_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 120 $$;
-- ISO 8601 instant (the shape every Runtime timestamp uses).
create function threadlink_private.iso_instant_pattern() returns text
language sql immutable set search_path = '' as $$
  select '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' $$;

-- ---------------------------------------------------------------------------
-- 2. Owner settings (section 5): the failover preference
-- ---------------------------------------------------------------------------
create table public.user_settings (
  owner_user_id text primary key references public.users (id) on delete cascade,
  failover_policy text not null default 'auto'
    constraint user_settings_failover_policy_check check (failover_policy in ('auto', 'ask', 'wait')),
  updated_at timestamptz not null default now()
);
comment on table public.user_settings is
  'Per-owner preferences. Written only by the owner RPCs (set_failover_policy).';
alter table public.user_settings enable row level security;
revoke all on table public.user_settings from public, anon, authenticated;
grant select on table public.user_settings to authenticated;
create policy user_settings_select_own on public.user_settings for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- The owner's policy (default auto when never set).
create function threadlink_private.failover_policy_of(p_owner text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.failover_policy from public.user_settings s where s.owner_user_id = p_owner), 'auto')
$$;

-- ---------------------------------------------------------------------------
-- 3. Columns and superset constraints
-- ---------------------------------------------------------------------------
-- Jobs: the lane, the owner's failover policy at creation, the owner message
-- a Fast Chat job answers.
alter table public.team_jobs
  add column lane text not null default 'work'
    constraint team_jobs_lane_check check (lane in ('chat', 'work')),
  add column failover_policy text
    constraint team_jobs_failover_policy_check check (failover_policy in ('auto', 'ask', 'wait')),
  add column source_event_id text
    constraint team_jobs_source_event_format check (source_event_id ~ '^tlcev_[0-9a-f]{32}$');
alter table public.team_jobs drop constraint team_jobs_status_check;
alter table public.team_jobs add constraint team_jobs_status_check check (status in (
  'queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting',
  'completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled', 'interrupted', 'paused',
  'review_pending'));
alter table public.team_jobs drop constraint team_jobs_verdict_check;
alter table public.team_jobs add constraint team_jobs_verdict_check
  check (verdict in ('PASS', 'NEEDS_FIX', 'BLOCKED', 'NEEDS_USER_DECISION', 'REVIEW_PENDING'));
alter table public.team_jobs drop constraint team_jobs_verdict_status;
alter table public.team_jobs add constraint team_jobs_verdict_status check (
  (verdict is null and status not in ('completed', 'needs_fix', 'blocked', 'needs_user_decision', 'review_pending'))
  -- A Fast Chat job completes without a verdict (it reviews nothing).
  or (verdict is null and lane = 'chat' and status = 'completed')
  or (verdict = 'PASS' and status = 'completed')
  or (verdict = 'NEEDS_FIX' and status = 'needs_fix')
  or (verdict = 'BLOCKED' and status = 'blocked')
  or (verdict = 'NEEDS_USER_DECISION' and status = 'needs_user_decision')
  or (verdict = 'REVIEW_PENDING' and status = 'review_pending'));
alter table public.team_jobs drop constraint team_jobs_finished_consistency;
alter table public.team_jobs add constraint team_jobs_finished_consistency check (
  (finished_at is not null)
    = (status in ('completed', 'needs_fix', 'blocked', 'needs_user_decision', 'failed', 'cancelled',
                  'review_pending')));
alter table public.team_jobs add constraint team_jobs_chat_lane_no_verdict check (lane = 'work' or verdict is null);
alter table public.team_jobs add constraint team_jobs_chat_lane_source check (lane = 'chat' or source_event_id is null);
create index team_jobs_chat_open_idx on public.team_jobs (chat_id, lane) where finished_at is null;

-- Runs: why a native session was resumed or started fresh, and timings.
create function threadlink_private.valid_run_timings(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) e
       where not (e.key = any (array['queueMs', 'spawnMs', 'contextMs', 'firstEventMs', 'providerMs', 'persistMs']))
          or jsonb_typeof(e.value) <> 'number'
          or (e.value #>> '{}')::numeric <> pg_catalog.trunc((e.value #>> '{}')::numeric)
          or (e.value #>> '{}')::numeric not between 0 and 86400000)
$$;
alter table public.agent_runs
  add column session_reason text
    constraint agent_runs_session_reason_check check (session_reason in (
      'resumed', 'fresh_first_turn', 'fresh_rotated', 'fresh_resume_failed')),
  add column timings jsonb
    constraint agent_runs_timings_check check (timings is null or threadlink_private.valid_run_timings(timings));
-- 0.11: a run may resume a native session of an EARLIER job of the same chat
-- (Fast Chat continuity), so "resumed" no longer implies a resumed-from run of
-- this job. A resumed-from run still implies resumed/forked.
alter table public.agent_runs drop constraint agent_runs_resumed_consistency;
alter table public.agent_runs add constraint agent_runs_resumed_consistency
  check (resumed_from_run_id is null or native_session_continuity in ('resumed', 'forked'));
grant select (session_reason, timings) on table public.agent_runs to authenticated;

-- Identity is fixed at start. 0.11: the one identity change allowed is a
-- fresh run being marked as having resumed a session of an earlier job of the
-- same chat (continuity fresh -> resumed, no resumed-from run), while running.
create or replace function threadlink_private.agent_runs_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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
     or (new.native_session_continuity is distinct from old.native_session_continuity
         and not (old.native_session_continuity = 'fresh' and new.native_session_continuity = 'resumed'
                  and new.resumed_from_run_id is null and old.finished_at is null))
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

-- Provider health: when it last changed (the failover-notice dedupe window).
alter table public.runtime_provider_health add column health_changed_at timestamptz;

-- Choices: the 0.11 kinds and params (supersets).
alter table public.user_choices drop constraint user_choices_kind_check;
alter table public.user_choices add constraint user_choices_kind_check check (kind in (
  'provider_failure', 'timeout', 'plan_disagreement', 'interrupted', 'migration', 'production_deploy',
  'destructive_action', 'security_action', 'paid_usage', 'permission_expansion', 'secret_change',
  'start_work', 'usage_exhausted'));
alter table public.user_choices drop constraint user_choices_params_shape;
alter table public.user_choices add constraint user_choices_params_shape check (threadlink_private.json_shape_ok(params,
  '{"provider":"string","otherProvider":"string","step":"string","minutes":"number","nodeKey":"string",
    "sourceEventId":"string","resetsAt":"string"}'));

-- Chat rows: the failover notice.
alter table public.chat_events drop constraint chat_events_event_type_check;
alter table public.chat_events add constraint chat_events_event_type_check check (event_type in (
      'request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status', 'plan_agreed',
      'unit_status', 'finding', 'decision', 'job_verdict', 'task_started', 'task_progress', 'task_completed',
      'task_failed', 'task_cancelled', 'owner_routed', 'stop_requested', 'model_used', 'model_mismatch',
      'mode_changed', 'provider_blocked', 'code_change', 'decision_card', 'choice', 'job_summary', 'phase',
      'timeout', 'interrupted', 'control_requested', 'failover'));
create index chat_events_failover_idx on public.chat_events (chat_id, created_at desc) where event_type = 'failover';

/*
 * Structured chat payloads (superset of 0.10): owner rows (request / message)
 * may record the lane they were routed to, and the failover notice carries
 * its providers. Everything else is exactly the 0.10 rule.
 */
create or replace function threadlink_private.valid_chat_payload(p_type text, p jsonb)
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
      -- 0.11
      when 'request' then threadlink_private.json_shape_ok(p,
        '{"lane":"!string","laneReason":"string|null","choiceId":"string|null"}')
        and (p ->> 'lane') in ('chat', 'work')
      when 'message' then threadlink_private.json_shape_ok(p,
        '{"lane":"!string","laneReason":"string|null","choiceId":"string|null"}')
        and (p ->> 'lane') in ('chat', 'work')
      when 'failover' then threadlink_private.json_shape_ok(p,
        '{"from":"!string","to":"string|null","reviewPending":"!boolean","resetsAt":"string|null"}')
      else false end, false))
$$;

-- Provider detection documents: + resetsAt (null, or an ISO instant).
create or replace function threadlink_private.valid_provider_detection(p jsonb)
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
                       'currentModel', 'capabilities', 'usage', 'detectedAt',
                       'health', 'healthCheckedAt', 'healthDetail', 'resetsAt')
     )
     and p::text !~* '"[^"]*(email|org|organi[sz]ation|account|uuid|user_?id|token|secret|password|api_?key|credential|cookie)[^"]*"[[:space:]]*:'
     and p::text !~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
     and (not (p ? 'health')
          or (jsonb_typeof(p -> 'health') = 'string'
              and (p ->> 'health') = any (threadlink_private.provider_health_values())))
     and (not (p ? 'healthCheckedAt')
          or jsonb_typeof(p -> 'healthCheckedAt') = 'null'
          or (jsonb_typeof(p -> 'healthCheckedAt') = 'string'
              and (p ->> 'healthCheckedAt')
                  ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'))
     and (not (p ? 'healthDetail')
          or jsonb_typeof(p -> 'healthDetail') = 'null'
          or (jsonb_typeof(p -> 'healthDetail') = 'string'
              and (p ->> 'healthDetail') = any (threadlink_private.provider_health_details())))
     and (not (p ? 'resetsAt')
          or jsonb_typeof(p -> 'resetsAt') = 'null'
          or (jsonb_typeof(p -> 'resetsAt') = 'string'
              and (p ->> 'resetsAt')
                  ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'))
$$;

/*
 * Detection reports: 0.9/0.10 rules, plus
 *   * resetsAt is kept only with health usage_exhausted and only inside a
 *     sanity window (now - 1 h .. now + 8 days); otherwise it is stored as
 *     null (never refused, never invented);
 *   * health_changed_at moves when this computer's health for the provider
 *     changes (the failover-notice dedupe window).
 */
create or replace function public.report_provider_detection(p_token_hash text, p_provider text, p_detected jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes := threadlink_private.require_runtime(v_connection);
  v_detected jsonb := p_detected;
  v_checked timestamptz;
  v_resets timestamptz;
begin
  if p_provider is null or not (p_provider = any (threadlink_private.team_providers())) then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if jsonb_typeof(v_detected) = 'object' and v_detected ? 'healthDetail'
     and not (jsonb_typeof(v_detected -> 'healthDetail') = 'string'
              and (v_detected ->> 'healthDetail') = any (threadlink_private.provider_health_details())) then
    v_detected := jsonb_set(v_detected, '{healthDetail}', 'null'::jsonb);
  end if;
  if v_detected is null or not threadlink_private.valid_provider_detection(v_detected) then
    raise exception 'invalid detection' using errcode = '22023';
  end if;
  if jsonb_typeof(v_detected -> 'healthCheckedAt') = 'string' then
    begin
      v_checked := (v_detected ->> 'healthCheckedAt')::timestamptz;
    exception when others then
      raise exception 'invalid detection' using errcode = '22023';
    end;
    if v_checked > pg_catalog.now() + interval '5 minutes' then
      raise exception 'invalid detection' using errcode = '22023';
    end if;
  end if;
  if v_detected ? 'resetsAt' then
    v_resets := null;
    if jsonb_typeof(v_detected -> 'resetsAt') = 'string' and (v_detected ->> 'health') = 'usage_exhausted' then
      begin
        v_resets := (v_detected ->> 'resetsAt')::timestamptz;
      exception when others then
        v_resets := null;
      end;
      if v_resets < pg_catalog.now() - interval '1 hour' or v_resets > pg_catalog.now() + interval '8 days' then
        v_resets := null;
      end if;
    end if;
    v_detected := jsonb_set(v_detected, '{resetsAt}',
      case when v_resets is null then 'null'::jsonb
           else to_jsonb(pg_catalog.to_char(v_resets at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end);
  end if;
  insert into public.provider_profiles (owner_user_id, provider, detected, detected_at)
  values (v_runtime.owner_user_id, p_provider, v_detected, pg_catalog.now())
  on conflict (owner_user_id, provider) do update
    set detected = excluded.detected, detected_at = excluded.detected_at;
  insert into public.runtime_provider_health
    (runtime_id, owner_user_id, provider, detected, health, checked_at, detail, received_at, health_changed_at)
  values
    (v_runtime.id, v_runtime.owner_user_id, p_provider, v_detected,
     case when jsonb_typeof(v_detected -> 'health') = 'string' then v_detected ->> 'health' end,
     v_checked,
     case when jsonb_typeof(v_detected -> 'healthDetail') = 'string' then v_detected ->> 'healthDetail' end,
     pg_catalog.now(), pg_catalog.now())
  on conflict (runtime_id, provider) do update
    set detected = excluded.detected, health = excluded.health, checked_at = excluded.checked_at,
        detail = excluded.detail, received_at = excluded.received_at,
        health_changed_at = case when public.runtime_provider_health.health is distinct from excluded.health
                                 then pg_catalog.now()
                                 else public.runtime_provider_health.health_changed_at end;
  return threadlink_private.provider_profile_json(v_runtime.owner_user_id, p_provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Work is liveness (section 3.1): every authenticated worker call of an
--    agent session (inbox, claim, start, task heartbeat, progress, results,
--    team_job_write) refreshes its Runtime's last_seen_at, throttled.
--    Chat reads through the Runtime credential (desktop / terminal) and
--    read-only commands do not go through here and do not count.
-- ---------------------------------------------------------------------------
create function threadlink_private.runtime_touch(p_connection_id text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.runtimes
  set last_seen_at = pg_catalog.now()
  where connection_id = p_connection_id and status = 'active'
    and (last_seen_at is null or last_seen_at < pg_catalog.now() - threadlink_private.runtime_touch_interval());
$$;

create or replace function threadlink_private.require_role_session(
  p_connection public.connections,
  p_session_id text,
  p_role text
)
returns public.session_bindings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.session_bindings;
begin
  if p_connection.role <> p_role then
    raise exception '% connection required', p_role using errcode = '42501';
  end if;
  v_session := threadlink_private.require_own_session(p_connection, p_session_id);
  if not threadlink_private.session_is_usable(v_session.id) then
    raise exception 'session is not active' using errcode = '55000';
  end if;
  if p_role = 'agent' then
    perform threadlink_private.runtime_touch(p_connection.id);
  end if;
  return v_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Presence v2 (section 4) and protocol reporting
-- ---------------------------------------------------------------------------
/*
 * working       runs of this Runtime are queued/running in an unfinished job,
 *               and there was activity (the run's or the Runtime's) < 3 min ago;
 *               work is proof of life, so this wins over the age test
 * online        last seen < 75 s
 * reconnecting  75 s <= last seen < 3 min
 * offline       >= 3 min, never seen, revoked, or paused (disabled)
 */
create function threadlink_private.runtime_presence(p public.runtimes)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.id is null then null
    when p.status <> 'active' or p.paused then 'offline'
    when exists (select 1 from public.agent_runs ar join public.team_jobs j on j.id = ar.job_id
                 where ar.runtime_id = p.id and ar.status in ('queued', 'running') and j.finished_at is null
                   and greatest(coalesce(ar.last_activity_at, ar.started_at, ar.created_at),
                                coalesce(p.last_seen_at, '-infinity'::timestamptz))
                       >= pg_catalog.now() - interval '3 minutes') then 'working'
    when p.last_seen_at is null then 'offline'
    when p.last_seen_at >= pg_catalog.now() - interval '75 seconds' then 'online'
    when p.last_seen_at >= pg_catalog.now() - interval '3 minutes' then 'reconnecting'
    else 'offline' end
$$;

-- The 0.10 answer; the minimum protocol stays 10 (a 0.10 Runtime needs no update).
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
    'protocol', threadlink_private.runtime_protocol_of(r.version, r.protocol),
    'protocol_reported', r.protocol is not null,
    'min_protocol', threadlink_private.runtime_protocol_min(),
    'update_required', threadlink_private.runtime_protocol_of(r.version, r.protocol)
                       < threadlink_private.runtime_protocol_min(),
    -- 0.11
    'current_protocol', threadlink_private.runtime_protocol_current(),
    'update_available', threadlink_private.runtime_protocol_of(r.version, r.protocol)
                        < threadlink_private.runtime_protocol_current())
  from public.runtimes r where r.id = p_runtime_id
$$;

create or replace function threadlink_private.chat_api_runtime_json(p public.runtimes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'label', p.label,
    'online', threadlink_private.runtime_presence(p) in ('online', 'working'),
    'presence', threadlink_private.runtime_presence(p),
    'last_seen_at', p.last_seen_at,
    'version', p.version,
    'protocol', threadlink_private.runtime_protocol_of(p.version, p.protocol),
    'min_protocol', threadlink_private.min_protocol_for('runs'),
    'current_protocol', threadlink_private.runtime_protocol_current(),
    'update_required', threadlink_private.runtime_protocol_of(p.version, p.protocol)
                       < threadlink_private.min_protocol_for('runs'))
$$;

create or replace function public.chat_host_status(p_chat_id text)
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
  v_protocol integer;
begin
  select * into v_chat from public.chats where id = p_chat_id and owner_user_id = v_owner and deleted_at is null;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into v_room from public.rooms where id = v_chat.room_id and status <> 'deleted';
  if v_room.id is not null then
    select r.* into v_runtime from public.runtimes r
    where r.id = threadlink_private.room_runtime(v_room.id) and r.owner_user_id = v_owner;
  end if;
  v_protocol := threadlink_private.runtime_protocol_of(v_runtime.version, v_runtime.protocol);
  return jsonb_build_object(
    'chat_id', v_chat.id,
    'room_id', v_room.id,
    'now', pg_catalog.now(),
    'server_now', pg_catalog.now(),
    'runtime', case when v_runtime.id is null then null else jsonb_build_object(
      'runtime_id', v_runtime.id, 'label', v_runtime.label,
      'presence', threadlink_private.runtime_presence(v_runtime),
      'last_seen_at', v_runtime.last_seen_at,
      'protocol', v_protocol,
      'needs_update', v_protocol < threadlink_private.runtime_protocol_min(),
      'update_available', v_protocol < threadlink_private.runtime_protocol_current(),
      'fast_chat', v_protocol >= threadlink_private.min_protocol_for('chat_lane')) end,
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', a.provider,
        'name', coalesce(p.display_name, a.provider),
        'short_name', coalesce(p.short_name, a.provider),
        'health', threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at),
        'state', case
          when threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at) = 'unknown'
               and h.detected ->> 'health' = 'ready'
               and threadlink_private.provider_checked_at(h.detected, h.received_at) is not null then 'stale'
          else threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at) end,
        'checked_at', threadlink_private.provider_checked_at(h.detected, h.received_at),
        -- 0.11: when the provider said its usage resets (only when it said so).
        'resets_at', case when h.detected ->> 'health' = 'usage_exhausted'
                          and jsonb_typeof(h.detected -> 'resetsAt') = 'string'
                          then h.detected ->> 'resetsAt' end)
        order by coalesce(p.sort, 10000), a.provider)
      from public.room_agents a
      left join public.agent_providers p on p.id = a.provider
      left join public.runtime_provider_health h on h.runtime_id = v_runtime.id and h.provider = a.provider
      where a.room_id = v_room.id and a.enabled), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The health gate (section 5) and job starts with a lane
-- ---------------------------------------------------------------------------
-- The protocol of the Runtime a project runs on (0: none).
create function threadlink_private.room_protocol(p_room_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select threadlink_private.runtime_protocol_of(r.version, r.protocol)
                   from public.runtimes r
                   where r.id = threadlink_private.room_runtime(p_room_id) and r.status = 'active'), 0)
$$;

/*
 * Whether work may start with these participants' health (p_health from
 * provider_health_list):
 *   chat lane  -> at least one responder is ready (the Runtime skips the others);
 *   work lane  -> everyone ready (0.9 rule), or, on a protocol-11 Runtime: at
 *                 least one ready and every other participant only
 *                 usage_exhausted. The owner's policy is then applied by the
 *                 Runtime (auto: fail over; ask: the usage card; wait: wait),
 *                 which a post-time refusal would make impossible.
 * Nobody ready never passes.
 */
create function threadlink_private.health_gate_ok(p_owner text, p_room_id text, p_health jsonb, p_lane text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_health is null or jsonb_array_length(p_health) = 0 then false
    when p_lane = 'chat' then exists (select 1 from jsonb_array_elements(p_health) e where e ->> 'health' = 'ready')
    when threadlink_private.provider_health_ok(p_health) then true
    else threadlink_private.room_protocol(p_room_id) >= threadlink_private.min_protocol_for('failover')
         and exists (select 1 from jsonb_array_elements(p_health) e where e ->> 'health' = 'ready')
         and not exists (select 1 from jsonb_array_elements(p_health) e
                         where e ->> 'health' not in ('ready', 'usage_exhausted')) end
$$;

/*
 * team_start_job_v2 (0.9) with a lane. Differences from v2, all by lane:
 *   work: one running WORK job per chat (a Fast Chat job does not block
 *         work); the health gate allows failover (health_gate_ok).
 *   chat: may start while work runs (at most chat_lane_max_open_per_chat()
 *         unfinished chat jobs per chat); any ready responder passes the gate;
 *         no project checks; the owner's own posts skip the controller task
 *         window (the owner post rate limits apply instead).
 * The carrier gains lane, failoverPolicy and (chat) sourceEventId, responders.
 */
create function threadlink_private.team_start_job_v3(
  p_owner text,
  p_actor_connection_id text,
  p_origin text,
  p_room public.rooms,
  p_link public.thread_links,
  p_goal text,
  p_spec jsonb,
  p_max_planning_rounds integer,
  p_max_review_rounds integer,
  p_parallel_agents integer,
  p_mode text,
  p_builder text,
  p_reviewer text,
  p_task_idempotency_key text,
  p_chat_id text,
  p_role_overrides jsonb,
  p_retried_from_job_id text,
  p_lane text,
  p_source_event_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_goal text := pg_catalog.btrim(p_goal);
  v_mode text := coalesce(p_mode, 'team');
  v_lane text := coalesce(p_lane, 'work');
  v_policy text := threadlink_private.failover_policy_of(p_owner);
  v_who jsonb;
  v_builder text;
  v_reviewer text;
  v_participants text[];
  v_health jsonb;
  v_chat public.chats;
  v_chat_id text;
  v_planning integer := least(greatest(coalesce(p_max_planning_rounds, p_room.max_planning_rounds), 1), 5);
  v_review integer := least(greatest(coalesce(p_max_review_rounds, p_room.max_review_rounds), 1), 6);
  v_parallel integer := least(greatest(coalesce(p_parallel_agents, p_room.parallel_agents), 1), 4);
  v_verify text[] := p_room.verify_commands;
  v_paid boolean;
  v_job_id text := threadlink_private.generate_id('tljob');
  v_task_id text;
  v_content jsonb;
  v_existing text;
  v_open integer;
  v_recent integer;
begin
  if not (v_lane = any (threadlink_private.lanes())) then
    raise exception 'invalid lane' using errcode = '22023', hint = 'invalid';
  end if;
  if v_lane = 'work' and p_source_event_id is not null then
    raise exception 'invalid source' using errcode = '22023', hint = 'invalid';
  end if;
  if p_task_idempotency_key is not null then
    select id into v_task_id from public.tasks
    where owner_user_id = p_owner and origin_session_id = p_link.controller_session_id
      and idempotency_key = p_task_idempotency_key;
    if v_task_id is not null then
      select id into v_existing from public.team_jobs where task_id = v_task_id and owner_user_id = p_owner;
      if v_existing is null then
        raise exception 'idempotency key already used' using errcode = '55000';
      end if;
      return threadlink_private.team_status_json(v_existing) || jsonb_build_object('created', false);
    end if;
  end if;

  if p_room.status <> 'active' then
    raise exception 'room is not active' using errcode = '55000', hint = 'room_inactive';
  end if;
  if v_goal is null or octet_length(v_goal) not between 1 and 8000 then
    raise exception 'invalid goal' using errcode = '22023', hint = 'invalid_goal';
  end if;
  if p_spec is not null and not threadlink_private.valid_team_spec(p_spec) then
    raise exception 'invalid spec' using errcode = '22023';
  end if;
  if not (v_mode = any (array['solo', 'pair', 'team'])) then
    raise exception 'invalid mode' using errcode = '22023', hint = 'invalid_mode';
  end if;
  if p_builder is not null and not (p_builder = any (threadlink_private.team_providers())) then
    raise exception 'invalid builder' using errcode = '22023', hint = 'invalid_builder';
  end if;
  if p_reviewer is not null and not (p_reviewer = any (threadlink_private.team_providers())) then
    raise exception 'invalid reviewer' using errcode = '22023', hint = 'invalid_builder';
  end if;
  if not threadlink_private.valid_verify_commands(v_verify) then
    raise exception 'invalid verify commands' using errcode = '22023';
  end if;
  if not threadlink_private.valid_role_overrides(p_role_overrides) then
    raise exception 'invalid role overrides' using errcode = '22023', hint = 'invalid_roles';
  end if;
  -- Review cannot be bypassed by a controller asking for solo WORK. A Fast
  -- Chat answer changes nothing, so it is not work that needs review.
  if v_lane = 'work' and v_mode = 'solo' and p_origin <> 'owner' and p_room.cross_review then
    raise exception 'This project requires review; use Builder + Reviewer or Team'
      using errcode = '42501', hint = 'review_required';
  end if;

  v_chat_id := coalesce(p_chat_id, threadlink_private.room_default_chat(p_room.id));
  if v_chat_id is null then
    raise exception 'chat limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  select * into v_chat from public.chats where id = v_chat_id for update;
  if not found or v_chat.owner_user_id <> p_owner or v_chat.deleted_at is not null
     or v_chat.room_id is distinct from p_room.id then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  if v_lane = 'work' then
    if not (p_origin = 'controller' and p_chat_id is null)
       and exists (select 1 from public.team_jobs
                   where chat_id = v_chat.id and finished_at is null and lane = 'work') then
      raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
    end if;
  else
    if (select count(*) from public.team_jobs where chat_id = v_chat.id and finished_at is null and lane = 'chat')
       >= threadlink_private.chat_lane_max_open_per_chat() then
      raise exception 'too many replies waiting in this chat' using errcode = '54000', hint = 'rate_limited';
    end if;
    if p_source_event_id is not null and not exists (
         select 1 from public.chat_events e
         where e.id = p_source_event_id and e.owner_user_id = p_owner and e.chat_id = v_chat.id
           and e.author_kind in ('owner', 'controller') and e.event_type in ('request', 'message')) then
      raise exception 'invalid source' using errcode = '22023', hint = 'invalid';
    end if;
  end if;

  v_who := threadlink_private.team_participants(p_owner, p_room.id, v_mode, p_builder, p_reviewer);
  v_builder := v_who ->> 'builder';
  v_reviewer := v_who ->> 'reviewer';
  select coalesce(array_agg(value order by ord), '{}') into v_participants
  from jsonb_array_elements_text(v_who -> 'participants') with ordinality as x(value, ord);

  if p_role_overrides is not null and exists (
       select 1 from jsonb_each_text(p_role_overrides) e where not (e.value = any (v_participants))) then
    raise exception 'a role override names an agent not in this job' using errcode = '22023',
      hint = 'invalid_roles';
  end if;

  perform threadlink_private.team_route_check(p_owner, p_room, p_link, v_mode);
  if v_lane = 'chat' and threadlink_private.room_protocol(p_room.id) < threadlink_private.min_protocol_for('chat_lane') then
    raise exception 'ThreadLink on this computer needs an update for Fast Chat'
      using errcode = '55000', hint = 'runtime_outdated';
  end if;

  v_health := threadlink_private.provider_health_list(p_room.id, v_participants);
  if not threadlink_private.health_gate_ok(p_owner, p_room.id, v_health, v_lane) then
    raise exception 'an agent this job needs is not ready'
      using errcode = '55000', hint = 'provider_unhealthy',
            detail = threadlink_private.provider_health_detail(v_health);
  end if;

  select coalesce(bool_and(coalesce(pp.paid_usage_enabled, false)), false) into v_paid
  from unnest(v_participants) p(provider)
  left join public.provider_profiles pp on pp.owner_user_id = p_owner and pp.provider = p.provider;

  if v_lane = 'chat' then
    v_verify := '{}';
  end if;
  v_content := jsonb_build_object(
    'kind', 'threadlink.team_job',
    'version', 1,
    'jobId', v_job_id,
    'roomId', p_room.id,
    'roomName', p_room.name,
    'goal', v_goal,
    'spec', coalesce(p_spec, '{}'::jsonb),
    'mode', v_mode,
    'builder', v_builder,
    'reviewer', v_reviewer,
    'origin', p_origin,
    'chatId', v_chat.id,
    'participants', to_jsonb(v_participants),
    'roleOverrides', coalesce(p_role_overrides, '{}'::jsonb),
    'budgets', jsonb_build_object(
      'maxPlanningRounds', v_planning, 'maxReviewRounds', v_review, 'parallelAgents', v_parallel),
    'policy', jsonb_build_object(
      'usagePolicy', p_room.usage_policy,
      'paidUsage', v_paid,
      'crossReview', p_room.cross_review,
      'finalInspection', p_room.final_inspection,
      'worktreeIsolation', p_room.worktree_isolation,
      'overrides', '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', a.provider, 'displayName', a.display_name, 'roles', to_jsonb(a.default_roles))
        order by a.provider)
      from public.room_agents a
      where a.room_id = p_room.id and a.enabled and a.provider = any (v_participants)), '[]'::jsonb),
    'verifyCommands', to_jsonb(v_verify),
    -- 0.11 (section 2): a 0.10 Runtime never receives a chat-lane carrier.
    'lane', v_lane,
    'failoverPolicy', v_policy
  );
  if v_lane = 'chat' then
    v_content := v_content || jsonb_build_object('sourceEventId', p_source_event_id,
                                                 'responders', to_jsonb(v_participants));
  end if;
  if octet_length(v_content::text) > 65536 then
    raise exception 'team job is too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:tasks:' || p_link.id, 0));
  select count(*) into v_open from public.tasks
  where thread_link_id = p_link.id and status in ('queued', 'claimed', 'working');
  if v_open >= threadlink_private.max_open_tasks_per_link() then
    raise exception 'open task limit reached for this link' using errcode = '54000', hint = 'rate_limited';
  end if;
  if not (v_lane = 'chat' and p_origin = 'owner') then
    select count(*) into v_recent from public.tasks
    where origin_session_id = p_link.controller_session_id
      and created_at > pg_catalog.now() - threadlink_private.task_rate_window();
    if v_recent >= threadlink_private.max_tasks_per_window() then
      raise exception 'task creation rate limit reached' using errcode = '54000', hint = 'rate_limited';
    end if;
  end if;

  perform pg_catalog.set_config('threadlink.creating_team_job', 'on', true);
  insert into public.tasks
    (owner_user_id, thread_link_id, origin_session_id, target_session_id,
     priority, task_type, title, content, idempotency_key, expires_at)
  values
    (p_owner, p_link.id, p_link.controller_session_id, p_link.agent_session_id,
     -- A Fast Chat reply goes ahead of queued work.
     case when v_lane = 'chat' then 'B' else 'C' end, 'team',
     pg_catalog.left(pg_catalog.regexp_replace(v_goal, '[[:space:]]+', ' ', 'g'), 255),
     v_content::text, p_task_idempotency_key,
     pg_catalog.now() + case when v_lane = 'chat' then interval '1 day' else interval '604800 seconds' end)
  returning id into v_task_id;
  perform pg_catalog.set_config('threadlink.creating_team_job', '', true);

  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id, message_type)
  values
    (p_owner, v_task_id, p_link.id, p_link.controller_session_id, p_link.agent_session_id, 'task');
  perform threadlink_private.record_event(
    p_owner, p_actor_connection_id, 'task.created', 'task', v_task_id,
    jsonb_build_object('thread_link_id', p_link.id));

  insert into public.team_jobs
    (id, owner_user_id, room_id, task_id, goal, spec_input,
     max_planning_rounds, max_review_rounds, parallel_agents, verify_commands, mode, builder_provider, origin,
     chat_id, role_overrides, retried_from_job_id, lane, failover_policy, source_event_id)
  values
    (v_job_id, p_owner, p_room.id, v_task_id, v_goal, p_spec,
     v_planning, v_review, v_parallel, v_verify, v_mode, v_builder, p_origin,
     v_chat.id, p_role_overrides, p_retried_from_job_id, v_lane, v_policy, p_source_event_id);

  perform threadlink_private.record_event(
    p_owner, p_actor_connection_id, 'team.job_started', 'team_job', v_job_id,
    jsonb_build_object('room_id', p_room.id, 'task_id', v_task_id, 'mode', v_mode, 'origin', p_origin,
                       'chat_id', v_chat.id, 'lane', v_lane));
  return threadlink_private.team_status_json(v_job_id) || jsonb_build_object('created', true);
end;
$$;

-- The 0.9 entry point: a work-lane start (same signature, grants preserved).
create or replace function threadlink_private.team_start_job_v2(
  p_owner text,
  p_actor_connection_id text,
  p_origin text,
  p_room public.rooms,
  p_link public.thread_links,
  p_goal text,
  p_spec jsonb,
  p_max_planning_rounds integer,
  p_max_review_rounds integer,
  p_parallel_agents integer,
  p_mode text,
  p_builder text,
  p_reviewer text,
  p_task_idempotency_key text,
  p_chat_id text,
  p_role_overrides jsonb,
  p_retried_from_job_id text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_v3(
    p_owner, p_actor_connection_id, p_origin, p_room, p_link, p_goal, p_spec, p_max_planning_rounds,
    p_max_review_rounds, p_parallel_agents, p_mode, p_builder, p_reviewer, p_task_idempotency_key, p_chat_id,
    p_role_overrides, p_retried_from_job_id, 'work', null)
$$;

-- ---------------------------------------------------------------------------
-- 7. Job rows: a Fast Chat job narrates nothing (no "job started", phases,
--    verdict or summary); REVIEW_PENDING reads as "Work complete · review
--    pending"; the new columns are part of a job's fixed identity.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.team_jobs_guard_update()
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
     or new.mode is distinct from old.mode
     or new.builder_provider is distinct from old.builder_provider
     or new.origin is distinct from old.origin
     or new.chat_id is distinct from old.chat_id
     or new.role_overrides is distinct from old.role_overrides
     or new.retried_from_job_id is distinct from old.retried_from_job_id
     or new.lane is distinct from old.lane
     or new.failover_policy is distinct from old.failover_policy
     or new.source_event_id is distinct from old.source_event_id
     or new.created_at is distinct from old.created_at then
    raise exception 'team job identity and budgets are immutable' using errcode = '42501';
  end if;
  if old.stop_requested_at is not null and new.stop_requested_at is distinct from old.stop_requested_at then
    raise exception 'a stop request cannot be withdrawn' using errcode = '42501';
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

create or replace function threadlink_private.chat_on_job_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_builder text := threadlink_private.chat_provider_label(new.builder_provider);
  v_other text := threadlink_private.chat_provider_label(
    case new.builder_provider when 'claude-code' then 'codex' when 'codex' then 'claude-code' end);
begin
  begin
    select * into v_task from public.tasks where id = new.task_id;
    -- 0.11: the controller's Fast Chat path writes its own request row first
    -- (so the carrier can name it); every other controller start as before.
    if new.origin = 'controller'
       and coalesce(pg_catalog.current_setting('threadlink.controller_request_written', true), '') <> 'on' then
      perform threadlink_private.chat_write(
        new.owner_user_id, new.room_id, v_task.target_session_id, new.id, new.task_id, null, 'controller', null,
        threadlink_private.chat_controller_label(v_task.origin_session_id), null, 'team',
        'request', null, null, null, null, new.goal, 2000, 'visible');
    end if;
    if new.lane = 'chat' then
      return null;
    end if;
    perform threadlink_private.chat_job_event(new, 'job_started',
      case new.mode
        when 'solo' then 'Solo job started: ' || v_builder || ' is working on it.'
        when 'pair' then 'Builder + Reviewer started: ' || v_builder || ' builds, ' || v_other || ' reviews.'
        else 'Team Mode started: the team will plan, build and review this together.' end,
      'visible');
  exception when others then
    raise warning 'threadlink chat: job start not recorded (%)', sqlstate;
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
    when 'review_pending' then 'Work complete · review pending'
    else p_status end
$$;

-- The verdict as words: REVIEW_PENDING is never shown as a code.
create function threadlink_private.verdict_words(p_verdict text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_verdict when 'REVIEW_PENDING' then 'Work complete · review pending' else p_verdict end
$$;

create or replace function threadlink_private.job_summary_text(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Summary: ' || threadlink_private.verdict_words(p ->> 'verdict') || '.'
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
  -- A finished job: runs still open are cancelled and pending choices lapse,
  -- except a Fast Chat "Run this as work?" question, which outlives the reply.
  if new.finished_at is not null and old.finished_at is null then
    begin
      update public.agent_runs
      set status = 'cancelled', failure = coalesce(failure, 'cancelled'), finished_at = pg_catalog.now()
      where job_id = new.id and status in ('queued', 'running');
      update public.user_choices set status = 'cancelled'
      where job_id = new.id and status = 'pending' and kind <> 'start_work';
    exception when others then
      raise warning 'threadlink: open runs/choices not closed (%)', sqlstate;
    end;
  end if;
  -- 0.11: a Fast Chat job writes no milestones; only a failure is said, once.
  if new.lane = 'chat' then
    begin
      if new.status = 'failed' and old.status is distinct from 'failed' then
        perform threadlink_private.chat_job_event(new, 'job_status', 'The agents could not reply.', 'visible');
      end if;
    exception when others then
      raise warning 'threadlink chat: job update not recorded (%)', sqlstate;
    end;
    return null;
  end if;
  begin
    if old.stop_requested_at is null and new.stop_requested_at is not null then
      perform threadlink_private.chat_job_event(new, 'stop_requested',
        'Stop requested. The team will finish the current round and stop.', 'visible');
    end if;
    if new.verdict is not null and old.verdict is null then
      perform threadlink_private.chat_job_event(new, 'job_verdict',
        'Result: ' || threadlink_private.verdict_words(new.verdict)
        || case when new.verdict = 'REVIEW_PENDING'
                then E'\n' || coalesce(threadlink_private.chat_provider_label(new.verdict_provider) || '''s',
                                       'The reviewer''s')
                     || ' included usage ran out, so its independent review has not happened yet. No paid usage was used.'
                when new.verdict_reason is not null and new.verdict <> 'PASS'
                then E'\n' || coalesce(
                  threadlink_private.chat_provider_reason_text(new.verdict_reason, new.verdict_provider),
                  threadlink_private.chat_reason_text(new.verdict_reason))
                when new.stop_requested_at is not null and new.verdict = 'NEEDS_USER_DECISION'
                then E'\nStopped by you.' else '' end
        -- Who built and who reviewed come only from completed runs of this
        -- job, never from its intended roles: after a failover, or when
        -- nothing ran, the intended roles would claim work that never happened.
        || E'\n' || case new.mode
             when 'solo' then 'Solo job' || coalesce(': ' || threadlink_private.chat_provider_label(
                                (select ar.provider from public.agent_runs ar where ar.job_id = new.id
                                   and ar.role = 'builder' and ar.status = 'completed'
                                 order by ar.finished_at desc nulls last limit 1)) || ' built it, with no reviewer.', '.')
             when 'pair' then 'Builder + Reviewer' || coalesce(': ' || threadlink_private.chat_provider_label(
                                (select ar.provider from public.agent_runs ar where ar.job_id = new.id
                                   and ar.role = 'builder' and ar.status = 'completed'
                                 order by ar.finished_at desc nulls last limit 1)) || ' built it'
                              || coalesce(', ' || threadlink_private.chat_provider_label(
                                   (select ar.provider from public.agent_runs ar where ar.job_id = new.id
                                      and ar.role = 'reviewer' and ar.status = 'completed'
                                    order by ar.finished_at desc nulls last limit 1)) || ' reviewed it.',
                                 case when new.verdict = 'REVIEW_PENDING' then '; the independent review is pending.'
                                      else '.' end), '.')
             else 'Team Mode job.' end
        || case when cardinality(new.verify_commands) = 0 then ' No project checks are set.'
                else ' Project checks: ' || cardinality(new.verify_commands) || '.' end,
        'visible');
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
      if threadlink_private.chat_phase_of(new.status) is not null
         and threadlink_private.chat_phase_of(new.status)
             is distinct from threadlink_private.chat_phase_of(old.status)
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

-- Team status: + lane and failover policy (every team_job_write answer).
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
    'finished_at', j.finished_at,
    -- 0.11
    'lane', j.lane,
    'failover_policy', j.failover_policy
  )
  from public.team_jobs j
  join public.rooms r on r.id = j.room_id
  join public.tasks t on t.id = j.task_id
  where j.id = p_job_id
$$;

-- ---------------------------------------------------------------------------
-- 8. Choices (sections 2.5, 5, 6): the 0.11 kinds, one decide path for the
--    card (decide_choice) and for natural answers (chat_post), and "Run this
--    as work" starting a work job from the original owner message.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.choice_options(p_kind text, p_params jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with v as (
    select coalesce(threadlink_private.provider_label(p_params ->> 'provider'), 'the agent') as who,
           threadlink_private.provider_label(p_params ->> 'otherProvider') as other,
           coalesce((select p.short_name from public.agent_providers p where p.id = p_params ->> 'provider'),
                    'the agent') as who_short,
           (select p.short_name from public.agent_providers p where p.id = p_params ->> 'otherProvider') as other_short
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
      -- 0.11
      (12, case when p_kind = 'start_work' then 'run_work' end, 'Run this as work'),
      (13, case when p_kind = 'start_work' then 'keep_chatting' end, 'Keep chatting'),
      (14, case when p_kind = 'usage_exhausted' and v.other_short is not null then 'continue_other' end,
           'Continue with ' || v.other_short),
      (15, case when p_kind = 'usage_exhausted' then 'check_again' end, 'Check ' || v.who_short || ' again'),
      (16, case when p_kind = 'usage_exhausted' then 'wait' end, 'Wait for ' || v.who_short),
      (17, case when p_kind in ('provider_failure', 'timeout', 'plan_disagreement', 'interrupted',
                                'usage_exhausted') then 'stop' end,
           'Stop')
    ) as x(ord, key, label)
    where x.key is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', o.key, 'label', o.label) order by o.ord), '[]'::jsonb) from o
$$;

create or replace function threadlink_private.choice_title(p_kind text, p_params jsonb)
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
    -- 0.11
    when 'start_work' then 'This looks like repository work. Run it as work?'
    when 'usage_exhausted' then
      coalesce((select p.short_name from public.agent_providers p where p.id = p_params ->> 'provider'), 'An agent')
      || ' usage is exhausted. What should ThreadLink do?'
  end
$$;

/*
 * The provider-failure options a Runtime may offer, minus "Retry <provider>"
 * while that provider's usage is exhausted on the job's computer (retrying
 * the same exhausted agent helps nobody, section 5).
 */
create function threadlink_private.choice_options_now(p_job public.team_jobs, p_kind text, p_params jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_kind = 'provider_failure' and p_params ->> 'provider' is not null
         and exists (select 1 from public.runtime_provider_health h
                     where h.runtime_id = threadlink_private.room_runtime(p_job.room_id)
                       and h.provider = p_params ->> 'provider'
                       and threadlink_private.provider_effective_health(h.provider, h.detected, h.received_at)
                           = 'usage_exhausted')
    then coalesce((select jsonb_agg(o order by ord)
                   from jsonb_array_elements(threadlink_private.choice_options(p_kind, p_params))
                        with ordinality as x(o, ord)
                   where o ->> 'key' <> 'retry'), '[]'::jsonb)
    else threadlink_private.choice_options(p_kind, p_params) end
$$;

/*
 * Starts WORK from an owner message of this chat (the source of a
 * "Run this as work?" choice). Routed like the owner composer: a leading
 * @mention picks the agent, otherwise the chat's mode. Nobody ready -> the
 * provider_blocked row, no job (0.9 behaviour). Returns {routed, job_id}.
 */
create function threadlink_private.chat_start_work_from_event(p_owner text, p_chat_id text, p_event_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chat public.chats;
  v_room public.rooms;
  v_event public.chat_events;
  v_link public.thread_links;
  v_match text[];
  v_mention text;
  v_goal text;
  v_mode text;
  v_builder text;
  v_reviewer text;
  v_who jsonb;
  v_participants text[];
  v_health jsonb;
  v_status jsonb;
begin
  select * into v_chat from public.chats where id = p_chat_id and owner_user_id = p_owner and deleted_at is null;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into v_event from public.chat_events
  where id = p_event_id and owner_user_id = p_owner and chat_id = v_chat.id
    and author_kind = 'owner' and event_type in ('request', 'message');
  if not found then
    raise exception 'invalid source' using errcode = '22023', hint = 'invalid';
  end if;
  select * into v_room from public.rooms where id = v_chat.room_id and owner_user_id = p_owner and status <> 'deleted';
  if not found then
    raise exception 'Choose a project for this chat so the agents know which folder to work in'
      using errcode = '55000', hint = 'needs_project';
  end if;
  if exists (select 1 from public.team_jobs where chat_id = v_chat.id and finished_at is null and lane = 'work') then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;
  v_match := pg_catalog.regexp_match(v_event.body, '^(@(claude-code|claude|codex|team)([[:space:],:;.!]+|$))', 'i');
  if v_match is not null then
    v_mention := case lower(v_match[2]) when 'claude' then 'claude-code' else lower(v_match[2]) end;
    v_goal := pg_catalog.btrim(substr(v_event.body, char_length(v_match[1]) + 1), E' \n\t');
  else
    v_goal := v_event.body;
  end if;
  if v_goal is null or v_goal = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if v_mention in ('claude-code', 'codex') then
    v_mode := 'solo';
    v_builder := v_mention;
  elsif v_mention = 'team' then
    v_mode := 'team';
  else
    v_mode := v_chat.mode;
    if v_mode = 'solo' then
      v_builder := v_chat.solo_provider;
    elsif v_mode = 'pair' then
      v_builder := v_chat.builder_provider;
      v_reviewer := v_chat.reviewer_provider;
    end if;
  end if;
  v_who := threadlink_private.team_participants(p_owner, v_room.id, v_mode, v_builder, v_reviewer);
  v_builder := v_who ->> 'builder';
  v_reviewer := v_who ->> 'reviewer';
  select coalesce(array_agg(value order by ord), '{}') into v_participants
  from jsonb_array_elements_text(v_who -> 'participants') with ordinality as x(value, ord);
  select * into v_link from public.thread_links
  where owner_user_id = p_owner and agent_session_id = v_room.agent_session_id and status = 'active'
  order by approved_at desc nulls last, created_at desc
  limit 1
  for share;
  if not found or not threadlink_private.session_is_usable(v_link.agent_session_id)
     or not threadlink_private.session_is_usable(v_link.controller_session_id) then
    raise exception 'this project is not linked any more' using errcode = '55000', hint = 'route_missing';
  end if;
  perform threadlink_private.team_route_check(p_owner, v_room, v_link, v_mode);
  v_health := threadlink_private.provider_health_list(v_room.id, v_participants);
  if not threadlink_private.health_gate_ok(p_owner, v_room.id, v_health, 'work') then
    perform threadlink_private.chat_note(v_chat, v_room.id, 'provider_blocked',
      threadlink_private.provider_health_text(v_health));
    return jsonb_build_object('routed', 'provider_blocked', 'job_id', null, 'health', v_health);
  end if;
  v_status := threadlink_private.team_start_job_v3(
    p_owner, null, 'owner', v_room, v_link, v_goal, null, null, null, null, v_mode, v_builder, v_reviewer,
    null, v_chat.id, null, null, 'work', null);
  return jsonb_build_object('routed', 'new_job', 'job_id', v_status ->> 'job_id');
end;
$$;

/*
 * The one decide path. p_chat_id (when given) must be the choice's chat.
 * p_natural = answered by typing (never an approval kind: those need the
 * card). A start_work choice outlives its (finished) Fast Chat job; every
 * other kind needs its job still running. Returns choice_json + {chosen_label,
 * started: {routed, job_id} | null}.
 */
create function threadlink_private.choice_decide(
  p_owner text, p_choice_id text, p_key text, p_chat_id text, p_natural boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.user_choices;
  v_job public.team_jobs;
  v_label text;
  v_started jsonb;
begin
  if p_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_choice_id is null or p_choice_id !~ '^tlchc_[0-9a-f]{32}$' then
    raise exception 'choice not found' using errcode = 'P0002', hint = 'choice_not_found';
  end if;
  select * into v from public.user_choices where id = p_choice_id and owner_user_id = p_owner for update;
  if not found
     or (p_chat_id is not null and v.chat_id is distinct from p_chat_id)
     or exists (select 1 from public.chats c where c.id = v.chat_id and c.deleted_at is not null)
     or exists (select 1 from public.team_jobs j join public.rooms r on r.id = j.room_id
                where j.id = v.job_id and r.status = 'deleted') then
    raise exception 'choice not found' using errcode = 'P0002', hint = 'choice_not_found';
  end if;
  if p_natural and v.kind = any (threadlink_private.approval_choice_kinds()) then
    raise exception 'this choice needs its card' using errcode = '42501', hint = 'choice_needs_card';
  end if;
  if v.status = 'chosen' and v.chosen_key is not distinct from p_key then
    return threadlink_private.choice_json(v.id)
      || jsonb_build_object('replayed', true, 'started', null,
                            'chosen_label', (select o ->> 'label' from jsonb_array_elements(v.options) o
                                             where o ->> 'key' = p_key limit 1));
  end if;
  if v.status <> 'pending' then
    raise exception 'this choice is closed' using errcode = '55000', hint = 'choice_closed';
  end if;
  if v.expires_at < pg_catalog.now() then
    raise exception 'this choice has expired' using errcode = '55000', hint = 'choice_expired';
  end if;
  if v.job_id is not null then
    select * into v_job from public.team_jobs where id = v.job_id;
    if v_job.finished_at is not null and v.kind <> 'start_work' then
      raise exception 'this choice is closed' using errcode = '55000', hint = 'choice_closed';
    end if;
  end if;
  if p_key is null or p_key !~ '^[a-z_]{1,40}$'
     or not (v.options @> jsonb_build_array(jsonb_build_object('key', p_key))) then
    raise exception 'that is not one of the options' using errcode = '22023', hint = 'invalid_choice';
  end if;
  perform threadlink_private.owner_rate_limit(p_owner, 'choice_decide', 30);
  update public.user_choices
  set status = 'chosen', chosen_key = p_key, decided_at = pg_catalog.now(), decided_by = p_owner
  where id = v.id;
  select o ->> 'label' into v_label from jsonb_array_elements(v.options) o where o ->> 'key' = p_key;
  if v_job.id is not null then
    perform threadlink_private.chat_card(v_job, 'threadlink', null, 'choice', 'You chose: ' || v_label || '.',
      'visible',
      jsonb_build_object('choiceId', v.id, 'kind', v.kind, 'status', 'chosen', 'options', v.options,
                         'chosenKey', p_key, 'expiresAt', v.expires_at),
      null, 'choice', v.id);
  end if;
  perform threadlink_private.record_event(p_owner, null, 'team.choice_decided', 'user_choice', v.id,
    jsonb_build_object('job_id', v.job_id, 'kind', v.kind, 'key', p_key, 'natural', p_natural));
  if v.kind = 'start_work' and p_key = 'run_work' then
    v_started := threadlink_private.chat_start_work_from_event(p_owner, v.chat_id, v.params ->> 'sourceEventId');
  end if;
  return threadlink_private.choice_json(v.id)
    || jsonb_build_object('chosen_label', v_label, 'started', v_started);
end;
$$;

-- The owner answers a choice on its card (0.10 contract, same signature).
create or replace function public.decide_choice(p_choice_id text, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return threadlink_private.choice_decide(threadlink_private.require_owner(), p_choice_id, p_key, null, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Owner posts with a lane (section 2.3). The TS layer classifies the
--    message (lib/chat/intent.ts) and, for web / desktop / terminal, matches
--    a natural answer to an open choice (lib/chat/choice-intent.ts); SQL
--    re-checks everything. Precedence:
--      1. "@team stop"   -> stop the running work job AND every running Fast
--                           Chat job of this chat
--      2. p_choice_id    -> resolve that choice (pending, this chat, not an
--                           approval kind); the message is stored, no new job.
--                           A choice that cannot be resolved is ignored and the
--                           message routes normally.
--      3. work + running work job -> a note to it (0.10)
--      4. work           -> a new work job (0.10 path, failover-aware gate)
--      5. chat           -> a new Fast Chat job, even while work runs
--    A chat-lane post to a project whose Runtime is older than protocol 11 is
--    downgraded to work (laneReason runtime_outdated).
-- ---------------------------------------------------------------------------
create function threadlink_private.chat_post_v11(
  p_owner text,
  p_chat_id text,
  p_body text,
  p_idempotency_key text,
  p_lane text,
  p_lane_reason text,
  p_choice_id text,
  p_choice_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chat public.chats;
  v_room public.rooms;
  v_room_id text;
  v_has_room boolean := false;
  v_prev public.chat_events;
  v_match text[];
  v_mention text;
  v_rest text;
  v_body text;
  v_job public.team_jobs;
  v_link public.thread_links;
  v_mode text;
  v_builder text;
  v_reviewer text;
  v_audience text;
  v_event_id text;
  v_status jsonb;
  v_agents text[];
  v_who jsonb;
  v_participants text[];
  v_health jsonb;
  v_session text;
  v_lane text := p_lane;
  v_reason text := p_lane_reason;
  v_choice public.user_choices;
  v_decided jsonb;
  v_stopped integer := 0;
  v_first_chat_job text;
begin
  if p_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  if v_lane is null or not (v_lane = any (threadlink_private.lanes())) then
    raise exception 'invalid lane' using errcode = '22023', hint = 'invalid';
  end if;
  if v_reason is not null and not (v_reason = any (threadlink_private.lane_reasons())) then
    raise exception 'invalid lane reason' using errcode = '22023', hint = 'invalid';
  end if;
  if (p_choice_id is null) <> (p_choice_key is null)
     or (p_choice_id is not null and p_choice_id !~ '^tlchc_[0-9a-f]{32}$')
     or (p_choice_key is not null and p_choice_key !~ '^[a-z_]{1,40}$') then
    raise exception 'invalid choice' using errcode = '22023', hint = 'invalid';
  end if;
  select room_id into v_room_id from public.chats
  where id = p_chat_id and owner_user_id = p_owner and deleted_at is null;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  if v_room_id is not null then
    select * into v_room from public.rooms where id = v_room_id and owner_user_id = p_owner for update;
    v_has_room := found and v_room.status <> 'deleted';
  end if;
  select * into v_chat from public.chats
  where id = p_chat_id and owner_user_id = p_owner and deleted_at is null
  for update;
  if not found or v_chat.room_id is distinct from v_room_id then
    raise exception 'chat changed' using errcode = '55000', hint = 'conflict';
  end if;

  -- Replay: the same key returns the first answer and changes nothing.
  if p_idempotency_key is not null then
    select * into v_prev from public.chat_events
    where owner_user_id = p_owner and idempotency_key = p_idempotency_key;
    if found then
      if v_prev.chat_id is distinct from v_chat.id then
        raise exception 'idempotency key already used' using errcode = '55000', hint = 'idempotency_conflict';
      end if;
      return jsonb_build_object(
        'routed', case when v_prev.payload ->> 'choiceId' is not null then 'choice_resolved'
                       when v_prev.event_type = 'request' and v_prev.job_id is null then 'provider_blocked'
                       when v_prev.event_type = 'request'
                            and (select j.lane from public.team_jobs j where j.id = v_prev.job_id) = 'chat'
                            then 'chat_job'
                       when v_prev.event_type = 'request' then 'new_job'
                       when v_prev.body ~* threadlink_private.chat_stop_pattern() then 'stop_requested'
                       else 'note_to_active_job' end,
        'job_id', v_prev.job_id, 'event_id', v_prev.id, 'chat_id', v_chat.id, 'replayed', true,
        'lane', coalesce(v_prev.payload ->> 'lane', 'work'), 'lane_reason', v_prev.payload ->> 'laneReason');
    end if;
  end if;

  if v_has_room and v_room.status <> 'active' then
    raise exception 'room is not active' using errcode = '55000', hint = 'room_inactive';
  end if;
  if p_body is null or pg_catalog.btrim(p_body) = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if char_length(p_body) > threadlink_private.chat_owner_max_chars() then
    raise exception 'message too long' using errcode = '22023', hint = 'too_long';
  end if;
  if (select count(*) from public.chat_events
      where chat_id = v_chat.id and author_kind = 'owner'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_owner_posts_per_minute()
     or (v_has_room and (select count(*) from public.chat_events
                         where room_id = v_room.id and author_kind = 'owner'
                           and created_at > pg_catalog.now() - interval '1 minute')
                        >= threadlink_private.chat_owner_posts_per_minute()) then
    raise exception 'too many messages' using errcode = '54000', hint = 'rate_limited';
  end if;
  if (select count(*) from public.chat_events
      where owner_user_id = p_owner and author_kind = 'owner'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_owner_posts_per_minute_total() then
    raise exception 'too many messages' using errcode = '54000', hint = 'rate_limited';
  end if;

  v_body := threadlink_private.chat_clean(p_body, threadlink_private.chat_owner_max_chars());
  if v_body is null then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  v_match := pg_catalog.regexp_match(v_body, '^(@(claude-code|claude|codex|team)([[:space:],:;.!]+|$))', 'i');
  if v_match is not null then
    v_mention := case lower(v_match[2]) when 'claude' then 'claude-code' else lower(v_match[2]) end;
    v_rest := pg_catalog.btrim(substr(v_body, char_length(v_match[1]) + 1), E' \n\t');
  else
    v_rest := v_body;
  end if;

  -- Protocol gate: a Runtime before 0.11 would run a chat message as the full
  -- engineering pipeline, so it gets work (and the owner row says why).
  if v_lane = 'chat' and v_has_room
     and threadlink_private.room_protocol(v_room.id) < threadlink_private.min_protocol_for('chat_lane') then
    v_lane := 'work';
    v_reason := 'runtime_outdated';
  end if;

  -- The running work job of THIS chat (notes and the stop request go there).
  select * into v_job from public.team_jobs
  where chat_id = v_chat.id and owner_user_id = p_owner and finished_at is null and lane = 'work'
  order by created_at desc
  limit 1
  for update;

  -- 1. Stop: the work job and every Fast Chat job still going.
  if v_body ~* threadlink_private.chat_stop_pattern() then
    select id into v_first_chat_job from public.team_jobs
    where chat_id = v_chat.id and owner_user_id = p_owner and finished_at is null and lane = 'chat'
    order by created_at
    limit 1;
    if v_job.id is null and v_first_chat_job is null then
      raise exception 'nothing to stop' using errcode = '55000', hint = 'nothing_to_stop';
    end if;
    select t.target_session_id into v_session from public.tasks t
    where t.id = (select j.task_id from public.team_jobs j where j.id = coalesce(v_job.id, v_first_chat_job));
    insert into public.chat_events
      (owner_user_id, chat_id, room_id, agent_session_id, job_id, author_kind, author_label, audience,
       event_type, body, visibility, delivered_at, idempotency_key, payload)
    values
      (p_owner, v_chat.id,
       (select j.room_id from public.team_jobs j where j.id = coalesce(v_job.id, v_first_chat_job)),
       v_session, coalesce(v_job.id, v_first_chat_job), 'owner', 'You', 'team', 'message',
       v_body, 'visible', pg_catalog.now(), p_idempotency_key,
       jsonb_build_object('lane', coalesce(v_job.lane, 'chat'), 'laneReason', v_reason))
    returning id into v_event_id;
    if v_job.id is not null and v_job.stop_requested_at is null then
      update public.team_jobs set stop_requested_at = pg_catalog.now() where id = v_job.id;
      perform threadlink_private.record_event(p_owner, null, 'team.stop_requested', 'team_job', v_job.id,
        jsonb_build_object('room_id', v_job.room_id, 'chat_id', v_chat.id));
    end if;
    update public.team_jobs
    set stop_requested_at = coalesce(stop_requested_at, pg_catalog.now()),
        control = coalesce(control, 'stop_now'),
        control_requested_at = coalesce(control_requested_at, pg_catalog.now())
    where chat_id = v_chat.id and owner_user_id = p_owner and finished_at is null and lane = 'chat';
    get diagnostics v_stopped = row_count;
    if v_stopped > 0 then
      perform threadlink_private.record_event(p_owner, null, 'team.stop_requested', 'chat', v_chat.id,
        jsonb_build_object('chat_jobs', v_stopped));
    end if;
    return jsonb_build_object('routed', 'stop_requested', 'job_id', coalesce(v_job.id, v_first_chat_job),
                              'event_id', v_event_id, 'chat_id', v_chat.id, 'lane', coalesce(v_job.lane, 'chat'),
                              'lane_reason', v_reason, 'chat_jobs_stopped', v_stopped);
  end if;

  -- 2. A natural answer to an open choice of this chat.
  if p_choice_id is not null then
    select * into v_choice from public.user_choices
    where id = p_choice_id and owner_user_id = p_owner and chat_id = v_chat.id and status = 'pending'
      and expires_at >= pg_catalog.now()
      and not (kind = any (threadlink_private.approval_choice_kinds()))
      and options @> jsonb_build_array(jsonb_build_object('key', p_choice_key))
      and (job_id is null or kind = 'start_work'
           or exists (select 1 from public.team_jobs j where j.id = user_choices.job_id and j.finished_at is null));
    if found then
      select t.target_session_id into v_session from public.tasks t
      where t.id = (select j.task_id from public.team_jobs j where j.id = v_choice.job_id);
      insert into public.chat_events
        (owner_user_id, chat_id, room_id, agent_session_id, job_id, author_kind, author_label, audience,
         event_type, body, visibility, delivered_at, idempotency_key, payload)
      values
        (p_owner, v_chat.id, (select j.room_id from public.team_jobs j where j.id = v_choice.job_id),
         v_session, v_choice.job_id, 'owner', 'You', coalesce(v_mention, 'team'), 'message',
         v_body, 'visible', pg_catalog.now(), p_idempotency_key,
         jsonb_build_object('lane', v_lane, 'laneReason', 'choice_answer', 'choiceId', v_choice.id))
      returning id into v_event_id;
      v_decided := threadlink_private.choice_decide(p_owner, v_choice.id, p_choice_key, v_chat.id, true);
      return jsonb_build_object('routed', 'choice_resolved',
                                'job_id', coalesce(v_decided #>> '{started,job_id}', v_choice.job_id),
                                'event_id', v_event_id, 'chat_id', v_chat.id, 'lane', v_lane,
                                'lane_reason', 'choice_answer', 'choice_id', v_choice.id,
                                'chosen_key', p_choice_key, 'chosen_label', v_decided ->> 'chosen_label',
                                'started', v_decided -> 'started');
    end if;
  end if;

  -- 3. Work while work runs: a note to that job (0.10).
  if v_lane = 'work' and v_job.id is not null then
    select t.target_session_id into v_session from public.tasks t where t.id = v_job.task_id;
    select coalesce(array_agg(provider), '{}') into v_agents
    from public.room_agents where room_id = v_job.room_id and enabled;
    v_audience := coalesce(v_mention, 'team');
    if v_audience <> 'team' and not (v_audience = any (v_agents)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
    insert into public.chat_events
      (owner_user_id, chat_id, room_id, agent_session_id, job_id, author_kind, author_label, audience,
       event_type, body, visibility, idempotency_key, payload)
    values
      (p_owner, v_chat.id, v_job.room_id, v_session, v_job.id, 'owner', 'You', v_audience, 'message',
       v_body, 'visible', p_idempotency_key, jsonb_build_object('lane', 'work', 'laneReason', v_reason))
    returning id into v_event_id;
    return jsonb_build_object('routed', 'note_to_active_job', 'job_id', v_job.id, 'event_id', v_event_id,
                              'chat_id', v_chat.id, 'lane', 'work', 'lane_reason', v_reason);
  end if;

  -- 4 / 5. A new job: work, or a Fast Chat reply.
  if v_rest is null or v_rest = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if not v_has_room then
    raise exception 'Choose a project for this chat so the agents know which folder to work in'
      using errcode = '55000', hint = 'needs_project';
  end if;
  if v_mention in ('claude-code', 'codex') then
    v_mode := 'solo';
    v_builder := v_mention;
  elsif v_mention = 'team' then
    v_mode := 'team';
  else
    v_mode := v_chat.mode;
    if v_mode = 'solo' then
      v_builder := v_chat.solo_provider;
    elsif v_mode = 'pair' then
      v_builder := v_chat.builder_provider;
      v_reviewer := v_chat.reviewer_provider;
    end if;
  end if;
  v_who := threadlink_private.team_participants(p_owner, v_room.id, v_mode, v_builder, v_reviewer);
  v_builder := v_who ->> 'builder';
  v_reviewer := v_who ->> 'reviewer';
  select coalesce(array_agg(value order by ord), '{}') into v_participants
  from jsonb_array_elements_text(v_who -> 'participants') with ordinality as x(value, ord);
  v_audience := case when v_mode = 'solo' then v_builder else 'team' end;

  select * into v_link from public.thread_links
  where owner_user_id = p_owner and agent_session_id = v_room.agent_session_id and status = 'active'
  order by approved_at desc nulls last, created_at desc
  limit 1
  for share;
  if not found or not threadlink_private.session_is_usable(v_link.agent_session_id)
     or not threadlink_private.session_is_usable(v_link.controller_session_id) then
    raise exception 'this project is not linked any more' using errcode = '55000', hint = 'route_missing';
  end if;
  perform threadlink_private.team_route_check(p_owner, v_room, v_link, v_mode);

  insert into public.chat_events
    (owner_user_id, chat_id, room_id, agent_session_id, author_kind, author_label, audience, event_type,
     body, visibility, idempotency_key, payload)
  values
    (p_owner, v_chat.id, v_room.id, v_room.agent_session_id, 'owner', 'You', v_audience, 'request',
     v_body, 'visible', p_idempotency_key, jsonb_build_object('lane', v_lane, 'laneReason', v_reason))
  returning id into v_event_id;

  -- The health gate: nobody able to answer / work -> the message and one
  -- ThreadLink row naming who is not ready; no job.
  v_health := threadlink_private.provider_health_list(v_room.id, v_participants);
  if not threadlink_private.health_gate_ok(p_owner, v_room.id, v_health, v_lane) then
    perform threadlink_private.chat_note(v_chat, v_room.id, 'provider_blocked',
      threadlink_private.provider_health_text(v_health));
    return jsonb_build_object('routed', 'provider_blocked', 'job_id', null, 'event_id', v_event_id,
                              'chat_id', v_chat.id, 'health', v_health, 'mode', v_mode,
                              'builder', v_builder, 'reviewer', v_reviewer, 'lane', v_lane,
                              'lane_reason', v_reason);
  end if;

  v_status := threadlink_private.team_start_job_v3(
    p_owner, null, 'owner', v_room, v_link, v_rest, null, null, null, null, v_mode, v_builder, v_reviewer,
    null, v_chat.id, null, null, v_lane, case when v_lane = 'chat' then v_event_id end);

  update public.chat_events set job_id = v_status ->> 'job_id' where id = v_event_id;
  return jsonb_build_object('routed', case when v_lane = 'chat' then 'chat_job' else 'new_job' end,
                            'job_id', v_status ->> 'job_id', 'event_id', v_event_id,
                            'chat_id', v_chat.id, 'mode', v_mode, 'builder', v_builder,
                            'reviewer', v_reviewer, 'lane', v_lane, 'lane_reason', v_reason);
end;
$$;

-- Owner (web): keyed by chat, with a lane and an optional natural choice answer.
-- All arguments required (no defaults), so no older call can resolve here.
create function public.post_chat_message(
  p_chat_id text, p_body text, p_idempotency_key text, p_lane text, p_lane_reason text,
  p_choice_id text, p_choice_key text
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
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  return threadlink_private.chat_post_v11(v_owner, p_chat_id, p_body, p_idempotency_key, p_lane, p_lane_reason,
                                          p_choice_id, p_choice_key);
end;
$$;

-- Owner from the desktop app / terminal (Runtime credential), with a lane and
-- an optional natural choice answer. Same rules as runtime_post_chat_message.
create function public.runtime_post_chat_message(
  p_token_hash text, p_chat_id text, p_body text, p_idempotency_key text, p_client text,
  p_lane text, p_lane_reason text, p_choice_id text, p_choice_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v_result jsonb;
begin
  if p_client is null or not (p_client = any (array['desktop', 'terminal'])) then
    raise exception 'invalid client' using errcode = '22023', hint = 'invalid';
  end if;
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  perform threadlink_private.chat_api_require_this_computer(v_rt,
    (select c.room_id from public.chats c
     where c.id = p_chat_id and c.owner_user_id = v_rt.owner_user_id and c.deleted_at is null));
  perform pg_catalog.set_config('threadlink.post_client', p_client, true);
  v_result := threadlink_private.chat_post_v11(v_rt.owner_user_id, p_chat_id, p_body, p_idempotency_key,
                                               p_lane, p_lane_reason, p_choice_id, p_choice_key);
  perform pg_catalog.set_config('threadlink.post_client', '', true);
  return v_result - 'mode' - 'builder' - 'reviewer';
end;
$$;

/*
 * A controller's message with a lane. As the 0.10 controller path (the
 * controller's own link, stricter than the owner: no notes, no stop, no
 * natural choice answers, health refusal stores nothing), plus:
 *   work: refused (job_active) only while WORK runs in the chat;
 *   chat: a Fast Chat job, even while work runs; its request row is written
 *         first (authored by the controller) so the carrier can name it.
 */
create function public.controller_post_chat_message(
  p_token_hash text, p_session_id text, p_chat_id text, p_body text, p_idempotency_key text,
  p_lane text, p_lane_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
  w record;
  v_owner text := (v.o_connection).owner_user_id;
  v_task text;
  v_job public.team_jobs;
  v_body text;
  v_match text[];
  v_mention text;
  v_goal text;
  v_mode text;
  v_builder text;
  v_reviewer text;
  v_result jsonb;
  v_lane text := p_lane;
  v_reason text := p_lane_reason;
  v_event_id text;
begin
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  if v_lane is null or not (v_lane = any (threadlink_private.lanes())) then
    raise exception 'invalid lane' using errcode = '22023', hint = 'invalid';
  end if;
  if v_reason is not null and not (v_reason = any (threadlink_private.lane_reasons())) then
    raise exception 'invalid lane reason' using errcode = '22023', hint = 'invalid';
  end if;
  w := threadlink_private.chat_api_controller_chat(v.o_connection, v.o_session, p_chat_id);

  if p_idempotency_key is not null then
    select id into v_task from public.tasks
    where owner_user_id = v_owner and origin_session_id = (v.o_session).id and idempotency_key = p_idempotency_key;
    if v_task is not null then
      select * into v_job from public.team_jobs where task_id = v_task and owner_user_id = v_owner;
      if not found or v_job.chat_id is distinct from (w.o_chat).id then
        raise exception 'idempotency key already used' using errcode = '55000', hint = 'idempotency_conflict';
      end if;
      return threadlink_private.team_status_json(v_job.id) || jsonb_build_object('created', false);
    end if;
  end if;

  if p_body is null or pg_catalog.btrim(p_body) = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if char_length(p_body) > threadlink_private.chat_owner_max_chars() then
    raise exception 'message too long' using errcode = '22023', hint = 'too_long';
  end if;
  v_body := threadlink_private.chat_clean(p_body, threadlink_private.chat_owner_max_chars());
  if v_body is null then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if v_body ~* threadlink_private.chat_stop_pattern() then
    raise exception 'nothing to stop' using errcode = '55000', hint = 'nothing_to_stop';
  end if;
  if v_lane = 'chat'
     and threadlink_private.room_protocol((w.o_room).id) < threadlink_private.min_protocol_for('chat_lane') then
    v_lane := 'work';
    v_reason := 'runtime_outdated';
  end if;
  if v_lane = 'work' and exists (select 1 from public.team_jobs
                                 where chat_id = (w.o_chat).id and finished_at is null and lane = 'work') then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;

  v_match := pg_catalog.regexp_match(v_body, '^(@(claude-code|claude|codex|team)([[:space:],:;.!]+|$))', 'i');
  if v_match is not null then
    v_mention := case lower(v_match[2]) when 'claude' then 'claude-code' else lower(v_match[2]) end;
    v_goal := pg_catalog.btrim(substr(v_body, char_length(v_match[1]) + 1), E' \n\t');
  else
    v_goal := v_body;
  end if;
  if v_goal is null or v_goal = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if v_mention in ('claude-code', 'codex') then
    v_mode := 'solo';
    v_builder := v_mention;
  elsif v_mention = 'team' then
    v_mode := 'team';
  else
    v_mode := (w.o_chat).mode;
    if v_mode = 'solo' then
      v_builder := (w.o_chat).solo_provider;
    elsif v_mode = 'pair' then
      v_builder := (w.o_chat).builder_provider;
      v_reviewer := (w.o_chat).reviewer_provider;
    end if;
  end if;

  if v_lane = 'chat' then
    -- The request row first (the carrier names it); the job-insert trigger
    -- then skips its own copy.
    insert into public.chat_events
      (owner_user_id, chat_id, room_id, agent_session_id, author_kind, author_label, audience, event_type,
       body, visibility, payload)
    values
      (v_owner, (w.o_chat).id, (w.o_room).id, (w.o_room).agent_session_id, 'controller',
       threadlink_private.chat_controller_label((v.o_session).id), 'team', 'request',
       pg_catalog.left(v_goal, 2000), 'visible', jsonb_build_object('lane', 'chat', 'laneReason', v_reason))
    returning id into v_event_id;
    perform pg_catalog.set_config('threadlink.controller_request_written', 'on', true);
  end if;
  v_result := threadlink_private.team_start_job_v3(
    v_owner, (v.o_connection).id, 'controller', w.o_room, w.o_link, v_goal, null, null, null, null,
    v_mode, v_builder, v_reviewer, p_idempotency_key, (w.o_chat).id, null, null, v_lane, v_event_id);
  perform pg_catalog.set_config('threadlink.controller_request_written', '', true);
  if v_event_id is not null then
    update public.chat_events set job_id = v_result ->> 'job_id' where id = v_event_id;
  end if;
  perform threadlink_private.touch_session((v.o_session).id);
  return v_result || jsonb_build_object('lane', v_lane, 'lane_reason', v_reason);
end;
$$;

/*
 * What the TS layer needs to classify a message and to match a natural
 * answer (section 6), for one chat of p_owner: the chat's mode, whether WORK
 * is running, and the chat's open choices (newest first, at most 5) with the
 * health of the provider each is about. Approval kinds are never listed.
 */
create function threadlink_private.chat_compose_context(p_owner text, p_chat_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.chats;
  v_runtime text;
begin
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into v from public.chats where id = p_chat_id and owner_user_id = p_owner and deleted_at is null;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  v_runtime := case when v.room_id is not null then threadlink_private.room_runtime(v.room_id) end;
  return jsonb_build_object(
    'chat_id', v.id,
    'mode', v.mode,
    'active_work_job', exists (select 1 from public.team_jobs j
                               where j.chat_id = v.id and j.finished_at is null and j.lane = 'work'),
    'fast_chat', v.room_id is not null
                 and threadlink_private.room_protocol(v.room_id) >= threadlink_private.min_protocol_for('chat_lane'),
    'choices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'choice_id', c.id, 'kind', c.kind, 'options', c.options,
               'provider', c.params ->> 'provider', 'other_provider', c.params ->> 'otherProvider',
               'provider_health', (select threadlink_private.provider_effective_health(h.provider, h.detected, h.received_at)
                                   from public.runtime_provider_health h
                                   where h.runtime_id = v_runtime and h.provider = c.params ->> 'provider'),
               'created_at', c.created_at)
             order by c.created_at desc)
      from (select * from public.user_choices uc
            where uc.chat_id = v.id and uc.owner_user_id = p_owner and uc.status = 'pending'
              and uc.expires_at >= pg_catalog.now()
              and not (uc.kind = any (threadlink_private.approval_choice_kinds()))
              and (uc.job_id is null or uc.kind = 'start_work'
                   or exists (select 1 from public.team_jobs j where j.id = uc.job_id and j.finished_at is null))
            order by uc.created_at desc
            limit 5) c), '[]'::jsonb));
end;
$$;

create function public.chat_compose_context(p_chat_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return threadlink_private.chat_compose_context(threadlink_private.require_owner(), p_chat_id);
end;
$$;

create function public.runtime_chat_compose_context(p_token_hash text, p_chat_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
begin
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
  return threadlink_private.chat_compose_context(v_rt.owner_user_id, p_chat_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The Runtime write path (claim-gated). The 0.10 function moves to
--     threadlink_private.team_job_write_v10 unchanged; the new public
--     function (same signature, same audience) authenticates exactly as it
--     did, then:
--       * handles the 0.11 ops itself: read_chat_context, failover_notice,
--         set_status for a Fast Chat job, set_final REVIEW_PENDING,
--         request_choice for start_work / usage_exhausted / any Fast Chat job;
--       * refuses plan/DAG ops on a Fast Chat job (hint chat_lane);
--       * extends run_started (sessionReason, cross-job resume), run_finished
--         (timings), PASS (independent review happened, protocol 11) and
--         provider_failure (no retry of an exhausted provider);
--       * delegates everything else to the 0.10 function unchanged.
-- ---------------------------------------------------------------------------
alter function public.team_job_write(text, text, text, text, text, jsonb) set schema threadlink_private;
alter function threadlink_private.team_job_write(text, text, text, text, text, jsonb) rename to team_job_write_v10;
revoke all on function threadlink_private.team_job_write_v10(text, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;

-- A provider's short registry name ("Claude", "Codex").
create function threadlink_private.provider_short(p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.short_name from public.agent_providers p where p.id = p_provider), 'An agent')
$$;

-- The fixed failover sentence (section 5): registry names and fixed words only.
create function threadlink_private.failover_text(p_from text, p_to text, p_review_pending boolean)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select threadlink_private.provider_short(p_from) || ' usage is exhausted.'
    || case when p_to is not null then ' Continuing with ' || threadlink_private.provider_short(p_to) || '.'
            else '' end
    || case when p_review_pending then ' Independent review will wait for '
                                       || threadlink_private.provider_short(p_from) || '.'
            else '' end
$$;

-- An ISO instant from a payload key, inside a sanity window, or null.
create function threadlink_private.tj_instant(p jsonb, p_key text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := threadlink_private.tj_text(p, p_key, 64, false);
  t timestamptz;
begin
  if v is null then
    return null;
  end if;
  if v !~ threadlink_private.iso_instant_pattern() then
    raise exception 'invalid %', p_key using errcode = '22023';
  end if;
  begin
    t := v::timestamptz;
  exception when others then
    raise exception 'invalid %', p_key using errcode = '22023';
  end;
  if t < pg_catalog.now() - interval '1 hour' or t > pg_catalog.now() + interval '8 days' then
    return null;
  end if;
  return t;
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
  v_protocol integer := threadlink_private.connection_protocol(v_connection.id);
  v_result jsonb := '{}'::jsonb;
  v_out jsonb;
  v_kind text;
  v_text text;
  v_status text;
  v_provider text;
  v_other text;
  v_int integer;
  v_bool boolean;
  v_run public.agent_runs;
  v_run_id text;
  v_reason text;
  v_cross_resume boolean := false;
  v_timings jsonb;
  v_params jsonb;
  v_options jsonb;
  v_strings text[];
  v_choice public.user_choices;
  v_title text;
  v_resets timestamptz;
  v_event_id text;
  v_since timestamptz;
  v_participants text[];
begin
  -- The same authority as 0.10, in the same order (identical refusals).
  select * into v_job from public.team_jobs
  where id = p_job_id and owner_user_id = v_connection.owner_user_id
  for update;
  if not found then
    raise exception 'team job not found' using errcode = 'P0002';
  end if;
  v_task := threadlink_private.require_claimed_task(
    v_session, v_job.task_id, p_claim_ref, array['claimed', 'working']);
  if jsonb_typeof(v_p) <> 'object' or octet_length(v_p::text) > 1048576 then
    raise exception 'invalid payload' using errcode = '22023';
  end if;

  -- A Fast Chat job has no plan, units, changes, findings, decisions or verdict.
  if v_job.lane = 'chat' and p_op in ('set_spec', 'set_plan', 'upsert_nodes', 'set_node_status', 'open_round',
                                      'add_change', 'add_finding', 'add_decision', 'set_final',
                                      'set_finding_status') then
    raise exception 'not available for a Fast Chat job' using errcode = '22023', hint = 'chat_lane';
  end if;

  if p_op in ('read_chat_context', 'failover_notice')
     or (p_op = 'set_status' and v_job.lane = 'chat')
     or (p_op = 'set_final' and jsonb_typeof(v_p -> 'verdict') = 'string' and v_p ->> 'verdict' = 'REVIEW_PENDING')
     or (p_op = 'request_choice' and (v_job.lane = 'chat'
                                      or v_p ->> 'kind' in ('start_work', 'usage_exhausted'))) then
    -- The 0.10 preconditions for a write, then the 0.11 op.
    select * into v_room from public.rooms where id = v_job.room_id;
    if v_room.status = 'deleted' then
      raise exception 'room was deleted' using errcode = '55000';
    end if;
    if v_job.finished_at is not null then
      raise exception 'team job is finished' using errcode = '55000';
    end if;
    if v_job.last_claim_ref is distinct from p_claim_ref then
      update public.team_jobs set last_claim_ref = p_claim_ref where id = v_job.id;
      v_job.last_claim_ref := p_claim_ref;
    end if;
    if octet_length(v_p::text) > 131072 then
      raise exception 'invalid payload' using errcode = '22023';
    end if;
    v_participants := threadlink_private.job_participants(v_job.id);

    case
    -- ------------------------------------------------------- read_chat_context
    -- This job's chat only: visible owner / controller / agent messages,
    -- newest N, returned oldest first, bodies re-redacted.
    when p_op = 'read_chat_context' then
      perform threadlink_private.tj_keys(v_p, array['limit']);
      v_int := coalesce(threadlink_private.tj_int(v_p, 'limit', 1, 40, false), 20);
      v_result := jsonb_build_object('messages', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', m.id, 'chat_seq', m.chat_seq, 'author_kind', m.author_kind,
                 'author_provider_id', m.author_provider, 'author_label', m.author_label,
                 'reply_to', m.reply_to_event_id, 'body', threadlink_private.redact_text(m.body),
                 'created_at', m.created_at)
               order by m.chat_seq)
        from (select e.* from public.chat_events e
              where v_job.chat_id is not null and e.chat_id = v_job.chat_id
                and e.owner_user_id = v_job.owner_user_id and e.visibility = 'visible'
                and ((e.author_kind in ('owner', 'controller') and e.event_type in ('request', 'message'))
                     or (e.author_kind = 'agent' and e.event_type in ('agent_message', 'agent_result')))
              order by e.chat_seq desc nulls last
              limit v_int) m), '[]'::jsonb));

    -- --------------------------------------------------------- failover_notice
    when p_op = 'failover_notice' then
      perform threadlink_private.tj_keys(v_p, array['from', 'to', 'review_pending', 'resets_at']);
      v_provider := threadlink_private.tj_text(v_p, 'from', 64, true);
      v_other := threadlink_private.tj_text(v_p, 'to', 64, false);
      v_bool := coalesce(threadlink_private.tj_bool(v_p, 'review_pending'), false);
      v_resets := threadlink_private.tj_instant(v_p, 'resets_at');
      if not (v_provider = any (v_participants))
         or (v_other is not null and (not (v_other = any (v_participants)) or v_other = v_provider)) then
        raise exception 'invalid provider' using errcode = '22023';
      end if;
      -- Never invented: the provider really is exhausted (its run of this job
      -- said so, or this computer's health for it says so).
      if not exists (select 1 from public.agent_runs r
                     where r.job_id = v_job.id and r.provider = v_provider and r.failure = 'quota_exhausted')
         and not exists (select 1 from public.runtime_provider_health h
                         where h.runtime_id = threadlink_private.room_runtime(v_job.room_id)
                           and h.provider = v_provider and h.health = 'usage_exhausted') then
        raise exception 'that agent''s usage is not exhausted' using errcode = '22023', hint = 'not_exhausted';
      end if;
      -- One notice per chat, provider pair and exhaustion (since the health
      -- last changed, at most 24 h).
      select greatest(coalesce(h.health_changed_at, '-infinity'::timestamptz), pg_catalog.now() - interval '24 hours')
      into v_since
      from public.runtime_provider_health h
      where h.runtime_id = threadlink_private.room_runtime(v_job.room_id) and h.provider = v_provider;
      v_since := coalesce(v_since, pg_catalog.now() - interval '24 hours');
      select e.id into v_event_id from public.chat_events e
      where e.chat_id = v_job.chat_id and e.event_type = 'failover' and e.created_at >= v_since
        and e.payload ->> 'from' = v_provider and (e.payload ->> 'to') is not distinct from v_other
      order by e.created_at desc
      limit 1;
      if v_event_id is not null then
        v_result := jsonb_build_object('event_id', v_event_id, 'created', false);
      else
        v_event_id := threadlink_private.chat_card(v_job, 'threadlink', null, 'failover',
          threadlink_private.failover_text(v_provider, v_other, v_bool), 'visible',
          jsonb_build_object('from', v_provider, 'to', v_other, 'reviewPending', v_bool,
                             'resetsAt', case when v_resets is null then null
                                              else pg_catalog.to_char(v_resets at time zone 'UTC',
                                                                      'YYYY-MM-DD"T"HH24:MI:SS"Z"') end));
        perform threadlink_private.record_event(v_job.owner_user_id, v_connection.id, 'team.failover_notice',
          'team_job', v_job.id, jsonb_build_object('from', v_provider, 'to', v_other, 'review_pending', v_bool));
        v_result := jsonb_build_object('event_id', v_event_id, 'created', true);
      end if;

    -- ------------------------------------------------- set_status (Fast Chat)
    when p_op = 'set_status' then
      perform threadlink_private.tj_keys(v_p, array['status', 'line']);
      v_status := threadlink_private.tj_enum(v_p, 'status',
        array['normalising', 'cancelled', 'interrupted', 'paused', 'completed', 'failed'], true);
      v_text := threadlink_private.tj_text(v_p, 'line', 800, false);
      if v_text is not null and (char_length(v_text) > 200 or v_text ~ '[[:cntrl:]]') then
        raise exception 'invalid line' using errcode = '22023';
      end if;
      update public.team_jobs
      set status = v_status,
          status_line = coalesce(v_text, status_line),
          finished_at = case when v_status in ('completed', 'failed', 'cancelled') then pg_catalog.now() end
      where id = v_job.id;
      if v_status in ('completed', 'failed', 'cancelled') then
        perform threadlink_private.record_event(
          v_job.owner_user_id, v_connection.id, 'team.job_finished', 'team_job', v_job.id,
          jsonb_build_object('status', v_status, 'lane', 'chat'));
      end if;

    -- ------------------------------------------------ set_final REVIEW_PENDING
    -- The work finished but the independent reviewer could not review it (its
    -- usage ran out): never PASS; open blocking findings or a failed unit are
    -- NEEDS_FIX, not this.
    when p_op = 'set_final' then
      perform threadlink_private.tj_keys(v_p, array['verdict', 'evidence', 'summary', 'reason', 'provider']);
      v_provider := threadlink_private.tj_enum(v_p, 'provider', threadlink_private.team_providers(), false);
      if v_provider is not null and not (v_provider = any (v_participants)) then
        raise exception 'invalid provider' using errcode = '22023';
      end if;
      if v_p ? 'reason' and (jsonb_typeof(v_p -> 'reason') <> 'string'
          or threadlink_private.chat_reason_text(v_p ->> 'reason') is null) then
        raise exception 'invalid reason' using errcode = '22023';
      end if;
      if v_p -> 'evidence' is null or jsonb_typeof(v_p -> 'evidence') <> 'object'
         or octet_length((v_p -> 'evidence')::text) > 32768 then
        raise exception 'invalid evidence' using errcode = '22023';
      end if;
      if exists (select 1 from public.team_findings
                 where job_id = v_job.id and status = any (threadlink_private.finding_open_states())
                   and severity in ('blocking', 'important')) then
        raise exception 'REVIEW_PENDING refused: open blocking or important findings' using errcode = '55000',
          hint = 'open_findings';
      end if;
      if exists (select 1 from public.team_nodes where job_id = v_job.id and status = 'failed') then
        raise exception 'REVIEW_PENDING refused: a node failed' using errcode = '55000', hint = 'node_failed';
      end if;
      update public.team_jobs
      set verdict = 'REVIEW_PENDING',
          evidence = v_p -> 'evidence',
          summary = threadlink_private.tj_text(v_p, 'summary', 4000, false),
          verdict_reason = v_p ->> 'reason',
          verdict_provider = v_provider,
          status = 'review_pending',
          finished_at = pg_catalog.now()
      where id = v_job.id;
      perform threadlink_private.record_event(
        v_job.owner_user_id, v_connection.id, 'team.job_finished', 'team_job', v_job.id,
        jsonb_build_object('verdict', 'REVIEW_PENDING'));

    -- ---------------------------------------- request_choice (0.11 kinds, chat)
    when p_op = 'request_choice' then
      perform threadlink_private.tj_keys(v_p, array['request_key', 'kind', 'run_id', 'provider', 'other_provider',
                                                    'step', 'minutes', 'node_key', 'options', 'source_event_id',
                                                    'resets_at']);
      v_text := threadlink_private.tj_text(v_p, 'request_key', 128, true);
      if v_text !~ '^[A-Za-z0-9._:-]{1,128}$' then
        raise exception 'invalid request_key' using errcode = '22023';
      end if;
      v_kind := threadlink_private.tj_enum(v_p, 'kind', threadlink_private.choice_kinds(), true);
      if v_job.lane = 'chat' and not (v_kind = any (array['start_work', 'usage_exhausted', 'provider_failure'])) then
        raise exception 'not available for a Fast Chat job' using errcode = '22023', hint = 'chat_lane';
      end if;
      if v_kind = 'start_work' and v_job.lane <> 'chat' then
        raise exception 'invalid kind' using errcode = '22023';
      end if;
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
        if (v_provider is not null and not (v_provider = any (v_participants)))
           or (v_other is not null and (not (v_other = any (v_participants)) or v_other = v_provider)) then
          raise exception 'invalid provider' using errcode = '22023';
        end if;
        if v_kind = 'usage_exhausted' and v_provider is null then
          raise exception 'invalid provider' using errcode = '22023';
        end if;
        v_text := threadlink_private.tj_text(v_p, 'source_event_id', 64, false);
        if v_kind = 'start_work' then
          if v_text is null or not exists (
               select 1 from public.chat_events e
               where e.id = v_text and e.owner_user_id = v_job.owner_user_id and e.chat_id = v_job.chat_id
                 and e.author_kind = 'owner' and e.event_type in ('request', 'message')) then
            raise exception 'invalid source_event_id' using errcode = '22023';
          end if;
        elsif v_text is not null then
          raise exception 'invalid source_event_id' using errcode = '22023';
        end if;
        v_resets := case when v_kind = 'usage_exhausted' then threadlink_private.tj_instant(v_p, 'resets_at') end;
        if v_kind <> 'usage_exhausted' and v_p ? 'resets_at' then
          raise exception 'invalid resets_at' using errcode = '22023';
        end if;
        perform threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false));
        v_params := jsonb_strip_nulls(jsonb_build_object(
          'provider', v_provider, 'otherProvider', v_other,
          'step', threadlink_private.tj_enum(v_p, 'step', threadlink_private.choice_steps(), false),
          'minutes', threadlink_private.tj_int(v_p, 'minutes', 1, 1440, false),
          'nodeKey', threadlink_private.tj_text(v_p, 'node_key', 64, false),
          'sourceEventId', v_text,
          'resetsAt', case when v_resets is not null
                           then pg_catalog.to_char(v_resets at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end));
        v_options := threadlink_private.choice_options_now(v_job, v_kind, v_params);
        if v_p ? 'options' then
          v_strings := threadlink_private.tj_strings(v_p, 'options', 6, 40, '^[a-z_]{1,40}$');
          if cardinality(v_strings) = 0 then
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
          (v_job.owner_user_id, v_job.chat_id, v_job.id, v_run.id, v_kind, v_title, v_params, v_options,
           threadlink_private.tj_text(v_p, 'request_key', 128, true),
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
        -- A work job waits for the owner; a Fast Chat job is never paused.
        if v_job.lane = 'work' then
          update public.team_jobs set status = 'paused' where id = v_job.id and status <> 'paused';
        end if;
        v_result := jsonb_build_object('choice_id', v_choice.id, 'created', true, 'status', 'pending');
      end if;
    end case;
    return threadlink_private.team_status_json(v_job.id) || jsonb_build_object('op', p_op, 'result', v_result);
  end if;

  -- ------------------------------------------------ extended 0.10 operations
  if p_op = 'run_started' then
    v_reason := threadlink_private.tj_enum(v_p, 'session_reason', threadlink_private.session_reasons(), false);
    v_p := v_p - 'session_reason';
    -- Resuming the native session of an earlier job of THIS chat: no
    -- resumed-from run of this job exists, so the 0.10 op stores it fresh and
    -- it is marked resumed right after (the native-session guard still refuses
    -- any other chat or project).
    if jsonb_typeof(v_p -> 'continuity') = 'string' and v_p ->> 'continuity' = 'resumed'
       and (v_p -> 'resumed_from_run_key' is null or v_p -> 'resumed_from_run_key' = 'null'::jsonb) then
      v_cross_resume := true;
      v_p := v_p - 'continuity' - 'resumed_from_run_key';
    end if;
  elsif p_op = 'run_finished' then
    if v_p ? 'timings' and v_p -> 'timings' <> 'null'::jsonb then
      v_timings := v_p -> 'timings';
      if not threadlink_private.valid_run_timings(v_timings) then
        raise exception 'invalid timings' using errcode = '22023';
      end if;
    end if;
    v_p := v_p - 'timings';
    if v_timings is not null then
      v_run := threadlink_private.tj_run(v_job.id, threadlink_private.tj_text(v_p, 'run_id', 64, true), null,
                                         threadlink_private.run_statuses());
      update public.agent_runs set timings = v_timings where id = v_run.id and finished_at is null;
    end if;
  elsif p_op = 'set_final' and jsonb_typeof(v_p -> 'verdict') = 'string' and v_p ->> 'verdict' = 'PASS'
        and v_protocol >= threadlink_private.min_protocol_for('review_check') and v_job.mode <> 'solo'
        -- Only where review was required: the project's cross-review as the
        -- job's carrier snapshotted it (the room's setting for an old carrier).
        and coalesce(
              case when jsonb_typeof(v_task.content::jsonb #> '{policy,crossReview}') = 'boolean'
                   then (v_task.content::jsonb #>> '{policy,crossReview}')::boolean end,
              (select r.cross_review from public.rooms r where r.id = v_job.room_id),
              true) then
    -- Never PASS without the independent review (section 5): every unit with a
    -- reviewer was reviewed by a completed run of that reviewer.
    if exists (select 1 from public.team_nodes n
               where n.job_id = v_job.id and n.reviewer_provider is not null and n.status <> 'skipped'
                 and not exists (select 1 from public.agent_runs r
                                 where r.job_id = v_job.id and r.provider = n.reviewer_provider
                                   and r.status = 'completed'
                                   and r.role in ('reviewer', 'security_reviewer', 'test_reviewer'))) then
      raise exception 'PASS refused: the independent review did not happen' using errcode = '55000',
        hint = 'review_missing';
    end if;
  elsif p_op = 'request_choice' and v_p ->> 'kind' = 'provider_failure' then
    -- No "Retry <provider>" while that provider's usage is exhausted.
    v_options := threadlink_private.choice_options_now(v_job, 'provider_failure',
      jsonb_strip_nulls(jsonb_build_object('provider', v_p ->> 'provider', 'otherProvider', v_p ->> 'other_provider')));
    if not (v_options @> '[{"key":"retry"}]'::jsonb) then
      if jsonb_typeof(v_p -> 'options') = 'array' then
        select coalesce(jsonb_agg(o), '[]'::jsonb) into v_params
        from jsonb_array_elements(v_p -> 'options') o where o #>> '{}' <> 'retry';
        if jsonb_array_length(v_params) = 0 then
          v_params := '["stop"]'::jsonb;
        end if;
        v_p := jsonb_set(v_p, '{options}', v_params);
      else
        select coalesce(jsonb_agg(o ->> 'key'), '["stop"]'::jsonb) into v_params
        from jsonb_array_elements(v_options) o;
        v_p := v_p || jsonb_build_object('options', v_params);
      end if;
    end if;
  end if;

  v_out := threadlink_private.team_job_write_v10(p_token_hash, p_session_id, p_job_id, p_claim_ref, p_op, v_p);

  if p_op = 'run_started' and (v_out #>> '{result,created}') = 'true' then
    update public.agent_runs
    set session_reason = v_reason,
        native_session_continuity = case when v_cross_resume then 'resumed' else native_session_continuity end
    where id = v_out #>> '{result,run_id}' and job_id = v_job.id;
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Wake long-poll (section 3.2): how many tasks this Runtime could claim
--     now (queued, or a lapsed lease) across its own sessions. The route
--     calls it with p_begin = true once per wake request (rate-limited) and
--     then polls it cheaply until something is pending or time runs out.
-- ---------------------------------------------------------------------------
create function public.runtime_pending_count(p_token_hash text, p_begin boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes;
  v_pending integer;
begin
  if v_connection.role <> 'agent' then
    raise exception 'agent connection required' using errcode = '42501', hint = 'forbidden';
  end if;
  select * into v_runtime from public.runtimes
  where connection_id = v_connection.id and owner_user_id = v_connection.owner_user_id and status = 'active';
  if not found then
    raise exception 'runtime not registered' using errcode = '42501', hint = 'runtime_required';
  end if;
  if coalesce(p_begin, false) then
    perform threadlink_private.owner_rate_limit(v_runtime.owner_user_id, 'runtime_wake',
                                                threadlink_private.runtime_wakes_per_minute());
  end if;
  -- Waiting for work is proof of life too.
  perform threadlink_private.runtime_touch(v_connection.id);
  if v_runtime.paused then
    return jsonb_build_object('pending', 0, 'paused', true);
  end if;
  select count(*)::integer into v_pending from (
    select 1 from public.tasks t
    join public.session_bindings s on s.id = t.target_session_id and s.owner_user_id = t.owner_user_id
    where s.connection_id = v_connection.id and s.runtime_id = v_runtime.id and s.status in ('active', 'idle')
      and t.owner_user_id = v_connection.owner_user_id
      and ((t.status = 'queued' and (t.expires_at is null or t.expires_at > pg_catalog.now()))
           or (t.status in ('claimed', 'working') and t.claimed_until < pg_catalog.now()))
    limit 100) x;
  return jsonb_build_object('pending', v_pending, 'paused', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Owner settings RPCs (Clerk-authenticated)
-- ---------------------------------------------------------------------------
create function public.get_my_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
begin
  return jsonb_build_object(
    'failover_policy', threadlink_private.failover_policy_of(v_owner),
    'updated_at', (select s.updated_at from public.user_settings s where s.owner_user_id = v_owner));
end;
$$;

create function public.set_failover_policy(p_policy text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.require_owner();
begin
  if p_policy is null or not (p_policy = any (threadlink_private.failover_policies())) then
    raise exception 'invalid policy' using errcode = '22023', hint = 'invalid';
  end if;
  if not exists (select 1 from public.users u where u.id = v_owner) then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'settings', 30);
  insert into public.user_settings (owner_user_id, failover_policy, updated_at)
  values (v_owner, p_policy, pg_catalog.now())
  on conflict (owner_user_id) do update set failover_policy = excluded.failover_policy, updated_at = excluded.updated_at;
  perform threadlink_private.record_event(v_owner, null, 'settings.updated', 'user_settings', v_owner,
    jsonb_build_object('failover_policy', p_policy));
  return public.get_my_settings();
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Privileges: revoke everything new from every client role, then grant
--     exactly its audience (owner RPCs -> authenticated; credential RPCs ->
--     anon + authenticated like their originals). Replaced functions keep
--     their existing grants.
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.runtime_protocol_min()', 'threadlink_private.approval_choice_kinds()',
    'threadlink_private.lanes()', 'threadlink_private.lane_reasons()', 'threadlink_private.failover_policies()',
    'threadlink_private.session_reasons()', 'threadlink_private.timing_keys()',
    'threadlink_private.chat_lane_max_open_per_chat()', 'threadlink_private.runtime_touch_interval()',
    'threadlink_private.runtime_wakes_per_minute()', 'threadlink_private.iso_instant_pattern()',
    'threadlink_private.failover_policy_of(text)', 'threadlink_private.valid_run_timings(jsonb)',
    'threadlink_private.runtime_touch(text)', 'threadlink_private.runtime_presence(public.runtimes)',
    'threadlink_private.room_protocol(text)', 'threadlink_private.health_gate_ok(text, text, jsonb, text)',
    'threadlink_private.team_start_job_v3(text, text, text, public.rooms, public.thread_links, text, jsonb, integer, integer, integer, text, text, text, text, text, jsonb, text, text, text)',
    'threadlink_private.verdict_words(text)',
    'threadlink_private.choice_options_now(public.team_jobs, text, jsonb)',
    'threadlink_private.chat_start_work_from_event(text, text, text)',
    'threadlink_private.choice_decide(text, text, text, text, boolean)',
    'threadlink_private.chat_post_v11(text, text, text, text, text, text, text, text)',
    'threadlink_private.chat_compose_context(text, text)',
    'threadlink_private.provider_short(text)', 'threadlink_private.failover_text(text, text, boolean)',
    'threadlink_private.tj_instant(jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;

  -- Credential RPCs (Runtime / controller): the audience of their originals.
  foreach f in array array[
    'public.team_job_write(text, text, text, text, text, jsonb)',
    'public.runtime_pending_count(text, boolean)',
    'public.runtime_post_chat_message(text, text, text, text, text, text, text, text, text)',
    'public.controller_post_chat_message(text, text, text, text, text, text, text)',
    'public.runtime_chat_compose_context(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;

  -- Owner RPCs.
  foreach f in array array[
    'public.post_chat_message(text, text, text, text, text, text, text)',
    'public.chat_compose_context(text)',
    'public.get_my_settings()',
    'public.set_failover_policy(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$grants$;
-- ---------------------------------------------------------------------------
-- 14. The credential chat API's chat summary: + the execution host's presence
--     (section 4) for the desktop app and the terminal.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_api_summary(p_chat_id text, p_runtime_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as (select * from public.chats where id = p_chat_id),
  r as (select rm.* from public.rooms rm join c on c.room_id = rm.id where rm.status <> 'deleted'),
  rt as (select x.* from public.runtimes x
         where x.id = (select threadlink_private.room_runtime(r.id) from r)),
  jobs as (select j.* from public.team_jobs j join c on j.chat_id = c.id order by j.created_at desc limit 20),
  active as (select * from jobs where finished_at is null order by (lane = 'work') desc, created_at desc limit 1),
  latest as (select * from jobs order by created_at desc limit 1),
  newest as (select e.seq, e.body from public.chat_events e join c on e.chat_id = c.id
             where e.visibility = 'visible' order by e.seq desc limit 1)
  select jsonb_build_object(
    'chat_id', c.id,
    'name', c.name,
    'mode', c.mode,
    'settings', jsonb_build_object('mode', c.mode, 'solo_provider', c.solo_provider,
                                   'builder_provider', c.builder_provider,
                                   'reviewer_provider', c.reviewer_provider),
    'project', (select jsonb_build_object(
                  'project_id', r.id,
                  'name', r.name,
                  'status', r.status,
                  'runs_on', (select rt.label from rt),
                  -- 0.11: the same presence rule as chat_host_status (section 4).
                  'runtime_online', coalesce((select threadlink_private.runtime_presence(rt) in ('online', 'working')
                                              from rt), false),
                  'runtime_presence', (select threadlink_private.runtime_presence(rt) from rt),
                  'runtime_last_seen_at', (select rt.last_seen_at from rt),
                  'this_computer', coalesce((select rt.id = p_runtime_id from rt), false))
                from r),
    'group_name', (select g.name from public.chat_groups g where g.id = c.group_id),
    'pinned', c.pinned_at is not null,
    'archived', c.archived_at is not null,
    'is_room_default', c.is_room_default,
    'last_activity_at', c.last_activity_at,
    'last_message', (select pg_catalog.left(n.body, 200) from newest n),
    'unread', exists (select 1 from public.chat_events u
                      where u.chat_id = c.id and u.chat_seq > c.last_read_chat_seq
                        and threadlink_private.chat_counts_unread(u.author_kind, u.event_type, u.visibility)),
    -- At most 100 (0200's rule).
    'unread_count', (select count(*)::integer from (
                       select 1 from public.chat_events u
                       where u.chat_id = c.id and u.chat_seq > c.last_read_chat_seq
                         and threadlink_private.chat_counts_unread(u.author_kind, u.event_type, u.visibility)
                       limit 100) x),
    'last_read_cursor', c.last_read_chat_seq,
    'needs_attention',
      coalesce((select l.status in ('blocked', 'needs_user_decision') from latest l), false)
      or exists (select 1 from active a join public.team_decisions d on d.job_id = a.id
                 where d.requires_user and d.resolution is null),
    'active_job', (select jsonb_build_object('job_id', a.id, 'mode', a.mode, 'status', a.status, 'lane', a.lane)
                   from active a),
    'participants',
      coalesce((select jsonb_agg(jsonb_build_object(
                  'kind', 'agent', 'provider', a.provider,
                  -- Display metadata from the provider registry (never a per-provider switch).
                  'name', coalesce(pr.display_name, a.provider),
                  'short_name', coalesce(pr.short_name, a.provider),
                  'health', threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at))
                  order by coalesce(pr.sort, 0), a.provider)
                from public.room_agents a
                join r on r.id = a.room_id
                left join public.agent_providers pr on pr.id = a.provider
                left join public.runtime_provider_health h
                  on h.runtime_id = (select rt.id from rt) and h.provider = a.provider
                where a.enabled), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('kind', 'controller', 'provider', null, 'name', s.label,
                                                       'short_name', s.label, 'health', null) order by s.label)
                   from (select distinct x.author_label as label
                         from (select ce.author_label from public.chat_events ce
                               where ce.chat_id = c.id and ce.author_kind = 'controller'
                               order by ce.seq desc limit 50) x) s), '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('kind', 'owner', 'provider', null, 'name', 'You',
                                              'short_name', 'You', 'health', null)))
  from c
$$;

-- The owner's projects a new chat can be put in (active, not deleted).

-- ---------------------------------------------------------------------------
-- 15. The Runtime-credential chat API (desktop app / terminal), 0.11:
--     the owner's failover setting, deciding a choice on its card, the
--     execution host's presence on every chat read, and live-activity
--     subjects. Same rules as the owner paths; the owner comes from the
--     credential of an active, unpaused Runtime.
-- ---------------------------------------------------------------------------

-- A run's step in fixed words ("Reviewing"), never agent text.
create function threadlink_private.run_subject(p_activity text, p_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when t is null then null else pg_catalog.upper(pg_catalog.left(t, 1)) || pg_catalog.substr(t, 2) end
  from (select threadlink_private.run_step_text(p_activity, p_role) as t) x
$$;

create or replace function threadlink_private.chat_api_live(p_chat_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'run_id', ar.id,
           'provider', ar.provider,
           'provider_name', coalesce(pr.display_name, ar.provider),
           'role', ar.role,
           'activity', ar.activity,
           'started_at', ar.started_at,
           'last_activity_at', ar.last_activity_at,
           -- 0.11: fixed words only ("Reviewing"), and the job's lane.
           'subject', threadlink_private.run_subject(ar.activity, ar.role),
           'lane', j.lane)
           order by ar.started_at nulls last, ar.id), '[]'::jsonb)
  from public.agent_runs ar
  join public.team_jobs j on j.id = ar.job_id and j.owner_user_id = ar.owner_user_id
  left join public.agent_providers pr on pr.id = ar.provider
  where j.chat_id = p_chat_id and j.finished_at is null and ar.status in ('queued', 'running')
$$;

-- The execution host of a chat as a client shows it (presence v2), or null.
create function threadlink_private.chat_api_host(p_chat_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'label', rt.label,
    'presence', threadlink_private.runtime_presence(rt),
    'last_seen_at', rt.last_seen_at)
  from public.chats c
  join public.rooms r on r.id = c.room_id and r.owner_user_id = c.owner_user_id and r.status <> 'deleted'
  join public.runtimes rt on rt.id = threadlink_private.room_runtime(r.id) and rt.owner_user_id = c.owner_user_id
  where c.id = p_chat_id
$$;

create or replace function public.runtime_get_chat(p_token_hash text, p_chat_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v public.chats := threadlink_private.chat_api_owned_chat(v_rt.owner_user_id, p_chat_id);
begin
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
  return threadlink_private.chat_api_summary(v.id, v_rt.id)
    || jsonb_build_object('activity', threadlink_private.chat_api_live(v.id),
                          'host', threadlink_private.chat_api_host(v.id),
                          'server_now', pg_catalog.now());
end;
$$;

create or replace function public.runtime_chat_events(
  p_token_hash text, p_chat_id text, p_after bigint, p_before bigint, p_limit integer, p_technical boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v public.chats := threadlink_private.chat_api_owned_chat(v_rt.owner_user_id, p_chat_id);
begin
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
  return threadlink_private.chat_api_page(v.id, p_after, p_before, p_limit, p_technical)
    || jsonb_build_object(
         'chat_id', v.id,
         -- 0.11: the running WORK job first (a Fast Chat reply may run beside it).
         'active_job', (select jsonb_build_object('job_id', j.id, 'mode', j.mode, 'status', j.status,
                                                  'lane', j.lane)
                        from public.team_jobs j
                        where j.chat_id = v.id and j.finished_at is null
                        order by (j.lane = 'work') desc, j.created_at desc limit 1),
         'activity', threadlink_private.chat_api_live(v.id),
         'deliveries', threadlink_private.chat_api_deliveries(v.id),
         'host', threadlink_private.chat_api_host(v.id),
         'server_now', pg_catalog.now());
end;
$$;

-- The owner's chats + the owner's settings (failover policy).
create or replace function public.runtime_list_chats(
  p_token_hash text, p_include_archived boolean, p_search text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
begin
  if v_search is not null and (char_length(v_search) > 100 or v_search ~ '[[:cntrl:]]') then
    raise exception 'invalid search' using errcode = '22023', hint = 'invalid';
  end if;
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
  return jsonb_build_object(
    'chats', coalesce((
      select jsonb_agg(threadlink_private.chat_api_summary(c.id, v_rt.id)
                       order by c.pinned_at desc nulls last, c.last_activity_at desc, c.id)
      from (select * from public.chats
            where owner_user_id = v_rt.owner_user_id and deleted_at is null
              and (coalesce(p_include_archived, false) or archived_at is null)
              and (v_search is null or name ilike '%' || pg_catalog.regexp_replace(v_search, '([\\%_])', '\\\1', 'g') || '%')
            order by pinned_at desc nulls last, last_activity_at desc, id
            limit 200) c), '[]'::jsonb),
    'projects', threadlink_private.chat_api_projects(v_rt.owner_user_id, v_rt.id),
    'runtime', threadlink_private.chat_api_runtime_json(v_rt),
    'settings', jsonb_build_object('failover_policy', threadlink_private.failover_policy_of(v_rt.owner_user_id)));
end;
$$;

-- The owner's failover policy from the desktop app (same rules as set_failover_policy).
create function public.runtime_set_failover_policy(p_token_hash text, p_policy text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
begin
  if p_policy is null or not (p_policy = any (threadlink_private.failover_policies())) then
    raise exception 'invalid policy' using errcode = '22023', hint = 'invalid';
  end if;
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'settings', 30);
  insert into public.user_settings (owner_user_id, failover_policy, updated_at)
  values (v_rt.owner_user_id, p_policy, pg_catalog.now())
  on conflict (owner_user_id) do update set failover_policy = excluded.failover_policy, updated_at = excluded.updated_at;
  perform threadlink_private.record_event(v_rt.owner_user_id, v_rt.connection_id, 'settings.updated', 'user_settings',
    v_rt.owner_user_id, jsonb_build_object('failover_policy', p_policy));
  return jsonb_build_object(
    'failover_policy', threadlink_private.failover_policy_of(v_rt.owner_user_id),
    'updated_at', (select s.updated_at from public.user_settings s where s.owner_user_id = v_rt.owner_user_id));
end;
$$;

create function public.runtime_get_settings(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
begin
  perform threadlink_private.owner_rate_limit(v_rt.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
  return jsonb_build_object(
    'failover_policy', threadlink_private.failover_policy_of(v_rt.owner_user_id),
    'updated_at', (select s.updated_at from public.user_settings s where s.owner_user_id = v_rt.owner_user_id));
end;
$$;

/*
 * The owner answers a choice on its card from the desktop app / terminal:
 * the dashboard's rules (decide_choice: any kind, only its own options, a
 * pending unexpired choice of a running job; start_work outlives its reply),
 * for a choice of THIS chat, from the computer the chat's project runs on
 * (deciding may start or steer work, like posting).
 */
create function public.runtime_decide_choice(p_token_hash text, p_chat_id text, p_choice_id text, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v public.chats := threadlink_private.chat_api_owned_chat(v_rt.owner_user_id, p_chat_id);
begin
  perform threadlink_private.chat_api_require_this_computer(v_rt, v.room_id);
  return threadlink_private.choice_decide(v_rt.owner_user_id, p_choice_id, p_key, v.id, false);
end;
$$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.run_subject(text, text)',
    'threadlink_private.chat_api_host(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.runtime_set_failover_policy(text, text)',
    'public.runtime_get_settings(text)',
    'public.runtime_decide_choice(text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;
end;
$grants$;

-- ---------------------------------------------------------------------------
-- 16. Unread (0.10 rule): a failover notice matters to the owner too.
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_counts_unread(p_author_kind text, p_event_type text, p_visibility text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_visibility = 'visible'
     and (p_author_kind in ('agent', 'controller')
          or (p_author_kind = 'threadlink'
              and p_event_type in ('job_summary', 'job_verdict', 'choice', 'finding', 'provider_blocked', 'timeout',
                                   'interrupted', 'failover')))
$$;

-- ---------------------------------------------------------------------------
-- 17. Redaction: "the <secret word> is <value>" only when the value looks like
--     a secret. Everything else is the 0.10 rule set, unchanged.
-- ---------------------------------------------------------------------------
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
  -- "the password is X", only when X looks like a secret (a digit in it, or
  -- 16+ characters, optionally quoted): "an expired token is still accepted"
  -- is prose and stays readable (0.11; mirrors runtime/src/summary.ts).
  t := pg_catalog.regexp_replace(t,
    '((password|passphrase|passwd|secret|token|api[ _-]?key)[[:space:]]+(is|was)[[:space:]]+)'
    || '(["''`]?[^[:space:]]*[0-9][^[:space:]]*|[^[:space:]]{16,})',
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
