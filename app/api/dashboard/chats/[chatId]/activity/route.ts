import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { getMyHostStatus, listMyLiveActivity } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json } from "@/lib/chat/route-helpers";

export const dynamic = "force-dynamic";

/** Fail closed before reading anything from the request (the signed-in ThreadLink user). */
async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

/**
 * 0.10: what is happening in a chat right now (sections 3 and 8).
 * GET -> {live: LiveActivity[], host: ChatHostStatus}
 *   live: runs working now that have not produced their message yet
 *   host: "Runs on <label>", presence (online/offline/working), and each
 *         agent's health with the time of the check ("Ready · checked 23 s ago").
 */

type Ctx = { params: Promise<{ chatId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  try {
    const [live, host] = await Promise.all([
      listMyLiveActivity(chatId.data),
      getMyHostStatus(chatId.data),
    ]);
    return json({ live, host });
  } catch (error) {
    return chatErrorResponse(error, "chat activity read");
  }
}
