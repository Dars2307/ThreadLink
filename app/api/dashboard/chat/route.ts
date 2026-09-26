import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { CHAT_POST_MAX_BYTES, parseChatSearchParams, type ChatErrorReason } from "@/lib/chat/model";
import { listMyChat, postMyChatMessage } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, NO_STORE, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * The chat timeline, for the signed-in OWNER (Clerk session; not a connection
 * route). proxy.ts keeps /api/dashboard/* behind Clerk, and each handler
 * resolves the ThreadLink user itself before touching the request, then
 * reads/writes with the user-scoped client so RLS stays an enforcing second
 * layer. Error bodies are {ok:false, reason, message} with a fixed, human-safe
 * sentence; never database text.
 *
 * GET  ?chat=<tlcht_...>&after=<seq>&technical=0|1  -> ChatPage   (0.9, one chat)
 * GET  ?room=<tlrom_...>&after=<seq>&technical=0|1  -> ChatPage   (0.8, a project's timeline)
 * POST {chatId, body, idempotencyKey?}                   -> PostChatMessageResult (0.9)
 * POST {roomId, body, mode?, builder?, idempotencyKey?}  -> PostChatMessageResult (0.8)
 *
 * A post refused by the health gate answers 409 {ok:false, reason:"provider_unhealthy",
 * message, health:[{provider, health}], stored:true}: the message and a ThreadLink row
 * naming who is not ready ARE in the chat; no work started.
 */

/** Fail closed before reading anything from the request. */
async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const query = parseChatSearchParams(new URL(request.url).searchParams);
  if (!query) return chatFailure("invalid");
  try {
    return Response.json(await listMyChat(query), { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat read");
  }
}

export async function POST(request: Request): Promise<Response> {
  // Same-origin JSON only. A cross-site form can post text/plain that happens to
  // parse as JSON; the browser always sends these headers, so refuse anything
  // that is not a same-origin JSON request before it can act as the owner.
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const read = await readSmallJson(request, CHAT_POST_MAX_BYTES);
  if (!read.ok) return read.response;
  try {
    const outcome = await postMyChatMessage(read.body);
    if (!outcome.ok) {
      return chatFailure(outcome.reason, {
        message: outcome.message,
        health: outcome.health,
        stored: outcome.stored,
      });
    }
    return Response.json(
      { ok: true, routed: outcome.routed, jobId: outcome.jobId },
      { headers: NO_STORE },
    );
  } catch (error) {
    return chatErrorResponse(error, "chat post");
  }
}
