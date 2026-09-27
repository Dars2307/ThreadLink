import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ChatErrorReason } from "@/lib/chat/model";
import { searchMyChats } from "@/lib/chat/owner";
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
 * 0.10: search the owner's chats (section 7): chat names, project names,
 * visible messages, finding / decision / artifact titles. A plain substring,
 * 2-100 characters, newest first.
 * GET ?q=<text>&limit=<1-50> -> {results: ChatSearchResult[]}
 */

export async function GET(request: Request): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const params = new URL(request.url).searchParams;
  const limit = params.get("limit");
  if (limit !== null && !/^\d{1,2}$/.test(limit)) return chatFailure("invalid");
  try {
    return json({
      results: await searchMyChats({
        q: params.get("q") ?? "",
        ...(limit !== null ? { limit: Number(limit) } : {}),
      }),
    });
  } catch (error) {
    return chatErrorResponse(error, "chat search");
  }
}
