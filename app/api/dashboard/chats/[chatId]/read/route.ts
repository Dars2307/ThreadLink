import { z } from "zod";

import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { markMyChatRead } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, NO_STORE, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * POST {seq} -> {ok:true, lastReadSeq}
 * Marks the owner's chat read up to seq (never past its newest row, never backwards).
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

const bodySchema = z.object({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

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
    const result = await markMyChatRead(chatId.data, body.data.seq);
    return Response.json({ ok: true, lastReadSeq: result.lastReadSeq }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat read mark");
  }
}
