import { handleRuntimeChatRequest, readChatJson } from "@/lib/client-api/chat-routes";
import { CHAT_API_ACTION_MAX_BYTES, decideRuntimeChoice } from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * 0.11: the owner answers a choice card from the desktop app or the terminal.
 * Same rules as the dashboard (POST /api/dashboard/chats/<id>/choices/<id>):
 * only a pending, unexpired choice of THIS chat, only one of its own options;
 * the same answer again is a replay; another account's choice is "not found".
 * Like posting, only from the computer the chat's project runs on.
 *
 * POST {key} -> {choiceId, kind, status, chosenKey, chosenLabel, decidedAt, replayed, startedJobId}
 * Errors: {ok:false, reason, message} (choice_not_found | choice_closed |
 * choice_expired | invalid_choice | other_computer | ...), a fixed sentence.
 */
export async function POST(
  request: Request,
  // (Explicit params type: generated route types may predate this route.)
  ctx: { params: Promise<{ chatId: string; choiceId: string }> },
): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const body = await readChatJson(request, CHAT_API_ACTION_MAX_BYTES);
    const { chatId, choiceId } = await ctx.params;
    return decideRuntimeChoice(db, credentialHash, chatId, choiceId, body);
  });
}
