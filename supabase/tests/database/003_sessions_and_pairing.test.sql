-- ThreadLink Phase 4: session bindings + pairing (pgTAP). LOCAL disposable stack only.
-- Clients are simulated as `anon` presenting fake 64-hex credential HMACs.

begin;

create extension if not exists pgtap with schema extensions;

select plan(84);

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

create function pg_temp.h(seed text) returns text language sql as $$
  select md5(seed) || md5(seed || ':2');
$$;

create temp table ids (name text primary key, value text) on commit drop;
create function pg_temp.id(n text) returns text language sql as $$ select value from ids where name = n $$;
create function pg_temp.put(n text, v text) returns text language sql as $$
  insert into ids values (n, v) on conflict (name) do update set value = excluded.value returning value;
$$;

grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: A has controller C1, agents G1 and G2; B has controller BC, agent BG.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_PairAlice01');
select public.provision_current_user('Alice', null);
select pg_temp.put('a_user', (select id from public.users));
select pg_temp.put('a_c1', public.register_connection('chatgpt', 'controller', 'A ChatGPT', pg_temp.h('a-c1'), 'tlc_ac1aaa') ->> 'id');
select pg_temp.put('a_g1', public.register_connection('claude-code', 'agent', 'A laptop', pg_temp.h('a-g1'), 'tlc_ag1aaa') ->> 'id');
select pg_temp.put('a_g2', public.register_connection('claude-code', 'agent', 'A desktop', pg_temp.h('a-g2'), 'tlc_ag2aaa') ->> 'id');
select pg_temp.put('a_c3', public.register_connection('chatgpt', 'controller', 'A ChatGPT 2', pg_temp.h('a-c3'), 'tlc_ac3aaa') ->> 'id');
reset role;

select pg_temp.act_as_user('user_PairBob0002');
select public.provision_current_user('Bob', null);
select pg_temp.put('b_user', (select id from public.users));
select pg_temp.put('b_c', public.register_connection('chatgpt', 'controller', null, pg_temp.h('b-c'), 'tlc_bcaaaa') ->> 'id');
select pg_temp.put('b_g', public.register_connection('claude-code', 'agent', null, pg_temp.h('b-g'), 'tlc_bgaaaa') ->> 'id');
reset role;

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.session_bindings'::regclass), 'RLS on session_bindings');
select ok((select relrowsecurity from pg_class where oid = 'public.thread_links'::regclass), 'RLS on thread_links');
select ok(not has_table_privilege('anon', 'public.session_bindings', 'select'), 'anon cannot read sessions');
select ok(not has_table_privilege('anon', 'public.thread_links', 'select'), 'anon cannot read links');
select ok(not has_table_privilege('authenticated', 'public.session_bindings', 'insert'), 'no direct session INSERT');
select ok(not has_table_privilege('authenticated', 'public.session_bindings', 'update'), 'no direct session UPDATE');
select ok(not has_table_privilege('authenticated', 'public.thread_links', 'insert'), 'no direct link INSERT');
select ok(not has_table_privilege('authenticated', 'public.thread_links', 'update'), 'no direct link UPDATE');
select ok(not has_table_privilege('authenticated', 'public.thread_links', 'delete'), 'no link DELETE (history kept)');
select ok(not has_function_privilege('anon', 'public.revoke_thread_link(text)', 'execute'), 'anon cannot use the owner revoke');
select ok(
  (select count(*) = 0 from public.connection_credentials where token_hash = pg_temp.h('a-g1')),
  'credential HMACs are not stored at rest (only their sha256)'
);

-- ---------------------------------------------------------------------------
-- Session registration & identity
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('s_c1', public.register_session(pg_temp.h('a-c1'), 'Planning chat', null, 'chat-local-1') ->> 'id');
select pg_temp.put('s_g1', public.register_session(pg_temp.h('a-g1'), 'repo: threadlink', 'claude-native-123', 'cc-local-1') ->> 'id');
select pg_temp.put('s_g2', public.register_session(pg_temp.h('a-g2'), 'desktop', null, 'cc-local-2') ->> 'id');
select pg_temp.put('s_c3', public.register_session(pg_temp.h('a-c3'), null, null, 'chat-local-3') ->> 'id');

select matches(pg_temp.id('s_c1'), '^tlses_[0-9a-f]{32}$', 'session has a tlses_ ID');
select ok(pg_temp.id('s_g1') !~* '(alice|user_|repo|claude-native)', 'session ID contains no personal data or provider ref');
select is(
  (public.register_session(pg_temp.h('a-c1'), null, null, 'chat-local-1') ->> 'id'),
  pg_temp.id('s_c1'),
  'same connection + same local_binding_ref returns the same session'
);
select is(
  (public.register_session(pg_temp.h('a-c1'), null, null, 'chat-local-1') ->> 'created')::boolean,
  false,
  'reconnect is reported as not created'
);
select is(
  (public.register_session(pg_temp.h('a-c1'), 'Renamed chat', null, 'chat-local-1') ->> 'id'),
  pg_temp.id('s_c1'),
  'display-name change does not change tlses_ identity'
);
select is(
  (public.get_session(pg_temp.h('a-c1'), pg_temp.id('s_c1')) ->> 'display_name'),
  'Renamed chat',
  'display name updated as metadata only'
);
select is(
  (public.register_session(pg_temp.h('a-g1'), null, 'claude-native-456', 'cc-local-1') ->> 'id'),
  pg_temp.id('s_g1'),
  'provider_session_ref change does not create a new identity when local ref is unchanged'
);
select is(
  (public.get_session(pg_temp.h('a-g1'), pg_temp.id('s_g1')) ->> 'provider_session_ref'),
  'claude-native-456',
  'provider ref stored as optional metadata'
);
select lives_ok(
  $$ select pg_temp.put('s_nolocal', public.register_session(pg_temp.h('a-c1'), null, null, null) ->> 'id') $$,
  'missing provider_session_ref and local ref is allowed'
);
select isnt(
  (public.register_session(pg_temp.h('a-c1'), null, null, null) ->> 'id'),
  pg_temp.id('s_nolocal'),
  'without a local ref each registration is a new binding'
);
select isnt(
  (public.register_session(pg_temp.h('a-g2'), null, null, 'cc-local-1') ->> 'id'),
  pg_temp.id('s_g1'),
  'another connection cannot claim a binding by reusing its local ref'
);
select results_eq(
  $$ select public.get_session(pg_temp.h('a-g1'), pg_temp.id('s_g1')) ->> 'role',
            public.get_session(pg_temp.h('a-g1'), pg_temp.id('s_g1')) ->> 'platform' $$,
  $$ values ('agent'::text, 'claude-code'::text) $$,
  'role/platform come from the connection, not the client'
);
select throws_ok(
  $$ select public.get_session(pg_temp.h('a-g2'), pg_temp.id('s_g1')) $$,
  'P0002', 'session not found',
  'a connection cannot read another connection''s session'
);
select throws_ok(
  $$ select public.get_session(pg_temp.h('b-g'), pg_temp.id('s_g1')) $$,
  'P0002', 'session not found',
  'User B cannot read User A session'
);
select throws_ok(
  $$ select public.register_session(pg_temp.h('unknown'), null, null, null) $$,
  '28000', null,
  'unknown credential cannot register a session'
);
select throws_ok(
  $$ select public.register_session('not-a-hash', null, null, null) $$,
  '28000', null,
  'malformed credential cannot register a session'
);
select throws_ok(
  $$ select public.register_session(pg_temp.h('a-c1'), null, null, 'bad ref with spaces') $$,
  '23514', null,
  'invalid local_binding_ref is rejected'
);
reset role;

-- User B registers sessions.
select pg_temp.act_as_client();
select pg_temp.put('s_bc', public.register_session(pg_temp.h('b-c'), null, null, 'b-chat') ->> 'id');
select pg_temp.put('s_bg', public.register_session(pg_temp.h('b-g'), null, null, 'b-cc') ->> 'id');
reset role;

-- Human reads via RLS
select pg_temp.act_as_user('user_PairAlice01');
select ok(
  (select count(*) from public.session_bindings) >= 5
    and not exists (select 1 from public.session_bindings where owner_user_id <> pg_temp.id('a_user')),
  'User A dashboard sees only their own sessions'
);
select is_empty(
  $$ select 1 from public.session_bindings where id in (pg_temp.id('s_bc'), pg_temp.id('s_bg')) $$,
  'User A cannot view User B sessions'
);
reset role;

-- ---------------------------------------------------------------------------
-- Pairing request (controller -> agent)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('l1', public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g1')) ->> 'id');
select matches(pg_temp.id('l1'), '^tllnk_[0-9a-f]{32}$', 'link has a tllnk_ ID');
select is(
  (public.list_session_links(pg_temp.h('a-g1'), pg_temp.id('s_g1')) -> 0 ->> 'status'),
  'pending',
  'controller -> agent request is pending (never auto-activated)'
);
select is(
  (public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g1')) ->> 'id'),
  pg_temp.id('l1'),
  'duplicate pending request returns the existing link'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('s_g2')) $$,
  '42501', 'controller connection required',
  'an agent connection cannot initiate pairing'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_c3')) $$,
  'P0002', 'session not found',
  'role mismatch: controller cannot pair with another controller'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c3'), pg_temp.id('s_g1')) $$,
  'P0002', 'session not found',
  'controller cannot request on behalf of a session owned by another connection'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_bg')) $$,
  'P0002', 'session not found',
  'User A cannot create a link to User B session (same-owner enforced)'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('b-c'), pg_temp.id('s_bc'), pg_temp.id('s_g1')) $$,
  'P0002', 'session not found',
  'User B cannot target User A agent session'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), 'tlses_00000000000000000000000000000000') $$,
  'P0002', 'session not found',
  'nonexistent target is indistinguishable from another user''s session'
);

-- ---------------------------------------------------------------------------
-- Approval (agent side only, exact agent session)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('l1')) $$,
  '42501', 'agent connection required',
  'controller cannot approve (no self-approval)'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('l1')) $$,
  'P0002', 'thread link not found',
  'wrong agent cannot approve a pairing targeted to another agent session'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-g2'), pg_temp.id('s_g1'), pg_temp.id('l1')) $$,
  'P0002', 'session not found',
  'an agent connection cannot approve using another connection''s session'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('b-g'), pg_temp.id('s_bg'), pg_temp.id('l1')) $$,
  'P0002', 'thread link not found',
  'User B cannot approve User A pairing'
);
select is(
  (public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1')) ->> 'status'),
  'active',
  'target agent approves -> active'
);
select isnt(
  (public.list_session_links(pg_temp.h('a-c1'), pg_temp.id('s_c1')) -> 0 ->> 'approved_at'),
  null,
  'approval time recorded'
);
select is(
  (public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1')) ->> 'status'),
  'active',
  'repeated approval is idempotent'
);
select is(
  (public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g1')) ->> 'id'),
  pg_temp.id('l1'),
  'duplicate request for an active pair returns the active link (no duplicate)'
);
reset role;
select is(
  (select count(*)::int from public.thread_links
   where controller_session_id = pg_temp.id('s_c1') and agent_session_id = pg_temp.id('s_g1')),
  1,
  'exactly one link row for the pair'
);

-- One controller may hold links to several agents.
select pg_temp.act_as_client();
select pg_temp.put('l2', public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g2')) ->> 'id');
select isnt(pg_temp.id('l2'), pg_temp.id('l1'), 'a controller session may pair with a second agent session');
select is(
  jsonb_array_length(public.list_session_links(pg_temp.h('a-g2'), pg_temp.id('s_g2'))),
  1,
  'agent sees exactly the pending request targeted at it'
);
reset role;

-- ---------------------------------------------------------------------------
-- Cross-user revocation / owner revocation
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.revoke_pairing(pg_temp.h('b-g'), pg_temp.id('s_bg'), pg_temp.id('l1')) $$,
  'P0002', 'thread link not found',
  'User B cannot revoke User A link via a client'
);
select throws_ok(
  $$ select public.revoke_pairing(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('l1')) $$,
  'P0002', 'thread link not found',
  'a non-participant session cannot revoke a link'
);
reset role;

select pg_temp.act_as_user('user_PairBob0002');
select throws_ok(
  $$ select public.revoke_thread_link(pg_temp.id('l1')) $$,
  'P0002', 'thread link not found',
  'User B cannot revoke User A link from the dashboard'
);
select is_empty($$ select 1 from public.thread_links where id = pg_temp.id('l1') $$, 'User B cannot view User A links');
reset role;

select pg_temp.act_as_user('user_PairAlice01');
select results_eq(
  $$ select status from public.thread_links where id = pg_temp.id('l1') $$,
  array['active'::text],
  'User A sees their active link'
);
select is(
  (public.revoke_thread_link(pg_temp.id('l2')) ->> 'status'),
  'revoked',
  'owner can revoke a pending link from the dashboard'
);
reset role;

-- ---------------------------------------------------------------------------
-- Revoke active pair; history; new pair gets new ID
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select is(
  (public.revoke_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('l1')) ->> 'revoked_reason'),
  'revoked_by_controller',
  'controller can revoke an active pair'
);
select is(
  (public.revoke_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1')) ->> 'status'),
  'revoked',
  'repeated revocation is idempotent'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1')) $$,
  '55000', null,
  'revoked pair cannot be reactivated'
);
select pg_temp.put('l3', public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g1')) ->> 'id');
select isnt(pg_temp.id('l3'), pg_temp.id('l1'), 'a new pair after revocation gets a new tllnk_ ID');
select is(
  (public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l3')) ->> 'status'),
  'active',
  'the new pair can be approved'
);
reset role;
select is(
  (select count(*)::int from public.thread_links
   where controller_session_id = pg_temp.id('s_c1') and agent_session_id = pg_temp.id('s_g1')),
  2,
  'revoked link stays in history alongside the new one'
);
select throws_ok(
  $$ update public.thread_links set status = 'active' where id = pg_temp.id('l1') $$,
  '42501', null,
  'even a privileged writer cannot un-revoke a link'
);

-- ---------------------------------------------------------------------------
-- Cascade: session retirement
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('l4', public.request_pairing(pg_temp.h('a-c3'), pg_temp.id('s_c3'), pg_temp.id('s_g2')) ->> 'id');
select is(
  (public.retire_session(pg_temp.h('a-g2'), pg_temp.id('s_g2')) ->> 'status'),
  'retired',
  'agent can retire its own session'
);
select is(
  (public.list_session_links(pg_temp.h('a-c3'), pg_temp.id('s_c3')) -> 0 ->> 'revoked_reason'),
  'agent_session_ended',
  'retiring a session revokes its pending link immediately'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('l4')) $$,
  '55000', null,
  'retired session cannot approve pairing'
);
select throws_ok(
  $$ select public.register_session(pg_temp.h('a-g2'), null, null, 'cc-local-2') $$,
  '55000', 'session binding is no longer active',
  'retired binding cannot silently reactivate via its local ref'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c3'), pg_temp.id('s_c3'), pg_temp.id('s_g2')) $$,
  'P0002', 'session not found',
  'retired session cannot be paired'
);
select is(
  (public.retire_session(pg_temp.h('a-g2'), pg_temp.id('s_g2')) ->> 'status'),
  'retired',
  'retirement is idempotent'
);
reset role;
select throws_ok(
  $$ update public.session_bindings set status = 'active' where id = pg_temp.id('s_g2') $$,
  '42501', null,
  'even a privileged writer cannot reactivate a retired session'
);

-- ---------------------------------------------------------------------------
-- Cascade: connection revocation
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_PairAlice01');
select public.revoke_connection(pg_temp.id('a_g1'));
reset role;
select is(
  (select status from public.session_bindings where id = pg_temp.id('s_g1')),
  'revoked',
  'revoking a connection revokes its sessions'
);
select is(
  (select revoked_reason from public.thread_links where id = pg_temp.id('l3')),
  'agent_session_ended',
  'revoking a connection revokes its active links'
);
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.register_session(pg_temp.h('a-g1'), null, null, 'cc-local-new') $$,
  '28000', null,
  'revoked connection cannot register a session'
);
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l3')) $$,
  '28000', null,
  'revoked connection cannot approve'
);
select throws_ok(
  $$ select public.list_session_links(pg_temp.h('a-g1'), pg_temp.id('s_g1')) $$,
  '28000', null,
  'revoked connection cannot use its sessions at all'
);
select throws_ok(
  $$ select public.request_pairing(pg_temp.h('a-c1'), pg_temp.id('s_c1'), pg_temp.id('s_g1')) $$,
  'P0002', 'session not found',
  'sessions of a revoked connection cannot be paired'
);

-- Impersonation: a controller credential cannot act as the agent connection.
select throws_ok(
  $$ select public.approve_pairing(pg_temp.h('a-c1'), pg_temp.id('s_g1'), pg_temp.id('l3')) $$,
  '42501', 'agent connection required',
  'controller A cannot impersonate agent A'
);
reset role;

-- ---------------------------------------------------------------------------
-- Integrity: cross-owner and wrong-role links are unrepresentable
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.thread_links (owner_user_id, controller_session_id, agent_session_id)
     values (pg_temp.id('a_user'), pg_temp.id('s_c1'), pg_temp.id('s_bg')) $$,
  '23503', null,
  'a cross-owner link violates the composite foreign key'
);
select throws_ok(
  $$ insert into public.thread_links (owner_user_id, controller_session_id, agent_session_id)
     values (pg_temp.id('a_user'), pg_temp.id('s_c1'), pg_temp.id('s_c3')) $$,
  '23514', null,
  'a controller-controller link is rejected by the role trigger'
);

-- ---------------------------------------------------------------------------
-- Audit + anonymous
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_PairAlice01');
select ok(
  (select count(distinct action) from public.audit_events
   where action in ('session.registered', 'session.retired', 'link.requested', 'link.approved', 'link.revoked')) = 5,
  'session and link lifecycle is audited'
);
select is_empty(
  $$ select 1 from public.audit_events where metadata::text ~ '[0-9a-f]{64}' $$,
  'audit metadata contains no credential material'
);
reset role;

select pg_temp.act_as_client();
select throws_ok('select 1 from public.session_bindings', '42501', null, 'anonymous cannot read sessions');
select throws_ok('select 1 from public.thread_links', '42501', null, 'anonymous cannot read links');
select throws_ok(
  $$ select public.list_session_links(null, pg_temp.id('s_c1')) $$,
  '28000', null,
  'no credential, no access'
);
reset role;

select * from finish();
rollback;
