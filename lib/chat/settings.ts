import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import { ChatActionError } from "./chats";
import { chatErrorReason } from "./model";
import { FAILOVER_POLICIES, type FailoverPolicy, type OwnerSettings } from "./types";

/**
 * 0.11 owner settings (docs/design/threadlink-0.11.md section 5): what happens
 * when an agent's included usage runs out. Identity comes only from the
 * verified Clerk session; the database resolves the owner from the JWT
 * (get_my_settings / set_failover_policy) and RLS keeps user_settings private.
 */

const settingsRow = z.object({
  failover_policy: z.enum(FAILOVER_POLICIES),
  updated_at: z.string().nullable(),
});

export const setFailoverPolicySchema = z
  .object({ failoverPolicy: z.enum(FAILOVER_POLICIES) })
  .strict();

async function call(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<OwnerSettings> {
  let result: { data: unknown; error: { code?: string; hint?: string | null } | null };
  try {
    result = await db.rpc(fn, args);
  } catch {
    throw new ChatActionError("unavailable");
  }
  if (result.error) throw new ChatActionError(chatErrorReason(result.error));
  const r = settingsRow.safeParse(result.data);
  if (!r.success) throw new ChatActionError("unavailable");
  return { failoverPolicy: r.data.failover_policy, updatedAt: r.data.updated_at };
}

export async function getSettingsAs(db: SupabaseClient): Promise<OwnerSettings> {
  return call(db, "get_my_settings", {});
}

export async function setFailoverPolicyAs(
  db: SupabaseClient,
  rawBody: unknown,
): Promise<OwnerSettings> {
  const body = setFailoverPolicySchema.safeParse(rawBody);
  if (!body.success) throw new ChatActionError("invalid");
  const policy: FailoverPolicy = body.data.failoverPolicy;
  return call(db, "set_failover_policy", { p_policy: policy });
}

export async function getMySettings(): Promise<OwnerSettings> {
  await requireThreadLinkUser();
  return getSettingsAs(createUserSupabaseClient());
}

export async function setMyFailoverPolicy(rawBody: unknown): Promise<OwnerSettings> {
  await requireThreadLinkUser();
  return setFailoverPolicyAs(createUserSupabaseClient(), rawBody);
}
