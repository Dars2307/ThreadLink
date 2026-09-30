-- 0.11.3: a mid-sentence "pass:" is prose; secrets are still hidden.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select is(threadlink_private.redact_text('Follow-up after a deeper pass: the handler in ai.py leaks exception text.'),
  'Follow-up after a deeper pass: the handler in ai.py leaks exception text.',
  'a review that says "a deeper pass:" is not redacted (the Production case)');
select is(threadlink_private.redact_text('On the second pass: nothing new.'), 'On the second pass: nothing new.',
  'another mid-sentence "pass:" stays readable');
select is(threadlink_private.redact_text('pass: letmein'), 'pass: [redacted]', '"pass:" as a label is still redacted');
select is(threadlink_private.redact_text(E'notes\n  - pass: letmein now'), E'notes\n  - pass: [redacted]',
  '...also after a list bullet on its own line');
select is(threadlink_private.redact_text('the pass=letmein now'), 'the pass=[redacted]', '"pass=" is redacted anywhere');
select is(threadlink_private.redact_text('PASSWORD: correct horse battery staple'), 'PASSWORD: [redacted]',
  'other key: value rules are unchanged');
select is(threadlink_private.redact_text('db_creds: user secret'), 'db_creds: [redacted]', 'creds keys are unchanged');
select is(threadlink_private.redact_text('Authorization: Bearer abcdefghijkl12345'), 'Authorization: Bearer [redacted]',
  'a bearer token is hidden');

select * from finish();
rollback;
