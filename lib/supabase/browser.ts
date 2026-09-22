"use client";

import { useSession } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useMemo } from "react";

import { getPublicEnv } from "@/lib/env/client";

/**
 * Browser Supabase client authenticated with the current Clerk session token.
 *
 * Only the publishable key is available here. All access is subject to RLS;
 * the privileged secret key must never reach the browser.
 */
export function useSupabaseBrowserClient(): SupabaseClient {
  const { session } = useSession();

  return useMemo(() => {
    const env = getPublicEnv();
    return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      accessToken: async () => (await session?.getToken()) ?? null,
    });
  }, [session]);
}
