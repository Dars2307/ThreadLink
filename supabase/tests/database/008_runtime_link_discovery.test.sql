-- ThreadLink Phase 6.6: Runtime-scoped link discovery (pgTAP). LOCAL stack only.
--
-- A Runtime must be able to find a link request for one of its own sessions
-- without any local state, and must not be able to see anyone else's - not
-- another user's, and not another Runtime of its own user.

begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

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
-- The one link in Alice's first Runtime, as that Runtime sees it.
create function pg_temp.mine(hash text) returns jsonb language sql as $$
  select coalesce(public.list_runtime_links(hash) -> 0, 'null'::jsonb)
$$;
create function pg_temp.count_of(hash text) returns int language sql as $$
  select jsonb_array_length(public.list_runtime_links(hash))
$$;
create function pg_temp.link(l text) returns public.thread_links language sql security definer as $$
  select * from public.thread_links where id = l $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Two users. Alice has two Runtimes; the link targets the first one.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_LinkAlice00001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'ChatGPT', pg_temp.h('a-chat'), 'tlc_achat1');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt1'), 'tlc_art1aa');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt2'), 'tlc_art2aa');
reset role;
select pg_temp.act_as_user('user_LinkBob000001');
select public.provision_current_user('Bob', null);
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_brt1aa');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('rt1', public.register_runtime(pg_temp.h('a-rt1'), 'Laptop', 'windows', 'desktop', '0.6.6') ->> 'id');
select pg_temp.put('rt2', public.register_runtime(pg_temp.h('a-rt2'), 'Cloud VM', 'linux', 'remote', '0.6.6') ->> 'id');
select pg_temp.put('rtb', public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'windows', 'desktop', '0.6.6') ->> 'id');

select pg_temp.put('ws1', public.upsert_runtime_workspace(pg_temp.h('a-rt1'), pg_temp.k('C:/work/ThreadLink'),
  'ThreadLink', 'C:\work\ThreadLink', 'github.com/dars2307/threadlink', repeat('a', 64), 'main') ->> 'id');
select pg_temp.put('ws2', public.upsert_runtime_workspace(pg_temp.h('a-rt2'), pg_temp.k('/srv/ThreadLink'),
  'ThreadLink', '/srv/ThreadLink', null, null, null) ->> 'id');

select pg_temp.put('agent1', public.register_runtime_session(pg_temp.h('a-rt1'), pg_temp.id('ws1'),
  'cc:31a711b2-740c-4fe5-a551-e20e8080dce1', 'Dashboard redesign', 'claude-code', 'resume',
  '31a711b2-740c-4fe5-a551-e20e8080dce1') ->> 'id');
select pg_temp.put('agent2', public.register_runtime_session(pg_temp.h('a-rt2'), pg_temp.id('ws2'),
  'cc-fresh:11111111-1111-4111-8111-111111111111', 'Cloud conversation', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'chat-1') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent1')) ->> 'id');

-- ---------------------------------------------------------------------------
-- The owning Runtime sees it, with what it needs and nothing more
-- ---------------------------------------------------------------------------
select is(pg_temp.count_of(pg_temp.h('a-rt1')), 1, 'the owning Runtime sees its pending request');
select is(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'id', pg_temp.id('link'), 'the link id is returned');
select is(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'status', 'pending', 'its status is pending');
select is(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'agent_session_id', pg_temp.id('agent1'),
  'the target ThreadLink session is returned');
select is(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'controller_display_name', 'ChatGPT',
  'an unnamed chat is described by its connection, in words');
select ok(not (pg_temp.mine(pg_temp.h('a-rt1')) ? 'controller_session_id'),
  'the controller session id is NOT exposed to the Runtime');

-- Enough to find the conversation locally, or to attach it again.
select is(pg_temp.mine(pg_temp.h('a-rt1')) #>> '{conversation,local_binding_ref}',
  'cc:31a711b2-740c-4fe5-a551-e20e8080dce1', 'the conversation binding ref is returned');
select is(pg_temp.mine(pg_temp.h('a-rt1')) #>> '{conversation,native_session_id}',
  '31a711b2-740c-4fe5-a551-e20e8080dce1', 'the native conversation id is returned for reattaching');
select is(pg_temp.mine(pg_temp.h('a-rt1')) #>> '{conversation,workspace_path}', 'C:\work\ThreadLink',
  'the workspace path is returned for reattaching');
select is(pg_temp.mine(pg_temp.h('a-rt1')) #>> '{conversation,workspace_name}', 'ThreadLink',
  'the workspace name is returned');
select is(pg_temp.mine(pg_temp.h('a-rt1')) #>> '{conversation,mode}', 'resume',
  'the conversation mode is returned');

-- ---------------------------------------------------------------------------
-- Discovery does not depend on local state, and isolation is strict
-- ---------------------------------------------------------------------------
-- Nothing about this function consults the Runtime's files: the same call made
-- after a local detach returns the same request. (The client-side half of this
-- is covered in tests/desktop/approval.test.ts.)
select is(pg_temp.count_of(pg_temp.h('a-rt1')), 1,
  'the request is still visible however the Runtime''s local state looks');

select is(pg_temp.count_of(pg_temp.h('a-rt2')), 0,
  'another Runtime of the SAME user does not see it');
select is(pg_temp.count_of(pg_temp.h('b-rt')), 0, 'another user''s Runtime does not see it');
select throws_ok($$ select public.list_runtime_links(pg_temp.h('a-chat')) $$,
  '42501', null, 'a controller connection may not list Runtime links');
select throws_ok($$ select public.list_runtime_links(pg_temp.h('nobody')) $$,
  '28000', null, 'an unknown credential is refused');

-- A Runtime of the same user still cannot approve a session it does not own.
select throws_ok($$ select public.approve_pairing(pg_temp.h('a-rt2'), pg_temp.id('agent1'), pg_temp.id('link')) $$,
  'P0002', null, 'another Runtime of the same user cannot approve it');
select is((pg_temp.link(pg_temp.id('link'))).status, 'pending',
  'the request is untouched by that attempt');

-- ---------------------------------------------------------------------------
-- Approval, idempotence, and what the list shows afterwards
-- ---------------------------------------------------------------------------
select is(public.approve_pairing(pg_temp.h('a-rt1'), pg_temp.id('agent1'), pg_temp.id('link')) ->> 'status',
  'active', 'the owning Runtime approves it');
select is(public.approve_pairing(pg_temp.h('a-rt1'), pg_temp.id('agent1'), pg_temp.id('link')) ->> 'status',
  'active', 'approving again is idempotent');
select is(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'status', 'active',
  'the link is now listed as active');
select isnt(pg_temp.mine(pg_temp.h('a-rt1')) ->> 'approved_at', null, 'with an approval time');

-- ---------------------------------------------------------------------------
-- A revoked Runtime can neither list nor approve
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as_user('user_LinkAlice00001');
select public.revoke_runtime(pg_temp.id('rt1'));
reset role;
select pg_temp.act_as_client();
select throws_ok($$ select public.list_runtime_links(pg_temp.h('a-rt1')) $$,
  '28000', null, 'a revoked Runtime cannot list its links');
select throws_ok($$ select public.approve_pairing(pg_temp.h('a-rt1'), pg_temp.id('agent1'), pg_temp.id('link')) $$,
  '28000', null, 'a revoked Runtime cannot approve');

select * from finish();
rollback;
