-- ThreadLink Phase 2: canonical ThreadLink users.
--
-- One row per Clerk user. `id` is ThreadLink's own immutable identity;
-- `clerk_user_id` is the immutable external identity. `display_name` and
-- `primary_email` are profile metadata only and are NEVER used for authorization.

create table public.users (
  id text primary key
    default threadlink_private.generate_id('tlusr')
    constraint users_id_format check (id ~ '^tlusr_[0-9a-f]{32}$'),
  clerk_user_id text not null
    constraint users_clerk_user_id_key unique
    constraint users_clerk_user_id_format check (clerk_user_id ~ '^user_[A-Za-z0-9]+$'),
  display_name text
    constraint users_display_name_length check (char_length(display_name) between 1 and 200),
  primary_email text
    constraint users_primary_email_length check (char_length(primary_email) between 3 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is
  'Canonical ThreadLink user. Ownership root for all tenant data. Email/name are display metadata only.';
comment on column public.users.clerk_user_id is
  'Immutable Clerk user ID (JWT sub). The only link between Clerk identity and ThreadLink identity.';

-- Identity columns are immutable, even for privileged roles.
create function threadlink_private.users_guard_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.clerk_user_id is distinct from old.clerk_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'ThreadLink user identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function threadlink_private.users_guard_immutable() from public;

create trigger users_guard_immutable
  before update on public.users
  for each row execute function threadlink_private.users_guard_immutable();

create trigger users_touch_updated_at
  before update on public.users
  for each row execute function threadlink_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Current ThreadLink user
--
-- Maps verified JWT sub -> users.clerk_user_id -> users.id. SECURITY DEFINER so
-- that RLS policies on other tables can resolve ownership without depending on
-- the users-table policy; it can only ever return the caller's own ID.
-- ---------------------------------------------------------------------------
create function threadlink_private.current_user_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users as u
  where u.clerk_user_id = threadlink_private.current_clerk_user_id()
$$;

comment on function threadlink_private.current_user_id() is
  'ThreadLink user ID for the verified caller, or NULL if unauthenticated/unprovisioned.';

revoke all on function threadlink_private.current_user_id() from public;
grant execute on function threadlink_private.current_user_id() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

-- Supabase grants broad default privileges on new public tables. Remove them
-- and grant back only what is required.
revoke all on table public.users from public, anon, authenticated;
grant select on table public.users to authenticated;
-- No INSERT/UPDATE/DELETE for `authenticated`: rows are created only through
-- public.provision_current_user(), which derives identity from the JWT.

create policy users_select_own
  on public.users
  for select
  to authenticated
  using (clerk_user_id = (select threadlink_private.current_clerk_user_id()));

-- ---------------------------------------------------------------------------
-- Lazy, idempotent, race-safe provisioning
--
-- The Clerk user ID is taken ONLY from the verified JWT; there is no parameter
-- for it. Concurrent first requests converge on one row via the unique
-- constraint (ON CONFLICT). Profile metadata is refreshed when it changes.
-- ---------------------------------------------------------------------------
create function public.provision_current_user(
  p_display_name text default null,
  p_primary_email text default null
)
returns public.users
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clerk_user_id text := threadlink_private.current_clerk_user_id();
  v_display_name text := left(nullif(btrim(p_display_name), ''), 200);
  v_primary_email text := left(nullif(lower(btrim(p_primary_email)), ''), 320);
  v_user public.users;
begin
  if v_clerk_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if v_primary_email is not null and char_length(v_primary_email) < 3 then
    v_primary_email := null;
  end if;

  insert into public.users as u (clerk_user_id, display_name, primary_email)
  values (v_clerk_user_id, v_display_name, v_primary_email)
  on conflict (clerk_user_id) do update
    set display_name = excluded.display_name,
        primary_email = excluded.primary_email
    where (u.display_name, u.primary_email)
          is distinct from (excluded.display_name, excluded.primary_email)
  returning u.* into v_user;

  if v_user.id is null then
    -- Row existed and profile was unchanged.
    select u.* into v_user from public.users as u where u.clerk_user_id = v_clerk_user_id;
  end if;

  return v_user;
end;
$$;

comment on function public.provision_current_user(text, text) is
  'Returns the caller''s ThreadLink user, creating it on first use. Identity comes only from the verified JWT.';

revoke all on function public.provision_current_user(text, text) from public, anon;
grant execute on function public.provision_current_user(text, text) to authenticated;
