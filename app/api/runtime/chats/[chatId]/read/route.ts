import { handleRuntimeChatRequest, readChatJson } from "@/lib/client-api/chat-routes";
import { CHAT_API_READ_MAX_BYTES, markRuntimeChatRead } from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * POST {cursor} -> {ok:true, lastReadCursor}
 * Marks the chat read up to a per-chat cursor (never past its newest row,
 * never backwards).
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runtime/chats/[chatId]/read">,
): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const body = await readChatJson(request, CHAT_API_READ_MAX_BYTES);
    const result = await markRuntimeChatRead(db, credentialHash, (await ctx.params).chatId, body);
    return { ok: true, lastReadCursor: result.lastReadCursor };
  });
}
