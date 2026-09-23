-- ThreadLink Phase 6.7: acknowledgement, blocked states, notifications (pgTAP).
-- LOCAL stack only.

begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

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
create function pg_temp.task(t text) returns public.tasks language sql security definer as $$
  select * from public.tasks where id = t $$;
create function pg_temp.notif(t text) returns public.notifications language sql security definer as $$
  select * from public.notifications where task_id = t limit 1 $$;
create function pg_temp.delivery(t text, ch text) returns public.notification_deliveries
language sql security definer as $$
  select d.* from public.notification_deliveries d
  join public.notifications n on n.id = d.notification_id
  where n.task_id = t and d.channel = ch limit 1
$$;
create function pg_temp.notif_of(t text, ev text) returns public.notifications
language sql security definer as $$
  select * from public.notifications where task_id = t and event_type = ev limit 1
$$;
create function pg_temp.notif_count(t text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where task_id = t $$;
create function pg_temp.enable_email(t text) returns void language sql security definer as $x$
  update public.notification_settings
  set email_enabled = true, email_credential_state = 'configured', email_grace_seconds = 60
  where owner_user_id = (select owner_user_id from public.tasks where id = t)
$x$;
create function pg_temp.make_due(t text) returns void language sql security definer as $x$
  update public.notification_deliveries d
  set send_after = pg_catalog.now() - interval '1 minute'
  from public.notifications n
  where d.notification_id = n.id and n.task_id = t and d.channel = 'email'
$x$;
-- The sweep is granted to service_role only (it is the scheduler's entry
-- point); the test drives it through a definer wrapper.
create function pg_temp.sweep() returns int language sql security definer as $x$
  select public.run_notification_sweep(100)
$x$;
create function pg_temp.msg_count(t text, mt text) returns int language sql security definer as $$
  select count(*)::int from public.messages where task_id = t and message_type = mt $$;
grant select, insert, update on ids to anon, authenticated;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Two accounts, one Runtime each; a task from Alice's chat to her agent.
-- ---------------------------------------------------------------------------
select pg_temp.act_as_user('user_AckAlice000001');
select public.provision_current_user('Alice', null);
select public.register_connection('chatgpt', 'controller', 'ChatGPT', pg_temp.h('a-chat'), 'tlc_achat1');
select public.register_connection('chatgpt', 'controller', 'Other chat', pg_temp.h('a-chat2'), 'tlc_achat2');
select public.register_connection('claude-code', 'agent', null, pg_temp.h('a-rt'), 'tlc_art001');
reset role;
select pg_temp.act_as_user('user_AckBob00000001');
select public.provision_current_user('Bob', null);
select public.register_connection('chatgpt', 'controller', 'Bob chat', pg_temp.h('b-chat'), 'tlc_bchat1');
reset role;

select pg_temp.act_as_client();
select pg_temp.put('rt', public.register_runtime(pg_temp.h('a-rt'), 'Laptop', 'windows', 'desktop', '0.6.7') ->> 'id');
select pg_temp.put('ws', public.upsert_runtime_workspace(pg_temp.h('a-rt'), pg_temp.k('C:/work/ThreadLink'),
  'ThreadLink', 'C:\work\ThreadLink', null, null, null) ->> 'id');
select public.runtime_heartbeat(pg_temp.h('a-rt'), '0.6.7', '{"claude-code":"available"}', '{}');
select pg_temp.put('agent', public.register_runtime_session(pg_temp.h('a-rt'), pg_temp.id('ws'),
  'cc-worker:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Background worker', 'claude-code', 'worker',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') ->> 'id');
select pg_temp.put('chat', public.register_session(pg_temp.h('a-chat'), null, null, 'chat-1') ->> 'id');
select pg_temp.put('chat2', public.register_session(pg_temp.h('a-chat2'), null, null, 'chat-2') ->> 'id');
select pg_temp.put('link', public.request_pairing(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('agent')) ->> 'id');
select public.approve_pairing(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('link'));

select pg_temp.put('t1', public.create_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('link'),
  'Phase 6.7', 'do the work') ->> 'task_id');

-- ---------------------------------------------------------------------------
-- Blocked: alive, but not progressing
-- ---------------------------------------------------------------------------
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t1'), 'claim-1');
select public.start_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t1'), 'claim-1');
select is((pg_temp.task(pg_temp.id('t1'))).blocked_reason, null, 'a working task is not blocked');

select is(public.report_task_blocked(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t1'), 'claim-1',
  'plan_mode') ->> 'status', 'working', 'a blocked task keeps its claim; it has not died');
select is((pg_temp.task(pg_temp.id('t1'))).blocked_reason, 'plan_mode',
  'and it says why it cannot proceed');
select isnt((pg_temp.task(pg_temp.id('t1'))).blocked_at, null, 'with the time it became blocked');
select is(pg_temp.notif_count(pg_temp.id('t1')), 0,
  'plan mode does not notify: it is fixed by changing the mode, not by a nudge');

select throws_ok($$ select public.report_task_blocked(pg_temp.h('a-rt'), pg_temp.id('agent'),
  pg_temp.id('t1'), 'claim-1', 'bored') $$,
  '22023', null, 'an unknown blocked reason is refused');
select throws_ok($$ select public.report_task_blocked(pg_temp.h('a-chat'), pg_temp.id('chat'),
  pg_temp.id('t1'), 'claim-1', 'plan_mode') $$,
  '42501', null, 'the controller cannot declare the agent blocked');

-- Waiting for a human DOES notify.
select public.report_task_blocked(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t1'), 'claim-1',
  'user_input_required');
select is(pg_temp.notif_count(pg_temp.id('t1')), 1, 'needing the user raises one notification');
select is((pg_temp.notif(pg_temp.id('t1'))).event_type, 'user_input_required', 'of the right kind');

-- ---------------------------------------------------------------------------
-- Completion: notification, safe metadata, and an unacknowledged result
-- ---------------------------------------------------------------------------
select public.complete_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t1'), 'claim-1',
  'export const API_KEY = ''sk-live-secret''');
select is((pg_temp.task(pg_temp.id('t1'))).status, 'completed', 'the task completes');
select is((pg_temp.task(pg_temp.id('t1'))).blocked_reason, null, 'completing clears the block');
select is((pg_temp.task(pg_temp.id('t1'))).acknowledged_at, null, 'the result starts unacknowledged');

select is((pg_temp.notif_of(pg_temp.id('t1'), 'task_completed')).event_type, 'task_completed',
  'completion raises a notification');
select is((pg_temp.notif_of(pg_temp.id('t1'), 'task_completed')).title, 'Phase 6.7',
  'carrying the task title');
select is((pg_temp.notif_of(pg_temp.id('t1'), 'task_completed')).workspace_name, 'ThreadLink',
  'and the workspace it ran in');
select ok(to_jsonb(pg_temp.notif_of(pg_temp.id('t1'), 'task_completed'))::text not like '%sk-live-secret%',
  'and never the result body');

select is((pg_temp.delivery(pg_temp.id('t1'), 'desktop')).status, 'pending',
  'desktop delivery is queued immediately');
select is((pg_temp.delivery(pg_temp.id('t1'), 'email')).id, null,
  'email is not queued while it is switched off');

-- Repeating a state does not repeat the notification.
select is(pg_temp.notif_count(pg_temp.id('t1')), 2,
  'exactly one notification per task state, not one per report');

-- ---------------------------------------------------------------------------
-- Acknowledgement
-- ---------------------------------------------------------------------------
select is(public.get_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('t1')) ->> 'status',
  'completed', 'the controller can poll status');
select is((pg_temp.task(pg_temp.id('t1'))).acknowledged_at, null,
  'polling status is NOT acknowledgement');

select public.get_task_result(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('t1'));
select is((pg_temp.task(pg_temp.id('t1'))).acknowledged_at, null,
  'nor is fetching the result: the controller must say it has read it');

select is(public.acknowledge_task_result(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('t1'))
  ->> 'status', 'completed', 'the originating controller acknowledges');
select isnt((pg_temp.task(pg_temp.id('t1'))).acknowledged_at, null, 'which is recorded');
select is((pg_temp.task(pg_temp.id('t1'))).acknowledged_actor_type, 'controller',
  'with the actor type, so user/runtime/automation can follow later');

-- Idempotent: the second call must not move the timestamp.
select pg_temp.put('ack1', (pg_temp.task(pg_temp.id('t1'))).acknowledged_at::text);
select public.acknowledge_task_result(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('t1'));
select is((pg_temp.task(pg_temp.id('t1'))).acknowledged_at::text, pg_temp.id('ack1'),
  'acknowledging again changes nothing');

-- Nothing about acknowledgement reaches the agent.
select is(pg_temp.msg_count(pg_temp.id('t1'), 'task'), 1, 'the agent still sees exactly one task message');
select is(pg_temp.msg_count(pg_temp.id('t1'), 'progress'), 0, 'and no acknowledgement was sent to it');

-- Ownership.
select throws_ok($$ select public.acknowledge_task_result(pg_temp.h('b-chat'),
  pg_temp.id('chat'), pg_temp.id('t1')) $$,
  'P0002', null, 'another account cannot acknowledge this task');
select throws_ok($$ select public.acknowledge_task_result(pg_temp.h('a-chat2'),
  pg_temp.id('chat2'), pg_temp.id('t1')) $$,
  'P0002', null, 'another chat of the same user cannot acknowledge it either');
select throws_ok($$ select public.acknowledge_task_result(pg_temp.h('a-rt'),
  pg_temp.id('agent'), pg_temp.id('t1')) $$,
  '42501', null, 'the agent cannot acknowledge its own result');

-- ---------------------------------------------------------------------------
-- The email fallback: due, re-checked, suppressed
-- ---------------------------------------------------------------------------
-- Turn email on with a tiny grace period, then run a second task.
select pg_temp.enable_email(pg_temp.id('t1'));

select pg_temp.put('t2', public.create_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('link'),
  'Second task', 'more work') ->> 'task_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t2'), 'claim-2');
select public.complete_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t2'), 'claim-2', 'done');

select is((pg_temp.delivery(pg_temp.id('t2'), 'email')).status, 'pending',
  'an email fallback is queued for an unacknowledged result');
select ok((pg_temp.delivery(pg_temp.id('t2'), 'email')).send_after > pg_catalog.now(),
  'and is not due until the grace period has passed');

-- Not due yet: the sweeper leaves it alone.
select is(pg_temp.sweep(), 0, 'the sweeper ignores a fallback that is not due');

-- Make it due, then acknowledge before the sweep runs.
select pg_temp.make_due(pg_temp.id('t2'));

select public.acknowledge_task_result(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('t2'));
select is((pg_temp.delivery(pg_temp.id('t2'), 'email')).status, 'suppressed',
  'acknowledging cancels the fallback outright');
select is(pg_temp.sweep(), 0,
  'and the sweeper then has nothing to do');

-- A third task, left unacknowledged, becomes due and is handled exactly once.
select pg_temp.put('t3', public.create_task(pg_temp.h('a-chat'), pg_temp.id('chat'), pg_temp.id('link'),
  'Third task', 'more') ->> 'task_id');
select public.claim_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t3'), 'claim-3');
select public.complete_task(pg_temp.h('a-rt'), pg_temp.id('agent'), pg_temp.id('t3'), 'claim-3', 'done');
select pg_temp.make_due(pg_temp.id('t3'));

select is(pg_temp.sweep(), 1, 'a due, unacknowledged fallback is handled');
select is(pg_temp.sweep(), 0, 'running the sweep again does nothing: it is idempotent');
select is((pg_temp.delivery(pg_temp.id('t3'), 'email')).status, 'unavailable',
  'and is honestly marked unsendable, because no email channel is configured');

select throws_ok($$ select public.run_notification_sweep(100) $$,
  '42501', null, 'a client credential cannot run the sweep: it is the scheduler''s job');

select * from finish();
rollback;
