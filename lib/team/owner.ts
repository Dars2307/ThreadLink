import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import {
  getJobDetailFor,
  listRoomJobsFor,
  removeConversationAs,
  type OwnerJobDetail,
  type OwnerJobSummary,
  type RemovedConversation,
} from "./queries";

/** Signed-in (dashboard) entry points for team jobs and conversations. */

export { ConversationNotFoundError } from "./queries";

export async function listMyRoomJobs(roomId: unknown): Promise<OwnerJobSummary[]> {
  const user = await requireThreadLinkUser();
  return listRoomJobsFor(createUserSupabaseClient(), user, roomId);
}

export async function getMyJobDetail(jobId: unknown): Promise<OwnerJobDetail | null> {
  const user = await requireThreadLinkUser();
  return getJobDetailFor(createUserSupabaseClient(), user, jobId);
}

/** "Remove from ThreadLink": never deletes the provider's native history. */
export async function removeMyConversation(sessionId: unknown): Promise<RemovedConversation> {
  await requireThreadLinkUser();
  return removeConversationAs(createUserSupabaseClient(), sessionId);
}
