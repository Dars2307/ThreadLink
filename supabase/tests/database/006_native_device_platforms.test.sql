-- ThreadLink Phase 6.5: native session attachment, device authorization,
-- OAuth platform classification, agent failure reasons (pgTAP). LOCAL stack only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(45);

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
create temp table ids (name text primary key, value text) on commit drop;
create function pg_temp.id(n text) returns text language sql as $$ select value from ids where name = n $$;
create function pg_temp.put(n text, v text) returns text language sql as $$
  insert into ids values (n, v) on conflict (name) do update set value = excluded.value returning value;
$$;
create function pg_temp.session(s text) returns public.session_bindings language sql security definer as $$
  select * from public.session_bindings where id = s
$$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t
$$;
create function pg_temp.connection(c text) returns public.connections language sql security definer as $$
  select * from public.connections where id = c
$$;
create function pg_temp.device(code text) returns public.device_authorizations language sql security definer as $$
  select * from public.device_authorizations where user_code = code
$$;
create function pg_temp.expire_device(code text) returns void language sql security definer as $$
  update public.device_authorizations set expires_at = now() - interval '1 second' where user_code = code
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

select pg_temp.act_as_user('user_NativeAlice1');
select public.provision_current_user('Alice', 'alice@example.com');
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c'), 'tlc_acaaaa');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-g'), 'tlc_agaaaa');
reset role;
select pg_temp.act_as_user('user_NativeBob002');
select public.provision_current_user('Bob', null);
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-g'), 'tlc_bgaaaa');
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('b-c'), 'tlc_bcaaaa');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('s_c', public.register_session(pg_temp.h('a-c'), 'Chat', null, 'c') ->> 'id');
select pg_temp.put('s_g', public.register_session(pg_temp.h('a-g'), 'Laptop', null, 'g') ->> 'id');
select pg_temp.put('s_bg', public.register_session(pg_temp.h('b-g'), 'Bob laptop', null, 'bg') ->> 'id');
select pg_temp.put('s_bc', public.register_session(pg_temp.h('b-c'), 'Bob chat', null, 'bc') ->> 'id');

-- ---------------------------------------------------------------------------
-- Platform / role model
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as_user('user_NativeAlice1');
select throws_ok(
  $$ select public.register_connection('chatgpt', 'agent', null, pg_temp.h('bad-1'), 'tlc_bad111') $$,
  '23514', null, 'a controller platform cannot be registered as an agent');
select throws_ok(
  $$ select public.register_connection('claude-code', 'controller', null, pg_temp.h('bad-2'), 'tlc_bad222') $$,
  '23514', null, 'claude-code cannot be registered as a controller');
reset role;

select is(threadlink_private.classify_oauth_platform(array['https://chatgpt.com/connector_platform_oauth_redirect']),
  'chatgpt', 'chatgpt.com redirect -> chatgpt');
select is(threadlink_private.classify_oauth_platform(array['https://claude.ai/api/mcp/auth_callback']),
  'claude-desktop', 'claude.ai redirect -> claude-desktop');
select is(threadlink_private.classify_oauth_platform(array['https://claude.ai/cb', 'https://chatgpt.com/cb']),
  'generic-mcp', 'mixed providers -> generic-mcp');
select is(threadlink_private.classify_oauth_platform(array['http://localhost:3334/callback']),
  'generic-mcp', 'localhost redirect -> generic-mcp');
select is(threadlink_private.classify_oauth_platform(array['https://chatgpt.com.evil.example/cb']),
  'generic-mcp', 'look-alike host -> generic-mcp');

select pg_temp.act_as_client();
select pg_temp.put('cli_claude', public.register_oauth_client('ChatGPT (claimed)', array['https://claude.ai/api/mcp/auth_callback']) ->> 'client_id');
reset role;
select is((select platform from public.oauth_clients where id = pg_temp.id('cli_claude')), 'claude-desktop',
  'platform comes from the redirect URI, not the client-supplied name');

-- OAuth exchange creates a connection with the classified platform.
select pg_temp.act_as_user('user_NativeAlice1');
select public.create_oauth_authorization(pg_temp.id('cli_claude'), 'https://claude.ai/api/mcp/auth_callback',
  encode(sha256(convert_to('claude-code-1', 'UTF8')), 'hex'),
  translate(rtrim(encode(sha256(convert_to(repeat('v', 43), 'UTF8')), 'base64'), '='), '+/', '-_'), null);
reset role;
select pg_temp.act_as_client();
select pg_temp.put('c_claude', public.exchange_oauth_code(encode(sha256(convert_to('claude-code-1', 'UTF8')), 'hex'),
  repeat('v', 43), pg_temp.id('cli_claude'), 'https://claude.ai/api/mcp/auth_callback', null,
  pg_temp.h('claude-desktop'), 'tlc_cdaaaa') ->> 'connection_id');
reset role;
select is((pg_temp.connection(pg_temp.id('c_claude'))).platform, 'claude-desktop', 'Claude MCP client is stored as claude-desktop');
select is((pg_temp.connection(pg_temp.id('c_claude'))).role, 'controller', 'OAuth MCP clients are controllers');

-- ---------------------------------------------------------------------------
-- Native session attachment
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select lives_ok(
  $$ select public.set_native_session(pg_temp.h('a-g'), pg_temp.id('s_g'), 'resume',
       '04158991-0630-4b8b-b461-58c86ee35453', 'C:\work\ThreadLink') $$,
  'the agent attaches a native Claude session to its own tlses_');
reset role;
select is((pg_temp.session(pg_temp.id('s_g'))).native_provider_session_id, '04158991-0630-4b8b-b461-58c86ee35453',
  'native session id stored as metadata');
select is((pg_temp.session(pg_temp.id('s_g'))).native_session_mode, 'resume', 'mode is resume');
select is((pg_temp.session(pg_temp.id('s_g'))).id, pg_temp.id('s_g'), 'tlses_ identity unchanged by attachment');
select isnt((pg_temp.session(pg_temp.id('s_g'))).native_attached_at, null, 'attachment time recorded');

select pg_temp.act_as_client();
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('a-c'), pg_temp.id('s_c'), 'resume',
       '04158991-0630-4b8b-b461-58c86ee35453', 'x') $$,
  '42501', null, 'a controller cannot attach a native session');
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('b-g'), pg_temp.id('s_g'), 'resume',
       '04158991-0630-4b8b-b461-58c86ee35453', 'x') $$,
  'P0002', null, 'another user''s agent cannot attach to this session');
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('a-g'), pg_temp.id('s_g'), 'resume', 'not-a-uuid', 'x') $$,
  '23514', null, 'malformed native session id rejected');
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('a-g'), pg_temp.id('s_g'), 'resume', null, 'x') $$,
  '22023', null, 'resume mode requires a native session id');
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('a-g'), pg_temp.id('s_g'), 'fresh',
       '04158991-0630-4b8b-b461-58c86ee35453', 'x') $$,
  '22023', null, 'fresh mode must not carry a native id');
select throws_ok(
  $$ select public.set_native_session(pg_temp.h('a-g'), pg_temp.id('s_g'), 'rm -rf', null, 'x') $$,
  '22023', null, 'unknown mode rejected');
select is(
  public.get_session(pg_temp.h('a-g'), pg_temp.id('s_g')) ->> 'native_session_mode', 'resume',
  'session json exposes the mode to the owning agent');

-- Controller view of pairable agent sessions: own user only, no paths or native ids.
select is(jsonb_array_length(public.list_agent_sessions(pg_temp.h('a-c'), pg_temp.id('s_c'))), 1,
  'controller sees exactly its owner''s agent sessions');
select is(public.list_agent_sessions(pg_temp.h('a-c'), pg_temp.id('s_c')) -> 0 ->> 'workspace_name', 'ThreadLink',
  'only the workspace folder name is shown');
select ok(not (public.list_agent_sessions(pg_temp.h('a-c'), pg_temp.id('s_c'))::text ~ '04158991|C:'),
  'no native id or full path leaks to the controller');
select throws_ok($$ select public.list_agent_sessions(pg_temp.h('a-g'), pg_temp.id('s_g')) $$,
  '42501', null, 'agents cannot enumerate sessions');
select throws_ok($$ select public.list_agent_sessions(pg_temp.h('b-c'), pg_temp.id('s_c')) $$,
  'P0002', null, 'cannot list using another user''s session');

-- ---------------------------------------------------------------------------
-- Failure reasons (session busy)
-- ---------------------------------------------------------------------------
select pg_temp.put('l', public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('s_g')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('l'));
select is(public.list_agent_sessions(pg_temp.h('a-c'), pg_temp.id('s_c')) -> 0 ->> 'link_status', 'active',
  'link status shown for the controller''s own link');
select pg_temp.put('t', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'Busy', 'x') ->> 'task_id');
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'w1');
select throws_ok(
  $$ select public.fail_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'w1', 'x', 'lease_exhausted') $$,
  '22023', null, 'agents cannot claim system failure reasons');
select is(
  public.fail_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'w1', 'Claude session is open elsewhere', 'session_busy')
    ->> 'failure_reason', 'session_busy', 'session busy is reported as a failure reason');
select pg_temp.put('t2', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'Plain', 'x') ->> 'task_id');
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w1');
select is(
  public.fail_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w1', 'boom') ->> 'status', 'failed',
  'the five-argument fail_task call still works');

-- ---------------------------------------------------------------------------
-- Device authorization
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.start_device_authorization(pg_temp.h('dev-1'), 'BCDFGHJK', 'Joel laptop') $$,
  'anyone can start a device authorization');
select throws_ok($$ select public.start_device_authorization(pg_temp.h('dev-x'), 'abc', 'x') $$,
  '22023', null, 'malformed user code rejected');
select throws_ok($$ select public.redeem_device_authorization(pg_temp.h('dev-1'), pg_temp.h('tok-1'), 'tlc_tok111') $$,
  'TLD01', null, 'pending authorization cannot be redeemed');
select throws_ok($$ select public.get_device_authorization('BCDFGHJK') $$,
  '42501', null, 'anonymous callers cannot look up codes');
reset role;

select pg_temp.act_as_user('user_NativeAlice1');
select is(public.get_device_authorization('BCDFGHJK') ->> 'display_name', 'Joel laptop', 'signed-in user sees the device name');
select throws_ok($$ select public.decide_device_authorization('ZZZZZZZZ', true) $$,
  'P0002', null, 'unknown code rejected');
select is(public.decide_device_authorization('BCDFGHJK', true) ->> 'status', 'approved', 'user approves the device');
reset role;
select is((pg_temp.device('BCDFGHJK')).owner_user_id, (select id from public.users where clerk_user_id = 'user_NativeAlice1'),
  'owner is the approving user');

select pg_temp.act_as_client();
select pg_temp.put('dev_conn', public.redeem_device_authorization(pg_temp.h('dev-1'), pg_temp.h('tok-1'), 'tlc_tok111') ->> 'connection_id');
reset role;
select is((pg_temp.connection(pg_temp.id('dev_conn'))).platform, 'claude-code', 'device flow creates a claude-code connection');
select is((pg_temp.connection(pg_temp.id('dev_conn'))).role, 'agent', '... with the agent role');
select pg_temp.act_as_client();
select is(public.authenticate_connection(pg_temp.h('tok-1')) ->> 'connection_id', pg_temp.id('dev_conn'),
  'the redeemed credential authenticates');
select throws_ok($$ select public.redeem_device_authorization(pg_temp.h('dev-1'), pg_temp.h('tok-2'), 'tlc_tok222') $$,
  '22023', null, 'a device code is single-use');

-- Denied and expired.
select public.start_device_authorization(pg_temp.h('dev-2'), 'CDFGHJKL', 'Other');
reset role;
select pg_temp.act_as_user('user_NativeBob002');
select public.decide_device_authorization('CDFGHJKL', false);
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.redeem_device_authorization(pg_temp.h('dev-2'), pg_temp.h('tok-3'), 'tlc_tok333') $$,
  'TLD02', null, 'denied authorization cannot be redeemed');
select public.start_device_authorization(pg_temp.h('dev-3'), 'DFGHJKLM', 'Late');
reset role;
select pg_temp.expire_device('DFGHJKLM');
select pg_temp.act_as_user('user_NativeAlice1');
select throws_ok($$ select public.decide_device_authorization('DFGHJKLM', true) $$,
  'P0002', null, 'expired codes cannot be approved');
reset role;

select * from finish();
rollback;
