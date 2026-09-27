import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { getMyRunProvenance } from "@/lib/chat/owner";
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
 * 0.10: one agent run's provenance (section 2), for Details / Provenance.
 * GET -> RunProvenance. The native session id is never included: only
 * `nativeSession.available`; the owner reveals it with POST .../reveal.
 * A run of another chat or account = 404 run_not_found.
 */

type Ctx = { params: Promise<{ chatId: string; runId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const { chatId, runId } = await ctx.params;
  const chat = chatIdSchema.safeParse(chatId);
  if (!chat.success) return chatFailure("chat_not_found");
  try {
    const run = await getMyRunProvenance(chat.data, runId);
    if (!run) return chatFailure("run_not_found");
    return json(run);
  } catch (error) {
    return chatErrorResponse(error, "run provenance read");
  }
}
