-- ThreadLink chat-first (pgTAP): chats and groups, the backfill, the provider
-- health gate on every job-start path, chat-keyed routing (mode, @mention,
-- needs_project, provider_blocked, mode_changed), the room-keyed 0.8 post,
-- controller chatId, last_phase, verdict provider, retry, detection health.
-- LOCAL stack only. Isolation and provenance are in 016_chat_first_security.

begin;

create extension if not exists pgtap with schema extensions;

select plan(150);

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
-- The SQLSTATE and the stable reason code (HINT) of a failing statement.
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
-- ...and its DETAIL.
create function pg_temp.detail(q text) returns text language plpgsql as $$
declare
  v_detail text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return v_detail;
end;
$$;
-- A detection document: ready by default, or the given health / age.
create function pg_temp.doc(p text, health text default 'ready', age interval default '0 seconds')
returns jsonb language sql as $$
  select jsonb_build_object('installed', true, 'authenticated', true,
    'authMethod', case p when 'claude-code' then 'claude.ai' else 'chatgpt' end,
    'health', health,
    'healthCheckedAt', to_char((now() - age) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$$;
create function pg_temp.report(rt text, p text, health text default 'ready', age interval default '0 seconds')
returns jsonb language sql as $$
  select public.report_provider_detection(pg_temp.h(rt), p, pg_temp.doc(p, health, age))
$$;
create function pg_temp.ev(p_where text) returns setof public.chat_events language plpgsql security definer as $$
begin
  return query execute 'select * from public.chat_events where ' || p_where || ' order by seq';
end;
$$;
create function pg_temp.evc(p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute 'select count(*)::int from public.chat_events where ' || p_where into n;
  return n;
end;
$$;
create function pg_temp.cnt(p_table text, p_where text) returns int language plpgsql security definer as $$
declare n int;
begin
  execute format('select count(*)::int from public.%I where ', p_table) || p_where into n;
  return n;
end;
$$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.job_by_goal(g text) returns text language sql security definer as $$
  select id from public.team_jobs where goal = g $$;
create function pg_temp.chat(c text) returns public.chats language sql security definer as $$
  select * from public.chats where id = c $$;
create function pg_temp.default_chat(r text) returns text language sql security definer as $$
  select id from public.chats where room_id = r and is_room_default and deleted_at is null $$;
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t $$;
create function pg_temp.w(j text, claim text, op text, payload jsonb) returns jsonb language sql as $$
  select public.team_job_write(pg_temp.h('a-rt'), pg_temp.id('agent'), j, claim, op, payload)
$$;
create function pg_temp.claim(j text, claim text) returns jsonb language sql as $$
  select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), (pg_temp.job(j)).task_id, claim)
$$;
create function pg_temp.start(room text, goal text, mode text default null, builder text default null,
                              chat text default null) returns jsonb language sql as $$
  select public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), room, goal, null, null, null, null,
                               null, null, mode, builder, chat)
$$;
create function pg_temp.cpost(chat text, body text, idem text default null) returns jsonb language sql as $$
  select public.post_chat_message(p_chat_id => chat, p_body => body, p_idempotency_key => idem)
$$;
create function pg_temp.detail_of(d jsonb) returns text language sql as $$
  select coalesce(public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
    pg_temp.doc('codex', 'needs_sign_in') || d) -> 'detected' ->> 'healthDetail', '<null>')
$$;
-- One Runtime's own health row, found by its connection's display prefix.
create function pg_temp.rt_health(prefix text, p text) returns text language sql security definer as $$
  select h.health || '|' || coalesce(h.detail, '<null>')
  from public.runtime_provider_health h
  join public.runtimes r on r.id = h.runtime_id
  join public.connection_credentials cc on cc.connection_id = r.connection_id
  where cc.token_prefix = prefix and h.provider = p
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: Alice (ChatGPT, a 0.9 Runtime with two agent sessions, two
-- projects), both agents ready. Bob exists so counts can be scoped.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_ChatFirstAlice01');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'My ChatGPT', pg_temp.h('a-chat'), 'tlc_cfacht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_cfart1');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Laptop', 'windows', 'desktop', '0.9.0');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/w/Prism'),
  'Prism', 'C:\w\Prism', null, null, null) ->> 'id');
select pg_temp.put('ws2', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/w/Other'),
  'Other', 'C:\w\Other', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.9.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:prism', 'Prism worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('agent2', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws2'),
  'cc:other', 'Other worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'cf-chat') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));
select pg_temp.put('link2', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent2')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent2'), pg_temp.id('link2'));
select pg_temp.report('a-rt', 'claude-code');
select pg_temp.report('a-rt', 'codex');
select pg_temp.put('room', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Prism', pg_temp.id('link')) ->> 'room_id');
select pg_temp.put('room2', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Other', pg_temp.id('link2')) ->> 'room_id');
select pg_temp.put('dchat', pg_temp.default_chat(pg_temp.id('room')));
select pg_temp.put('dchat2', pg_temp.default_chat(pg_temp.id('room2')));
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
-- Owner solo in this project is allowed; the controller solo below needs it off.
select public.update_room_policy(pg_temp.id('room'), p_cross_review => false);
reset role;

-- ===========================================================================
-- 1. Shape and privileges
-- ===========================================================================
reset role;
select ok((select relrowsecurity from pg_class where oid = 'public.chats'::regclass), 'RLS is enabled on chats');
select ok((select relrowsecurity from pg_class where oid = 'public.chat_groups'::regclass),
  'RLS is enabled on chat_groups');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('chats', 'chat_groups')
           and cmd = 'SELECT' and roles = array['authenticated']::name[]
           and qual ~ 'owner_user_id = \( SELECT threadlink_private\.current_user_id'), 2,
  'one owner-scoped SELECT policy on each table');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('chats', 'chat_groups')), 2,
  'and no other policy');
select is((select count(*)::int
           from unnest(array['public.chats', 'public.chat_groups']) t(tab)
           cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
           where has_table_privilege('authenticated', t.tab, p.priv) or has_table_privilege('anon', t.tab, p.priv)), 0,
  'no client role can write chats or chat groups');
select ok(not has_table_privilege('anon', 'public.chats', 'select'), 'anon cannot read chats');
select is((select count(*)::int from unnest(array[
    'public.post_chat_message(text, text, text)', 'public.create_chat(text, text, text, text)',
    'public.update_chat(text, text, text, boolean, text, boolean, text, text, text, text, boolean, boolean)',
    'public.set_chat_pinned(text, boolean)', 'public.set_chat_archived(text, boolean)', 'public.delete_chat(text)',
    'public.mark_chat_read(text, bigint)', 'public.create_chat_group(text)', 'public.rename_chat_group(text, text)',
    'public.delete_chat_group(text)', 'public.retry_job_with_roles(text, text)', 'public.chat_list_extras(text[])']) f
  where has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')), 12,
  'every owner RPC is for the signed-in owner only');
select is((select count(*)::int from unnest(array[
    'public.start_team_job(text, text, text, text, jsonb, integer, integer, integer, text[], text, text, text, text)',
    'public.create_chat_task(text, text, text, text, text, text, text, text, integer)']) f
  where has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')), 2,
  'the controller RPCs are for credential callers only');
select is((select count(*)::int from unnest(array[
    'threadlink_private.chat_post(text, text, text, text, text, text, boolean)',
    'threadlink_private.team_start_job_v2(text, text, text, public.rooms, public.thread_links, text, jsonb, integer, integer, integer, text, text, text, text, text, jsonb, text)',
    'threadlink_private.room_default_chat(text)', 'threadlink_private.chat_first_backfill()',
    'threadlink_private.provider_health_list(text, text[])']) f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')), 0,
  'private helpers are not callable by any client role');

-- ===========================================================================
-- 2. Default chats and provider-neutral roles
-- ===========================================================================
select is(pg_temp.cnt('chats', format('room_id = %L and is_room_default and deleted_at is null', pg_temp.id('room'))), 1,
  'a new project gets exactly one default chat');
select is((pg_temp.chat(pg_temp.id('dchat'))).name || '|' || (pg_temp.chat(pg_temp.id('dchat'))).mode, 'Prism|team',
  'named after the project, in Team mode');
select is((select array_agg(distinct r order by r) from public.room_agents a, unnest(a.default_roles) r
           where a.room_id = pg_temp.id('room')),
  (select array_agg(x order by x) from unnest(threadlink_private.team_roles()) x),
  'new agents get the full role set: no provider is special');
select ok(threadlink_private.room_default_chat(pg_temp.id('room')) = pg_temp.id('dchat'),
  'asking again returns the same default chat');

-- ===========================================================================
-- 3. The backfill, on data shaped like Production before this migration
-- ===========================================================================
select pg_temp.put('bj', pg_temp.start(pg_temp.id('room'), 'Backfill fixture') ->> 'job_id');
select pg_temp.put('bj_updated', (pg_temp.job(pg_temp.id('bj'))).updated_at::text);
select pg_temp.put('bj_bodies', (select md5(string_agg(body, '|' order by seq)) from public.chat_events
                                 where room_id = pg_temp.id('room')));
select pg_temp.put('bj_events', pg_temp.evc(format('room_id = %L', pg_temp.id('room')))::text);
-- Turn the clock back: no chats for this project, no chat_id anywhere.
alter table public.chat_events disable trigger chat_events_guard_update;
update public.chat_events set chat_id = null where room_id = pg_temp.id('room');
alter table public.chat_events enable trigger chat_events_guard_update;
alter table public.team_jobs disable trigger team_jobs_guard_update;
update public.team_jobs set chat_id = null, last_phase = null where room_id = pg_temp.id('room');
alter table public.team_jobs enable trigger team_jobs_guard_update;
delete from public.chats where room_id = pg_temp.id('room');

select is(threadlink_private.chat_first_backfill(),
  jsonb_build_object('chats', 1, 'jobs', 1, 'events', pg_temp.id('bj_events')::int),
  'the backfill makes one chat and fills in the project''s job and every chat row');
select pg_temp.put('dchat', pg_temp.default_chat(pg_temp.id('room')));
select is((pg_temp.chat(pg_temp.id('dchat'))).name || '|' || (pg_temp.chat(pg_temp.id('dchat'))).mode, 'Prism|team',
  'the backfilled default chat is named after the project, in Team mode');
select is(pg_temp.evc(format('room_id = %L and chat_id is distinct from %L', pg_temp.id('room'), pg_temp.id('dchat'))), 0,
  'every chat row of the project is in its default chat');
select is(pg_temp.evc(format('room_id = %L', pg_temp.id('room')))::text, pg_temp.id('bj_events'), 'no row was added or removed');
select is((select md5(string_agg(body, '|' order by seq)) from public.chat_events where room_id = pg_temp.id('room')),
  pg_temp.id('bj_bodies'), 'no row was rewritten');
select is((pg_temp.job(pg_temp.id('bj'))).chat_id, pg_temp.id('dchat'), 'the job is in the default chat');
select is((pg_temp.job(pg_temp.id('bj'))).updated_at::text, pg_temp.id('bj_updated'), 'the job''s updated_at is untouched');
select is((pg_temp.job(pg_temp.id('bj'))).last_phase, 'queued', 'a running job''s last phase is its status');
select is((pg_temp.chat(pg_temp.id('dchat'))).last_read_seq,
  (select max(seq) from public.chat_events where room_id = pg_temp.id('room')),
  'existing history counts as read');
select is(threadlink_private.chat_first_backfill(), '{"chats": 0, "jobs": 0, "events": 0}'::jsonb,
  'running it again changes nothing');

-- The fixture job is cancelled by its Runtime, which records the phase honestly.
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('bj'), 'c-bj');
select pg_temp.w(pg_temp.id('bj'), 'c-bj', 'set_status', '{"status":"normalising"}');
select pg_temp.w(pg_temp.id('bj'), 'c-bj', 'set_status', '{"status":"cancelled"}');
select is((pg_temp.job(pg_temp.id('bj'))).last_phase, 'normalising',
  'last_phase keeps the last non-terminal status after the job ends');

-- ===========================================================================
-- 4. Detection health: what a Runtime may report
-- ===========================================================================
select is(pg_temp.fails($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex') || '{"health":"fine"}') $$), '22023:', 'health must be one of the fixed values');
select is(pg_temp.fails($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex') || '{"healthCheckedAt":"yesterday"}') $$), '22023:', 'healthCheckedAt must be a timestamp');
select is(pg_temp.fails($$ select public.report_provider_detection(pg_temp.h('a-rt'), 'codex',
  pg_temp.doc('codex', 'ready', '-1 hour')) $$), '22023:', 'a health check from the future is refused');
-- The detail: only the Runtime's fixed sentences are kept; anything else is
-- stored as null (the health itself still arrives).
select is(pg_temp.detail_of('{"healthDetail":"Needs you to sign in again on this computer."}'),
  'Needs you to sign in again on this computer.', 'a fixed Runtime sentence is kept');
select is(pg_temp.detail_of(jsonb_build_object('healthDetail', E'line one\nline two')), '<null>',
  'a multi-line detail is stored as null');
select is(pg_temp.detail_of('{"healthDetail":"See https://evil.example/login"}'), '<null>',
  'a URL is stored as null');
select is(pg_temp.detail_of('{"healthDetail":"Error: \"Failed to refresh\" at C:\\x"}'), '<null>',
  'quotes and paths (stderr) are stored as null');
select is(pg_temp.detail_of('{"healthDetail":"Token refresh failed (sk-abcdefghijklmnopqrstuvwx)"}'), '<null>',
  'a credential-shaped detail is never stored');
select is(pg_temp.detail_of('{"healthDetail":42}'), '<null>', 'a non-text detail is stored as null');
select is(pg_temp.rt_health('tlc_cfart1', 'codex'), 'needs_sign_in|<null>', 'the Runtime''s own health row records what it reported');

reset role;
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex'), now()), 'ready',
  'effective health: a fresh authenticated check is ready');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex') || '{"installed":false}', now()),
  'not_installed', 'effective health: not installed');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex') || '{"authenticated":false}', now()),
  'needs_sign_in', 'effective health: signed out, whatever the last check said');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex') || '{"authMethod":"api_key"}', now()),
  'api_key_auth', 'effective health: an API-key sign-in is not a subscription');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex') - 'authMethod', now()),
  'api_key_auth', 'effective health: an unknown sign-in method fails closed');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex', 'usage_exhausted'), now()),
  'usage_exhausted', 'effective health: a reported failure wins');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex') - 'health', now()),
  'unknown', 'effective health: "authenticated" alone (status output) is not proof');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex', 'ready', '3 hours'), now()),
  'unknown', 'effective health: a check older than 2 hours is not proof');
select is(threadlink_private.provider_effective_health('codex', pg_temp.doc('codex'), now() - interval '3 hours'),
  'unknown', 'effective health: the server''s own receipt time also bounds freshness');
select is(threadlink_private.provider_effective_health('codex', '{}', null), 'unknown',
  'effective health: never reported');

-- ===========================================================================
-- 5. The health gate on the controller path: refused, nothing created
-- ===========================================================================
select pg_temp.act_as_client();
select pg_temp.put('n_jobs', pg_temp.cnt('team_jobs', 'true')::text);
select pg_temp.put('n_tasks', pg_temp.cnt('tasks', 'true')::text);
select is(pg_temp.fails($$ select pg_temp.start(pg_temp.id('room'), 'Needs Codex') $$), '55000:provider_unhealthy',
  'a controller cannot start a team job while an agent needs sign-in');
select is(pg_temp.detail($$ select pg_temp.start(pg_temp.id('room'), 'Needs Codex') $$),
  'claude-code=ready,codex=needs_sign_in', 'the refusal lists each provider''s health (machine-readable)');
select is(pg_temp.fails($$ select pg_temp.start(pg_temp.id('room'), 'Claude alone', 'solo', 'claude-code') $$), 'ok',
  'a solo job for the ready agent is not blocked by the other one');
select is(pg_temp.cnt('team_jobs', 'true')::text, (pg_temp.id('n_jobs')::int + 1)::text,
  'only the allowed job was created');
select is(pg_temp.cnt('tasks', 'true')::text, (pg_temp.id('n_tasks')::int + 1)::text, 'and only its task');
select pg_temp.report('a-rt', 'codex', 'ready', '3 hours');
select is(pg_temp.detail($$ select pg_temp.start(pg_temp.id('room2'), 'Stale') $$), 'claude-code=ready,codex=unknown',
  'a stale check blocks too');
select pg_temp.report('a-rt', 'codex');
-- The solo job above: finish it so the default chat is free.
select pg_temp.put('soloj', pg_temp.job_by_goal('Claude alone'));
select pg_temp.claim(pg_temp.id('soloj'), 'c-solo');
select pg_temp.w(pg_temp.id('soloj'), 'c-solo', 'set_status', '{"status":"cancelled"}');

-- ===========================================================================
-- 6. Owner chat management
-- ===========================================================================
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select pg_temp.put('c1', public.create_chat('Rate limiter', pg_temp.id('room'), null, 'solo') ->> 'chat_id');
select is((pg_temp.chat(pg_temp.id('c1'))).mode || '|' || (pg_temp.chat(pg_temp.id('c1'))).room_id,
  'solo|' || pg_temp.id('room'), 'create_chat: a chat in a project, in the chosen mode');
select pg_temp.put('loose', public.create_chat('Ideas') ->> 'chat_id');
select is((public.create_chat('  Ideas two  ') ->> 'name'), 'Ideas two', 'names are trimmed');
select is(pg_temp.fails($$ select public.create_chat(E'bad\nname') $$), '22023:invalid_name', 'no control characters in a name');
select is(pg_temp.fails($$ select public.create_chat(repeat('n', 101)) $$), '22023:invalid_name', 'names are at most 100 characters');
select is(pg_temp.fails($$ select public.create_chat('x', null, null, 'swarm') $$), '22023:invalid_mode', 'mode is solo, pair or team');
select is(pg_temp.fails(format($q$ select public.create_chat('x', %L) $q$, 'tlrom_' || repeat('0', 32))),
  'P0002:project_not_found', 'an unknown project is not found');

select pg_temp.put('g1', public.create_chat_group('Clients') ->> 'group_id');
select is(pg_temp.fails($$ select public.create_chat_group('clients') $$), '55000:name_taken', 'group names are unique (any case)');
select is(public.rename_chat_group(pg_temp.id('g1'), 'Client work') ->> 'name', 'Client work', 'a group can be renamed');
select is(public.update_chat(pg_temp.id('loose'), p_group_id => pg_temp.id('g1')) ->> 'group_name', 'Client work',
  'a chat can be put in a group');
select is(public.update_chat(pg_temp.id('loose'), p_name => 'Ideas (renamed)') ->> 'name', 'Ideas (renamed)',
  'a chat can be renamed');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_room_id => %L, p_clear_room => true) $q$,
  pg_temp.id('loose'), pg_temp.id('room'))), '22023:invalid', 'moving and clearing at once is refused');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_mode => 'pair', p_builder_provider => 'codex', p_reviewer_provider => 'codex') $q$,
  pg_temp.id('c1'))), '22023:invalid_pair', 'an agent never reviews its own work');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_solo_provider => 'gemini') $q$, pg_temp.id('c1'))),
  '22023:invalid_builder', 'only known providers');
select is(public.set_chat_pinned(pg_temp.id('loose'), true) ->> 'pinned', 'true', 'pin');
select is(public.set_chat_archived(pg_temp.id('loose'), true) ->> 'archived', 'true', 'archive');
select is(public.set_chat_archived(pg_temp.id('loose'), false) ->> 'archived', 'false', 'restore');
select is(public.delete_chat_group(pg_temp.id('g1')) ->> 'deleted', 'true', 'delete a group');
select is((pg_temp.chat(pg_temp.id('loose'))).group_id, null, '...its chats stay, ungrouped');
select is(public.delete_chat(pg_temp.id('loose')) ->> 'deleted', 'true', 'delete a chat from ThreadLink');
select is(pg_temp.fails(format($q$ select public.set_chat_pinned(%L, false) $q$, pg_temp.id('loose'))), 'P0002:chat_not_found',
  'a deleted chat is gone for every action');

-- Mode changes are ThreadLink rows; history is never edited.
select pg_temp.put('seq_before', pg_temp.evc(format('chat_id = %L', pg_temp.id('c1')))::text);
select is(public.update_chat(pg_temp.id('c1'), p_solo_provider => 'codex') ->> 'solo_provider', 'codex',
  'the chat can name its solo agent');
select is((select body || '|' || author_kind || '|' || author_label || '|' || visibility
           from pg_temp.ev(format('chat_id = %L and event_type = ''mode_changed''', pg_temp.id('c1'))) limit 1),
  'Mode changed to Solo: Codex works alone.|threadlink|ThreadLink|visible', 'a mode change writes a ThreadLink row');
select is(public.update_chat(pg_temp.id('c1'), p_name => 'Rate limiter work') ->> 'mode', 'solo',
  'renaming is not a mode change');
select is(pg_temp.evc(format('chat_id = %L and event_type = ''mode_changed''', pg_temp.id('c1'))), 1, '...and writes no row');

-- ===========================================================================
-- 7. Posting by chat: the chat's mode routes; @mention overrides once
-- ===========================================================================
select pg_temp.put('p1', pg_temp.cpost(pg_temp.id('c1'), 'Add a token bucket', 'k-p1') ->> 'job_id');
select is((pg_temp.job(pg_temp.id('p1'))).mode || '|' || (pg_temp.job(pg_temp.id('p1'))).builder_provider
  || '|' || (pg_temp.job(pg_temp.id('p1'))).chat_id, 'solo|codex|' || pg_temp.id('c1'),
  'a solo chat starts a solo job with its agent, in that chat');
select is(((pg_temp.task((pg_temp.job(pg_temp.id('p1'))).task_id)).content::jsonb) -> 'chatId',
  to_jsonb(pg_temp.id('c1')), 'the carrier names the chat');
select is(((pg_temp.task((pg_temp.job(pg_temp.id('p1'))).task_id)).content::jsonb) -> 'participants',
  '["codex"]'::jsonb, 'the carrier lists the participants');
select is(pg_temp.evc(format('job_id = %L and chat_id is distinct from %L', pg_temp.id('p1'), pg_temp.id('c1'))), 0,
  'every row of the job lands in the chat');
select is(pg_temp.evc(format('chat_id = %L and event_type = ''request'' and author_kind = ''owner'' and job_id = %L',
  pg_temp.id('c1'), pg_temp.id('p1'))), 1, 'the owner''s request is in the chat, linked to the job');
select is(pg_temp.cpost(pg_temp.id('c1'), 'Add a token bucket', 'k-p1') ->> 'replayed', 'true',
  'the same idempotency key replays');
select is(pg_temp.cpost(pg_temp.id('c1'), '@claude please also check the docs', null) ->> 'routed',
  'note_to_active_job', 'while a job runs, a message is a note for it');
select is(pg_temp.cpost(pg_temp.id('c1'), '@team stop', null) ->> 'routed', 'stop_requested',
  '@team stop stops the chat''s job');
select is(pg_temp.fails(format($q$ select public.delete_chat(%L) $q$, pg_temp.id('c1'))), '55000:job_active',
  'a chat with running work cannot be deleted');
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, 'x', 'k-p1') $q$, pg_temp.id('dchat'))),
  '55000:idempotency_conflict', 'a key used in another chat is a conflict');

-- @mention overrides the chat's mode for one message.
select pg_temp.put('c2', public.create_chat('Pair chat', pg_temp.id('room2'), null, 'pair') ->> 'chat_id');
select pg_temp.put('p2', pg_temp.cpost(pg_temp.id('c2'), '@codex just this once', null) ->> 'job_id');
select is((pg_temp.job(pg_temp.id('p2'))).mode || '|' || (pg_temp.job(pg_temp.id('p2'))).builder_provider,
  'solo|codex', '@codex in a pair chat starts one solo job');
select is((pg_temp.chat(pg_temp.id('c2'))).mode, 'pair', 'the chat''s mode is unchanged');
select is(pg_temp.fails($$ select pg_temp.cpost(pg_temp.id('c2'), '@codex another?', null) $$) , 'ok',
  'a second message while it runs is a note');

-- A pair chat with no named agents: picked provider-neutrally, reviewer differs.
select pg_temp.put('c3', public.create_chat('Pair two', pg_temp.id('room2'), null, 'pair') ->> 'chat_id');
select pg_temp.put('p3', pg_temp.cpost(pg_temp.id('c3'), 'Tidy the parser', null) ->> 'job_id');
select is((pg_temp.job(pg_temp.id('p3'))).mode, 'pair', 'a pair chat starts a pair job');
select ok((((pg_temp.task((pg_temp.job(pg_temp.id('p3'))).task_id)).content::jsonb) ->> 'builder')
          <> (((pg_temp.task((pg_temp.job(pg_temp.id('p3'))).task_id)).content::jsonb) ->> 'reviewer'),
  'builder and reviewer differ');
select is((pg_temp.job(pg_temp.id('p3'))).builder_provider, 'claude-code',
  'the builder alternates: Codex just built in this project, so Claude Code builds');

-- needs_project: nothing is stored, no job, no task.
select pg_temp.put('n_ev', pg_temp.evc('true')::text);
select pg_temp.put('n_jobs', pg_temp.cnt('team_jobs', 'true')::text);
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, 'Build it', null) $q$,
  (select id from public.chats where name = 'Ideas two'))), '55000:needs_project',
  'a chat with no project cannot start work');
select is(pg_temp.evc('true')::text || '|' || pg_temp.cnt('team_jobs', 'true'),
  pg_temp.id('n_ev') || '|' || pg_temp.id('n_jobs'), 'and nothing was written');

-- Moving a chat into a project makes it work; a mode change is recorded.
select pg_temp.put('c4', (select id from public.chats where name = 'Ideas two'));
select is(public.update_chat(pg_temp.id('c4'), p_room_id => pg_temp.id('room'), p_mode => 'team') ->> 'room_id',
  pg_temp.id('room'), 'a chat can be moved into a project');
select is((select body from pg_temp.ev(format('chat_id = %L and event_type = ''mode_changed''', pg_temp.id('c4'))) limit 1),
  NULL, 'the mode did not change (it was already Team), so no row');

-- provider_blocked: the request and a ThreadLink row are stored; no job, no task.
reset role;
select pg_temp.act_as_client();
select pg_temp.report('a-rt', 'claude-code', 'needs_sign_in');
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select pg_temp.put('n_jobs', pg_temp.cnt('team_jobs', 'true')::text);
select pg_temp.put('n_tasks', pg_temp.cnt('tasks', 'true')::text);
select pg_temp.put('blocked', pg_temp.cpost(pg_temp.id('c4'), 'Refactor the router', 'k-blocked')::text);
select is(pg_temp.id('blocked')::jsonb ->> 'routed', 'provider_blocked', 'an agent that needs sign-in blocks the start');
select is(pg_temp.id('blocked')::jsonb -> 'health',
  '[{"provider":"claude-code","health":"needs_sign_in"},{"provider":"codex","health":"ready"}]'::jsonb,
  'the answer lists each participant''s health');
select is(pg_temp.cnt('team_jobs', 'true')::text || '|' || pg_temp.cnt('tasks', 'true'),
  pg_temp.id('n_jobs') || '|' || pg_temp.id('n_tasks'), 'no job and no task were created');
select is((select body || '|' || author_kind || '|' || visibility
           from pg_temp.ev(format('chat_id = %L and event_type = ''provider_blocked''', pg_temp.id('c4')))),
  'Claude Code needs you to sign in again on this computer. Codex is ready.|threadlink|visible',
  'a ThreadLink row says who is not ready, in fixed words');
select is(pg_temp.evc(format('chat_id = %L and event_type = ''request'' and job_id is null', pg_temp.id('c4'))), 1,
  'the owner''s request stays in the chat');
select is(pg_temp.cpost(pg_temp.id('c4'), 'Refactor the router', 'k-blocked') ->> 'routed',
  'provider_blocked', 'a replay says it was blocked');
select pg_temp.put('c4solo', pg_temp.cpost(pg_temp.id('c4'), '@codex solo is fine') ->> 'job_id');
select ok(pg_temp.id('c4solo') is not null, 'a solo request to the ready agent still starts');
reset role;
select pg_temp.act_as_client();
select pg_temp.report('a-rt', 'claude-code');

-- ===========================================================================
-- 8. The room-keyed 0.8 post routes to the default chat
-- ===========================================================================
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select pg_temp.put('lj', public.post_chat_message(pg_temp.id('room'), '@team 0.8 client asks') ->> 'job_id');
select is((pg_temp.job(pg_temp.id('lj'))).chat_id, pg_temp.id('dchat'), 'a room-keyed post lands in the default chat');
select is(pg_temp.evc(format('idempotency_key is null and author_kind = ''owner'' and chat_id = %L and job_id = %L',
  pg_temp.id('dchat'), pg_temp.id('lj'))), 1, '...with the owner''s request');
select is(public.post_chat_message(pg_temp.id('room'), 'a note') ->> 'routed', 'note_to_active_job',
  'and notes go to the default chat''s running job');
select is(pg_temp.cpost(pg_temp.id('dchat'), 'a note by chat', null) ->> 'job_id', pg_temp.id('lj'),
  'the same job, whichever key is used');

-- ===========================================================================
-- 9. Controller chatId
-- ===========================================================================
select pg_temp.put('c5', public.create_chat('Controller target', pg_temp.id('room2')) ->> 'chat_id');
reset role;
select pg_temp.act_as_client();
select pg_temp.put('cj', pg_temp.start(pg_temp.id('room2'), 'Into a named chat', 'team', null, pg_temp.id('c5')) ->> 'job_id');
select is((pg_temp.job(pg_temp.id('cj'))).chat_id, pg_temp.id('c5'), 'a controller may name the chat');
select is(pg_temp.evc(format('job_id = %L and event_type = ''request'' and author_kind = ''controller'' and chat_id = %L',
  pg_temp.id('cj'), pg_temp.id('c5'))), 1, 'its request is shown in that chat');
select is(pg_temp.fails(format($q$ select pg_temp.start(%L, 'Wrong project', 'team', null, %L) $q$,
  pg_temp.id('room'), pg_temp.id('c5'))), 'P0002:chat_not_found', 'a chat of another project is not found');
select is(pg_temp.fails(format($q$ select pg_temp.start(%L, 'Bad id', 'team', null, 'not-a-chat') $q$,
  pg_temp.id('room'))), 'P0002:chat_not_found', 'a malformed chat id is not found');
select is(pg_temp.start(pg_temp.id('room2'), 'Default chat', 'pair', 'codex') ->> 'chat_id', pg_temp.id('dchat2'),
  'without chatId, controller work lands in the project''s default chat');

-- send_to_agent in a chat: an ordinary task, in that chat.
select pg_temp.put('st', public.create_chat_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('link2'),
  pg_temp.id('c5'), 'Look', 'Please look at the logs', null, null, null) ->> 'task_id');
select is((pg_temp.task(pg_temp.id('st'))).chat_id, pg_temp.id('c5'), 'a single task records its chat');
select is(pg_temp.evc(format('task_id = %L and event_type = ''request'' and chat_id = %L', pg_temp.id('st'), pg_temp.id('c5'))), 1,
  'its request is shown in that chat');
select is(pg_temp.fails(format($q$ select public.create_chat_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('link'),
  %L, 't', 'c', null, null, null) $q$, pg_temp.id('c5'))), 'P0002:chat_not_found',
  'the chat must be in the project the link reaches');

-- ===========================================================================
-- 10. Verdict provider, new reasons, retry
-- ===========================================================================
-- The solo job in that chat ends first (a retry needs the chat free).
select pg_temp.claim(pg_temp.id('c4solo'), 'c-c4solo');
select pg_temp.w(pg_temp.id('c4solo'), 'c-c4solo', 'set_status', '{"status":"cancelled"}');
-- A job blocked at planning with no plan: Claude Code could not sign in.
select pg_temp.put('rj', pg_temp.start(pg_temp.id('room'), 'Blocked early', 'team', null, pg_temp.id('c4')) ->> 'job_id');
select pg_temp.claim(pg_temp.id('rj'), 'c-rj');
select pg_temp.w(pg_temp.id('rj'), 'c-rj', 'open_round', '{"kind":"planning"}');
select is(pg_temp.fails($$ select pg_temp.w(pg_temp.id('rj'), 'c-rj', 'set_final',
  '{"verdict":"BLOCKED","reason":"agent_needs_sign_in","provider":"gemini","evidence":{}}') $$), '22023:',
  'the verdict provider must be a provider');
select is(pg_temp.w(pg_temp.id('rj'), 'c-rj', 'set_final',
  '{"verdict":"BLOCKED","reason":"agent_needs_sign_in","provider":"claude-code","evidence":{}}') ->> 'verdict_provider',
  'claude-code', 'set_final records who the reason is about');
select is((pg_temp.job(pg_temp.id('rj'))).last_phase, 'planning', 'the job stopped during planning');
select is((select body from pg_temp.ev(format('job_id = %L and event_type = ''job_verdict''', pg_temp.id('rj')))),
  E'Result: BLOCKED\nClaude Code needs you to sign in again on this computer.\nTeam Mode job. No project checks are set.',
  'the verdict line names the provider from trusted state');

reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('bj'))),
  '55000:not_retryable', 'a cancelled job is not retried this way');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'gemini') $q$, pg_temp.id('rj'))),
  '22023:invalid_roles', 'the coordinator must be a known provider');
reset role;
select pg_temp.act_as_client();
select pg_temp.report('a-rt', 'codex', 'usage_exhausted');
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('rj'))),
  '55000:provider_unhealthy', 'a retry is refused while a participant is not ready');
reset role;
select pg_temp.act_as_client();
select pg_temp.report('a-rt', 'codex');
select pg_temp.report('a-rt', 'claude-code');
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select pg_temp.put('rr', public.retry_job_with_roles(pg_temp.id('rj'), 'codex') ->> 'job_id');
select is((pg_temp.job(pg_temp.id('rr'))).chat_id || '|' || (pg_temp.job(pg_temp.id('rr'))).goal,
  pg_temp.id('c4') || '|Blocked early', 'the retry is a new job in the same chat, same goal');
select is((pg_temp.job(pg_temp.id('rr'))).role_overrides, '{"coordinator":"codex"}'::jsonb,
  'with the chosen coordinator');
select is(((pg_temp.task((pg_temp.job(pg_temp.id('rr'))).task_id)).content::jsonb) -> 'roleOverrides',
  '{"coordinator":"codex"}'::jsonb, 'the carrier tells the Runtime');
select is((pg_temp.job(pg_temp.id('rr'))).retried_from_job_id, pg_temp.id('rj'), 'and remembers what it retries');
select is(public.retry_job_with_roles(pg_temp.id('rj'), 'codex') ->> 'job_id', pg_temp.id('rr'),
  'retrying again returns the same retry (never two)');
select is((select body from pg_temp.ev(format('job_id = %L and event_type = ''job_status'' and visibility = ''visible''', pg_temp.id('rr')))),
  'Retrying the blocked job: Codex coordinates.', 'the chat says so in fixed words');

-- The new verdict reasons are accepted.
reset role;
select pg_temp.act_as_client();
select pg_temp.claim(pg_temp.id('rr'), 'c-rr');
select is(pg_temp.w(pg_temp.id('rr'), 'c-rr', 'set_final',
  '{"verdict":"BLOCKED","reason":"api_key_auth","provider":"codex","evidence":{}}') ->> 'verdict_reason', 'api_key_auth',
  'api_key_auth is a verdict reason');
select is((select body from pg_temp.ev(format('job_id = %L and event_type = ''job_verdict''', pg_temp.id('rr')))),
  E'Result: BLOCKED\nCodex is signed in with an API key, which would bill per use; ThreadLink did not use it.\nTeam Mode job. No project checks are set.',
  'and its line names the provider');
select is((pg_temp.job(pg_temp.id('rr'))).last_phase, 'queued', 'a job blocked at claim stopped before normalising');
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'claude-code') $q$, pg_temp.id('rr'))),
  'ok', 'a retry of a retry is allowed when it too was blocked early');

-- mark_chat_read never passes the newest row and never goes back.
select is((public.mark_chat_read(pg_temp.id('c4'), 9223372036854775807) ->> 'last_read_seq')::bigint,
  (select max(seq) from public.chat_events where chat_id = pg_temp.id('c4')), 'read up to the newest row');
select is((public.mark_chat_read(pg_temp.id('c4'), 0) ->> 'last_read_seq')::bigint,
  (select max(seq) from public.chat_events where chat_id = pg_temp.id('c4')), 'and never backwards');

-- chat_list_extras: the newest visible row and controller labels.
select is((select controller_labels from public.chat_list_extras(array[pg_temp.id('c5')])), array['ChatGPT'],
  'the controller seen in a chat is listed by its trusted label');
select is((select last_seq from public.chat_list_extras(array[pg_temp.id('c4')])),
  (select max(seq) from public.chat_events where chat_id = pg_temp.id('c4') and visibility = 'visible'),
  'the newest visible row');

-- Deleting a project hides its default chat (history kept).
select public.delete_room(pg_temp.id('room2'));
select ok((pg_temp.chat(pg_temp.id('dchat2'))).deleted_at is not null, 'a deleted project''s default chat is hidden');
select ok((pg_temp.chat(pg_temp.id('c5'))).deleted_at is null, 'other chats in it stay');
select is(pg_temp.fails(format($q$ select pg_temp.cpost(%L, 'more', null) $q$, pg_temp.id('c5'))),
  '55000:needs_project', 'but cannot start work until they get a project');

-- ===========================================================================
-- 11. Health is per computer; one running job per chat; replay first;
--     retry after a move; atomic updates; owner action limits
-- ===========================================================================
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt2'), 'tlc_cfart2');
reset role;
select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt2'), 'Desktop', 'windows', 'desktop', '0.9.0');
select pg_temp.put('ws3', public.upsert_runtime_workspace(pg_temp.h('a-rt2'), pg_temp.k('D:/w/Third'),
  'Third', 'D:\w\Third', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt2'), '0.9.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent3', public.register_runtime_session(pg_temp.h('a-rt2'), pg_temp.id('ws3'),
  'cc:third', 'Third worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('link3', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent3')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt2'), pg_temp.id('agent3'), pg_temp.id('link3'));
select pg_temp.put('room3', public.create_room(pg_temp.h('a-chat'), pg_temp.id('chat'), 'Third', pg_temp.id('link3')) ->> 'room_id');
-- Computer A (a-rt): both ready. Computer B (a-rt2): Codex needs sign-in.
select pg_temp.report('a-rt', 'claude-code');
select pg_temp.report('a-rt', 'codex');
select pg_temp.report('a-rt2', 'claude-code');
select pg_temp.report('a-rt2', 'codex', 'needs_sign_in');
select is(pg_temp.detail($$ select pg_temp.start(pg_temp.id('room3'), 'On computer B') $$),
  'claude-code=ready,codex=needs_sign_in', 'a project on computer B is gated by B''s own health');
select is(pg_temp.fails($$ select pg_temp.start(pg_temp.id('room'), 'On computer A') $$), 'ok',
  'while computer A''s project is not blocked by B');
select pg_temp.report('a-rt', 'codex', 'needs_sign_in');
select pg_temp.report('a-rt2', 'codex');
select is(pg_temp.detail($$ select pg_temp.start(pg_temp.id('room'), 'A again') $$),
  'claude-code=ready,codex=needs_sign_in', 'and B being ready does not unblock A');
select is(pg_temp.fails($$ select pg_temp.start(pg_temp.id('room3'), 'B now', 'pair', 'codex') $$), 'ok',
  'and computer B, now ready, starts work');

-- Replay before the gate: a retried controller request returns its job.
select pg_temp.report('a-rt', 'codex');
select pg_temp.put('rk', public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('room'), 'Keyed',
  null, null, null, null, null, 'rk-1', 'team', null, null) ->> 'job_id');
select pg_temp.report('a-rt', 'codex', 'needs_sign_in');
select is(public.start_team_job(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('room'), 'Keyed',
  null, null, null, null, null, 'rk-1', 'team', null, null) ->> 'job_id', pg_temp.id('rk'),
  'a retried controller request returns its job even though an agent is not ready now');
select pg_temp.report('a-rt', 'codex');

-- One running job per named chat (the default chat keeps 0.8 parallel controller jobs).
select is(pg_temp.fails(format($q$ select pg_temp.start(%L, 'Busy chat', 'team', null, %L) $q$,
  pg_temp.id('room'), pg_temp.id('c1'))), '55000:job_active',
  'a controller cannot start a second running job in a named chat');
select is(pg_temp.fails($$ select pg_temp.start(pg_temp.id('room'), 'Parallel in the default chat') $$), 'ok',
  'a controller that names no chat may still run jobs in parallel (0.8)');

-- Retry after the chat moved to another project: a clear refusal.
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select pg_temp.put('c6', public.create_chat('Mover', pg_temp.id('room')) ->> 'chat_id');
reset role;
select pg_temp.act_as_client();
select pg_temp.put('mj', pg_temp.start(pg_temp.id('room'), 'Blocked then moved', 'team', null, pg_temp.id('c6')) ->> 'job_id');
select pg_temp.claim(pg_temp.id('mj'), 'c-mj');
select pg_temp.w(pg_temp.id('mj'), 'c-mj', 'set_final', '{"verdict":"BLOCKED","reason":"agent_failed","evidence":{}}');
reset role;
select pg_temp.act_as_user('user_ChatFirstAlice01');
select public.update_chat(pg_temp.id('c6'), p_room_id => pg_temp.id('room3'));
select is(pg_temp.fails(format($q$ select public.retry_job_with_roles(%L, 'codex') $q$, pg_temp.id('mj'))),
  '55000:project_changed', 'a retry after the chat moved says so');

-- update_chat is one atomic change, pin and archive included.
select is(public.update_chat(pg_temp.id('c6'), p_name => 'Moved', p_pinned => true, p_archived => true)
          ->> 'pinned' || '|' || (pg_temp.chat(pg_temp.id('c6'))).name || '|'
          || ((pg_temp.chat(pg_temp.id('c6'))).archived_at is not null),
  'true|Moved|true', 'name, pin and archive in one call');
select is(pg_temp.fails(format($q$ select public.update_chat(%L, p_name => 'Half', p_pinned => false, p_mode => 'swarm') $q$,
  pg_temp.id('c6'))), '22023:invalid_mode', 'a refused change...');
select is((pg_temp.chat(pg_temp.id('c6'))).name || '|' || ((pg_temp.chat(pg_temp.id('c6'))).pinned_at is not null),
  'Moved|true', '...applies nothing');

-- Cheap owner actions are bounded too.
select is(pg_temp.fails(format($q$ do $d$ begin for i in 1..61 loop perform public.set_chat_pinned(%L, i %% 2 = 0); end loop; end $d$ $q$,
  pg_temp.id('c6'))), '54000:rate_limited', 'pin/archive/group changes are limited per minute');
select is(pg_temp.fails(format($q$ do $d$ begin for i in 1..300 loop perform public.mark_chat_read(%L, 0); end loop; end $d$ $q$,
  pg_temp.id('c6'))), 'ok', 'marking read without moving the cursor costs nothing');

select * from finish();
rollback;
