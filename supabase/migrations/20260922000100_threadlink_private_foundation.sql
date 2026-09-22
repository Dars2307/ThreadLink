-- ThreadLink Phase 2: private schema, ID generation and identity helpers.
--
-- The `threadlink_private` schema is NOT exposed through the Supabase Data API
-- (only `public` and `graphql_public` are). It holds helpers used by RLS
-- policies, column defaults and triggers.

create schema if not exists threadlink_private;

revoke all on schema threadlink_private from public;
revoke all on schema threadlink_private from anon;
-- `authenticated` needs USAGE to evaluate RLS policies and column defaults
-- that call these helpers. It gets EXECUTE only on the specific functions below.
grant usage on schema threadlink_private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ID generation
--
-- ThreadLink IDs are `<prefix>_<32 lowercase hex>` built from gen_random_uuid()
-- (UUIDv4: 122 bits from the server CSPRNG). They are generated only inside the
-- database, are not time-ordered or sequential, and encode no personal data.
-- UUIDv7 was rejected because its leading 48 bits are a timestamp.
-- ---------------------------------------------------------------------------
create function threadlink_private.generate_id(prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
begin
  if prefix is null or prefix !~ '^tl[a-z]{3}$' then
    raise exception 'invalid ThreadLink id prefix' using errcode = '22023';
  end if;
  return prefix || '_' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
end;
$$;

comment on function threadlink_private.generate_id(text) is
  'Generates an unpredictable ThreadLink ID: <prefix>_<32 hex> from gen_random_uuid().';

-- ---------------------------------------------------------------------------
-- Verified external subject
--
-- Returns the Clerk user ID from the *verified* JWT's `sub` claim, or NULL if
-- the claim is missing or is not a well-formed Clerk user ID. Supabase verifies
-- the token signature (Clerk third-party auth) before claims reach Postgres.
-- NULL makes every ownership comparison fail, so callers fail closed.
-- ---------------------------------------------------------------------------
create function threadlink_private.current_clerk_user_id()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when claims.sub ~ '^user_[A-Za-z0-9]+$' then claims.sub
    else null
  end
  from (select auth.jwt() ->> 'sub' as sub) as claims
$$;

comment on function threadlink_private.current_clerk_user_id() is
  'Clerk user ID from the verified JWT sub claim; NULL if absent or malformed.';

-- Shared trigger: maintain updated_at.
create function threadlink_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function threadlink_private.generate_id(text) from public;
revoke all on function threadlink_private.current_clerk_user_id() from public;
revoke all on function threadlink_private.touch_updated_at() from public;

grant execute on function threadlink_private.generate_id(text) to authenticated, service_role;
grant execute on function threadlink_private.current_clerk_user_id() to authenticated, service_role;
