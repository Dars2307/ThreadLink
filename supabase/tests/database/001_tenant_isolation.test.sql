-- ThreadLink tenant isolation tests (pgTAP). Run with: supabase test db
--
-- Runs against the LOCAL disposable Supabase stack only. Everything happens in
-- one transaction that is rolled back, so no data persists.
--
-- Callers are simulated exactly as PostgREST does it: switch to the `anon` or
-- `authenticated` role and set `request.jwt.claims`. Only RLS and grants stand
-- between the caller and other users' rows.

begin;

create extension if not exists pgtap with schema extensions;

select plan(52);

-- ---------------------------------------------------------------------------
-- Helpers (pg_temp: vanish with the session)
-- ---------------------------------------------------------------------------
create function pg_temp.act_as(claims jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', coalesce(claims::text, ''), true);
  execute 'set local role authenticated';
end;
$$;

create function pg_temp.act_as_user(sub text) returns void language sql as $$
  select pg_temp.act_as(jsonb_build_object('sub', sub, 'role', 'authenticated'));
$$;

create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
end;
$$;

-- Executes a DML statement as the current role and returns the affected row count.
create function pg_temp.rows_affected(stmt text) returns int language plpgsql as $$
declare n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Deterministic fake credential hash (64 hex). Tests never use real tokens.
create function pg_temp.fake_hash(seed text) returns text language sql as $f$
  select md5(seed) || md5(seed || ':2');
$f$;

grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Structural guarantees
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'RLS is enabled on every table in public'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public'
       and (btrim(coalesce(qual, '')) in ('true', '(true)')
         or btrim(coalesce(with_check, '')) in ('true', '(true)')) $$,
  'no permissive USING (true) / WITH CHECK (true) policies'
);

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and not ('authenticated' = any (roles)) $$,
  'every policy is scoped to the authenticated role only'
);

select ok(not has_table_privilege('anon', 'public.users', 'select'), 'anon has no SELECT on users');
select ok(not has_table_privilege('anon', 'public.connections', 'select'), 'anon has no SELECT on connections');
select ok(not has_table_privilege('authenticated', 'public.users', 'insert'), 'authenticated cannot INSERT users directly');
select ok(not has_table_privilege('authenticated', 'public.users', 'update'), 'authenticated cannot UPDATE users');
select ok(not has_table_privilege('authenticated', 'public.users', 'delete'), 'authenticated cannot DELETE users');
select ok(
  not has_column_privilege('authenticated', 'public.connections', 'owner_user_id', 'insert'),
  'authenticated cannot supply connections.owner_user_id on INSERT'
);
select ok(
  not has_column_privilege('authenticated', 'public.connections', 'owner_user_id', 'update'),
  'authenticated cannot UPDATE connections.owner_user_id'
);
select ok(
  not has_function_privilege('anon', 'public.provision_current_user(text, text)', 'execute'),
  'anon cannot execute provision_current_user'
);
select ok(
  not has_schema_privilege('anon', 'threadlink_private', 'usage'),
  'anon has no access to threadlink_private'
);

-- ---------------------------------------------------------------------------
-- Fixtures: User A provisions through the real function; User B's rows are
-- created as the migration owner to simulate another tenant's existing data.
-- ---------------------------------------------------------------------------
create temp table a_user (like public.users) on commit drop;
create temp table b_conn (id text, owner_user_id text) on commit drop;
grant select, insert on a_user to authenticated;
grant select on b_conn to authenticated, anon;

select pg_temp.act_as_user('user_AliceTest01');
insert into a_user select * from public.provision_current_user('Alice', 'Alice@Example.com');
reset role;

insert into public.users (clerk_user_id, display_name, primary_email)
values ('user_BobTest02', 'Bob', 'bob@example.com');

with ins as (
  insert into public.connections (owner_user_id, platform, role, display_name)
  select u.id, 'chatgpt', 'controller', 'Bob ChatGPT'
  from public.users as u where u.clerk_user_id = 'user_BobTest02'
  returning id, owner_user_id
)
insert into b_conn select * from ins;

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------
select matches((select id from a_user), '^tlusr_[0-9a-f]{32}$', 'provisioned user has a tlusr_ ID');
select is((select clerk_user_id from a_user), 'user_AliceTest01', 'provisioned user is mapped to the JWT subject');
select is((select primary_email from a_user), 'alice@example.com', 'email is normalised (metadata only)');

select pg_temp.act_as_user('user_AliceTest01');
select is(
  (select id from public.provision_current_user('Alice', 'alice@example.com')),
  (select id from a_user),
  'provisioning is idempotent: second call returns the same ThreadLink user'
);
select is(
  (select display_name from public.provision_current_user('Alice Renamed', 'alice@example.com')),
  'Alice Renamed',
  'profile metadata refreshes without changing identity'
);
select is(
  (select id from public.provision_current_user(null, null)),
  (select id from a_user),
  'renaming never changes the ThreadLink user ID'
);
select is(
  (select id from public.provision_current_user('Mallory', 'bob@example.com')),
  (select id from a_user),
  'claiming another user''s email does not switch identity'
);
-- Restore Alice's own email so later cross-tenant checks are unambiguous.
select public.provision_current_user('Alice', 'alice@example.com');
reset role;
select is(
  (select count(*)::int from public.users where clerk_user_id = 'user_AliceTest01'),
  1,
  'exactly one users row exists for User A after repeated provisioning'
);

-- ---------------------------------------------------------------------------
-- User A: positive access to own data
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_AliceTest01');

select results_eq(
  'select id from public.users',
  'select id from a_user',
  'User A can read exactly their own profile'
);

select lives_ok(
  $$ select public.register_connection('claude-code', 'agent', 'Alice laptop', pg_temp.fake_hash('a1'), 'tlc_aaaaaa') $$,
  'User A can register a connection'
);

select is(
  (select owner_user_id from public.connections where display_name = 'Alice laptop'),
  (select id from a_user),
  'new connection is owned by User A (owner derived server-side)'
);
select matches(
  (select id from public.connections where display_name = 'Alice laptop'),
  '^tlcon_[0-9a-f]{32}$',
  'new connection has a tlcon_ ID'
);
select is(
  (select status from public.connections where display_name = 'Alice laptop'),
  'active',
  'new connection defaults to active'
);

select results_eq(
  'select count(*)::int from public.connections',
  array[1],
  'User A sees only their own connection'
);

select is(
  pg_temp.rows_affected($$ update public.connections set display_name = 'Alice laptop 2' where display_name = 'Alice laptop' $$),
  1,
  'User A can update their own connection label'
);

-- ---------------------------------------------------------------------------
-- User A: cross-tenant denial
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select 1 from public.users where clerk_user_id = 'user_BobTest02' $$,
  'User A cannot read User B profile by Clerk ID'
);
select is_empty(
  $$ select 1 from public.users where primary_email = 'bob@example.com' $$,
  'User A cannot read User B profile by email'
);
select is_empty(
  $$ select 1 from public.connections where id = (select id from b_conn) $$,
  'User A cannot read User B connection by ID'
);
select is_empty(
  $$ select 1 from public.connections where owner_user_id = (select owner_user_id from b_conn) $$,
  'User A cannot enumerate User B connections by owner ID'
);

select is(
  pg_temp.rows_affected($$ update public.connections set display_name = 'pwned' where id = (select id from b_conn) $$),
  0,
  'User A cannot modify User B connection (0 rows affected)'
);
select throws_ok(
  $$ select public.revoke_connection((select id from b_conn)) $$,
  'P0002',
  null,
  'User A cannot revoke User B connection (looks nonexistent)'
);
select throws_ok(
  $$ delete from public.connections where id = (select id from b_conn) $$,
  '42501',
  null,
  'nobody can delete connections via the API (revocation history is preserved)'
);

select throws_ok(
  $$ insert into public.connections (owner_user_id, platform, role)
     values ((select owner_user_id from b_conn), 'chatgpt', 'controller') $$,
  '42501',
  null,
  'User A cannot create a connection owned by User B'
);
select throws_ok(
  $$ update public.connections set owner_user_id = (select owner_user_id from b_conn) $$,
  '42501',
  null,
  'User A cannot reassign their connection to User B'
);
select throws_ok(
  $$ update public.users set display_name = 'x' $$,
  '42501',
  null,
  'User A cannot update users rows directly'
);
select throws_ok(
  $$ insert into public.users (clerk_user_id) values ('user_Forged999') $$,
  '42501',
  null,
  'User A cannot insert arbitrary users rows'
);

-- ---------------------------------------------------------------------------
-- Validation and lifecycle
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.register_connection('codex', 'agent', null, pg_temp.fake_hash('x1'), 'tlc_xxxxx1') $$,
  '23514',
  null,
  'unknown platform is rejected'
);
select throws_ok(
  $$ select public.register_connection('chatgpt', 'admin', null, pg_temp.fake_hash('x2'), 'tlc_xxxxx2') $$,
  '23514',
  null,
  'unknown role is rejected'
);
select throws_ok(
  $$ update public.connections set status = 'active' $$,
  '42501',
  null,
  'callers cannot set status directly'
);
select throws_ok(
  $$ insert into public.connections (platform, role) values ('chatgpt', 'controller') $$,
  '42501',
  null,
  'direct INSERT is not permitted (registration function only)'
);

select public.revoke_connection((select id from public.connections where display_name = 'Alice laptop 2'));
select isnt(
  (select revoked_at from public.connections where display_name = 'Alice laptop 2'),
  null,
  'revoking sets revoked_at'
);
select throws_ok(
  $$ select public.rotate_connection_credential(
       (select id from public.connections where display_name = 'Alice laptop 2'),
       pg_temp.fake_hash('a1-reissue'), 'tlc_aaaaa2') $$,
  '55000',
  null,
  'revocation is terminal (cannot reissue a credential to a revoked connection)'
);

reset role;

-- B's data is untouched after all of A's attempts.
select results_eq(
  $$ select display_name, status from public.connections where id = (select id from b_conn) $$,
  $$ values ('Bob ChatGPT'::text, 'active'::text) $$,
  'User B connection is unchanged after User A attacks'
);

-- ---------------------------------------------------------------------------
-- Missing / malformed / unprovisioned identity
-- ---------------------------------------------------------------------------
select pg_temp.act_as_anon();
select throws_ok('select * from public.users', '42501', null, 'anonymous cannot read users');
select throws_ok('select * from public.connections', '42501', null, 'anonymous cannot read connections');
select throws_ok(
  $$ select public.provision_current_user('x', 'x@example.com') $$,
  '42501',
  null,
  'anonymous cannot provision'
);
reset role;

select pg_temp.act_as('{"role":"authenticated"}'::jsonb);
select is_empty('select 1 from public.users', 'authenticated without sub sees no users');
select throws_ok(
  $$ select public.provision_current_user('x', null) $$,
  '28000',
  null,
  'authenticated without sub cannot provision'
);
reset role;

select pg_temp.act_as_user('user_AliceTest01'' OR ''1''=''1');
select is_empty('select 1 from public.users', 'malformed sub is treated as no identity');
reset role;

select pg_temp.act_as_user('user_NotProvisioned3');
select throws_ok(
  $$ select public.register_connection('chatgpt', 'controller', null, pg_temp.fake_hash('np'), 'tlc_nnnnnn') $$,
  '28000',
  null,
  'unprovisioned identity cannot register connections'
);
reset role;

select * from finish();
rollback;
