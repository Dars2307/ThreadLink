-- ThreadLink Phase 6.6: runtimes, workspaces, per-conversation sessions, capabilities,
-- pause, restart, revocation, credential rotation (pgTAP). LOCAL stack only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(55);

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
create function pg_temp.runtime(r text) returns public.runtimes language sql security definer as $$
  select * from public.runtimes where id = r $$;
create function pg_temp.session(s text) returns public.session_bindings language sql security definer as $$
  select * from public.session_bindings where id = s $$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t $$;
create function pg_temp.link(l text) returns public.thread_links language sql security definer as $$
  select * from public.thread_links where id = l $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

select pg_temp.act_as_user('user_RuntimeAlice1');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c1'), 'tlc_ac1aaa');
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c2'), 'tlc_ac2aaa');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_artaaa');
reset role;
select pg_temp.act_as_user('user_RuntimeBob002');
select public.provision_current_user('Bob', null);
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_brtaaa');
reset role;

-- ---------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '1.0.0', '{}', '{}') $$,
  'P0002', null, 'heartbeat requires registration');
select pg_temp.put('rt', public.register_runtime(pg_temp.h('a-rt'), 'Joel''s Laptop', 'windows', 'desktop', '0.6.6') ->> 'id');
select matches(pg_temp.id('rt'), '^tlrun_[0-9a-f]{32}$', 'runtime gets a tlrun_ id');
select is(public.register_runtime(pg_temp.h('a-rt'), 'Laptop (renamed)', 'windows', 'cli', '0.6.7') ->> 'id',
  pg_temp.id('rt'), 're-registration reuses the same runtime (restart preserves identity)');
select throws_ok($$ select public.register_runtime(pg_temp.h('a-c1'), 'x', 'windows', 'desktop', '1') $$,
  '42501', null, 'controllers cannot register runtimes');
select throws_ok($$ select public.register_runtime(pg_temp.h('a-rt'), 'x', 'amiga', 'desktop', '1') $$,
  '23514', null, 'unknown platform rejected');
select pg_temp.put('rt_b', public.register_runtime(pg_temp.h('b-rt'), 'Bob box', 'linux', 'remote', '0.6.6') ->> 'id');
reset role;
select is((pg_temp.runtime(pg_temp.id('rt'))).owner_user_id,
  (select id from public.users where clerk_user_id = 'user_RuntimeAlice1'), 'owner comes from the credential');

-- ---------------------------------------------------------------------------
-- Capabilities + heartbeat
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '1', '{"owner_user_id":"x"}', '{}') $$,
  '22023', null, 'unknown capability keys rejected');
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '1', '{"claude-code":"yes"}', '{}') $$,
  '22023', null, 'invalid capability values rejected');
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '1', '[1]', '{}') $$,
  '22023', null, 'capabilities must be an object');
select lives_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6',
  '{"claude-code":"available","claude-resume":"available","interactive-session-discovery":"available","codex":"unavailable","filesystem":"local","platform":"windows"}', '{}') $$,
  'valid capabilities accepted');
reset role;
select is((pg_temp.runtime(pg_temp.id('rt'))).capabilities ->> 'claude-code', 'available', 'capabilities stored');
select isnt((pg_temp.runtime(pg_temp.id('rt'))).last_seen_at, null, 'heartbeat records last seen');

-- ---------------------------------------------------------------------------
-- Workspaces + multiple conversations in one workspace
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/work/ThreadLink'),
  'ThreadLink', 'C:\work\ThreadLink', 'github.com/dars2307/threadlink', pg_temp.k('github.com/dars2307/threadlink'), 'main') ->> 'id');
select is(public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/work/ThreadLink'), 'ThreadLink', null, null, null, null) ->> 'id',
  pg_temp.id('ws'), 'same workspace key reuses the workspace');
select throws_ok($$ select public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('x'), 'x', null, 'user:pass@github.com/x', null, null) $$,
  '23514', null, 'remotes with credentials/userinfo are rejected');
select pg_temp.put('ws_b', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/workspaces/ThreadLink'),
  'ThreadLink', '/workspaces/ThreadLink', 'github.com/dars2307/threadlink', pg_temp.k('github.com/dars2307/threadlink'), 'main') ->> 'id');

select pg_temp.put('s_dash', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:11111111-1111-4111-8111-111111111111', 'Dashboard redesign', 'claude-code', 'resume', '11111111-1111-4111-8111-111111111111') ->> 'id');
select pg_temp.put('s_sec', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:22222222-2222-4222-8222-222222222222', 'Security review', 'claude-code', 'resume', '22222222-2222-4222-8222-222222222222') ->> 'id');
select isnt(pg_temp.id('s_dash'), pg_temp.id('s_sec'), 'two conversations in one workspace are two tlses_');
select is(public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:11111111-1111-4111-8111-111111111111', 'Dashboard redesign', 'claude-code', 'resume', '11111111-1111-4111-8111-111111111111') ->> 'id',
  pg_temp.id('s_dash'), 're-registering a conversation reuses its tlses_');
reset role;
select is((pg_temp.session(pg_temp.id('s_dash'))).workspace_id, pg_temp.id('ws'), 'session placed in the workspace');
select is((pg_temp.session(pg_temp.id('s_dash'))).runtime_id, pg_temp.id('rt'), 'session placed on the runtime');
select is((pg_temp.session(pg_temp.id('s_dash'))).native_provider_session_id, '11111111-1111-4111-8111-111111111111',
  'native id kept as metadata');
select pg_temp.act_as_client();
select throws_ok($$ select public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws_b'), 'cc:x', 'x', 'claude-code', 'fresh', null) $$,
  'P0002', null, 'cannot place sessions in another runtime''s workspace');
select throws_ok($$ select public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'), 'cc:y', 'y', 'emacs', 'fresh', null) $$,
  '22023', null, 'unknown provider rejected');
select throws_ok($$ select public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'), 'cc:z', 'z', 'claude-code', 'resume', null) $$,
  '22023', null, 'resume needs a native id');

-- Busy state: only this runtime's sessions; foreign ids ignored.
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6', '{"claude-code":"available"}',
  array[pg_temp.id('s_sec'), 'tlses_ffffffffffffffffffffffffffffffff']);
reset role;
select ok((pg_temp.session(pg_temp.id('s_sec'))).native_busy, 'busy conversation flagged');
select ok(not (pg_temp.session(pg_temp.id('s_dash'))).native_busy, 'idle conversation not flagged');

-- ---------------------------------------------------------------------------
-- Two ChatGPT chats -> two different Claude conversations in the same workspace
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('c1', public.register_session(pg_temp.h('a-c1'), 'Phase 6.6 planning', null, 'chat-1') ->> 'id');
select pg_temp.put('c2', public.register_session(pg_temp.h('a-c2'), 'Security chat', null, 'chat-2') ->> 'id');
select is(jsonb_array_length(public.list_agent_sessions(pg_temp.h('a-c1'), pg_temp.id('c1'))), 2,
  'controller sees both conversations');
select is((select count(*)::int from jsonb_array_elements(public.list_agent_sessions(pg_temp.h('a-c1'), pg_temp.id('c1'))) e
           where e ->> 'runtime_label' = 'Laptop (renamed)' and e ->> 'workspace_name' = 'ThreadLink'), 2,
  'each shows its runtime and workspace');
select is((select e ->> 'busy' from jsonb_array_elements(public.list_agent_sessions(pg_temp.h('a-c1'), pg_temp.id('c1'))) e
           where e ->> 'id' = pg_temp.id('s_sec')), 'true', 'busy state visible to the controller');
select ok(not (public.list_agent_sessions(pg_temp.h('a-c1'), pg_temp.id('c1'))::text ~ '11111111-1111|C:'),
  'controller never sees native ids or paths');
select pg_temp.put('l1', public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('c1'), pg_temp.id('s_dash')) ->> 'id');
select pg_temp.put('l2', public.request_pairing(pg_temp.h('a-c2'), pg_temp.id('c2'), pg_temp.id('s_sec')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('s_dash'), pg_temp.id('l1'));
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('s_sec'), pg_temp.id('l2'));
select pg_temp.put('t1', public.create_task(pg_temp.h('a-c1'), pg_temp.id('c1'), pg_temp.id('l1'), 'For dashboard', 'x') ->> 'task_id');
select pg_temp.put('t2', public.create_task(pg_temp.h('a-c2'), pg_temp.id('c2'), pg_temp.id('l2'), 'For security', 'y') ->> 'task_id');
reset role;
select is((pg_temp.task(pg_temp.id('t1'))).target_session_id, pg_temp.id('s_dash'), 'chat 1 routes to its exact conversation');
select is((pg_temp.task(pg_temp.id('t2'))).target_session_id, pg_temp.id('s_sec'), 'chat 2 routes to its exact conversation');
select pg_temp.act_as_client();
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-rt'), pg_temp.id('s_dash'), 20)), 1, 'each conversation inbox holds only its task');
select throws_ok($$ select public.create_task(pg_temp.h('a-c1'), pg_temp.id('c1'), pg_temp.id('l2'), 'cross', 'x') $$,
  'P0002', null, 'chat 1 cannot use chat 2''s link');

-- ---------------------------------------------------------------------------
-- Capability-aware routing, link pause, runtime pause
-- ---------------------------------------------------------------------------
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6', '{"claude-code":"unavailable"}', '{}');
select throws_ok($$ select public.create_task(pg_temp.h('a-c1'), pg_temp.id('c1'), pg_temp.id('l1'), 'no claude', 'x') $$,
  '55000', null, 'no routing to a runtime without the provider capability');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6', '{"claude-code":"available"}', '{}');
reset role;

select pg_temp.act_as_user('user_RuntimeAlice1');
select is(public.set_link_paused(pg_temp.id('l1'), true) ->> 'paused', 'true', 'owner pauses a link');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.create_task(pg_temp.h('a-c1'), pg_temp.id('c1'), pg_temp.id('l1'), 'paused', 'x') $$,
  '55000', null, 'paused link accepts no new tasks');
reset role;
select pg_temp.act_as_user('user_RuntimeAlice1');
select public.set_link_paused(pg_temp.id('l1'), false);
select is(public.update_runtime(pg_temp.id('rt'), null, null, true, false) ->> 'paused', 'true', 'owner pauses the runtime');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('s_dash'), pg_temp.id('t1'), 'w') $$,
  '55000', null, 'a paused runtime cannot claim');
select is(jsonb_array_length(public.list_agent_sessions(pg_temp.h('a-c1'), pg_temp.id('c1'))), 0,
  'paused runtime conversations are not offered for linking');
reset role;
select pg_temp.act_as_user('user_RuntimeAlice1');
select public.update_runtime(pg_temp.id('rt'), null, '{"autoStart": false}', false, true);
reset role;
select is((pg_temp.runtime(pg_temp.id('rt'))).settings ->> 'autoStart', 'false', 'settings stored server-side');
select isnt((pg_temp.runtime(pg_temp.id('rt'))).restart_requested_at, null, 'restart request recorded');
select pg_temp.act_as_client();
select is(public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6', '{"claude-code":"available"}', '{}') -> 'settings' ->> 'autoStart',
  'false', 'the runtime receives settings on heartbeat (no local dashboard state)');
select lives_ok($$ select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('s_dash'), pg_temp.id('t1'), 'w') $$,
  'unpaused runtime claims');
reset role;

select pg_temp.act_as_user('user_RuntimeAlice1');
select throws_ok($$ select public.update_runtime(pg_temp.id('rt'), null, '{"rm":true}', null, false) $$,
  '22023', null, 'unknown settings rejected');
reset role;
select pg_temp.act_as_user('user_RuntimeBob002');
select throws_ok($$ select public.update_runtime(pg_temp.id('rt'), 'pwned', null, null, false) $$,
  'P0002', null, 'another user cannot control this runtime');
select throws_ok($$ select public.revoke_runtime(pg_temp.id('rt')) $$,
  'P0002', null, 'another user cannot revoke this runtime');
select is((select count(*)::int from public.runtimes), 1, 'RLS: Bob sees only his runtime');
select is((select count(*)::int from public.runtime_workspaces), 1, 'RLS: Bob sees only his workspace');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select count(*) from public.runtimes $$, '42501', null, 'anon cannot read runtimes');

-- ---------------------------------------------------------------------------
-- Credential rotation + revocation
-- ---------------------------------------------------------------------------
select public.rotate_own_credential(pg_temp.h('b-rt'), pg_temp.h('b-rt-2'), 'tlc_brt222');
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('b-rt'), '1', '{}', '{}') $$,
  '28000', null, 'old credential stops working after rotation');
select lives_ok($$ select public.runtime_heartbeat(pg_temp.h('b-rt-2'), '1', '{}', '{}') $$,
  'rotated credential works for the same runtime');
reset role;

select pg_temp.act_as_user('user_RuntimeAlice1');
select is(public.revoke_runtime(pg_temp.id('rt')) ->> 'status', 'revoked', 'owner revokes the runtime');
reset role;
select is((select status from public.connections where id = (pg_temp.runtime(pg_temp.id('rt'))).connection_id), 'revoked',
  'revoking the runtime revokes its connection');
select is((pg_temp.link(pg_temp.id('l2'))).status, 'revoked', 'its links are revoked');
select is((pg_temp.task(pg_temp.id('t2'))).status, 'cancelled', 'its open tasks are cancelled');
select pg_temp.act_as_client();
select throws_ok($$ select public.runtime_heartbeat(pg_temp.h('a-rt'), '1', '{}', '{}') $$,
  '28000', null, 'a revoked runtime cannot authenticate');

select * from finish();
rollback;
