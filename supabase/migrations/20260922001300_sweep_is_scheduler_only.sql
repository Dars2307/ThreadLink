-- ThreadLink Phase 6.7: the notification sweep belongs to the scheduler alone.
--
-- public.run_notification_sweep is security definer and works across every
-- user's notification deliveries, so only the scheduler may call it. Migration
-- 001200 revoked it from `public` and `anon`, but Supabase grants EXECUTE on
-- new functions in `public` to `authenticated` through default privileges, so
-- any signed-in user still inherited it -- and could drive other tenants'
-- delivery state. `anon` alone is not the whole client surface.
--
-- Revoked here rather than by editing 001200, which is already applied.

revoke all on function public.run_notification_sweep(integer)
  from public, anon, authenticated;
grant execute on function public.run_notification_sweep(integer) to service_role;
