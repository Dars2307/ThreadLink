import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ChatErrorReason } from "@/lib/chat/model";
import { chatErrorResponse, chatFailure, json, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";
import { getMySettings, setMyFailoverPolicy } from "@/lib/chat/settings";

export const dynamic = "force-dynamic";

/**
 * 0.11 (docs/design/threadlink-0.11.md section 5): the owner's choice for when
 * an agent's included usage runs out. Settings -> Agents.
 *
 * GET                                    -> {failoverPolicy: "auto"|"ask"|"wait", updatedAt}
 * PUT {failoverPolicy: "auto"|"ask"|"wait"} -> the same
 *
 *   auto  Continue with another included agent (default)
 *   ask   Ask me first
 *   wait  Wait for the same agent
 *
 * Signed-in owner only (Clerk); the database resolves the owner from the JWT.
 * Error bodies are {ok:false, reason, message} with a fixed sentence.
 */
/** Fail closed before reading anything from the request (the signed-in ThreadLink user). */
async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

export async function GET(): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  try {
    return json(await getMySettings());
  } catch (error) {
    return chatErrorResponse(error, "settings read");
  }
}

export async function PUT(request: Request): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const read = await readSmallJson(request);
  if (!read.ok) return read.response;
  try {
    return json(await setMyFailoverPolicy(read.body));
  } catch (error) {
    return chatErrorResponse(error, "settings update");
  }
}
