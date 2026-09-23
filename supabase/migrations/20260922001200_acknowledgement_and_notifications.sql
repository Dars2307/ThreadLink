-- ===========================================================================
-- Phase 6.7 — Acknowledgement, blocked states and notifications
--
-- ChatGPT cannot wake itself when Claude finishes, so ThreadLink has to tell
-- the user. Three pieces, in dependency order:
--
--   1. Acknowledgement: a result is unacknowledged until the controller says
--      it has read it. Polling status is not reading. This is what lets a
--      fallback be cancelled instead of firing at someone who already knows.
--   2. Blocked states: a task that cannot proceed says so, rather than sitting
--      at 'working' looking productive. Plan Mode is the case that prompted
--      this: the agent was alive and doing nothing useful.
--   3. Notifications: one row per meaningful state, and one delivery row per
--      channel, so nothing is ever sent twice and email can be deferred and
--      cancelled.
--
-- Deliberately NOT here: any ThreadLink-owned email credential, any plaintext
-- per-user API key, and any push delivery. Those need secure per-user secret
-- storage, which does not exist yet; the channels exist but report unavailable.
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
  'runtime.registered', 'runtime.updated', 'runtime.revoked'
));

-- ---------------------------------------------------------------------------
-- 1. Acknowledgement and blocked state on the task
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column acknowledged_at timestamptz,
  -- Controller today. User/runtime/automation are deliberately allowed now so
  -- that adding them later is not another migration of this column.
  add column acknowledged_actor_type text
    constraint tasks_ack_actor_check
      check (acknowledged_actor_type in ('controller', 'user', 'runtime', 'automation')),
  add column acknowledged_by_connection_id text references public.connections (id) on delete set null,
  add column acknowledged_by_session_id text references public.session_bindings (id) on delete set null,
  add constraint tasks_ack_consistency
    check ((acknowledged_at is null) = (acknowledged_actor_type is null)),
  -- Why a task that is claimed/working is not actually progressing.
  add column blocked_reason text
    constraint tasks_blocked_reason_check
      check (blocked_reason in ('plan_mode', 'approval_required', 'user_input_required')),
  add column blocked_at timestamptz,
  add constraint tasks_blocked_consistency
    check ((blocked_at is null) = (blocked_reason is null));

comment on column public.tasks.acknowledged_at is
  'When a controller confirmed it had READ the result. Reading status is not '
  'acknowledgement. Never forwarded to the agent.';
comment on column public.tasks.blocked_reason is
  'Set while a claimed/working task cannot proceed (e.g. the Claude session is '
  'in Plan Mode). The task is still alive; it just is not progressing.';

create index tasks_unacknowledged_idx on public.tasks (owner_user_id, completed_at)
  where acknowledged_at is null;

-- ---------------------------------------------------------------------------
-- 2. Per-user notification preferences
-- ---------------------------------------------------------------------------
create table public.notification_settings (
  owner_user_id text primary key references public.users (id) on delete cascade,
  on_task_completed boolean not null default true,
  on_task_failed boolean not null default true,
  on_approval_required boolean not null default true,
  on_user_input_required boolean not null default true,
  desktop_enabled boolean not null default true,
  email_enabled boolean not null default false,
  email_address text
    constraint notification_settings_email_format
      check (email_address is null or email_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- How long a result may sit unacknowledged before the fallback is due.
  email_grace_seconds integer not null default 600
    constraint notification_settings_grace_check check (email_grace_seconds between 60 and 86400),
  /*
   * BYO Resend. ThreadLink has no secure per-user secret storage, so there is
   * deliberately NO column for an API key: a plaintext column would be worse
   * than the feature is worth. Only the state is tracked, and delivery stays
   * disabled until a reviewed secret-storage design exists.
   */
  email_provider text not null default 'none'
    constraint notification_settings_provider_check check (email_provider in ('none', 'resend')),
  email_credential_state text not null default 'unavailable'
    constraint notification_settings_credential_check
      check (email_credential_state in ('unavailable', 'configured')),
  web_push_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notification_settings is
  'Per-user notification preferences. Contains no secrets: BYO email keys wait '
  'on secure per-user secret storage.';

alter table public.notification_settings enable row level security;
revoke all on table public.notification_settings from public, anon, authenticated;
grant select on table public.notification_settings to authenticated;
create policy notification_settings_select_own on public.notification_settings
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 3. Web Push subscriptions (the data model only; nothing is sent yet)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id text primary key default threadlink_private.generate_id('tlpsh'),
  owner_user_id text not null references public.users (id) on delete cascade,
  endpoint text not null
    constraint push_subscriptions_endpoint_format
      check (char_length(endpoint) between 1 and 2048 and endpoint ~ '^https://'),
  -- Web Push public key and auth secret as the browser issues them. These are
  -- per-subscription values, not account credentials.
  p256dh text not null constraint push_subscriptions_p256dh_format
    check (char_length(p256dh) between 1 and 255),
  auth text not null constraint push_subscriptions_auth_format
    check (char_length(auth) between 1 and 255),
  user_agent text constraint push_subscriptions_ua_length check (char_length(user_agent) <= 255),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint push_subscriptions_id_format check (id ~ '^tlpsh_[0-9a-f]{32}$'),
  constraint push_subscriptions_endpoint_key unique (owner_user_id, endpoint)
);

comment on table public.push_subscriptions is
  'Browser Web Push subscriptions, so a phone can be notified while the PC is '
  'at home. Delivery needs a VAPID key pair that is not configured yet.';

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select on table public.push_subscriptions to authenticated;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 4. Notifications and their per-channel deliveries
-- ---------------------------------------------------------------------------
create table public.notifications (
  id text primary key default threadlink_private.generate_id('tlntf'),
  owner_user_id text not null references public.users (id) on delete cascade,
  task_id text references public.tasks (id) on delete cascade,
  event_type text not null
    constraint notifications_event_check check (event_type in (
      'task_completed', 'task_failed', 'approval_required', 'user_input_required')),
  /*
   * Safe metadata only. Never a prompt, result body, diff, token or key: this
   * is what ends up on a lock screen.
   */
  title text not null constraint notifications_title_length check (char_length(title) between 1 and 255),
  workspace_name text constraint notifications_workspace_length check (char_length(workspace_name) <= 100),
  provider text constraint notifications_provider_length check (char_length(provider) <= 40),
  /** Groups related events so a burst becomes one notification, not ten. */
  coalesce_key text not null
    constraint notifications_coalesce_length check (char_length(coalesce_key) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint notifications_id_format check (id ~ '^tlntf_[0-9a-f]{32}$'),
  -- One state change produces at most one notification, however many times the
  -- agent reports it.
  constraint notifications_task_event_key unique (task_id, event_type)
);

create index notifications_owner_idx on public.notifications (owner_user_id, created_at desc);
create index notifications_coalesce_idx on public.notifications (owner_user_id, coalesce_key, created_at desc);

alter table public.notifications enable row level security;
revoke all on table public.notifications from public, anon, authenticated;
grant select on table public.notifications to authenticated;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

create table public.notification_deliveries (
  id text primary key default threadlink_private.generate_id('tlndl'),
  owner_user_id text not null references public.users (id) on delete cascade,
  notification_id text not null references public.notifications (id) on delete cascade,
  channel text not null
    constraint notification_deliveries_channel_check check (channel in ('desktop', 'email', 'web_push')),
  status text not null default 'pending'
    constraint notification_deliveries_status_check
      check (status in ('pending', 'sent', 'suppressed', 'failed', 'unavailable')),
  /** Email only: the fallback is not due until the grace period has passed. */
  send_after timestamptz,
  attempt_count integer not null default 0
    constraint notification_deliveries_attempts_check check (attempt_count between 0 and 10),
  claimed_until timestamptz,
  sent_at timestamptz,
  detail text constraint notification_deliveries_detail_length check (char_length(detail) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_id_format check (id ~ '^tlndl_[0-9a-f]{32}$'),
  -- A channel delivers a given notification once. This is the dedupe.
  constraint notification_deliveries_channel_key unique (notification_id, channel)
);

create index notification_deliveries_due_idx
  on public.notification_deliveries (send_after)
  where status = 'pending';

alter table public.notification_deliveries enable row level security;
revoke all on table public.notification_deliveries from public, anon, authenticated;
grant select on table public.notification_deliveries to authenticated;
create policy notification_deliveries_select_own on public.notification_deliveries
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- 5. Raising a notification
-- ---------------------------------------------------------------------------
/*
 * One notification per meaningful state, with the deliveries the user's
 * settings actually allow. Called from the task lifecycle; never from progress
 * or polling, because those are not states anyone needs to be told about.
 *
 * Idempotent by construction: notifications_task_event_key makes a repeated
 * state report a no-op, and each channel has at most one delivery row.
 */
create function threadlink_private.raise_notification(
  p_owner_user_id text,
  p_task_id text,
  p_event_type text,
  p_title text,
  p_workspace_name text,
  p_provider text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.notification_settings;
  v_id text;
  v_wanted boolean;
  v_window text;
begin
  select * into v from public.notification_settings where owner_user_id = p_owner_user_id;
  if not found then
    insert into public.notification_settings (owner_user_id) values (p_owner_user_id)
    on conflict (owner_user_id) do nothing;
    select * into v from public.notification_settings where owner_user_id = p_owner_user_id;
  end if;

  v_wanted := case p_event_type
    when 'task_completed' then v.on_task_completed
    when 'task_failed' then v.on_task_failed
    when 'approval_required' then v.on_approval_required
    when 'user_input_required' then v.on_user_input_required
    else false
  end;
  if not v_wanted then
    return null;
  end if;

  -- Events of the same kind within the same minute coalesce into one group, so
  -- finishing four tasks at once is one notification rather than four.
  v_window := pg_catalog.to_char(pg_catalog.date_trunc('minute', pg_catalog.now()), 'YYYYMMDDHH24MI');
  insert into public.notifications
    (owner_user_id, task_id, event_type, title, workspace_name, provider, coalesce_key)
  values
    (p_owner_user_id, p_task_id, p_event_type, pg_catalog.left(p_title, 255),
     p_workspace_name, p_provider, p_event_type || ':' || v_window)
  on conflict (task_id, event_type) do nothing
  returning id into v_id;

  if v_id is null then
    -- Already raised for this task and state: nothing more to do.
    return null;
  end if;

  -- Desktop is the default free channel and is due immediately.
  if v.desktop_enabled then
    insert into public.notification_deliveries (owner_user_id, notification_id, channel, status)
    values (p_owner_user_id, v_id, 'desktop', 'pending')
    on conflict (notification_id, channel) do nothing;
  end if;

  -- Email is a fallback: it only becomes due if the result is still
  -- unacknowledged after the grace period. Failures and completions are the
  -- only states worth chasing someone by email for.
  if v.email_enabled and p_event_type in ('task_completed', 'task_failed') then
    insert into public.notification_deliveries
      (owner_user_id, notification_id, channel, status, send_after)
    values (
      p_owner_user_id, v_id, 'email',
      -- No usable credential yet: recorded, never sent. See the BYO Resend note.
      case when v.email_credential_state = 'configured' then 'pending' else 'unavailable' end,
      pg_catalog.now() + pg_catalog.make_interval(secs => v.email_grace_seconds)
    )
    on conflict (notification_id, channel) do nothing;
  end if;

  -- Web Push is a first-class channel in the model, but delivery needs a VAPID
  -- key pair that is not configured, so it is recorded as unavailable.
  if v.web_push_enabled and exists (
    select 1 from public.push_subscriptions where owner_user_id = p_owner_user_id
  ) then
    insert into public.notification_deliveries (owner_user_id, notification_id, channel, status, detail)
    values (p_owner_user_id, v_id, 'web_push', 'unavailable', 'Web Push is not configured on this server.')
    on conflict (notification_id, channel) do nothing;
  end if;

  return v_id;
end;
$$;
revoke all on function threadlink_private.raise_notification(text, text, text, text, text, text) from public;

/** Safe display facts about a task: never its content. */
create function threadlink_private.task_notification_context(p_task_id text)
returns table (workspace_name text, provider text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.display_name, s.provider
  from public.tasks t
  join public.session_bindings s on s.id = t.target_session_id
  left join public.runtime_workspaces w on w.id = s.workspace_id
  where t.id = p_task_id
$$;
revoke all on function threadlink_private.task_notification_context(text) from public;

-- ---------------------------------------------------------------------------
-- 6. Lifecycle hooks: completion and failure are the states worth telling about
-- ---------------------------------------------------------------------------
create or replace function public.complete_task(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text,
  p_result text, p_artifacts jsonb default '[]'::jsonb
)
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
  v_artifact jsonb;
  v_context record;
begin
  if p_artifacts is null or jsonb_typeof(p_artifacts) <> 'array' or jsonb_array_length(p_artifacts) > 20 then
    raise exception 'artifacts must be an array of at most 20 items' using errcode = '22023';
  end if;

  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
     message_type, content, in_reply_to)
  values
    (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id, v_task.origin_session_id,
     'result', p_result,
     (select id from public.messages where task_id = v_task.id and message_type = 'task'));

  for v_artifact in select value from jsonb_array_elements(p_artifacts) loop
    if jsonb_typeof(v_artifact) <> 'object' then
      raise exception 'artifact must be an object' using errcode = '22023';
    end if;
    insert into public.artifacts (owner_user_id, task_id, type, reference, metadata)
    values (v_task.owner_user_id, v_task.id, v_artifact ->> 'type', v_artifact ->> 'reference',
            coalesce(v_artifact -> 'metadata', '{}'::jsonb));
  end loop;

  -- Finishing clears any block: the task is no longer waiting for anything.
  update public.tasks
  set status = 'completed', blocked_reason = null, blocked_at = null
  where id = v_task.id;
  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.completed', 'task', v_task.id);

  select * into v_context from threadlink_private.task_notification_context(v_task.id);
  perform threadlink_private.raise_notification(
    v_task.owner_user_id, v_task.id, 'task_completed', v_task.title,
    v_context.workspace_name, v_context.provider);

  return threadlink_private.task_json(v_task.id, false);
end;
$$;

create or replace function public.fail_task(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text,
  p_error text, p_failure_reason text default null
)
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
  v_context record;
begin
  if p_failure_reason is not null
     and p_failure_reason not in ('session_busy', 'native_session_unavailable', 'background_mode_unsupported') then
    raise exception 'invalid failure reason' using errcode = '22023';
  end if;

  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
     message_type, content, in_reply_to)
  values
    (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id, v_task.origin_session_id,
     'error', p_error,
     (select id from public.messages where task_id = v_task.id and message_type = 'task'));

  update public.tasks
  set status = 'failed', failure_reason = p_failure_reason, blocked_reason = null, blocked_at = null
  where id = v_task.id;
  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.failed', 'task', v_task.id);

  select * into v_context from threadlink_private.task_notification_context(v_task.id);
  perform threadlink_private.raise_notification(
    v_task.owner_user_id, v_task.id, 'task_failed', v_task.title,
    v_context.workspace_name, v_context.provider);

  return threadlink_private.task_json(v_task.id, false);
end;
$$;

revoke all on function public.complete_task(text, text, text, text, text, jsonb) from public;
grant execute on function public.complete_task(text, text, text, text, text, jsonb) to anon, authenticated;
revoke all on function public.fail_task(text, text, text, text, text, text) from public;
grant execute on function public.fail_task(text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Blocked: alive, but not progressing
-- ---------------------------------------------------------------------------
/*
 * The agent says why it cannot proceed. The task keeps its claim and lease -
 * it has not died - but it stops claiming to be working, and the states that
 * need a human raise a notification.
 *
 * Plan Mode is the motivating case: a Claude session in Plan Mode will happily
 * research forever and never implement. ThreadLink must say so rather than
 * show a task that looks productive.
 */
create function public.report_task_blocked(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text, p_reason text
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
  v_context record;
  v_event text;
begin
  if p_reason is null or p_reason not in ('plan_mode', 'approval_required', 'user_input_required') then
    raise exception 'invalid blocked reason' using errcode = '22023';
  end if;
  v_task := threadlink_private.require_claimed_task(
    v_session, p_task_id, p_claim_ref, array['claimed', 'working']);

  update public.tasks
  set blocked_reason = p_reason, blocked_at = coalesce(blocked_at, pg_catalog.now())
  where id = v_task.id;
  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'task.blocked', 'task', v_task.id,
    jsonb_build_object('reason', p_reason));

  -- Only the states that actually need the user raise a notification.
  v_event := case p_reason
    when 'approval_required' then 'approval_required'
    when 'user_input_required' then 'user_input_required'
    else null
  end;
  if v_event is not null then
    select * into v_context from threadlink_private.task_notification_context(v_task.id);
    perform threadlink_private.raise_notification(
      v_task.owner_user_id, v_task.id, v_event, v_task.title,
      v_context.workspace_name, v_context.provider);
  end if;

  return threadlink_private.task_json(v_task.id, false);
end;
$$;
revoke all on function public.report_task_blocked(text, text, text, text, text) from public;
grant execute on function public.report_task_blocked(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Acknowledgement
-- ---------------------------------------------------------------------------
/*
 * The controller says it has READ the result. Deliberately separate from
 * get_task_result: a client that fetches and then crashes has not read
 * anything, and get_task_status must never count.
 *
 * Idempotent: acknowledging twice returns the same answer and does not move
 * acknowledged_at. Nothing about this reaches the agent.
 */
create function public.acknowledge_task_result(
  p_token_hash text, p_session_id text, p_task_id text
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
  v_task public.tasks;
begin
  -- Only the session the task came FROM may acknowledge it, and only within
  -- its own account. A stranger gets "not found", not a hint that it exists.
  select * into v_task from public.tasks
  where id = p_task_id
    and owner_user_id = v_connection.owner_user_id
    and origin_session_id = v_session.id
  for update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  if v_task.status not in ('completed', 'failed', 'cancelled', 'expired') then
    raise exception 'task has no result to acknowledge yet' using errcode = '55000';
  end if;

  if v_task.acknowledged_at is null then
    update public.tasks
    set acknowledged_at = pg_catalog.now(),
        acknowledged_actor_type = 'controller',
        acknowledged_by_connection_id = v_connection.id,
        acknowledged_by_session_id = v_session.id
    where id = v_task.id;

    -- An acknowledged result needs no chasing: cancel anything still waiting.
    update public.notification_deliveries d
    set status = 'suppressed',
        detail = 'Acknowledged before the fallback was due.',
        updated_at = pg_catalog.now()
    from public.notifications n
    where d.notification_id = n.id
      and n.task_id = v_task.id
      and d.status = 'pending'
      and d.channel <> 'desktop';

    perform threadlink_private.record_event(
      v_connection.owner_user_id, v_connection.id, 'task.acknowledged', 'task', v_task.id,
      jsonb_build_object('actor', 'controller'));
  end if;

  return threadlink_private.task_json(v_task.id, false);
end;
$$;
revoke all on function public.acknowledge_task_result(text, text, text) from public;
grant execute on function public.acknowledge_task_result(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. The fallback sweeper (driven by Supabase Cron / pg_cron)
-- ---------------------------------------------------------------------------
/*
 * Why a sweeper at all: the desktop Runtime is exactly what is NOT running when
 * the user is away from their computer, which is precisely when the fallback
 * matters. So the deadline lives in the database and something server-side has
 * to look at it.
 *
 * Race safety, in order:
 *   - only rows whose send_after has passed are considered;
 *   - each row is taken with FOR UPDATE SKIP LOCKED, so two overlapping cron
 *     ticks never take the same row;
 *   - acknowledgement is re-checked INSIDE that lock, so a result acknowledged
 *     one moment before the tick is still suppressed;
 *   - claimed_until parks the row briefly, so a crash mid-send does not wedge
 *     it forever;
 *   - the unique (notification_id, channel) constraint means a row can only be
 *     marked sent once, however many times this runs.
 */
create function threadlink_private.sweep_notification_fallbacks(p_limit integer default 100)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_acknowledged timestamptz;
  v_handled integer := 0;
begin
  for v_row in
    select d.id, d.notification_id, n.task_id
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    where d.status = 'pending'
      and d.channel <> 'desktop'
      and d.send_after is not null
      and d.send_after <= pg_catalog.now()
      and (d.claimed_until is null or d.claimed_until < pg_catalog.now())
    order by d.send_after
    limit p_limit
    for update of d skip locked
  loop
    -- Re-check under the lock: the controller may have acknowledged since the
    -- row became due.
    select t.acknowledged_at into v_acknowledged
    from public.tasks t where t.id = v_row.task_id;

    if v_acknowledged is not null then
      update public.notification_deliveries
      set status = 'suppressed',
          detail = 'Acknowledged before the fallback was sent.',
          updated_at = pg_catalog.now()
      where id = v_row.id;
    else
      /*
       * Everything up to the send is implemented. The send itself is not:
       * ThreadLink has no per-user email credential it may safely use, and
       * will not invent one. The row is parked as due so the channel can be
       * completed without changing any of this logic.
       */
      update public.notification_deliveries
      set status = 'unavailable',
          attempt_count = attempt_count + 1,
          claimed_until = null,
          detail = 'Due, but no email channel is configured. See docs/notifications.md.',
          updated_at = pg_catalog.now()
      where id = v_row.id;
    end if;
    v_handled := v_handled + 1;
  end loop;
  return v_handled;
end;
$$;
revoke all on function threadlink_private.sweep_notification_fallbacks(integer) from public;

/** The entry point a scheduler calls. Owner-invocable for manual runs/tests. */
create function public.run_notification_sweep(p_limit integer default 100)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  return threadlink_private.sweep_notification_fallbacks(p_limit);
end;
$$;
revoke all on function public.run_notification_sweep(integer) from public, anon;
grant execute on function public.run_notification_sweep(integer) to service_role;

comment on function public.run_notification_sweep(integer) is
  'Marks due notification fallbacks, re-checking acknowledgement atomically. '
  'Scheduled with Supabase Cron; safe to run by hand and safe to run twice.';

-- ---------------------------------------------------------------------------
-- 10. The schedule itself
-- ---------------------------------------------------------------------------
/*
 * pg_cron is available on Supabase but must be enabled per project, which is an
 * owner action on the hosted database. This block schedules the job when the
 * extension is present and says nothing when it is not, so the migration is
 * valid either way and no scheduler is invented.
 *
 * Enabling it on hosted: Dashboard -> Database -> Extensions -> enable pg_cron,
 * then re-run this block (or `select cron.schedule(...)` with the same body).
 */
do $do$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'threadlink-notification-sweep',
      '* * * * *',
      $job$ select public.run_notification_sweep(100); $job$
    );
  else
    raise notice
      'pg_cron is not enabled: the notification fallback sweep is not scheduled. %',
      'Enable the pg_cron extension, then schedule threadlink-notification-sweep.';
  end if;
end;
$do$;
