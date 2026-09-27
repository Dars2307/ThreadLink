import {
  chatApiFailure,
  chatClientFrom,
  handleRuntimeChatRequest,
  readChatJson,
} from "@/lib/client-api/chat-routes";
import { CHAT_API_POST_MAX_BYTES, postRuntimeChatMessage } from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * The owner's composer from the desktop app or the terminal.
 *
 * POST {body (<=4000 chars), idempotencyKey?, client?: desktop|terminal}
 *      header X-ThreadLink-Client: desktop|terminal (header or field; required; must agree)
 * -> {ok:true, routed: note_to_active_job|stop_requested|new_job, jobId, eventId, replayed}
 * Health gate: 409 {ok:false, reason:"provider_unhealthy", message, health, stored:true, eventId}
 * (the message and a ThreadLink row naming who is not ready ARE in the chat; no work started).
 * The same idempotencyKey returns the first answer (replayed:true) and stores nothing new.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runtime/chats/[chatId]/messages">,
): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const body = await readChatJson(request, CHAT_API_POST_MAX_BYTES);
    const client = chatClientFrom(request, body);
    const { client: _client, ...rest } = body as Record<string, unknown>;
    void _client;
    const result = await postRuntimeChatMessage(
      db,
      credentialHash,
      (await ctx.params).chatId,
      rest,
      client,
    );
    if (!result.ok) {
      return chatApiFailure(result.reason, {
        message: result.message,
        health: result.health,
        stored: result.stored,
        eventId: result.eventId,
      });
    }
    return result;
  });
}
