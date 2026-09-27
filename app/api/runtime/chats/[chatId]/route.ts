import { handleRuntimeChatRequest } from "@/lib/client-api/chat-routes";
import { getRuntimeChat } from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * GET -> ChatApiSummary (one chat of the credential's owner).
 * Another account's chat answers exactly like a missing one (404 chat_not_found).
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/runtime/chats/[chatId]">,
): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) =>
    getRuntimeChat(db, credentialHash, (await ctx.params).chatId),
  );
}
