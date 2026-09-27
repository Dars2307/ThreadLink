import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { listMyChoices } from "@/lib/chat/owner";
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
 * 0.10: the chat's choices (docs/design/threadlink-0.10.md section 4).
 * GET -> {choices: ChoiceView[]}. Owner only; another account's chat = 404.
 * Agent text (titles) is data, attributed to its agent; never HTML.
 */

type Ctx = { params: Promise<{ chatId: string }> };

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  try {
    return json({ choices: await listMyChoices(chatId.data) });
  } catch (error) {
    return chatErrorResponse(error, "chat choices read");
  }
}
