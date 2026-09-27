import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { deleteMyArtifact, readMyArtifact } from "@/lib/chat/owner";
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
 * 0.10: one artifact.
 * GET    -> the text as a download (text/plain, text/markdown or
 *           application/json; a diff is served as text/plain; charset utf-8;
 *           attachment; nosniff; sandboxed; no-store). The text was redacted
 *           before it was stored; it is never rendered as a page.
 * DELETE -> {ok:true} (hidden from ThreadLink; the audit trail stays)
 */

type Ctx = { params: Promise<{ chatId: string; artifactId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const { chatId, artifactId } = await ctx.params;
  const chat = chatIdSchema.safeParse(chatId);
  if (!chat.success) return chatFailure("chat_not_found");
  try {
    const file = await readMyArtifact(chat.data, artifactId);
    if (!file) return chatFailure("artifact_not_found");
    const type = file.mime === "text/x-diff" ? "text/plain" : file.mime;
    return new Response(file.content, {
      status: 200,
      headers: {
        "Content-Type": `${type}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return chatErrorResponse(error, "artifact download");
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginRequest(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const { chatId, artifactId } = await ctx.params;
  const chat = chatIdSchema.safeParse(chatId);
  if (!chat.success) return chatFailure("chat_not_found");
  try {
    await deleteMyArtifact(chat.data, artifactId);
    return json({ ok: true });
  } catch (error) {
    return chatErrorResponse(error, "artifact delete");
  }
}
