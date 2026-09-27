-- ===========================================================================
-- ThreadLink 0.10: the credential-authenticated chat API.
--
-- Contract: docs/design/threadlink-0.10.md section 9 ("Runtime-credential chat
-- API", "MCP chat-first tools"). Sorts after 20260927000200_threadlink_0_10.sql.
--
--   * Runtime (agent credential) functions for the desktop app and terminal:
--     list / read / create chats, the chat timeline with a PER-CHAT cursor,
--     post as the owner (client desktop|terminal recorded), mark read.
--   * Controller (MCP) functions: the chats reachable through the calling
--     session's own active links, read them, create one, post a request
--     (authored as the controller, routed like the owner composer), the chat's
--     status and a job's result.
--
-- Every function resolves the owner from the credential (never from an
-- argument) and applies the SAME rules as the owner functions: ownership
-- (another account's chat is exactly "not found"), rate limits, the health
-- gate, idempotency and needs_project. The owner post path itself
-- (threadlink_private.chat_post) is reused, not copied.
--
-- The global chat_events.seq is never returned. Clients page with the
-- per-chat cursor chat_events.chat_seq and read state last_read_chat_seq
-- (both from migration 0200), with 0200's unread rules.
--
-- Additive: one new nullable column (chat_events.client), one trigger, new
-- functions. Nothing existing is replaced.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Which client wrote an owner post (web posts leave it null)
-- ---------------------------------------------------------------------------
alter table public.chat_events
  add column client text
    constraint chat_events_client_check check (client in ('web', 'desktop', 'terminal')),
  add constraint chat_events_client_owner check (client is null or author_kind = 'owner');

-- Set only from the transaction-local setting the credential post path writes
-- (never from a client-supplied column: there is no client INSERT path).
create function threadlink_private.chat_events_record_client()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v text := nullif(pg_catalog.current_setting('threadlink.post_client', true), '');
begin
  if new.author_kind = 'owner' and v in ('desktop', 'terminal') then
    new.client := v;
  else
    new.client := null;
  end if;
  return new;
end;
$$;
create trigger chat_events_record_client before insert on public.chat_events
  for each row execute function threadlink_private.chat_events_record_client();

-- ---------------------------------------------------------------------------
-- 2. Bounds
-- ---------------------------------------------------------------------------
-- Reads (list, one chat, timeline) per owner per minute through a credential.
create function threadlink_private.chat_api_reads_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 300 $$;
create function threadlink_private.chat_api_page_default() returns integer
language sql immutable set search_path = '' as $$ select 100 $$;
create function threadlink_private.chat_api_page_max() returns integer
language sql immutable set search_path = '' as $$ select 200 $$;

-- ---------------------------------------------------------------------------
-- 3. The per-chat timeline (chat_events.chat_seq, from migration 0200)
-- ---------------------------------------------------------------------------

-- Delivery of an owner note (section 5), from trusted columns only:
-- seen (a run consumed it, or the Runtime picked it up), not_delivered (its
-- job ended first), queued (for these participants), or sent.
create function threadlink_private.chat_api_delivery(p public.chat_events)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.author_kind <> 'owner' or p.event_type <> 'message' or p.job_id is null then null
    when p.consumed_by_run_id is not null then jsonb_build_object('state', 'seen', 'by',
      coalesce((select jsonb_agg(r.provider) from public.agent_runs r where r.id = p.consumed_by_run_id),
               '[]'::jsonb))
    when p.delivered_at is not null then jsonb_build_object('state', 'seen', 'by', '[]'::jsonb)
    when exists (select 1 from public.team_jobs j where j.id = p.job_id and j.finished_at is not null)
      then jsonb_build_object('state', 'not_delivered')
    when p.queued_for is not null then jsonb_build_object('state', 'queued', 'for', to_jsonb(p.queued_for))
    else jsonb_build_object('state', 'sent') end
$$;

-- One chat row, as a client may see it. No global seq, no session, task or
-- node ids, no idempotency key. The provider appears on agent rows only.
create function threadlink_private.chat_api_event_json(p public.chat_events)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'cursor', p.chat_seq,
    'created_at', p.created_at,
    'author_kind', p.author_kind,
    'author_label', p.author_label,
    'author_provider', case when p.author_kind = 'agent' then p.author_provider end,
    'author_role', p.author_role,
    'audience', p.audience,
    'event_type', p.event_type,
    'message_type', p.message_type,
    'round', p.round,
    'model_requested', p.model_requested,
    'model_observed', p.model_observed,
    'body', p.body,
    'visibility', p.visibility,
    'job_id', p.job_id,
    'run_id', p.run_id,
    'reply_to_event_id', p.reply_to_event_id,
    'ref_kind', p.ref_kind,
    'ref_id', p.ref_id,
    'payload', p.payload,
    'delivery', threadlink_private.chat_api_delivery(p),
    'client', p.client)
$$;

/*
 * One page of a chat's timeline, oldest first.
 *   neither after nor before: the latest page;
 *   after:  rows after that cursor, oldest first (poll with the returned cursor);
 *   before: the page just before that cursor (scroll back with oldest_cursor).
 * Returns {events, cursor, oldest_cursor, has_more}. `cursor` is where the
 * next poll starts: the last row returned when more rows follow, otherwise
 * the chat's newest cursor. `has_more` is in the direction of travel (older
 * rows for the latest page / before, newer rows for after). The chat is NOT
 * checked here: callers do.
 */
create function threadlink_private.chat_api_page(
  p_chat_id text, p_after bigint, p_before bigint, p_limit integer, p_technical boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_limit, threadlink_private.chat_api_page_default());
  v_technical boolean := coalesce(p_technical, false);
  v_rows jsonb;
  v_count integer;
  v_newest bigint;
  v_more boolean;
begin
  if p_after is not null and p_before is not null then
    raise exception 'after or before, not both' using errcode = '22023', hint = 'invalid';
  end if;
  if v_limit < 1 or v_limit > threadlink_private.chat_api_page_max()
     or (p_after is not null and p_after < 0) or (p_before is not null and p_before < 0) then
    raise exception 'invalid page' using errcode = '22023', hint = 'invalid';
  end if;
  select coalesce(c.last_event_seq, 0) into v_newest from public.chats c where c.id = p_chat_id;
  -- limit + 1 rows, to know whether there is more in the direction of travel.
  with picked as (
    select e from public.chat_events e
    where e.chat_id = p_chat_id and e.chat_seq is not null
      and (v_technical or e.visibility = 'visible')
      and (p_after is null or e.chat_seq > p_after)
      and (p_before is null or e.chat_seq < p_before)
    order by case when p_after is null then -e.chat_seq else e.chat_seq end
    limit v_limit + 1
  )
  select (select coalesce(jsonb_agg(threadlink_private.chat_api_event_json(p.e) order by (p.e).chat_seq),
                          '[]'::jsonb)
          from (select * from picked
                order by case when p_after is null then -(picked.e).chat_seq else (picked.e).chat_seq end
                limit v_limit) p),
         (select count(*)::integer from picked)
    into v_rows, v_count;
  v_more := v_count > v_limit;
  return jsonb_build_object(
    'events', v_rows,
    'cursor', case when p_after is not null and v_more
                   then (v_rows -> (jsonb_array_length(v_rows) - 1) ->> 'cursor')::bigint
                   else coalesce(v_newest, 0) end,
    'oldest_cursor', case when jsonb_array_length(v_rows) > 0 then (v_rows -> 0 ->> 'cursor')::bigint end,
    'has_more', v_more);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A chat as a client sees it (friendly fields; ids only as handles)
-- ---------------------------------------------------------------------------
create function threadlink_private.chat_api_summary(p_chat_id text, p_runtime_id text)
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
  active as (select * from jobs where finished_at is null order by created_at desc limit 1),
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
                  -- The same 2-minute presence rule as chat_host_status.
                  'runtime_online', coalesce((select rt.status = 'active'
                                                     and rt.last_seen_at >= pg_catalog.now() - interval '2 minutes'
                                              from rt), false),
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
    'active_job', (select jsonb_build_object('job_id', a.id, 'mode', a.mode, 'status', a.status) from active a),
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
create function threadlink_private.chat_api_projects(p_owner text, p_runtime_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'project_id', r.id,
           'name', r.name,
           'runs_on', rt.label,
           'this_computer', coalesce(rt.id = p_runtime_id, false))
           order by lower(r.name), r.id), '[]'::jsonb)
  from public.rooms r
  left join public.runtimes rt on rt.id = threadlink_private.room_runtime(r.id)
  where r.owner_user_id = p_owner and r.status = 'active'
$$;

-- Live activity (section 3): the chat's runs that are working but have not
-- produced their message yet. Provider display metadata from the registry.
create function threadlink_private.chat_api_live(p_chat_id text)
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
           'last_activity_at', ar.last_activity_at)
           order by ar.started_at nulls last, ar.id), '[]'::jsonb)
  from public.agent_runs ar
  join public.team_jobs j on j.id = ar.job_id and j.owner_user_id = ar.owner_user_id
  left join public.agent_providers pr on pr.id = ar.provider
  where j.chat_id = p_chat_id and j.finished_at is null and ar.status in ('queued', 'running')
$$;

-- The delivery state of the chat's newest owner notes (at most 50), so a
-- poller that only fetches new rows still sees queued -> seen changes.
create function threadlink_private.chat_api_deliveries(p_chat_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('cursor', n.chat_seq, 'delivery',
                                               threadlink_private.chat_api_delivery(n))
                            order by n.chat_seq), '[]'::jsonb)
  from (select e.* from public.chat_events e
        where e.chat_id = p_chat_id and e.chat_seq is not null and e.author_kind = 'owner'
          and e.event_type = 'message' and e.job_id is not null
        order by e.chat_seq desc
        limit 50) n
$$;

-- The calling Runtime as the desktop app / terminal shows it: presence (the
-- same 2-minute rule as chat_host_status), version and whether it must update
-- for the 0.10 features (min_protocol_for('runs')).
create function threadlink_private.chat_api_runtime_json(p public.runtimes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'label', p.label,
    'online', p.status = 'active' and p.last_seen_at is not null
              and p.last_seen_at >= pg_catalog.now() - interval '2 minutes',
    'version', p.version,
    'protocol', threadlink_private.runtime_protocol_of(p.version, p.protocol),
    'min_protocol', threadlink_private.min_protocol_for('runs'),
    'current_protocol', threadlink_private.runtime_protocol_current(),
    'update_required', threadlink_private.runtime_protocol_of(p.version, p.protocol)
                       < threadlink_private.min_protocol_for('runs'))
$$;

-- ---------------------------------------------------------------------------
-- 5. Shared owner-side operations, with the owner as an argument. The owner
--    RPCs derive it from the JWT; these from a verified credential.
-- ---------------------------------------------------------------------------

-- A live chat of p_owner, locked. Anything else is "not found".
create function threadlink_private.chat_api_owned_chat(p_owner text, p_chat_id text)
returns public.chats
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.chats;
begin
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into v from public.chats
  where id = p_chat_id and owner_user_id = p_owner and deleted_at is null
  for update;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  return v;
end;
$$;

-- create_chat's rules, verbatim, for a verified owner.
create function threadlink_private.chat_api_create_chat(
  p_owner text, p_actor_connection_id text, p_name text, p_room_id text, p_mode text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := threadlink_private.chat_valid_name(p_name, 100);
  v_room public.rooms;
  v_id text;
begin
  if p_mode is not null and not (p_mode = any (array['solo', 'pair', 'team'])) then
    raise exception 'invalid mode' using errcode = '22023', hint = 'invalid_mode';
  end if;
  if p_room_id is not null then
    v_room := threadlink_private.require_chat_project(p_owner, p_room_id);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('threadlink:chats:' || p_owner, 0));
  if (select count(*) from public.chats
      where owner_user_id = p_owner and created_at > pg_catalog.now() - interval '1 minute')
     >= threadlink_private.chat_creates_per_minute() then
    raise exception 'too many new chats' using errcode = '54000', hint = 'rate_limited';
  end if;
  if (select count(*) from public.chats where owner_user_id = p_owner and deleted_at is null)
     >= threadlink_private.chat_max_per_owner() then
    raise exception 'chat limit reached' using errcode = '54000', hint = 'limit_reached';
  end if;
  insert into public.chats (owner_user_id, name, room_id, mode)
  values (p_owner, v_name, v_room.id, coalesce(p_mode, 'team'))
  returning id into v_id;
  perform threadlink_private.record_event(p_owner, p_actor_connection_id, 'chat.created', 'chat', v_id,
    jsonb_build_object('room_id', v_room.id, 'mode', coalesce(p_mode, 'team')));
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Runtime (agent credential) chat API
-- ---------------------------------------------------------------------------

-- The calling Runtime: an agent credential of a registered, active, unpaused
-- Runtime. Controllers and anything else are refused.
create function threadlink_private.chat_api_runtime(p_token_hash text)
returns public.runtimes
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v public.runtimes;
begin
  if v_connection.role <> 'agent' then
    raise exception 'runtime credential required' using errcode = '42501', hint = 'forbidden';
  end if;
  select * into v from public.runtimes
  where connection_id = v_connection.id and owner_user_id = v_connection.owner_user_id and status = 'active';
  if not found then
    raise exception 'runtime not registered' using errcode = '42501', hint = 'runtime_required';
  end if;
  if v.paused then
    raise exception 'runtime is paused' using errcode = '42501', hint = 'runtime_paused';
  end if;
  return v;
end;
$$;

/*
 * Work in a project runs on the computer that owns its agent session. A
 * Runtime may read every chat of its owner, but it may only post into (or
 * create a chat in) a project that runs on ITSELF; anything else is refused
 * with hint other_computer and the other computer's label as DETAIL. A chat
 * with no project runs nowhere and is allowed.
 */
create function threadlink_private.chat_api_require_this_computer(p_rt public.runtimes, p_room_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_runtime text;
  v_label text;
begin
  if p_room_id is null then
    return;
  end if;
  v_runtime := threadlink_private.room_runtime(p_room_id);
  -- No runtime: a deleted / detached project; the post path refuses it itself.
  if v_runtime is not null and v_runtime <> p_rt.id then
    select pg_catalog.left(pg_catalog.regexp_replace(r.label, '[[:cntrl:]]', '', 'g'), 100) into v_label
    from public.runtimes r where r.id = v_runtime and r.owner_user_id = p_rt.owner_user_id;
    raise exception 'this chat runs on another computer' using errcode = '42501', hint = 'other_computer',
      detail = coalesce(v_label, '');
  end if;
end;
$$;
revoke all on function threadlink_private.chat_api_require_this_computer(public.runtimes, text)
  from public, anon, authenticated, service_role;

create function public.runtime_list_chats(
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
    'runtime', threadlink_private.chat_api_runtime_json(v_rt));
end;
$$;

create function public.runtime_get_chat(p_token_hash text, p_chat_id text)
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
    || jsonb_build_object('activity', threadlink_private.chat_api_live(v.id));
end;
$$;

create function public.runtime_chat_events(
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
         'active_job', (select jsonb_build_object('job_id', j.id, 'mode', j.mode, 'status', j.status)
                        from public.team_jobs j
                        where j.chat_id = v.id and j.finished_at is null
                        order by j.created_at desc limit 1),
         'activity', threadlink_private.chat_api_live(v.id),
         'deliveries', threadlink_private.chat_api_deliveries(v.id));
end;
$$;

create function public.runtime_create_chat(p_token_hash text, p_name text, p_room_id text, p_mode text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v_id text;
begin
  if p_room_id is not null and p_room_id !~ '^tlrom_[0-9a-f]{32}$' then
    raise exception 'project not found' using errcode = 'P0002', hint = 'project_not_found';
  end if;
  if p_room_id is not null then
    -- The project must be the caller's (else "not found") and run on this computer.
    perform threadlink_private.require_chat_project(v_rt.owner_user_id, p_room_id);
    perform threadlink_private.chat_api_require_this_computer(v_rt, p_room_id);
  end if;
  v_id := threadlink_private.chat_api_create_chat(v_rt.owner_user_id, v_rt.connection_id, p_name, p_room_id, p_mode);
  return threadlink_private.chat_api_summary(v_id, v_rt.id);
end;
$$;

/*
 * The owner's composer, from the desktop app or the terminal. Exactly the
 * owner post path (chat_post: routing, @mentions, stop, rate limits, health
 * gate, idempotency, needs_project); the row records which client sent it.
 */
create function public.runtime_post_chat_message(
  p_token_hash text, p_chat_id text, p_body text, p_idempotency_key text, p_client text
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
  -- Posting may start or steer work: only from the computer the chat's project runs on.
  perform threadlink_private.chat_api_require_this_computer(v_rt,
    (select c.room_id from public.chats c
     where c.id = p_chat_id and c.owner_user_id = v_rt.owner_user_id and c.deleted_at is null));
  perform pg_catalog.set_config('threadlink.post_client', p_client, true);
  v_result := threadlink_private.chat_post(v_rt.owner_user_id, p_chat_id, p_body, null, null,
                                           p_idempotency_key, false);
  perform pg_catalog.set_config('threadlink.post_client', '', true);
  return v_result - 'mode' - 'builder' - 'reviewer';
end;
$$;

-- Read up to a per-chat cursor (never past the newest row, never backwards).
create function public.runtime_mark_chat_read(p_token_hash text, p_chat_id text, p_cursor bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rt public.runtimes := threadlink_private.chat_api_runtime(p_token_hash);
  v public.chats := threadlink_private.chat_api_owned_chat(v_rt.owner_user_id, p_chat_id);
  v_new bigint;
begin
  if p_cursor is null or p_cursor < 0 then
    raise exception 'invalid cursor' using errcode = '22023', hint = 'invalid';
  end if;
  -- mark_chat_read_seq's rule (migration 0200), for a verified owner.
  v_new := least(p_cursor, v.last_event_seq);
  if v_new > v.last_read_chat_seq then
    perform threadlink_private.owner_rate_limit(v.owner_user_id, 'chat_read',
                                                threadlink_private.chat_reads_per_minute());
    update public.chats
    set last_read_chat_seq = v_new,
        last_read_seq = greatest(last_read_seq,
          coalesce((select max(e.seq) from public.chat_events e where e.chat_id = v.id and e.chat_seq <= v_new), 0))
    where id = v.id;
  end if;
  return jsonb_build_object(
    'chat_id', v.id,
    'last_read_cursor', (select last_read_chat_seq from public.chats where id = v.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Controller (MCP) chat API
-- ---------------------------------------------------------------------------

-- The calling controller session's live chat, in an active project whose agent
-- session is the target of one of THIS session's active links. Returns the
-- chat (locked) and fills p_room / p_link. Anything else: "not found".
create function threadlink_private.chat_api_controller_chat(
  p_connection public.connections, p_session public.session_bindings, p_chat_id text,
  out o_chat public.chats, out o_room public.rooms, out o_link public.thread_links
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_chat_id is null or p_chat_id !~ '^tlcht_[0-9a-f]{32}$' then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  -- Lock order as chat_post: the project, then the chat.
  select r.* into o_room from public.rooms r
  join public.chats c on c.room_id = r.id and c.owner_user_id = r.owner_user_id
  where c.id = p_chat_id and c.owner_user_id = p_connection.owner_user_id and c.deleted_at is null
    and r.status = 'active'
  for update of r;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into o_link from public.thread_links
  where controller_session_id = p_session.id and agent_session_id = o_room.agent_session_id
    and owner_user_id = p_connection.owner_user_id and status = 'active'
  order by approved_at desc nulls last, created_at desc
  limit 1
  for share;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
  select * into o_chat from public.chats
  where id = p_chat_id and owner_user_id = p_connection.owner_user_id and deleted_at is null
    and room_id = o_room.id
  for update;
  if not found then
    raise exception 'chat not found' using errcode = 'P0002', hint = 'chat_not_found';
  end if;
end;
$$;

-- The controller session (role controller, own, usable) for a credential.
create function threadlink_private.chat_api_controller(
  p_token_hash text, p_session_id text,
  out o_connection public.connections, out o_session public.session_bindings
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  o_connection := threadlink_private.require_connection(p_token_hash);
  o_session := threadlink_private.require_role_session(o_connection, p_session_id, 'controller');
  perform threadlink_private.owner_rate_limit(o_connection.owner_user_id, 'chat_api_read',
                                              threadlink_private.chat_api_reads_per_minute());
end;
$$;

create function public.controller_list_chats(p_token_hash text, p_session_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
begin
  return jsonb_build_object('chats', coalesce((
    select jsonb_agg(jsonb_build_object(
             'chat_id', c.id,
             'name', c.name,
             'mode', c.mode,
             'project_name', r.name,
             'is_room_default', c.is_room_default,
             'last_activity_at', c.last_activity_at,
             'active_job', (select jsonb_build_object('job_id', j.id, 'mode', j.mode, 'status', j.status)
                            from public.team_jobs j
                            where j.chat_id = c.id and j.finished_at is null
                            order by j.created_at desc limit 1))
             order by c.pinned_at desc nulls last, c.last_activity_at desc, c.id)
    from (select c0.* from public.chats c0
          join public.rooms r0 on r0.id = c0.room_id and r0.owner_user_id = c0.owner_user_id
          where c0.owner_user_id = (v.o_connection).owner_user_id and c0.deleted_at is null
            and c0.archived_at is null and r0.status = 'active'
            and exists (select 1 from public.thread_links l
                        where l.controller_session_id = (v.o_session).id and l.agent_session_id = r0.agent_session_id
                          and l.owner_user_id = c0.owner_user_id and l.status = 'active')
          order by c0.pinned_at desc nulls last, c0.last_activity_at desc, c0.id
          limit 100) c
    join public.rooms r on r.id = c.room_id), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', r.id, 'name', r.name) order by lower(r.name), r.id)
      from public.rooms r
      where r.owner_user_id = (v.o_connection).owner_user_id and r.status = 'active'
        and exists (select 1 from public.thread_links l
                    where l.controller_session_id = (v.o_session).id and l.agent_session_id = r.agent_session_id
                      and l.owner_user_id = r.owner_user_id and l.status = 'active')), '[]'::jsonb));
end;
$$;

create function public.controller_get_chat(
  p_token_hash text, p_session_id text, p_chat_id text, p_after bigint, p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
  w record := threadlink_private.chat_api_controller_chat(v.o_connection, v.o_session, p_chat_id);
begin
  return jsonb_build_object(
    'chat', threadlink_private.chat_api_summary((w.o_chat).id, null),
    'messages', threadlink_private.chat_api_page((w.o_chat).id, p_after, null, coalesce(p_limit, 20), false));
end;
$$;

create function public.controller_create_chat(
  p_token_hash text, p_session_id text, p_room_id text, p_name text, p_mode text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
  v_id text;
begin
  -- Only a project this session reaches through one of its own active links.
  if p_room_id is null or p_room_id !~ '^tlrom_[0-9a-f]{32}$' or not exists (
       select 1 from public.rooms r
       join public.thread_links l on l.agent_session_id = r.agent_session_id and l.owner_user_id = r.owner_user_id
       where r.id = p_room_id and r.owner_user_id = (v.o_connection).owner_user_id and r.status <> 'deleted'
         and l.controller_session_id = (v.o_session).id and l.status = 'active') then
    raise exception 'project not found' using errcode = 'P0002', hint = 'project_not_found';
  end if;
  v_id := threadlink_private.chat_api_create_chat((v.o_connection).owner_user_id, (v.o_connection).id,
                                                  p_name, p_room_id, p_mode);
  perform threadlink_private.touch_session((v.o_session).id);
  return threadlink_private.chat_api_summary(v_id, null);
end;
$$;

/*
 * A controller's message in a chat: routed like the owner composer (the chat's
 * mode, a leading @mention), but it is the CONTROLLER's request - the job is
 * started over the caller's own link, and its request row is authored by the
 * controller with the controller's label (chat_on_job_insert). Differences
 * from the owner, all fail-closed:
 *   - a controller cannot add notes to, or stop, running work (job_active);
 *   - the health gate refuses with provider_unhealthy and stores nothing;
 *   - solo work in a project that requires review is refused (review_required).
 * Idempotent per controller session: the same key returns the same job.
 */
create function public.controller_post_chat_message(
  p_token_hash text, p_session_id text, p_chat_id text, p_body text, p_idempotency_key text
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
begin
  if p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023', hint = 'invalid';
  end if;
  w := threadlink_private.chat_api_controller_chat(v.o_connection, v.o_session, p_chat_id);

  -- Replay first: the same key returns the job it made, and changes nothing.
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
  if exists (select 1 from public.team_jobs where chat_id = (w.o_chat).id and finished_at is null) then
    raise exception 'work is still running in this chat' using errcode = '55000', hint = 'job_active';
  end if;
  if v_body ~* threadlink_private.chat_stop_pattern() then
    raise exception 'nothing to stop' using errcode = '55000', hint = 'nothing_to_stop';
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

  v_result := threadlink_private.team_start_job_v2(
    v_owner, (v.o_connection).id, 'controller', w.o_room, w.o_link, v_goal, null, null, null, null,
    v_mode, v_builder, v_reviewer, p_idempotency_key, (w.o_chat).id, null, null);
  perform threadlink_private.touch_session((v.o_session).id);
  return v_result;
end;
$$;

-- The chat's work now: the running job, else the latest one (or none).
create function public.controller_chat_status(p_token_hash text, p_session_id text, p_chat_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
  w record := threadlink_private.chat_api_controller_chat(v.o_connection, v.o_session, p_chat_id);
  v_job text;
begin
  select id into v_job from public.team_jobs
  where chat_id = (w.o_chat).id
  order by (finished_at is null) desc, created_at desc
  limit 1;
  return jsonb_build_object(
    'chat', threadlink_private.chat_api_summary((w.o_chat).id, null),
    'job', case when v_job is not null then threadlink_private.team_status_json(v_job) end);
end;
$$;

-- A job's result: one this session started, or one in a chat it reaches.
create function public.controller_job_result(p_token_hash text, p_session_id text, p_job_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record := threadlink_private.chat_api_controller(p_token_hash, p_session_id);
  v_job public.team_jobs;
begin
  if p_job_id is null or p_job_id !~ '^tljob_[0-9a-f]{32}$' then
    raise exception 'job not found' using errcode = 'P0002', hint = 'job_not_found';
  end if;
  select j.* into v_job
  from public.team_jobs j
  join public.tasks t on t.id = j.task_id and t.owner_user_id = j.owner_user_id
  join public.rooms r on r.id = j.room_id and r.owner_user_id = j.owner_user_id
  left join public.chats c on c.id = j.chat_id and c.owner_user_id = j.owner_user_id
  where j.id = p_job_id and j.owner_user_id = (v.o_connection).owner_user_id and r.status <> 'deleted'
    and (t.origin_session_id = (v.o_session).id
         or (c.deleted_at is null and exists (
               select 1 from public.thread_links l
               where l.controller_session_id = (v.o_session).id and l.agent_session_id = r.agent_session_id
                 and l.owner_user_id = j.owner_user_id and l.status = 'active')));
  if not found then
    raise exception 'job not found' using errcode = 'P0002', hint = 'job_not_found';
  end if;
  return threadlink_private.team_status_json(v_job.id)
    || jsonb_build_object('chat_name', (select c.name from public.chats c
                                        where c.id = v_job.chat_id and c.deleted_at is null));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Privileges: private helpers for nobody; credential RPCs for anon only.
-- ---------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'threadlink_private.chat_events_record_client()',
    'threadlink_private.chat_api_reads_per_minute()', 'threadlink_private.chat_api_page_default()',
    'threadlink_private.chat_api_page_max()', 'threadlink_private.chat_api_delivery(public.chat_events)',
    'threadlink_private.chat_api_event_json(public.chat_events)',
    'threadlink_private.chat_api_page(text, bigint, bigint, integer, boolean)',
    'threadlink_private.chat_api_summary(text, text)', 'threadlink_private.chat_api_projects(text, text)',
    'threadlink_private.chat_api_live(text)', 'threadlink_private.chat_api_deliveries(text)',
    'threadlink_private.chat_api_runtime_json(public.runtimes)',
    'threadlink_private.chat_api_owned_chat(text, text)',
    'threadlink_private.chat_api_create_chat(text, text, text, text, text)',
    'threadlink_private.chat_api_runtime(text)',
    'threadlink_private.chat_api_controller_chat(public.connections, public.session_bindings, text)',
    'threadlink_private.chat_api_controller(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;

  foreach f in array array[
    'public.runtime_list_chats(text, boolean, text)',
    'public.runtime_get_chat(text, text)',
    'public.runtime_chat_events(text, text, bigint, bigint, integer, boolean)',
    'public.runtime_create_chat(text, text, text, text)',
    'public.runtime_post_chat_message(text, text, text, text, text)',
    'public.runtime_mark_chat_read(text, text, bigint)',
    'public.controller_list_chats(text, text)',
    'public.controller_get_chat(text, text, text, bigint, integer)',
    'public.controller_create_chat(text, text, text, text, text)',
    'public.controller_post_chat_message(text, text, text, text, text)',
    'public.controller_chat_status(text, text, text)',
    'public.controller_job_result(text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;
end;
$grants$;
