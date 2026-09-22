import "server-only";

import { z } from "zod";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import { normalizeUserCode } from "./server";

/**
 * Human side of the bridge device sign-in. Runs with the signed-in user's
 * Clerk-backed, RLS-scoped client: the database takes the owner from the JWT,
 * never from the request.
 */

export type PendingDevice = { code: string; displayName: string; expiresAt: string };

export async function lookupPendingDevice(rawCode: unknown): Promise<PendingDevice | null> {
  const code = normalizeUserCode(rawCode);
  if (!code) return null;
  await requireThreadLinkUser();
  const { data, error } = await createUserSupabaseClient().rpc("get_device_authorization", {
    p_user_code: code,
  });
  if (error) return null;
  const parsed = z.object({ display_name: z.string(), expires_at: z.string() }).safeParse(data);
  return parsed.success
    ? { code, displayName: parsed.data.display_name, expiresAt: parsed.data.expires_at }
    : null;
}

export async function decideDevice(rawCode: unknown, approve: boolean): Promise<boolean> {
  const code = normalizeUserCode(rawCode);
  if (!code) return false;
  await requireThreadLinkUser();
  const { error } = await createUserSupabaseClient().rpc("decide_device_authorization", {
    p_user_code: code,
    p_approve: approve,
  });
  return !error;
}
