import "server-only";

import { auth } from "@clerk/nextjs/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env/server";

/**
 * Supabase client that acts AS the signed-in user.
 *
 * Uses the publishable key plus the caller's Clerk session token (Supabase
 * third-party auth), so Postgres RLS evaluates `auth.jwt()->>'sub'` as the
 * Clerk user ID. Supabase Auth is not used; with `accessToken` set,
 * `supabase.auth.*` is disabled by the library.
 *
 * This is the default client for tenant-owned data. Prefer it over the
 * privileged client so RLS remains an enforcing second layer.
 */
export function createUserSupabaseClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    accessToken: async () => {
      const { getToken } = await auth();
      // null => request runs as the anon role, which RLS must deny for tenant data.
      return (await getToken()) ?? null;
    },
  });
}
