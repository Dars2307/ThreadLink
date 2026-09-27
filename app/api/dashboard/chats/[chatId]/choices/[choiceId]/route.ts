import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { decideMyChoice } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

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
 * 0.10: the owner answers a question (section 4).
 * POST {key} -> {ok:true, choice: ChoiceView}
 * Refusals: 404 choice_not_found (another chat or account), 409 choice_closed /
 * choice_expired, 400 invalid_choice (not one of its options).
 */

type Ctx = { params: Promise<{ chatId: string; choiceId: string }> };

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const { chatId, choiceId } = await ctx.params;
  const chat = chatIdSchema.safeParse(chatId);
  if (!chat.success) return chatFailure("chat_not_found");
  const read = await readSmallJson(request, 256);
  if (!read.ok) return read.response;
  try {
    return json({ ok: true, choice: await decideMyChoice(chat.data, choiceId, read.body) });
  } catch (error) {
    return chatErrorResponse(error, "choice decision");
  }
}
