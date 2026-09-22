-- ThreadLink Phase 6: claim leases, OAuth (MCP connector), owner pairing, limits (pgTAP).
-- LOCAL disposable stack only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(65);

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
-- RFC 7636 S256 challenge, computed independently of the function under test.
create function pg_temp.s256(verifier text) returns text language sql as $$
  select translate(rtrim(encode(sha256(convert_to(verifier, 'UTF8')), 'base64'), '='), '+/', '-_')
$$;
create temp table ids (name text primary key, value text) on commit drop;
create function pg_temp.id(n text) returns text language sql as $$ select value from ids where name = n $$;
create function pg_temp.put(n text, v text) returns text language sql as $$
  insert into ids values (n, v) on conflict (name) do update set value = excluded.value returning value;
$$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t
$$;
create function pg_temp.expire_lease(t text) returns void language sql security definer as $$
  update public.tasks set claimed_until = now() - interval '1 second' where id = t
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- Fixtures: A has controller C (s_c), agent G (s_g) and link L; B has controller BC.
select pg_temp.act_as_user('user_LeaseAlice1');
select public.provision_current_user('Alice', null);
select pg_temp.put('a_user', (select id from public.users));
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c'), 'tlc_acaaaa');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-g'), 'tlc_agaaaa');
reset role;
select pg_temp.act_as_user('user_LeaseBob002');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('b-c'), 'tlc_bcaaaa');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('s_c', public.register_session(pg_temp.h('a-c'), 'Chat', null, 'c') ->> 'id');
select pg_temp.put('s_g', public.register_session(pg_temp.h('a-g'), 'Bridge', null, 'g') ->> 'id');
select pg_temp.put('s_bc', public.register_session(pg_temp.h('b-c'), null, null, 'bc') ->> 'id');
select pg_temp.put('l', public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('s_g')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('l'));
select pg_temp.put('t', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'Lease', 'x') ->> 'task_id');

-- ---------------------------------------------------------------------------
-- Leases
-- ---------------------------------------------------------------------------
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1');
select ok(
  (pg_temp.task(pg_temp.id('t'))).claimed_until between now() + interval '4 minutes' and now() + interval '6 minutes',
  'a claim grants a finite lease (5 minutes)');
select is((pg_temp.task(pg_temp.id('t'))).attempt_count, 1, 'claim counts the attempt');
select is(
  (public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1') ->> 'attempt_count')::int,
  1, 'idempotent re-claim does not count a new attempt');
select lives_ok(
  $$ select public.renew_task_lease(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1') $$,
  'the claiming worker can renew (heartbeat)');
select throws_ok(
  $$ select public.renew_task_lease(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-2') $$,
  '55000', null, 'another worker cannot renew the lease');
select public.start_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1');

-- Crash: the lease runs out.
select pg_temp.expire_lease(pg_temp.id('t'));
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1', 'late') $$,
  '55000', null, 'a stale worker cannot complete after losing its lease');
select throws_ok(
  $$ select public.report_progress(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1', 'late') $$,
  '55000', null, 'a stale worker cannot report progress after losing its lease');
select is(
  public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g')) -> 0 ->> 'status',
  'queued', 'an expired lease requeues the task and it is redelivered');
select is(
  public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g')) -> 0 ->> 'claim_ref',
  null, 'the requeued task no longer carries the old claim');
select is(
  (public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-2') ->> 'status'),
  'claimed', 'a fresh worker can claim the requeued task');
select is((pg_temp.task(pg_temp.id('t'))).attempt_count, 2, 'second attempt counted');
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1', 'late') $$,
  '55000', null, 'the old worker still cannot complete while the new one holds the lease');
select is(
  (public.complete_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-2', 'done') ->> 'status'),
  'completed', 'the fresh worker completes');
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t'), 'worker-1', 'again') $$,
  '55000', null, 'completion happens exactly once');
select pg_temp.expire_lease(pg_temp.id('t'));
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g'))), 0, 'completed tasks are never requeued');
select is((pg_temp.task(pg_temp.id('t'))).status, 'completed', 'completed stays terminal');
reset role;
select is(
  (select count(*)::int from public.messages where task_id = pg_temp.id('t') and message_type = 'result'),
  1, 'exactly one result message');
select pg_temp.act_as_client();

-- Bounded retries: three expiries exhaust the task.
select pg_temp.put('t2', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'Crashy', 'x') ->> 'task_id');
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w-a');
select pg_temp.expire_lease(pg_temp.id('t2'));
select public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g'));
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w-b');
select pg_temp.expire_lease(pg_temp.id('t2'));
select public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g'));
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w-c');
select is((pg_temp.task(pg_temp.id('t2'))).attempt_count, 3, 'third attempt counted');
select pg_temp.expire_lease(pg_temp.id('t2'));
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g'), pg_temp.id('s_g'))), 0, 'an exhausted task is not redelivered');
select results_eq(
  $$ select status, failure_reason from pg_temp.task(pg_temp.id('t2')) $$,
  $$ values ('failed'::text, 'lease_exhausted'::text) $$,
  'after max_attempts expiries the task fails with lease_exhausted');
select matches(
  public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t2')) ->> 'error',
  'Claim lease expired 3 time', 'the origin receives the lease-exhaustion error');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t2'), 'w-d') $$,
  '55000', null, 'a failed task cannot be reclaimed');
reset role;

-- Integrity of the state machine around leases.
select pg_temp.act_as_client();
select pg_temp.put('t3', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'Live', 'x') ->> 'task_id');
select public.claim_task(pg_temp.h('a-g'), pg_temp.id('s_g'), pg_temp.id('t3'), 'w-live');
reset role;
select throws_ok(
  $$ update public.tasks set status = 'queued', claim_ref = null where id = pg_temp.id('t3') $$,
  '42501', null, 'a task with a live lease cannot be requeued, even by a privileged writer');
select throws_ok(
  $$ update public.tasks set attempt_count = 0 where id = pg_temp.id('t3') $$,
  '42501', null, 'attempt count cannot be reset');
select throws_ok(
  $$ update public.tasks set max_attempts = 10 where id = pg_temp.id('t3') $$,
  '42501', null, 'max_attempts is immutable');

-- ---------------------------------------------------------------------------
-- Controller task listing
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select ok(jsonb_array_length(public.list_origin_tasks(pg_temp.h('a-c'), pg_temp.id('s_c'))) >= 3,
  'controller lists its own tasks');
select is(public.list_origin_tasks(pg_temp.h('a-c'), pg_temp.id('s_c')) -> 0 ->> 'content', null,
  'task listing carries no content');
select throws_ok($$ select public.list_origin_tasks(pg_temp.h('a-g'), pg_temp.id('s_g')) $$,
  '42501', null, 'agents cannot use the controller listing');
select is(jsonb_array_length(public.list_origin_tasks(pg_temp.h('b-c'), pg_temp.id('s_bc'))), 0,
  'User B sees none of User A tasks');
select throws_ok($$ select public.list_origin_tasks(pg_temp.h('b-c'), pg_temp.id('s_c')) $$,
  'P0002', null, 'User B cannot list User A session tasks');
reset role;

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select lives_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'burst', 'x')
     from generate_series(1, 27) $$,
  'up to 30 tasks per 10 minutes per origin session');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l'), 'one too many', 'x') $$,
  '54000', 'task creation rate limit reached', 'the 31st task in the window is rejected');

select lives_ok(
  $$ select pg_temp.put('ag' || g, public.register_session(pg_temp.h('a-g'), null, null, 'ag' || g) ->> 'id')
     from generate_series(1, 11) g $$,
  'setup: eleven agent sessions');
select lives_ok(
  $$ select public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('ag' || g)) from generate_series(1, 10) g $$,
  'up to 10 pending pairing requests per controller session');
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('ag11')) $$,
  '54000', 'pending pairing limit reached', 'the 11th pending request is rejected');
reset role;

-- ---------------------------------------------------------------------------
-- Owner-initiated pairing (dashboard); agent approval still required
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('s_c2', public.register_session(pg_temp.h('a-c'), 'Chat 2', null, 'c2') ->> 'id');
select pg_temp.put('s_g2', public.register_session(pg_temp.h('a-g'), 'Bridge 2', null, 'g2') ->> 'id');
reset role;
select pg_temp.act_as_user('user_LeaseAlice1');
select pg_temp.put('ol', public.owner_request_pairing(pg_temp.id('s_c2'), pg_temp.id('s_g2')) ->> 'id');
select is((select status from public.thread_links where id = pg_temp.id('ol')), 'pending',
  'owner-initiated pairing starts pending (never auto-activated)');
select throws_ok($$ select public.owner_request_pairing(pg_temp.id('s_c2'), pg_temp.id('s_c')) $$,
  'P0002', null, 'owner cannot pair two controller sessions');
reset role;
select pg_temp.act_as_user('user_LeaseBob002');
select throws_ok($$ select public.owner_request_pairing(pg_temp.id('s_c2'), pg_temp.id('s_g2')) $$,
  'P0002', null, 'User B cannot pair User A sessions');
select throws_ok($$ select public.owner_request_pairing(pg_temp.id('s_bc'), pg_temp.id('s_g2')) $$,
  'P0002', null, 'User B cannot pair their controller with User A agent');
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.owner_request_pairing(pg_temp.id('s_c2'), pg_temp.id('s_g2')) $$,
  '42501', null, 'anonymous cannot use owner pairing');
select is(
  (public.approve_pairing(pg_temp.h('a-g'), pg_temp.id('s_g2'), pg_temp.id('ol')) ->> 'status'),
  'active', 'the agent session approves the owner-initiated request');
select is(
  (public.list_session_links(pg_temp.h('a-c'), pg_temp.id('s_c2')) -> 0 ->> 'agent_display_name'),
  'Bridge 2', 'links expose safe counterpart display names');
reset role;

-- ---------------------------------------------------------------------------
-- OAuth: dynamic registration
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.oauth_clients', 'select'), 'anon cannot read oauth_clients');
select ok(not has_table_privilege('authenticated', 'public.oauth_authorization_codes', 'select'),
  'nobody can read authorization codes through the API');
select pg_temp.act_as_client();
select pg_temp.put('cli', public.register_oauth_client('ChatGPT', array['https://chatgpt.com/connector_platform_oauth_redirect']) ->> 'client_id');
select matches(pg_temp.id('cli'), '^tlcli_[0-9a-f]{32}$', 'client registered with a tlcli_ ID');
select throws_ok($$ select public.register_oauth_client('x', array['http://evil.example/cb']) $$,
  '22023', null, 'plain-http non-localhost redirect URIs are rejected');
select throws_ok($$ select public.register_oauth_client('x', array['javascript:alert(1)']) $$,
  '22023', null, 'non-URL redirect URIs are rejected');
select throws_ok($$ select public.register_oauth_client('x', array['https://a/1','https://a/2','https://a/3','https://a/4','https://a/5','https://a/6']) $$,
  '22023', null, 'at most 5 redirect URIs');
select throws_ok($$ select public.get_oauth_client(pg_temp.id('cli')) $$, '42501', null,
  'anonymous callers cannot look up clients');
select throws_ok(
  $$ select public.create_oauth_authorization(pg_temp.id('cli'), 'https://chatgpt.com/connector_platform_oauth_redirect',
       pg_temp.h('code-1'), pg_temp.s256(repeat('v', 43)), null) $$,
  '42501', null, 'anonymous callers cannot authorize');
reset role;

-- ---------------------------------------------------------------------------
-- OAuth: consent (Clerk session) + code exchange (PKCE verified in the DB)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_LeaseAlice1');
select is(public.get_oauth_client(pg_temp.id('cli')) ->> 'client_name', 'ChatGPT', 'signed-in user sees the client name');
select throws_ok(
  $$ select public.create_oauth_authorization(pg_temp.id('cli'), 'https://attacker.example/cb',
       pg_temp.h('code-x'), pg_temp.s256(repeat('v', 43)), null) $$,
  'P0002', null, 'an unregistered redirect URI is refused');
select lives_ok(
  $$ select public.create_oauth_authorization(pg_temp.id('cli'), 'https://chatgpt.com/connector_platform_oauth_redirect',
       pg_temp.h('code-1'), pg_temp.s256(repeat('v', 43)), 'https://tl.example/mcp') $$,
  'the signed-in owner authorizes the client');
reset role;

select pg_temp.act_as_client();
select throws_ok(
  $$ select public.exchange_oauth_code(pg_temp.h('code-1'), repeat('w', 43), pg_temp.id('cli'),
       'https://chatgpt.com/connector_platform_oauth_redirect', 'https://tl.example/mcp', pg_temp.h('tok-1'), 'tlc_tok001') $$,
  '22023', 'invalid_grant', 'a wrong PKCE verifier is rejected');
select throws_ok(
  $$ select public.exchange_oauth_code(pg_temp.h('code-1'), repeat('v', 43), pg_temp.id('cli'),
       'https://chatgpt.com/other', 'https://tl.example/mcp', pg_temp.h('tok-1'), 'tlc_tok001') $$,
  '22023', 'invalid_grant', 'a mismatched redirect URI is rejected');
select throws_ok(
  $$ select public.exchange_oauth_code(pg_temp.h('code-1'), repeat('v', 43), pg_temp.id('cli'),
       'https://chatgpt.com/connector_platform_oauth_redirect', 'https://other.example/mcp', pg_temp.h('tok-1'), 'tlc_tok001') $$,
  '22023', 'invalid_grant', 'a mismatched resource is rejected');
select pg_temp.put('conn', public.exchange_oauth_code(pg_temp.h('code-1'), repeat('v', 43), pg_temp.id('cli'),
  'https://chatgpt.com/connector_platform_oauth_redirect', 'https://tl.example/mcp', pg_temp.h('tok-1'), 'tlc_tok001') ->> 'connection_id');
select matches(pg_temp.id('conn'), '^tlcon_', 'a valid code + verifier issues a connection credential');
select results_eq(
  $$ select public.authenticate_connection(pg_temp.h('tok-1')) ->> 'platform',
            public.authenticate_connection(pg_temp.h('tok-1')) ->> 'role',
            public.authenticate_connection(pg_temp.h('tok-1')) ->> 'owner_user_id' $$,
  $$ values ('chatgpt'::text, 'controller'::text, pg_temp.id('a_user')) $$,
  'the access token authenticates as the owner''s chatgpt/controller connection');
select throws_ok(
  $$ select public.exchange_oauth_code(pg_temp.h('code-1'), repeat('v', 43), pg_temp.id('cli'),
       'https://chatgpt.com/connector_platform_oauth_redirect', 'https://tl.example/mcp', pg_temp.h('tok-2'), 'tlc_tok002') $$,
  '22023', 'invalid_grant', 'authorization codes are single-use');
reset role;

-- Re-authorization reuses the same connection identity and rotates the credential.
select pg_temp.act_as_user('user_LeaseAlice1');
select public.create_oauth_authorization(pg_temp.id('cli'), 'https://chatgpt.com/connector_platform_oauth_redirect',
  pg_temp.h('code-2'), pg_temp.s256(repeat('z', 50)), null);
reset role;
select pg_temp.act_as_client();
select is(
  public.exchange_oauth_code(pg_temp.h('code-2'), repeat('z', 50), pg_temp.id('cli'),
    'https://chatgpt.com/connector_platform_oauth_redirect', null, pg_temp.h('tok-3'), 'tlc_tok003') ->> 'connection_id',
  pg_temp.id('conn'), 're-authorizing the same client reuses the connection (no duplicates)');
select is(public.authenticate_connection(pg_temp.h('tok-1')), null, 'the previous access token stops working');
select isnt(public.authenticate_connection(pg_temp.h('tok-3')), null, 'the new access token works');
reset role;

-- Expired codes and cross-user isolation.
select pg_temp.act_as_user('user_LeaseBob002');
select public.create_oauth_authorization(pg_temp.id('cli'), 'https://chatgpt.com/connector_platform_oauth_redirect',
  pg_temp.h('code-b'), pg_temp.s256(repeat('b', 43)), null);
reset role;
update public.oauth_authorization_codes set expires_at = now() - interval '1 second' where code_hash = pg_temp.h('code-b');
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.exchange_oauth_code(pg_temp.h('code-b'), repeat('b', 43), pg_temp.id('cli'),
       'https://chatgpt.com/connector_platform_oauth_redirect', null, pg_temp.h('tok-b'), 'tlc_tokbbb') $$,
  '22023', 'invalid_grant', 'expired codes are rejected');
reset role;
select pg_temp.act_as_user('user_LeaseBob002');
select is_empty($$ select 1 from public.connections where id = pg_temp.id('conn') $$,
  'User B cannot see User A''s ChatGPT connection');
reset role;
select pg_temp.act_as_user('user_LeaseAlice1');
select public.revoke_connection(pg_temp.id('conn'));
reset role;
select is(public.authenticate_connection(pg_temp.h('tok-3')), null, 'revoking the ChatGPT connection disables the MCP token');

select * from finish();
rollback;
