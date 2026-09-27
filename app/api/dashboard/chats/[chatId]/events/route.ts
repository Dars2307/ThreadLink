import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { listMyChatTimeline } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json } from "@/lib/chat/route-helpers";
import { parseTimelineParams } from "@/lib/chat/work";

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
 * 0.10: one chat's timeline by its own cursor (docs/design/threadlink-0.10.md
 * section 7). Owner only (Clerk session, user-scoped client, RLS).
 *
 * GET ?after=<chat_seq>            -> rows after it, oldest first (poll)
 * GET ?before=<chat_seq>&limit=N   -> the page just older than it
 * GET (no cursor)                  -> the latest page (default 100, max 200)
 *     &technical=1                 -> include technical rows
 * -> ChatTimelinePage. Every event's `seq` IS its chat_seq; the global
 *    sequence is never returned here. Another account's chat = 404.
 */

type Ctx = { params: Promise<{ chatId: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  const query = parseTimelineParams(new URL(request.url).searchParams);
  if (!query) return chatFailure("invalid");
  try {
    return json(await listMyChatTimeline(chatId.data, query));
  } catch (error) {
    return chatErrorResponse(error, "chat timeline read");
  }
}
