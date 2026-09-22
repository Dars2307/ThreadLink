-- ThreadLink Phase 2: connections.
--
-- A connection is an authenticated installation/client (e.g. a ChatGPT or
-- Claude Code integration) owned by exactly one ThreadLink user. No sharing.

create table public.connections (
  id text primary key
    default threadlink_private.generate_id('tlcon')
    constraint connections_id_format check (id ~ '^tlcon_[0-9a-f]{32}$'),
  -- Owner is ALWAYS derived from the verified caller. `authenticated` has no
  -- privilege to supply this column, and RLS re-checks it.
  owner_user_id text not null
    default threadlink_private.current_user_id()
    references public.users (id) on delete cascade,
  platform text not null
    constraint connections_platform_check check (platform in ('chatgpt', 'claude-code')),
  role text not null
    constraint connections_role_check check (role in ('controller', 'agent')),
  status text not null default 'active'
    constraint connections_status_check check (status in ('active', 'idle', 'revoked', 'retired')),
  display_name text
    constraint connections_display_name_length check (char_length(display_name) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint connections_revoked_consistency
    check ((status = 'revoked') = (revoked_at is not null))
);

comment on table public.connections is
  'Client/installation owned by one ThreadLink user. Display names are cosmetic; the id is canonical.';

create index connections_owner_user_id_idx on public.connections (owner_user_id);

-- Identity/ownership columns are immutable; revoked/retired are terminal.
create function threadlink_private.connections_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.owner_user_id is distinct from old.owner_user_id
     or new.platform is distinct from old.platform
     or new.role is distinct from old.role
     or new.created_at is distinct from old.created_at then
    raise exception 'connection identity columns are immutable' using errcode = '42501';
  end if;

  if old.status in ('revoked', 'retired') and new.status is distinct from old.status then
    raise exception 'connection status % is terminal', old.status using errcode = '42501';
  end if;

  if new.status = 'revoked' and old.status <> 'revoked' then
    new.revoked_at := pg_catalog.now();
  end if;

  return new;
end;
$$;
revoke all on function threadlink_private.connections_guard_update() from public;

create trigger connections_guard_update
  before update on public.connections
  for each row execute function threadlink_private.connections_guard_update();

create trigger connections_touch_updated_at
  before update on public.connections
  for each row execute function threadlink_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security + least-privilege grants
-- ---------------------------------------------------------------------------
alter table public.connections enable row level security;

revoke all on table public.connections from public, anon, authenticated;

grant select on table public.connections to authenticated;
-- Column-scoped: callers can choose platform/role/label only. id, owner,
-- status and timestamps come from defaults/triggers.
grant insert (platform, role, display_name) on table public.connections to authenticated;
grant update (display_name, status) on table public.connections to authenticated;
grant delete on table public.connections to authenticated;

create policy connections_select_own
  on public.connections
  for select
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));

create policy connections_insert_own
  on public.connections
  for insert
  to authenticated
  with check (owner_user_id = (select threadlink_private.current_user_id()));

create policy connections_update_own
  on public.connections
  for update
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()))
  with check (owner_user_id = (select threadlink_private.current_user_id()));

create policy connections_delete_own
  on public.connections
  for delete
  to authenticated
  using (owner_user_id = (select threadlink_private.current_user_id()));
