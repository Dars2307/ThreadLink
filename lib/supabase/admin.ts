import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env/server";

/**
 * PRIVILEGED Supabase client using SUPABASE_SECRET_KEY. It BYPASSES RLS.
 *
 * Rules:
 * - Server-only. The `server-only` import makes any client-bundle import fail the build.
 * - Use only for trusted system operations that cannot run under a user token.
 * - Every query must be scoped by an owner ID obtained from `requireIdentity()`,
 *   never by an ID supplied by the client.
 * - Never return raw rows from this client to the browser without filtering.
 */
export function createPrivilegedSupabaseClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
