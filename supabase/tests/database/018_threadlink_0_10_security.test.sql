-- ThreadLink 0.10 security (pgTAP): cross-account isolation for runs,
-- choices, artifacts, search, host status and job control; forged run ids on
-- every Runtime write (another job, another provider, another account);
-- runless agent messages from a protocol-10 Runtime; native sessions reused
-- across chats; choice options outside the allow-list; attachment size and
-- redaction; the payload shape and provenance constraints held even against
-- a privileged writer; privileges on every new table and RPC.
-- LOCAL stack only. Adversarial.

begin;

create extension if not exists pgtap with schema extensions;

select plan(81);

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
create function pg_temp.doc(p text) returns jsonb language sql as $$
  select jsonb_build_object('installed', true, 'authenticated', true,
    'authMethod', case p when 'claude-code' then 'claude.ai' else 'chatgpt' end, 'health', 'ready',
    'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
create function pg_temp.evc(p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute 'select count(*)::int from public.chat_events where ' || p_where into n;
  return n;
end;
$$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.default_chat(r text) returns text language sql security definer as $$
  select id from public.chats where room_id = r and is_room_default and deleted_at is null $$;
-- A write by one account's Runtime (a-rt / b-rt) with its own agent session.
create function pg_temp.w(who text, j text, claim text, op text, payload jsonb) returns jsonb language sql as $$
  select public.team_job_write(pg_temp.h(who || '-rt'), pg_temp.id(who || 'agent'), j, claim, op, payload) -> 'result'
$$;
create function pg_temp.start(who text, goal text, chat text default null) returns jsonb language sql as $$
  select public.start_team_job(pg_temp.h(who || '-chat'), pg_temp.id(who || 'chat'), pg_temp.id(who || 'room'), goal,
                               null, null, null, null, null, null, 'team', null, chat)
$$;
create function pg_temp.run_start(who text, j text, claim text, rkey text, p text, role text) returns text language sql as $$
  select pg_temp.w(who, j, claim, 'run_started', jsonb_build_object('run_key', rkey, 'provider', p,
    'participant_key', p || ':' || role, 'role', role)) ->> 'run_id'
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Alice and Bob, each with a protocol-10 Runtime, a project, a
-- running Team job and runs.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_V10SecAlice001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'Alice chat', pg_temp.h('a-chat'), 'tlc_v1sac1');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_v1sar1');
reset role;
select pg_temp.act_as_user('user_V10SecBob00001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob chat', pg_temp.h('b-chat'), 'tlc_v1sbc1');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_v1sbr1');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Alice PC', 'windows', 'desktop', '0.10.0', 10);
select pg_temp.put('aws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/a'), 'A', 'C:\a', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.10.0', '{"claude-code":"available"}', '{}', 10);
select pg_temp.put('aagent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('aws'),
  'cc:a', 'A worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('achat', public.register_session(pg_temp.h('a-chat'), null, null, 'v1s-a') ->> 'id');
select pg_temp.put('alink', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('achat'), pg_temp.id('aagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('aagent'), pg_temp.id('alink'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('aroom', public.create_room(pg_temp.h('a-chat'), pg_temp.id('achat'), 'Alice project', pg_temp.id('alink')) ->> 'room_id');
select pg_temp.put('aj', pg_temp.start('a', 'Alice goal') ->> 'job_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('aagent'), (pg_temp.job(pg_temp.id('aj'))).task_id, 'ca');
select pg_temp.put('arun', pg_temp.run_start('a', pg_temp.id('aj'), 'ca', 'plan:1', 'claude-code', 'planner'));
select pg_temp.put('arun_codex', pg_temp.run_start('a', pg_temp.id('aj'), 'ca', 'review:1', 'codex', 'reviewer'));

select public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'linux', 'desktop', '0.10.0', 10);
select pg_temp.put('bws', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/b'), 'B', '/b', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('b-rt'), '0.10.0', '{"claude-code":"available"}', '{}', 10);
select pg_temp.put('bagent', public.register_runtime_session(pg_temp.h('b-rt'), pg_temp.id('bws'),
  'cc:b', 'B worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('bchat', public.register_session(pg_temp.h('b-chat'), null, null, 'v1s-b') ->> 'id');
select pg_temp.put('blink', public.request_pairing(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('bagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('blink'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('broom', public.create_room(pg_temp.h('b-chat'), pg_temp.id('bchat'), 'Bob project', pg_temp.id('blink')) ->> 'room_id');
select pg_temp.put('bj', pg_temp.start('b', 'Bob goal') ->> 'job_id');
select public.claim_task(pg_temp.h('b-rt'), pg_temp.id('bagent'), (pg_temp.job(pg_temp.id('bj'))).task_id, 'cb');
select pg_temp.put('brun', pg_temp.run_start('b', pg_temp.id('bj'), 'cb', 'plan:1', 'claude-code', 'planner'));

-- Alice: a second job in another chat of her project, with its own run.
reset role;
select pg_temp.act_as_user('user_V10SecAlice001');
select pg_temp.put('ac2', public.create_chat('Alice second', pg_temp.id('aroom')) ->> 'chat_id');
reset role;
select pg_temp.act_as_client();
select pg_temp.put('aj2', pg_temp.start('a', 'Alice second goal', pg_temp.id('ac2')) ->> 'job_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('aagent'), (pg_temp.job(pg_temp.id('aj2'))).task_id, 'ca2');
select pg_temp.put('arun2', pg_temp.run_start('a', pg_temp.id('aj2'), 'ca2', 'plan:1', 'claude-code', 'planner'));
-- Alice's choice, artifact and a finished run with a native session.
select pg_temp.put('achoice', pg_temp.w('a', pg_temp.id('aj'), 'ca', 'request_choice',
  '{"request_key":"f:1","kind":"provider_failure","provider":"claude-code","other_provider":"codex"}') ->> 'choice_id');
select pg_temp.put('aart', pg_temp.w('a', pg_temp.id('aj'), 'ca', 'add_artifact',
  '{"kind":"report","title":"Alice secret report","mime":"text/plain","content":"Alice private findings"}') ->> 'artifact_id');
select pg_temp.w('a', pg_temp.id('aj'), 'ca', 'run_finished', jsonb_build_object('run_id', pg_temp.id('arun'),
  'status', 'completed', 'native_session_id', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'native_session_kind', 'claude_session'));
select pg_temp.w('a', pg_temp.id('aj'), 'ca', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'proposal', 'body', 'Alice private plan text', 'run_id', pg_temp.id('arun')));
reset role;
select pg_temp.put('adchat', pg_temp.default_chat(pg_temp.id('aroom')));
select pg_temp.put('aj_event', (select id from public.chat_events where job_id = pg_temp.id('aj') and author_kind = 'agent' limit 1));
select pg_temp.put('ghostchoice', 'tlchc_' || repeat('0', 32));
select pg_temp.put('ghostrun', 'tlarn_' || repeat('0', 32));
select pg_temp.put('ghostjob', 'tljob_' || repeat('0', 32));
select pg_temp.put('ghostchat', 'tlcht_' || repeat('0', 32));

-- ===========================================================================
-- 1. Privileges and RLS on the new tables and RPCs
-- ===========================================================================
select ok((select bool_and(relrowsecurity) from pg_class
           where oid in ('public.agent_runs'::regclass, 'public.user_choices'::regclass,
                         'public.chat_artifacts'::regclass, 'public.agent_providers'::regclass)),
  'RLS is on for every new table');
select is((select count(*)::int
           from unnest(array['public.agent_runs', 'public.user_choices', 'public.chat_artifacts', 'public.agent_providers']) t(tab)
           cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
           where has_table_privilege('authenticated', t.tab, p.priv) or has_table_privilege('anon', t.tab, p.priv)), 0,
  'no client role can write runs, choices, artifacts or the registry');
select ok(not has_table_privilege('anon', 'public.agent_runs', 'select')
          and not has_table_privilege('anon', 'public.user_choices', 'select')
          and not has_table_privilege('anon', 'public.chat_artifacts', 'select'),
  'anon reads none of them');
select ok(not has_column_privilege('authenticated', 'public.agent_runs', 'native_session_id', 'select'),
  'the native session id is not a readable column');
select is((select count(*)::int from unnest(array[
    'public.decide_choice(text, text)', 'public.control_job(text, text)',
    'public.add_chat_attachment(text, text, text, text)', 'public.delete_chat_artifact(text)',
    'public.reveal_run_native_session(text)', 'public.mark_chat_read_seq(text, bigint)',
    'public.chat_list_extras_v2(text[])', 'public.search_my_chats(text, integer)',
    'public.chat_host_status(text)']) f
  where has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')), 9,
  'every owner RPC is for the signed-in owner only');
select is((select count(*)::int from unnest(array[
    'threadlink_private.tj_run(text, text, text, text[])', 'threadlink_private.v10_backfill()',
    'threadlink_private.chat_card(public.team_jobs, text, public.agent_runs, text, text, text, jsonb, text, text, text)',
    'threadlink_private.job_summary_payload(public.team_jobs)', 'threadlink_private.choice_options(text, jsonb)',
    'threadlink_private.connection_protocol(text)', 'threadlink_private.require_owner()']) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')), 0,
  'private helpers are not callable by any client role');

-- ===========================================================================
-- 2. Bob and Alice's things: invisible, and "not found" everywhere
-- ===========================================================================
select pg_temp.act_as_user('user_V10SecBob00001');
select is((select count(*)::int from public.agent_runs where owner_user_id <> (select id from public.users where clerk_user_id = 'user_V10SecBob00001')), 0,
  'Bob reads none of Alice''s runs');
select is((select count(*)::int from public.agent_runs where id = pg_temp.id('arun')), 0, '...not even by id');
select is((select count(*)::int from public.user_choices where id = pg_temp.id('achoice')), 0, 'nor her choices');
select is((select count(*)::int from public.chat_artifacts where id = pg_temp.id('aart')), 0, 'nor her artifacts');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('achoice'))),
  pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('ghostchoice'))),
  'decide_choice: Alice''s choice = a missing choice');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('achoice'))),
  'P0002:choice_not_found', '...which is "not found"');
select is(pg_temp.fails(format($q$ select public.control_job(%L, 'stop_now') $q$, pg_temp.id('aj'))),
  pg_temp.fails(format($q$ select public.control_job(%L, 'stop_now') $q$, pg_temp.id('ghostjob'))),
  'control_job: Alice''s job = a missing job');
select is(pg_temp.fails(format($q$ select public.control_job(%L, 'stop_now') $q$, pg_temp.id('aj'))),
  'P0002:job_not_found', '...which is "not found"');
select is(pg_temp.fails(format($q$ select public.reveal_run_native_session(%L) $q$, pg_temp.id('arun'))),
  pg_temp.fails(format($q$ select public.reveal_run_native_session(%L) $q$, pg_temp.id('ghostrun'))),
  'reveal: Alice''s run = a missing run');
select is(pg_temp.fails(format($q$ select public.add_chat_attachment(%L, 'x', 'y', 'text/plain') $q$, pg_temp.id('adchat'))),
  'P0002:chat_not_found', 'Bob cannot attach to Alice''s chat');
select is(pg_temp.fails(format($q$ select public.delete_chat_artifact(%L) $q$, pg_temp.id('aart'))),
  'P0002:artifact_not_found', 'nor delete her artifact');
select is(pg_temp.fails(format($q$ select public.chat_host_status(%L) $q$, pg_temp.id('adchat'))),
  pg_temp.fails(format($q$ select public.chat_host_status(%L) $q$, pg_temp.id('ghostchat'))),
  'host status: Alice''s chat = a missing chat');
select is(pg_temp.fails(format($q$ select public.mark_chat_read_seq(%L, 5) $q$, pg_temp.id('adchat'))),
  'P0002:chat_not_found', 'nor move her read cursor');
select is((select count(*)::int from public.chat_list_extras_v2(array[pg_temp.id('adchat')])), 0,
  'chat_list_extras_v2 returns nothing for Alice''s chat id');
select is((select count(*)::int from public.search_my_chats('Alice private')), 0, 'search never finds Alice''s messages');
select is((select count(*)::int from public.search_my_chats('Alice secret')), 0, '...nor her artifacts');
select is((select count(*)::int from public.search_my_chats('Alice project')), 0, '...nor her project');
reset role;
select is((select status from public.user_choices where id = pg_temp.id('achoice')), 'pending', 'Alice''s choice is untouched');
select is((select control from public.team_jobs where id = pg_temp.id('aj')), null, 'Alice''s job has no control');

-- ===========================================================================
-- 3. Forged run ids on Runtime writes
-- ===========================================================================
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'proposal', 'body', 'x', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('arun2'))), '22023:invalid_run',
  'add_message: a run of another job is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'codex',
  'type', 'review', 'body', 'x', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('arun'))), '22023:invalid_run',
  'add_message: a run of another provider is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'proposal', 'body', 'x', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('brun'))), '22023:invalid_run',
  'add_message: another account''s run is refused (and indistinguishable)');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'proposal', 'body', 'x', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('ghostrun'))), '22023:invalid_run',
  '...exactly like a run that does not exist');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message',
  '{"sender":"claude-code","type":"proposal","body":"runless"}') $q$, pg_temp.id('aj'))), '22023:run_required',
  'a protocol-10 Runtime cannot write a runless agent message');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'threadlink',
  'type', 'handoff', 'body', 'x', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('arun'))), '22023:invalid_run',
  'orchestrator text never carries a run');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_finding', jsonb_build_object('severity', 'blocking',
  'category', 'security', 'title', 't', 'body', 'b', 'raised_by', 'codex', 'run_id', %L)) $q$,
  pg_temp.id('aj'), pg_temp.id('arun2'))), '22023:invalid_run', 'add_finding: a run of another job is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_decision', jsonb_build_object('title', 'T',
  'title_source', 'agent', 'run_id', %L)) $q$, pg_temp.id('aj'), pg_temp.id('brun'))), '22023:invalid_run',
  'add_decision: another account''s run is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed')) $q$, pg_temp.id('aj'), pg_temp.id('arun2'))), '22023:invalid_run',
  'run_finished: a run of another job is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'run_activity', jsonb_build_object('run_id', %L,
  'activity', 'building')) $q$, pg_temp.id('aj'), pg_temp.id('brun'))), '22023:invalid_run',
  'run_activity: another account''s run is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_change', jsonb_build_object('run_id', %L,
  'files_changed', 1, 'insertions', 1, 'deletions', 0)) $q$, pg_temp.id('aj'), pg_temp.id('brun'))), '22023:invalid_run',
  'add_change: another account''s run is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'read_owner_notes', jsonb_build_object('run_id', %L)) $q$,
  pg_temp.id('aj'), pg_temp.id('arun2'))), '22023:invalid_run', 'read_owner_notes: a run of another job is refused');
-- Bob's Runtime cannot write Alice's job at all.
select is(pg_temp.fails(format($q$ select pg_temp.w('b', %L, 'cb', 'run_started', '{"run_key":"x","provider":"codex",
  "participant_key":"codex:builder","role":"builder"}') $q$, pg_temp.id('aj'))), 'P0002:',
  'another account''s Runtime cannot start a run in the job');
-- Replies and references never leave the job.
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'add_message', jsonb_build_object('sender', 'claude-code',
  'type', 'proposal', 'body', 'x', 'run_id', %L, 'ref_kind', 'artifact', 'ref_id', %L)) $q$,
  pg_temp.id('aj2'), pg_temp.id('arun2'), pg_temp.id('aart'))), '55000:',
  'a job''s Runtime claim is per job (the carrier claim decides first)');
select is(pg_temp.fails(format($q$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('aagent'), %L, 'ca2', 'add_message',
  jsonb_build_object('sender', 'claude-code', 'type', 'proposal', 'body', 'x', 'run_id', %L, 'ref_kind', 'artifact',
  'ref_id', %L)) $q$, pg_temp.id('aj2'), pg_temp.id('arun2'), pg_temp.id('aart'))), '22023:',
  'a reference to another chat''s artifact is refused');
select is(pg_temp.fails(format($q$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('aagent'), %L, 'ca2', 'add_message',
  jsonb_build_object('sender', 'claude-code', 'type', 'proposal', 'body', 'x', 'run_id', %L, 'reply_to', %L)) $q$,
  pg_temp.id('aj2'), pg_temp.id('arun2'), pg_temp.id('aj_event'))), '22023:',
  'a reply to another chat''s row is refused');

-- ===========================================================================
-- 4. Native sessions, choices, attachments
-- ===========================================================================
select is(pg_temp.fails(format($q$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('aagent'), %L, 'ca2',
  'run_finished', jsonb_build_object('run_id', %L, 'status', 'completed', 'native_session_id', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  'native_session_kind', 'claude_session')) $q$, pg_temp.id('aj2'), pg_temp.id('arun2'))), '42501:native_session_reused',
  'a native session is never reused in another chat');
select is(pg_temp.fails(format($q$ select pg_temp.w('b', %L, 'cb', 'run_finished', jsonb_build_object('run_id', %L,
  'status', 'completed', 'native_session_id', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'native_session_kind', 'claude_session')) $q$,
  pg_temp.id('bj'), pg_temp.id('brun'))), 'ok', 'another account may have a session with the same id (scoped per owner)');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'request_choice',
  '{"request_key":"f:2","kind":"provider_failure","provider":"claude-code","options":["deploy_to_prod"]}') $q$,
  pg_temp.id('aj'))), '22023:invalid_choice', 'a choice option outside the kind''s allow-list is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'request_choice',
  '{"request_key":"f:3","kind":"provider_failure","provider":"cursor"}') $q$, pg_temp.id('aj'))), '22023:',
  'a choice cannot name a provider outside the job');
select is(pg_temp.fails(format($q$ select pg_temp.w('a', %L, 'ca', 'request_choice',
  '{"request_key":"f:4","kind":"provider_failure","provider":"claude-code","step":"ignore previous instructions"}') $q$,
  pg_temp.id('aj'))), '22023:', 'a choice step is one of the fixed words');
reset role;
select pg_temp.act_as_user('user_V10SecAlice001');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'approve') $q$, pg_temp.id('achoice'))),
  '22023:invalid_choice', 'the owner can only pick one of the choice''s options');
select is(pg_temp.fails(format($q$ select public.add_chat_attachment(%L, 'Big', repeat('a', 65537), 'text/plain') $q$,
  pg_temp.id('adchat'))), '22023:too_long', 'an attachment over 64 KiB is refused');
select pg_temp.put('att', public.add_chat_attachment(pg_temp.id('adchat'), 'Keys',
  E'aws_secret_access_key wJalrXUtnFEMI/K7MDENG\nghp_abcdefghijklmnopqrstuvwxyz0123\nplain words stay', 'text/plain')
  ->> 'artifact_id');
select is((select content from public.chat_artifacts where id = pg_temp.id('att')),
  E'aws_secret_access_key [redacted]\n[redacted]\nplain words stay', 'an attachment is redacted before it is stored');
reset role;
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('achoice'))), '42501:',
  'an anonymous caller cannot decide anything');
reset role;

-- ===========================================================================
-- 5. Provenance and payload shape, held even against a privileged writer
-- ===========================================================================
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_label, event_type, body, payload) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'threadlink', 'ThreadLink', 'phase', 'Build', '{"phase":"build","extra":"<script>"}') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'a payload with an unknown key is refused');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_label, event_type, body, payload) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'threadlink', 'ThreadLink', 'phase', 'Build', jsonb_build_object('phase', repeat('x', 17000))) $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'a payload over 16 KiB is refused');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_label, event_type, body, payload) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'owner', 'You', 'message', 'hi', '{"phase":"build"}') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'a message carries no payload');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_provider, author_label, event_type, body) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'agent', 'codex', 'Codex', 'phase', 'Build') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'an agent can never write a ThreadLink phase');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_provider, author_label, event_type, body) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'agent', 'codex', 'Codex', 'code_change', 'Changed 1 file') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'an agent card always names its run');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_provider, author_label, event_type, body) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'agent', 'not-a-provider', 'X', 'agent_message', 'hi') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23503:',
  'an agent row names a registered provider');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, room_id, agent_session_id,
  author_kind, author_label, audience, event_type, body) values ((select owner_user_id from public.chats where id = %L),
  %L, %L, %L, 'owner', 'You', 'mallory', 'message', 'hi') $q$,
  pg_temp.id('adchat'), pg_temp.id('adchat'), pg_temp.id('aroom'), pg_temp.id('aagent'))), '23514:',
  'an audience is team or a registered provider');
select is(pg_temp.fails(format($q$ update public.chat_events set chat_seq = 999 where job_id = %L $q$, pg_temp.id('aj'))),
  '42501:', 'chat_seq is append-only');
select is(pg_temp.fails(format($q$ update public.agent_runs set provider = 'codex' where id = %L $q$, pg_temp.id('arun'))),
  '42501:', 'a run''s identity is immutable');
select is(pg_temp.fails(format($q$ update public.user_choices set options = '[{"key":"approve","label":"Approve"}]'
  where id = %L $q$, pg_temp.id('achoice'))), '42501:', 'a choice is fixed once asked');

-- ===========================================================================
-- 6. Security review fixes
-- ===========================================================================
-- I4: credentials assigned by name, in env / shell / YAML / JSON forms.
select is(threadlink_private.redact_text('DB_PASS=hunter2'), 'DB_PASS=[redacted]', 'DB_PASS=... is redacted');
select is(threadlink_private.redact_text('export MY_CREDS=abc123'), 'export MY_CREDS=[redacted]', 'export X_CREDS=...');
select is(threadlink_private.redact_text('STRIPE_KEY: live_abc'), 'STRIPE_KEY: [redacted]', 'YAML KEY: ...');
select is(threadlink_private.redact_text('{"db_pass": "s3cret"}'), '{"db_pass": [redacted]', 'JSON "db_pass": ...');
select is(threadlink_private.redact_text('credentials = abc'), 'credentials = [redacted]', 'credentials = ...');
select is(threadlink_private.redact_text('pass: letmein'), 'pass: [redacted]', 'pass: ...');
select is(threadlink_private.redact_text('password: correct horse'), 'password: [redacted]', 'password: ... still');
select is(threadlink_private.redact_text(E'The keyboard: nice
passing: 3
monkey business'),
  E'The keyboard: nice\npassing: 3\nmonkey business', 'prose is left alone');

-- M5: search is rate-limited per owner.
select pg_temp.act_as_user('user_V10SecBob00001');
select ok((select count(*) from generate_series(1, 35) g
           cross join lateral (select pg_temp.fails(format('select * from public.search_my_chats(%L)', 'Bob goal ' || g)) as r) x
           where x.r = '54000:rate_limited') > 0, 'more than 30 searches a minute are refused');
reset role;

-- I1: a Runtime posts or starts work only in projects that run on itself.
select pg_temp.act_as_user('user_V10SecAlice001');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a2-rt'), 'tlc_v1sar2');
reset role;
select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a2-rt'), 'Alice laptop', 'macos', 'desktop', '0.10.0', 10);
select is(pg_temp.fails(format($q$ select public.runtime_post_chat_message(pg_temp.h('a2-rt'), %L, 'hello', null, 'desktop') $q$,
  pg_temp.id('adchat'))), '42501:other_computer', 'another computer of the owner cannot post into this project''s chat');
select is(pg_temp.fails(format($q$ select public.runtime_create_chat(pg_temp.h('a2-rt'), 'x', %L, null) $q$,
  pg_temp.id('aroom'))), '42501:other_computer', '...nor create a chat in it');
select ok(public.runtime_create_chat(pg_temp.h('a-rt'), 'From its own computer', pg_temp.id('aroom'), null) is not null,
  'the project''s own computer can');
reset role;

-- A lease that lapsed during a long step, taken back by the SAME claim, is not
-- a crash: the job keeps running (seen for real on a slow machine).
select pg_temp.put('aj2_task', (pg_temp.job(pg_temp.id('aj2'))).task_id);
update public.tasks set claimed_until = now() - interval '1 second' where id = pg_temp.id('aj2_task');
update public.tasks set status = 'queued', claim_ref = null where id = pg_temp.id('aj2_task');
select pg_temp.act_as_client();
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('aagent'), pg_temp.id('aj2_task'), 'ca2');
reset role;
select isnt((pg_temp.job(pg_temp.id('aj2'))).status, 'interrupted',
  'the same claim taking its own job back does not interrupt it');
select is((select count(*)::int from public.user_choices
           where job_id = pg_temp.id('aj2') and kind = 'interrupted'), 0, 'and asks the owner nothing');

-- I3: a carrier re-claimed by a DIFFERENT claim while write work had started is interrupted.
-- The lease ran out, so the task goes back to the queue.
update public.tasks set claimed_until = now() - interval '1 second' where id = pg_temp.id('aj2_task');
update public.tasks set status = 'queued', claim_ref = null where id = pg_temp.id('aj2_task');
select pg_temp.act_as_client();
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('aagent'), pg_temp.id('aj2_task'), 'ca2-again');
reset role;
select is((pg_temp.job(pg_temp.id('aj2'))).status, 'interrupted', 'the job is interrupted');
select is((select status from public.agent_runs where id = pg_temp.id('arun2')), 'interrupted',
  'what was running is marked interrupted');
select pg_temp.put('rechoice', (select id from public.user_choices
                                where job_id = pg_temp.id('aj2') and kind = 'interrupted'));
select ok(pg_temp.id('rechoice') is not null, 'the owner is asked what to do');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('aagent'), %L, 'ca2-again',
  'run_started', '{"run_key":"build:1","provider":"claude-code","participant_key":"claude-code:builder","role":"builder"}') $q$,
  pg_temp.id('aj2'))), '55000:interrupted_needs_owner', 'no write run starts before the owner answers');
reset role;
select pg_temp.act_as_user('user_V10SecAlice001');
select public.decide_choice(pg_temp.id('rechoice'), 'resume');
reset role;
select pg_temp.act_as_client();
select ok(public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('aagent'), pg_temp.id('aj2'), 'ca2-again', 'run_started',
  '{"run_key":"build:1","provider":"claude-code","participant_key":"claude-code:builder","role":"builder"}')
  #>> '{result,run_id}' is not null, 'after "Resume" write work may start again');
reset role;

-- M12: decisions and controls never reach a deleted chat.
update public.chats set deleted_at = now() where id = pg_temp.id('adchat');
select pg_temp.act_as_user('user_V10SecAlice001');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'stop') $q$, pg_temp.id('achoice'))),
  'P0002:choice_not_found', 'a choice of a deleted chat is not found');
select is(pg_temp.fails(format($q$ select public.control_job(%L, 'stop_now') $q$, pg_temp.id('aj'))),
  'P0002:job_not_found', 'a job of a deleted chat is not found');
reset role;

select * from finish();
rollback;
