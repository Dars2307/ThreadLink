import { handleRuntimeChatRequest, readChatJson } from "@/lib/client-api/chat-routes";
import {
  CHAT_API_ACTION_MAX_BYTES,
  getRuntimeSettings,
  setRuntimeFailoverPolicy,
} from "@/lib/client-api/chats";

export const dynamic = "force-dynamic";

/**
 * 0.11 (docs/design/threadlink-0.11.md section 5): the owner's failover
 * preference from the desktop app. Runtime (agent) credential of an active,
 * unpaused Runtime; the owner comes from it.
 *
 * GET                                        -> {failoverPolicy, updatedAt}
 * PUT {failoverPolicy: "auto"|"ask"|"wait"}  -> {failoverPolicy, updatedAt}
 * Errors: {ok:false, reason, message} with a fixed sentence.
 */
export async function GET(request: Request): Promise<Response> {
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) =>
    getRuntimeSettings(db, credentialHash),
  );
}

export async function PUT(request: Request): Promise<Response> {
  // The body is read INSIDE the handler, after authentication.
  return handleRuntimeChatRequest(request, async ({ db, credentialHash }) =>
    setRuntimeFailoverPolicy(
      db,
      credentialHash,
      await readChatJson(request, CHAT_API_ACTION_MAX_BYTES),
    ),
  );
}
