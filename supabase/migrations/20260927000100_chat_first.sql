-- ===========================================================================
-- Chat-first ThreadLink: chats (the main experience), chat groups, provider
-- health gating, honest progress (last_phase), provider-neutral roles, the
-- owner's explicit retry, and chat-scoped routing for the owner and the
-- controller.
--
-- Contract: docs/design/chat-first.md sections 2-6. Shared TS types:
-- lib/chat/types.ts (0.9 additions).
--
-- Additive, like every migration since Production has real data:
--   * new tables chats / chat_groups; new nullable columns on team_jobs, tasks
--     and chat_events; nothing existing is dropped;
--   * the audit action allow-list is RE-STATED IN FULL as a superset;
--   * the verdict_reason check and the chat event-type check are re-stated as
--     supersets;
--   * functions from earlier migrations are replaced in place (same
--     signatures, grants preserved) or gain new overloads; the 0.8 room-keyed
--     post_chat_message keeps working and routes to the room's default chat;
--   * backfill: one default chat per existing room, and chat_id set on that
--     room's existing jobs and chat events (with the append-only / immutability
--     guards bypassed for exactly that update, and nothing else rewritten).
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
  -- New in chat-first.
  'chat.created', 'chat.updated', 'chat.archived', 'chat.restored', 'chat.deleted',
  'chat_group.created', 'chat_group.renamed', 'chat_group.deleted',
  'team.job_retried'
));

-- ---------------------------------------------------------------------------
-- 1. Vocabulary and bounds
-- ---------------------------------------------------------------------------
create or replace function threadlink_private.chat_event_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status',
               'plan_agreed', 'unit_status', 'finding', 'decision', 'job_verdict', 'task_started',
               'task_progress', 'task_completed', 'task_failed', 'task_cancelled', 'owner_routed',
               'stop_requested', 'model_used', 'model_mismatch', 'mode_changed', 'provider_blocked'] $$;
-- Mirrors PROVIDER_HEALTH in lib/chat/types.ts.
create function threadlink_private.provider_health_values() returns text[]
language sql immutable set search_path = '' as $$
  select array['ready', 'needs_sign_in', 'not_installed', 'api_key_auth', 'usage_exhausted', 'unknown'] $$;
-- A health check older than this proves nothing about the sign-in now.
create function threadlink_private.provider_health_max_age() returns interval
language sql immutable set search_path = '' as $$ select interval '2 hours' $$;
-- The ONLY details a Runtime may attach to a health result: its fixed
-- sentences (runtime/src/team/health.ts HEALTH_DETAIL). Anything else is
-- stored as null, so no provider output, URL or quote can ever be kept.
create function threadlink_private.provider_health_details() returns text[]
language sql immutable set search_path = '' as $$
  select array['Signed in and answering.', 'Needs you to sign in again on this computer.',
               'Not installed on this computer.',
               'Signed in with an API key, which would bill per use. Sign in with your subscription.',
               'Usage limit reached.', 'Not checked yet, or the check could not finish.'] $$;
create function threadlink_private.chat_max_per_owner() returns integer
language sql immutable set search_path = '' as $$ select 2000 $$;
create function threadlink_private.chat_creates_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 20 $$;
create function threadlink_private.chat_updates_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 60 $$;
create function threadlink_private.chat_mode_changes_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
create function threadlink_private.chat_group_max_per_owner() returns integer
language sql immutable set search_path = '' as $$ select 50 $$;
create function threadlink_private.chat_retries_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
-- Moving the read cursor (a page marks read as it polls; several tabs).
create function threadlink_private.chat_reads_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 240 $$;
-- The roles an owner (or a retry) may pin to a provider for one job.
create function threadlink_private.team_overridable_roles() returns text[]
language sql immutable set search_path = '' as $$
  select array['coordinator', 'planner', 'builder', 'reviewer', 'integrator'] $$;

-- { role: provider } with only overridable roles and known providers.
create function threadlink_private.valid_role_overrides(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 1024
    and not exists (
      select 1 from jsonb_each(p) e
      where not (e.key = any (threadlink_private.team_overridable_roles()))
         or jsonb_typeof(e.value) <> 'string'
         or not ((e.value #>> '{}') = any (threadlink_private.team_providers()))))
$$;

-- ---------------------------------------------------------------------------
-- 2. Provider health: what the Runtime may report, and what it means now
-- ---------------------------------------------------------------------------

-- Superset of the Team Mode rule: three new keys, each strictly shaped. The
-- health detail is one of the Runtime's fixed sentences (or null).
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
                       'health', 'healthCheckedAt', 'healthDetail')
     )
     -- No credential- or identity-shaped key anywhere in the document.
     and p::text !~* '"[^"]*(email|org|organi[sz]ation|account|uuid|user_?id|token|secret|password|api_?key|credential|cookie)[^"]*"[[:space:]]*:'
     -- ...and no email address as a value, under any key.
     and p::text !~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
     and (not (p ? 'health')
          or (jsonb_typeof(p -> 'health') = 'string'
              and (p ->> 'health') = any (threadlink_private.provider_health_values())))
     -- null: the Runtime never managed to check (reads as "not checked").
     and (not (p ? 'healthCheckedAt')
          or jsonb_typeof(p -> 'healthCheckedAt') = 'null'
          or (jsonb_typeof(p -> 'healthCheckedAt') = 'string'
              and (p ->> 'healthCheckedAt')
                  ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'))
     and (not (p ? 'healthDetail')
          or jsonb_typeof(p -> 'healthDetail') = 'null'
          or (jsonb_typeof(p -> 'healthDetail') = 'string'
              and (p ->> 'healthDetail') = any (threadlink_private.provider_health_details())))
$$;

/*
 * The health that counts NOW for one provider, from the owner stored
 * detection. Fails closed: anything not positively proven ready is not ready.
 *   no report                         -> unknown
 *   installed = false                 -> not_installed
 *   Runtime reported a failing health -> that health
 *   not signed in                     -> needs_sign_in
 *   signed in, but not by subscription -> api_key_auth
 *   no health, or not ready         -> unknown
 *   ready, but checked > 2 h ago      -> unknown   (checked = the earlier of the
 *                                         Runtime healthCheckedAt and the
 *                                         server own receipt time)
 */
create function threadlink_private.provider_effective_health(
  p_provider text, p_detected jsonb, p_detected_at timestamptz
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_health text := p_detected ->> 'health';
  v_checked timestamptz;
begin
  if p_detected is null or p_detected = '{}'::jsonb or p_detected_at is null then
    return 'unknown';
  end if;
  if jsonb_typeof(p_detected -> 'installed') = 'boolean' and not (p_detected ->> 'installed')::boolean then
    return 'not_installed';
  end if;
  if v_health in ('needs_sign_in', 'not_installed', 'api_key_auth', 'usage_exhausted') then
    return v_health;
  end if;
  if jsonb_typeof(p_detected -> 'installed') is distinct from 'boolean' then
    return 'unknown';
  end if;
  if jsonb_typeof(p_detected -> 'authenticated') is distinct from 'boolean'
     or not (p_detected ->> 'authenticated')::boolean then
    return 'needs_sign_in';
  end if;
  if (p_detected ->> 'authMethod') is distinct from (case p_provider when 'claude-code' then 'claude.ai'
                                                                    when 'codex' then 'chatgpt' end) then
    return 'api_key_auth';
  end if;
  if v_health is distinct from 'ready' then
    return 'unknown';
  end if;
  begin
    v_checked := (p_detected ->> 'healthCheckedAt')::timestamptz;
  exception when others then
    return 'unknown';
  end;
  if v_checked is null then
    return 'unknown';
  end if;
  v_checked := least(v_checked, p_detected_at);
  if v_checked < pg_catalog.now() - threadlink_private.provider_health_max_age() then
    return 'unknown';
  end if;
  return 'ready';
end;
$$;

create function threadlink_private.provider_health_ok(p_list jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_array_length(p_list) > 0
     and not exists (select 1 from jsonb_array_elements(p_list) e where e ->> 'health' <> 'ready')
$$;

-- Machine-readable, for the error DETAIL: "claude-code=needs_sign_in,codex=ready".
create function threadlink_private.provider_health_detail(p_list jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select string_agg((e ->> 'provider') || '=' || (e ->> 'health'), ',' order by o)
  from jsonb_array_elements(p_list) with ordinality as x(e, o)
$$;

-- One fixed sentence per provider and health. Built from ids and fixed text only.
create function threadlink_private.provider_health_sentence(p_provider text, p_health text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(threadlink_private.chat_provider_label(p_provider), 'An agent') || case p_health
    when 'ready' then ' is ready.'
    when 'needs_sign_in' then ' needs you to sign in again on this computer.'
    when 'not_installed' then ' is not installed on this computer.'
    when 'api_key_auth' then ' is signed in with an API key; sign in with your subscription instead.'
    when 'usage_exhausted' then ' has reached its usage limit.'
    else ' has not been checked recently. Open the ThreadLink app on this computer so it can check.' end
$$;

create function threadlink_private.provider_health_text(p_list jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select string_agg(threadlink_private.provider_health_sentence(e ->> 'provider', e ->> 'health'), ' ' order by o)
  from jsonb_array_elements(p_list) with ordinality as x(e, o)
$$;

-- ---------------------------------------------------------------------------
-- 3. Chats and chat groups
-- ---------------------------------------------------------------------------
create table public.chat_groups (
  id text primary key
    default threadlink_private.generate_id('tlgrp')
    constraint chat_groups_id_format check (id ~ '^tlgrp_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  name text not null
    constraint chat_groups_name_check check (char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
  sort integer not null default 0 constraint chat_groups_sort_check check (sort between 0 and 100000),
  created_at timestamptz not null default now(),
  constraint chat_groups_id_owner_key unique (id, owner_user_id)
);
comment on table public.chat_groups is 'A custom group of chats (the owner''s own sections). Owner-only.';
create unique index chat_groups_owner_name_idx on public.chat_groups (owner_user_id, lower(name));

create table public.chats (
  id text primary key
    default threadlink_private.generate_id('tlcht')
    constraint chats_id_format check (id ~ '^tlcht_[0-9a-f]{32}$'),
  owner_user_id text not null references public.users (id) on delete cascade,
  name text not null
    constraint chats_name_check check (char_length(name) between 1 and 100 and name !~ '[[:cntrl:]]'),
  -- The project, which is also the execution route. Null: a chat that can hold
  -- messages but cannot start work until it has a project.
  room_id text,
  group_id text,
  mode text not null default 'team' constraint chats_mode_check check (mode in ('solo', 'pair', 'team')),
  -- Null = chosen automatically when the work starts.
  solo_provider text constraint chats_solo_provider_check check (solo_provider in ('claude-code', 'codex')),
  builder_provider text
    constraint chats_builder_provider_check check (builder_provider in ('claude-code', 'codex')),
  reviewer_provider text
    constraint chats_reviewer_provider_check check (reviewer_provider in ('claude-code', 'codex')),
  pinned_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  last_activity_at timestamptz not null default now(),
  last_read_seq bigint not null default 0 constraint chats_last_read_seq_check check (last_read_seq >= 0),
  -- The chat controller work lands in when the controller names no chat.
  is_room_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chats_id_owner_key unique (id, owner_user_id),
  constraint chats_room_owner_fkey foreign key (room_id, owner_user_id)
    references public.rooms (id, owner_user_id) on delete cascade,
  constraint chats_group_owner_fkey foreign key (group_id, owner_user_id)
    references public.chat_groups (id, owner_user_id) on delete set null (group_id),
  constraint chats_default_has_room check (not is_room_default or room_id is not null),
  -- Never self-review.
  constraint chats_pair_distinct check (builder_provider is null or reviewer_provider is null
                                        or builder_provider <> reviewer_provider)
);
comment on table public.chats is
  'A ThreadLink chat: the main experience. Project (room) = execution route. Written only by owner RPCs.';
create unique index chats_room_default_idx on public.chats (room_id) where is_room_default and deleted_at is null;
create index chats_owner_activity_idx on public.chats (owner_user_id, last_activity_at desc) where deleted_at is null;
create index chats_room_idx on public.chats (room_id);
create index chats_group_idx on public.chats (group_id) where group_id is not null;

alter table public.chat_groups enable row level security;
alter table public.chats enable row level security;
revoke all on table public.chat_groups, public.chats from public, anon, authenticated;
grant select on table public.chat_groups, public.chats to authenticated;
create policy chat_groups_select_own on public.chat_groups for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
create policy chats_select_own on public.chats for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- Health per Runtime (per computer), as each Runtime last reported it. The
-- job-start gate reads the row of the Runtime that owns the project's agent
-- session. provider_profiles.detected stays the account's last report (display).
create table public.runtime_provider_health (
  runtime_id text not null,
  owner_user_id text not null,
  provider text not null
    constraint runtime_provider_health_provider_check check (provider in ('claude-code', 'codex')),
  detected jsonb not null
    constraint runtime_provider_health_detected_valid check (threadlink_private.valid_provider_detection(detected)),
  health text constraint runtime_provider_health_health_check check (health in (
    'ready', 'needs_sign_in', 'not_installed', 'api_key_auth', 'usage_exhausted', 'unknown')),
  checked_at timestamptz,
  detail text,
  received_at timestamptz not null default now(),
  primary key (runtime_id, provider),
  constraint runtime_provider_health_runtime_owner_fkey foreign key (runtime_id, owner_user_id)
    references public.runtimes (id, owner_user_id) on delete cascade
);
comment on table public.runtime_provider_health is
  'Provider health as each Runtime (computer) last reported it. Written only by report_provider_detection.';
create index runtime_provider_health_owner_idx on public.runtime_provider_health (owner_user_id);
alter table public.runtime_provider_health enable row level security;
revoke all on table public.runtime_provider_health from public, anon, authenticated;
grant select on table public.runtime_provider_health to authenticated;
create policy runtime_provider_health_select_own on public.runtime_provider_health for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- Owner actions that are cheap but must not be unbounded (pin, archive, read,
-- groups). Private: no client role can see or write it.
create table threadlink_private.owner_action_log (
  owner_user_id text not null references public.users (id) on delete cascade,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index owner_action_log_idx on threadlink_private.owner_action_log (owner_user_id, bucket, created_at);
revoke all on table threadlink_private.owner_action_log from public, anon, authenticated;

-- Counts one action; refuses (54000 rate_limited) past p_max per minute.
create function threadlink_private.owner_rate_limit(p_owner text, p_bucket text, p_max integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('threadlink:owner-rate:' || p_owner || ':' || p_bucket, 0));
  delete from threadlink_private.owner_action_log
  where owner_user_id = p_owner and bucket = p_bucket and created_at < pg_catalog.now() - interval '1 minute';
  if (select count(*) from threadlink_private.owner_action_log
      where owner_user_id = p_owner and bucket = p_bucket) >= p_max then
    raise exception 'too many changes' using errcode = '54000', hint = 'rate_limited';
  end if;
  insert into threadlink_private.owner_action_log (owner_user_id, bucket) values (p_owner, p_bucket);
end;
$$;

-- The Runtime a project runs on: the one owning the room's agent session.
-- Health is per computer: another computer's sign-in says nothing about this one.
create function threadlink_private.room_runtime(p_room_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select sb.runtime_id
  from public.rooms r
  join public.session_bindings sb on sb.id = r.agent_session_id and sb.owner_user_id = r.owner_user_id
  where r.id = p_room_id
$$;

-- [{provider, health}] for the given providers, in the given order, as the
-- project's OWN Runtime last reported them.
create function threadlink_private.provider_health_list(p_room_id text, p_providers text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', p.provider,
           'health', threadlink_private.provider_effective_health(p.provider, h.detected, h.received_at))
         order by p.ord), '[]'::jsonb)
  from unnest(p_providers) with ordinality as p(provider, ord)
  left join public.runtime_provider_health h
    on h.runtime_id = threadlink_private.room_runtime(p_room_id) and h.provider = p.provider
$$;

-- ---------------------------------------------------------------------------
-- 4. Columns on existing tables
-- ---------------------------------------------------------------------------
alter table public.team_jobs
  add column chat_id text,
  -- The last non-terminal status the job reached (honest progress: where it stopped).
  add column last_phase text
    constraint team_jobs_last_phase_check check (last_phase in (
      'queued', 'normalising', 'planning', 'building', 'reviewing', 'integrating', 'inspecting')),
  add column role_overrides jsonb
    constraint team_jobs_role_overrides_check check (threadlink_private.valid_role_overrides(role_overrides)),
  -- The provider a verdict reason is about (set by the Runtime; a participant).
  add column verdict_provider text
    constraint team_jobs_verdict_provider_check check (verdict_provider in ('claude-code', 'codex')),
  add column retried_from_job_id text,
  add constraint team_jobs_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id),
  -- No ON DELETE action: chats are only soft-deleted, and a SET NULL would be
  -- an update the job immutability guard refuses. Checked at statement end,
  -- so an account deletion cascade still removes both.
  add constraint team_jobs_retried_from_fkey foreign key (retried_from_job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id);
create index team_jobs_chat_idx on public.team_jobs (chat_id, created_at desc);
-- A blocked job is retried at most once.
create unique index team_jobs_retried_from_idx on public.team_jobs (retried_from_job_id)
  where retried_from_job_id is not null;

-- A controller's single task may name its chat (send_to_agent chatId).
alter table public.tasks
  add column chat_id text,
  add constraint tasks_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id);

alter table public.chat_events
  add column chat_id text,
  add constraint chat_events_chat_owner_fkey foreign key (chat_id, owner_user_id)
    references public.chats (id, owner_user_id) on delete cascade;
create index chat_events_chat_seq_idx on public.chat_events (chat_id, seq);
create index chat_events_chat_controller_idx on public.chat_events (chat_id, seq)
  where author_kind = 'controller';
create index chat_events_chat_owner_posts_idx on public.chat_events (chat_id, created_at)
  where author_kind = 'owner';

-- A chat with no project has no agent session. Only the owner's own words and
-- ThreadLink's fixed text may live there, never job or task rows.
alter table public.chat_events alter column agent_session_id drop not null;
alter table public.chat_events add constraint chat_events_session_or_chat check (
  agent_session_id is not null
  or (chat_id is not null and author_kind in ('owner', 'threadlink') and job_id is null and task_id is null));

alter table public.chat_events drop constraint chat_events_event_type_check;
alter table public.chat_events add constraint chat_events_event_type_check check (event_type in (
      'request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status', 'plan_agreed',
      'unit_status', 'finding', 'decision', 'job_verdict', 'task_started', 'task_progress', 'task_completed',
      'task_failed', 'task_cancelled', 'owner_routed', 'stop_requested', 'model_used', 'model_mismatch',
      'mode_changed', 'provider_blocked'));

-- chat_events stay append-only; chat_id, like job_id, may be filled in once.
create or replace function threadlink_private.chat_events_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'delivered_at' - 'job_id' - 'chat_id') is distinct from (to_jsonb(old) - 'delivered_at' - 'job_id' - 'chat_id')
     or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
     or (old.job_id is not null and new.job_id is distinct from old.job_id)
     or (old.chat_id is not null and new.chat_id is distinct from old.chat_id) then
    raise exception 'chat events are append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Identity now also covers the chat, the role overrides and the retry link.
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

-- ---------------------------------------------------------------------------
-- 5. Default chats, and chat_id carried from job/task/room to every row
-- ---------------------------------------------------------------------------

-- The room's default chat, created on first need. Null for a deleted room
-- without one (its history stays where it is).
create function threadlink_private.room_default_chat(p_room_id text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_id text;
begin
  if p_room_id is null then
    return null;
  end if;
  select id into v_id from public.chats where room_id = p_room_id and is_room_default and deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select * into v_room from public.rooms where id = p_room_id;
  if not found or v_room.status = 'deleted' then
    return null;
  end if;
  -- The same caps as create_chat: a default chat that keeps being deleted and
  -- remade is still a new chat. Past a cap there is no default chat (null);
  -- a job start then refuses with limit_reached.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('threadlink:chats:' || v_room.owner_user_id, 0));
  if (select count(*) from public.chats
      where owner_user_id = v_room.owner_user_id and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_creates_per_minute()
     or (select count(*) from public.chats where owner_user_id = v_room.owner_user_id and deleted_at is null)
        >= threadlink_private.chat_max_per_owner() then
    return null;
  end if;
  insert into public.chats (owner_user_id, name, room_id, is_room_default)
  values (v_room.owner_user_id, v_room.name, v_room.id, true)
  on conflict (room_id) where is_room_default and deleted_at is null do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.chats where room_id = p_room_id and is_room_default and deleted_at is null;
  end if;
  return v_id;
end;
$$;

create function threadlink_private.rooms_default_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform threadlink_private.room_default_chat(new.id);
  elsif new.status = 'deleted' and old.status <> 'deleted' then
    -- A deleted project takes its default chat with it (history kept, hidden).
    update public.chats set deleted_at = pg_catalog.now(), pinned_at = null, updated_at = pg_catalog.now()
    where room_id = new.id and is_room_default and deleted_at is null;
  end if;
  return null;
end;
$$;

-- Jobs: the chat (the room's default when the caller named none) and the
-- last non-terminal phase reached.
create function threadlink_private.team_jobs_chat_phase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.chat_id is null then
      new.chat_id := threadlink_private.room_default_chat(new.room_id);
    end if;
    new.last_phase := case when threadlink_private.team_phase_rank(new.status) is not null then new.status end;
  elsif new.status is distinct from old.status
        and threadlink_private.team_phase_rank(new.status) is not null then
    new.last_phase := new.status;
  end if;
  return new;
end;
$$;

-- Tasks: a chat named by create_chat_task (transaction-local), re-checked
-- against the task's own owner and route.
create function threadlink_private.tasks_assign_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chat text := nullif(pg_catalog.current_setting('threadlink.task_chat_id', true), '');
begin
  if v_chat is not null and new.task_type <> 'team' then
    if not exists (
      select 1 from public.chats c
      join public.rooms r on r.id = c.room_id
      where c.id = v_chat and c.owner_user_id = new.owner_user_id and c.deleted_at is null
        and r.status <> 'deleted' and r.agent_session_id = new.target_session_id) then
      raise exception 'chat not found' using errcode = 'P0002';
    end if;
    new.chat_id := v_chat;
  end if;
  return new;
end;
$$;

-- Chat rows: the chat comes from the job, else the task, else the room's
-- default chat. A caller-named chat (owner RPCs) is kept; the composite
-- foreign key keeps it the same owner's.
create function threadlink_private.chat_events_assign_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.chat_id is null and new.job_id is not null then
    select chat_id into new.chat_id from public.team_jobs where id = new.job_id;
  end if;
  if new.chat_id is null and new.task_id is not null then
    select chat_id into new.chat_id from public.tasks where id = new.task_id;
  end if;
  if new.chat_id is null and new.room_id is not null then
    new.chat_id := threadlink_private.room_default_chat(new.room_id);
  end if;
  return new;
end;
$$;

create function threadlink_private.chat_events_touch_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.chat_id is not null and new.visibility = 'visible' then
    update public.chats set last_activity_at = greatest(last_activity_at, new.created_at)
    where id = new.chat_id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Backfill (Production has data): one default chat per existing room, and
--    chat_id on that room's jobs and chat rows. Nothing else is rewritten.
-- ---------------------------------------------------------------------------
-- The room's default chat for the backfill: the live one, else the newest
-- deleted one (a deleted room's history).
create function threadlink_private.chat_first_default_of(p_room_id text)
returns text
language sql
stable
set search_path = ''
as $$
  select id from public.chats
  where room_id = p_room_id and is_room_default
  order by deleted_at desc nulls first, created_at desc
  limit 1
$$;
revoke all on function threadlink_private.chat_first_default_of(text) from public, anon, authenticated, service_role;

/*
 * Idempotent: only rooms without a default chat, and only rows whose chat_id
 * is still null, are touched. Kept as a function so the database tests can
 * run it against fixture data shaped like Production before this migration.
 */
create function threadlink_private.chat_first_backfill()
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_chats integer;
  v_jobs integer;
  v_events integer;
begin
  insert into public.chats
    (owner_user_id, name, room_id, is_room_default, created_at, updated_at, last_activity_at, last_read_seq,
     deleted_at)
  select r.owner_user_id, r.name, r.id, true, r.created_at, r.updated_at,
         greatest(r.created_at, coalesce((select max(e.created_at) from public.chat_events e where e.room_id = r.id),
                                         r.updated_at)),
         -- Existing history counts as read: nobody is shown old rows as unread.
         coalesce((select max(e.seq) from public.chat_events e where e.room_id = r.id), 0),
         r.deleted_at
  from public.rooms r
  where not exists (select 1 from public.chats c where c.room_id = r.id and c.is_room_default);
  get diagnostics v_chats = row_count;

  -- Finished jobs are immutable by trigger; this one update is the migration's
  -- own, sets only chat_id and last_phase, and leaves updated_at alone.
  execute 'alter table public.team_jobs disable trigger team_jobs_guard_update';
  execute 'alter table public.team_jobs disable trigger team_jobs_touch_updated_at';
  execute 'alter table public.team_jobs disable trigger chat_on_job_update';
  update public.team_jobs j
  set chat_id = threadlink_private.chat_first_default_of(j.room_id),
      -- Only a job still running says truthfully where it is; a finished job's
      -- last phase was never recorded and stays unknown (null).
      last_phase = case when j.finished_at is null
                         and threadlink_private.team_phase_rank(j.status) is not null then j.status end
  where j.chat_id is null and threadlink_private.chat_first_default_of(j.room_id) is not null;
  get diagnostics v_jobs = row_count;
  execute 'alter table public.team_jobs enable trigger team_jobs_guard_update';
  execute 'alter table public.team_jobs enable trigger team_jobs_touch_updated_at';
  execute 'alter table public.team_jobs enable trigger chat_on_job_update';

  update public.chat_events e
  set chat_id = coalesce((select j.chat_id from public.team_jobs j where j.id = e.job_id),
                         threadlink_private.chat_first_default_of(e.room_id))
  where e.chat_id is null and e.room_id is not null
    and threadlink_private.chat_first_default_of(e.room_id) is not null;
  get diagnostics v_events = row_count;
  return jsonb_build_object('chats', v_chats, 'jobs', v_jobs, 'events', v_events);
end;
$$;
revoke all on function threadlink_private.chat_first_backfill() from public, anon, authenticated, service_role;
select threadlink_private.chat_first_backfill();

-- Triggers go on after the backfill.
create trigger rooms_default_chat after insert or update of status on public.rooms
  for each row execute function threadlink_private.rooms_default_chat();
create trigger team_jobs_chat_phase before insert or update on public.team_jobs
  for each row execute function threadlink_private.team_jobs_chat_phase();
create trigger tasks_assign_chat before insert on public.tasks
  for each row execute function threadlink_private.tasks_assign_chat();
create trigger chat_events_assign_chat before insert on public.chat_events
  for each row execute function threadlink_private.chat_events_assign_chat();
create trigger chat_events_touch_chat after insert on public.chat_events
  for each row execute function threadlink_private.chat_events_touch_chat();

-- ---------------------------------------------------------------------------
-- 7. Provider-neutral roles (section 4): the old seeded defaults were never
--    chosen by anyone; they become the full role set (no preference).
-- ---------------------------------------------------------------------------
update public.room_agents
set default_roles = threadlink_private.team_roles()
where (provider = 'claude-code' and default_roles = array['planner', 'builder', 'reviewer', 'integrator']::text[])
   or (provider = 'codex'
       and default_roles = array['builder', 'reviewer', 'security_reviewer', 'test_reviewer']::text[]);

-- ---------------------------------------------------------------------------
-- 8. Team status: + chat, last phase, role overrides, verdict reason/provider
--    and the retry link (the Runtime and the dashboard read these).
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
-- 9. Verdict reasons: + agent_needs_sign_in, api_key_auth (superset).
--    Mirrors lib/team/model.ts VERDICT_REASONS and runtime verdict-reasons.ts.
-- ---------------------------------------------------------------------------
alter table public.team_jobs drop constraint team_jobs_verdict_reason_check;
alter table public.team_jobs add constraint team_jobs_verdict_reason_check check (verdict_reason in ('tests_failed', 'review_not_passed', 'agents_disagree', 'dependency_not_finished', 'plan_blocked', 'agent_unavailable', 'agent_not_in_project', 'usage_exhausted', 'model_mismatch', 'access_mismatch', 'agent_timed_out', 'agent_failed', 'changed_during_review', 'inspection_found_issues', 'no_review_or_tests', 'stopped_by_owner', 'unexpected_error', 'merge_conflict', 'no_suitable_model', 'agent_needs_sign_in', 'api_key_auth'));

create or replace function threadlink_private.chat_reason_text(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_code
    when 'tests_failed' then 'ThreadLink''s own tests failed on the result.'
    when 'review_not_passed' then 'A unit did not pass review within the round limit.'
    when 'agents_disagree' then 'The agents disagree and could not settle it within the round limit.'
    when 'dependency_not_finished' then 'Work a unit depends on did not finish.'
    when 'plan_blocked' then 'The reviewer judged the plan cannot proceed.'
    when 'agent_unavailable' then 'An agent this job needs is not installed or not signed in on your computer.'
    when 'agent_not_in_project' then 'An agent this job needs is not part of this project.'
    when 'usage_exhausted' then 'An agent''s plan usage ran out. ThreadLink waits rather than switching agents or paying.'
    when 'model_mismatch' then 'An agent ran a different model than ThreadLink chose, so its work was not used.'
    when 'access_mismatch' then 'An agent could not be confirmed to run with the access ThreadLink asked for, so its work was not used.'
    when 'agent_timed_out' then 'An agent did not finish in time.'
    when 'agent_failed' then 'An agent failed or did not answer in the required format.'
    when 'changed_during_review' then 'The work changed while it was being reviewed.'
    when 'inspection_found_issues' then 'The final inspection found problems.'
    when 'no_review_or_tests' then 'Nothing reviewed or tested this work: check it yourself, or add test commands in the project settings.'
    when 'stopped_by_owner' then 'Stopped by you.'
    when 'unexpected_error' then 'The Runtime stopped because of an unexpected error.'
    when 'merge_conflict' then 'Two pieces of work conflict and need your decision.'
    when 'no_suitable_model' then 'No model fits this step under your usage policy; choose one in the project settings.'
    when 'agent_needs_sign_in' then 'An agent needs you to sign in again on this computer.'
    when 'api_key_auth' then 'An agent is signed in with an API key, which would bill per use; ThreadLink did not use it.'
    else null end
$$;

-- The same reason naming the provider (from trusted state: the job's
-- verdict_provider, a participant). Null when there is no provider version.
create function threadlink_private.chat_provider_reason_text(p_code text, p_provider text)
returns text
language sql
immutable
set search_path = ''
as $$
  select threadlink_private.chat_provider_label(p_provider) || case p_code
    when 'agent_needs_sign_in' then ' needs you to sign in again on this computer.'
    when 'api_key_auth' then ' is signed in with an API key, which would bill per use; ThreadLink did not use it.'
    when 'agent_unavailable' then ' is not installed or not signed in on your computer.'
    when 'usage_exhausted' then '''s plan usage ran out. ThreadLink waits rather than switching agents or paying.'
    when 'agent_timed_out' then ' did not finish in time.'
    when 'agent_failed' then ' failed or did not answer in the required format.'
    when 'model_mismatch' then ' ran a different model than ThreadLink chose, so its work was not used.'
    else null end
$$;

create or replace function threadlink_private.chat_on_job_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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
    end if;
  exception when others then
    raise warning 'threadlink chat: job update not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Starting a job: provider-neutral participants, the chat, role
--     overrides, and the provider health gate (section 2).
-- ---------------------------------------------------------------------------

/*
 * An enabled agent of the room to work on something, chosen without favouring
 * any provider: a ready one first, then the one that built least recently in
 * this room (so load alternates), then a stable order. Null when none.
 */
create function threadlink_private.team_pick_provider(p_owner text, p_room_id text, p_exclude text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.provider
  from public.room_agents a
  left join public.runtime_provider_health h
    on h.runtime_id = threadlink_private.room_runtime(p_room_id) and h.provider = a.provider
  where a.room_id = p_room_id and a.owner_user_id = p_owner and a.enabled and a.provider is distinct from p_exclude
  order by (threadlink_private.provider_effective_health(a.provider, h.detected, h.received_at) = 'ready') desc,
           (select max(j.created_at) from public.team_jobs j
            where j.room_id = p_room_id and j.builder_provider = a.provider) asc nulls first,
           a.provider
  limit 1
$$;

/*
 * The route checks both job-start paths share, in the order the user can act
 * on them: the link exists and is usable, it is not paused, and the Runtime is
 * new enough for the mode.
 */
create function threadlink_private.team_route_check(
  p_owner text, p_room public.rooms, p_link public.thread_links, p_mode text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_runtime_version text;
begin
  if p_link.id is null or p_link.owner_user_id <> p_owner or p_link.status <> 'active'
     or p_link.agent_session_id is distinct from p_room.agent_session_id
     or not threadlink_private.session_is_usable(p_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002', hint = 'route_missing';
  end if;
  if p_link.paused then
    raise exception 'link is paused' using errcode = '55000', hint = 'link_paused';
  end if;
  select r.version into v_runtime_version
  from public.session_bindings sb
  join public.runtimes r on r.id = sb.runtime_id
  where sb.id = p_room.agent_session_id and sb.owner_user_id = p_owner;
  if not threadlink_private.version_at_least(v_runtime_version, 0,
                                             threadlink_private.team_min_runtime_minor(p_mode)) then
    raise exception 'team mode unavailable: update the ThreadLink app on the computer this project runs on'
      using errcode = '55000', hint = 'runtime_outdated';
  end if;
end;
$$;

/*
 * Who takes part: solo = the builder; pair = builder + reviewer; team = every
 * enabled agent. A missing builder/reviewer is picked provider-neutrally.
 * Returns {mode, builder, reviewer, participants[]} or raises
 * agent_not_in_project.
 */
create function threadlink_private.team_participants(
  p_owner text, p_room_id text, p_mode text, p_builder text, p_reviewer text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_builder text := p_builder;
  v_reviewer text := p_reviewer;
  v_participants text[];
begin
  if p_mode = 'team' then
    select coalesce(array_agg(provider order by provider), '{}') into v_participants
    from public.room_agents where room_id = p_room_id and enabled;
    v_builder := null;
    v_reviewer := null;
  else
    if v_builder is null then
      v_builder := threadlink_private.team_pick_provider(p_owner, p_room_id,
                                                         case when p_mode = 'pair' then v_reviewer end);
    end if;
    if p_mode = 'pair' then
      v_reviewer := coalesce(v_reviewer, threadlink_private.team_pick_provider(p_owner, p_room_id, v_builder));
    else
      v_reviewer := null;
    end if;
    if v_builder is null or (p_mode = 'pair' and (v_reviewer is null or v_reviewer = v_builder)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
    v_participants := array_remove(array[v_builder, v_reviewer], null);
    if exists (select 1 from unnest(v_participants) p
               where not exists (select 1 from public.room_agents a
                                 where a.room_id = p_room_id and a.provider = p and a.enabled)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
  end if;
  if cardinality(v_participants) = 0 then
    raise exception 'this project has no agents' using errcode = '55000', hint = 'agent_not_in_project';
  end if;
  return jsonb_build_object('mode', p_mode, 'builder', v_builder, 'reviewer', v_reviewer,
                            'participants', to_jsonb(v_participants));
end;
$$;

/*
 * Creates the carrier task (task_type team) over p_link and the team job,
 * atomically, in p_chat_id (the rooms default chat when null). As in 0.8
 * plus: the chat is the same owners and in this room; role overrides name
 * participants only; and every participant must be READY (a recent,
 * authenticated health check), otherwise 55000 / hint provider_unhealthy with
 * DETAIL "provider=health,..." and nothing is created.
 */
create function threadlink_private.team_start_job_v2(
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
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_goal text := pg_catalog.btrim(p_goal);
  v_mode text := coalesce(p_mode, 'team');
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
  -- Replay first: a retried controller request returns the job it made, even
  -- if an agent became unhealthy or the chat got busy since.
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
  -- A project that requires review cannot be bypassed by a controller asking
  -- for a solo job. Only the owner may choose solo there, explicitly.
  if v_mode = 'solo' and p_origin <> 'owner' and p_room.cross_review then
    raise exception 'This project requires review; use Builder + Reviewer or Team'
      using errcode = '42501', hint = 'review_required';
  end if;

  -- The chat: the caller's (same owner, same project, not deleted), else the
  -- project's default chat. Another account's chat is "not found". The chat
  -- row is LOCKED and re-checked, so a start and an owner post in the same
  -- chat are serialised and see each other's job.
  v_chat_id := coalesce(p_chat_id, threadlink_private.room_default_chat(p_room.id));
  if v_chat_id is null then
    -- The default chat could not be made (the owner's chat caps).
    raise exception 'chat limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  select * into v_chat from public.chats where id = v_chat_id for update;
  if not found or v_chat.owner_user_id <> p_owner or v_chat.deleted_at is not null
     or v_chat.room_id is distinct from p_room.id then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  -- One running job per chat. The one exception is 0.8 parity: a controller
  -- that names no chat may run several jobs in a project's default chat.
  if not (p_origin = 'controller' and p_chat_id is null)
     and exists (select 1 from public.team_jobs where chat_id = v_chat.id and finished_at is null) then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;

  v_who := threadlink_private.team_participants(p_owner, p_room.id, v_mode, p_builder, p_reviewer);
  v_builder := v_who ->> 'builder';
  v_reviewer := v_who ->> 'reviewer';
  select coalesce(array_agg(value order by ord), '{}') into v_participants
  from jsonb_array_elements_text(v_who -> 'participants') with ordinality as x(value, ord);

  -- Overrides may only name the people taking part.
  if p_role_overrides is not null and exists (
       select 1 from jsonb_each_text(p_role_overrides) e where not (e.value = any (v_participants))) then
    raise exception 'a role override names an agent not in this job' using errcode = '22023',
      hint = 'invalid_roles';
  end if;

  perform threadlink_private.team_route_check(p_owner, p_room, p_link, v_mode);

  -- The health gate: every participant ready, checked recently, with a real
  -- authenticated call. Status output is not proof. Never substitutes.
  v_health := threadlink_private.provider_health_list(p_room.id, v_participants);
  if not threadlink_private.provider_health_ok(v_health) then
    raise exception 'an agent this job needs is not ready'
      using errcode = '55000', hint = 'provider_unhealthy',
            detail = threadlink_private.provider_health_detail(v_health);
  end if;

  -- Paid usage only from the owner's profiles: on only if on for every participant.
  select coalesce(bool_and(coalesce(pp.paid_usage_enabled, false)), false) into v_paid
  from unnest(v_participants) p(provider)
  left join public.provider_profiles pp on pp.owner_user_id = p_owner and pp.provider = p.provider;

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
    -- New in chat-first (optional for a Runtime that predates them).
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
    'verifyCommands', to_jsonb(v_verify)
  );
  if octet_length(v_content::text) > 65536 then
    raise exception 'team job is too large' using errcode = '22023';
  end if;

  -- The same caps create_task applies.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:tasks:' || p_link.id, 0));
  select count(*) into v_open from public.tasks
  where thread_link_id = p_link.id and status in ('queued', 'claimed', 'working');
  if v_open >= threadlink_private.max_open_tasks_per_link() then
    raise exception 'open task limit reached for this link' using errcode = '54000', hint = 'rate_limited';
  end if;
  select count(*) into v_recent from public.tasks
  where origin_session_id = p_link.controller_session_id
    and created_at > pg_catalog.now() - threadlink_private.task_rate_window();
  if v_recent >= threadlink_private.max_tasks_per_window() then
    raise exception 'task creation rate limit reached' using errcode = '54000', hint = 'rate_limited';
  end if;

  perform pg_catalog.set_config('threadlink.creating_team_job', 'on', true);
  insert into public.tasks
    (owner_user_id, thread_link_id, origin_session_id, target_session_id,
     priority, task_type, title, content, idempotency_key, expires_at)
  values
    (p_owner, p_link.id, p_link.controller_session_id, p_link.agent_session_id,
     'C', 'team', pg_catalog.left(pg_catalog.regexp_replace(v_goal, '[[:space:]]+', ' ', 'g'), 255),
     v_content::text, p_task_idempotency_key, pg_catalog.now() + interval '604800 seconds')
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
     chat_id, role_overrides, retried_from_job_id)
  values
    (v_job_id, p_owner, p_room.id, v_task_id, v_goal, p_spec,
     v_planning, v_review, v_parallel, v_verify, v_mode, v_builder, p_origin,
     v_chat.id, p_role_overrides, p_retried_from_job_id);

  perform threadlink_private.record_event(
    p_owner, p_actor_connection_id, 'team.job_started', 'team_job', v_job_id,
    jsonb_build_object('room_id', p_room.id, 'task_id', v_task_id, 'mode', v_mode, 'origin', p_origin,
                       'chat_id', v_chat.id));
  return threadlink_private.team_status_json(v_job_id) || jsonb_build_object('created', true);
end;
$$;

-- The 0.8 private entry point, unchanged in meaning: the room's default chat.
create or replace function threadlink_private.team_start_job(
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
  p_task_idempotency_key text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_v2(
    p_owner, p_actor_connection_id, p_origin, p_room, p_link, p_goal, p_spec, p_max_planning_rounds,
    p_max_review_rounds, p_parallel_agents, p_mode, p_builder, null, p_task_idempotency_key, null, null, null)
$$;

-- The controller path, now with an optional chat (same owner, same room).
create function threadlink_private.team_start_job_from_controller_v2(
  p_token_hash text,
  p_session_id text,
  p_room_id text,
  p_goal text,
  p_spec jsonb,
  p_max_planning_rounds integer,
  p_max_review_rounds integer,
  p_parallel_agents integer,
  p_verify_commands text[],
  p_idempotency_key text,
  p_mode text,
  p_builder text,
  p_chat_id text
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
  v_result jsonb;
begin
  -- ThreadLink runs verify commands itself, outside any agent sandbox: only the
  -- owner sets them (room policy). A command from a chat is refused outright.
  if p_verify_commands is not null then
    raise exception 'test commands are set by the project owner in the project settings'
      using errcode = '42501';
  end if;
  if p_chat_id is not null and p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  if v_room.status <> 'active' then
    raise exception 'room is not active' using errcode = '55000';
  end if;
  -- The room's route: the CALLER's own active link to the room's agent session.
  select * into v_link from public.thread_links
  where controller_session_id = v_session.id and agent_session_id = v_room.agent_session_id
    and owner_user_id = v_connection.owner_user_id and status = 'active'
  for share;
  if not found then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;
  v_result := threadlink_private.team_start_job_v2(
    v_connection.owner_user_id, v_connection.id, 'controller', v_room, v_link,
    p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds, p_parallel_agents,
    p_mode, p_builder, null, p_idempotency_key, p_chat_id, null, null);
  perform threadlink_private.touch_session(v_session.id);
  return v_result;
end;
$$;

create or replace function threadlink_private.team_start_job_from_controller(
  p_token_hash text,
  p_session_id text,
  p_room_id text,
  p_goal text,
  p_spec jsonb,
  p_max_planning_rounds integer,
  p_max_review_rounds integer,
  p_parallel_agents integer,
  p_verify_commands text[],
  p_idempotency_key text,
  p_mode text,
  p_builder text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_from_controller_v2(
    p_token_hash, p_session_id, p_room_id, p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds,
    p_parallel_agents, p_verify_commands, p_idempotency_key, p_mode, p_builder, null)
$$;

-- With a chat. Every argument is required (no defaults), so older calls keep
-- resolving to the 10- and 12-argument overloads.
create function public.start_team_job(
  p_token_hash text,
  p_session_id text,
  p_room_id text,
  p_goal text,
  p_spec jsonb,
  p_max_planning_rounds integer,
  p_max_review_rounds integer,
  p_parallel_agents integer,
  p_verify_commands text[],
  p_idempotency_key text,
  p_mode text,
  p_builder text,
  p_chat_id text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_from_controller_v2(
    p_token_hash, p_session_id, p_room_id, p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds,
    p_parallel_agents, p_verify_commands, p_idempotency_key, p_mode, p_builder, p_chat_id)
$$;

/*
 * send_to_agent in a chat: an ordinary task (create_task, every routing rule
 * unchanged) that lands in the named chat. The chat must be the caller
 * accounts, not deleted, and in a live project whose agent session is the
 * target of the caller link. Otherwise "not found", and nothing is created.
 */
create function public.create_chat_task(
  p_token_hash text,
  p_origin_session_id text,
  p_thread_link_id text,
  p_chat_id text,
  p_title text,
  p_content text,
  p_priority text,
  p_idempotency_key text,
  p_expires_in_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_result jsonb;
begin
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' or not exists (
       select 1 from public.chats c
       join public.rooms r on r.id = c.room_id
       join public.thread_links l on l.agent_session_id = r.agent_session_id
       where c.id = p_chat_id and c.owner_user_id = v_connection.owner_user_id and c.deleted_at is null
         and r.owner_user_id = v_connection.owner_user_id and r.status = 'active'
         and l.id = p_thread_link_id and l.owner_user_id = v_connection.owner_user_id
         and l.controller_session_id = p_origin_session_id) then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  perform pg_catalog.set_config('threadlink.task_chat_id', p_chat_id, true);
  v_result := public.create_task(p_token_hash, p_origin_session_id, p_thread_link_id, p_title, p_content,
                                 coalesce(p_priority, 'C'), 'general', p_idempotency_key, p_expires_in_seconds);
  perform pg_catalog.set_config('threadlink.task_chat_id', '', true);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Runtime write: set_final gains an optional `provider` (verdict_provider).
--     Otherwise identical to collaboration chat; last_phase is kept by the
--     team_jobs_chat_phase trigger on every status change, whatever the path.
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
                                                  'round', 'body', 'model_observed']);
    -- What the Runtime observed the model to be (never what it asked for).
    v_text := threadlink_private.tj_text(v_p, 'model_observed', 100, false);
    if v_text is not null and v_text !~ threadlink_private.chat_model_pattern() then
      raise exception 'invalid model_observed' using errcode = '22023';
    end if;
    insert into public.team_messages
      (owner_user_id, job_id, node_id, sender, sender_role, receiver, message_type, round, body, model_observed)
    values
      (v_job.owner_user_id, v_job.id,
       threadlink_private.team_node_id(v_job.id, threadlink_private.tj_text(v_p, 'node_key', 64, false)),
       threadlink_private.tj_enum(v_p, 'sender', array['claude-code', 'codex', 'threadlink'], true),
       threadlink_private.tj_enum(v_p, 'sender_role', threadlink_private.team_roles(), false),
       threadlink_private.tj_enum(v_p, 'receiver', array['claude-code', 'codex', 'threadlink'], false),
       threadlink_private.tj_enum(v_p, 'type', threadlink_private.team_message_types(), true),
       coalesce(threadlink_private.tj_int(v_p, 'round', 0, 6, false),
                greatest(v_job.planning_round, v_job.review_round)),
       threadlink_private.tj_text(v_p, 'body', threadlink_private.team_body_max_bytes(), true),
       v_text)
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
    if v_round is not null and v_round <= v_count then
      return threadlink_private.team_status_json(v_job.id)
        || jsonb_build_object('op', p_op, 'result', jsonb_build_object('round', v_count, 'opened', false));
    end if;
    if v_round is not null and v_round <> v_count + 1 then
      raise exception 'rounds open one at a time' using errcode = '22023';
    end if;
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
    perform threadlink_private.tj_keys(v_p, array['limit']);
    v_count := coalesce(threadlink_private.tj_int(v_p, 'limit', 1, 20, false), 20);
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
      update public.chat_events set delivered_at = pg_catalog.now() where id = v_note.id;
      v_notes := v_notes || jsonb_build_array(jsonb_build_object(
        'id', v_note.id, 'seq', v_note.seq, 'audience', v_note.audience, 'body', v_note.body,
        'created_at', v_note.created_at));
      perform threadlink_private.chat_job_event(v_job, 'owner_routed',
        'Your note was passed to ' || case v_note.audience when 'team' then 'the team'
          else coalesce(threadlink_private.chat_provider_label(v_note.audience), 'the team') end || '.',
        'visible');
    end loop;
    v_result := jsonb_build_object('notes', v_notes);

  else
    raise exception 'invalid op' using errcode = '22023';
  end case;

  return threadlink_private.team_status_json(v_job.id) || jsonb_build_object('op', p_op, 'result', v_result);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Owner messages keyed by chat. The chat's mode drives routing; a leading
--     @mention overrides it for one message. The 0.8 room-keyed entry point
--     routes to the room's default chat with its 0.8 hint semantics.
-- ---------------------------------------------------------------------------

create function threadlink_private.chat_json(p_chat_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'chat_id', c.id,
    'name', c.name,
    'mode', c.mode,
    'room_id', c.room_id,
    'project_name', case when r.status <> 'deleted' then r.name end,
    'project_status', r.status,
    'group_id', c.group_id,
    'group_name', g.name,
    'solo_provider', c.solo_provider,
    'builder_provider', c.builder_provider,
    'reviewer_provider', c.reviewer_provider,
    'pinned', c.pinned_at is not null,
    'pinned_at', c.pinned_at,
    'archived', c.archived_at is not null,
    'archived_at', c.archived_at,
    'is_room_default', c.is_room_default,
    'last_activity_at', c.last_activity_at,
    'last_read_seq', c.last_read_seq,
    'created_at', c.created_at,
    'updated_at', c.updated_at)
  from public.chats c
  left join public.rooms r on r.id = c.room_id
  left join public.chat_groups g on g.id = c.group_id
  where c.id = p_chat_id
$$;

-- The caller's own live chat, locked. Anything else is "not found".
create function threadlink_private.require_owned_chat(p_chat_id text)
returns public.chats
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v public.chats;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  select * into v from public.chats
  where id = p_chat_id and owner_user_id = v_owner and deleted_at is null
  for update;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  return v;
end;
$$;

-- A ThreadLink row in a chat (fixed text only), with or without a project.
create function threadlink_private.chat_note(
  p_chat public.chats, p_room_id text, p_event_type text, p_body text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_body text := threadlink_private.chat_clean(p_body, 2000);
begin
  if v_body is null then
    return null;
  end if;
  insert into public.chat_events
    (owner_user_id, chat_id, room_id, agent_session_id, author_kind, author_label, event_type, body, visibility)
  values
    (p_chat.owner_user_id, p_chat.id, p_room_id,
     (select r.agent_session_id from public.rooms r where r.id = p_room_id and r.status <> 'deleted'),
     'threadlink', 'ThreadLink', p_event_type, v_body, 'visible')
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * The one owner-post path. p_legacy = the 0.8 room-keyed call (mode/builder
 * hints as in 0.8, no chat mode); otherwise the chats mode decides.
 *
 *   active job in the chat + "@team stop..." -> stop requested
 *   active job in the chat + anything else   -> an owner note for that job
 *   no active job, no project                -> needs_project (nothing stored)
 *   no active job, an agent not ready        -> the message + a provider_blocked
 *                                               row are stored; NO job or task
 *   no active job                            -> a new job in this chat
 *
 * Failures raise with a stable HINT; the server chooses the sentence.
 */
create function threadlink_private.chat_post(
  p_owner text,
  p_chat_id text,
  p_body text,
  p_mode text,
  p_builder text,
  p_idempotency_key text,
  p_legacy boolean
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
  v_goal text;
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
begin
  if p_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  -- Lock order: the project first, then the chat (as the room-keyed path).
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
        'routed', case when v_prev.event_type = 'request' and v_prev.job_id is null then 'provider_blocked'
                       when v_prev.event_type = 'request' then 'new_job'
                       when v_prev.body ~* threadlink_private.chat_stop_pattern() then 'stop_requested'
                       else 'note_to_active_job' end,
        'job_id', v_prev.job_id, 'event_id', v_prev.id, 'chat_id', v_chat.id, 'replayed', true);
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
  if p_mode is not null and not (p_mode = any (array['solo', 'pair', 'team'])) then
    raise exception 'invalid mode' using errcode = '22023', hint = 'invalid_mode';
  end if;
  if p_builder is not null and not (p_builder = any (threadlink_private.team_providers())) then
    raise exception 'invalid builder' using errcode = '22023', hint = 'invalid_builder';
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

  -- What is shown and stored: cleaned and redacted.
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

  -- A running job in THIS chat takes notes and stop requests (wherever the
  -- chat's project is now: the job keeps the project it started in).
  select * into v_job from public.team_jobs
  where chat_id = v_chat.id and owner_user_id = p_owner and finished_at is null
  order by created_at desc
  limit 1
  for update;

  if found then
    select t.target_session_id into v_session from public.tasks t where t.id = v_job.task_id;
    if v_body ~* threadlink_private.chat_stop_pattern() then
      insert into public.chat_events
        (owner_user_id, chat_id, room_id, agent_session_id, job_id, author_kind, author_label, audience,
         event_type, body, visibility, delivered_at, idempotency_key)
      values
        (p_owner, v_chat.id, v_job.room_id, v_session, v_job.id, 'owner', 'You', 'team', 'message',
         v_body, 'visible', pg_catalog.now(), p_idempotency_key)
      returning id into v_event_id;
      if v_job.stop_requested_at is null then
        update public.team_jobs set stop_requested_at = pg_catalog.now() where id = v_job.id;
        perform threadlink_private.record_event(p_owner, null, 'team.stop_requested', 'team_job', v_job.id,
          jsonb_build_object('room_id', v_job.room_id, 'chat_id', v_chat.id));
      end if;
      return jsonb_build_object('routed', 'stop_requested', 'job_id', v_job.id, 'event_id', v_event_id,
                                'chat_id', v_chat.id);
    end if;

    select coalesce(array_agg(provider), '{}') into v_agents
    from public.room_agents where room_id = v_job.room_id and enabled;
    v_audience := coalesce(v_mention, 'team');
    if v_audience <> 'team' and not (v_audience = any (v_agents)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
    insert into public.chat_events
      (owner_user_id, chat_id, room_id, agent_session_id, job_id, author_kind, author_label, audience,
       event_type, body, visibility, idempotency_key)
    values
      (p_owner, v_chat.id, v_job.room_id, v_session, v_job.id, 'owner', 'You', v_audience, 'message',
       v_body, 'visible', p_idempotency_key)
    returning id into v_event_id;
    return jsonb_build_object('routed', 'note_to_active_job', 'job_id', v_job.id, 'event_id', v_event_id,
                              'chat_id', v_chat.id);
  end if;

  -- No active job: the message starts one.
  if v_body ~* threadlink_private.chat_stop_pattern() then
    raise exception 'nothing to stop' using errcode = '55000', hint = 'nothing_to_stop';
  end if;
  v_goal := v_rest;
  if v_goal is null or v_goal = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;
  if not v_has_room then
    raise exception 'Choose a project for this chat so the agents know which folder to work in'
      using errcode = '55000', hint = 'needs_project';
  end if;

  if p_legacy then
    -- The 0.8 hint semantics, without favouring a provider when none is named.
    if p_mode = 'pair' then
      v_mode := 'pair';
      v_builder := coalesce(case when v_mention in ('claude-code', 'codex') then v_mention end, p_builder);
    elsif v_mention in ('claude-code', 'codex') then
      v_mode := 'solo';
      v_builder := v_mention;
    elsif v_mention = 'team' or p_mode = 'team' then
      v_mode := 'team';
    elsif p_mode = 'solo' then
      v_mode := 'solo';
      v_builder := p_builder;
    elsif (select count(*) from public.room_agents where room_id = v_room.id and enabled) >= 2 then
      v_mode := 'team';
    else
      v_mode := 'solo';
      v_builder := p_builder;
    end if;
  elsif v_mention in ('claude-code', 'codex') then
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

  -- The project's route: the most recent active link to its agent session.
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

  -- The owner's message first, so the timeline reads request -> job started.
  insert into public.chat_events
    (owner_user_id, chat_id, room_id, agent_session_id, author_kind, author_label, audience, event_type,
     body, visibility, idempotency_key)
  values
    (p_owner, v_chat.id, v_room.id, v_room.agent_session_id, 'owner', 'You', v_audience, 'request',
     v_body, 'visible', p_idempotency_key)
  returning id into v_event_id;

  -- The health gate. The refusal is itself part of the conversation: a
  -- ThreadLink row says who is not ready. No job, no task.
  v_health := threadlink_private.provider_health_list(v_room.id, v_participants);
  if not threadlink_private.provider_health_ok(v_health) then
    perform threadlink_private.chat_note(v_chat, v_room.id, 'provider_blocked',
      threadlink_private.provider_health_text(v_health));
    return jsonb_build_object('routed', 'provider_blocked', 'job_id', null, 'event_id', v_event_id,
                              'chat_id', v_chat.id, 'health', v_health, 'mode', v_mode,
                              'builder', v_builder, 'reviewer', v_reviewer);
  end if;

  v_status := threadlink_private.team_start_job_v2(
    p_owner, null, 'owner', v_room, v_link, v_goal, null, null, null, null, v_mode, v_builder, v_reviewer,
    null, v_chat.id, null, null);

  update public.chat_events set job_id = v_status ->> 'job_id' where id = v_event_id;
  return jsonb_build_object('routed', 'new_job', 'job_id', v_status ->> 'job_id', 'event_id', v_event_id,
                            'chat_id', v_chat.id, 'mode', v_mode, 'builder', v_builder,
                            'reviewer', v_reviewer);
end;
$$;

-- 0.8: keyed by room, same signature and behaviour; now the room's default chat.
create or replace function public.post_chat_message(
  p_room_id text,
  p_body text,
  p_mode text default null,
  p_builder text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_room public.rooms;
  v_chat text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  v_room := threadlink_private.require_owned_room(p_room_id);
  v_chat := threadlink_private.room_default_chat(v_room.id);
  if v_chat is null then
    raise exception 'chat limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  return threadlink_private.chat_post(v_owner, v_chat, p_body, p_mode, p_builder, p_idempotency_key, true);
end;
$$;

-- Chat-first: keyed by chat. All three arguments are required (no defaults),
-- so a two-argument call can only ever resolve to the room-keyed function.
create function public.post_chat_message(p_chat_id text, p_body text, p_idempotency_key text)
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
  return threadlink_private.chat_post(v_owner, p_chat_id, p_body, null, null, p_idempotency_key, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Owner chat management (Clerk-authenticated; auth.uid() owns everything)
-- ---------------------------------------------------------------------------

-- A project the caller may put a chat in: their own, active.
create function threadlink_private.require_chat_project(p_owner text, p_room_id text)
returns public.rooms
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.rooms;
begin
  select * into v from public.rooms where id = p_room_id and owner_user_id = p_owner and status <> 'deleted';
  if not found then
    raise exception 'project not found' using errcode = 'P0002', hint = 'project_not_found';
  end if;
  if v.status <> 'active' then
    raise exception 'project is archived' using errcode = '55000', hint = 'room_inactive';
  end if;
  return v;
end;
$$;

create function threadlink_private.chat_valid_name(p_name text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := pg_catalog.btrim(threadlink_private.chat_strip_invisible(p_name));
begin
  if v is null or char_length(v) not between 1 and p_max or v ~ '[[:cntrl:]]' then
    raise exception 'invalid name' using errcode = '22023', hint = 'invalid_name';
  end if;
  return v;
end;
$$;

-- "Mode changed to ...": fixed words and provider labels only.
create function threadlink_private.chat_mode_text(
  p_mode text, p_solo text, p_builder text, p_reviewer text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_mode
    when 'team' then 'Mode changed to Team.'
    when 'solo' then 'Mode changed to Solo'
                     || coalesce(': ' || threadlink_private.chat_provider_label(p_solo) || ' works alone', '') || '.'
    else 'Mode changed to Builder + Reviewer'
         || case when p_builder is null and p_reviewer is null then ''
                 else ' (' || coalesce(threadlink_private.chat_provider_label(p_builder), 'chosen automatically')
                      || ' builds, ' || coalesce(threadlink_private.chat_provider_label(p_reviewer), 'the other agent')
                      || ' reviews)' end
         || '.' end
$$;

create function public.create_chat(
  p_name text,
  p_room_id text default null,
  p_group_id text default null,
  p_mode text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_name text;
  v_room public.rooms;
  v_id text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  v_name := threadlink_private.chat_valid_name(p_name, 100);
  if p_mode is not null and not (p_mode = any (array['solo', 'pair', 'team'])) then
    raise exception 'invalid mode' using errcode = '22023', hint = 'invalid_mode';
  end if;
  if p_room_id is not null then
    v_room := threadlink_private.require_chat_project(v_owner, p_room_id);
  end if;
  if p_group_id is not null and not exists (
       select 1 from public.chat_groups where id = p_group_id and owner_user_id = v_owner) then
    raise exception 'group not found' using errcode = 'P0002', hint = 'group_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:chats:' || v_owner, 0));
  if (select count(*) from public.chats
      where owner_user_id = v_owner and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_creates_per_minute() then
    raise exception 'too many new chats' using errcode = '54000', hint = 'rate_limited';
  end if;
  if (select count(*) from public.chats where owner_user_id = v_owner and deleted_at is null)
     >= threadlink_private.chat_max_per_owner() then
    raise exception 'chat limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  insert into public.chats (owner_user_id, name, room_id, group_id, mode)
  values (v_owner, v_name, v_room.id, p_group_id, coalesce(p_mode, 'team'))
  returning id into v_id;
  perform threadlink_private.record_event(v_owner, null, 'chat.created', 'chat', v_id,
    jsonb_build_object('room_id', v_room.id, 'mode', coalesce(p_mode, 'team')));
  return threadlink_private.chat_json(v_id);
end;
$$;

/*
 * Change a chat, atomically. Null leaves a field as it is. p_clear_room /
 * p_clear_group remove the project / group; p_pinned / p_archived pin and
 * archive in the same change. A provider may be auto (chosen when work
 * starts). Changing the mode or providers writes a ThreadLink row "Mode
 * changed to ..." and never edits history. Moving a chat to another project
 * changes only future work (a running job keeps its project).
 */
create function public.update_chat(
  p_chat_id text,
  p_name text default null,
  p_room_id text default null,
  p_clear_room boolean default false,
  p_group_id text default null,
  p_clear_group boolean default false,
  p_mode text default null,
  p_solo_provider text default null,
  p_builder_provider text default null,
  p_reviewer_provider text default null,
  p_pinned boolean default null,
  p_archived boolean default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
  v_name text := v.name;
  v_room_id text := v.room_id;
  v_group_id text := v.group_id;
  v_mode text := coalesce(p_mode, v.mode);
  v_solo text := v.solo_provider;
  v_builder text := v.builder_provider;
  v_reviewer text := v.reviewer_provider;
  v_mode_changed boolean;
  v_p text;
begin
  if (p_clear_room and p_room_id is not null) or (p_clear_group and p_group_id is not null)
     or p_clear_room is null or p_clear_group is null then
    raise exception 'invalid change' using errcode = '22023', hint = 'invalid';
  end if;
  if (select count(*) from public.audit_events
      where owner_user_id = v.owner_user_id and action = 'chat.updated'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_updates_per_minute() then
    raise exception 'too many changes' using errcode = '54000', hint = 'rate_limited';
  end if;
  if p_name is not null then
    v_name := threadlink_private.chat_valid_name(p_name, 100);
  end if;
  if p_clear_room then
    v_room_id := null;
  elsif p_room_id is not null then
    v_room_id := (threadlink_private.require_chat_project(v.owner_user_id, p_room_id)).id;
  end if;
  if p_clear_group then
    v_group_id := null;
  elsif p_group_id is not null then
    if not exists (select 1 from public.chat_groups where id = p_group_id and owner_user_id = v.owner_user_id) then
      raise exception 'group not found' using errcode = 'P0002', hint = 'group_not_found';
    end if;
    v_group_id := p_group_id;
  end if;
  if not (v_mode = any (array['solo', 'pair', 'team'])) then
    raise exception 'invalid mode' using errcode = '22023', hint = 'invalid_mode';
  end if;
  foreach v_p in array array[p_solo_provider, p_builder_provider, p_reviewer_provider] loop
    if v_p is not null and v_p <> 'auto' and not (v_p = any (threadlink_private.team_providers())) then
      raise exception 'invalid provider' using errcode = '22023', hint = 'invalid_builder';
    end if;
  end loop;
  if p_solo_provider is not null then
    v_solo := nullif(p_solo_provider, 'auto');
  end if;
  if p_builder_provider is not null then
    v_builder := nullif(p_builder_provider, 'auto');
  end if;
  if p_reviewer_provider is not null then
    v_reviewer := nullif(p_reviewer_provider, 'auto');
  end if;
  if v_builder is not null and v_builder = v_reviewer then
    raise exception 'an agent cannot review its own work' using errcode = '22023', hint = 'invalid_pair';
  end if;
  -- A named provider must be an enabled agent of the chat's project.
  if v_room_id is not null and exists (
       select 1 from unnest(array[v_solo, v_builder, v_reviewer]) p(provider)
       where p.provider is not null
         and not exists (select 1 from public.room_agents a
                         where a.room_id = v_room_id and a.provider = p.provider and a.enabled)) then
    raise exception 'that agent is not part of this project' using errcode = '55000',
      hint = 'agent_not_in_project';
  end if;

  v_mode_changed := v_mode is distinct from v.mode or v_solo is distinct from v.solo_provider
                    or v_builder is distinct from v.builder_provider
                    or v_reviewer is distinct from v.reviewer_provider;
  if v_mode_changed and (select count(*) from public.chat_events
                         where chat_id = v.id and event_type = 'mode_changed'
                           and created_at > pg_catalog.now() - interval '1 minute')
                        >= threadlink_private.chat_mode_changes_per_minute() then
    raise exception 'too many mode changes' using errcode = '54000', hint = 'rate_limited';
  end if;

  update public.chats
  set name = v_name,
      room_id = v_room_id,
      group_id = v_group_id,
      mode = v_mode,
      solo_provider = v_solo,
      builder_provider = v_builder,
      reviewer_provider = v_reviewer,
      -- A chat moved out of its project is no longer that project's default.
      is_room_default = is_room_default and v_room_id is not distinct from v.room_id,
      pinned_at = case when p_pinned is null then pinned_at
                       when p_pinned then coalesce(pinned_at, pg_catalog.now()) end,
      archived_at = case when p_archived is null then archived_at
                         when p_archived then coalesce(archived_at, pg_catalog.now()) end,
      updated_at = pg_catalog.now()
  where id = v.id;
  if p_archived and v.archived_at is null then
    perform threadlink_private.record_event(v.owner_user_id, null, 'chat.archived', 'chat', v.id);
  elsif p_archived is not null and not p_archived and v.archived_at is not null then
    perform threadlink_private.record_event(v.owner_user_id, null, 'chat.restored', 'chat', v.id);
  end if;

  if v_mode_changed then
    perform threadlink_private.chat_note((select c from public.chats c where c.id = v.id), v_room_id,
      'mode_changed', threadlink_private.chat_mode_text(v_mode, v_solo, v_builder, v_reviewer));
  end if;
  perform threadlink_private.record_event(v.owner_user_id, null, 'chat.updated', 'chat', v.id,
    jsonb_build_object(
      'renamed', v_name is distinct from v.name,
      'project_changed', v_room_id is distinct from v.room_id,
      'group_changed', v_group_id is distinct from v.group_id,
      'mode', v_mode,
      'mode_changed', v_mode_changed));
  return threadlink_private.chat_json(v.id);
end;
$$;

create function public.set_chat_pinned(p_chat_id text, p_pinned boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
begin
  if p_pinned is null then
    raise exception 'invalid pinned flag' using errcode = '22023', hint = 'invalid';
  end if;
  perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  update public.chats
  set pinned_at = case when p_pinned then coalesce(pinned_at, pg_catalog.now()) end,
      updated_at = pg_catalog.now()
  where id = v.id;
  return threadlink_private.chat_json(v.id);
end;
$$;

create function public.set_chat_archived(p_chat_id text, p_archived boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
begin
  if p_archived is null then
    raise exception 'invalid archived flag' using errcode = '22023', hint = 'invalid';
  end if;
  perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  if p_archived and v.archived_at is null then
    update public.chats set archived_at = pg_catalog.now(), updated_at = pg_catalog.now() where id = v.id;
    perform threadlink_private.record_event(v.owner_user_id, null, 'chat.archived', 'chat', v.id);
  elsif not p_archived and v.archived_at is not null then
    update public.chats set archived_at = null, updated_at = pg_catalog.now() where id = v.id;
    perform threadlink_private.record_event(v.owner_user_id, null, 'chat.restored', 'chat', v.id);
  end if;
  return threadlink_private.chat_json(v.id);
end;
$$;

/*
 * "Delete from ThreadLink": the chat is hidden for good (soft delete). It never
 * touches the provider own history, jobs, results or the audit trail. A chat
 * with running work must be stopped first.
 */
create function public.delete_chat(p_chat_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
begin
  if exists (select 1 from public.team_jobs where chat_id = v.id and finished_at is null) then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;
  update public.chats
  set deleted_at = pg_catalog.now(), pinned_at = null, updated_at = pg_catalog.now()
  where id = v.id;
  perform threadlink_private.record_event(v.owner_user_id, null, 'chat.deleted', 'chat', v.id);
  return jsonb_build_object('chat_id', v.id, 'deleted', true);
end;
$$;

-- Read up to p_seq (never past the chat's newest row, never backwards).
create function public.mark_chat_read(p_chat_id text, p_seq bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats := threadlink_private.require_owned_chat(p_chat_id);
  v_max bigint;
begin
  if p_seq is null or p_seq < 0 then
    raise exception 'invalid cursor' using errcode = '22023', hint = 'invalid';
  end if;
  select coalesce(max(seq), 0) into v_max from public.chat_events where chat_id = v.id;
  -- Only a call that moves the cursor counts (the page marks read as it polls).
  if least(p_seq, v_max) > v.last_read_seq then
    perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_read',
                                                threadlink_private.chat_reads_per_minute());
    update public.chats set last_read_seq = least(p_seq, v_max) where id = v.id;
  end if;
  return jsonb_build_object('chat_id', v.id,
                            'last_read_seq', (select last_read_seq from public.chats where id = v.id));
end;
$$;

create function public.create_chat_group(p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_name text;
  v_id text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  v_name := threadlink_private.chat_valid_name(p_name, 60);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:chat-groups:' || v_owner, 0));
  if (select count(*) from public.chat_groups where owner_user_id = v_owner)
     >= threadlink_private.chat_group_max_per_owner() then
    raise exception 'group limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  if exists (select 1 from public.chat_groups where owner_user_id = v_owner and lower(name) = lower(v_name)) then
    raise exception 'a group with this name already exists' using errcode = '55000', hint = 'name_taken';
  end if;
  insert into public.chat_groups (owner_user_id, name, sort)
  values (v_owner, v_name,
          least(coalesce((select max(sort) from public.chat_groups where owner_user_id = v_owner), -1) + 1, 100000))
  returning id into v_id;
  perform threadlink_private.record_event(v_owner, null, 'chat_group.created', 'chat_group', v_id);
  return (select jsonb_build_object('group_id', g.id, 'name', g.name, 'sort', g.sort)
          from public.chat_groups g where g.id = v_id);
end;
$$;

create function public.rename_chat_group(p_group_id text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v public.chat_groups;
  v_name text;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  select * into v from public.chat_groups where id = p_group_id and owner_user_id = v_owner for update;
  if not found then
    raise exception 'group not found' using errcode = 'P0002', hint = 'group_not_found';
  end if;
  v_name := threadlink_private.chat_valid_name(p_name, 60);
  if exists (select 1 from public.chat_groups
             where owner_user_id = v_owner and id <> v.id and lower(name) = lower(v_name)) then
    raise exception 'a group with this name already exists' using errcode = '55000', hint = 'name_taken';
  end if;
  update public.chat_groups set name = v_name where id = v.id;
  perform threadlink_private.record_event(v_owner, null, 'chat_group.renamed', 'chat_group', v.id);
  return jsonb_build_object('group_id', v.id, 'name', v_name, 'sort', v.sort);
end;
$$;

-- The group goes; its chats stay, ungrouped.
create function public.delete_chat_group(p_group_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v public.chat_groups;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  perform threadlink_private.owner_rate_limit(v_owner, 'chat_organise',
                                              threadlink_private.chat_updates_per_minute());
  select * into v from public.chat_groups where id = p_group_id and owner_user_id = v_owner for update;
  if not found then
    raise exception 'group not found' using errcode = 'P0002', hint = 'group_not_found';
  end if;
  update public.chats set group_id = null, updated_at = pg_catalog.now()
  where group_id = v.id and owner_user_id = v_owner;
  delete from public.chat_groups where id = v.id;
  perform threadlink_private.record_event(v_owner, null, 'chat_group.deleted', 'chat_group', v.id);
  return jsonb_build_object('group_id', v.id, 'deleted', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Explicit retry with another coordinator (section 2). Never automatic.
-- ---------------------------------------------------------------------------

/*
 * Only for a BLOCKED job that never persisted a plan (it failed before real
 * work). Starts a NEW job in the same chat, same goal/spec/mode/builders and
 * budgets, with roleOverrides.coordinator = p_coordinator. The coordinator must
 * be a participant of that job, and every participant must be READY (else
 * 55000 provider_unhealthy with the health DETAIL, nothing created). A job is
 * retried at most once: a repeat returns the first retry.
 */
create function public.retry_job_with_roles(p_job_id text, p_coordinator text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owner text := threadlink_private.current_user_id();
  v_job public.team_jobs;
  v_chat public.chats;
  v_room public.rooms;
  v_link public.thread_links;
  v_task public.tasks;
  v_carrier jsonb;
  v_existing text;
  v_status jsonb;
  v_new public.team_jobs;
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_coordinator is null or not (p_coordinator = any (threadlink_private.team_providers())) then
    raise exception 'invalid coordinator' using errcode = '22023', hint = 'invalid_roles';
  end if;
  select * into v_job from public.team_jobs where id = p_job_id and owner_user_id = v_owner;
  if not found then
    raise exception 'job not found' using errcode = 'P0002', hint = 'job_not_found';
  end if;
  -- Lock order: project, chat, job.
  select * into v_room from public.rooms where id = v_job.room_id for update;
  select * into v_chat from public.chats
  where id = v_job.chat_id and owner_user_id = v_owner and deleted_at is null
  for update;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  -- The retry would run in the job's project; the chat has moved on.
  if v_chat.room_id is distinct from v_job.room_id then
    raise exception 'This chat now belongs to another project; start a new request instead'
      using errcode = '55000', hint = 'project_changed';
  end if;
  select * into v_job from public.team_jobs where id = p_job_id for update;

  select id into v_existing from public.team_jobs where retried_from_job_id = v_job.id;
  if v_existing is not null then
    return jsonb_build_object('routed', 'new_job', 'job_id', v_existing, 'chat_id', v_chat.id,
                              'retried_from_job_id', v_job.id, 'replayed', true);
  end if;
  if v_job.status <> 'blocked' or v_job.plan is not null then
    raise exception 'only a job blocked before it had a plan can be retried this way'
      using errcode = '55000', hint = 'not_retryable';
  end if;
  if v_room.status <> 'active' then
    raise exception 'room is not active' using errcode = '55000', hint = 'room_inactive';
  end if;

  select * into v_task from public.tasks where id = v_job.task_id;
  v_carrier := v_task.content::jsonb;
  if not exists (
       select 1 from jsonb_array_elements(
         case when jsonb_typeof(v_carrier -> 'agents') = 'array' then v_carrier -> 'agents' else '[]'::jsonb end) a
       where a ->> 'provider' = p_coordinator) then
    raise exception 'that agent did not take part in this job' using errcode = '22023', hint = 'invalid_roles';
  end if;
  if exists (select 1 from public.team_jobs where chat_id = v_chat.id and finished_at is null) then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;
  if (select count(*) from public.audit_events
      where owner_user_id = v_owner and action = 'team.job_retried'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_retries_per_minute() then
    raise exception 'too many retries' using errcode = '54000', hint = 'rate_limited';
  end if;

  select * into v_link from public.thread_links
  where owner_user_id = v_owner and agent_session_id = v_room.agent_session_id and status = 'active'
  order by approved_at desc nulls last, created_at desc
  limit 1
  for share;
  if not found or not threadlink_private.session_is_usable(v_link.agent_session_id)
     or not threadlink_private.session_is_usable(v_link.controller_session_id) then
    raise exception 'this project is not linked any more' using errcode = '55000', hint = 'route_missing';
  end if;

  v_status := threadlink_private.team_start_job_v2(
    v_owner, null, 'owner', v_room, v_link, v_job.goal, v_job.spec_input,
    v_job.max_planning_rounds, v_job.max_review_rounds, v_job.parallel_agents,
    v_job.mode, v_job.builder_provider,
    case when v_job.mode = 'pair' and jsonb_typeof(v_carrier -> 'reviewer') = 'string'
         then v_carrier ->> 'reviewer' end,
    null, v_chat.id,
    coalesce(v_job.role_overrides, '{}'::jsonb) || jsonb_build_object('coordinator', p_coordinator),
    v_job.id);

  select * into v_new from public.team_jobs where id = v_status ->> 'job_id';
  perform threadlink_private.chat_job_event(v_new, 'job_status',
    'Retrying the blocked job: ' || threadlink_private.chat_provider_label(p_coordinator) || ' coordinates.',
    'visible');
  perform threadlink_private.record_event(v_owner, null, 'team.job_retried', 'team_job', v_new.id,
    jsonb_build_object('retried_from_job_id', v_job.id, 'coordinator', p_coordinator, 'chat_id', v_chat.id));
  return jsonb_build_object('routed', 'new_job', 'job_id', v_new.id, 'chat_id', v_chat.id,
                            'retried_from_job_id', v_job.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Detection reports: + health, healthCheckedAt, healthDetail (section 2)
-- ---------------------------------------------------------------------------
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
begin
  if p_provider is null or not (p_provider = any (threadlink_private.team_providers())) then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  -- A detail that is not one of the Runtime's fixed sentences is stored as null
  -- (never refused: the health itself must still arrive).
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
    -- A check "from the future" proves nothing (small clock skew allowed).
    if v_checked > pg_catalog.now() + interval '5 minutes' then
      raise exception 'invalid detection' using errcode = '22023';
    end if;
  end if;
  -- The account's last report (for display) ...
  insert into public.provider_profiles (owner_user_id, provider, detected, detected_at)
  values (v_runtime.owner_user_id, p_provider, v_detected, pg_catalog.now())
  on conflict (owner_user_id, provider) do update
    set detected = excluded.detected, detected_at = excluded.detected_at;
  -- ... and THIS computer's health, which is what gates jobs on its projects.
  insert into public.runtime_provider_health
    (runtime_id, owner_user_id, provider, detected, health, checked_at, detail, received_at)
  values
    (v_runtime.id, v_runtime.owner_user_id, p_provider, v_detected,
     case when jsonb_typeof(v_detected -> 'health') = 'string' then v_detected ->> 'health' end,
     v_checked,
     case when jsonb_typeof(v_detected -> 'healthDetail') = 'string' then v_detected ->> 'healthDetail' end,
     pg_catalog.now())
  on conflict (runtime_id, provider) do update
    set detected = excluded.detected, health = excluded.health, checked_at = excluded.checked_at,
        detail = excluded.detail, received_at = excluded.received_at;
  return threadlink_private.provider_profile_json(v_runtime.owner_user_id, p_provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Reads for the chat list (invoker: RLS decides what is visible)
-- ---------------------------------------------------------------------------

-- For each of the caller's chats: the newest visible row (clipped), and the
-- controller labels seen recently. At most 500 chats per call.
create function public.chat_list_extras(p_chat_ids text[])
returns table (chat_id text, last_seq bigint, last_body text, last_at timestamptz, controller_labels text[])
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_chat_ids is null or cardinality(p_chat_ids) > 500 then
    raise exception 'too many chats' using errcode = '22023', hint = 'invalid';
  end if;
  return query
  select c.id,
         e.seq,
         pg_catalog.left(e.body, 200),
         e.created_at,
         coalesce((select array_agg(distinct s.author_label)
                   from (select ce.author_label from public.chat_events ce
                         where ce.chat_id = c.id and ce.author_kind = 'controller'
                         order by ce.seq desc limit 50) s), '{}'::text[])
  from (select distinct unnest(p_chat_ids) as id) c
  left join lateral (
    select ev.seq, ev.body, ev.created_at from public.chat_events ev
    where ev.chat_id = c.id and ev.visibility = 'visible'
    order by ev.seq desc
    limit 1) e on true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 17. create_room: new rooms' agents get the full role set (no preference).
--     Its default chat is made by the rooms_default_chat trigger.
-- ---------------------------------------------------------------------------
create or replace function public.create_room(
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
    -- Provider-neutral (chat-first section 4): every role, no preference.
    (v_connection.owner_user_id, v_room_id, 'claude-code', 'Claude', threadlink_private.team_roles()),
    (v_connection.owner_user_id, v_room_id, 'codex', 'Codex', threadlink_private.team_roles());

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'room.created', 'room', v_room_id,
    jsonb_build_object('workspace_id', v_agent.workspace_id));
  perform threadlink_private.touch_session(v_session.id);
  return threadlink_private.room_json(v_room_id) || jsonb_build_object('created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. Privileges: revoke everything new from every client role, then grant
--     exactly its audience (credential RPCs -> anon; owner RPCs ->
--     authenticated). Replaced functions keep their existing grants.
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.provider_health_values()', 'threadlink_private.provider_health_max_age()',
    'threadlink_private.provider_health_details()', 'threadlink_private.chat_max_per_owner()',
    'threadlink_private.room_runtime(text)', 'threadlink_private.owner_rate_limit(text, text, integer)',
    'threadlink_private.chat_creates_per_minute()', 'threadlink_private.chat_updates_per_minute()',
    'threadlink_private.chat_mode_changes_per_minute()', 'threadlink_private.chat_group_max_per_owner()',
    'threadlink_private.chat_retries_per_minute()', 'threadlink_private.team_overridable_roles()',
    'threadlink_private.chat_reads_per_minute()',
    'threadlink_private.valid_role_overrides(jsonb)',
    'threadlink_private.provider_effective_health(text, jsonb, timestamptz)',
    'threadlink_private.provider_health_list(text, text[])', 'threadlink_private.provider_health_ok(jsonb)',
    'threadlink_private.provider_health_detail(jsonb)', 'threadlink_private.provider_health_sentence(text, text)',
    'threadlink_private.provider_health_text(jsonb)',
    'threadlink_private.room_default_chat(text)', 'threadlink_private.rooms_default_chat()',
    'threadlink_private.team_jobs_chat_phase()', 'threadlink_private.tasks_assign_chat()',
    'threadlink_private.chat_events_assign_chat()', 'threadlink_private.chat_events_touch_chat()',
    'threadlink_private.chat_provider_reason_text(text, text)',
    'threadlink_private.team_pick_provider(text, text, text)',
    'threadlink_private.team_route_check(text, public.rooms, public.thread_links, text)',
    'threadlink_private.team_participants(text, text, text, text, text)',
    'threadlink_private.team_start_job_v2(text, text, text, public.rooms, public.thread_links, text, jsonb, '
      || 'integer, integer, integer, text, text, text, text, text, jsonb, text)',
    'threadlink_private.team_start_job_from_controller_v2(text, text, text, text, jsonb, integer, integer, '
      || 'integer, text[], text, text, text, text)',
    'threadlink_private.chat_json(text)', 'threadlink_private.require_owned_chat(text)',
    'threadlink_private.chat_note(public.chats, text, text, text)',
    'threadlink_private.chat_post(text, text, text, text, text, text, boolean)',
    'threadlink_private.require_chat_project(text, text)', 'threadlink_private.chat_valid_name(text, integer)',
    'threadlink_private.chat_mode_text(text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;

  -- Credential (controller) RPCs.
  foreach f in array array[
    'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text, text, text, text)',
    'public.create_chat_task(text, text, text, text, text, text, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;

  -- Owner RPCs.
  foreach f in array array[
    'public.post_chat_message(text, text, text)',
    'public.create_chat(text, text, text, text)',
    'public.update_chat(text, text, text, boolean, text, boolean, text, text, text, text, boolean, boolean)',
    'public.set_chat_pinned(text, boolean)',
    'public.set_chat_archived(text, boolean)',
    'public.delete_chat(text)',
    'public.mark_chat_read(text, bigint)',
    'public.create_chat_group(text)',
    'public.rename_chat_group(text, text)',
    'public.delete_chat_group(text)',
    'public.retry_job_with_roles(text, text)',
    'public.chat_list_extras(text[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$grants$;
