-- ThreadLink Phase 6.7: background delegation (pgTAP). LOCAL stack only.
--
-- Exact-conversation mode must keep refusing a conversation that is open.
-- Background worker mode must be a distinct, traceable conversation of
-- ThreadLink's own, in the same workspace, and never be passed off as the
-- user's.

begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

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
create function pg_temp.session(s text) returns public.session_bindings language sql security definer as $$
  select * from public.session_bindings where id = s $$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- Two native conversations: the user's, and the worker ThreadLink branches off it.
create function pg_temp.user_convo() returns text language sql as $$
  select 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'::text $$;
create function pg_temp.worker_convo() returns text language sql as $$
  select '11111111-2222-4333-8444-555555555555'::text $$;

select pg_temp.act_as_user('user_Deleg00000001');
select public.provision_current_user('Joel', null);
select public.register_connection('chatgpt', 'controller', 'ChatGPT', pg_temp.h('chat'), 'tlc_chat01');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('rt'), 'tlc_rt0001');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('rt', public.register_runtime(pg_temp.h('rt'), 'Laptop', 'windows', 'desktop', '0.6.7') ->> 'id');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('rt'), pg_temp.k('C:/work/ThreadLink'),
  'ThreadLink', 'C:\work\ThreadLink', null, null, null) ->> 'id');

-- ---------------------------------------------------------------------------
-- Registering each mode
-- ---------------------------------------------------------------------------
select pg_temp.put('exact', public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc:' || pg_temp.user_convo(), 'Dashboard redesign', 'claude-code', 'resume', pg_temp.user_convo()) ->> 'id');
select is((pg_temp.session(pg_temp.id('exact'))).native_session_mode, 'resume',
  'exact conversation registers as resume');

select pg_temp.put('bg', public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc-worker:' || pg_temp.user_convo(), 'Background worker', 'claude-code', 'worker',
  pg_temp.user_convo()) ->> 'id');
select is((pg_temp.session(pg_temp.id('bg'))).native_session_mode, 'worker',
  'background delegation registers as worker');
select is((pg_temp.session(pg_temp.id('bg'))).native_provider_session_id, pg_temp.user_convo(),
  'the worker remembers which conversation it was branched from');
select is((pg_temp.session(pg_temp.id('bg'))).worker_native_session_id, null,
  'it has no worker conversation until one has actually run');
select isnt(pg_temp.id('bg'), pg_temp.id('exact'),
  'the worker is a different ThreadLink session from the exact conversation');
select is((pg_temp.session(pg_temp.id('bg'))).workspace_id, pg_temp.id('ws'),
  'and it belongs to the same workspace');

-- The first run reports the conversation it created; re-registering keeps it.
select is(public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc-worker:' || pg_temp.user_convo(), 'Background worker', 'claude-code', 'worker',
  pg_temp.user_convo(), pg_temp.worker_convo()) ->> 'id', pg_temp.id('bg'),
  're-registering the worker reuses the same ThreadLink session');
select is((pg_temp.session(pg_temp.id('bg'))).worker_native_session_id, pg_temp.worker_convo(),
  'the worker conversation is recorded for reuse');

-- A fresh conversation carries no native id at all.
select pg_temp.put('fresh', public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc-fresh:11111111-1111-4111-8111-111111111111', 'New each time', 'claude-code', 'fresh', null) ->> 'id');
select is((pg_temp.session(pg_temp.id('fresh'))).native_session_mode, 'fresh', 'fresh mode still works');

-- ---------------------------------------------------------------------------
-- The modes cannot be mixed up
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc:x1', 'x', 'claude-code', 'resume', null) $$,
  '22023', null, 'exact mode requires the conversation it resumes');
select throws_ok($$ select public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc:x2', 'x', 'claude-code', 'fresh', pg_temp.user_convo()) $$,
  '22023', null, 'a fresh conversation may not name a native session');
select throws_ok($$ select public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc:x3', 'x', 'claude-code', 'resume', pg_temp.user_convo(), pg_temp.worker_convo()) $$,
  '22023', null, 'only worker mode may carry a worker conversation');
select throws_ok($$ select public.register_runtime_session(pg_temp.h('rt'), pg_temp.id('ws'),
  'cc:x4', 'x', 'claude-code', 'sneaky', null) $$,
  '22023', null, 'an unknown mode is refused');

-- ---------------------------------------------------------------------------
-- A task records how it was actually run
-- ---------------------------------------------------------------------------
-- ThreadLink only routes to a Runtime that reports the provider as available.
select public.runtime_heartbeat(pg_temp.h('rt'), '0.6.7', '{"claude-code":"available"}', '{}');

select pg_temp.put('chatses', public.register_session(pg_temp.h('chat'), null, null, 'chat-1') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('chat'), pg_temp.id('chatses'), pg_temp.id('bg')) ->> 'id');
select public.approve_pairing(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('link'));
select pg_temp.put('t1', public.create_task(pg_temp.h('chat'), pg_temp.id('chatses'), pg_temp.id('link'),
  'Delegated work', 'do the thing') ->> 'task_id');

select is((pg_temp.task(pg_temp.id('t1'))).execution_mode, null,
  'a queued task has not been run any particular way yet');

select public.claim_task(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('t1'), 'claim-1');
select is(public.report_execution_mode(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('t1'), 'claim-1',
  'background_worker', pg_temp.worker_convo()) ->> 'execution_mode', 'background_worker',
  'the agent records that a background worker ran it');
select is((pg_temp.task(pg_temp.id('t1'))).worker_native_session_id, pg_temp.worker_convo(),
  'and which conversation did the work, so it is traceable');

select throws_ok($$ select public.report_execution_mode(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('t1'),
  'claim-1', 'exact_conversation', pg_temp.worker_convo()) $$,
  '22023', null, 'a worker conversation cannot be reported as the exact conversation');
select throws_ok($$ select public.report_execution_mode(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('t1'),
  'claim-1', 'pretend') $$,
  '22023', null, 'an unknown execution mode is refused');
select throws_ok($$ select public.report_execution_mode(pg_temp.h('rt'), pg_temp.id('bg'), pg_temp.id('t1'),
  'wrong-claim', 'background_worker') $$,
  '55000', null, 'only the agent holding the claim may report how it ran');
select throws_ok($$ select public.report_execution_mode(pg_temp.h('chat'), pg_temp.id('chatses'), pg_temp.id('t1'),
  'claim-1', 'background_worker') $$,
  '42501', null, 'the controller may not report execution mode');

-- ---------------------------------------------------------------------------
-- Isolation is unchanged
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.register_runtime_session(pg_temp.h('nobody'), pg_temp.id('ws'),
  'cc:x5', 'x', 'claude-code', 'worker', null) $$,
  '28000', null, 'an unknown credential cannot register a worker');

select * from finish();
rollback;
