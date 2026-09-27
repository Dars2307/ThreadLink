import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { revealMyRunNativeSession } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json } from "@/lib/chat/route-helpers";
import { sameOriginRequest } from "@/lib/chat/same-origin";

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
 * 0.10: the owner's explicit "copy native session" (section 2). Same-origin
 * POST only; audited (team.native_session_revealed) and rate-limited by the
 * database. Never cached.
 * POST -> {ok:true, available, nativeSessionId, kind, resumeCommand}
 *   resumeCommand: "claude --resume <id>" for a Claude Code session (to copy;
 *   never run by ThreadLink), otherwise null.
 */

type Ctx = { params: Promise<{ chatId: string; runId: string }> };

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginRequest(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const { chatId, runId } = await ctx.params;
  const chat = chatIdSchema.safeParse(chatId);
  if (!chat.success) return chatFailure("chat_not_found");
  try {
    return json({ ok: true, ...(await revealMyRunNativeSession(chat.data, runId)) });
  } catch (error) {
    return chatErrorResponse(error, "native session reveal");
  }
}
