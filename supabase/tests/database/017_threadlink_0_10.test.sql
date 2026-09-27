-- ThreadLink 0.10 (pgTAP): the provider registry, the Runtime protocol, agent
-- runs (start / activity / finish, idempotency, verification, native session
-- continuity), run-tied agent messages with replies and references, finding
-- states, decision title sources, user choices, code-change and artifact
-- cards, job control, owner-note delivery, interrupted / paused jobs, the
-- final summary, the per-chat cursor and backfill, unread rules, search, host
-- status, attachments and the native-session reveal.
-- LOCAL stack only. Isolation and forgery are in 018_threadlink_0_10_security.

begin;

create extension if not exists pgtap with schema extensions;

select plan(146);

create function pg_temp.act_as_user(sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sub, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
create function pg_temp.act_as_client() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end;
$$;
create function pg_temp.h(seed text) returns text language sql as $$ select md5(seed) || md5(seed || ':2') $$;
create function pg_temp.k(seed text) returns text language sql as $$ select encode(sha256(convert_to(seed, 'UTF8')), 'hex') $$;
create temp table ids (name text primary key, value text) on commit drop;
create function pg_temp.id(n text) returns text language sql as $$ select value from ids where name = n $$;
create function pg_temp.put(n text, v text) returns text language sql as $$
  insert into ids values (n, v) on conflict (name) do update set value = excluded.value returning value;
$$;
create function pg_temp.fails(q text) returns text language plpgsql as $$
declare
  v_state text;
  v_hint text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end;
$$;
create function pg_temp.doc(p text, health text default 'ready', age interval default '0 seconds')
returns jsonb language sql as $$
  select jsonb_build_object('installed', true, 'authenticated', true,
    'authMethod', case p when 'claude-code' then 'claude.ai' else 'chatgpt' end,
    'health', health,
    'healthCheckedAt', to_char((now() - age) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
create function pg_temp.ev(p_where text) returns setof public.chat_events language plpgsql security definer as $$
begin
  return query execute 'select * from public.chat_events where ' || p_where || ' order by seq';
end;
$$;
create function pg_temp.evc(p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute 'select count(*)::int from public.chat_events where ' || p_where into n;
  return n;
end;
$$;
create function pg_temp.cnt(p_table text, p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute format('select count(*)::int from public.%I where ', p_table) || p_where into n;
  return n;
end;
$$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.run(r text) returns public.agent_runs language sql security definer as $$
  select * from public.agent_runs where id = r $$;
create function pg_temp.chat(c text) returns public.chats language sql security definer as $$
  select * from public.chats where id = c $$;
create function pg_temp.default_chat(r text) returns text language sql security definer as $$
  select id from public.chats where room_id = r and is_room_default and deleted_at is null $$;
create function pg_temp.rt() returns public.runtimes language sql security definer as $$
  select r.* from public.runtimes r join public.connection_credentials cc on cc.connection_id = r.connection_id
  where cc.token_prefix = 'tlc_v10rt1' $$;
create function pg_temp.w(j text, claim text, op text, payload jsonb) returns jsonb language sql as $$
  select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), j, claim, op, payload)
$$;
create function pg_temp.wr(j text, claim text, op text, payload jsonb) returns jsonb language sql as $$
  select (public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), j, claim, op, payload)) -> 'result'
$$;
create function pg_temp.claim(j text, claim text) returns jsonb language sql as $$
  select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), (pg_temp.job(j)).task_id, claim)
$$;
create function pg_temp.start(goal text, chat text default null) returns jsonb language sql as $$
  select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('room'), goal, null, null, null,
                               null, null, null, 'team', null, chat)
$$;
create function pg_temp.run_start(j text, claim text, rkey text, p text, role text, extra jsonb default '{}')
returns text language sql as $$
  select pg_temp.wr(j, claim, 'run_started', jsonb_build_object('run_key', rkey, 'provider', p,
    'participant_key', p || ':' || role, 'role', role, 'requested_model', 'model-a', 'access', 'workspace-write',
    'timeout_ms', 1800000) || extra) ->> 'run_id'
$$;
-- Moves a run's last activity back (the 5 s activity throttle).
create function pg_temp.age_run(r text) returns void language sql security definer as $$
  update public.agent_runs set last_activity_at = now() - interval '1 minute' where id = r $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Alice (ChatGPT), a 0.10 Runtime reporting protocol 10, one project
-- with Claude Code and Codex (both ready), and a Team job in its default chat.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_V10Alice000001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'My ChatGPT', pg_temp.h('a-chat'), 'tlc_v10cht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_v10rt1');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Nickron PC', 'windows', 'desktop', '0.10.0', 10);
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/w/Prism'),
  'Prism', 'C:\w\Prism', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.10.0', '{"claude-code":"available"}', '{}', 10);
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:prism', 'Prism worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'v10-chat') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('room', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Prism', pg_temp.id('link')) ->> 'room_id');
select pg_temp.put('dchat', pg_temp.default_chat(pg_temp.id('room')));
select pg_temp.put('j1', pg_temp.start('Add rate limiting') ->> 'job_id');
select pg_temp.claim(pg_temp.id('j1'), 'c1');
reset role;

-- ===========================================================================
-- 1. The provider registry and the protocol
-- ===========================================================================
select is((select count(*)::int from public.agent_providers), 5, 'five providers are registered');
select is((select string_agg(id, ',' order by sort) from public.agent_providers where supported), 'claude-code,codex',
  'only Claude Code and Codex are supported');
select ok(not has_table_privilege('anon', 'public.agent_providers', 'insert')
          and not has_table_privilege('authenticated', 'public.agent_providers', 'update'),
  'no client writes the registry');
select pg_temp.act_as_client();
select is(jsonb_array_length(public.agent_providers_list()), 5, 'anyone reads the registry through agent_providers_list');
select is(public.agent_providers_list() -> 0 ->> 'display_name', 'Claude Code', '...with display names, in order');
reset role;
select is((pg_temp.rt()).protocol, 10, 'the heartbeat overload records protocol 10');
select is(threadlink_private.runtime_protocol_of('0.9.3', null), 9, 'no protocol reported: a 0.9 Runtime counts as 9');
select is(threadlink_private.runtime_protocol_of('1.2.0', null), 10, 'a 1.x Runtime without a report counts as 10');
select is(threadlink_private.runtime_protocol_of('0.9.0', 12), 12, 'a reported protocol wins');
select is(threadlink_private.min_protocol_for('team') || ',' || threadlink_private.min_protocol_for('pair') || ','
          || threadlink_private.min_protocol_for('job_control'), '7,8,10',
  'job starts keep the 0.9 minimum; job control needs protocol 10');

-- ===========================================================================
-- 2. The per-chat cursor
-- ===========================================================================
select ok((select bool_and(chat_seq = rn) from (
             select chat_seq, row_number() over (order by seq) as rn from public.chat_events
             where chat_id = pg_temp.id('dchat')) x),
  'every row of a chat gets the next chat_seq, in insert order, with no gaps');
select is((pg_temp.chat(pg_temp.id('dchat'))).last_event_seq,
  (select max(chat_seq) from public.chat_events where chat_id = pg_temp.id('dchat')),
  'the chat remembers its newest chat_seq');
select is(threadlink_private.v10_backfill() ->> 'events', '0', 'the backfill finds nothing left to number');
-- Production-shaped data: rows without a chat_seq are numbered in seq order.
alter table public.chat_events disable trigger chat_events_guard_update;
update public.chat_events set chat_seq = null where chat_id = pg_temp.id('dchat');
alter table public.chat_events enable trigger chat_events_guard_update;
select ok((threadlink_private.v10_backfill() ->> 'events')::int > 0, 'the backfill numbers existing rows');
select ok((select bool_and(chat_seq = rn) from (
             select chat_seq, row_number() over (order by seq) as rn from public.chat_events
             where chat_id = pg_temp.id('dchat')) x),
  '...per chat, in seq order');

-- ===========================================================================
-- 3. Agent runs
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('r_plan', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'plan:1', 'claude-code', 'planner',
  '{"worktree_label":"Prism / plan"}'));
select ok(pg_temp.id('r_plan') ~ '^tlarn_[0-9a-f]{32}$', 'run_started returns a run id');
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_started', jsonb_build_object('run_key', 'plan:1',
  'provider', 'claude-code', 'participant_key', 'claude-code:planner', 'role', 'planner')),
  jsonb_build_object('run_id', pg_temp.id('r_plan'), 'created', false, 'status', 'running'),
  'the same run key returns the same run (idempotent)');
select is(pg_temp.fails($q$ select pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_started', '{"run_key":"plan:1",
  "provider":"claude-code","participant_key":"claude-code:reviewer","role":"reviewer"}') $q$),
  '55000:conflict', '...and refuses a different identity under that key');
select is(pg_temp.fails($q$ select pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_started', '{"run_key":"x:1",
  "provider":"cursor","participant_key":"cursor:builder","role":"builder"}') $q$),
  '22023:', 'a provider that is not a participant cannot start a run');
select is(pg_temp.fails($q$ select pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_started', '{"run_key":"x:2",
  "provider":"codex","participant_key":"claude-code:builder","role":"builder"}') $q$),
  '22023:', 'the participant key must name the run''s provider');
reset role;
select is((pg_temp.run(pg_temp.id('r_plan'))).runtime_id, (pg_temp.rt()).id, 'the run records its execution host');
select is((pg_temp.run(pg_temp.id('r_plan'))).chat_id, pg_temp.id('dchat'), '...and its chat');
select is((pg_temp.run(pg_temp.id('r_plan'))).status || '|' || (pg_temp.run(pg_temp.id('r_plan'))).activity,
  'running|queued', 'a new run is running, queued for its first step');

select pg_temp.act_as_client();
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_activity',
  jsonb_build_object('run_id', pg_temp.id('r_plan'), 'activity', 'planning')) ->> 'throttled', 'true',
  'an activity within 5 s of the last one is ignored');
reset role;
select pg_temp.age_run(pg_temp.id('r_plan'));
select pg_temp.act_as_client();
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_activity',
  jsonb_build_object('run_id', pg_temp.id('r_plan'), 'activity', 'planning')) ->> 'updated', 'true',
  'a later activity is recorded');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_activity', '{"run_id":%s,"activity":"dancing"}') $q$,
  pg_temp.id('j1'), to_json(pg_temp.id('r_plan'))::text)), '22023:', 'an unknown activity is refused');
reset role;
select is((pg_temp.run(pg_temp.id('r_plan'))).activity, 'planning', 'the live activity is on the run');

-- ===========================================================================
-- 4. Run-tied agent messages, replies and references
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('m1', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_message', jsonb_build_object(
  'sender', 'claude-code', 'type', 'proposal', 'body', 'Plan: three units, API first.',
  'run_id', pg_temp.id('r_plan'))) ->> 'message_id');
select pg_temp.put('e1', (select id from pg_temp.ev(format('team_message_id = %L', pg_temp.id('m1')))));
reset role;
select is((select run_id || '|' || author_role || '|' || author_kind from pg_temp.ev(format('id = %L', pg_temp.id('e1')))),
  pg_temp.id('r_plan') || '|planner|agent', 'the agent row carries its run and the run''s role');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message',
  '{"sender":"codex","type":"review","body":"No run here."}') $q$, pg_temp.id('j1'))),
  '22023:run_required', 'a protocol-10 Runtime cannot write a runless agent message');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message', jsonb_build_object(
  'sender', 'codex', 'type', 'review', 'body', 'Not my run.', 'run_id', %L)) $q$, pg_temp.id('j1'), pg_temp.id('r_plan'))),
  '22023:invalid_run', 'a message cannot use another provider''s run');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message', jsonb_build_object(
  'sender', 'claude-code', 'sender_role', 'reviewer', 'type', 'review', 'body', 'Wrong role.', 'run_id', %L)) $q$,
  pg_temp.id('j1'), pg_temp.id('r_plan'))), '22023:', 'nor claim a role its run does not have');
select pg_temp.put('r_rev', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'plan-review:1', 'codex', 'reviewer'));
select pg_temp.put('m2', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_message', jsonb_build_object(
  'sender', 'codex', 'type', 'review', 'body', 'Looks right; one concern on limits.',
  'run_id', pg_temp.id('r_rev'), 'reply_to', pg_temp.id('m1'))) ->> 'message_id');
reset role;
select is((select reply_to_event_id from pg_temp.ev(format('team_message_id = %L', pg_temp.id('m2')))), pg_temp.id('e1'),
  'a plan review replies to the plan proposal''s chat row');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message', jsonb_build_object(
  'sender', 'codex', 'type', 'review', 'body', 'x', 'run_id', %L, 'reply_to', 'tlcev_%s')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_rev'), repeat('0', 32))), '22023:', 'a reply to an unknown row is refused');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message', jsonb_build_object(
  'sender', 'codex', 'type', 'review', 'body', 'x', 'run_id', %L, 'ref_kind', 'finding', 'ref_id', 'tlfnd_%s')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_rev'), repeat('0', 32))), '22023:', 'a reference to an unknown finding is refused');
reset role;

-- ===========================================================================
-- 5. Findings: 0.10 states, the raising run, file:line, cards
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'upsert_nodes', '{"nodes":[{"key":"api","title":"API","owner_provider":"claude-code","reviewer_provider":"codex"}]}');
select pg_temp.put('f1', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_finding', jsonb_build_object(
  'node_key', 'api', 'severity', 'blocking', 'category', 'security', 'title', 'Limits keyed by IP only',
  'body', 'Use the account id too.', 'raised_by', 'codex', 'run_id', pg_temp.id('r_rev'),
  'owner_participant', 'claude-code:builder', 'file_path', 'app/api/limit.ts', 'line', 42)) ->> 'finding_id');
reset role;
select is((select payload ->> 'findingId' || '|' || (payload ->> 'line') || '|' || (payload ->> 'raisedRunId') || '|' || ref_id
           from pg_temp.ev(format('event_type = ''finding'' and ref_id = %L', pg_temp.id('f1')))),
  pg_temp.id('f1') || '|42|' || pg_temp.id('r_rev') || '|' || pg_temp.id('f1'),
  'the finding card carries the finding, its file:line and the raising run');
select is((select body from pg_temp.ev(format('event_type = ''finding'' and ref_id = %L', pg_temp.id('f1')))),
  'Blocking finding from Codex (security) on unit api', 'the card''s text is built from trusted fields only');
select is((select location from public.team_findings where id = pg_temp.id('f1')), 'app/api/limit.ts:42',
  'the location is derived from file:line');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_finding', jsonb_build_object(
  'severity', 'important', 'category', 'tests', 'title', 't', 'body', 'b', 'raised_by', 'codex')) $q$,
  pg_temp.id('j1'))), '22023:run_required', 'an agent''s finding needs its raising run');
select pg_temp.put('m3', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_message', jsonb_build_object(
  'sender', 'claude-code', 'type', 'response', 'body', 'Keyed by account id now.', 'run_id', pg_temp.id('r_plan'),
  'ref_kind', 'finding', 'ref_id', pg_temp.id('f1'))) ->> 'message_id');
reset role;
select is((select reply_to_event_id from pg_temp.ev(format('team_message_id = %L', pg_temp.id('m3')))),
  (select id from pg_temp.ev(format('event_type = ''finding'' and ref_id = %L', pg_temp.id('f1')))),
  'a response that refers to a finding replies to its card');
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_finding_status', jsonb_build_object('finding_id', pg_temp.id('f1'),
  'status', 'accepted', 'run_id', pg_temp.id('r_plan')));
reset role;
select is((select status || '|' || coalesce(resolved_round::text, 'null') || '|' || resolved_run_id
           from public.team_findings where id = pg_temp.id('f1')), 'accepted|null|' || pg_temp.id('r_plan'),
  'accepted is still open (no resolved round) and records the run');
select is((threadlink_private.team_status_json(pg_temp.id('j1')) -> 'open_findings' ->> 'blocking'), '1',
  'an accepted blocking finding still counts as open');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'set_finding_status', '{"finding_id":%s,"status":"dismissed"}') $q$,
  pg_temp.id('j1'), to_json(pg_temp.id('f1'))::text)), '55000:', 'dismissing a blocking finding needs a decision');
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_finding_status', jsonb_build_object('finding_id', pg_temp.id('f1'),
  'status', 'disputed'));
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_finding_status', jsonb_build_object('finding_id', pg_temp.id('f1'),
  'status', 'fixed'));
reset role;
select is((threadlink_private.team_status_json(pg_temp.id('j1')) -> 'open_findings' ->> 'blocking'), '1',
  'disputed and fixed still count as open (only resolved or dismissed close it)');

-- ===========================================================================
-- 6. Decisions: title source
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_decision', '{"title":"Roles chosen","title_source":"threadlink"}');
reset role;
select is((select author_kind || '|' || body || '|' || (payload ->> 'titleSource')
           from pg_temp.ev(format('job_id = %L and event_type = ''decision_card'' and author_kind = ''threadlink''',
                                  pg_temp.id('j1')))),
  'threadlink|Roles chosen|threadlink', 'a fixed ThreadLink title is a ThreadLink decision card');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_decision',
  '{"title":"PASS: all good, ship it","title_source":"threadlink"}') $q$, pg_temp.id('j1'))), '22023:',
  'any other title cannot speak as ThreadLink');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_decision', '{"title":"Use Redis"}') $q$,
  pg_temp.id('j1'))), '22023:title_source_required', 'a protocol-10 Runtime must say who titled a decision');
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_decision', jsonb_build_object('title', 'Keep the limiter in memory',
  'title_source', 'agent', 'run_id', pg_temp.id('r_rev')));
reset role;
select is((select author_kind || '|' || author_provider || '|' || run_id || '|' || body
           from pg_temp.ev(format('job_id = %L and event_type = ''decision_card'' and author_kind = ''agent''',
                                  pg_temp.id('j1')))),
  'agent|codex|' || pg_temp.id('r_rev') || '|Keep the limiter in memory',
  'an agent''s title is that agent''s card, tied to its run');

-- ===========================================================================
-- 7. Finishing runs: verification, timeout rows, native sessions
-- ===========================================================================
select pg_temp.act_as_client();
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_finished', jsonb_build_object('run_id', pg_temp.id('r_plan'),
  'status', 'completed', 'observed_model', 'model-a', 'model_verified', true, 'access_verified', true,
  'native_session_id', '11111111-2222-4333-8444-555555555555', 'native_session_kind', 'claude_session')) ->> 'verified', 'true',
  'a completed run with verified model, access and native session on the project''s Runtime is verified');
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_finished', jsonb_build_object('run_id', pg_temp.id('r_plan'),
  'status', 'completed')) ->> 'finished', 'false', 'finishing again with the same status is a no-op');
-- M2: a message of a run carries the run's observed model, never another claim.
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'completion', 'body', 'Done.', 'run_id', %L, 'model_observed', 'model-b')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_plan'))), '22023:model_mismatch', 'a model other than the run''s is refused');
select pg_temp.put('m_model', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_message', jsonb_build_object(
  'sender', 'claude-code', 'type', 'completion', 'body', 'Done, as planned.', 'run_id', pg_temp.id('r_plan')))
  ->> 'message_id');
reset role;
select is((select model_observed from public.team_messages where id = pg_temp.id('m_model')), 'model-a',
  '...and without one the message takes the run''s observed model');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed', 'native_session_id', '-rf', 'native_session_kind', 'other')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_rev'))), '22023:', 'a native session id must start with a letter or digit');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed', 'native_session_id', 'not-a-uuid', 'native_session_kind', 'claude_session')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_rev'))), '22023:', 'a Claude Code session id must be a UUID');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_finished', '{"run_id":%s,"status":"failed"}') $q$,
  pg_temp.id('j1'), to_json(pg_temp.id('r_plan'))::text)), '55000:conflict', '...a different outcome is refused');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed', 'model_verified', true)) $q$, pg_temp.id('j1'), pg_temp.id('r_rev'))), '22023:',
  'a model cannot be verified without an observed model');
select pg_temp.put('r_to', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'review:api:1', 'codex', 'reviewer',
  '{"node_key":"api","activity":"reviewing"}'));
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_finished', jsonb_build_object('run_id', pg_temp.id('r_to'),
  'status', 'timed_out', 'failure', 'timeout'));
reset role;
select is((select body from pg_temp.ev(format('event_type = ''timeout'' and run_id = %L', pg_temp.id('r_to')))),
  'Codex timed out after 30 min while reviewing on api.', 'a timeout row names provider, duration, step and unit');
select is((select payload ->> 'minutes' from pg_temp.ev(format('event_type = ''timeout'' and run_id = %L', pg_temp.id('r_to')))),
  '30', '...with the same facts as data');
select is((pg_temp.run(pg_temp.id('r_to'))).verification ->> 'exitClean', 'false', 'a timed-out run did not exit cleanly');
-- Resuming its own session inside the job is allowed.
select pg_temp.act_as_client();
select pg_temp.put('r_plan2', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'plan:2', 'claude-code', 'planner',
  '{"continuity":"resumed","resumed_from_run_key":"plan:1"}'));
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'run_started', '{"run_key":"plan:3","provider":"codex",
  "participant_key":"codex:planner","role":"planner","continuity":"resumed","resumed_from_run_key":"plan:1"}') $q$,
  pg_temp.id('j1'))), '22023:', 'a participant resumes only its own session');
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'run_finished', jsonb_build_object('run_id', pg_temp.id('r_plan2'),
  'status', 'completed', 'native_session_id', '11111111-2222-4333-8444-555555555555', 'native_session_kind', 'claude_session'));
reset role;
select is((pg_temp.run(pg_temp.id('r_plan2'))).resumed_from_run_id, pg_temp.id('r_plan'),
  'a resumed run points at the run it resumed');
select is((pg_temp.run(pg_temp.id('r_plan2'))).native_session_id, '11111111-2222-4333-8444-555555555555',
  'the same native session may appear twice in one chat');

-- ===========================================================================
-- 8. User choices
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('ch1', pg_temp.wr(pg_temp.id('j1'), 'c1', 'request_choice', jsonb_build_object(
  'request_key', 'timeout:review:api:1', 'kind', 'timeout', 'run_id', pg_temp.id('r_to'), 'provider', 'codex',
  'other_provider', 'claude-code', 'step', 'reviewing', 'minutes', 30, 'node_key', 'api')) ->> 'choice_id');
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'request_choice', jsonb_build_object(
  'request_key', 'timeout:review:api:1', 'kind', 'timeout')) ->> 'choice_id', pg_temp.id('ch1'),
  'the same request key returns the same choice');
reset role;
select is((select string_agg(o ->> 'key', ',' order by ord) from public.user_choices c,
           jsonb_array_elements(c.options) with ordinality as x(o, ord) where c.id = pg_temp.id('ch1')),
  'retry,retry_other,increase_timeout,stop', 'a timeout offers exactly its allow-list');
select is((select title from public.user_choices where id = pg_temp.id('ch1')),
  'Codex timed out after 30 min while reviewing on api. What should ThreadLink do?',
  'the title is fixed text plus trusted parameters');
select is((select string_agg(o ->> 'label', ' · ' order by ord) from public.user_choices c,
           jsonb_array_elements(c.options) with ordinality as x(o, ord) where c.id = pg_temp.id('ch1')),
  'Retry this step · Retry with Claude Code · Give it more time · Stop', 'labels name providers from the registry');
select is(pg_temp.evc(format('event_type = ''choice'' and ref_id = %L and visibility = ''visible''', pg_temp.id('ch1'))), 1,
  'the choice is a visible ThreadLink row');
select pg_temp.act_as_client();
select pg_temp.put('ch2', pg_temp.wr(pg_temp.id('j1'), 'c1', 'request_choice', '{"request_key":"fail:1",
  "kind":"provider_failure","provider":"claude-code","options":["retry","stop"]}') ->> 'choice_id');
reset role;
select is((select string_agg(o ->> 'key', ',' order by ord) from public.user_choices c,
           jsonb_array_elements(c.options) with ordinality as x(o, ord) where c.id = pg_temp.id('ch2')),
  'retry,stop', 'the Runtime may narrow the options');
select is((select count(*)::int from public.audit_events where action = 'team.choice_requested'
           and resource_id in (pg_temp.id('ch1'), pg_temp.id('ch2'))), 2, 'asking is audited');
select is((pg_temp.job(pg_temp.id('j1'))).status, 'paused', 'a job waiting for the owner is paused (not finished)');
-- A plan disagreement past the budget: the owner may allow one more round.
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'open_round', '{"kind":"planning"}');
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'open_round', '{"kind":"planning"}');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'open_round', '{"kind":"planning"}') $q$, pg_temp.id('j1'))),
  '54000:', 'the planning budget is exhausted');
select pg_temp.put('ch3', pg_temp.wr(pg_temp.id('j1'), 'c1', 'request_choice', '{"request_key":"plan:disagreement:2",
  "kind":"plan_disagreement","provider":"claude-code","other_provider":"codex","options":["extra_round","stop"]}')
  ->> 'choice_id');
reset role;
select pg_temp.act_as_user('user_V10Alice000001');
select public.decide_choice(pg_temp.id('ch3'), 'extra_round');
reset role;
select pg_temp.act_as_client();
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'open_round', '{"kind":"planning"}') ->> 'round', '3',
  'after the owner allowed one more round, one more round opens');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'open_round', '{"kind":"planning"}') $q$, pg_temp.id('j1'))),
  '54000:', '...and only one');
reset role;
select is(threadlink_private.team_status_json(pg_temp.id('j1')) #>> '{rounds,planning,max}', '3',
  'the status shows the extended budget');

select pg_temp.act_as_user('user_V10Alice000001');
select is(public.decide_choice(pg_temp.id('ch1'), 'retry_other') ->> 'status', 'chosen', 'the owner decides');
select is(public.decide_choice(pg_temp.id('ch1'), 'retry_other') ->> 'replayed', 'true', 'the same answer again is a replay');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('ch1'))), '55000:choice_closed',
  'a decided choice cannot be changed');
reset role;
select is((select body from pg_temp.ev(format('event_type = ''choice'' and ref_id = %L and payload ->> ''status'' = ''chosen''',
  pg_temp.id('ch1')))), 'You chose: Retry with Claude Code.', 'the answer is a ThreadLink row');
select pg_temp.act_as_client();
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'read_choices', jsonb_build_object('choice_ids',
  jsonb_build_array(pg_temp.id('ch1')))) -> 'choices' -> 0 ->> 'chosen_key', 'retry_other',
  'the Runtime reads the answer');
reset role;

-- ===========================================================================
-- 9. Code changes and artifacts
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('r_build', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'build:api:1', 'claude-code', 'builder',
  '{"node_key":"api"}'));
select pg_temp.put('chg', (pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_change', jsonb_build_object(
  'node_key', 'api', 'run_id', pg_temp.id('r_build'), 'files_changed', 2, 'insertions', 40, 'deletions', 3,
  'files', jsonb_build_array('app/api/limit.ts', 'tests/limit.test.ts'), 'branch', 'tl/prism/api',
  'commit', 'abc1234', 'tests', jsonb_build_array(jsonb_build_object('command', 'npm test', 'ok', true)),
  'diff', E'+const password = "hunter2-secret"\n+export const limit = 10;'))) ::text);
reset role;
select is((select author_kind || '|' || author_provider || '|' || run_id from pg_temp.ev(format(
  'event_type = ''code_change'' and job_id = %L', pg_temp.id('j1')))), 'agent|claude-code|' || pg_temp.id('r_build'),
  'a code change is the builder run''s card');
select is((select body from pg_temp.ev(format('event_type = ''code_change'' and job_id = %L', pg_temp.id('j1')))),
  'Changed 2 files (+40 ' || U&'\2212' || '3). Tests: 1 of 1 passed.', 'its text is built from the numbers');
select is((select payload -> 'files' from pg_temp.ev(format('event_type = ''code_change'' and job_id = %L', pg_temp.id('j1')))),
  '["app/api/limit.ts", "tests/limit.test.ts"]'::jsonb, '...with the files as data');
select is((select kind || '|' || mime || '|' || (content !~ 'hunter2') from public.chat_artifacts
           where id = (pg_temp.id('chg')::jsonb ->> 'artifact_id')), 'diff|text/x-diff|true',
  'the diff becomes a redacted diff artifact');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_change', jsonb_build_object('run_id', %L,
  'files_changed', 1, 'insertions', 1, 'deletions', 0, 'files', '["../../etc/passwd"]')) $q$,
  pg_temp.id('j1'), pg_temp.id('r_build'))), '22023:', 'a file outside the repository is refused');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_change', jsonb_build_object('run_id', %L,
  'files_changed', 1, 'insertions', 1, 'deletions', 0)) $q$, pg_temp.id('j1'), pg_temp.id('r_rev'))),
  '22023:invalid_run', 'only a builder''s run writes a code change');
select pg_temp.put('art', pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_artifact', '{"request_key":"report:1","kind":"report",
  "title":"Final report","mime":"text/markdown","content":"# Report\n\nAll units done. token=abcd1234efgh"}') ->> 'artifact_id');
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'add_artifact', '{"request_key":"report:1","kind":"report",
  "title":"Final report","mime":"text/markdown","content":"again"}') ->> 'artifact_id', pg_temp.id('art'),
  'an artifact is idempotent by its request key');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_artifact', jsonb_build_object('kind', 'notes',
  'title', 'Big', 'mime', 'text/plain', 'content', repeat('x', 524289))) $q$, pg_temp.id('j1'))), '22023:',
  'an artifact over 512 KiB is refused');
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c1', 'add_artifact', '{"kind":"user_attachment",
  "title":"Mine","mime":"text/plain","content":"x"}') $q$, pg_temp.id('j1'))), '22023:',
  'the Runtime cannot write an owner attachment');
reset role;
select ok((select content !~ 'abcd1234efgh' from public.chat_artifacts where id = pg_temp.id('art')),
  'artifact text is redacted before it is stored');

-- ===========================================================================
-- 10. Owner notes: delivery states
-- ===========================================================================
select pg_temp.act_as_user('user_V10Alice000001');
select pg_temp.put('note', public.post_chat_message(p_chat_id => pg_temp.id('dchat'),
  p_body => '@codex please also cover burst traffic', p_idempotency_key => null) ->> 'event_id');
select pg_temp.put('note2', public.post_chat_message(p_chat_id => pg_temp.id('dchat'),
  p_body => 'Everyone: keep it small', p_idempotency_key => null) ->> 'event_id');
reset role;
select is((select queued_for from pg_temp.ev(format('id = %L', pg_temp.id('note')))), array['codex'],
  'a note to one agent is queued for that agent');
select is((select queued_for from pg_temp.ev(format('id = %L', pg_temp.id('note2')))), array['claude-code', 'codex'],
  'a note to the team is queued for every participant');
select pg_temp.act_as_client();
select pg_temp.put('r_rev2', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'review:api:2', 'codex', 'reviewer'));
select is(jsonb_array_length(pg_temp.wr(pg_temp.id('j1'), 'c1', 'read_owner_notes',
  jsonb_build_object('run_id', pg_temp.id('r_rev2'))) -> 'notes'), 2, 'the Runtime reads the notes for a run');
reset role;
select is((select consumed_by_run_id from pg_temp.ev(format('id = %L', pg_temp.id('note')))), pg_temp.id('r_rev2'),
  'the note records the run that consumed it');
select is((select body from pg_temp.ev(format('job_id = %L and event_type = ''owner_routed''', pg_temp.id('j1')))
           order by seq desc limit 1), 'Your note was passed to Codex.', 'the chat says who saw it');

-- ===========================================================================
-- 11. Job control
-- ===========================================================================
select pg_temp.act_as_user('user_V10Alice000001');
select is(public.control_job(pg_temp.id('j1'), 'pause_after_step') ->> 'control', 'pause_after_step',
  'the owner asks to pause after the current step');
select is(public.control_job(pg_temp.id('j1'), 'pause_after_step') ->> 'replayed', 'true', 'asking again is a replay');
select is(pg_temp.fails(format($q$ select public.control_job(%L, 'explode') $q$, pg_temp.id('j1'))),
  '22023:invalid_control', 'an unknown control is refused');
reset role;
select is((select body from pg_temp.ev(format('job_id = %L and event_type = ''control_requested''', pg_temp.id('j1')))),
  'Pause requested: after the current step.', 'the request is a ThreadLink row');
select is(threadlink_private.team_status_json(pg_temp.id('j1')) ->> 'control', 'pause_after_step',
  'the Runtime sees the control in every answer');
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_status', '{"status":"paused"}');
select is(pg_temp.wr(pg_temp.id('j1'), 'c1', 'ack_control', '{"control":"pause_after_step"}') ->> 'cleared', 'true',
  'the Runtime acknowledges the control once honoured');
reset role;
select is((pg_temp.job(pg_temp.id('j1'))).status || '|' || coalesce((pg_temp.job(pg_temp.id('j1'))).control, 'null'),
  'paused|null', 'the job is paused and the control is cleared');
select pg_temp.act_as_user('user_V10Alice000001');
select is(public.control_job(pg_temp.id('j1'), 'resume') ->> 'control', 'resume', 'a paused job can be resumed');
reset role;
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'ack_control', '{"control":"resume"}');
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_status', '{"status":"interrupted"}');
reset role;
select is(pg_temp.evc(format('job_id = %L and event_type = ''interrupted'' and visibility = ''visible''', pg_temp.id('j1'))), 1,
  'an interrupted job says so in the chat');
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_status', '{"status":"building"}');
reset role;
select is(pg_temp.evc(format('job_id = %L and event_type = ''phase'' and payload ->> ''phase'' = ''build''', pg_temp.id('j1'))), 1,
  'a status change writes a phase separator');

-- ===========================================================================
-- 12. The final summary
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('r_open', pg_temp.run_start(pg_temp.id('j1'), 'c1', 'inspect:1', 'codex', 'reviewer'));
select pg_temp.wr(pg_temp.id('j1'), 'c1', 'set_final', '{"verdict":"NEEDS_FIX","reason":"review_not_passed",
  "evidence":{"tests":[{"command":"npm test","ok":true},{"command":"npm run lint","ok":false}]}}');
reset role;
select is((pg_temp.run(pg_temp.id('r_open'))).status, 'cancelled', 'a run still open when the job ends is cancelled');
select is((select status from public.user_choices where id = pg_temp.id('ch2')), 'cancelled',
  'a pending choice lapses when the job ends');
select is((select payload ->> 'verdict' || '|' || (payload #>> '{tests,run}') || '|' || (payload #>> '{tests,passed}')
                  || '|' || (payload ->> 'openItems') || '|' || (payload ->> 'reportArtifactId') || '|' || (payload ->> 'changes')
           from pg_temp.ev(format('job_id = %L and event_type = ''job_summary''', pg_temp.id('j1')))),
  'NEEDS_FIX|2|1|1|' || pg_temp.id('art') || '|1', 'the summary is built from job data only');
select is((select payload -> 'agents' from pg_temp.ev(format('job_id = %L and event_type = ''job_summary''', pg_temp.id('j1')))),
  '["claude-code", "codex"]'::jsonb, '...naming the agents that ran');
select ok((select body ~ '^Summary: NEEDS_FIX\. Units done: 0 of 1\. Tests: 1 of 2 passed\.'
           from pg_temp.ev(format('job_id = %L and event_type = ''job_summary''', pg_temp.id('j1')))),
  'its text is fixed words and numbers');
select pg_temp.act_as_user('user_V10Alice000001');
select is(pg_temp.fails(format($q$ select public.control_job(%L, 'stop_now') $q$, pg_temp.id('j1'))), '55000:job_finished',
  'a finished job takes no control');
reset role;

-- ===========================================================================
-- 13. Native sessions never cross chats; the reveal
-- ===========================================================================
select pg_temp.act_as_user('user_V10Alice000001');
select pg_temp.put('c2', public.create_chat('Second chat', pg_temp.id('room')) ->> 'chat_id');
select is(public.set_room_step_timeouts(pg_temp.id('room'), '{"review":40,"build":45}') ->> 'step_timeouts',
  '{"build": 45, "review": 40}', 'the owner sets step timeouts in minutes');
select is(pg_temp.fails(format($q$ select public.set_room_step_timeouts(%L, '{"review":1}') $q$, pg_temp.id('room'))),
  '22023:invalid', 'a timeout under 2 minutes is refused');
select is(pg_temp.fails(format($q$ select public.set_room_step_timeouts(%L, '{"lunch":30}') $q$, pg_temp.id('room'))),
  '22023:invalid', 'an unknown step is refused');
reset role;
select pg_temp.act_as_client();
select pg_temp.put('j2', pg_temp.start('Another goal', pg_temp.id('c2')) ->> 'job_id');
reset role;
select is((select (t.content::jsonb) -> 'timeouts' from public.tasks t where t.id = (pg_temp.job(pg_temp.id('j2'))).task_id),
  '{"build": 45, "review": 40}'::jsonb, 'a new job''s carrier carries the project''s timeouts');
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('j2'), 'c2');
select pg_temp.put('r_j2', pg_temp.run_start(pg_temp.id('j2'), 'c2', 'plan:1', 'claude-code', 'planner'));
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c2', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed', 'native_session_id', '11111111-2222-4333-8444-555555555555', 'native_session_kind', 'claude_session')) $q$,
  pg_temp.id('j2'), pg_temp.id('r_j2'))), '42501:native_session_reused',
  'a native session of one chat is never reused in another');
select is(pg_temp.wr(pg_temp.id('j2'), 'c2', 'run_finished', jsonb_build_object('run_id', pg_temp.id('r_j2'),
  'status', 'completed', 'native_session_id', '66666666-7777-4888-9999-aaaaaaaaaaaa', 'native_session_kind', 'claude_session')) ->> 'finished', 'true',
  'a fresh session is fine');
reset role;
select pg_temp.act_as_user('user_V10Alice000001');
select is((select count(*)::int from public.agent_runs where job_id = pg_temp.id('j1')), 7,
  'the owner reads the runs of a job');
select ok(not has_column_privilege('authenticated', 'public.agent_runs', 'native_session_id', 'select'),
  'but not the native session id column');
select is(public.reveal_run_native_session(pg_temp.id('r_plan')) ->> 'resume_command', 'claude --resume 11111111-2222-4333-8444-555555555555',
  'the explicit reveal returns it, with the verified resume command');
reset role;
select is((select count(*)::int from public.audit_events where action = 'team.native_session_revealed'
           and resource_id = pg_temp.id('r_plan')), 1, '...and is audited');

-- ===========================================================================
-- 14. Unread, the read cursor, search, host status, attachments
-- ===========================================================================
select pg_temp.act_as_user('user_V10Alice000001');
select ok((select unread_count from public.chat_list_extras_v2(array[pg_temp.id('dchat')])) > 0,
  'agent rows and important ThreadLink rows count as unread');
select is(public.mark_chat_read_seq(pg_temp.id('dchat'), 1000000) ->> 'last_read_chat_seq',
  (pg_temp.chat(pg_temp.id('dchat'))).last_event_seq::text, 'the read cursor never passes the newest row');
select is((select unread_count from public.chat_list_extras_v2(array[pg_temp.id('dchat')])), 0, 'read: nothing unread');
select is((pg_temp.chat(pg_temp.id('dchat'))).last_read_seq,
  (select max(seq) from public.chat_events where chat_id = pg_temp.id('dchat')), 'the 0.9 cursor follows');
select public.mark_chat_read_seq(pg_temp.id('c2'), 1000000);
reset role;
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('j2'), 'c2', 'set_status', '{"status":"planning"}');
reset role;
select pg_temp.act_as_user('user_V10Alice000001');
select is((select unread_count from public.chat_list_extras_v2(array[pg_temp.id('c2')])), 0,
  'phases and status rows are never unread');
select is((select kind || '|' || chat_id from public.search_my_chats('burst traffic') limit 1),
  'message|' || pg_temp.id('dchat'), 'search finds a visible message');
select is((select count(*)::int from public.search_my_chats('Limits keyed') where kind = 'finding'), 1,
  'search finds a finding title');
select is((select count(*)::int from public.search_my_chats('Second') where kind = 'chat'), 1, 'search finds a chat name');
select is((select count(*)::int from public.search_my_chats('100%_') ), 0, 'wildcards are plain text');
select is(pg_temp.fails($q$ select * from public.search_my_chats('x') $q$), '22023:invalid', 'a one-letter search is refused');
select is((select count(*)::int from public.search_my_chats('burst traffic', 20,
             jsonb_build_object('projectId', pg_temp.id('room'), 'mode', 'team', 'provider', 'codex'))), 1,
  'search filters: project, mode and provider match');
select is((select count(*)::int from public.search_my_chats('burst traffic', 20, '{"mode":"solo"}')), 0,
  '...and a filter that does not match removes the hit');
select is((select count(*)::int from public.search_my_chats('burst traffic', 20,
             jsonb_build_object('from', (now() + interval '1 day')::text))), 0, 'a date range filters by time');
select is(pg_temp.fails($q$ select * from public.search_my_chats('burst', 20, '{"mode":"<x>"}') $q$), '22023:invalid',
  'an invalid filter is refused');
select is(public.chat_host_status(pg_temp.id('dchat')) #>> '{runtime,label}', 'Nickron PC', 'the chat says where it runs');
select is(public.chat_host_status(pg_temp.id('dchat')) #>> '{runtime,presence}', 'online', '...online (recent heartbeat)');
select is(public.chat_host_status(pg_temp.id('dchat')) #>> '{agents,0,state}', 'ready', 'agents are ready');
select ok(public.chat_host_status(pg_temp.id('dchat')) #>> '{agents,0,checked_at}' is not null, '...with the time of the check');
select pg_temp.put('att', public.add_chat_attachment(pg_temp.id('dchat'), 'Notes',
  E'Context for the team.\nAPI_KEY=sk-live-abcdefghijklmnop', 'text/plain') ->> 'artifact_id');
select is(pg_temp.fails(format($q$ select public.add_chat_attachment(%L, 'Big', repeat('x', 65537), 'text/plain') $q$,
  pg_temp.id('dchat'))), '22023:too_long', 'an attachment over 64 KiB is refused');
select is(pg_temp.fails(format($q$ select public.add_chat_attachment(%L, 'Html', 'x', 'text/html') $q$,
  pg_temp.id('dchat'))), '22023:invalid', 'only text or markdown');
reset role;
select is((select kind || '|' || created_by || '|' || (content ~ 'sk-live') from public.chat_artifacts where id = pg_temp.id('att')),
  'user_attachment|owner|false', 'an attachment is the owner''s, redacted');

-- ===========================================================================
-- 15. Protocol 9 Runtimes keep working (rollout)
-- ===========================================================================
select pg_temp.act_as_client();
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.9.0', '{"claude-code":"available"}', '{}');
reset role;
select is((pg_temp.rt()).protocol, 10, 'a heartbeat without a protocol never lowers the stored one');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.wr(%L, 'c2', 'add_message',
  '{"sender":"codex","type":"proposal","body":"Legacy message."}') $q$, pg_temp.id('j2'))), '22023:run_required',
  'a Runtime that once reported protocol 10 cannot fall back to runless messages');
reset role;
select is(threadlink_private.runtime_protocol_of('0.9.0', 10), 10, 'the highest protocol counts');

-- Deleting the account removes its chats, jobs, runs, choices and artifacts
-- (found by the real-agent run: "no action" chat keys made this fail).
select ok((select count(*) from public.team_jobs j join public.users u on u.id = j.owner_user_id
           where u.clerk_user_id = 'user_V10Alice000001' and j.chat_id is not null) > 0,
  'the account has jobs in chats');
select lives_ok($$ delete from public.users where clerk_user_id = 'user_V10Alice000001' $$,
  'an account with chats, jobs, runs and choices can be deleted');
select is((select count(*)::int from public.chats c where not exists
           (select 1 from public.users u where u.id = c.owner_user_id)), 0, 'and nothing of it is left behind');

select * from finish();
rollback;
