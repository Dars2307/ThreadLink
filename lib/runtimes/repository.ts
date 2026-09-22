import "server-only";

import { z } from "zod";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { ThreadLinkNotFoundError } from "@/lib/sessions/queries";
import { createUserSupabaseClient } from "@/lib/supabase/server";

/**
 * Owner (dashboard) control of Runtimes and links. Every call is Clerk-authenticated
 * and RLS-scoped; the database re-checks ownership and returns "not found" for
 * anything that is not the caller's.
 */

const runtimeIdSchema = z.string().regex(/^tlrun_[0-9a-f]{32}$/);
const linkIdSchema = z.string().regex(/^tllnk_[0-9a-f]{32}$/);

const settingsSchema = z
  .object({
    autoStart: z.boolean().optional(),
    autoReconnect: z.boolean().optional(),
    notifications: z.boolean().optional(),
  })
  .strict();

export async function updateMyRuntime(
  rawRuntimeId: unknown,
  input: {
    label?: unknown;
    settings?: unknown;
    paused?: unknown;
    requestRestart?: boolean;
  },
): Promise<void> {
  await requireThreadLinkUser();
  const runtimeId = runtimeIdSchema.parse(rawRuntimeId);
  const label =
    input.label === undefined || input.label === null
      ? null
      : z.string().trim().min(1).max(100).parse(input.label);
  const settings = input.settings === undefined ? null : settingsSchema.parse(input.settings);
  const paused =
    input.paused === undefined || input.paused === null ? null : z.boolean().parse(input.paused);
  const { error } = await createUserSupabaseClient().rpc("update_runtime", {
    p_runtime_id: runtimeId,
    p_label: label,
    p_settings: settings,
    p_paused: paused,
    p_request_restart: input.requestRestart === true,
  });
  if (error) {
    if (error.code === "P0002") throw new ThreadLinkNotFoundError();
    throw new Error("Failed to update the Runtime");
  }
}

export async function revokeMyRuntime(rawRuntimeId: unknown): Promise<void> {
  await requireThreadLinkUser();
  const runtimeId = runtimeIdSchema.parse(rawRuntimeId);
  const { error } = await createUserSupabaseClient().rpc("revoke_runtime", {
    p_runtime_id: runtimeId,
  });
  if (error) {
    if (error.code === "P0002") throw new ThreadLinkNotFoundError();
    throw new Error("Failed to disconnect the Runtime");
  }
}

export async function setMyLinkPaused(rawLinkId: unknown, paused: boolean): Promise<void> {
  await requireThreadLinkUser();
  const linkId = linkIdSchema.parse(rawLinkId);
  const { error } = await createUserSupabaseClient().rpc("set_link_paused", {
    p_link_id: linkId,
    p_paused: paused,
  });
  if (error) {
    if (error.code === "P0002") throw new ThreadLinkNotFoundError();
    throw new Error("Failed to update the link");
  }
}
