-- ThreadLink 0.10 credential chat API (pgTAP): the Runtime (desktop/terminal)
-- and controller (MCP) chat functions. Cross-account isolation, wrong
-- credential kinds, paused/revoked Runtimes, reachability through the
-- controller's own links, idempotent replays, the health gate, needs_project,
-- rate limits, per-chat cursors (no global seq), and privileges.
-- LOCAL stack only. Adversarial.

begin;

create extension if not exists pgtap with schema extensions;

select plan(95);

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
create function pg_temp.q(p_sql text) returns text language plpgsql security definer as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end;
$$;
create function pg_temp.ev(p_id text) returns public.chat_events language sql security definer as $$
  select * from public.chat_events where id = p_id $$;
create function pg_temp.job(j text) returns public.team_jobs language sql security definer as $$
  select * from public.team_jobs where id = j $$;
create function pg_temp.chat(c text) returns public.chats language sql security definer as $$
  select * from public.chats where id = c $$;
create function pg_temp.runtime_of(hash_seed text) returns text language sql security definer as $$
  select r.id from public.runtimes r join public.connection_credentials k on k.connection_id = r.connection_id
  where k.token_hash = threadlink_private.credential_digest(pg_temp.h(hash_seed)) $$;
create function pg_temp.post(rt text, chat text, body text, idem text default null, client text default 'desktop')
returns jsonb language sql as $$
  select public.runtime_post_chat_message(pg_temp.h(rt), chat, body, idem, client) $$;
create function pg_temp.cpost(ctl text, sess text, chat text, body text, idem text default null)
returns jsonb language sql as $$
  select public.controller_post_chat_message(pg_temp.h(ctl), sess, chat, body, idem) $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures. Alice: a controller (two sessions), a Runtime with two agent
-- sessions and two projects (the second linked only to her second
-- controller session), a paused Runtime, a revoked Runtime, and an agent
-- credential that never registered a Runtime. Bob: a controller, a Runtime,
-- a project and a chat.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_ChatApiAlice001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'Alice GPT', pg_temp.h('a-chat'), 'tlc_caacht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_caart1');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt-paused'), 'tlc_caart2');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt-revoked'), 'tlc_caart3');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-bare'), 'tlc_caart4');
reset role;
select pg_temp.act_as_user('user_ChatApiBob00001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob GPT', pg_temp.h('b-chat'), 'tlc_cabcht');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-rt'), 'tlc_cabrt1');
reset role;

select pg_temp.act_as_client();
select public.register_runtime(pg_temp.h('a-rt'), 'Alice PC', 'windows', 'desktop', '0.10.0');
select public.register_runtime(pg_temp.h('a-rt-paused'), 'Alice laptop', 'macos', 'desktop', '0.10.0');
select public.register_runtime(pg_temp.h('a-rt-revoked'), 'Alice old PC', 'linux', 'desktop', '0.10.0');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/a'), 'A', 'C:\a', null, null, null) ->> 'id');
select pg_temp.put('ws2', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/a2'), 'A2', 'C:\a2', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.10.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc:a', 'A worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('agent2', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws2'),
  'cc:a2', 'A2 worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('sess', public.register_session(pg_temp.h('a-chat'), null, null, 'cs-a') ->> 'id');
select pg_temp.put('sess2', public.register_session(pg_temp.h('a-chat'), null, null, 'cs-a2') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));
select pg_temp.put('link2', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('sess2'), pg_temp.id('agent2')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent2'), pg_temp.id('link2'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('room', public.create_room(pg_temp.h('a-chat'), pg_temp.id('sess'), 'Prism', pg_temp.id('link')) ->> 'room_id');
select pg_temp.put('room2', public.create_room(pg_temp.h('a-chat'), pg_temp.id('sess2'), 'Other', pg_temp.id('link2')) ->> 'room_id');

select public.register_runtime(pg_temp.h('b-rt'), 'Bob PC', 'linux', 'desktop', '0.10.0');
select pg_temp.put('bws', public.upsert_runtime_workspace(pg_temp.h('b-rt'), pg_temp.k('/b'), 'B', '/b', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('b-rt'), '0.10.0', '{"claude-code":"available"}', '{}');
select pg_temp.put('bagent', public.register_runtime_session(pg_temp.h('b-rt'), pg_temp.id('bws'),
  'cc:b', 'B worker', 'claude-code', 'fresh', null) ->> 'id');
select pg_temp.put('bsess', public.register_session(pg_temp.h('b-chat'), null, null, 'cs-b') ->> 'id');
select pg_temp.put('blink', public.request_pairing(pg_temp.h('b-chat'), pg_temp.id('bsess'), pg_temp.id('bagent')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-rt'), pg_temp.id('bagent'), pg_temp.id('blink'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'claude-code', pg_temp.doc('claude-code'));
select public.report_provider_detection(pg_temp.h('b-rt'), 'codex', pg_temp.doc('codex'));
select pg_temp.put('broom', public.create_room(pg_temp.h('b-chat'), pg_temp.id('bsess'), 'Bob project') ->> 'room_id');

reset role;
select pg_temp.act_as_user('user_ChatApiAlice001');
select pg_temp.put('achat', public.create_chat('Alice main', pg_temp.id('room')) ->> 'chat_id');
select pg_temp.put('anoproj', public.create_chat('No project yet') ->> 'chat_id');
select pg_temp.put('aother', public.create_chat('In the other project', pg_temp.id('room2')) ->> 'chat_id');
select public.update_runtime(pg_temp.runtime_of('a-rt-paused'), null, null, true, false);
select public.revoke_runtime(pg_temp.runtime_of('a-rt-revoked'));
reset role;
select pg_temp.act_as_user('user_ChatApiBob00001');
select pg_temp.put('bchat', public.create_chat('Bob secret chat', pg_temp.id('broom')) ->> 'chat_id');
select public.post_chat_message(p_chat_id => pg_temp.id('bchat'), p_body => 'Bob private goal', p_idempotency_key => 'shared-key');
reset role;
select pg_temp.put('ghost', 'tlcht_' || repeat('0', 32));
select pg_temp.put('ghostroom', 'tlrom_' || repeat('0', 32));
select pg_temp.put('ghostjob', 'tljob_' || repeat('0', 32));
select pg_temp.put('bjob', (select id from public.team_jobs where chat_id = pg_temp.id('bchat') limit 1));
select pg_temp.put('bevents', pg_temp.evc(format('chat_id = %L', pg_temp.id('bchat')))::text);

select pg_temp.act_as_client();

-- ===========================================================================
-- 1. Runtime credential: only an active, unpaused Runtime of the owner
-- ===========================================================================
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('a-chat'), false, null) $$),
  '42501:forbidden', 'a controller credential is refused on the Runtime chat API');
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('a-rt-paused'), false, null) $$),
  '42501:runtime_paused', 'a paused Runtime is refused');
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('a-rt-revoked'), false, null) $$),
  '28000:', 'a revoked Runtime is not authenticated at all');
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('a-bare'), false, null) $$),
  '42501:runtime_required', 'an agent credential that never registered a Runtime is refused');
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('nobody'), false, null) $$),
  '28000:', 'an unknown credential is not authenticated');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt-paused', %L, 'hi') $q$, pg_temp.id('achat'))),
  '42501:runtime_paused', 'a paused Runtime cannot post');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-chat', %L, 'hi') $q$, pg_temp.id('achat'))),
  '42501:forbidden', 'a controller cannot post as the owner');

-- ===========================================================================
-- 2. Another account's chat is exactly "not found", for every Runtime call
-- ===========================================================================
select is(pg_temp.fails(format($q$ select public.runtime_get_chat(pg_temp.h('a-rt'), %L) $q$, pg_temp.id('bchat'))),
  pg_temp.fails(format($q$ select public.runtime_get_chat(pg_temp.h('a-rt'), %L) $q$, pg_temp.id('ghost'))),
  'runtime_get_chat: another account''s chat = a missing chat');
select is(pg_temp.fails(format($q$ select public.runtime_get_chat(pg_temp.h('a-rt'), %L) $q$, pg_temp.id('bchat'))),
  'P0002:chat_not_found', '...which is chat_not_found');
select is(pg_temp.fails(format($q$ select public.runtime_chat_events(pg_temp.h('a-rt'), %L, null, null, null, false) $q$, pg_temp.id('bchat'))),
  'P0002:chat_not_found', 'runtime_chat_events');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'mine now') $q$, pg_temp.id('bchat'))),
  'P0002:chat_not_found', 'runtime_post_chat_message');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, '@team stop') $q$, pg_temp.id('bchat'))),
  'P0002:chat_not_found', 'cannot stop another account''s work');
select is(pg_temp.fails(format($q$ select public.runtime_mark_chat_read(pg_temp.h('a-rt'), %L, 1) $q$, pg_temp.id('bchat'))),
  'P0002:chat_not_found', 'runtime_mark_chat_read');
select is(pg_temp.fails(format($q$ select public.runtime_create_chat(pg_temp.h('a-rt'), 'x', %L, null) $q$, pg_temp.id('broom'))),
  pg_temp.fails(format($q$ select public.runtime_create_chat(pg_temp.h('a-rt'), 'x', %L, null) $q$, pg_temp.id('ghostroom'))),
  'runtime_create_chat in another account''s project = a missing project');
select is(pg_temp.fails(format($q$ select public.runtime_create_chat(pg_temp.h('a-rt'), 'x', %L, null) $q$, pg_temp.id('broom'))),
  'P0002:project_not_found', '...which is project_not_found');
select is(pg_temp.fails($$ select pg_temp.post('a-rt', 'not-a-chat-id', 'x') $$), 'P0002:chat_not_found',
  'a malformed chat id is "not found" too');
select is(pg_temp.evc(format('chat_id = %L', pg_temp.id('bchat')))::text, pg_temp.id('bevents'),
  'nothing was written into Bob''s chat');
select is((select count(*)::int from jsonb_array_elements(public.runtime_list_chats(pg_temp.h('a-rt'), true, null) -> 'chats') c
           where c ->> 'chat_id' = pg_temp.id('bchat')), 0, 'Bob''s chat is not in Alice''s list');
select ok(public.runtime_list_chats(pg_temp.h('a-rt'), true, null)::text !~ 'Bob', 'no trace of Bob in Alice''s list');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'reusing Bob''s key', 'shared-key') $q$, pg_temp.id('achat'))),
  'ok', 'idempotency keys are per account: Bob''s key means nothing to Alice');

-- ===========================================================================
-- 3. List, detail, projects
-- ===========================================================================
select is((select count(*)::int from jsonb_array_elements(public.runtime_list_chats(pg_temp.h('a-rt'), false, null) -> 'chats')),
  pg_temp.q($$ select count(*)::int from public.chats c join public.users u on u.id = c.owner_user_id
   where u.clerk_user_id = 'user_ChatApiAlice001' and c.deleted_at is null and c.archived_at is null $$)::int,
  'the list is every live chat of the owner');
select is((select count(*)::int from jsonb_array_elements(public.runtime_list_chats(pg_temp.h('a-rt'), false, 'main') -> 'chats')),
  1, 'search by name');
select is(pg_temp.fails($$ select public.runtime_list_chats(pg_temp.h('a-rt'), false, repeat('x', 101)) $$),
  '22023:invalid', 'an oversized search is refused');
select is((select count(*)::int from jsonb_array_elements(public.runtime_list_chats(pg_temp.h('a-rt'), false, '%') -> 'chats')),
  0, 'LIKE wildcards in a search are literal');
select is(jsonb_array_length(public.runtime_list_chats(pg_temp.h('a-rt'), false, null) -> 'projects'), 2,
  'the owner''s active projects are offered');
select ok((select bool_and((p ->> 'this_computer')::boolean)
           from jsonb_array_elements(public.runtime_list_chats(pg_temp.h('a-rt'), false, null) -> 'projects') p),
  'projects say they run on this computer');
select is(public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('achat')) -> 'project' ->> 'name', 'Prism',
  'a chat names its project');
select is(public.runtime_list_chats(pg_temp.h('a-rt'), false, null) -> 'runtime' ->> 'label', 'Alice PC',
  'the list says which computer is asking');
select is((public.runtime_list_chats(pg_temp.h('a-rt'), false, null) -> 'runtime' ->> 'update_required')::boolean, false,
  '...and that a 0.10 Runtime needs no update');
select is(jsonb_typeof(public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('achat')) -> 'activity'), 'array',
  'one chat carries its live activity');
select is(public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('achat')) -> 'project' ->> 'runs_on', 'Alice PC',
  '...and the computer it runs on');
select is((select count(*)::int from jsonb_array_elements(public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('achat')) -> 'participants') p
           where p ->> 'kind' = 'agent' and p ->> 'health' = 'ready'), 2, 'both agents show as ready');
select ok(public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('achat')) -> 'project' is not null
          and public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('anoproj')) -> 'project' = 'null'::jsonb,
  'a chat with no project says so');

-- ===========================================================================
-- 4. Posting as the owner from the desktop / terminal
-- ===========================================================================
select pg_temp.put('p1', pg_temp.post('a-rt', pg_temp.id('achat'), 'Make the login page faster', 'rt-key-1', 'terminal')::text);
select is(pg_temp.id('p1')::jsonb ->> 'routed', 'note_to_active_job',
  'a post into a chat with running work is a note for it (the job started by the shared-key post)');
select is((pg_temp.ev(pg_temp.id('p1')::jsonb ->> 'event_id')).client, 'terminal', 'the row records the terminal client');
select is((pg_temp.ev(pg_temp.id('p1')::jsonb ->> 'event_id')).author_kind || '|' || (pg_temp.ev(pg_temp.id('p1')::jsonb ->> 'event_id')).author_label,
  'owner|You', 'authored by the owner, never by the Runtime');
select is(pg_temp.post('a-rt', pg_temp.id('achat'), 'Make the login page faster', 'rt-key-1', 'terminal') ->> 'event_id',
  pg_temp.id('p1')::jsonb ->> 'event_id', 'the same key replays the same message');
select is((pg_temp.post('a-rt', pg_temp.id('achat'), 'Make the login page faster', 'rt-key-1', 'terminal') ->> 'replayed')::boolean,
  true, '...and says it is a replay');
select is(pg_temp.evc(format('idempotency_key = %L', 'rt-key-1')), 1, '...and stores it once');
select is(pg_temp.q(format('select client from public.chat_events where chat_id = %L and idempotency_key = %L',
  pg_temp.id('bchat'), 'shared-key')), null, 'a web post records no client');
select is((select e -> 'delivery' ->> 'state'
           from jsonb_array_elements(public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('achat'), null, null, null, false) -> 'events') e
           where e ->> 'id' = pg_temp.id('p1')::jsonb ->> 'event_id'), 'queued',
  'a note to running work shows its delivery (queued)');
select is((select d -> 'delivery' ->> 'state'
           from jsonb_array_elements(public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('achat'), 999999, null, null, false) -> 'deliveries') d
           where (d ->> 'cursor')::bigint = (pg_temp.ev(pg_temp.id('p1')::jsonb ->> 'event_id')).chat_seq), 'queued',
  '...and a poll with nothing new still carries the notes'' delivery');
select ok(not (pg_temp.post('a-rt', pg_temp.id('achat'), 'x', 'rt-key-1') ? 'seq'), 'no global seq in a post result');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'x', null, 'web') $q$, pg_temp.id('achat'))),
  '22023:invalid', 'the client is desktop or terminal only');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'x', null, null) $q$, pg_temp.id('achat'))),
  '22023:invalid', '...and required');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, '   ') $q$, pg_temp.id('achat'))),
  '22023:empty', 'an empty message is refused');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, repeat('x', 4001)) $q$, pg_temp.id('achat'))),
  '22023:too_long', 'an oversized message is refused');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'x', 'bad key!') $q$, pg_temp.id('achat'))),
  '22023:invalid', 'a malformed idempotency key is refused');
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'Build it') $q$, pg_temp.id('anoproj'))),
  '55000:needs_project', 'a chat with no project cannot start work (needs_project)');
select is(pg_temp.post('a-rt', pg_temp.id('achat'), 'my key is sk-abcdefghijklmnopqrstuv now') ->> 'routed',
  'note_to_active_job', 'a note with a secret-shaped value...');
select is(pg_temp.evc(format('chat_id = %L and body like %L', pg_temp.id('achat'), '%sk-abcdefghijklmnop%')), 0,
  '...is stored redacted');

-- Health gate: the message and a ThreadLink row are stored, no job.
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex', 'needs_sign_in'));
select pg_temp.put('gated', public.runtime_create_chat(pg_temp.h('a-rt'), 'Gated', pg_temp.id('room'), 'team') ->> 'chat_id');
select pg_temp.put('g1', pg_temp.post('a-rt', pg_temp.id('gated'), 'Build the thing', 'rt-gate')::text);
select is(pg_temp.id('g1')::jsonb ->> 'routed', 'provider_blocked', 'an unready agent blocks new work');
select is((pg_temp.id('g1')::jsonb -> 'health' -> 1 ->> 'health'), 'needs_sign_in', '...and says who is not ready');
select is(pg_temp.evc(format('chat_id = %L and event_type = %L', pg_temp.id('gated'), 'provider_blocked')), 1,
  '...with a ThreadLink row in the chat');
select is(pg_temp.q(format('select count(*) from public.team_jobs where chat_id = %L', pg_temp.id('gated'))), '0', '...and no job');
select public.report_provider_detection(pg_temp.h('a-rt'), 'codex', pg_temp.doc('codex'));
select is(pg_temp.post('a-rt', pg_temp.id('gated'), 'Build the thing now', 'rt-gate-2') ->> 'routed', 'new_job',
  'once ready, a post starts work');

-- Rate limit: the same per-chat cap as the owner composer.
select pg_temp.put('flood', public.runtime_create_chat(pg_temp.h('a-rt'), 'Flood', null, null) ->> 'chat_id');
reset role;
-- The chat has no project, so a post stores nothing (needs_project): fill
-- this minute's quota with rows written directly. The cap is checked first.
insert into public.chat_events (owner_user_id, chat_id, author_kind, author_label, event_type, body)
select (select owner_user_id from public.chats where id = pg_temp.id('flood')), pg_temp.id('flood'),
       'owner', 'You', 'message', 'filler ' || g
from generate_series(1, 20) g;
select pg_temp.act_as_client();
select is(pg_temp.fails(format($q$ select pg_temp.post('a-rt', %L, 'one more') $q$, pg_temp.id('flood'))),
  '54000:rate_limited', 'the per-chat post rate limit applies to the desktop too');

-- ===========================================================================
-- 5. The timeline: a per-chat cursor, never the global seq
-- ===========================================================================
select pg_temp.put('page', public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'), null, null, null, false)::text);
select is((pg_temp.id('page')::jsonb -> 'events' -> 0 ->> 'cursor')::int, 1, 'a chat''s first row has cursor 1');
select is((pg_temp.id('page')::jsonb ->> 'cursor')::int,
  pg_temp.evc(format('chat_id = %L', pg_temp.id('gated'))), 'the cursor counts this chat''s rows only');
select ok(pg_temp.id('page') !~ '"seq"' and pg_temp.id('page') !~ 'agent_session_id' and pg_temp.id('page') !~ 'idempotency'
          and pg_temp.id('page') !~ 'task_id', 'no global seq, session id, task id or idempotency key in a page');
select is(jsonb_array_length(public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'),
  (pg_temp.id('page')::jsonb ->> 'cursor')::bigint, null, null, false) -> 'events'), 0, 'polling after the cursor: nothing new');
select is(jsonb_array_length(public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'), 0, null, 1, true) -> 'events'), 1,
  'limit bounds a page');
select is((public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'), 0, null, 1, true) ->> 'has_more')::boolean, true,
  '...and says there is more');
select is((public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'), 0, null, 1, true) ->> 'cursor')::int, 1,
  '...and the cursor stops at the last row returned');
select is(jsonb_array_length(public.runtime_chat_events(pg_temp.h('a-rt'), pg_temp.id('gated'), null, 2, null, true) -> 'events'), 1,
  'before: the rows before a cursor');
select is(pg_temp.fails(format($q$ select public.runtime_chat_events(pg_temp.h('a-rt'), %L, 1, 2, null, false) $q$, pg_temp.id('gated'))),
  '22023:invalid', 'after and before together are refused');
select is(pg_temp.fails(format($q$ select public.runtime_chat_events(pg_temp.h('a-rt'), %L, null, null, 201, false) $q$, pg_temp.id('gated'))),
  '22023:invalid', 'a page larger than 200 is refused');
select is(pg_temp.fails(format($q$ select public.runtime_chat_events(pg_temp.h('a-rt'), %L, -1, null, null, false) $q$, pg_temp.id('gated'))),
  '22023:invalid', 'a negative cursor is refused');

-- Read state.
select is((public.runtime_mark_chat_read(pg_temp.h('a-rt'), pg_temp.id('gated'), 2) ->> 'last_read_cursor')::int, 2,
  'mark read to a cursor');
select is((public.runtime_mark_chat_read(pg_temp.h('a-rt'), pg_temp.id('gated'), 1) ->> 'last_read_cursor')::int, 2,
  'never backwards');
select is((public.runtime_mark_chat_read(pg_temp.h('a-rt'), pg_temp.id('gated'), 999999) ->> 'last_read_cursor')::int,
  pg_temp.evc(format('chat_id = %L', pg_temp.id('gated'))), 'never past the newest row');
select is((public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('gated')) ->> 'unread')::boolean, false,
  'read chats are not unread');
select is((public.runtime_get_chat(pg_temp.h('a-rt'), pg_temp.id('gated')) ->> 'last_read_cursor')::bigint,
  (pg_temp.chat(pg_temp.id('gated'))).last_read_chat_seq, 'the read cursor is the chat''s own (last_read_chat_seq)');

-- ===========================================================================
-- 6. Controller: only chats reachable through its own active links
-- ===========================================================================
select pg_temp.put('cchat', public.controller_create_chat(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('room'), 'From GPT', 'pair') ->> 'chat_id');
select ok(pg_temp.id('cchat') ~ '^tlcht_', 'a controller creates a chat in a project it reaches');
select is(pg_temp.fails(format($q$ select public.controller_create_chat(pg_temp.h('a-chat'), %L, %L, 'x', null) $q$,
  pg_temp.id('sess'), pg_temp.id('room2'))), 'P0002:project_not_found',
  'not in the owner''s project it has no link to');
select is(pg_temp.fails(format($q$ select public.controller_create_chat(pg_temp.h('a-chat'), %L, %L, 'x', null) $q$,
  pg_temp.id('sess'), pg_temp.id('broom'))), 'P0002:project_not_found', 'nor in another account''s project');
select is((select count(*)::int from jsonb_array_elements(public.controller_list_chats(pg_temp.h('a-chat'), pg_temp.id('sess')) -> 'chats') c
           where c ->> 'chat_id' in (pg_temp.id('aother'), pg_temp.id('anoproj'), pg_temp.id('bchat'))), 0,
  'the list holds no unlinked, project-less or foreign chat');
select ok((select count(*) > 0 from jsonb_array_elements(public.controller_list_chats(pg_temp.h('a-chat'), pg_temp.id('sess')) -> 'chats') c
           where c ->> 'chat_id' = pg_temp.id('cchat')), '...but holds the reachable ones');
select is(pg_temp.fails(format($q$ select public.controller_get_chat(pg_temp.h('a-chat'), %L, %L, null, null) $q$,
  pg_temp.id('sess'), pg_temp.id('aother'))),
  pg_temp.fails(format($q$ select public.controller_get_chat(pg_temp.h('a-chat'), %L, %L, null, null) $q$,
  pg_temp.id('sess'), pg_temp.id('ghost'))), 'an unlinked chat of the same owner = a missing chat');
select is(pg_temp.fails(format($q$ select public.controller_get_chat(pg_temp.h('a-chat'), %L, %L, null, null) $q$,
  pg_temp.id('sess'), pg_temp.id('bchat'))), 'P0002:chat_not_found', 'another account''s chat is not found');
select is(pg_temp.fails(format($q$ select public.controller_get_chat(pg_temp.h('a-rt'), %L, %L, null, null) $q$,
  pg_temp.id('agent'), pg_temp.id('achat'))), '42501:', 'a Runtime credential is refused on the controller functions');
select is(pg_temp.fails(format($q$ select pg_temp.cpost('a-chat', %L, %L, 'hi') $q$, pg_temp.id('sess'), pg_temp.id('aother'))),
  'P0002:chat_not_found', 'a controller cannot post into a chat it has no link to');
select is(pg_temp.fails(format($q$ select pg_temp.cpost('b-chat', %L, %L, 'hi') $q$, pg_temp.id('bsess'), pg_temp.id('cchat'))),
  'P0002:chat_not_found', 'nor into another account''s chat');

-- Posting: a controller request routed by the chat's mode, idempotent.
select pg_temp.put('c1', pg_temp.cpost('a-chat', pg_temp.id('sess'), pg_temp.id('cchat'), 'Add rate limiting', 'gpt-1')::text);
select is((pg_temp.id('c1')::jsonb ->> 'created')::boolean, true, 'a controller post starts a job');
select is(pg_temp.id('c1')::jsonb ->> 'mode', 'pair', '...in the chat''s mode');
select is((pg_temp.job(pg_temp.id('c1')::jsonb ->> 'job_id')).origin, 'controller', '...as the controller''s work');
select is(pg_temp.q(format($q$ select author_kind || '|' || author_label from public.chat_events
           where job_id = %L and event_type = 'request' $q$, pg_temp.id('c1')::jsonb ->> 'job_id')),
  'controller|ChatGPT', 'the request is authored by the controller, with its label');
select is(pg_temp.cpost('a-chat', pg_temp.id('sess'), pg_temp.id('cchat'), 'Add rate limiting', 'gpt-1') ->> 'job_id',
  pg_temp.id('c1')::jsonb ->> 'job_id', 'the same key replays the same job');
select is(pg_temp.fails(format($q$ select pg_temp.cpost('a-chat', %L, %L, 'another thing') $q$, pg_temp.id('sess'), pg_temp.id('cchat'))),
  '55000:job_active', 'a controller cannot add to running work');
select is(pg_temp.fails(format($q$ select pg_temp.cpost('a-chat', %L, %L, '@team stop') $q$, pg_temp.id('sess'), pg_temp.id('cchat'))),
  '55000:job_active', 'nor stop it');
select is(public.controller_chat_status(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('cchat')) -> 'job' ->> 'job_id',
  pg_temp.id('c1')::jsonb ->> 'job_id', 'the chat status shows the running job');
select is(public.controller_job_result(pg_temp.h('a-chat'), pg_temp.id('sess'), pg_temp.id('c1')::jsonb ->> 'job_id') ->> 'chat_name',
  'From GPT', 'the job result names its chat');
select is(pg_temp.fails(format($q$ select public.controller_job_result(pg_temp.h('a-chat'), %L, %L) $q$, pg_temp.id('sess'), pg_temp.id('bjob'))),
  pg_temp.fails(format($q$ select public.controller_job_result(pg_temp.h('a-chat'), %L, %L) $q$, pg_temp.id('sess'), pg_temp.id('ghostjob'))),
  'another account''s job = a missing job');

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================
reset role;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'runtime\_%chat%' or p.proname like 'controller\_%')
             and (has_function_privilege('authenticated', p.oid, 'execute')
                  or not has_function_privilege('anon', p.oid, 'execute'))), 0,
  'the credential chat RPCs are callable by anon (credential) only');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'threadlink_private' and p.proname like 'chat\_api\_%'
             and (has_function_privilege('anon', p.oid, 'execute')
                  or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no client role can call the private helpers');

select * from finish();
rollback;
