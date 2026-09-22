import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { listRecentTasks, type RecentTask } from "@/lib/tasks/queries";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import {
  listSessions,
  listThreadLinks,
  revokeThreadLinkAsOwner,
  type OwnerSession,
} from "./queries";

/** The signed-in user's session bindings (dashboard). */
export async function listMySessions(): Promise<OwnerSession[]> {
  const user = await requireThreadLinkUser();
  return listSessions(createUserSupabaseClient(), user);
}

/** The signed-in user's thread links (dashboard). */
export async function listMyThreadLinks(): Promise<ThreadLinkView[]> {
  const user = await requireThreadLinkUser();
  return listThreadLinks(createUserSupabaseClient(), user);
}

/** Revokes one of the signed-in user's links. Idempotent. */
export async function revokeMyThreadLink(linkId: unknown): Promise<ThreadLinkView> {
  await requireThreadLinkUser();
  return revokeThreadLinkAsOwner(createUserSupabaseClient(), linkId);
}

/** The signed-in user's most recent tasks (metadata only). */
export async function listMyRecentTasks(): Promise<RecentTask[]> {
  const user = await requireThreadLinkUser();
  return listRecentTasks(createUserSupabaseClient(), user);
}
