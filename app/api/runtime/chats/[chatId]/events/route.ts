import { handleRuntimeChatRequest } from "@/lib/client-api/chat-routes";
import { ChatApiError, parseEventsQuery, runtimeChatEvents } from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * One page of a chat's timeline, oldest first, with a PER-CHAT cursor.
 *
 * GET ?after=<cursor>          rows after it (poll with the returned cursor)
 * GET ?before=<cursor>         the page just before it (scroll back with oldestCursor)
 * GET (neither)                the latest page
 *     &limit=1..200 (default 100)  &technical=0|1 (default 0: visible rows only)
 * -> {chatId, events: ChatApiEvent[], cursor, oldestCursor, hasMore, activeJob}
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/runtime/chats/[chatId]/events">,
): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const query = parseEventsQuery(new URL(request.url).searchParams);
    if (!query) throw new ChatApiError("invalid");
    return runtimeChatEvents(db, credentialHash, (await ctx.params).chatId, query);
  });
}
