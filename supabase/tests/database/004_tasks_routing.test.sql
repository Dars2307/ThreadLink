-- ThreadLink Phase 5: tasks, messages, artifacts, routing (pgTAP). LOCAL disposable stack only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(100);

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
create function pg_temp.task_status(t text) returns text language sql security definer as $$
  select status from public.tasks where id = t
$$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures
-- A: controller C (s_c), controller C2 (s_c2), agents G1 (s_g1), G2 (s_g2)
--    links: L1 = s_c -> s_g1 (active), L2 = s_c2 -> s_g2 (active)
-- B: controller BC (s_bc), agent BG (s_bg), link LB (active)
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_TaskAlice01');
select public.provision_current_user('Alice', null);
select pg_temp.put('a_user', (select id from public.users));
select pg_temp.put('a_c',  public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c'), 'tlc_acaaaa') ->> 'id');
select pg_temp.put('a_c2', public.register_connection('chatgpt', 'controller', null, pg_temp.h('a-c2'), 'tlc_ac2aaa') ->> 'id');
select pg_temp.put('a_g1', public.register_connection('claude-code', 'agent', null, pg_temp.h('a-g1'), 'tlc_ag1aaa') ->> 'id');
select pg_temp.put('a_g2', public.register_connection('claude-code', 'agent', null, pg_temp.h('a-g2'), 'tlc_ag2aaa') ->> 'id');
reset role;
select pg_temp.act_as_user('user_TaskBob0002');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', null, pg_temp.h('b-c'), 'tlc_bcaaaa');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('b-g'), 'tlc_bgaaaa');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('s_c',  public.register_session(pg_temp.h('a-c'),  'Plan', null, 'c') ->> 'id');
select pg_temp.put('s_c2', public.register_session(pg_temp.h('a-c2'), 'Plan 2', null, 'c2') ->> 'id');
select pg_temp.put('s_g1', public.register_session(pg_temp.h('a-g1'), 'repo', null, 'g1') ->> 'id');
select pg_temp.put('s_g2', public.register_session(pg_temp.h('a-g2'), 'repo 2', null, 'g2') ->> 'id');
select pg_temp.put('s_bc', public.register_session(pg_temp.h('b-c'),  null, null, 'bc') ->> 'id');
select pg_temp.put('s_bg', public.register_session(pg_temp.h('b-g'),  null, null, 'bg') ->> 'id');
select pg_temp.put('l1', public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('s_g1')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1'));
select pg_temp.put('l2', public.request_pairing(pg_temp.h('a-c2'), pg_temp.id('s_c2'), pg_temp.id('s_g2')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('l2'));
select pg_temp.put('lb', public.request_pairing(pg_temp.h('b-c'), pg_temp.id('s_bc'), pg_temp.id('s_bg')) ->> 'id');
select public.approve_pairing(pg_temp.h('b-g'), pg_temp.id('s_bg'), pg_temp.id('lb'));
reset role;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.tasks'::regclass), 'RLS on tasks');
select ok((select relrowsecurity from pg_class where oid = 'public.messages'::regclass), 'RLS on messages');
select ok((select relrowsecurity from pg_class where oid = 'public.artifacts'::regclass), 'RLS on artifacts');
select ok(not has_table_privilege('anon', 'public.tasks', 'select'), 'anon cannot read tasks');
select ok(not has_table_privilege('anon', 'public.messages', 'select'), 'anon cannot read messages');
select ok(not has_table_privilege('authenticated', 'public.tasks', 'insert'), 'no direct task INSERT');
select ok(not has_table_privilege('authenticated', 'public.tasks', 'update'), 'no direct task UPDATE');
select ok(not has_table_privilege('authenticated', 'public.messages', 'insert'), 'no direct message INSERT');
select ok(not has_table_privilege('authenticated', 'public.artifacts', 'insert'), 'no direct artifact INSERT');
select ok(not has_table_privilege('authenticated', 'public.tasks', 'delete'), 'no task DELETE (history kept)');

-- ---------------------------------------------------------------------------
-- Send: controller creates a task over its active link
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('t1', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'),
  'Fix login', 'Please fix the login bug', 'A1', 'code', 'key-1') ->> 'task_id');
select matches(pg_temp.id('t1'), '^tltask_[0-9a-f]{32}$', 'task has a tltask_ ID');
select is(
  (public.get_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) ->> 'target_session_id'),
  pg_temp.id('s_g1'),
  'target session resolved from the link (never supplied by the caller)'
);
select is(
  (public.get_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) ->> 'status'),
  'queued', 'new task is queued'
);
select is(
  (public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'),
    'Different title', 'different content', 'B', 'general', 'key-1') ->> 'task_id'),
  pg_temp.id('t1'),
  'same idempotency key returns the original task (content is not the key)'
);
select is(
  (public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'),
    'Fix login', 'Please fix the login bug', 'A1', 'code', 'key-1') ->> 'created')::boolean,
  false, 'idempotent replay reports created = false'
);
reset role;
select is((select count(*)::int from public.tasks where idempotency_key = 'key-1'), 1, 'no duplicate task for the key');
select is(
  (select count(*)::int from public.messages where task_id = pg_temp.id('t1') and message_type = 'task'),
  1, 'exactly one task message envelope'
);
select is(
  (select recipient_session_id from public.messages where task_id = pg_temp.id('t1') and message_type = 'task'),
  pg_temp.id('s_g1'), 'task message addressed to the exact agent session'
);

select pg_temp.act_as_client();
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l1'), 't', 'c') $$,
  '42501', 'controller connection required', 'agent cannot create a controller task');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l2'), 't', 'c') $$,
  'P0002', 'thread link not found', 'controller cannot send over a link it is not the controller of');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c2'), pg_temp.id('l2'), 't', 'c') $$,
  'P0002', 'session not found', 'controller A cannot send from another controller session');
select throws_ok(
  $$ select public.create_task(pg_temp.h('b-c'), pg_temp.id('s_bc'), pg_temp.id('l1'), 't', 'c') $$,
  'P0002', 'thread link not found', 'User B cannot send through User A link');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('lb'), 't', 'c') $$,
  'P0002', 'thread link not found', 'User A cannot send through User B link');
select throws_ok(
  $$ select public.create_task(pg_temp.h('b-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 't', 'c') $$,
  'P0002', 'session not found', 'User B cannot send from User A controller session');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), 'tllnk_00000000000000000000000000000000', 't', 'c') $$,
  'P0002', 'thread link not found', 'nonexistent link is indistinguishable');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), repeat('x', 256), 'c') $$,
  '23514', null, 'title over 255 chars rejected');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 't', repeat('x', 65537)) $$,
  '23514', null, 'content over 64 KB rejected');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 't', 'c', 'Z9') $$,
  '23514', null, 'invalid priority rejected');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 't', 'c', 'C', 'general', null, 5) $$,
  '22023', null, 'invalid expiry rejected');
reset role;
select throws_ok(
  $$ insert into public.tasks (owner_user_id, thread_link_id, origin_session_id, target_session_id, title, content)
     values (pg_temp.id('a_user'), pg_temp.id('l1'), pg_temp.id('s_c'), pg_temp.id('s_g2'), 't', 'c') $$,
  '23514', null, 'a task whose target is not the link agent is unrepresentable (even for privileged writers)');

-- ---------------------------------------------------------------------------
-- Inbox + claim
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select is(
  (select jsonb_agg(e ->> 'task_id') from jsonb_array_elements(public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1'))) e),
  jsonb_build_array(pg_temp.id('t1')), 'agent inbox receives exactly the routed task'
);
select is(
  public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1')) -> 0 ->> 'content',
  'Please fix the login bug', 'inbox delivers the task content to the exact target'
);
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g2'), pg_temp.id('s_g2'))), 0, 'another agent session sees nothing');
select is(jsonb_array_length(public.list_inbox(pg_temp.h('b-g'), pg_temp.id('s_bg'))), 0, 'User B agent sees nothing');
select throws_ok(
  $$ select public.list_inbox(pg_temp.h('a-c'), pg_temp.id('s_c')) $$,
  '42501', null, 'controller has no inbox (agent-only)');
select throws_ok(
  $$ select public.list_inbox(pg_temp.h('a-g2'), pg_temp.id('s_g1')) $$,
  'P0002', null, 'agent cannot read another connection''s inbox');

select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('t1'), 'w1') $$,
  'P0002', 'task not found', 'Agent A2 cannot claim a task routed to Agent A1');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('b-g'), pg_temp.id('s_bg'), pg_temp.id('t1'), 'w1') $$,
  'P0002', 'task not found', 'User B agent cannot claim User A task');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1'), 'w1') $$,
  '42501', null, 'controller cannot claim its own delegated task');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'bad ref!') $$,
  '22023', null, 'invalid claim_ref rejected');
select is(
  (public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1') ->> 'status'),
  'claimed', 'exact target agent claims the task');
select is(
  (public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1') ->> 'status'),
  'claimed', 'claim retry with the same claim_ref is idempotent');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-2') $$,
  '55000', null, 'a second worker cannot claim an owned task');
reset role;
select isnt(
  (select read_at from public.messages where task_id = pg_temp.id('t1') and message_type = 'task'),
  null, 'claim marks the task message read');

-- ---------------------------------------------------------------------------
-- Work: start, progress, complete with artifact
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.start_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-2') $$,
  '55000', null, 'only the claiming worker can start');
select is(
  (public.start_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1') ->> 'status'),
  'working', 'claiming worker starts the task');
select matches(
  public.report_progress(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1', 'Found the bug') ->> 'message_id',
  '^tlmsg_[0-9a-f]{32}$', 'progress message recorded with a tlmsg_ ID');
select throws_ok(
  $$ select public.report_progress(pg_temp.h('a-g2'), pg_temp.id('s_g2'), pg_temp.id('t1'), 'worker-1', 'x') $$,
  'P0002', null, 'another agent cannot post progress on the task');
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-2', 'done') $$,
  '55000', null, 'only the claiming worker can complete');
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1', 'done',
       '[{"type": "virus", "reference": "x"}]'::jsonb) $$,
  '23514', null, 'unknown artifact type rejected (and nothing is completed)');
select is(pg_temp.task_status(pg_temp.id('t1')), 'working', 'failed completion left the task working');
select is(
  (public.complete_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1', 'Fixed in abc123',
     '[{"type": "git_commit", "reference": "abc123", "metadata": {"branch": "main"}}]'::jsonb) ->> 'status'),
  'completed', 'agent completes with a result and artifact');
select throws_ok(
  $$ select public.complete_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-1', 'again') $$,
  '55000', null, 'completion is terminal');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1'), 'worker-9') $$,
  '55000', null, 'a completed task cannot be re-claimed');
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1'))), 0, 'completed task leaves the inbox');

-- ---------------------------------------------------------------------------
-- Result path: only the originating controller session
-- ---------------------------------------------------------------------------
select is(
  (public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) ->> 'result'),
  'Fixed in abc123', 'result returned to the origin controller');
select is(
  (public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) -> 'artifacts' -> 0 ->> 'reference'),
  'abc123', 'artifact reference returned to the origin');
select is(
  jsonb_array_length(public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) -> 'progress'),
  1, 'progress messages returned to the origin');
select isnt(
  (public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) ->> 'completed_at'),
  null, 'timestamps returned');
select throws_ok(
  $$ select public.get_task_result(pg_temp.h('a-c2'), pg_temp.id('s_c2'), pg_temp.id('t1')) $$,
  'P0002', 'task not found', 'another controller session of the same user cannot read the result');
select throws_ok(
  $$ select public.get_task_result(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t1')) $$,
  '42501', null, 'the agent cannot use the controller result path');
select throws_ok(
  $$ select public.get_task_result(pg_temp.h('b-c'), pg_temp.id('s_bc'), pg_temp.id('t1')) $$,
  'P0002', 'task not found', 'User B cannot read User A result');
select throws_ok(
  $$ select public.get_task(pg_temp.h('b-g'), pg_temp.id('s_bg'), pg_temp.id('t1')) $$,
  'P0002', 'task not found', 'User B cannot read User A task');
reset role;
select is(
  (select recipient_session_id from public.messages where task_id = pg_temp.id('t1') and message_type = 'result'),
  pg_temp.id('s_c'), 'result message addressed to the originating controller session');
select is(
  (select in_reply_to from public.messages where task_id = pg_temp.id('t1') and message_type = 'result'),
  (select id from public.messages where task_id = pg_temp.id('t1') and message_type = 'task'),
  'result preserves in_reply_to the task envelope');

-- ---------------------------------------------------------------------------
-- Failure path
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('t2', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 'Deploy', 'Deploy it') ->> 'task_id');
select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t2'), 'worker-1');
select is(
  (public.fail_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t2'), 'worker-1', 'Build failed') ->> 'status'),
  'failed', 'agent can fail a task');
select is(
  (public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t2')) ->> 'error'),
  'Build failed', 'error returned to the origin');
select throws_ok(
  $$ select public.start_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t2'), 'worker-1') $$,
  '55000', null, 'failed task cannot be silently reactivated');

-- Priority ordering: A1 before B in the inbox.
select pg_temp.put('t_low',  public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 'low', 'x', 'E') ->> 'task_id');
select pg_temp.put('t_frog', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 'frog', 'x', 'A1') ->> 'task_id');
select is(
  public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1')) -> 0 ->> 'task_id',
  pg_temp.id('t_frog'), 'A1 (the frog) is delivered first');

-- ---------------------------------------------------------------------------
-- Revoked before delivery -> cancelled, never delivered
-- ---------------------------------------------------------------------------
select public.revoke_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'));
select is(pg_temp.task_status(pg_temp.id('t_low')), 'cancelled', 'revoking the link cancels queued tasks');
reset role;
select is(
  (select cancel_reason from public.tasks where id = pg_temp.id('t_low')), 'link_revoked', 'cancel reason recorded');
select pg_temp.act_as_client();
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1'))), 0, 'revoked link delivers nothing');
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t_frog'), 'worker-1') $$,
  '55000', null, 'revoked link cannot deliver a queued task via claim');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l1'), 't', 'c') $$,
  'P0002', 'thread link not found', 'revoked link cannot send');
select is(
  (public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) ->> 'result'),
  'Fixed in abc123', 'completed history stays readable to the origin after revocation');
select is(
  (public.get_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t_frog')) ->> 'content'),
  null, 'the agent no longer receives content once the route is gone');
reset role;

-- ---------------------------------------------------------------------------
-- Delivery-time re-validation is independent of the cascade
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('l3', public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('s_g1')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l3'));
select pg_temp.put('t3', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l3'), 'T3', 'x') ->> 'task_id');
reset role;
alter table public.thread_links disable trigger thread_links_cascade_tasks;
update public.thread_links set status = 'revoked', revoked_reason = 'revoked_by_owner' where id = pg_temp.id('l3');
alter table public.thread_links enable trigger thread_links_cascade_tasks;
select is(pg_temp.task_status(pg_temp.id('t3')), 'queued', 'setup: cascade bypassed, task still queued');
select pg_temp.act_as_client();
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1'))), 0,
  'delivery-time check refuses a task whose link is no longer active');
reset role;
select results_eq(
  $$ select status, cancel_reason from public.tasks where id = pg_temp.id('t3') $$,
  $$ values ('cancelled'::text, 'route_invalid'::text) $$,
  'task cancelled at delivery time with reason route_invalid');

-- Expiry is enforced at delivery time.
select pg_temp.act_as_client();
select pg_temp.put('l4', public.request_pairing(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('s_g1')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('l4'));
select pg_temp.put('t4', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l4'), 'T4', 'x', 'C', 'general', null, 60) ->> 'task_id');
reset role;
alter table public.tasks disable trigger tasks_guard_update;
update public.tasks set expires_at = now() - interval '1 minute' where id = pg_temp.id('t4');
alter table public.tasks enable trigger tasks_guard_update;
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t4'), 'worker-1') $$,
  '55000', null, 'an expired task cannot be claimed');
select is(jsonb_array_length(public.list_inbox(pg_temp.h('a-g1'), pg_temp.id('s_g1'))), 0,
  'an expired task is never delivered');
reset role;
select is(pg_temp.task_status(pg_temp.id('t4')), 'expired', 'the inbox sweep persists the expiry');

-- ---------------------------------------------------------------------------
-- Retired sessions and revoked connections
-- ---------------------------------------------------------------------------
select pg_temp.act_as_client();
select pg_temp.put('t5', public.create_task(pg_temp.h('a-c2'), pg_temp.id('s_c2'), pg_temp.id('l2'), 'T5', 'x') ->> 'task_id');
select public.retire_session(pg_temp.h('a-c2'), pg_temp.id('s_c2'));
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c2'), pg_temp.id('s_c2'), pg_temp.id('l2'), 't', 'c') $$,
  '55000', null, 'retired session cannot send');
select is(pg_temp.task_status(pg_temp.id('t5')), 'cancelled', 'retiring the origin session cancels its open tasks');

select pg_temp.put('t6', public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l4'), 'T6', 'x') ->> 'task_id');
select public.retire_session(pg_temp.h('a-g1'), pg_temp.id('s_g1'));
select throws_ok(
  $$ select public.claim_task(pg_temp.h('a-g1'), pg_temp.id('s_g1'), pg_temp.id('t6'), 'worker-1') $$,
  '55000', null, 'retired agent cannot claim');
reset role;

select pg_temp.act_as_user('user_TaskAlice01');
select public.revoke_connection(pg_temp.id('a_g2'));
select public.revoke_connection(pg_temp.id('a_c'));
reset role;
select pg_temp.act_as_client();
select throws_ok(
  $$ select public.list_inbox(pg_temp.h('a-g2'), pg_temp.id('s_g2')) $$,
  '28000', null, 'revoked connection cannot receive');
select throws_ok(
  $$ select public.create_task(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('l4'), 't', 'c') $$,
  '28000', null, 'revoked connection cannot send');
select throws_ok(
  $$ select public.get_task_result(pg_temp.h('a-c'), pg_temp.id('s_c'), pg_temp.id('t1')) $$,
  '28000', null, 'revoked connection cannot read results');
reset role;

-- ---------------------------------------------------------------------------
-- Human (dashboard) RLS
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_TaskAlice01');
select ok((select count(*) from public.tasks) >= 8, 'owner reads own task history (all states kept)');
select ok((select count(*) from public.messages where task_id = pg_temp.id('t1')) = 3, 'owner reads own messages');
select ok((select count(*) from public.artifacts where task_id = pg_temp.id('t1')) = 1, 'owner reads own artifacts');
select throws_ok($$ update public.tasks set status = 'queued' $$, '42501', null, 'owner cannot write tasks directly');
reset role;
select pg_temp.act_as_user('user_TaskBob0002');
select is_empty($$ select 1 from public.tasks where owner_user_id = pg_temp.id('a_user') $$, 'User B cannot read User A tasks');
select is_empty($$ select 1 from public.messages where task_id = pg_temp.id('t1') $$, 'User B cannot read User A messages');
select is_empty($$ select 1 from public.artifacts where task_id = pg_temp.id('t1') $$, 'User B cannot read User A artifacts');
reset role;

select pg_temp.act_as_client();
select throws_ok('select 1 from public.tasks', '42501', null, 'anonymous cannot read tasks');
select throws_ok(
  $$ select public.create_task(null, pg_temp.id('s_c'), pg_temp.id('l4'), 't', 'c') $$,
  '28000', null, 'no credential, no send');
reset role;

-- Messages and tasks are immutable history.
select throws_ok(
  $$ update public.messages set content = 'tampered' where task_id = pg_temp.id('t1') and message_type = 'result' $$,
  '42501', null, 'messages cannot be rewritten, even by a privileged writer');
select throws_ok(
  $$ update public.tasks set status = 'queued' where id = pg_temp.id('t1') $$,
  '42501', null, 'completed task cannot be reactivated, even by a privileged writer');

select pg_temp.act_as_user('user_TaskAlice01');
select is(
  (select count(distinct action)::int from public.audit_events
   where action in ('task.created', 'task.claimed', 'task.completed', 'task.failed', 'task.cancelled', 'task.expired')),
  6, 'task lifecycle is audited');
reset role;

select * from finish();
rollback;
