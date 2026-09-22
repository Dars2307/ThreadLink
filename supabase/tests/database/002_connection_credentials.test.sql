-- ThreadLink Phase 3: connection credentials, revocation, rotation, audit (pgTAP).
-- LOCAL disposable stack only; single rolled-back transaction.
-- Credential hashes here are fake 64-hex strings; no real tokens are used.

begin;

create extension if not exists pgtap with schema extensions;

select plan(63);

create function pg_temp.act_as_user(sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sub, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end;
$$;

create function pg_temp.h(seed text) returns text language sql as $$
  select md5(seed) || md5(seed || ':2');
$$;

grant execute on all functions in schema pg_temp to anon, authenticated;

create temp table ids (name text primary key, value text) on commit drop;
grant select, insert, update on ids to anon, authenticated;

create function pg_temp.id(n text) returns text language sql as $$
  select value from ids where name = n;
$$;
grant execute on function pg_temp.id(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Structure and privileges
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.connection_credentials'::regclass),
  'RLS enabled on connection_credentials');
select ok((select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass),
  'RLS enabled on audit_events');
select ok(not has_column_privilege('authenticated', 'public.connection_credentials', 'token_hash', 'select'),
  'authenticated can never SELECT token_hash');
select ok(has_column_privilege('authenticated', 'public.connection_credentials', 'token_prefix', 'select'),
  'authenticated can SELECT the non-secret token_prefix');
select ok(not has_table_privilege('authenticated', 'public.connection_credentials', 'insert'),
  'authenticated cannot INSERT credentials directly');
select ok(not has_table_privilege('authenticated', 'public.connection_credentials', 'update'),
  'authenticated cannot UPDATE credentials directly');
select ok(not has_table_privilege('authenticated', 'public.audit_events', 'insert'),
  'authenticated cannot INSERT audit events');
select ok(not has_table_privilege('anon', 'public.connection_credentials', 'select'),
  'anon has no access to credentials');
select ok(not has_table_privilege('anon', 'public.audit_events', 'select'),
  'anon has no access to audit events');
select ok(not has_column_privilege('authenticated', 'public.connections', 'last_seen_at', 'update'),
  'authenticated cannot set last_seen_at');
select ok(not has_function_privilege('anon', 'public.register_connection(text,text,text,text,text)', 'execute'),
  'anon cannot register connections');
select ok(not has_function_privilege('anon', 'public.revoke_connection(text)', 'execute'),
  'anon cannot revoke connections');
select ok(not has_function_privilege('anon', 'public.rotate_connection_credential(text,text,text)', 'execute'),
  'anon cannot rotate credentials');
select ok(has_function_privilege('anon', 'public.authenticate_connection(text)', 'execute'),
  'anon can call authenticate_connection (clients have no Clerk session)');

-- ---------------------------------------------------------------------------
-- Fixtures: provision A and B through the real function
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_CredAlice01');
select public.provision_current_user('Alice', null);
insert into ids values ('a_user', (select id from public.users));
insert into ids values ('a_gpt', (select public.register_connection('chatgpt', 'controller', 'Alice ChatGPT', pg_temp.h('a-gpt'), 'tlc_agpt01') ->> 'id'));
insert into ids values ('a_cc', (select public.register_connection('claude-code', 'agent', 'Alice laptop', pg_temp.h('a-cc'), 'tlc_acc001') ->> 'id'));
reset role;

select pg_temp.act_as_user('user_CredBob002');
select public.provision_current_user('Bob', null);
insert into ids values ('b_user', (select id from public.users));
insert into ids values ('b_cc', (select public.register_connection('claude-code', 'agent', 'Bob laptop', pg_temp.h('b-cc'), 'tlc_bcc001') ->> 'id'));
reset role;

-- ---------------------------------------------------------------------------
-- Registration (User A)
-- ---------------------------------------------------------------------------
select matches(pg_temp.id('a_gpt'), '^tlcon_[0-9a-f]{32}$', 'ChatGPT connection has a tlcon_ ID');
select matches(pg_temp.id('a_cc'), '^tlcon_[0-9a-f]{32}$', 'Claude Code connection has a tlcon_ ID');

select results_eq(
  $$ select platform, role, status, owner_user_id from public.connections where id = pg_temp.id('a_gpt') $$,
  $$ values ('chatgpt'::text, 'controller'::text, 'active'::text, pg_temp.id('a_user')) $$,
  'ChatGPT controller connection registered for User A'
);
select results_eq(
  $$ select platform, role, owner_user_id from public.connections where id = pg_temp.id('a_cc') $$,
  $$ values ('claude-code'::text, 'agent'::text, pg_temp.id('a_user')) $$,
  'Claude Code agent connection registered for User A'
);
select is(
  (select token_hash from public.connection_credentials where connection_id = pg_temp.id('a_gpt')),
  pg_temp.h('a-gpt'),
  'only the hash is stored for the credential'
);
select matches(
  (select id from public.connection_credentials where connection_id = pg_temp.id('a_gpt')),
  '^tlcrd_[0-9a-f]{32}$',
  'credential has a tlcrd_ ID'
);

select pg_temp.act_as_user('user_CredAlice01');
select results_eq(
  $$ select count(*)::int from public.connections $$,
  array[2],
  'User A sees exactly their two connections'
);
select results_eq(
  $$ select token_prefix from public.connection_credentials where connection_id = pg_temp.id('a_gpt') $$,
  array['tlc_agpt01'::text],
  'User A can read their credential fingerprint'
);
select throws_ok(
  $$ select token_hash from public.connection_credentials $$,
  '42501', null,
  'User A cannot read credential hashes, even their own'
);
select throws_ok(
  $$ select * from public.connection_credentials $$,
  '42501', null,
  'SELECT * on credentials is denied (hash column is not granted)'
);

-- ---------------------------------------------------------------------------
-- Cross-tenant denial (User A vs User B)
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select 1 from public.connections where id = pg_temp.id('b_cc') $$,
  'User A cannot view User B connection'
);
select is_empty(
  $$ select 1 from public.connection_credentials where connection_id = pg_temp.id('b_cc') $$,
  'User A cannot view User B credential metadata'
);
select is_empty(
  $$ select 1 from public.connection_credentials where owner_user_id = pg_temp.id('b_user') $$,
  'User A cannot enumerate User B credentials by owner'
);
select throws_ok(
  $$ select public.revoke_connection(pg_temp.id('b_cc')) $$,
  'P0002', 'connection not found',
  'User A cannot revoke User B connection'
);
select throws_ok(
  $$ select public.revoke_connection('tlcon_00000000000000000000000000000000') $$,
  'P0002', 'connection not found',
  'nonexistent connection gives the identical error (no existence oracle)'
);
select throws_ok(
  $$ select public.rotate_connection_credential(pg_temp.id('b_cc'), pg_temp.h('steal'), 'tlc_steal1') $$,
  'P0002', 'connection not found',
  'User A cannot rotate/reissue User B credential'
);
select throws_ok(
  $$ update public.connection_credentials set revoked_at = now() where connection_id = pg_temp.id('b_cc') $$,
  '42501', null,
  'User A cannot revoke User B credential directly'
);
select is_empty(
  $$ select 1 from public.audit_events where owner_user_id = pg_temp.id('b_user') $$,
  'User A cannot read User B audit events'
);
select throws_ok(
  $$ select public.register_connection('chatgpt', 'controller', null, pg_temp.h('b-cc'), 'tlc_dup001') $$,
  '23505', null,
  'a credential hash cannot be registered twice (no claiming another credential)'
);
reset role;

-- ---------------------------------------------------------------------------
-- Connection authentication (as anon, like a client with only a token)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_anon();
select is(
  (select public.authenticate_connection(pg_temp.h('a-cc')) ->> 'connection_id'),
  pg_temp.id('a_cc'),
  'valid credential resolves to its connection'
);
select is(
  (select public.authenticate_connection(pg_temp.h('a-cc')) ->> 'owner_user_id'),
  pg_temp.id('a_user'),
  'valid credential resolves to its owner'
);
select is(
  (select public.authenticate_connection(pg_temp.h('a-cc'))) ?& array['connection_id','owner_user_id','platform','role','status'],
  true,
  'identity object has the expected fields'
);
select is(public.authenticate_connection(pg_temp.h('random-guess')), null, 'random credential fails');
select is(public.authenticate_connection('not-a-hash'), null, 'malformed hash fails');
select is(public.authenticate_connection(null), null, 'missing hash fails');
select is(public.authenticate_connection(upper(pg_temp.h('a-cc'))), null, 'hash is matched exactly');
reset role;

select isnt(
  (select last_used_at from public.connection_credentials where connection_id = pg_temp.id('a_cc')),
  null,
  'successful authentication records last_used_at'
);
select isnt(
  (select last_seen_at from public.connections where id = pg_temp.id('a_cc')),
  null,
  'successful authentication records connection last_seen_at'
);

-- ---------------------------------------------------------------------------
-- Rotation (User A, own connection)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_CredAlice01');
select lives_ok(
  $$ select public.rotate_connection_credential(pg_temp.id('a_gpt'), pg_temp.h('a-gpt-v2'), 'tlc_agpt02') $$,
  'User A can rotate their own credential'
);
reset role;
select pg_temp.act_as_anon();
select is(public.authenticate_connection(pg_temp.h('a-gpt')), null, 'old credential stops working after rotation');
select is(
  (select public.authenticate_connection(pg_temp.h('a-gpt-v2')) ->> 'connection_id'),
  pg_temp.id('a_gpt'),
  'new credential works after rotation'
);
reset role;
select is(
  (select count(*)::int from public.connection_credentials where connection_id = pg_temp.id('a_gpt') and revoked_at is null),
  1,
  'exactly one active credential after rotation'
);

-- ---------------------------------------------------------------------------
-- Revocation (User A, own connection)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_CredAlice01');
select is(
  (select public.revoke_connection(pg_temp.id('a_cc')) ->> 'status'),
  'revoked',
  'User A can revoke their own connection'
);
reset role;
select pg_temp.act_as_anon();
select is(public.authenticate_connection(pg_temp.h('a-cc')), null, 'revoked credential fails immediately');
reset role;
select pg_temp.act_as_user('user_CredAlice01');
select is(
  (select public.revoke_connection(pg_temp.id('a_cc')) ->> 'status'),
  'revoked',
  'repeated revocation is idempotent'
);
select throws_ok(
  $$ update public.connections set status = 'active' where id = pg_temp.id('a_cc') $$,
  '42501', null,
  'revoked connection cannot be silently reactivated'
);
select isnt(
  (select revoked_at from public.connection_credentials where connection_id = pg_temp.id('a_cc')),
  null,
  'revoking the connection revokes its credential'
);
select results_eq(
  $$ select count(*)::int from public.connections where id = pg_temp.id('a_cc') $$,
  array[1],
  'revoked connection remains visible in history'
);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select action, count(*)::int from public.audit_events group by action order by action $$,
  $$ values ('connection.auth_failed'::text, 2), ('connection.created', 2),
            ('connection.credential_rotated', 1), ('connection.revoked', 1) $$,
  'audit trail records creates, rotation, one revocation, and both uses of superseded/revoked credentials'
);
select is_empty(
  $$ select 1 from public.audit_events
     where metadata::text ~ '[0-9a-f]{64}' or metadata::text like '%tlc_%' $$,
  'audit metadata never contains hashes or tokens'
);
select throws_ok(
  $$ update public.audit_events set outcome = 'success' $$,
  '42501', null,
  'User A cannot tamper with audit events'
);
select throws_ok(
  $$ delete from public.audit_events $$,
  '42501', null,
  'User A cannot delete audit events'
);

-- ---------------------------------------------------------------------------
-- Abuse limit: 10 active connections per user
-- ---------------------------------------------------------------------------
-- A has 1 active (a_gpt) + 1 revoked. Register 9 more => 10 active.
select lives_ok(
  $$ select public.register_connection('claude-code', 'agent', null, pg_temp.h('cap' || g), 'tlc_cap' || lpad(g::text, 3, '0'))
     from generate_series(1, 9) as g $$,
  'User A can register up to 10 active connections (revoked ones do not count)'
);
select throws_ok(
  $$ select public.register_connection('claude-code', 'agent', null, pg_temp.h('cap-over'), 'tlc_capovr') $$,
  '54000', null,
  'the 11th active connection is rejected'
);
reset role;

-- ---------------------------------------------------------------------------
-- Anonymous / invalid identity
-- ---------------------------------------------------------------------------
select pg_temp.act_as_anon();
select throws_ok('select 1 from public.connection_credentials', '42501', null,
  'anonymous cannot read credentials');
select throws_ok('select 1 from public.audit_events', '42501', null,
  'anonymous cannot read audit events');
select throws_ok(
  $$ select public.register_connection('chatgpt', 'controller', null, pg_temp.h('anon'), 'tlc_anon01') $$,
  '42501', null,
  'anonymous cannot register a connection'
);
reset role;

select pg_temp.act_as_user('user_CredAlice01');
select throws_ok(
  $$ select public.register_connection('chatgpt', 'controller', null, 'tlc_rawTokenInsteadOfHash', 'tlc_raw001') $$,
  '22023', null,
  'raw tokens are rejected where a hash is expected'
);
reset role;

-- B is untouched throughout.
select pg_temp.act_as_anon();
select is(
  (select public.authenticate_connection(pg_temp.h('b-cc')) ->> 'connection_id'),
  pg_temp.id('b_cc'),
  'User B credential still works after all of User A''s attempts'
);
reset role;

select * from finish();
rollback;
