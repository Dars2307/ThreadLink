import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { addMyAttachment, listMyArtifacts } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";
import { ATTACHMENT_POST_MAX_BYTES } from "@/lib/chat/work";

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
 * 0.10: the chat's artifacts (section 4).
 * GET  -> {artifacts: ArtifactView[]} (no content; download with GET .../artifacts/<id>)
 * POST {title, content, mime?: "text/plain"|"text/markdown"} -> {ok:true, artifact}
 *      An owner text attachment: at most 64 KiB, redacted before it is stored,
 *      never forwarded to a provider by the server.
 */

type Ctx = { params: Promise<{ chatId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  try {
    return json({ artifacts: await listMyArtifacts(chatId.data) });
  } catch (error) {
    return chatErrorResponse(error, "artifacts read");
  }
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  const read = await readSmallJson(request, ATTACHMENT_POST_MAX_BYTES);
  if (!read.ok) return read.response;
  try {
    return json({ ok: true, artifact: await addMyAttachment(chatId.data, read.body) });
  } catch (error) {
    return chatErrorResponse(error, "attachment upload");
  }
}
