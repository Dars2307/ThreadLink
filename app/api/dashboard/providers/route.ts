import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ChatErrorReason } from "@/lib/chat/model";
import { listMyAgentProviders } from "@/lib/chat/owner";
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
 * 0.10: the provider registry (section 1): ids, display names, short names,
 * @mention aliases and whether ThreadLink supports them. The UI renders
 * providers from this, never from a per-provider switch.
 * GET -> {providers: ProviderInfo[]}
 */

export async function GET(): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  try {
    return json({ providers: await listMyAgentProviders() });
  } catch (error) {
    return chatErrorResponse(error, "provider registry read");
  }
}
