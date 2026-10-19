-- Mission Control Phase 1: task_events table.
--
-- One row per lifecycle event emitted by the runtime. The composite FK
-- (task_id, owner_user_id) binds every row to its parent task and enforces
-- that the writer supplied the correct owner: a mismatched owner_user_id
-- fails the FK constraint immediately, never silently routing the event to
-- another user's task.
--
-- Events are append-only and immutable after insert; there is no UPDATE or
-- DELETE policy for `authenticated`. The privileged client used by the API
-- route enforces ownership at the application layer before every insert.

create table public.task_events (
  id text primary key
    default threadlink_private.generate_id('tltev')
    constraint task_events_id_format check (id ~ '^tltev_[0-9a-f]{32}$'),
  task_id text not null,
  owner_user_id text not null,
  created_at timestamptz not null default now(),
  speaker text not null
    constraint task_events_speaker_check
      check (speaker in ('user', 'chatgpt', 'claude_code', 'system')),
  event_type text not null
    constraint task_events_event_type_length
      check (char_length(event_type) between 1 and 80),
  content text
    constraint task_events_content_length
      check (content is null or char_length(content) <= 4096),
  payload jsonb,
  -- Composite FK: the unique constraint tasks_id_owner_key on tasks(id,
  -- owner_user_id) enables this reference. Cascades so that deleting a task
  -- cleans up its events.
  constraint task_events_task_owner_fk
    foreign key (task_id, owner_user_id)
    references public.tasks(id, owner_user_id)
    on delete cascade
);

comment on table public.task_events is
  'Lifecycle events emitted by the runtime as tasks run. Append-only; no rows are mutated after insert.';
comment on column public.task_events.speaker is
  'Who emitted the event: user, chatgpt, claude_code, or system.';
comment on column public.task_events.event_type is
  'Machine-readable event label (e.g. task_started, task_completed, task_failed).';
comment on column public.task_events.content is
  'Optional human-readable description. Never contains raw task results or prompts.';
comment on column public.task_events.payload is
  'Optional structured metadata for the event (outcome, reason, etc.).';

-- Feed queries: all events for a task ordered by time.
create index task_events_task_id_created_at_idx
  on public.task_events (task_id, created_at);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.task_events enable row level security;

-- Remove Supabase's default broad grants before adding back only what is needed.
revoke all on table public.task_events from public, anon, authenticated;
grant select on table public.task_events to authenticated;
-- No INSERT/UPDATE/DELETE for `authenticated`: events are written only by the
-- privileged API route that verifies connection credentials server-side.

create policy task_events_select_own
  on public.task_events
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

-- ---------------------------------------------------------------------------
-- Supabase Realtime
-- ---------------------------------------------------------------------------
-- Enables postgres_changes subscriptions on this table. The RLS policy above
-- filters the stream so each subscriber receives only their own events.
alter publication supabase_realtime add table public.task_events;
