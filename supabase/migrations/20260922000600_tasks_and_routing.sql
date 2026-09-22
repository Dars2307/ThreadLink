-- ThreadLink Phase 5: tasks, messages, artifacts and point-to-point routing.
--
-- Every route resolves: origin tlses_ -> active tllnk_ -> target tlses_ -> target connection.
-- The caller supplies only its own session and the link; target, owner and
-- connection are derived here and re-validated at send AND delivery time.

-- ===========================================================================
-- 0. ID prefixes may be 3 or 4 letters (tltask_)
-- ===========================================================================
create or replace function threadlink_private.generate_id(prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
begin
  if prefix is null or prefix !~ '^tl[a-z]{3,4}$' then
    raise exception 'invalid ThreadLink id prefix' using errcode = '22023';
  end if;
  return prefix || '_' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
end;
$$;

-- Composite-FK target so tasks can bind (link, owner).
alter table public.thread_links add constraint thread_links_id_owner_key unique (id, owner_user_id);

-- ===========================================================================
-- 1. Limits (Alpha; documented in docs/routing.md)
-- ===========================================================================
create function threadlink_private.max_open_tasks_per_link()
returns integer language sql immutable set search_path = '' as $$ select 100 $$;
create function threadlink_private.default_task_ttl()
returns interval language sql immutable set search_path = '' as $$ select interval '24 hours' $$;
revoke all on function threadlink_private.max_open_tasks_per_link() from public;

-- A1 (the frog) > A2 > A3 > A > B > C > D > E. Ordering only; never authorization.
create function threadlink_private.priority_rank(p_priority text)
returns integer language sql immutable set search_path = '' as $$
  select case p_priority
    when 'A1' then 1 when 'A2' then 2 when 'A3' then 3 when 'A' then 4
    when 'B' then 5 when 'C' then 6 when 'D' then 7 when 'E' then 8 else 9 end
$$;
revoke all on function threadlink_private.priority_rank(text) from public;
revoke all on function threadlink_private.default_task_ttl() from public;

-- ===========================================================================
-- 2. tasks
-- ===========================================================================
create table public.tasks (
  id text primary key
    default threadlink_private.generate_id('tltask')
    constraint tasks_id_format check (id ~ '^tltask_[0-9a-f]{32}$'),
  owner_user_id text not null,
  thread_link_id text not null,
  origin_session_id text not null,
  target_session_id text not null,
  status text not null default 'queued'
    constraint tasks_status_check check (status in
      ('queued', 'claimed', 'working', 'completed', 'failed', 'cancelled', 'expired')),
  priority text not null default 'C'
    constraint tasks_priority_check check (priority ~ '^(A[1-3]?|[B-E])$'),
  task_type text not null default 'general'
    constraint tasks_task_type_format check (task_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  title text not null
    constraint tasks_title_length check (char_length(title) between 1 and 255),
  content text not null
    constraint tasks_content_size check (octet_length(content) between 1 and 65536),
  idempotency_key text
    constraint tasks_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  claim_ref text
    constraint tasks_claim_ref_format check (claim_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  cancel_reason text
    constraint tasks_cancel_reason_check check (cancel_reason in ('link_revoked', 'route_invalid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint tasks_link_owner_fkey
    foreign key (thread_link_id, owner_user_id) references public.thread_links (id, owner_user_id) on delete cascade,
  constraint tasks_origin_owner_fkey
    foreign key (origin_session_id, owner_user_id) references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint tasks_target_owner_fkey
    foreign key (target_session_id, owner_user_id) references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint tasks_id_owner_key unique (id, owner_user_id),
  constraint tasks_idempotency_key_scope unique (owner_user_id, origin_session_id, idempotency_key),
  constraint tasks_claim_consistency check ((status = 'queued') = (claim_ref is null) or status in ('cancelled', 'expired')),
  constraint tasks_cancel_consistency check ((status = 'cancelled') = (cancel_reason is not null))
);

comment on table public.tasks is
  'Work routed over one active thread link from its controller session to its agent session.';

create index tasks_target_inbox_idx on public.tasks (target_session_id, status, created_at);
create index tasks_origin_idx on public.tasks (origin_session_id, created_at desc);
create index tasks_link_idx on public.tasks (thread_link_id, status);
create index tasks_owner_created_idx on public.tasks (owner_user_id, created_at desc);

-- Integrity even for privileged writers: origin/target must be the link's exact sides.
create function threadlink_private.tasks_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.thread_links l
    where l.id = new.thread_link_id
      and l.owner_user_id = new.owner_user_id
      and l.controller_session_id = new.origin_session_id
      and l.agent_session_id = new.target_session_id
  ) then
    raise exception 'task route must match its thread link exactly' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.tasks_guard_insert() from public;

create trigger tasks_guard_insert
  before insert on public.tasks
  for each row execute function threadlink_private.tasks_guard_insert();

-- State machine; terminal states never change; timestamps set here.
create function threadlink_private.tasks_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.thread_link_id is distinct from old.thread_link_id
     or new.origin_session_id is distinct from old.origin_session_id
     or new.target_session_id is distinct from old.target_session_id
     or new.priority is distinct from old.priority
     or new.task_type is distinct from old.task_type
     or new.title is distinct from old.title
     or new.content is distinct from old.content
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'task identity and payload are immutable' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('completed', 'failed', 'cancelled', 'expired') then
      raise exception 'task status % is terminal', old.status using errcode = '42501';
    end if;
    if not (
         (old.status = 'queued'  and new.status in ('claimed', 'cancelled', 'expired'))
      or (old.status = 'claimed' and new.status in ('working', 'completed', 'failed', 'cancelled'))
      or (old.status = 'working' and new.status in ('completed', 'failed', 'cancelled'))
    ) then
      raise exception 'invalid task transition % -> %', old.status, new.status using errcode = '42501';
    end if;
    case new.status
      when 'claimed' then new.claimed_at := pg_catalog.now();
      when 'working' then new.started_at := pg_catalog.now();
      when 'completed' then new.completed_at := pg_catalog.now();
      when 'failed' then new.failed_at := pg_catalog.now();
      when 'cancelled' then new.cancelled_at := pg_catalog.now();
      when 'expired' then new.expired_at := pg_catalog.now();
      else null;
    end case;
  elsif new.claim_ref is distinct from old.claim_ref then
    raise exception 'task claim cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.tasks_guard_update() from public;

create trigger tasks_guard_update
  before update on public.tasks
  for each row execute function threadlink_private.tasks_guard_update();

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function threadlink_private.touch_updated_at();

alter table public.tasks enable row level security;
revoke all on table public.tasks from public, anon, authenticated;
grant select on table public.tasks to authenticated;
create policy tasks_select_own on public.tasks
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ===========================================================================
-- 3. messages (routing messages only; no transcript mirroring)
-- ===========================================================================
create table public.messages (
  id text primary key
    default threadlink_private.generate_id('tlmsg')
    constraint messages_id_format check (id ~ '^tlmsg_[0-9a-f]{32}$'),
  owner_user_id text not null,
  task_id text not null,
  thread_link_id text not null,
  sender_session_id text not null,
  recipient_session_id text not null,
  message_type text not null
    constraint messages_type_check check (message_type in ('task', 'progress', 'result', 'error', 'note')),
  -- 'task' messages carry no copy: the payload lives on the task.
  content text,
  in_reply_to text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  constraint messages_task_owner_fkey
    foreign key (task_id, owner_user_id) references public.tasks (id, owner_user_id) on delete cascade,
  constraint messages_sender_owner_fkey
    foreign key (sender_session_id, owner_user_id) references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint messages_recipient_owner_fkey
    foreign key (recipient_session_id, owner_user_id) references public.session_bindings (id, owner_user_id) on delete cascade,
  constraint messages_in_reply_to_fkey foreign key (in_reply_to) references public.messages (id) on delete set null,
  constraint messages_content_presence check ((message_type = 'task') = (content is null)),
  constraint messages_content_size check (
    content is null
    or (message_type = 'result' and octet_length(content) between 1 and 262144)
    or (message_type <> 'result' and octet_length(content) between 1 and 65536))
);

comment on table public.messages is 'Routing messages for one task between its origin and target sessions.';

create index messages_task_idx on public.messages (task_id, created_at);
create index messages_owner_idx on public.messages (owner_user_id);

create function threadlink_private.messages_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.tasks t
    where t.id = new.task_id
      and t.owner_user_id = new.owner_user_id
      and t.thread_link_id = new.thread_link_id
      and ((t.origin_session_id = new.sender_session_id and t.target_session_id = new.recipient_session_id)
        or (t.target_session_id = new.sender_session_id and t.origin_session_id = new.recipient_session_id))
  ) then
    raise exception 'message route must match its task exactly' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.messages_guard_insert() from public;

create trigger messages_guard_insert
  before insert on public.messages
  for each row execute function threadlink_private.messages_guard_insert();

-- Only delivery/read timestamps may change, once each.
create function threadlink_private.messages_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'delivered_at' - 'read_at') is distinct from (to_jsonb(old) - 'delivered_at' - 'read_at')
     or (old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at)
     or (old.read_at is not null and new.read_at is distinct from old.read_at) then
    raise exception 'messages are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.messages_guard_update() from public;

create trigger messages_guard_update
  before update on public.messages
  for each row execute function threadlink_private.messages_guard_update();

alter table public.messages enable row level security;
revoke all on table public.messages from public, anon, authenticated;
grant select on table public.messages to authenticated;
create policy messages_select_own on public.messages
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ===========================================================================
-- 4. artifacts (references + bounded metadata only; no blobs)
-- ===========================================================================
create table public.artifacts (
  id text primary key
    default threadlink_private.generate_id('tlart')
    constraint artifacts_id_format check (id ~ '^tlart_[0-9a-f]{32}$'),
  owner_user_id text not null,
  task_id text not null,
  type text not null
    constraint artifacts_type_check check (type in
      ('git_commit', 'pull_request', 'file_path', 'deployment', 'test_report', 'url', 'other')),
  reference text not null
    constraint artifacts_reference_length check (char_length(reference) between 1 and 1024),
  metadata jsonb not null default '{}'::jsonb
    constraint artifacts_metadata_shape check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  created_at timestamptz not null default now(),
  constraint artifacts_task_owner_fkey
    foreign key (task_id, owner_user_id) references public.tasks (id, owner_user_id) on delete cascade
);

create index artifacts_task_idx on public.artifacts (task_id);

create function threadlink_private.artifacts_block_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'artifacts are immutable' using errcode = '42501';
end;
$$;
revoke all on function threadlink_private.artifacts_block_update() from public;
create trigger artifacts_block_update
  before update on public.artifacts
  for each row execute function threadlink_private.artifacts_block_update();

alter table public.artifacts enable row level security;
revoke all on table public.artifacts from public, anon, authenticated;
grant select on table public.artifacts to authenticated;
create policy artifacts_select_own on public.artifacts
  for select to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ===========================================================================
-- 5. Audit actions
-- ===========================================================================
alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events add constraint audit_events_action_check check (action in (
  'connection.created', 'connection.revoked', 'connection.credential_rotated', 'connection.auth_failed',
  'session.registered', 'session.retired', 'session.revoked',
  'link.requested', 'link.approved', 'link.revoked',
  'task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired'
));

-- ===========================================================================
-- 6. Revocation cascade: link revoked -> open tasks cancelled (history kept)
-- ===========================================================================
create function threadlink_private.cascade_link_revoked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'revoked' and old.status <> 'revoked' then
    with cancelled as (
      update public.tasks
      set status = 'cancelled', cancel_reason = 'link_revoked'
      where thread_link_id = new.id and status in ('queued', 'claimed', 'working')
      returning id, owner_user_id
    )
    insert into public.audit_events (owner_user_id, action, resource_type, resource_id, outcome, metadata)
    select owner_user_id, 'task.cancelled', 'task', id, 'success', jsonb_build_object('reason', 'link_revoked')
    from cancelled;
  end if;
  return null;
end;
$$;
revoke all on function threadlink_private.cascade_link_revoked() from public;

create trigger thread_links_cascade_tasks
  after update of status on public.thread_links
  for each row execute function threadlink_private.cascade_link_revoked();

-- ===========================================================================
-- 7. Routing helpers
-- ===========================================================================

-- The full path must be live: active link whose exact sides are the task's
-- sessions, both sessions usable (which includes their connections).
create function threadlink_private.task_route_is_valid(p_task_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks t
    join public.thread_links l
      on l.id = t.thread_link_id and l.owner_user_id = t.owner_user_id
    where t.id = p_task_id
      and l.status = 'active'
      and l.controller_session_id = t.origin_session_id
      and l.agent_session_id = t.target_session_id
      and threadlink_private.session_is_usable(t.origin_session_id)
      and threadlink_private.session_is_usable(t.target_session_id)
  )
$$;
revoke all on function threadlink_private.task_route_is_valid(text) from public;

-- Expires overdue queued tasks and cancels open tasks whose route is no longer
-- valid. Called at every delivery point (defence in depth beyond the cascade).
create function threadlink_private.sweep_task(p_task_id text)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found then
    return null;
  end if;
  if v_task.status = 'queued' and v_task.expires_at <= pg_catalog.now() then
    update public.tasks set status = 'expired' where id = v_task.id returning * into v_task;
    perform threadlink_private.record_event(v_task.owner_user_id, null, 'task.expired', 'task', v_task.id);
  elsif v_task.status in ('queued', 'claimed', 'working')
        and not threadlink_private.task_route_is_valid(v_task.id) then
    update public.tasks set status = 'cancelled', cancel_reason = 'route_invalid'
    where id = v_task.id returning * into v_task;
    perform threadlink_private.record_event(
      v_task.owner_user_id, null, 'task.cancelled', 'task', v_task.id,
      jsonb_build_object('reason', 'route_invalid'));
  end if;
  return v_task;
end;
$$;
revoke all on function threadlink_private.sweep_task(text) from public;

-- Caller's own usable session with the required role, else not-found / forbidden.
create function threadlink_private.require_role_session(
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
  return v_session;
end;
$$;
revoke all on function threadlink_private.require_role_session(public.connections, text, text) from public;

-- Task envelope. Content included only when requested (agent delivery).
create function threadlink_private.task_json(p_task_id text, p_include_content boolean)
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

-- Loads a task for the exact target agent session, sweeping it first.
create function threadlink_private.require_target_task(p_session public.session_bindings, p_task_id text)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
begin
  if not exists (select 1 from public.tasks where id = p_task_id and target_session_id = p_session.id) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_task := threadlink_private.sweep_task(p_task_id);
  return v_task;
end;
$$;
revoke all on function threadlink_private.require_target_task(public.session_bindings, text) from public;

-- Agent-side operations require: own claim, open task, still-valid route.
create function threadlink_private.require_claimed_task(
  p_session public.session_bindings,
  p_task_id text,
  p_claim_ref text,
  p_allowed_statuses text[]
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_task public.tasks := threadlink_private.require_target_task(p_session, p_task_id);
begin
  if v_task.status in ('queued', 'claimed', 'working')
     and (v_task.claim_ref is null or v_task.claim_ref is distinct from p_claim_ref) then
    raise exception 'task is not claimed by this worker' using errcode = '55000';
  end if;
  if not (v_task.status = any (p_allowed_statuses)) then
    raise exception 'task is %', v_task.status using errcode = '55000';
  end if;
  return v_task;
end;
$$;
revoke all on function threadlink_private.require_claimed_task(public.session_bindings, text, text, text[]) from public;

-- ===========================================================================
-- 8. Controller: create a task over an active link
-- ===========================================================================
create function public.create_task(
  p_token_hash text,
  p_origin_session_id text,
  p_thread_link_id text,
  p_title text,
  p_content text,
  p_priority text default 'C',
  p_task_type text default 'general',
  p_idempotency_key text default null,
  p_expires_in_seconds integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_origin public.session_bindings := threadlink_private.require_role_session(v_connection, p_origin_session_id, 'controller');
  v_link public.thread_links;
  v_task_id text;
  v_open integer;
  v_expires_at timestamptz;
begin
  -- Idempotent replay: same (owner, origin session, key) returns the original task.
  if p_idempotency_key is not null then
    select id into v_task_id from public.tasks
    where owner_user_id = v_connection.owner_user_id
      and origin_session_id = v_origin.id
      and idempotency_key = p_idempotency_key;
    if v_task_id is not null then
      return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', false);
    end if;
  end if;

  -- The link must be active and the caller's session must be its controller side.
  select * into v_link from public.thread_links
  where id = p_thread_link_id
    and owner_user_id = v_connection.owner_user_id
    and controller_session_id = v_origin.id
  for share;
  if not found or v_link.status <> 'active'
     or not threadlink_private.session_is_usable(v_link.agent_session_id) then
    raise exception 'thread link not found' using errcode = 'P0002';
  end if;

  if p_expires_in_seconds is not null and (p_expires_in_seconds < 60 or p_expires_in_seconds > 604800) then
    raise exception 'expires_in_seconds must be between 60 and 604800' using errcode = '22023';
  end if;
  v_expires_at := pg_catalog.now()
    + coalesce(pg_catalog.make_interval(secs => p_expires_in_seconds), threadlink_private.default_task_ttl());

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:tasks:' || v_link.id, 0));
  select count(*) into v_open from public.tasks
  where thread_link_id = v_link.id and status in ('queued', 'claimed', 'working');
  if v_open >= threadlink_private.max_open_tasks_per_link() then
    raise exception 'open task limit reached for this link' using errcode = '54000';
  end if;

  insert into public.tasks
    (owner_user_id, thread_link_id, origin_session_id, target_session_id,
     priority, task_type, title, content, idempotency_key, expires_at)
  values
    (v_connection.owner_user_id, v_link.id, v_origin.id, v_link.agent_session_id,
     coalesce(p_priority, 'C'), coalesce(p_task_type, 'general'), p_title, p_content,
     p_idempotency_key, v_expires_at)
  on conflict (owner_user_id, origin_session_id, idempotency_key) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    -- Lost a concurrent race for the same idempotency key.
    select id into v_task_id from public.tasks
    where owner_user_id = v_connection.owner_user_id
      and origin_session_id = v_origin.id
      and idempotency_key = p_idempotency_key;
    return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', false);
  end if;

  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id, message_type)
  values
    (v_connection.owner_user_id, v_task_id, v_link.id, v_origin.id, v_link.agent_session_id, 'task');

  perform threadlink_private.record_event(
    v_connection.owner_user_id, v_connection.id, 'task.created', 'task', v_task_id,
    jsonb_build_object('thread_link_id', v_link.id));
  perform threadlink_private.touch_session(v_origin.id);

  return threadlink_private.task_json(v_task_id, false) || jsonb_build_object('created', true);
end;
$$;

-- ===========================================================================
-- 9. Agent: inbox, claim, start, progress, complete, fail
-- ===========================================================================

-- Deliverable tasks for the exact agent session: queued, plus open tasks it holds.
-- Every candidate is swept (expired / route re-validated) before delivery.
create function public.list_inbox(p_token_hash text, p_session_id text, p_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'agent');
  v_ids text[];
  v_id text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  select coalesce(array_agg(id order by rank, created_at), '{}') into v_ids
  from (
    select id, threadlink_private.priority_rank(priority) as rank, created_at from public.tasks
    where target_session_id = v_session.id and status in ('queued', 'claimed', 'working')
    order by rank, created_at
    limit v_limit
  ) candidates;

  foreach v_id in array v_ids loop
    perform threadlink_private.sweep_task(v_id);
  end loop;

  update public.messages set delivered_at = pg_catalog.now()
  where recipient_session_id = v_session.id and message_type = 'task' and delivered_at is null
    and task_id = any (v_ids)
    and task_id in (select id from public.tasks where status in ('queued', 'claimed', 'working'));

  perform threadlink_private.touch_session(v_session.id);

  return coalesce((
    select jsonb_agg(threadlink_private.task_json(t.id, true) || jsonb_build_object('claim_ref', t.claim_ref)
                     order by threadlink_private.priority_rank(t.priority), t.created_at)
    from public.tasks t
    where t.id = any (v_ids) and t.status in ('queued', 'claimed', 'working')
  ), '[]'::jsonb);
end;
$$;

-- Atomic claim. Row lock serializes concurrent claimers; the first wins.
-- Same claim_ref retries are idempotent; any other worker gets 55000.
create function public.claim_task(p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'agent');
  v_task public.tasks;
begin
  if p_claim_ref is null or p_claim_ref !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid claim_ref' using errcode = '22023';
  end if;
  v_task := threadlink_private.require_target_task(v_session, p_task_id);

  if v_task.status in ('claimed', 'working') and v_task.claim_ref = p_claim_ref then
    return threadlink_private.task_json(v_task.id, true) || jsonb_build_object('claim_ref', v_task.claim_ref);
  end if;
  if v_task.status <> 'queued' then
    raise exception 'task is not claimable' using errcode = '55000';
  end if;

  update public.tasks set status = 'claimed', claim_ref = p_claim_ref where id = v_task.id;
  update public.messages set delivered_at = coalesce(delivered_at, pg_catalog.now()), read_at = pg_catalog.now()
  where task_id = v_task.id and message_type = 'task' and read_at is null;

  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.claimed', 'task', v_task.id);
  return threadlink_private.task_json(v_task.id, true) || jsonb_build_object('claim_ref', p_claim_ref);
end;
$$;

create function public.start_task(p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text)
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
begin
  if v_task.status = 'claimed' then
    update public.tasks set status = 'working' where id = v_task.id;
  end if;
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

create function public.report_progress(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text, p_content text
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
  v_message_id text;
begin
  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
     message_type, content, in_reply_to)
  values
    (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id, v_task.origin_session_id,
     'progress', p_content,
     (select id from public.messages where task_id = v_task.id and message_type = 'task'))
  returning id into v_message_id;
  return jsonb_build_object('message_id', v_message_id, 'task_id', v_task.id, 'status', v_task.status);
end;
$$;

-- Completion preserves the return path: target -> task -> origin controller.
create function public.complete_task(
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

  update public.tasks set status = 'completed' where id = v_task.id;
  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.completed', 'task', v_task.id);
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

create function public.fail_task(
  p_token_hash text, p_session_id text, p_task_id text, p_claim_ref text, p_error text
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
begin
  insert into public.messages
    (owner_user_id, task_id, thread_link_id, sender_session_id, recipient_session_id,
     message_type, content, in_reply_to)
  values
    (v_task.owner_user_id, v_task.id, v_task.thread_link_id, v_task.target_session_id, v_task.origin_session_id,
     'error', p_error,
     (select id from public.messages where task_id = v_task.id and message_type = 'task'));
  update public.tasks set status = 'failed' where id = v_task.id;
  perform threadlink_private.record_event(v_connection.owner_user_id, v_connection.id, 'task.failed', 'task', v_task.id);
  return threadlink_private.task_json(v_task.id, false);
end;
$$;

-- ===========================================================================
-- 10. Reads for participants
-- ===========================================================================

-- Status for either participant. Target sees content only while its route is live.
create function public.get_task(p_token_hash text, p_session_id text, p_task_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_own_session(v_connection, p_session_id);
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and owner_user_id = v_connection.owner_user_id
    and (origin_session_id = v_session.id or target_session_id = v_session.id);
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  if not threadlink_private.session_is_usable(v_session.id) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_task := threadlink_private.sweep_task(v_task.id);
  return threadlink_private.task_json(
    v_task.id,
    v_task.origin_session_id = v_session.id
      or (v_task.status in ('queued', 'claimed', 'working') and threadlink_private.task_route_is_valid(v_task.id))
  );
end;
$$;

-- Result path: ONLY the originating controller session. Readable after
-- completion even if the link was later revoked (history), while the origin
-- session itself is still usable.
create function public.get_task_result(p_token_hash text, p_session_id text, p_task_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_session public.session_bindings := threadlink_private.require_role_session(v_connection, p_session_id, 'controller');
  v_task public.tasks;
begin
  select * into v_task from public.tasks
  where id = p_task_id and owner_user_id = v_connection.owner_user_id and origin_session_id = v_session.id;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_task := threadlink_private.sweep_task(v_task.id);

  update public.messages
  set delivered_at = coalesce(delivered_at, pg_catalog.now()), read_at = coalesce(read_at, pg_catalog.now())
  where task_id = v_task.id and recipient_session_id = v_session.id;

  perform threadlink_private.touch_session(v_session.id);

  return threadlink_private.task_json(v_task.id, true) || jsonb_build_object(
    'result', (select m.content from public.messages m where m.task_id = v_task.id and m.message_type = 'result'),
    'error', (select m.content from public.messages m where m.task_id = v_task.id and m.message_type = 'error'),
    'progress', coalesce((
      select jsonb_agg(jsonb_build_object('message_id', m.id, 'content', m.content, 'created_at', m.created_at)
                       order by m.created_at)
      from public.messages m where m.task_id = v_task.id and m.message_type = 'progress'), '[]'::jsonb),
    'artifacts', coalesce((
      select jsonb_agg(jsonb_build_object('artifact_id', a.id, 'type', a.type, 'reference', a.reference,
                                          'metadata', a.metadata) order by a.created_at)
      from public.artifacts a where a.task_id = v_task.id), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 11. Privileges
-- ===========================================================================
revoke all on function public.create_task(text, text, text, text, text, text, text, text, integer) from public;
revoke all on function public.list_inbox(text, text, integer) from public;
revoke all on function public.claim_task(text, text, text, text) from public;
revoke all on function public.start_task(text, text, text, text) from public;
revoke all on function public.report_progress(text, text, text, text, text) from public;
revoke all on function public.complete_task(text, text, text, text, text, jsonb) from public;
revoke all on function public.fail_task(text, text, text, text, text) from public;
revoke all on function public.get_task(text, text, text) from public;
revoke all on function public.get_task_result(text, text, text) from public;

grant execute on function public.create_task(text, text, text, text, text, text, text, text, integer) to anon, authenticated;
grant execute on function public.list_inbox(text, text, integer) to anon, authenticated;
grant execute on function public.claim_task(text, text, text, text) to anon, authenticated;
grant execute on function public.start_task(text, text, text, text) to anon, authenticated;
grant execute on function public.report_progress(text, text, text, text, text) to anon, authenticated;
grant execute on function public.complete_task(text, text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.fail_task(text, text, text, text, text) to anon, authenticated;
grant execute on function public.get_task(text, text, text) to anon, authenticated;
grant execute on function public.get_task_result(text, text, text) to anon, authenticated;
