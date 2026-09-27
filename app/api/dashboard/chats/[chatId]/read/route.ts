import { z } from "zod";

import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { markMyChatRead, markMyChatReadSeq } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, NO_STORE, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * POST {chatSeq} -> {ok:true, lastReadChatSeq, lastReadSeq}   (0.10: the per-chat cursor)
 * POST {seq}     -> {ok:true, lastReadSeq}                    (0.9, DEPRECATED: the global
 *                   seq; still works during the rollout and moves both cursors)
 * Marks the owner's chat read up to the cursor (never past its newest row, never backwards).
 */

type Ctx = { params: Promise<{ chatId: string }> };

async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bodySchema = z.union([
  z.object({ chatSeq: cursor }).strict(),
  z.object({ seq: cursor }).strict(),
]);

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  const read = await readSmallJson(request, 256);
  if (!read.ok) return read.response;
  const body = bodySchema.safeParse(read.body);
  if (!body.success) return chatFailure("invalid");
  try {
    if ("chatSeq" in body.data) {
      const result = await markMyChatReadSeq(chatId.data, body.data.chatSeq);
      return Response.json(
        { ok: true, lastReadChatSeq: result.lastReadChatSeq, lastReadSeq: result.lastReadSeq },
        { headers: NO_STORE },
      );
    }
    const result = await markMyChatRead(chatId.data, body.data.seq);
    return Response.json({ ok: true, lastReadSeq: result.lastReadSeq }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat read mark");
  }
}
