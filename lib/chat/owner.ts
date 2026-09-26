import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";
import { listChatJobsFor, type OwnerJobSummary } from "@/lib/team/queries";

import {
  createChatAs,
  createChatGroupAs,
  deleteChatAs,
  deleteChatGroupAs,
  getChatFor,
  listChatGroupsFor,
  listChatsFor,
  markChatReadAs,
  renameChatGroupAs,
  retryJobWithRolesAs,
  setChatArchivedAs,
  setChatPinnedAs,
  updateChatAs,
  type ChatRecord,
  type ListChatsOptions,
} from "./chats";
import type { ChatQuery } from "./model";
import { listChatFor, postChatMessageAs, type PostChatMessageOutcome } from "./queries";
import type { ChatDetail, ChatGroup, ChatPage, ChatSummary } from "./types";

/**
 * Signed-in (dashboard) entry points for chats and the chat timeline.
 * Identity comes only from the verified Clerk session; the user-scoped client
 * keeps RLS enforcing and the database re-checks ownership (auth.uid()).
 *
 * Reads return data or null ("not found" and "not yours" read alike).
 * Changes throw ChatActionError (reason code + a human-safe sentence) on a
 * refusal; they never pass database text through.
 */

export { ChatNotFoundError, ChatRoomNotFoundError, type PostChatMessageOutcome } from "./queries";
export { ChatActionError, type ChatRecord, type ListChatsOptions } from "./chats";

// --- The timeline -----------------------------------------------------------

/** One page of a chat's (chatId) or a project's (roomId, 0.8) timeline. */
export async function listMyChat(query: ChatQuery): Promise<ChatPage> {
  const user = await requireThreadLinkUser();
  return listChatFor(createUserSupabaseClient(), user, query);
}

/** {chatId, body, idempotencyKey?} (0.9) or {roomId, body, mode?, builder?, idempotencyKey?} (0.8). */
export async function postMyChatMessage(input: unknown): Promise<PostChatMessageOutcome> {
  await requireThreadLinkUser();
  return postChatMessageAs(createUserSupabaseClient(), input);
}

// --- Chats ------------------------------------------------------------------

export async function listMyChats(
  options: ListChatsOptions = {},
): Promise<(ChatSummary & { isRoomDefault: boolean })[]> {
  const user = await requireThreadLinkUser();
  return listChatsFor(createUserSupabaseClient(), user, options);
}

export async function listMyChatGroups(): Promise<ChatGroup[]> {
  const user = await requireThreadLinkUser();
  return listChatGroupsFor(createUserSupabaseClient(), user);
}

export async function getMyChat(chatId: unknown): Promise<ChatDetail | null> {
  const user = await requireThreadLinkUser();
  return getChatFor(createUserSupabaseClient(), user, chatId);
}

/** The chat's jobs, newest first. */
export async function listMyChatJobs(chatId: unknown): Promise<OwnerJobSummary[]> {
  const user = await requireThreadLinkUser();
  return listChatJobsFor(createUserSupabaseClient(), user, chatId);
}

export async function createMyChat(input: unknown): Promise<ChatRecord> {
  await requireThreadLinkUser();
  return createChatAs(createUserSupabaseClient(), input);
}

/** `undefined` leaves a field; `null` clears it (no project / no group / Auto provider). */
export async function updateMyChat(chatId: unknown, patch: unknown): Promise<ChatRecord> {
  await requireThreadLinkUser();
  return updateChatAs(createUserSupabaseClient(), chatId, patch);
}

export async function setMyChatPinned(chatId: unknown, pinned: unknown): Promise<ChatRecord> {
  await requireThreadLinkUser();
  return setChatPinnedAs(createUserSupabaseClient(), chatId, pinned);
}

export async function setMyChatArchived(chatId: unknown, archived: unknown): Promise<ChatRecord> {
  await requireThreadLinkUser();
  return setChatArchivedAs(createUserSupabaseClient(), chatId, archived);
}

export async function deleteMyChat(chatId: unknown): Promise<void> {
  await requireThreadLinkUser();
  return deleteChatAs(createUserSupabaseClient(), chatId);
}

export async function markMyChatRead(
  chatId: unknown,
  seq: unknown,
): Promise<{ lastReadSeq: number }> {
  await requireThreadLinkUser();
  return markChatReadAs(createUserSupabaseClient(), chatId, seq);
}

// --- Groups -----------------------------------------------------------------

export async function createMyChatGroup(name: unknown): Promise<ChatGroup> {
  await requireThreadLinkUser();
  return createChatGroupAs(createUserSupabaseClient(), name);
}

export async function renameMyChatGroup(groupId: unknown, name: unknown): Promise<ChatGroup> {
  await requireThreadLinkUser();
  return renameChatGroupAs(createUserSupabaseClient(), groupId, name);
}

export async function deleteMyChatGroup(groupId: unknown): Promise<void> {
  await requireThreadLinkUser();
  return deleteChatGroupAs(createUserSupabaseClient(), groupId);
}

// --- Retry ------------------------------------------------------------------

export async function retryMyJobWithRoles(
  jobId: unknown,
  coordinator: unknown,
): Promise<{ jobId: string; chatId: string; replayed: boolean }> {
  await requireThreadLinkUser();
  return retryJobWithRolesAs(createUserSupabaseClient(), jobId, coordinator);
}
