-- ThreadLink 0.11 (pgTAP): execution lanes, the protocol gate, stop with both
-- lanes, notes only to work, the failover-aware health gate, owner settings,
-- start_work / usage_exhausted choices and natural answers, the 0.11
-- team_job_write ops (read_chat_context, failover_notice + dedupe, Fast Chat
-- set_status, REVIEW_PENDING, the PASS review check, session reasons,
-- timings, same-chat session reuse), work-as-liveness, presence v2, the wake
-- count, and cross-account denial for every new entry point.
-- LOCAL stack only. Adversarial.

begin;

create extension if not exists pgtap with schema extensions;

select plan(165);

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
create function pg_temp.doc(p text, health text default 'ready', resets text default null) returns jsonb
language sql as $$
  select jsonb_build_object('installed', true, 'authenticated', true,
    'authMethod', case p when 'claude-code' then 'claude.ai' else 'chatgpt' end, 'health', health,
    'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || case when resets is null then '{}'::jsonb else jsonb_build_object('resetsAt', resets) end
$$;
create function pg_temp.q(p_sql text) returns text language plpgsql security definer as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$$;
create function pg_temp.x(p_sql text) returns void language plpgsql security definer as $$
begin
  execute p_sql;
end;
$$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.ev(e text) returns public.chat_events language sql security definer as $$
  select * from public.chat_events where id = e $$;
create function pg_temp.carrier(jid text) returns jsonb language sql security definer as $$
  select t.content::jsonb from public.tasks t join public.team_jobs x on x.task_id = t.id where x.id = jid $$;
create function pg_temp.rt(seed text) returns public.runtimes language sql security definer as $$
  select r.* from public.runtimes r join public.connection_credentials k on k.connection_id = r.connection_id
  where k.token_hash = threadlink_private.credential_digest(pg_temp.h(seed)) $$;
create function pg_temp.post(chat text, body text, lane text, reason text default null,
                             choice text default null, ckey text default null) returns jsonb
language sql as $$ select public.post_chat_message(chat, body, null, lane, reason, choice, ckey) $$;
-- The agent session a job's carrier targets (the project's own worker).
create function pg_temp.sess_of(j text) returns text language sql security definer as $$
  select t.target_session_id from public.tasks t join public.team_jobs x on x.task_id = t.id where x.id = j $$;
create function pg_temp.claim(j text, claim text, sess text default null) returns jsonb language sql as $$
  select public.claim_task(pg_temp.h('a-rt'), coalesce(pg_temp.id(sess), pg_temp.sess_of(j)), (pg_temp.job(j)).task_id, claim) $$;
create function pg_temp.w(j text, claim text, op text, payload jsonb, sess text default null) returns jsonb
language sql as $$
  select public.team_job_write(pg_temp.h('a-rt'), coalesce(pg_temp.id(sess), pg_temp.sess_of(j)), j, claim, op, payload) $$;
create function pg_temp.wr(j text, claim text, op text, payload jsonb, sess text default null) returns jsonb
language sql as $$ select pg_temp.w(j, claim, op, payload, sess) -> 'result' $$;
create function pg_temp.run_start(j text, claim text, rkey text, p text, role text, extra jsonb default '{}',
                                  sess text default null)
returns text language sql as $$
  select pg_temp.wr(j, claim, 'run_started', jsonb_build_object('run_key', rkey, 'provider', p,
    'participant_key', p || ':' || role, 'role', role, 'requested_model', 'model-a', 'access', 'read-only')
    || extra, sess) ->> 'run_id'
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Alice: a controller, a 0.11 Runtime (protocol 11) with two agent
-- sessions and two projects, and a 0.10 Runtime (protocol 10) with a third
-- project. Bob: a controller, a 0.11 Runtime, a project and a chat.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_V11Alice000001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'Alice GPT', pg_temp.h('a-chat'), 'tlc_v11cht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_v11rt1');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-old'), 'tlc_v11rt2');
reset role;
select pg_temp.act_as_user('user_V11Bob00000001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob GPT', pg_temp.h('b-chat'), 'tlc_v11bch');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_v11brt');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('reg11', public.register_runtime(pg_temp.h('a-rt'), 'Nickron PC', 'windows', 'desktop', '0.11.0', 11)::text);
select pg_temp.put('reg10', public.register_runtime(pg_temp.h('a-old'), 'Old laptop', 'windows', 'desktop', '0.10.2', 10)::text);
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/p'), 'Prism', 'C:\p', null, null, null) ->> 'id');
select pg_temp.put('ws2', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/q'), 'Quartz', 'C:\q', null, null, null) ->> 'id');
select pg_temp.put('wso', public.upsert_runtime_workspace(pg_temp.h('a-old'), pg_temp.k('C:/o'), 'Old', 'C:\o', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.11.0', '{"claude-code":"available"}', '{}', 11);
select public.runtime_heartbeat(pg_temp.h('a-old'), '0.10.2', '{"claude-code":"available"}', '{}', 10);
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:p', 'Prism worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('agent2', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws2'),
  'cc:q', 'Quartz worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('agento', public.register_runtime_session(pg_temp.h('a-old'), pg_temp.id('wso'),
  'cc:o', 'Old worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('sess', public.register_session(pg_temp.h('a-chat'), null, null, 'v11-a') ->> 'id');
select pg_temp.put('sess2', public.register_session(pg_temp.h('a-chat'), null, null, 'v11-b') ->> 'id');
select pg_temp.put('sesso', public.register_session(pg_temp.h('a-chat'), null, null, 'v11-o') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));
select pg_temp.put('link2', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('sess2'), pg_temp.id('agent2')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent2'), pg_temp.id('link2'));
select pg_temp.put('linko', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('sesso'), pg_temp.id('agento')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-old'), pg_temp.id('agento'), pg_temp.id('linko'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select public.report_provider_detection(pg_temp.h('a-old'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-old'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('room', public.create_room(pg_temp.h('a-chat'), pg_temp.id('sess'), 'Prism', pg_temp.id('link')) ->> 'room_id');
select pg_temp.put('room2', public.create_room(pg_temp.h('a-chat'), pg_temp.id('sess2'), 'Quartz', pg_temp.id('link2')) ->> 'room_id');
select pg_temp.put('roomo', public.create_room(pg_temp.h('a-chat'), pg_temp.id('sesso'), 'Old', pg_temp.id('linko')) ->> 'room_id');

select public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'linux', 'desktop', '0.11.0', 11);
select pg_temp.put('bws', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/b'), 'B', '/b', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('b-rt'), '0.11.0', '{"claude-code":"available"}', '{}', 11);
select pg_temp.put('bagent', public.register_runtime_session(pg_temp.h('b-rt'), pg_temp.id('bws'),
  'cc:b', 'B worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('bsess', public.register_session(pg_temp.h('b-chat'), null, null, 'v11-bob') ->> 'id');
select pg_temp.put('blink', public.request_pairing(pg_temp.h('b-chat'), pg_temp.id('bsess'), pg_temp.id('bagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('blink'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('broom', public.create_room(pg_temp.h('b-chat'), pg_temp.id('bsess'), 'Bob project') ->> 'room_id');
reset role;

select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('c1', public.create_chat('Main', pg_temp.id('room')) ->> 'chat_id');
select pg_temp.put('c2', public.create_chat('Second', pg_temp.id('room')) ->> 'chat_id');
select pg_temp.put('c3', public.create_chat('Review pending', pg_temp.id('room2')) ->> 'chat_id');
select pg_temp.put('c4', public.create_chat('Pass check', pg_temp.id('room2')) ->> 'chat_id');
select pg_temp.put('co', public.create_chat('On the old laptop', pg_temp.id('roomo')) ->> 'chat_id');
reset role;
select pg_temp.act_as_user('user_V11Bob00000001');
select pg_temp.put('bc', public.create_chat('Bob chat', pg_temp.id('broom')) ->> 'chat_id');
reset role;

-- ===========================================================================
-- 1. Protocol: current 11, minimum stays 10
-- ===========================================================================
select is(threadlink_private.runtime_protocol_current(), 11, 'the current Runtime protocol is 11');
select is((pg_temp.id('reg10'))::jsonb ->> 'min_protocol', '10', 'the minimum protocol stays 10');
select is((pg_temp.id('reg10'))::jsonb ->> 'update_required', 'false', 'a 0.10 Runtime needs no update to keep working');
select is((pg_temp.id('reg10'))::jsonb ->> 'update_available', 'true', '...but it is told an update is available');
select is((pg_temp.id('reg11'))::jsonb ->> 'update_available', 'false', 'a 0.11 Runtime is current');

-- ===========================================================================
-- 2. Owner settings: failover policy
-- ===========================================================================
select pg_temp.act_as_user('user_V11Alice000001');
select is(public.get_my_settings() ->> 'failover_policy', 'auto', 'the failover policy defaults to auto');
select is(public.set_failover_policy('ask') ->> 'failover_policy', 'ask', 'the owner sets ask');
select is(pg_temp.fails($$ select public.set_failover_policy('never') $$), '22023:invalid', 'an unknown policy is refused');
select is((select count(*)::int from public.user_settings), 1, 'the owner reads her own settings row');
reset role;
select pg_temp.act_as_user('user_V11Bob00000001');
select is(public.get_my_settings() ->> 'failover_policy', 'auto', 'Bob still has the default: settings are per owner');
select is((select count(*)::int from public.user_settings), 0, 'RLS: Bob cannot read Alice''s settings');
select is(left(pg_temp.fails($$ insert into public.user_settings (owner_user_id, failover_policy) values ('user_V11Alice000001', 'wait') $$), 5),
  '42501', 'no client writes user_settings directly');
reset role;
select pg_temp.act_as_client();
select is(pg_temp.fails($$ select public.set_failover_policy('wait') $$), '42501:', 'anon cannot change settings');
reset role;
select pg_temp.act_as_user('user_V11Alice000001');
select public.set_failover_policy('auto');
reset role;

-- ===========================================================================
-- 3. Lane routing (owner, web)
-- ===========================================================================
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r1', pg_temp.post(pg_temp.id('c1'), 'hi team', 'chat', 'small_talk')::text);
reset role;
select is((pg_temp.id('r1'))::jsonb ->> 'routed', 'chat_job', 'a chat-lane message starts a Fast Chat job');
select pg_temp.put('cj1', (pg_temp.id('r1'))::jsonb ->> 'job_id');
select is((pg_temp.job(pg_temp.id('cj1'))).lane, 'chat', '...stored as lane chat');
select is((pg_temp.job(pg_temp.id('cj1'))).source_event_id, (pg_temp.id('r1'))::jsonb ->> 'event_id',
  '...answering the owner''s message');
select is((pg_temp.ev((pg_temp.id('r1'))::jsonb ->> 'event_id')).payload,
  '{"lane":"chat","laneReason":"small_talk"}'::jsonb, 'the owner row records lane and reason');
select is(pg_temp.carrier(pg_temp.id('cj1')) ->> 'lane', 'chat', 'the carrier says lane chat');
select is(pg_temp.carrier(pg_temp.id('cj1')) -> 'responders', '["claude-code","codex"]'::jsonb,
  'team mode: every enabled participant responds');
select is(pg_temp.carrier(pg_temp.id('cj1')) ->> 'sourceEventId', (pg_temp.id('r1'))::jsonb ->> 'event_id',
  'the carrier names the owner message');
select is(pg_temp.carrier(pg_temp.id('cj1')) ->> 'failoverPolicy', 'auto', 'the carrier carries the failover policy');
select is(pg_temp.q(format('select count(*) from public.chat_events where job_id = %L and author_kind = ''threadlink''',
  pg_temp.id('cj1'))), '0', 'a Fast Chat job writes no "job started" narration');

select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r2', pg_temp.post(pg_temp.id('c1'), 'fix the login bug', 'work', 'edit_requested')::text);
reset role;
select is((pg_temp.id('r2'))::jsonb ->> 'routed', 'new_job', 'a work message starts work while a Fast Chat job runs');
select pg_temp.put('wj1', (pg_temp.id('r2'))::jsonb ->> 'job_id');
select is((pg_temp.job(pg_temp.id('wj1'))).lane || '|' || (pg_temp.job(pg_temp.id('wj1'))).failover_policy, 'work|auto',
  'lane work, with the owner''s policy snapshotted');
select is(pg_temp.q(format('select count(*) from public.chat_events where job_id = %L and event_type = ''job_started''',
  pg_temp.id('wj1'))), '1', 'work still says "job started"');

select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r3', pg_temp.post(pg_temp.id('c1'), '@Claude what do you think about the plan?', 'chat', 'question')::text);
select pg_temp.put('r4', pg_temp.post(pg_temp.id('c1'), 'also run the tests', 'work', 'tests_requested')::text);
reset role;
select is((pg_temp.id('r3'))::jsonb ->> 'routed', 'chat_job', 'a question starts a Fast Chat job while work runs');
select is(pg_temp.carrier((pg_temp.id('r3'))::jsonb ->> 'job_id') -> 'responders', '["claude-code"]'::jsonb,
  'a mention: only that agent responds');
select is((pg_temp.id('r4'))::jsonb ->> 'routed' || '|' || ((pg_temp.id('r4'))::jsonb ->> 'job_id'),
  'note_to_active_job|' || pg_temp.id('wj1'), 'work while work runs: a note to the WORK job');
select is(pg_temp.q(format('select count(*) from public.team_jobs where chat_id = %L and finished_at is null',
  pg_temp.id('c1'))), '3', 'one work job and two Fast Chat jobs run in the chat');

-- Notes only go to work: with only a Fast Chat job running, work starts a job.
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r5', pg_temp.post(pg_temp.id('c2'), 'hello?', 'chat', 'small_talk')::text);
select pg_temp.put('r6', pg_temp.post(pg_temp.id('c2'), 'implement the export button', 'work', 'edit_requested')::text);
reset role;
select is((pg_temp.id('r6'))::jsonb ->> 'routed', 'new_job', 'a Fast Chat job never takes notes: work starts a job');
select pg_temp.put('wj2', (pg_temp.id('r6'))::jsonb ->> 'job_id');

-- Stop: the work job AND every Fast Chat job.
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r7', pg_temp.post(pg_temp.id('c1'), '@team stop', 'chat', null)::text);
reset role;
select is((pg_temp.id('r7'))::jsonb ->> 'routed', 'stop_requested', 'stop is a stop request in either lane');
select ok((pg_temp.job(pg_temp.id('wj1'))).stop_requested_at is not null, 'the work job is asked to stop');
select is(pg_temp.q(format('select count(*) from public.team_jobs where chat_id = %L and lane = ''chat''
  and finished_at is null and stop_requested_at is not null and control = ''stop_now''', pg_temp.id('c1'))), '2',
  '...and every running Fast Chat job is stopped now');
select is((pg_temp.id('r7'))::jsonb ->> 'chat_jobs_stopped', '2', 'the answer says how many replies were stopped');

-- The protocol gate: a 0.10 Runtime never receives Fast Chat work.
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r8', pg_temp.post(pg_temp.id('co'), 'what does this repo do?', 'chat', 'question')::text);
reset role;
select is((pg_temp.id('r8'))::jsonb ->> 'routed' || '|' || ((pg_temp.id('r8'))::jsonb ->> 'lane') || '|'
          || ((pg_temp.id('r8'))::jsonb ->> 'lane_reason'),
  'new_job|work|runtime_outdated', 'protocol < 11: chat is downgraded to work');
select is((pg_temp.ev((pg_temp.id('r8'))::jsonb ->> 'event_id')).payload ->> 'laneReason', 'runtime_outdated',
  '...and the owner row says why');
select is(pg_temp.carrier((pg_temp.id('r8'))::jsonb ->> 'job_id') ->> 'lane', 'work', '...the carrier is work');

-- Input validation.
select pg_temp.act_as_user('user_V11Alice000001');
select is(pg_temp.fails(format($q$ select pg_temp.post(%L, 'x', 'fast') $q$, pg_temp.id('c2'))), '22023:invalid',
  'an unknown lane is refused');
select is(pg_temp.fails(format($q$ select pg_temp.post(%L, 'x', 'chat', 'because') $q$, pg_temp.id('c2'))), '22023:invalid',
  'an unknown lane reason is refused');
select is(pg_temp.fails(format($q$ select pg_temp.post(%L, 'x', 'chat', null, 'tlchc_%s', null) $q$, pg_temp.id('c2'), repeat('0', 32))),
  '22023:invalid', 'a choice id without a key is refused');
reset role;

-- ===========================================================================
-- 4. The health gate with exhaustion (section 5)
-- ===========================================================================
select pg_temp.act_as_client();
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex', 'usage_exhausted', to_char((now() + interval '3 hours') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
reset role;
select ok(pg_temp.q(format($q$ select detected ->> 'resetsAt' from public.runtime_provider_health
  where runtime_id = %L and provider = 'codex' $q$, (pg_temp.rt('a-rt')).id)) is not null,
  'resetsAt within the sanity window is kept');
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r9', pg_temp.post(pg_temp.id('c3'), 'refactor the parser', 'work', 'edit_requested')::text);
reset role;
select is((pg_temp.id('r9'))::jsonb ->> 'routed', 'new_job', 'policy auto: one exhausted, one ready -> work starts (failover)');
select pg_temp.put('wj3', (pg_temp.id('r9'))::jsonb ->> 'job_id');
select pg_temp.act_as_user('user_V11Alice000001');
select public.set_failover_policy('ask');
select pg_temp.put('r10', pg_temp.post(pg_temp.id('c4'), 'refactor the lexer', 'work', 'edit_requested')::text);
select pg_temp.put('r11', pg_temp.post(pg_temp.id('c4'), 'why is the lexer slow?', 'chat', 'question')::text);
select public.set_failover_policy('auto');
select pg_temp.put('hs', public.chat_host_status(pg_temp.id('c4'))::text);
reset role;
select is((pg_temp.id('r10'))::jsonb ->> 'routed', 'new_job', 'policy ask: work starts so the Runtime can ask (the usage card)');
select is(pg_temp.q(format('select count(*) from public.chat_events where chat_id = %L and event_type = ''provider_blocked''',
  pg_temp.id('c4'))), '0', '...and nothing is refused at post time');
-- Finish that work job so the rest of this file sees c4 without running work.
update public.team_jobs set status = 'cancelled', finished_at = pg_catalog.now()
where id = (pg_temp.id('r10'))::jsonb ->> 'job_id';
select is((pg_temp.id('r11'))::jsonb ->> 'routed', 'chat_job', 'chat lane: a ready responder is enough');
select pg_temp.put('cj4', (pg_temp.id('r11'))::jsonb ->> 'job_id');
select ok((select a ->> 'resets_at' from jsonb_array_elements((pg_temp.id('hs'))::jsonb -> 'agents') a
           where a ->> 'provider' = 'codex') is not null, 'host status shows when Codex usage resets');
select pg_temp.act_as_client();
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex', 'usage_exhausted', to_char((now() + interval '30 days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
reset role;
select is(pg_temp.q(format($q$ select jsonb_typeof(detected -> 'resetsAt') from public.runtime_provider_health
  where runtime_id = %L and provider = 'codex' $q$, (pg_temp.rt('a-rt')).id)), 'null',
  'a reset time outside the sanity window is stored as null, never invented');
select pg_temp.act_as_client();
select is(pg_temp.fails($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex', 'usage_exhausted', 'tomorrow')) $$), '22023:', 'a malformed resetsAt is refused');
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code', 'usage_exhausted'));
reset role;
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r12', pg_temp.post(pg_temp.id('c4'), 'anyone there?', 'chat', 'question')::text);
reset role;
select is((pg_temp.id('r12'))::jsonb ->> 'routed', 'provider_blocked', 'nobody ready: even chat is blocked');
select pg_temp.act_as_client();
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
reset role;

-- ===========================================================================
-- 5. team_job_write: Fast Chat ops
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('cj4'), 'k-cj4', 'agent2');
select pg_temp.put('ctx', pg_temp.wr(pg_temp.id('cj4'), 'k-cj4', 'read_chat_context', '{"limit": 40}', 'agent2')::text);
reset role;
select is(jsonb_array_length((pg_temp.id('ctx'))::jsonb -> 'messages'), 3,
  'read_chat_context: this chat''s visible messages only (no ThreadLink rows)');
select is(((pg_temp.id('ctx'))::jsonb -> 'messages' -> -1 ->> 'body'), 'anyone there?', '...newest last');
select ok(not exists (select 1 from jsonb_array_elements((pg_temp.id('ctx'))::jsonb -> 'messages') m
                      where m ->> 'body' like '%parser%' or m ->> 'body' like '%login%'),
  '...nothing from other chats');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'read_chat_context', '{"limit": 41}', 'agent2') $q$, pg_temp.id('cj4'))),
  '22023:', 'read_chat_context is capped at 40');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'set_plan', '{"plan": {}}', 'agent2') $q$, pg_temp.id('cj4'))),
  '22023:chat_lane', 'a Fast Chat job has no plan');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'set_final', '{"verdict":"PASS","evidence":{}}', 'agent2') $q$, pg_temp.id('cj4'))),
  '22023:chat_lane', '...and no verdict');
select pg_temp.put('run1', pg_temp.run_start(pg_temp.id('cj4'), 'k-cj4', 'fc:1:claude', 'claude-code', 'investigator',
  '{"session_reason":"fresh_first_turn"}', 'agent2'));
select pg_temp.wr(pg_temp.id('cj4'), 'k-cj4', 'run_finished', jsonb_build_object('run_id', pg_temp.id('run1'),
  'status', 'completed', 'observed_model', 'claude-sonnet', 'model_verified', true, 'access_verified', true,
  'native_session_id', '11111111-2222-3333-4444-555555555555', 'native_session_kind', 'claude_session',
  'timings', '{"queueMs": 420, "providerMs": 5100, "persistMs": 12}'::jsonb), 'agent2');
reset role;
select is(pg_temp.q(format('select session_reason from public.agent_runs where id = %L', pg_temp.id('run1'))),
  'fresh_first_turn', 'run_started stores the session reason');
select is(pg_temp.q(format('select timings::text from public.agent_runs where id = %L', pg_temp.id('run1')))::jsonb,
  '{"queueMs": 420, "providerMs": 5100, "persistMs": 12}'::jsonb, 'run_finished stores the timings');
select pg_temp.act_as_client();
select pg_temp.put('run1b', pg_temp.run_start(pg_temp.id('cj4'), 'k-cj4', 'fc:1:codex', 'codex', 'investigator', '{}', 'agent2'));
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'run_finished',
  '{"run_id": "%s", "status": "completed", "timings": {"queueMs": -1}}') $q$, pg_temp.id('cj4'), pg_temp.id('run1b'))),
  '22023:', 'a negative timing is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'run_finished',
  '{"run_id": "%s", "status": "completed", "timings": {"queueMs": 86400001}}') $q$, pg_temp.id('cj4'), pg_temp.id('run1b'))),
  '22023:', 'a timing over 24 h is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'run_started',
  '{"run_key":"x1","provider":"codex","participant_key":"codex:investigator","role":"investigator","session_reason":"because"}') $q$,
  pg_temp.id('cj4'))), '22023:', 'an unknown session reason is refused');

-- start_work: the escalation choice survives the Fast Chat job finishing.
select pg_temp.put('sw', pg_temp.wr(pg_temp.id('cj4'), 'k-cj4', 'request_choice', jsonb_build_object(
  'request_key', 'fc:needs-work', 'kind', 'start_work', 'source_event_id', (pg_temp.id('r11'))::jsonb ->> 'event_id'), 'agent2')
  ->> 'choice_id');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'request_choice',
  '{"request_key":"fc:bad","kind":"start_work","source_event_id":"%s"}') $q$, pg_temp.id('cj4'),
  (pg_temp.id('r2'))::jsonb ->> 'event_id')), '22023:', 'start_work must name an owner message of THIS chat');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'request_choice',
  '{"request_key":"fc:mig","kind":"migration"}') $q$, pg_temp.id('cj4'))), '22023:chat_lane',
  'a Fast Chat job cannot ask for approvals');
reset role;
select is((pg_temp.job(pg_temp.id('cj4'))).status, 'queued', 'asking "run as work?" does not pause a Fast Chat job');
select is(pg_temp.q(format('select options::text from public.user_choices where id = %L', pg_temp.id('sw')))::jsonb,
  '[{"key":"run_work","label":"Run this as work"},{"key":"keep_chatting","label":"Keep chatting"}]'::jsonb,
  'start_work offers Run this as work / Keep chatting');
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('cj4'), 'k-cj4', 'set_status', '{"status":"completed"}', 'agent2');
reset role;
select is((pg_temp.job(pg_temp.id('cj4'))).status || '|' || coalesce((pg_temp.job(pg_temp.id('cj4'))).verdict, 'none'),
  'completed|none', 'a Fast Chat job completes without a verdict');
select is(pg_temp.q(format('select status from public.user_choices where id = %L', pg_temp.id('sw'))), 'pending',
  'the start_work choice outlives the finished Fast Chat job');
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj4', 'set_status', '{"status":"failed"}', 'agent2') $q$, pg_temp.id('cj4'))),
  '55000:', 'a finished Fast Chat job takes no more writes');
reset role;

-- Bob can neither see nor answer it.
select pg_temp.act_as_user('user_V11Bob00000001');
select is(pg_temp.fails(format($q$ select public.decide_choice(%L, 'run_work') $q$, pg_temp.id('sw'))), 'P0002:choice_not_found',
  'another account''s choice is not found');
select is(pg_temp.fails(format($q$ select public.chat_compose_context(%L) $q$, pg_temp.id('c4'))), 'P0002:chat_not_found',
  'another account''s compose context is not found');
select pg_temp.put('bpost', pg_temp.post(pg_temp.id('bc'), 'run it', 'chat', 'continuation', pg_temp.id('sw'), 'run_work')::text);
reset role;
select is((pg_temp.id('bpost'))::jsonb ->> 'routed', 'chat_job', 'Bob naming Alice''s choice just routes his own message');
select is(pg_temp.q(format('select status from public.user_choices where id = %L', pg_temp.id('sw'))), 'pending',
  '...and Alice''s choice is untouched');

-- Alice answers naturally: "run it" -> run_work starts WORK from the original message.
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('ctxa', public.chat_compose_context(pg_temp.id('c4'))::text);
select pg_temp.put('r13', pg_temp.post(pg_temp.id('c4'), 'go ahead', 'chat', 'continuation', pg_temp.id('sw'), 'run_work')::text);
reset role;
select is((pg_temp.id('ctxa'))::jsonb -> 'choices' -> 0 ->> 'choice_id', pg_temp.id('sw'), 'compose context lists the open choice');
select is((pg_temp.id('ctxa'))::jsonb ->> 'active_work_job', 'false', '...and whether work is running');
select is((pg_temp.id('r13'))::jsonb ->> 'routed' || '|' || ((pg_temp.id('r13'))::jsonb ->> 'chosen_label'),
  'choice_resolved|Run this as work', 'a natural answer resolves the choice');
select pg_temp.put('wj4', (pg_temp.id('r13'))::jsonb ->> 'job_id');
select is((pg_temp.job(pg_temp.id('wj4'))).lane || '|' || (pg_temp.job(pg_temp.id('wj4'))).goal, 'work|why is the lexer slow?',
  'run_work starts a work job whose goal is the original owner message');
select is((pg_temp.ev((pg_temp.id('r13'))::jsonb ->> 'event_id')).payload ->> 'choiceId', pg_temp.id('sw'),
  'the answer is stored as a message naming the choice');

-- ===========================================================================
-- 6. usage_exhausted, provider_failure without retry, approvals by card only
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('wj3'), 'k-wj3', 'agent2');
select pg_temp.put('ue', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'request_choice', jsonb_build_object(
  'request_key', 'ue:1', 'kind', 'usage_exhausted', 'provider', 'codex', 'other_provider', 'claude-code',
  'resets_at', to_char((now() + interval '2 hours') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'agent2')
  ->> 'choice_id');
select pg_temp.put('pf', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'request_choice',
  '{"request_key":"pf:1","kind":"provider_failure","provider":"codex","other_provider":"claude-code"}', 'agent2')
  ->> 'choice_id');
select pg_temp.put('pf2', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'request_choice',
  '{"request_key":"pf:2","kind":"provider_failure","provider":"codex","options":["retry"]}', 'agent2')
  ->> 'choice_id');
select pg_temp.put('mig', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'request_choice',
  '{"request_key":"mig:1","kind":"migration"}', 'agent2') ->> 'choice_id');
reset role;
select is(pg_temp.q(format('select options::text from public.user_choices where id = %L', pg_temp.id('ue')))::jsonb,
  '[{"key":"continue_other","label":"Continue with Claude"},{"key":"check_again","label":"Check Codex again"},
    {"key":"wait","label":"Wait for Codex"},{"key":"stop","label":"Stop"}]'::jsonb,
  'usage_exhausted: Continue with Claude / Check Codex again / Wait for Codex / Stop (no retry)');
select is(pg_temp.q(format('select title from public.user_choices where id = %L', pg_temp.id('ue'))),
  'Codex usage is exhausted. What should ThreadLink do?', 'a fixed title from the registry');
select ok(pg_temp.q(format('select params ->> ''resetsAt'' from public.user_choices where id = %L', pg_temp.id('ue'))) is not null,
  'the reset time the provider gave is kept on the choice');
select is(pg_temp.q(format('select string_agg(o ->> ''key'', '','') from public.user_choices, jsonb_array_elements(options) o where id = %L',
  pg_temp.id('pf'))), 'use_other,stop', 'provider_failure never offers retry for an exhausted provider');
select is(pg_temp.q(format('select string_agg(o ->> ''key'', '','') from public.user_choices, jsonb_array_elements(options) o where id = %L',
  pg_temp.id('pf2'))), 'stop', '...even when the Runtime asked only for retry');
select is((pg_temp.job(pg_temp.id('wj3'))).status, 'paused', 'a work job waits for the owner');

select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r14', pg_temp.post(pg_temp.id('c3'), '@Claude continue', 'chat', 'continuation', pg_temp.id('ue'), 'continue_other')::text);
select pg_temp.put('r15', pg_temp.post(pg_temp.id('c3'), 'approve', 'work', 'repo_action', pg_temp.id('mig'), 'approve')::text);
select is(pg_temp.fails(format($q$ select threadlink_private.choice_decide('user_V11Alice000001', %L, 'approve', null, true) $q$,
  pg_temp.id('mig'))), '42501:', 'no client may call the private decide path');
reset role;
select is((pg_temp.id('r14'))::jsonb ->> 'routed' || '|' || ((pg_temp.id('r14'))::jsonb ->> 'chosen_label'),
  'choice_resolved|Continue with Claude', '"@Claude continue" answers the usage choice');
select is(pg_temp.q(format('select chosen_key from public.user_choices where id = %L', pg_temp.id('ue'))), 'continue_other',
  '...recorded as continue_other');
select is(pg_temp.q(format('select count(*) from public.team_jobs where chat_id = %L', pg_temp.id('c3'))), '1',
  '...and no new job was started');
select is((pg_temp.id('r15'))::jsonb ->> 'routed', 'note_to_active_job', 'an approval is never answered by typing');
select is(pg_temp.q(format('select status from public.user_choices where id = %L', pg_temp.id('mig'))), 'pending',
  '...the approval stays open for its card');
select is(pg_temp.fails(format($q$ select threadlink_private.choice_decide(%L, %L, 'approve', null, true) $q$,
  pg_temp.q(format('select owner_user_id from public.user_choices where id = %L', pg_temp.id('mig'))), pg_temp.id('mig'))),
  '42501:choice_needs_card', 'the natural decide path refuses approval kinds');

-- ===========================================================================
-- 7. failover_notice, REVIEW_PENDING, the PASS review check
-- ===========================================================================
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj3', 'failover_notice',
  '{"from":"claude-code","to":"codex","review_pending":false}', 'agent2') $q$, pg_temp.id('wj3'))),
  '22023:not_exhausted', 'a failover notice for an agent that is not exhausted is refused');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj3', 'failover_notice',
  '{"from":"codex","to":"codex","review_pending":false}', 'agent2') $q$, pg_temp.id('wj3'))),
  '22023:', 'from and to must differ');
select pg_temp.put('fo1', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'failover_notice',
  '{"from":"codex","to":"claude-code","review_pending":true,"resets_at":null}', 'agent2')::text);
select pg_temp.put('fo2', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'failover_notice',
  '{"from":"codex","to":"claude-code","review_pending":true}', 'agent2')::text);
reset role;
select is((pg_temp.ev((pg_temp.id('fo1'))::jsonb ->> 'event_id')).body,
  'Codex usage is exhausted. Continuing with Claude. Independent review will wait for Codex.',
  'the failover notice is a fixed sentence from registry names');
select is((pg_temp.ev((pg_temp.id('fo1'))::jsonb ->> 'event_id')).event_type || '|'
          || (pg_temp.ev((pg_temp.id('fo1'))::jsonb ->> 'event_id')).author_kind || '|'
          || (pg_temp.ev((pg_temp.id('fo1'))::jsonb ->> 'event_id')).visibility,
  'failover|threadlink|visible', '...a visible ThreadLink failover row');
select is((pg_temp.id('fo2'))::jsonb ->> 'created' || '|' || ((pg_temp.id('fo2'))::jsonb ->> 'event_id'),
  'false|' || ((pg_temp.id('fo1'))::jsonb ->> 'event_id'), 'the same notice again is deduplicated');
-- Codex recovers and runs out again: a new exhaustion, a new notice.
select pg_temp.x(format($q$ update public.runtime_provider_health set health_changed_at = now() + interval '1 second'
  where runtime_id = %L and provider = 'codex' $q$, (pg_temp.rt('a-rt')).id));
select pg_temp.act_as_client();
select pg_temp.put('fo3', pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'failover_notice',
  '{"from":"codex","to":"claude-code","review_pending":true}', 'agent2')::text);
reset role;
select is((pg_temp.id('fo3'))::jsonb ->> 'created', 'true', 'after the health changed, a new notice is written');

select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('wj3'), 'k-wj3', 'set_final',
  '{"verdict":"REVIEW_PENDING","evidence":{"tests":[]},"reason":"usage_exhausted","provider":"codex"}', 'agent2');
reset role;
select is((pg_temp.job(pg_temp.id('wj3'))).status || '|' || (pg_temp.job(pg_temp.id('wj3'))).verdict,
  'review_pending|REVIEW_PENDING', 'REVIEW_PENDING: work complete, review pending (never PASS)');
select ok(pg_temp.q(format($q$ select body from public.chat_events where job_id = %L and event_type = 'job_verdict' $q$,
  pg_temp.id('wj3'))) like 'Result: Work complete · review pending%', 'the verdict row reads "Work complete · review pending"');
select ok(pg_temp.q(format($q$ select body from public.chat_events where job_id = %L and event_type = 'job_verdict' $q$,
  pg_temp.id('wj3'))) like '%Codex''s included usage ran out, so its independent review has not happened yet.%'
  and pg_temp.q(format($q$ select body from public.chat_events where job_id = %L and event_type = 'job_verdict' $q$,
  pg_temp.id('wj3'))) not like '%waits rather than switching%', '...and says the review has not happened, not that ThreadLink waited');
select ok(pg_temp.q(format($q$ select body from public.chat_events where job_id = %L and event_type = 'job_summary' $q$,
  pg_temp.id('wj3'))) like 'Summary: Work complete · review pending.%', '...and so does the summary');

-- PASS needs the independent review (protocol 11). wj4 runs in c4 (Quartz? no: Prism room2) as team.
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('wj4'), 'k-wj4', 'agent2');
select pg_temp.wr(pg_temp.id('wj4'), 'k-wj4', 'set_plan', '{"plan":{"units":["a"]},"approved_by":["claude-code","codex"]}', 'agent2');
select pg_temp.wr(pg_temp.id('wj4'), 'k-wj4', 'upsert_nodes',
  '{"nodes":[{"key":"a","title":"Unit a","owner_provider":"claude-code","reviewer_provider":"codex"}]}', 'agent2');
select pg_temp.wr(pg_temp.id('wj4'), 'k-wj4', 'set_node_status', '{"key":"a","status":"approved"}', 'agent2');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj4', 'set_final', '{"verdict":"PASS","evidence":{}}', 'agent2') $q$,
  pg_temp.id('wj4'))), '55000:review_missing', 'PASS is refused when the reviewer never reviewed');
select pg_temp.put('rv', pg_temp.run_start(pg_temp.id('wj4'), 'k-wj4', 'rv:1', 'codex', 'reviewer', '{}', 'agent2'));
select pg_temp.wr(pg_temp.id('wj4'), 'k-wj4', 'run_finished',
  jsonb_build_object('run_id', pg_temp.id('rv'), 'status', 'completed'), 'agent2');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj4', 'set_final', '{"verdict":"PASS","evidence":{}}', 'agent2') $q$,
  pg_temp.id('wj4'))), 'ok', '...and allowed once the reviewer''s run completed');
-- Only where review was required: a project without cross-review may still PASS.
select pg_temp.x(format($q$ update public.rooms set cross_review = false where id = %L $q$, pg_temp.id('room2')));
reset role;
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('wj5', pg_temp.post(pg_temp.id('c3'), 'implement the tokenizer', 'work', 'edit_requested') ->> 'job_id');
reset role;
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('wj5'), 'k-wj5');
select pg_temp.wr(pg_temp.id('wj5'), 'k-wj5', 'set_plan', '{"plan":{"units":["t"]},"approved_by":["claude-code","codex"]}');
select pg_temp.wr(pg_temp.id('wj5'), 'k-wj5', 'upsert_nodes',
  '{"nodes":[{"key":"t","title":"Unit t","owner_provider":"claude-code","reviewer_provider":"codex"}]}');
select pg_temp.wr(pg_temp.id('wj5'), 'k-wj5', 'set_node_status', '{"key":"t","status":"approved"}');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj5', 'set_final', '{"verdict":"PASS","evidence":{}}') $q$,
  pg_temp.id('wj5'))), 'ok', 'without cross-review (snapshotted on the job), PASS needs no reviewer run');
reset role;
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj1', 'set_final', '{"verdict":"REVIEW_PENDING","evidence":{}}') $q$,
  pg_temp.id('cj1'))), '55000:', 'set_final is claim-gated like every write');
reset role;

-- ===========================================================================
-- 8. Native sessions: reuse within one chat, never across chats
-- ===========================================================================
select pg_temp.act_as_user('user_V11Alice000001');
select pg_temp.put('r16', pg_temp.post(pg_temp.id('c4'), 'and what about the tokenizer?', 'chat', 'question')::text);
select pg_temp.put('r17', pg_temp.post(pg_temp.id('c2'), 'thoughts on naming?', 'chat', 'question')::text);
reset role;
select pg_temp.put('cj5', (pg_temp.id('r16'))::jsonb ->> 'job_id');
select pg_temp.put('cj6', (pg_temp.id('r17'))::jsonb ->> 'job_id');
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('cj5'), 'k-cj5', 'agent2');
select pg_temp.put('run5', pg_temp.run_start(pg_temp.id('cj5'), 'k-cj5', 'fc:5:claude', 'claude-code', 'investigator',
  '{"continuity":"resumed","session_reason":"resumed"}', 'agent2'));
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj5', 'run_finished', '{"run_id":"%s","status":"completed",
  "native_session_id":"11111111-2222-3333-4444-555555555555","native_session_kind":"claude_session"}', 'agent2') $q$,
  pg_temp.id('cj5'), pg_temp.id('run5'))), 'ok', 'a later job of the SAME chat may resume the chat''s native session');
reset role;
select is(pg_temp.q(format('select native_session_continuity || ''|'' || session_reason from public.agent_runs where id = %L',
  pg_temp.id('run5'))), 'resumed|resumed', '...recorded as resumed');
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('cj6'), 'k-cj6');
select pg_temp.put('run6', pg_temp.run_start(pg_temp.id('cj6'), 'k-cj6', 'fc:6:claude', 'claude-code', 'investigator'));
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-cj6', 'run_finished', '{"run_id":"%s","status":"completed",
  "native_session_id":"11111111-2222-3333-4444-555555555555","native_session_kind":"claude_session"}') $q$,
  pg_temp.id('cj6'), pg_temp.id('run6'))), '42501:native_session_reused', 'another chat can never reuse it');
reset role;

-- ===========================================================================
-- 9. Controller: Fast Chat while work runs; no notes, no choice answers
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('cc1', public.controller_post_chat_message(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('c2'),
  'what do you think about the export plan?', null, 'chat', 'question')::text);
select is(pg_temp.fails(format($q$ select public.controller_post_chat_message(pg_temp.h('a-chat'), %L, %L,
  'fix the export', null, 'work', 'edit_requested') $q$, pg_temp.id('sess'), pg_temp.id('c2'))), '55000:job_active',
  'a controller still cannot add work while work runs');
select is(pg_temp.fails(format($q$ select public.controller_post_chat_message(pg_temp.h('b-chat'), %L, %L,
  'hi', null, 'chat', null) $q$, pg_temp.id('bsess'), pg_temp.id('c2'))), 'P0002:chat_not_found',
  'another account''s controller cannot reach the chat');
reset role;
select is((pg_temp.job((pg_temp.id('cc1'))::jsonb ->> 'job_id')).lane, 'chat', 'a controller may ask a Fast Chat question while work runs');
select is(pg_temp.q(format($q$ select count(*) from public.chat_events where job_id = %L and author_kind = 'controller' $q$,
  (pg_temp.id('cc1'))::jsonb ->> 'job_id')), '1', '...with exactly one controller request row');
select is(pg_temp.carrier((pg_temp.id('cc1'))::jsonb ->> 'job_id') ->> 'sourceEventId',
  pg_temp.q(format($q$ select id from public.chat_events where job_id = %L and author_kind = 'controller' $q$,
    (pg_temp.id('cc1'))::jsonb ->> 'job_id')), '...which the carrier names');

-- ===========================================================================
-- 10. Runtime credential posts (desktop / terminal)
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('rp1', public.runtime_post_chat_message(pg_temp.h('a-rt'), pg_temp.id('c1'), 'hi again', null,
  'terminal', 'chat', 'small_talk', null, null)::text);
select is(pg_temp.fails(format($q$ select public.runtime_post_chat_message(pg_temp.h('b-rt'), %L, 'x', null, 'desktop',
  'chat', null, null, null) $q$, pg_temp.id('c1'))), 'P0002:chat_not_found', 'Bob''s Runtime cannot post into Alice''s chat');
select is(pg_temp.fails(format($q$ select public.runtime_chat_compose_context(pg_temp.h('b-rt'), %L) $q$, pg_temp.id('c1'))),
  'P0002:chat_not_found', '...nor read its compose context');
select is(pg_temp.fails(format($q$ select public.runtime_post_chat_message(pg_temp.h('a-old'), %L, 'x', null, 'desktop',
  'chat', null, null, null) $q$, pg_temp.id('c1'))), '42501:other_computer', 'only from the computer the project runs on');
reset role;
select is((pg_temp.id('rp1'))::jsonb ->> 'routed', 'chat_job', 'the terminal starts a Fast Chat job');
select is((pg_temp.ev((pg_temp.id('rp1'))::jsonb ->> 'event_id')).client, 'terminal', '...recording the client');

-- ===========================================================================
-- 11. Work is liveness, presence v2, the wake count
-- ===========================================================================
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '5 minutes' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select pg_temp.act_as_client();
select public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('c1'), null, null, 10, false);
reset role;
select ok((pg_temp.rt('a-rt')).last_seen_at < now() - interval '4 minutes', 'a chat read is not liveness');
select pg_temp.act_as_client();
select public.list_inbox(pg_temp.h('a-rt'), pg_temp.id('agent'), 5);
reset role;
select ok((pg_temp.rt('a-rt')).last_seen_at >= now() - interval '1 second', 'an inbox poll refreshes last_seen_at');
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '5 seconds' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('cj5'), 'k-cj5', 'read_chat_context', '{}', 'agent2');
reset role;
select ok((pg_temp.rt('a-rt')).last_seen_at <= now() - interval '4 seconds', '...throttled to once per 10 s');
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '20 seconds' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select pg_temp.act_as_client();
select pg_temp.wr(pg_temp.id('cj5'), 'k-cj5', 'read_chat_context', '{}', 'agent2');
reset role;
select ok((pg_temp.rt('a-rt')).last_seen_at >= now() - interval '1 second', 'a team_job_write refreshes it');

-- Presence (runs of a-rt: the reviewer and Fast Chat runs are finished; run6 and run1b still run).
select pg_temp.x(format($q$ update public.agent_runs set status = 'completed', finished_at = now() where runtime_id = %L
  and status in ('queued', 'running') $q$, (pg_temp.rt('a-rt')).id));
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '30 seconds' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'online', 'seen 30 s ago: online');
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '100 seconds' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'reconnecting', 'seen 100 s ago: reconnecting');
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '4 minutes' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'offline', 'seen 4 min ago, nothing running: offline');
select pg_temp.act_as_client();
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '4 minutes' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
reset role;
select pg_temp.put('run7', (select pg_temp.run_start(pg_temp.id('cj5'), 'k-cj5', 'fc:5:codex', 'codex', 'investigator', '{}', 'agent2')));
select pg_temp.x(format($q$ update public.runtimes set last_seen_at = now() - interval '4 minutes' where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'working',
  'a run with recent activity: working, even with an old heartbeat (the 0.10 bug)');
select pg_temp.act_as_user('user_V11Alice000001');
select is(public.chat_host_status(pg_temp.id('c1')) #>> '{runtime,presence}', 'working', 'chat_host_status says working');
select ok(public.chat_host_status(pg_temp.id('c1')) ? 'server_now', '...with the server time');
reset role;
select pg_temp.x(format($q$ update public.agent_runs set last_activity_at = now() - interval '10 minutes',
  started_at = now() - interval '10 minutes' where id = %L $q$, pg_temp.id('run7')));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'offline', 'a run silent for 10 min and no heartbeat: offline');
select pg_temp.x(format($q$ update public.runtimes set paused = true, last_seen_at = now() where id = %L $q$,
  (pg_temp.rt('a-rt')).id));
select is(threadlink_private.runtime_presence(pg_temp.rt('a-rt')), 'offline', 'a paused Runtime is offline');
select pg_temp.x(format($q$ update public.runtimes set paused = false where id = %L $q$, (pg_temp.rt('a-rt')).id));

-- Wake count.
select pg_temp.act_as_client();
select ok((public.runtime_pending_count(pg_temp.h('a-rt'), true) ->> 'pending')::int >= 1,
  'the wake count sees queued work for this Runtime''s sessions');
select is(public.runtime_pending_count(pg_temp.h('b-rt'), false) ->> 'pending', '1',
  'Bob''s Runtime counts only Bob''s work');
select is(pg_temp.fails($$ select public.runtime_pending_count(pg_temp.h('a-chat'), false) $$), '42501:forbidden',
  'a controller credential cannot wake');
select is(pg_temp.fails($$ select public.runtime_pending_count(pg_temp.h('nobody'), false) $$), '28000:',
  'an unknown credential cannot wake');
select is(pg_temp.fails($$ select public.runtime_pending_count(pg_temp.h('a-rt'), true) from generate_series(1, 130) $$),
  '54000:rate_limited', 'wake requests are rate-limited');
reset role;

-- ===========================================================================
-- 11b. Work-lane set_status, and the desktop / terminal additions: settings,
--      deciding a choice card, host presence and live subjects
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('wj2'), 'k-wj2');
select is(pg_temp.fails(format($q$ select pg_temp.w(%L, 'k-wj2', 'set_status', '{"status":"completed"}') $q$, pg_temp.id('wj2'))),
  '22023:', 'a work job can never be "completed" by set_status (only set_final PASS)');
select pg_temp.put('ue2', pg_temp.wr(pg_temp.id('cj5'), 'k-cj5', 'request_choice',
  '{"request_key":"ue:2","kind":"usage_exhausted","provider":"codex","other_provider":"claude-code"}') ->> 'choice_id');
reset role;
select is((pg_temp.job(pg_temp.id('cj5'))).status, 'queued', 'a Fast Chat job is not paused by a usage question');

select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select public.runtime_decide_choice(pg_temp.h('b-rt'), %L, %L, 'wait') $q$,
  pg_temp.id('c4'), pg_temp.id('ue2'))), 'P0002:chat_not_found', 'Bob''s Runtime cannot decide Alice''s choice');
select is(pg_temp.fails(format($q$ select public.runtime_decide_choice(pg_temp.h('b-rt'), %L, %L, 'wait') $q$,
  pg_temp.id('bc'), pg_temp.id('ue2'))), 'P0002:choice_not_found', '...not even through his own chat');
select is(pg_temp.fails(format($q$ select public.runtime_decide_choice(pg_temp.h('a-old'), %L, %L, 'wait') $q$,
  pg_temp.id('c4'), pg_temp.id('ue2'))), '42501:other_computer', 'only from the computer the project runs on');
select is(pg_temp.fails(format($q$ select public.runtime_decide_choice(pg_temp.h('a-rt'), %L, %L, 'retry') $q$,
  pg_temp.id('c4'), pg_temp.id('ue2'))), '22023:invalid_choice', 'only one of the choice''s own options');
select is(pg_temp.fails(format($q$ select public.runtime_decide_choice(pg_temp.h('a-rt'), %L, %L, 'wait') $q$,
  pg_temp.id('c1'), pg_temp.id('ue2'))), 'P0002:choice_not_found', 'only a choice of THAT chat');
select is(public.runtime_decide_choice(pg_temp.h('a-rt'), pg_temp.id('c4'), pg_temp.id('ue2'), 'wait') ->> 'chosen_label',
  'Wait for Codex', 'the desktop app answers a choice card');
select is(public.runtime_decide_choice(pg_temp.h('a-rt'), pg_temp.id('c4'), pg_temp.id('ue2'), 'wait') ->> 'replayed',
  'true', 'the same answer again is a replay');

select is(public.runtime_set_failover_policy(pg_temp.h('a-rt'), 'wait') ->> 'failover_policy', 'wait',
  'the desktop app sets the failover policy');
select is(public.runtime_list_chats(pg_temp.h('a-rt'), false, null) #>> '{settings,failover_policy}', 'wait',
  '...and the chat list carries it');
select is(public.runtime_get_settings(pg_temp.h('b-rt')) ->> 'failover_policy', 'auto',
  'Bob''s Runtime sees only Bob''s settings');
select is(pg_temp.fails($$ select public.runtime_set_failover_policy(pg_temp.h('a-rt'), 'sometimes') $$), '22023:invalid',
  'an unknown policy is refused');
select is(pg_temp.fails($$ select public.runtime_set_failover_policy(pg_temp.h('a-chat'), 'auto') $$), '42501:forbidden',
  'a controller credential cannot change settings');
select pg_temp.put('evs', public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('c4'), null, null, 5, false)::text);
reset role;
select pg_temp.act_as_user('user_V11Alice000001');
select is(public.get_my_settings() ->> 'failover_policy', 'wait', 'one setting for the owner, web and desktop alike');
select public.set_failover_policy('auto');
reset role;
select ok((pg_temp.id('evs'))::jsonb #>> '{host,presence}' in ('online', 'working', 'reconnecting', 'offline')
          and (pg_temp.id('evs'))::jsonb ? 'server_now', 'chat reads carry the host''s presence and the server time');
select is((pg_temp.id('evs'))::jsonb #>> '{host,label}', 'Nickron PC', '...naming the execution host');
select is((select a ->> 'subject' from jsonb_array_elements((pg_temp.id('evs'))::jsonb -> 'activity') a
           where a ->> 'run_id' = pg_temp.id('run7')), 'Investigating', 'live rows say what a run does in fixed words');

-- ===========================================================================
-- 11c. Redaction: prose about secrets stays readable; secret-looking values do not
-- ===========================================================================
select is(threadlink_private.redact_text('an expired token is still accepted after refresh'),
  'an expired token is still accepted after refresh', 'prose that mentions a token is not redacted');
select is(threadlink_private.redact_text('the password is hunter2'), 'the password is [redacted]',
  'a secret-looking value (a digit) is redacted');
select is(threadlink_private.redact_text('the api key was abcdefghijklmnopqrstuv'), 'the api key was [redacted]',
  '...and so is a long one');
select is(threadlink_private.redact_text('the secret is "s3cr3t"'), 'the secret is [redacted]', '...quoted too');
select is(threadlink_private.redact_text('token: still here'), 'token: [redacted]', 'key: value is still redacted');

-- ===========================================================================
-- 12. Privileges
-- ===========================================================================
select ok(not has_function_privilege('anon', 'public.post_chat_message(text, text, text, text, text, text, text)', 'execute'),
  'anon cannot call the owner post overload');
select ok(has_function_privilege('authenticated', 'public.post_chat_message(text, text, text, text, text, text, text)', 'execute'),
  'authenticated can');
select ok(not has_function_privilege('authenticated', 'public.runtime_post_chat_message(text, text, text, text, text, text, text, text, text)', 'execute')
          and has_function_privilege('anon', 'public.runtime_post_chat_message(text, text, text, text, text, text, text, text, text)', 'execute'),
  'the credential post overload is anon-only');
select ok(not has_function_privilege('anon', 'threadlink_private.team_job_write_v10(text, text, text, text, text, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'threadlink_private.team_job_write_v10(text, text, text, text, text, jsonb)', 'execute'),
  'the moved 0.10 write function is private');
select ok(has_function_privilege('anon', 'public.team_job_write(text, text, text, text, text, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.team_job_write(text, text, text, text, text, jsonb)', 'execute'),
  'team_job_write keeps its anon-only audience');
select ok(not has_function_privilege('anon', 'public.get_my_settings()', 'execute')
          and not has_function_privilege('anon', 'public.chat_compose_context(text)', 'execute'),
  'owner RPCs are not anon');
select ok(not has_function_privilege('authenticated', 'threadlink_private.chat_post_v11(text, text, text, text, text, text, text, text)', 'execute'),
  'the private post path is private');
select ok(has_function_privilege('anon', 'public.runtime_decide_choice(text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.runtime_decide_choice(text, text, text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.runtime_set_failover_policy(text, text)', 'execute'),
  'the desktop settings / decide RPCs are credential-only (anon)');
select ok(not has_table_privilege('authenticated', 'public.user_settings', 'insert')
          and not has_table_privilege('authenticated', 'public.user_settings', 'update'),
  'no client writes user_settings');

select * from finish();
rollback;
