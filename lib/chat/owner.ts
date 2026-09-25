import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import type { ChatQuery } from "./model";
import { listChatFor, postChatMessageAs, type PostChatMessageOutcome } from "./queries";
import type { ChatPage } from "./types";

/**
 * Signed-in (dashboard) entry points for the project chat. Identity comes only
 * from the verified Clerk session; the user-scoped client keeps RLS enforcing.
 */

export { ChatRoomNotFoundError, type PostChatMessageOutcome } from "./queries";

export async function listMyChat(query: ChatQuery): Promise<ChatPage> {
  const user = await requireThreadLinkUser();
  return listChatFor(createUserSupabaseClient(), user, query);
}

export async function postMyChatMessage(input: unknown): Promise<PostChatMessageOutcome> {
  await requireThreadLinkUser();
  return postChatMessageAs(createUserSupabaseClient(), input);
}
