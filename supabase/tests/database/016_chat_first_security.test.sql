-- ThreadLink chat-first security (pgTAP): cross-account isolation for every
-- chat RPC (another account's chat, group, project or job is exactly "not
-- found"), the controller's chatId, provenance of the new ThreadLink rows,
-- immutability of chat links, and the health gate per account.
-- LOCAL stack only. Adversarial.

begin;

create extension if not exists pgtap with schema extensions;

select plan(51);

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
create function pg_temp.doc(p text, health text default 'ready') returns jsonb language sql as $$
  select jsonb_build_object('installed', true, 'authenticated', true,
    'authMethod', case p when 'claude-code' then 'claude.ai' else 'chatgpt' end, 'health', health,
    'healthCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
create function pg_temp.evc(p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute 'select count(*)::int from public.chat_events where ' || p_where into n;
  return n;
end;
$$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.chat(c text) returns public.chats language sql security definer as $$
  select * from public.chats where id = c $$;
create function pg_temp.default_chat(r text) returns text language sql security definer as $$
  select id from public.chats where room_id = r and is_room_default and deleted_at is null $$;
create function pg_temp.cpost(chat text, body text, idem text default null) returns jsonb language sql as $$
  select public.post_chat_message(p_chat_id => chat, p_body => body, p_idempotency_key => idem)
$$;
create function pg_temp.profile(u text, p text) returns public.provider_profiles language sql security definer as $$
  select pp.* from public.provider_profiles pp join public.users us on us.id = pp.owner_user_id
  where us.clerk_user_id = u and pp.provider = p $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Alice and Bob, each with a 0.9 Runtime, one project, chats.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_CfSecAlice00001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'Alice chat', pg_temp.h('a-chat'), 'tlc_csacht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_csart1');
reset role;
select pg_temp.act_as_user('user_CfSecBob000001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob chat', pg_temp.h('b-chat'), 'tlc_csbcht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_csbrt1');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Alice PC', 'windows', 'desktop', '0.9.0');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/a'), 'A', 'C:\a', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.9.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:a', 'A worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'cs-a') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('room', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Alice project', pg_temp.id('link')) ->> 'room_id');

select public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'linux', 'desktop', '0.9.0');
select pg_temp.put('bws', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/b'), 'B', '/b', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('b-rt'), '0.9.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('bagent', public.register_runtime_session(pg_temp.h('b-rt'), pg_temp.id('bws'),
  'cc:b', 'B worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('bchat', public.register_session(pg_temp.h('b-chat'), null, null, 'cs-b') ->> 'id');
select pg_temp.put('blink', public.request_pairing(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('bagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('blink'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('broom', public.create_room(pg_temp.h('b-chat'), pg_temp.id('bchat'), 'Bob project') ->> 'room_id');

reset role;
select pg_temp.act_as_user('user_CfSecAlice00001');
select pg_temp.put('achat', public.create_chat('Alice chat', pg_temp.id('room')) ->> 'chat_id');
select pg_temp.put('agroup', public.create_chat_group('Alice group') ->> 'group_id');
select pg_temp.cpost(pg_temp.id('achat'), 'Alice private goal: ship the thing', 'shared-key');
-- A job that blocked before it had a plan (retry-eligible).
reset role;
select pg_temp.act_as_client();
select pg_temp.put('ajob', public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('room'), 'Blocked',
  null, null, null, null, null, null, 'team', null, pg_temp.default_chat(pg_temp.id('room'))) ->> 'job_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), (pg_temp.job(pg_temp.id('ajob'))).task_id, 'c-a');
select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('ajob'), 'c-a', 'set_final',
  '{"verdict":"BLOCKED","reason":"agent_needs_sign_in","provider":"claude-code","evidence":{}}');

reset role;
select pg_temp.act_as_user('user_CfSecBob000001');
select pg_temp.put('bchat1', public.create_chat('Bob chat', pg_temp.id('broom')) ->> 'chat_id');
select pg_temp.put('ghost', 'tlcht_' || repeat('0', 32));
select pg_temp.put('ghostgrp', 'tlgrp_' || repeat('0', 32));
select pg_temp.put('ghostjob', 'tljob_' || repeat('0', 32));
select pg_temp.put('ghostroom', 'tlrom_' || repeat('0', 32));

-- ===========================================================================
-- 1. Bob and Alice's things: indistinguishable from things that do not exist
-- ===========================================================================
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_name => 'mine now') $q$, pg_temp.id('achat'))),
  pg_temp.fails(format($q$ select public.update_chat(%L, p_name => 'mine now') $q$, pg_temp.id('ghost'))),
  'update_chat: another account''s chat = a missing chat');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_name => 'x') $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', '...which is "not found"');
select is(pg_temp.fails(format($q$ select public.set_chat_pinned(%L, true) $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'set_chat_pinned');
select is(pg_temp.fails(format($q$ select public.set_chat_archived(%L, true) $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'set_chat_archived');
select is(pg_temp.fails(format($q$ select public.delete_chat(%L) $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'delete_chat');
select is(pg_temp.fails(format($q$ select public.mark_chat_read(%L, 1) $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'mark_chat_read');
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, 'hello') $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'post_chat_message by chat');
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, '@team stop') $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'post_chat_message cannot stop another account''s work');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('ajob'))),
  pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('ghostjob'))),
  'retry_job_with_roles: another account''s job = a missing job');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('ajob'))),
  'P0002:job_not_found', '...which is "not found"');
select is(pg_temp.fails(format($q$ select public.create_chat('x', %L) $q$, pg_temp.id('room'))),
  pg_temp.fails(format($q$ select public.create_chat('x', %L) $q$, pg_temp.id('ghostroom'))),
  'create_chat in another account''s project = a missing project');
select is(pg_temp.fails(format($q$ select public.create_chat('x', %L) $q$, pg_temp.id('room'))),
  'P0002:project_not_found', '...which is "not found"');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_room_id => %L) $q$, pg_temp.id('bchat1'), pg_temp.id('room'))),
  'P0002:project_not_found', 'Bob cannot move his chat into Alice''s project');
select is(pg_temp.fails(format($q$ select public.create_chat('x', null, %L) $q$, pg_temp.id('agroup'))),
  'P0002:group_not_found', 'Bob cannot put a chat in Alice''s group');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_group_id => %L) $q$, pg_temp.id('bchat1'), pg_temp.id('agroup'))),
  'P0002:group_not_found', '...not even his own chat');
select is(pg_temp.fails(format($q$ select public.rename_chat_group(%L, 'x') $q$, pg_temp.id('agroup'))),
  pg_temp.fails(format($q$ select public.rename_chat_group(%L, 'x') $q$, pg_temp.id('ghostgrp'))),
  'rename_chat_group: another account''s group = a missing group');
select is(pg_temp.fails(format($q$ select public.delete_chat_group(%L) $q$, pg_temp.id('agroup'))),
  'P0002:group_not_found', 'delete_chat_group');
select is(pg_temp.fails($$ select public.create_chat_group('Alice group') $$), 'ok',
  'group names are unique per account only');
select is((pg_temp.cpost(pg_temp.id('bchat1'), 'Bob''s own work', 'shared-key') ->> 'routed'), 'new_job',
  'idempotency keys are per account: Alice''s key means nothing to Bob');

-- Nothing of Alice's changed.
reset role;
select is((pg_temp.chat(pg_temp.id('achat'))).name || '|' || coalesce((pg_temp.chat(pg_temp.id('achat'))).pinned_at::text, 'unpinned')
  || '|' || coalesce((pg_temp.chat(pg_temp.id('achat'))).deleted_at::text, 'live'),
  'Alice chat|unpinned|live', 'Alice''s chat is untouched');
select is((select count(*)::int from public.chat_groups where id = pg_temp.id('agroup')), 1, 'Alice''s group is untouched');
select is((select count(*)::int from public.team_jobs where retried_from_job_id = pg_temp.id('ajob')), 0,
  'and her job was not retried');

-- ===========================================================================
-- 2. Reads: RLS shows each account only its own
-- ===========================================================================
select pg_temp.act_as_user('user_CfSecBob000001');
select is((select count(*)::int from public.chats where owner_user_id <> (select id from public.users where clerk_user_id = 'user_CfSecBob000001')), 0,
  'Bob reads none of Alice''s chats');
select is((select count(*)::int from public.chats where id = pg_temp.id('achat')), 0, '...not even by id');
select is((select count(*)::int from public.chat_groups where id = pg_temp.id('agroup')), 0, 'nor her groups');
select is((select count(*)::int from public.runtime_provider_health
           where owner_user_id <> (select id from public.users where clerk_user_id = 'user_CfSecBob000001')), 0,
  'nor her computers'' health');
select is((select count(*)::int
           from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
           where has_table_privilege('authenticated', 'public.runtime_provider_health', p.priv)
              or has_table_privilege('anon', 'public.runtime_provider_health', p.priv)), 0,
  'no client role can write per-computer health');
select is((select count(*)::int from public.chat_events where chat_id = pg_temp.id('achat')), 0, 'nor her chat rows');
select is((select coalesce(last_seq::text, 'none') || '|' || coalesce(last_body, 'none') || '|' || cardinality(controller_labels)
           from public.chat_list_extras(array[pg_temp.id('achat')])), 'none|none|0',
  'chat_list_extras runs as the caller: another account''s chat reveals nothing');
select is(pg_temp.fails($$ select public.chat_list_extras(array_fill('x'::text, array[501])) $$), '22023:invalid',
  'chat_list_extras is bounded');

-- ===========================================================================
-- 3. Unauthenticated callers
-- ===========================================================================
reset role;
select pg_temp.act_as_client();
select is(pg_temp.fails($$ select public.create_chat('x') $$), '42501:', 'anon cannot call owner RPCs');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('ajob'))), '42501:',
  'anon cannot retry');
reset role;
select pg_temp.act_as_user('user_CfSecNobody0001');
select is(pg_temp.fails($$ select public.create_chat('x') $$), '28000:unauthenticated',
  'a signed-in stranger with no ThreadLink account is refused');
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, 'hi') $q$, pg_temp.id('achat'))), '28000:unauthenticated',
  '...everywhere');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_name => 'x') $q$, pg_temp.id('achat'))), '28000:unauthenticated',
  '...update_chat too');

-- ===========================================================================
-- 4. The controller's chatId is validated to the same account and project
-- ===========================================================================
reset role;
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select public.start_team_job(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('broom'),
  'into Alice chat', null, null, null, null, null, null, 'team', null, %L) $q$, pg_temp.id('achat'))),
  'P0002:chat_not_found', 'Bob''s controller cannot start work in Alice''s chat');
select is(pg_temp.fails(format($q$ select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('room'),
  'into Bob chat', null, null, null, null, null, null, 'team', null, %L) $q$, pg_temp.id('bchat1'))),
  'P0002:chat_not_found', 'nor Alice''s in Bob''s');
select is(pg_temp.fails(format($q$ select public.create_chat_task(pg_temp.h('b-chat'), pg_temp.id('bchat'), pg_temp.id('blink'),
  %L, 't', 'c', null, null, null) $q$, pg_temp.id('achat'))), 'P0002:chat_not_found',
  'send_to_agent cannot target another account''s chat');
select is(pg_temp.evc(format('chat_id = %L and author_kind = ''controller''', pg_temp.id('achat'))), 0,
  'and nothing reached Alice''s chat');

-- Detection from Bob's Runtime changes only Bob's health.
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', pg_temp.doc('codex', 'needs_sign_in'));
select is((pg_temp.profile('user_CfSecAlice00001', 'codex')).detected ->> 'health', 'ready',
  'another account''s Runtime cannot change Alice''s health');
select is(pg_temp.fails($$ select public.report_provider_detection(pg_temp.h('b-chat'), 'codex', pg_temp.doc('codex')) $$),
  '42501:', 'a controller credential cannot report health');
select is(public.report_provider_detection(pg_temp.h('b-rt'), 'codex',
  pg_temp.doc('codex') || '{"healthDetail":"signed in as bob@example.com"}') -> 'detected' -> 'healthDetail',
  'null'::jsonb, 'an email address in a health detail is never stored');

-- ===========================================================================
-- 5. Provenance and immutability (held even against a privileged writer)
-- ===========================================================================
reset role;
select is((select string_agg(distinct author_kind || '/' || author_label, ',')
           from public.chat_events where event_type in ('provider_blocked', 'mode_changed')
             and owner_user_id in (select id from public.users
                                   where clerk_user_id in ('user_CfSecAlice00001', 'user_CfSecBob000001'))), NULL,
  'no fixture wrote those rows yet (sanity)');
select pg_temp.act_as_user('user_CfSecAlice00001');
select public.update_chat(pg_temp.id('achat'), p_mode => 'pair');
reset role;
select is((select author_kind || '/' || author_label || '/' || coalesce(author_provider, '-')
           from public.chat_events where chat_id = pg_temp.id('achat') and event_type = 'mode_changed'),
  'threadlink/ThreadLink/-', 'mode_changed is ThreadLink''s own row');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, author_kind, author_label, event_type, body)
  values ((select owner_user_id from public.chats where id = %L), %L, 'owner', 'You', 'provider_blocked', 'fake') $q$,
  pg_temp.id('achat'), pg_temp.id('achat'))), '23514:', 'an owner row can never be a provider_blocked row');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, author_kind, author_label, event_type, body)
  values ((select owner_user_id from public.chats where id = %L), %L, 'controller', 'ChatGPT', 'request', 'x') $q$,
  pg_temp.id('achat'), pg_temp.id('achat'))), '23514:', 'only owner or ThreadLink rows may lack an agent session');
select is(pg_temp.fails(format($q$ insert into public.chat_events (owner_user_id, chat_id, author_kind, author_label, event_type, body)
  values ((select owner_user_id from public.chats where id = %L), %L, 'owner', 'You', 'message', 'x') $q$,
  pg_temp.id('bchat1'), pg_temp.id('achat'))), '23503:', 'a row can only be in its own owner''s chat');
select is(pg_temp.fails(format($q$ update public.chat_events set chat_id = %L where chat_id = %L $q$,
  pg_temp.id('bchat1'), pg_temp.id('achat'))), '42501:', 'a chat row never moves to another chat');
select is(pg_temp.fails(format($q$ update public.team_jobs set chat_id = %L where id = %L $q$,
  pg_temp.default_chat(pg_temp.id('room')), (select id from public.team_jobs where chat_id = pg_temp.id('achat') limit 1))),
  '42501:', 'a job never moves to another chat');
select is(pg_temp.fails(format($q$ update public.team_jobs set role_overrides = '{"coordinator":"codex"}' where id = %L $q$,
  (select id from public.team_jobs where chat_id = pg_temp.id('achat') limit 1))), '42501:', 'role overrides are fixed at start');
select is(pg_temp.fails($$ insert into public.chats (owner_user_id, name, room_id, is_room_default)
  select owner_user_id, 'Second default', id, true from public.rooms where id = pg_temp.id('room') $$), '23505:',
  'a project has one default chat');

select * from finish();
rollback;
