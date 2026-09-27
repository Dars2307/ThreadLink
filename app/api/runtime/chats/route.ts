import { handleRuntimeChatRequest, readChatJson } from "@/lib/client-api/chat-routes";
import {
  CHAT_API_ACTION_MAX_BYTES,
  ChatApiError,
  createRuntimeChat,
  listRuntimeChats,
} from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * The owner's chats, for the desktop app and the terminal. Runtime (agent)
 * credential of an active, unpaused Runtime only; the owner comes from it.
 *
 * GET  ?archived=0|1&search=<text, <=100>
 *      -> {chats: ChatApiSummary[], projects: ChatApiProject[]}
 *      pinned first, then most recent activity; at most 200.
 * POST {name, roomId?: tlrom_|null, mode?: solo|pair|team}
 *      -> {ok:true, chat: ChatApiSummary}
 * Errors: {ok:false, reason, message} with a fixed sentence.
 */
export async function GET(request: Request): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const p = new URL(request.url).searchParams;
    const archived = p.get("archived");
    const search = p.get("search");
    if (archived !== null && !["0", "1", "true", "false"].includes(archived)) {
      throw new ChatApiError("invalid");
    }
    return listRuntimeChats(db, credentialHash, {
      includeArchived: archived === "1" || archived === "true",
      ...(search !== null ? { search } : {}),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  // The body is read INSIDE the handler, after authentication.
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) => {
    const body = await readChatJson(request, CHAT_API_ACTION_MAX_BYTES);
    return { ok: true, chat: await createRuntimeChat(db, credentialHash, body) };
  });
}
