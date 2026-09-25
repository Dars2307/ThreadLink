import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import {
  CHAT_ERROR_MESSAGES,
  CHAT_ERROR_STATUS,
  CHAT_POST_MAX_BYTES,
  parseChatSearchParams,
  type ChatErrorReason,
} from "@/lib/chat/model";
import { ChatRoomNotFoundError, listMyChat, postMyChatMessage } from "@/lib/chat/owner";
import { OwnershipViolationError } from "@/lib/connections/model";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * The project chat, for the signed-in OWNER (Clerk session; not a connection
 * route). proxy.ts keeps /api/dashboard/* behind Clerk, and each handler
 * resolves the ThreadLink user itself before touching the request, then
 * reads/writes with the user-scoped client so RLS stays an enforcing second
 * layer. Error bodies are fixed, human-safe sentences; never database text.
 *
 * GET  ?room=<tlrom_...>&after=<seq>&technical=0|1  -> ChatPage
 * POST {roomId, body, mode?, builder?, idempotencyKey?} -> PostChatMessageResult
 */

const NO_STORE = { "Cache-Control": "no-store" };

function failure(reason: ChatErrorReason): Response {
  return Response.json(
    { ok: false, message: CHAT_ERROR_MESSAGES[reason] },
    { status: CHAT_ERROR_STATUS[reason], headers: NO_STORE },
  );
}

function reasonFor(error: unknown): ChatErrorReason {
  if (error instanceof AuthenticationRequiredError) return "unauthenticated";
  // Another account's project looks exactly like one that does not exist.
  if (error instanceof ChatRoomNotFoundError || error instanceof OwnershipViolationError) {
    return "not_found";
  }
  return "unavailable";
}

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
  if (denied) return failure(denied);
  const query = parseChatSearchParams(new URL(request.url).searchParams);
  if (!query) return failure("invalid");
  try {
    return Response.json(await listMyChat(query), { headers: NO_STORE });
  } catch (error) {
    const reason = reasonFor(error);
    if (reason === "unavailable") console.error("[threadlink] chat read failed");
    return failure(reason);
  }
}

export async function POST(request: Request): Promise<Response> {
  // Same-origin JSON only. A cross-site form can post text/plain that happens to
  // parse as JSON; the browser always sends these headers, so refuse anything
  // that is not a same-origin JSON request before it can act as the owner.
  if (!sameOriginJson(request)) return failure("invalid");
  const denied = await signedIn();
  if (denied) return failure(denied);
  // Size first (declared, then actual), before any parsing.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CHAT_POST_MAX_BYTES) return failure("too_long");
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > CHAT_POST_MAX_BYTES) return failure("too_long");
    body = JSON.parse(text) as unknown;
  } catch {
    return failure("invalid");
  }
  try {
    const outcome = await postMyChatMessage(body);
    if (!outcome.ok) return failure(outcome.reason);
    return Response.json(
      { ok: true, routed: outcome.routed, jobId: outcome.jobId },
      { headers: NO_STORE },
    );
  } catch (error) {
    const reason = reasonFor(error);
    if (reason === "unavailable") console.error("[threadlink] chat post failed");
    return failure(reason);
  }
}
