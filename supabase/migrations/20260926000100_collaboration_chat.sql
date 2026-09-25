-- ===========================================================================
-- Collaboration chat: one ThreadLink-owned timeline per project (room), job
-- modes (solo / pair / team), owner messages routed to the Runtime, and the
-- Runtime's narrow right to set the owner's DECLARED plan.
--
-- Contract: docs/design/collaboration-chat.md sections 2-5. Shared TS types:
-- lib/chat/types.ts.
--
-- Shape of the trust model (the security core):
--   * public.chat_events has NO insert/update/delete grant to any client role.
--     Rows are written only by the SECURITY DEFINER triggers and RPCs below.
--   * Who wrote a row (author_kind / author_provider / author_label) is derived
--     here from trusted parent rows, never from request input or agent text.
--     An agent writing "ThreadLink: PASS" produces an AGENT row; a verdict event
--     comes only from team_jobs.verdict, which only team_job_write sets.
--   * Chat triggers never raise into the parent write: a chat problem is logged
--     as a warning and the chat row is skipped, the parent write stands. But a
--     row that would violate provenance is never written (constraints below).
--
-- Additive: the audit action allow-list is RE-STATED IN FULL as a superset;
-- start_team_job keeps its old signature (now a thin wrapper) and gains a
-- 12-argument overload with p_mode/p_builder; team_job_write, team_status_json
-- and team_jobs_guard_update are replaced in place (same signatures, grants
-- preserved).
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
  -- New in collaboration chat.
  'provider.plan_set_from_device', 'provider.plan_migrated', 'team.stop_requested'
));

-- ---------------------------------------------------------------------------
-- 1. Vocabulary and bounds
-- ---------------------------------------------------------------------------
create function threadlink_private.chat_event_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status',
               'plan_agreed', 'unit_status', 'finding', 'decision', 'job_verdict', 'task_started',
               'task_progress', 'task_completed', 'task_failed', 'task_cancelled', 'owner_routed',
               'stop_requested', 'model_used', 'model_mismatch'] $$;
create function threadlink_private.chat_model_pattern() returns text
language sql immutable set search_path = '' as $$ select '^[A-Za-z0-9._:\[\]/-]{1,100}$' $$;
create function threadlink_private.chat_body_max_bytes() returns integer
language sql immutable set search_path = '' as $$ select 8192 $$;
-- Owner posts: characters per message, and posts per room per minute.
create function threadlink_private.chat_owner_max_chars() returns integer
language sql immutable set search_path = '' as $$ select 4000 $$;
create function threadlink_private.chat_owner_posts_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 20 $$;
-- ...and across all of one owner's rooms.
create function threadlink_private.chat_owner_posts_per_minute_total() returns integer
language sql immutable set search_path = '' as $$ select 60 $$;
-- Declared-plan changes a Runtime may make per owner per hour.
create function threadlink_private.runtime_plan_changes_per_hour() returns integer
language sql immutable set search_path = '' as $$ select 30 $$;
-- The oldest Runtime that runs each job mode. A Team-capable (0.7) Runtime
-- ignores `mode` and would run a solo request as a full team, so the simpler
-- modes need the Runtime that knows them.
-- "@team stop" followed by the end, whitespace or punctuation (not '-': "stop-gap").
-- The ONE definition, used by the live router and the idempotent replay alike.
create function threadlink_private.chat_stop_pattern() returns text
language sql immutable set search_path = '' as $$ select '^@team[[:space:]]+stop([[:space:]]|$|[.,!:;])' $$;
create function threadlink_private.team_min_runtime_minor(p_mode text) returns integer
language sql immutable set search_path = '' as $$ select case when p_mode = 'team' then 7 else 8 end $$;

-- ---------------------------------------------------------------------------
-- 2. Schema changes on existing tables
-- ---------------------------------------------------------------------------
alter table public.team_jobs
  add column mode text not null default 'team'
    constraint team_jobs_mode_check check (mode in ('solo', 'pair', 'team')),
  add column builder_provider text
    constraint team_jobs_builder_provider_check check (builder_provider in ('claude-code', 'codex')),
  add column stop_requested_at timestamptz,
  -- Why a job ended as it did, as a fixed code the Runtime reports. The chat
  -- turns it into a fixed sentence, so no agent text ever reaches the verdict line.
  add column verdict_reason text
    constraint team_jobs_verdict_reason_check check (verdict_reason in ('tests_failed', 'review_not_passed', 'agents_disagree', 'dependency_not_finished', 'plan_blocked', 'agent_unavailable', 'agent_not_in_project', 'usage_exhausted', 'model_mismatch', 'access_mismatch', 'agent_timed_out', 'agent_failed', 'changed_during_review', 'inspection_found_issues', 'no_review_or_tests', 'stopped_by_owner', 'unexpected_error', 'merge_conflict', 'no_suitable_model')),
  add column origin text not null default 'controller'
    constraint team_jobs_origin_check check (origin in ('controller', 'owner')),
  -- Solo and pair name who builds; Team Mode decides per unit.
  add constraint team_jobs_builder_mode check ((mode = 'team') = (builder_provider is null));

alter table public.team_messages
  add column model_observed text
    constraint team_messages_model_observed_format check (model_observed ~ '^[A-Za-z0-9._:\[\]/-]{1,100}$');

-- Mode, builder and origin are part of a job's identity; a stop request, once
-- made, stays made.
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

-- Legacy plan values. The provider_profiles_plan_check constraint (Team Mode
-- migration) already refuses 'team'/'business' for Codex, so no row can hold
-- one; this is a defensive, audited no-op kept for any environment that ever
-- relaxed the constraint.
do $legacy$
declare
  r record;
begin
  for r in
    update public.provider_profiles set declared_plan = 'unknown'
    where provider = 'codex' and declared_plan in ('team', 'business')
    returning id, owner_user_id
  loop
    perform threadlink_private.record_event(r.owner_user_id, null, 'provider.plan_migrated', 'provider_profile',
      r.id, jsonb_build_object('provider', 'codex', 'to', 'unknown'));
  end loop;
end;
$legacy$;

-- ---------------------------------------------------------------------------
-- 3. chat_events
-- ---------------------------------------------------------------------------
create table public.chat_events (
  id text primary key
    default threadlink_private.generate_id('tlcev')
    constraint chat_events_id_format check (id ~ '^tlcev_[0-9a-f]{32}$'),
  -- The poll cursor. Unique and monotonic per insert order.
  seq bigint generated always as identity constraint chat_events_seq_key unique,
  owner_user_id text not null references public.users (id) on delete cascade,
  room_id text,
  agent_session_id text not null,
  job_id text,
  task_id text,
  node_id text,
  author_kind text not null
    constraint chat_events_author_kind_check check (author_kind in ('controller', 'owner', 'threadlink', 'agent')),
  author_provider text
    constraint chat_events_author_provider_check check (author_provider in ('claude-code', 'codex')),
  author_label text not null
    constraint chat_events_author_label_check
      check (char_length(author_label) between 1 and 60 and author_label !~ '[[:cntrl:]]'),
  author_role text
    constraint chat_events_author_role_check check (author_role in (
      'coordinator', 'planner', 'builder', 'reviewer', 'security_reviewer', 'test_reviewer', 'integrator',
      'investigator')),
  audience text constraint chat_events_audience_check check (audience in ('claude-code', 'codex', 'team')),
  event_type text not null
    constraint chat_events_event_type_check check (event_type in (
      'request', 'message', 'agent_message', 'agent_result', 'job_started', 'job_status', 'plan_agreed',
      'unit_status', 'finding', 'decision', 'job_verdict', 'task_started', 'task_progress', 'task_completed',
      'task_failed', 'task_cancelled', 'owner_routed', 'stop_requested', 'model_used', 'model_mismatch')),
  message_type text
    constraint chat_events_message_type_check check (message_type in (
      'proposal', 'review', 'finding', 'response', 'handoff', 'question', 'decision', 'completion')),
  round integer constraint chat_events_round_check check (round between 0 and 6),
  model_requested text
    constraint chat_events_model_requested_format check (model_requested ~ '^[A-Za-z0-9._:\[\]/-]{1,100}$'),
  model_observed text
    constraint chat_events_model_observed_format check (model_observed ~ '^[A-Za-z0-9._:\[\]/-]{1,100}$'),
  -- Plain text: newline and tab are the only control characters allowed.
  body text not null
    constraint chat_events_body_check check (
      octet_length(body) between 1 and 8192
      and pg_catalog.translate(body, E'\n\t', '') !~ '[[:cntrl:]]'),
  visibility text not null default 'visible'
    constraint chat_events_visibility_check check (visibility in ('visible', 'technical')),
  delivered_at timestamptz,
  idempotency_key text
    constraint chat_events_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz not null default now(),
  constraint chat_events_room_owner_fkey foreign key (room_id, owner_user_id)
    references public.rooms (id, owner_user_id) on delete cascade,
  constraint chat_events_agent_session_owner_fkey foreign key (agent_session_id, owner_user_id)
    references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint chat_events_job_owner_fkey foreign key (job_id, owner_user_id)
    references public.team_jobs (id, owner_user_id) on delete cascade,
  constraint chat_events_task_owner_fkey foreign key (task_id, owner_user_id)
    references public.tasks (id, owner_user_id) on delete cascade,
  constraint chat_events_node_fkey foreign key (node_id, job_id)
    references public.team_nodes (id, job_id) on delete cascade,
  constraint chat_events_node_needs_job check (node_id is null or job_id is not null),
  -- Provenance, held even against a privileged writer:
  -- a provider exactly on agent rows;
  constraint chat_events_agent_provider check ((author_kind = 'agent') = (author_provider is not null)),
  -- fixed labels for the owner and ThreadLink, and nobody else may use them;
  constraint chat_events_owner_label check ((author_kind = 'owner') = (author_label = 'You')),
  constraint chat_events_threadlink_label check ((author_kind = 'threadlink') = (author_label = 'ThreadLink')),
  -- each author kind writes only its own kinds of event;
  constraint chat_events_author_event check (
    (author_kind = 'controller' and event_type = 'request')
    or (author_kind = 'owner' and event_type in ('request', 'message'))
    or (author_kind = 'agent' and event_type in ('agent_message', 'agent_result', 'task_progress'))
    or (author_kind = 'threadlink' and event_type not in ('request', 'message', 'agent_message', 'agent_result',
                                                          'task_progress'))),
  -- delivery state and idempotency belong to owner posts only.
  constraint chat_events_delivery_owner check (delivered_at is null or author_kind = 'owner'),
  constraint chat_events_idempotency_owner check (idempotency_key is null or author_kind = 'owner')
);
comment on table public.chat_events is
  'ThreadLink-owned project chat timeline. Written only by triggers/definer RPCs; authors derived from trusted state.';

create unique index chat_events_owner_idempotency_idx on public.chat_events (owner_user_id, idempotency_key)
  where idempotency_key is not null;
create index chat_events_room_seq_idx on public.chat_events (room_id, seq);
create index chat_events_agent_session_seq_idx on public.chat_events (agent_session_id, seq);
create index chat_events_job_seq_idx on public.chat_events (job_id, seq);
create index chat_events_owner_idx on public.chat_events (owner_user_id);
create index chat_events_owner_posts_idx on public.chat_events (room_id, created_at) where author_kind = 'owner';
create index chat_events_owner_posts_total_idx on public.chat_events (owner_user_id, created_at)
  where author_kind = 'owner';
create index chat_events_undelivered_idx on public.chat_events (job_id, seq)
  where author_kind = 'owner' and event_type = 'message' and delivered_at is null;

-- Append-only, except the two facts that arrive later: when the Runtime picked
-- an owner note up, and which job an owner's starting message created.
create function threadlink_private.chat_events_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'delivered_at' - 'job_id') is distinct from (to_jsonb(old) - 'delivered_at' - 'job_id')
     or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
     or (old.job_id is not null and new.job_id is distinct from old.job_id) then
    raise exception 'chat events are append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger chat_events_guard_update before update on public.chat_events
  for each row execute function threadlink_private.chat_events_guard_update();

alter table public.chat_events enable row level security;
revoke all on table public.chat_events from public, anon, authenticated;
grant select on table public.chat_events to authenticated;
create policy chat_events_select_own on public.chat_events for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 4. Text hygiene: redaction, control characters, size
-- ---------------------------------------------------------------------------

/*
 * Removes credential-shaped content, matched on SHAPE so an unknown provider's
 * key is still caught. Mirrors runtime/src/summary.ts where sensible. Broad on
 * purpose: a false positive costs a few characters, a false negative a secret.
 */
create function threadlink_private.redact_text(p text)
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
  -- Credentials inside a URL: scheme://user:password@host (postgres://, https://...),
  -- including an empty user (redis://:password@host).
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
  -- key = value / key: value where the key names a secret, including prefixed
  -- names (DB_PASSWORD, MY_API_KEY) and quoted JSON keys. The value runs to the
  -- end of the line: "PASSWORD: correct horse battery staple" is one secret.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z0-9_-]*(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)'
    || '[A-Za-z0-9_-]*["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
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
  -- A home directory names a person: C:\Users\<name>\ -> C:\Users\<ellipsis>\,
  -- /home/<name>/ and /Users/<name>/ likewise.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z]:[\\/](Users|Documents and Settings)[\\/])[^\\/[:space:]"''<>|]+', '\1' || U&'\2026', 'gi');
  t := pg_catalog.regexp_replace(t, '(/(home|Users)/)[^/[:space:]"''<>|]+', '\1' || U&'\2026', 'g');
  return t;
end;
$$;

-- Removes zero-width and bidi-control characters (U+200B-U+200F,
-- U+202A-U+202E, U+2066-U+2069, U+FEFF).
create function threadlink_private.chat_strip_invisible(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select pg_catalog.regexp_replace(p, '[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]', '', 'g') $$;

/*
 * Chat body: newlines normalised, every control character except newline and
 * tab removed, redacted, trimmed, clipped to p_max_chars and then to the byte
 * bound (with an ellipsis when clipped). NULL when nothing is left.
 * Redaction runs BEFORE clipping, so a secret is never cut in half and left
 * unrecognisable.
 */
create function threadlink_private.chat_clean(p text, p_max_chars integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text;
  v_max_bytes integer := threadlink_private.chat_body_max_bytes() - 3;
  v_clipped boolean := false;
begin
  if p is null then
    return null;
  end if;
  -- Keep \n and \t across the [[:cntrl:]] strip via private-use placeholders.
  t := pg_catalog.translate(p, U&'\E000\E001', '');
  t := pg_catalog.replace(pg_catalog.replace(t, E'\r\n', E'\n'), E'\r', E'\n');
  t := pg_catalog.translate(t, E'\n\t', U&'\E000\E001');
  t := pg_catalog.regexp_replace(t, '[[:cntrl:]]', '', 'g');
  t := pg_catalog.translate(t, U&'\E000\E001', E'\n\t');
  -- Bidi overrides and zero-width characters can disguise what text says.
  t := threadlink_private.chat_strip_invisible(t);
  t := threadlink_private.redact_text(t);
  t := pg_catalog.btrim(t, E' \n\t');
  if t = '' then
    return null;
  end if;
  if char_length(t) > p_max_chars then
    t := pg_catalog.rtrim(pg_catalog.left(t, p_max_chars));
    v_clipped := true;
  end if;
  if octet_length(t) > v_max_bytes then
    t := pg_catalog.left(t, v_max_bytes);
    while octet_length(t) > v_max_bytes loop
      t := pg_catalog.left(t, char_length(t) - greatest(1, (octet_length(t) - v_max_bytes) / 4));
    end loop;
    v_clipped := true;
  end if;
  if v_clipped then
    t := t || U&'\2026';
  end if;
  return t;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Trusted labels and context
-- ---------------------------------------------------------------------------
create function threadlink_private.chat_provider_label(p_provider text)
returns text
language sql
immutable
set search_path = ''
as $$ select case p_provider when 'claude-code' then 'Claude Code' when 'codex' then 'Codex' end $$;

-- The provider an agent session runs. A bridge session from before providers
-- were recorded is Claude Code (its connection platform says so).
create function threadlink_private.chat_session_provider(p_session_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when s.provider in ('claude-code', 'codex') then s.provider
    when s.provider is null and c.platform = 'claude-code' then 'claude-code'
  end
  from public.session_bindings s
  join public.connections c on c.id = s.connection_id
  where s.id = p_session_id
$$;

/*
 * The controller's display name comes from its CONNECTION (never from the
 * request): the platform first, then the connection's display name, else
 * "Controller". A display name that would impersonate the owner, ThreadLink or
 * an agent is refused.
 */
-- The label rule itself, pure (tested directly): platform first, then a
-- sanitised display name, else "Controller".
create function threadlink_private.chat_controller_name(p_platform text, p_display_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
  v_skeleton text;
begin
  if p_platform = 'chatgpt' then
    return 'ChatGPT';
  elsif p_platform = 'claude-desktop' then
    return 'Claude';
  end if;
  -- Normalise (NFKC folds full-width and compatibility forms), drop invisible
  -- and control characters, then compare an ASCII skeleton (lowercase letters
  -- and digits only) against every name a controller must not wear. Only the
  -- platform itself may say ChatGPT or Claude (handled above). A name with any
  -- character outside printable ASCII could be a look-alike: it is refused.
  v_name := pg_catalog.normalize(coalesce(p_display_name, ''), 'NFKC');
  v_name := threadlink_private.chat_strip_invisible(v_name);
  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(v_name, '[[:cntrl:]]', '', 'g'));
  v_skeleton := pg_catalog.regexp_replace(lower(v_name), '[^a-z0-9]', '', 'g');
  if v_name = ''
     or v_name ~ '[^ -~]'
     or v_skeleton in ('you', 'owner', 'system', '')
     or v_skeleton ~ '(threadlink|claude|codex|chatgpt|openai|anthropic)' then
    return 'Controller';
  end if;
  return pg_catalog.left(v_name, 60);
end;
$$;

create function threadlink_private.chat_controller_label(p_session_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select threadlink_private.chat_controller_name(c.platform, c.display_name)
  from public.session_bindings s
  join public.connections c on c.id = s.connection_id
  where s.id = p_session_id
$$;

-- A single task's project: the one active room whose agent session is the
-- task's target. None, or more than one, means no room.
create function threadlink_private.chat_room_for_session(p_owner text, p_session_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 1 then min(id) end
  from public.rooms
  where owner_user_id = p_owner and agent_session_id = p_session_id and status = 'active'
$$;

create function threadlink_private.chat_job_status_label(p_status text)
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
    when 'cancelled' then 'Cancelled' else p_status end
$$;

/*
 * The one insert path for every chat row. Cleans the body (NULL => nothing is
 * written), keeps model ids only when they match the model pattern, and lets
 * the table constraints refuse anything that breaks provenance.
 */
create function threadlink_private.chat_write(
  p_owner text,
  p_room_id text,
  p_agent_session_id text,
  p_job_id text,
  p_task_id text,
  p_node_id text,
  p_author_kind text,
  p_author_provider text,
  p_author_label text,
  p_author_role text,
  p_audience text,
  p_event_type text,
  p_message_type text,
  p_round integer,
  p_model_requested text,
  p_model_observed text,
  p_body text,
  p_max_chars integer,
  p_visibility text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_body text := threadlink_private.chat_clean(p_body, p_max_chars);
  v_id text;
begin
  if v_body is null or p_agent_session_id is null then
    return null;
  end if;
  insert into public.chat_events
    (owner_user_id, room_id, agent_session_id, job_id, task_id, node_id, author_kind, author_provider,
     author_label, author_role, audience, event_type, message_type, round, model_requested, model_observed,
     body, visibility)
  values
    (p_owner, p_room_id, p_agent_session_id, p_job_id, p_task_id, p_node_id, p_author_kind, p_author_provider,
     p_author_label, p_author_role, p_audience, p_event_type, p_message_type, p_round,
     case when p_model_requested ~ threadlink_private.chat_model_pattern() then p_model_requested end,
     case when p_model_observed ~ threadlink_private.chat_model_pattern() then p_model_observed end,
     v_body, p_visibility)
  returning id into v_id;
  return v_id;
end;
$$;

-- ThreadLink's own milestone for a job.
create function threadlink_private.chat_job_event(
  p_job public.team_jobs, p_event_type text, p_body text, p_visibility text, p_node_id text default null
)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.chat_write(
    p_job.owner_user_id, p_job.room_id,
    (select t.target_session_id from public.tasks t where t.id = p_job.task_id),
    p_job.id, p_job.task_id, p_node_id, 'threadlink', null, 'ThreadLink', null, null,
    p_event_type, null, null, null, null, p_body, 2000, p_visibility)
$$;

-- ---------------------------------------------------------------------------
-- 6. Triggers. Each one swallows its own failure: a chat problem must never
--    break the parent write. Only a warning (no content) is emitted.
-- ---------------------------------------------------------------------------

-- tasks insert (single tasks): the controller's request.
create function threadlink_private.chat_on_task_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content text;
begin
  if new.task_type = 'team' then
    return null;
  end if;
  begin
    v_content := case
      when pg_catalog.left(new.content, char_length(new.title)) = new.title then new.content
      else new.title || E'\n\n' || new.content end;
    perform threadlink_private.chat_write(
      new.owner_user_id, threadlink_private.chat_room_for_session(new.owner_user_id, new.target_session_id),
      new.target_session_id, null, new.id, null, 'controller', null,
      threadlink_private.chat_controller_label(new.origin_session_id), null,
      case threadlink_private.chat_session_provider(new.target_session_id)
        when 'codex' then 'codex' else 'claude-code' end,
      'request', null, null, null, null, v_content, 2000, 'visible');
  exception when others then
    raise warning 'threadlink chat: task request not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_task_insert after insert on public.tasks
  for each row execute function threadlink_private.chat_on_task_insert();

-- tasks status (single tasks): started / finished / failed / cancelled, with a
-- reason built here from the task's own columns (never from agent text).
create function threadlink_private.chat_on_task_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
  v_event text;
  v_body text;
  v_visibility text := 'visible';
begin
  if new.task_type = 'team' or new.status is not distinct from old.status then
    return null;
  end if;
  begin
    v_label := coalesce(threadlink_private.chat_provider_label(
      threadlink_private.chat_session_provider(new.target_session_id)), 'The agent');
    case new.status
      when 'working' then
        v_event := 'task_started';
        v_body := v_label || ' started working';
      when 'completed' then
        v_event := 'task_completed';
        v_body := v_label || ' finished';
        v_visibility := 'technical';
      when 'failed' then
        v_event := 'task_failed';
        v_body := case new.failure_reason
          when 'lease_exhausted' then 'The task failed: no worker finished it in time.'
          when 'session_busy' then 'The task failed: the conversation was busy.'
          when 'native_session_unavailable' then 'The task failed: the conversation is not available.'
          when 'background_mode_unsupported' then 'The task failed: this agent cannot work in the background.'
          else 'The task failed.' end;
      when 'expired' then
        v_event := 'task_failed';
        v_body := 'The task expired before an agent picked it up.';
      when 'cancelled' then
        v_event := 'task_cancelled';
        v_body := case new.cancel_reason
          when 'link_revoked' then 'Cancelled: the link to the agent was removed.'
          when 'route_invalid' then 'Cancelled: the agent can no longer be reached.'
          else 'Cancelled.' end;
      else
        return null;
    end case;
    perform threadlink_private.chat_write(
      new.owner_user_id, threadlink_private.chat_room_for_session(new.owner_user_id, new.target_session_id),
      new.target_session_id, null, new.id, null, 'threadlink', null, 'ThreadLink', null, null,
      v_event, null, null, null, null, v_body, 300, v_visibility);
  exception when others then
    raise warning 'threadlink chat: task status not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_task_status after update of status on public.tasks
  for each row execute function threadlink_private.chat_on_task_status();

-- messages insert (single tasks): the agent's progress and result. Written as
-- AGENT rows (the text is the agent's), never as ThreadLink rows.
create function threadlink_private.chat_on_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_provider text;
begin
  if new.message_type not in ('progress', 'result') then
    return null;
  end if;
  begin
    select * into v_task from public.tasks where id = new.task_id;
    if not found or v_task.task_type = 'team' or new.sender_session_id <> v_task.target_session_id then
      return null;
    end if;
    v_provider := threadlink_private.chat_session_provider(v_task.target_session_id);
    if v_provider is null then
      return null;
    end if;
    perform threadlink_private.chat_write(
      v_task.owner_user_id, threadlink_private.chat_room_for_session(v_task.owner_user_id, v_task.target_session_id),
      v_task.target_session_id, null, v_task.id, null, 'agent', v_provider,
      threadlink_private.chat_provider_label(v_provider), null, null,
      case new.message_type when 'result' then 'agent_result' else 'task_progress' end,
      null, null, null, null, new.content,
      case new.message_type when 'result' then 6000 else 300 end,
      case new.message_type when 'result' then 'visible' else 'technical' end);
  exception when others then
    raise warning 'threadlink chat: task message not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_message_insert after insert on public.messages
  for each row execute function threadlink_private.chat_on_message_insert();

-- team_jobs insert: the controller's request (owner requests are written by
-- post_chat_message itself, with their idempotency key) and "job started".
create function threadlink_private.chat_on_job_insert()
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
    if new.origin = 'controller' then
      perform threadlink_private.chat_write(
        new.owner_user_id, new.room_id, v_task.target_session_id, new.id, new.task_id, null, 'controller', null,
        threadlink_private.chat_controller_label(v_task.origin_session_id), null, 'team',
        'request', null, null, null, null, new.goal, 2000, 'visible');
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
create trigger chat_on_job_insert after insert on public.team_jobs
  for each row execute function threadlink_private.chat_on_job_insert();

-- team_jobs update: phase moves, the verdict, stop requests. Every word is
-- built here from the job's columns; only the runtime-stored summary is
-- quoted, after the verdict line that the database itself decided.
-- The fixed sentence for a verdict reason code. Never built from agent text.
create function threadlink_private.chat_reason_text(p_code text)
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
    else null end
$$;
revoke all on function threadlink_private.chat_reason_text(text) from public;

create function threadlink_private.chat_on_job_update()
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
                then E'\n' || threadlink_private.chat_reason_text(new.verdict_reason)
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
create trigger chat_on_job_update after update on public.team_jobs
  for each row execute function threadlink_private.chat_on_job_update();

-- team_nodes status. The unit is named by its key (a constrained identifier),
-- not by its free-text title.
create function threadlink_private.chat_on_node_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    perform threadlink_private.chat_job_event(v_job, 'unit_status',
      'Unit ' || new.node_key || ': ' || case new.status
        when 'pending' then 'pending' when 'ready' then 'ready' when 'running' then 'in progress'
        when 'in_review' then 'in review' when 'changes_requested' then 'changes requested'
        when 'approved' then 'approved' when 'integrated' then 'integrated' when 'failed' then 'failed'
        when 'skipped' then 'skipped' else new.status end,
      case when new.status in ('approved', 'changes_requested', 'integrated', 'failed')
           then 'visible' else 'technical' end,
      new.id);
  exception when others then
    raise warning 'threadlink chat: unit status not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_node_status after update of status on public.team_nodes
  for each row execute function threadlink_private.chat_on_node_status();

-- team_messages insert: an AGENT row. The provider is the message's sender,
-- and only a provider that is an agent of the job's room. Messages the
-- orchestrator itself wrote (sender 'threadlink') are not SQL-built text, so
-- they are not shown as ThreadLink's voice: they are skipped.
create function threadlink_private.chat_on_team_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
begin
  if new.sender not in ('claude-code', 'codex') then
    return null;
  end if;
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    -- Only an enabled agent of the room that takes part in THIS job (the
    -- server-built carrier lists exactly the participants).
    if not exists (select 1 from public.room_agents a
                   where a.room_id = v_job.room_id and a.provider = new.sender and a.enabled)
       or not exists (
         select 1 from public.tasks t
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(t.content::jsonb -> 'agents') = 'array'
                then t.content::jsonb -> 'agents' else '[]'::jsonb end) a
         where t.id = v_job.task_id and a ->> 'provider' = new.sender) then
      return null;
    end if;
    perform threadlink_private.chat_write(
      v_job.owner_user_id, v_job.room_id,
      (select t.target_session_id from public.tasks t where t.id = v_job.task_id),
      v_job.id, v_job.task_id, new.node_id, 'agent', new.sender,
      threadlink_private.chat_provider_label(new.sender), new.sender_role,
      case new.receiver when 'claude-code' then 'claude-code' when 'codex' then 'codex'
                        when 'threadlink' then null else 'team' end,
      'agent_message', new.message_type, new.round, null, new.model_observed, new.body, 8192,
      case when new.message_type in ('handoff', 'finding') then 'technical' else 'visible' end);
  exception when others then
    raise warning 'threadlink chat: agent message not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_team_message after insert on public.team_messages
  for each row execute function threadlink_private.chat_on_team_message();

create function threadlink_private.chat_on_team_finding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
begin
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    perform threadlink_private.chat_job_event(v_job, 'finding',
      case new.severity when 'blocking' then 'Blocking finding' when 'important' then 'Important finding'
                        else 'Minor finding' end
      || ' from ' || coalesce(threadlink_private.chat_provider_label(new.raised_by), 'ThreadLink')
      || ' (' || pg_catalog.replace(new.category, '_', ' ') || ')'
      -- Trusted fields only: the title and body are agent text.
      || coalesce(' on unit ' || (select n.node_key from public.team_nodes n where n.id = new.node_id), ''),
      case when new.severity in ('blocking', 'important') then 'visible' else 'technical' end,
      new.node_id);
  exception when others then
    raise warning 'threadlink chat: finding not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_team_finding after insert on public.team_findings
  for each row execute function threadlink_private.chat_on_team_finding();

create function threadlink_private.chat_on_team_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
begin
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    perform threadlink_private.chat_job_event(v_job, 'decision',
      -- The number and the flag only: the title is agent text.
      'Decision TL-' || pg_catalog.lpad(new.number::text, 5, '0')
      || case when new.requires_user then E'\nThis needs your decision.' else '' end,
      'visible');
  exception when others then
    raise warning 'threadlink chat: decision not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_team_decision after insert on public.team_decisions
  for each row execute function threadlink_private.chat_on_team_decision();

create function threadlink_private.chat_on_model_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.team_jobs;
  v_who text := threadlink_private.chat_provider_label(new.provider);
  v_mismatch boolean := new.observed_model is not null and new.observed_model <> new.requested_model;
begin
  begin
    select * into v_job from public.team_jobs where id = new.job_id;
    perform threadlink_private.chat_write(
      v_job.owner_user_id, v_job.room_id,
      (select t.target_session_id from public.tasks t where t.id = v_job.task_id),
      v_job.id, v_job.task_id, new.node_id, 'threadlink', null, 'ThreadLink', new.role, null,
      case when v_mismatch then 'model_mismatch' else 'model_used' end, null, null,
      new.requested_model, new.observed_model,
      case when v_mismatch
           then v_who || ' asked for ' || new.requested_model || ' but ran on ' || new.observed_model
                || ' (' || pg_catalog.replace(new.role, '_', ' ') || ').'
           else v_who || ' ' || pg_catalog.replace(new.role, '_', ' ') || ' ran on '
                || coalesce(new.observed_model, new.requested_model) || ' (' || new.model_class || ').' end,
      500,
      case when v_mismatch then 'visible' else 'technical' end);
  exception when others then
    raise warning 'threadlink chat: model usage not recorded (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger chat_on_model_usage after insert on public.model_usage_events
  for each row execute function threadlink_private.chat_on_model_usage();

-- ---------------------------------------------------------------------------
-- 7. Team status: now says the mode, the builder, the origin and whether the
--    owner asked the job to stop (the Runtime reads it from every write).
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
-- 8. Starting a job: one private core for the controller and the owner
-- ---------------------------------------------------------------------------

/*
 * Creates the carrier task (task_type 'team') over p_link and the team job,
 * atomically. The caller has already authenticated its principal and resolved
 * the room and the link; everything else is checked here, for both paths:
 * route alive and unpaused, Runtime version for the mode, every participating
 * agent installed and signed in with a subscription, verify commands only from
 * the room policy, paid usage only from the owner's provider profiles, the
 * per-link open-task cap and the per-origin rate limit (the same rules
 * create_task applies).
 */
create function threadlink_private.team_start_job(
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
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_goal text := pg_catalog.btrim(p_goal);
  v_mode text := coalesce(p_mode, 'team');
  v_builder text;
  v_reviewer text;
  v_participants text[];
  v_planning integer := least(greatest(coalesce(p_max_planning_rounds, p_room.max_planning_rounds), 1), 5);
  v_review integer := least(greatest(coalesce(p_max_review_rounds, p_room.max_review_rounds), 1), 6);
  v_parallel integer := least(greatest(coalesce(p_parallel_agents, p_room.parallel_agents), 1), 4);
  v_verify text[] := p_room.verify_commands;
  v_runtime_version text;
  v_paid boolean;
  v_job_id text := threadlink_private.generate_id('tljob');
  v_task_id text;
  v_content jsonb;
  v_existing text;
  v_open integer;
  v_recent integer;
begin
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
  if not threadlink_private.valid_verify_commands(v_verify) then
    raise exception 'invalid verify commands' using errcode = '22023';
  end if;
  -- A project that requires review cannot be bypassed by a controller asking
  -- for a solo job. Only the owner may choose solo there, explicitly.
  if v_mode = 'solo' and p_origin <> 'owner' and p_room.cross_review then
    raise exception 'This project requires review; use Builder + Reviewer or Team'
      using errcode = '42501', hint = 'review_required';
  end if;

  -- Who takes part. Solo: the builder alone. Pair: the builder and the other
  -- provider as reviewer. Team: every enabled agent of the room.
  if v_mode = 'team' then
    select coalesce(array_agg(provider order by provider), '{}') into v_participants
    from public.room_agents where room_id = p_room.id and enabled;
  else
    v_builder := coalesce(p_builder,
      (select provider from public.room_agents where room_id = p_room.id and enabled
       order by case provider when 'claude-code' then 0 else 1 end limit 1));
    v_reviewer := case when v_mode = 'pair'
                       then case v_builder when 'claude-code' then 'codex' else 'claude-code' end end;
    v_participants := array_remove(array[v_builder, v_reviewer], null);
    if v_builder is null or exists (
         select 1 from unnest(v_participants) p
         where not exists (select 1 from public.room_agents a
                           where a.room_id = p_room.id and a.provider = p and a.enabled)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
  end if;
  if cardinality(v_participants) = 0 then
    raise exception 'this project has no agents' using errcode = '55000', hint = 'agent_not_in_project';
  end if;

  -- The route must be alive: the exact link, active, unpaused, to a usable agent.
  if p_link.id is null or p_link.owner_user_id <> p_owner or p_link.status <> 'active'
     or p_link.agent_session_id is distinct from p_room.agent_session_id
     or not threadlink_private.session_is_usable(p_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002', hint = 'route_missing';
  end if;
  if p_link.paused then
    raise exception 'link is paused' using errcode = '55000', hint = 'link_paused';
  end if;

  -- The Runtime this room lives on must run this mode (checked per Runtime:
  -- another, newer computer on the account says nothing about this one).
  select r.version into v_runtime_version
  from public.session_bindings sb
  join public.runtimes r on r.id = sb.runtime_id
  where sb.id = p_room.agent_session_id and sb.owner_user_id = p_owner;
  if not threadlink_private.version_at_least(v_runtime_version, 0,
                                             threadlink_private.team_min_runtime_minor(v_mode)) then
    raise exception 'team mode unavailable: update the ThreadLink app on the computer this project runs on'
      using errcode = '55000', hint = 'runtime_outdated';
  end if;

  -- Every participating agent reported installed and signed in with a
  -- subscription (an API-key sign-in is paid usage nobody switched on).
  if exists (
    select 1
    from unnest(v_participants) p(provider)
    left join public.provider_profiles pp on pp.owner_user_id = p_owner and pp.provider = p.provider
    where not (
      coalesce((pp.detected ->> 'installed')::boolean, false)
      and coalesce((pp.detected ->> 'authenticated')::boolean, false)
      and (pp.detected ->> 'authMethod') = case p.provider when 'claude-code' then 'claude.ai'
                                                            when 'codex' then 'chatgpt' end)
  ) then
    raise exception 'team mode unavailable: update the ThreadLink app and sign in to every agent in this room'
      using errcode = '55000', hint = 'agents_unavailable';
  end if;

  -- Paid usage only from the owner's profiles: on only if on for every participant.
  select coalesce(bool_and(coalesce(pp.paid_usage_enabled, false)), false) into v_paid
  from unnest(v_participants) p(provider)
  left join public.provider_profiles pp on pp.owner_user_id = p_owner and pp.provider = p.provider;

  -- Idempotent replay (controller path): the same key returns the same job.
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

  v_content := jsonb_build_object(
    'kind', 'threadlink.team_job',
    'version', 1,
    'jobId', v_job_id,
    'roomId', p_room.id,
    'roomName', p_room.name,
    'goal', v_goal,
    'spec', coalesce(p_spec, '{}'::jsonb),
    -- New in collaboration chat (optional for a Runtime that predates them).
    'mode', v_mode,
    'builder', v_builder,
    'reviewer', v_reviewer,
    'origin', p_origin,
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

  -- The "team" task type is reserved: only this function creates one, and
  -- only for the length of this call.
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
     max_planning_rounds, max_review_rounds, parallel_agents, verify_commands, mode, builder_provider, origin)
  values
    (v_job_id, p_owner, p_room.id, v_task_id, v_goal, p_spec,
     v_planning, v_review, v_parallel, v_verify, v_mode, v_builder, p_origin);

  perform threadlink_private.record_event(
    p_owner, p_actor_connection_id, 'team.job_started', 'team_job', v_job_id,
    jsonb_build_object('room_id', p_room.id, 'task_id', v_task_id, 'mode', v_mode, 'origin', p_origin));
  return threadlink_private.team_status_json(v_job_id) || jsonb_build_object('created', true);
end;
$$;

-- The controller path, shared by both public overloads.
create function threadlink_private.team_start_job_from_controller(
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
  v_result := threadlink_private.team_start_job(
    v_connection.owner_user_id, v_connection.id, 'controller', v_room, v_link,
    p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds, p_parallel_agents,
    p_mode, p_builder, p_idempotency_key);
  perform threadlink_private.touch_session(v_session.id);
  return v_result;
end;
$$;

-- The original signature, unchanged for existing callers: always Team Mode.
create or replace function public.start_team_job(
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
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_from_controller(
    p_token_hash, p_session_id, p_room_id, p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds,
    p_parallel_agents, p_verify_commands, p_idempotency_key, null, null)
$$;

-- With a mode and builder. Every argument is required (no defaults), so a call
-- that omits p_mode/p_builder can only ever resolve to the original overload.
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
  p_builder text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select threadlink_private.team_start_job_from_controller(
    p_token_hash, p_session_id, p_room_id, p_goal, p_spec, p_max_planning_rounds, p_max_review_rounds,
    p_parallel_agents, p_verify_commands, p_idempotency_key, p_mode, p_builder)
$$;

-- ---------------------------------------------------------------------------
-- 9. Runtime write: + modelObserved on messages, + read_owner_notes
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
    perform threadlink_private.tj_keys(v_p, array['verdict', 'evidence', 'summary', 'reason']);
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
-- 10. Owner messages and routing (Clerk-authenticated)
-- ---------------------------------------------------------------------------

/*
 * The owner types into the project chat. auth.uid() must own the (active)
 * room. A leading @claude / @codex / @team decides where it goes; p_mode and
 * p_builder are hints from the composer, validated here and never trusted
 * over the mention.
 *
 *   active job  + "@team stop..."  -> stop_requested_at set on that job
 *   active job  + anything else    -> an owner note for the Runtime to deliver
 *   no active job                  -> a new job over the room's route
 *
 * Failures raise with a stable HINT (the reason code); the server maps it to a
 * human sentence and never shows database text. Idempotent per owner by
 * p_idempotency_key; at most 20 posts per room per minute, 4000 characters each.
 */
create function public.post_chat_message(
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
  v_prev public.chat_events;
  v_raw text;
  v_match text[];
  v_mention text;
  v_rest text;
  v_body text;
  v_goal text;
  v_job public.team_jobs;
  v_link public.thread_links;
  v_mode text;
  v_builder text;
  v_audience text;
  v_event_id text;
  v_status jsonb;
  v_agents text[];
begin
  if v_owner is null then
    raise exception 'authentication required' using errcode = '28000', hint = 'unauthenticated';
  end if;
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  -- Locks the room: posts to one room are serialised, so the rate limit and
  -- the "is a job active?" decision cannot race.
  v_room := threadlink_private.require_owned_room(p_room_id);

  -- Replay: the same key returns the first answer and changes nothing.
  if p_idempotency_key is not null then
    select * into v_prev from public.chat_events
    where owner_user_id = v_owner and idempotency_key = p_idempotency_key;
    if found then
      if v_prev.room_id is distinct from v_room.id then
        raise exception 'idempotency key already used' using errcode = '55000', hint = 'idempotency_conflict';
      end if;
      return jsonb_build_object(
        'routed', case when v_prev.event_type = 'request' then 'new_job'
                       when v_prev.body ~* threadlink_private.chat_stop_pattern() then 'stop_requested'
                       else 'note_to_active_job' end,
        'job_id', v_prev.job_id, 'event_id', v_prev.id, 'replayed', true);
    end if;
  end if;

  if v_room.status <> 'active' then
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
      where room_id = v_room.id and author_kind = 'owner'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_owner_posts_per_minute() then
    raise exception 'too many messages' using errcode = '54000', hint = 'rate_limited';
  end if;
  if (select count(*) from public.chat_events
      where owner_user_id = v_owner and author_kind = 'owner'
        and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_owner_posts_per_minute_total() then
    raise exception 'too many messages' using errcode = '54000', hint = 'rate_limited';
  end if;

  -- What is shown and stored: cleaned and redacted. A secret typed into the
  -- chat is redacted everywhere, including a job goal made from it.
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

  select coalesce(array_agg(provider), '{}') into v_agents
  from public.room_agents where room_id = v_room.id and enabled;

  select * into v_job from public.team_jobs
  where room_id = v_room.id and owner_user_id = v_owner and finished_at is null
  order by created_at desc
  limit 1
  for update;

  if found then
    if v_body ~* threadlink_private.chat_stop_pattern() then
      insert into public.chat_events
        (owner_user_id, room_id, agent_session_id, job_id, author_kind, author_label, audience, event_type,
         body, visibility, delivered_at, idempotency_key)
      values
        (v_owner, v_room.id, v_room.agent_session_id, v_job.id, 'owner', 'You', 'team', 'message',
         v_body, 'visible', pg_catalog.now(), p_idempotency_key)
      returning id into v_event_id;
      if v_job.stop_requested_at is null then
        update public.team_jobs set stop_requested_at = pg_catalog.now() where id = v_job.id;
        perform threadlink_private.record_event(v_owner, null, 'team.stop_requested', 'team_job', v_job.id,
          jsonb_build_object('room_id', v_room.id));
      end if;
      return jsonb_build_object('routed', 'stop_requested', 'job_id', v_job.id, 'event_id', v_event_id);
    end if;

    v_audience := coalesce(v_mention, 'team');
    if v_audience <> 'team' and not (v_audience = any (v_agents)) then
      raise exception 'that agent is not part of this project' using errcode = '55000',
        hint = 'agent_not_in_project';
    end if;
    insert into public.chat_events
      (owner_user_id, room_id, agent_session_id, job_id, author_kind, author_label, audience, event_type,
       body, visibility, idempotency_key)
    values
      (v_owner, v_room.id, v_room.agent_session_id, v_job.id, 'owner', 'You', v_audience, 'message',
       v_body, 'visible', p_idempotency_key)
    returning id into v_event_id;
    return jsonb_build_object('routed', 'note_to_active_job', 'job_id', v_job.id, 'event_id', v_event_id);
  end if;

  -- No active job: the message starts one.
  if v_body ~* threadlink_private.chat_stop_pattern() then
    raise exception 'nothing to stop' using errcode = '55000', hint = 'nothing_to_stop';
  end if;
  v_goal := v_rest;
  if v_goal is null or v_goal = '' then
    raise exception 'empty message' using errcode = '22023', hint = 'empty';
  end if;

  if p_mode = 'pair' then
    v_mode := 'pair';
    v_builder := coalesce(case when v_mention in ('claude-code', 'codex') then v_mention end, p_builder,
                          'claude-code');
  elsif v_mention in ('claude-code', 'codex') then
    v_mode := 'solo';
    v_builder := v_mention;
  elsif v_mention = 'team' or p_mode = 'team' then
    v_mode := 'team';
  elsif p_mode = 'solo' then
    v_mode := 'solo';
    v_builder := p_builder;
  elsif cardinality(v_agents) >= 2 then
    v_mode := 'team';
  else
    v_mode := 'solo';
    v_builder := coalesce(p_builder, v_agents[1]);
  end if;
  v_audience := case when v_mode = 'solo' and v_builder is not null then v_builder else 'team' end;

  -- The room's route: the most recent active link to the room's agent session.
  select * into v_link from public.thread_links
  where owner_user_id = v_owner and agent_session_id = v_room.agent_session_id and status = 'active'
  order by approved_at desc nulls last, created_at desc
  limit 1
  for share;
  if not found or not threadlink_private.session_is_usable(v_link.agent_session_id)
     or not threadlink_private.session_is_usable(v_link.controller_session_id) then
    raise exception 'this project is not linked any more' using errcode = '55000', hint = 'route_missing';
  end if;

  -- The owner's message first, so the timeline reads request -> job started.
  insert into public.chat_events
    (owner_user_id, room_id, agent_session_id, author_kind, author_label, audience, event_type,
     body, visibility, idempotency_key)
  values
    (v_owner, v_room.id, v_room.agent_session_id, 'owner', 'You', v_audience, 'request',
     v_body, 'visible', p_idempotency_key)
  returning id into v_event_id;

  v_status := threadlink_private.team_start_job(
    v_owner, null, 'owner', v_room, v_link, v_goal, null, null, null, null, v_mode, v_builder, null);

  update public.chat_events set job_id = v_status ->> 'job_id' where id = v_event_id;
  return jsonb_build_object('routed', 'new_job', 'job_id', v_status ->> 'job_id', 'event_id', v_event_id,
                            'mode', v_mode, 'builder', v_builder);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. The Runtime may set the owner's DECLARED plan (and nothing else)
-- ---------------------------------------------------------------------------

/*
 * A deliberate, narrow widening so the desktop app can edit the plan: the
 * declared plan only -- never usage policy, never paid usage. Same per-provider
 * validation as set_provider_profile. Audited as provider.plan_set_from_device.
 * Detection (report_provider_detection) still never touches declared_plan.
 */
create function public.set_runtime_provider_plan(p_token_hash text, p_provider text, p_declared_plan text)
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
  if p_declared_plan is null or not (p_declared_plan = any (
       case p_provider when 'claude-code' then threadlink_private.team_claude_plans()
                       else threadlink_private.team_chatgpt_plans() end)) then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('threadlink:runtime-plan:' || v_runtime.owner_user_id, 0));
  if (select count(*) from public.audit_events
      where owner_user_id = v_runtime.owner_user_id and action = 'provider.plan_set_from_device'
        and created_at > pg_catalog.now() - interval '1 hour')
     >= threadlink_private.runtime_plan_changes_per_hour() then
    raise exception 'too many plan changes' using errcode = '54000', hint = 'rate_limited';
  end if;
  insert into public.provider_profiles (owner_user_id, provider, declared_plan)
  values (v_runtime.owner_user_id, p_provider, p_declared_plan)
  on conflict (owner_user_id, provider) do update set declared_plan = excluded.declared_plan;
  perform threadlink_private.record_event(v_runtime.owner_user_id, v_connection.id,
    'provider.plan_set_from_device', 'provider_profile',
    (select id from public.provider_profiles where owner_user_id = v_runtime.owner_user_id and provider = p_provider),
    jsonb_build_object('provider', p_provider, 'declared_plan', p_declared_plan, 'runtime_id', v_runtime.id));
  return threadlink_private.provider_profile_json(v_runtime.owner_user_id, p_provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Privileges: revoke everything new from every client role, then grant
--     exactly its audience (credential RPCs -> anon; owner RPCs -> authenticated).
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.chat_event_types()', 'threadlink_private.chat_model_pattern()',
    'threadlink_private.chat_body_max_bytes()', 'threadlink_private.chat_owner_max_chars()',
    'threadlink_private.chat_owner_posts_per_minute()', 'threadlink_private.team_min_runtime_minor(text)',
    'threadlink_private.chat_owner_posts_per_minute_total()', 'threadlink_private.runtime_plan_changes_per_hour()',
    'threadlink_private.chat_stop_pattern()', 'threadlink_private.chat_strip_invisible(text)',
    'threadlink_private.chat_controller_name(text, text)',
    'threadlink_private.chat_events_guard_update()', 'threadlink_private.redact_text(text)',
    'threadlink_private.chat_clean(text, integer)', 'threadlink_private.chat_provider_label(text)',
    'threadlink_private.chat_session_provider(text)', 'threadlink_private.chat_controller_label(text)',
    'threadlink_private.chat_room_for_session(text, text)', 'threadlink_private.chat_job_status_label(text)',
    'threadlink_private.chat_write(text, text, text, text, text, text, text, text, text, text, text, text, text, '
      || 'integer, text, text, text, integer, text)',
    'threadlink_private.chat_job_event(public.team_jobs, text, text, text, text)',
    'threadlink_private.chat_on_task_insert()', 'threadlink_private.chat_on_task_status()',
    'threadlink_private.chat_on_message_insert()', 'threadlink_private.chat_on_job_insert()',
    'threadlink_private.chat_on_job_update()', 'threadlink_private.chat_on_node_status()',
    'threadlink_private.chat_on_team_message()', 'threadlink_private.chat_on_team_finding()',
    'threadlink_private.chat_on_team_decision()', 'threadlink_private.chat_on_model_usage()',
    'threadlink_private.team_start_job(text, text, text, public.rooms, public.thread_links, text, jsonb, '
      || 'integer, integer, integer, text, text, text)',
    'threadlink_private.team_start_job_from_controller(text, text, text, text, jsonb, integer, integer, '
      || 'integer, text[], text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;

  foreach f in array array[
    'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text)',
    'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text, text, text)',
    'public.team_job_write(text, text, text, text, text, jsonb)',
    'public.set_runtime_provider_plan(text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;

  foreach f in array array[
    'public.post_chat_message(text, text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$grants$;
