import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { readCappedText } from "@/lib/http/body";
import { OwnershipViolationError } from "@/lib/connections/model";

import { ChatActionError } from "./chats";
import { CHAT_ERROR_MESSAGES, CHAT_ERROR_STATUS, type ChatErrorReason } from "./model";
import { ChatNotFoundError, ChatRoomNotFoundError } from "./queries";
import type { ProviderHealthEntry } from "./types";

/**
 * Shared by the owner chat routes (/api/dashboard/chat, /api/dashboard/chats/**).
 * Every error body is a fixed, human-safe sentence plus its reason code; never
 * database text. Each route still resolves the signed-in user itself first.
 */

export const NO_STORE = { "Cache-Control": "no-store" };

/** HTTP body cap for chat management requests (names, ids, flags). */
export const CHAT_ACTION_MAX_BYTES = 4 * 1024;

export function chatFailure(
  reason: ChatErrorReason,
  extra: { message?: string; health?: ProviderHealthEntry[]; stored?: boolean } = {},
): Response {
  return Response.json(
    {
      ok: false,
      reason,
      message: extra.message ?? CHAT_ERROR_MESSAGES[reason],
      ...(extra.health && extra.health.length > 0 ? { health: extra.health } : {}),
      ...(extra.stored ? { stored: true } : {}),
    },
    { status: CHAT_ERROR_STATUS[reason], headers: NO_STORE },
  );
}

/** A thrown error -> the reason the person is told. Unknown errors are "unavailable". */
export function chatReasonFor(error: unknown): ChatErrorReason {
  if (error instanceof AuthenticationRequiredError) return "unauthenticated";
  if (error instanceof ChatActionError) return error.reason;
  if (error instanceof ChatNotFoundError) return "chat_not_found";
  // Another account's project looks exactly like one that does not exist.
  if (error instanceof ChatRoomNotFoundError || error instanceof OwnershipViolationError) {
    return "not_found";
  }
  return "unavailable";
}

export function chatErrorResponse(error: unknown, what: string): Response {
  const reason = chatReasonFor(error);
  if (reason === "unavailable") console.error(`[threadlink] ${what} failed`);
  if (error instanceof ChatActionError) {
    return chatFailure(reason, { message: error.message, health: error.health });
  }
  return chatFailure(reason);
}

/**
 * Reads a small JSON body: size first (declared, then actual), then JSON.
 * Returns the parsed value or a failure Response.
 */
export async function readSmallJson(
  request: Request,
  maxBytes: number = CHAT_ACTION_MAX_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    // Streamed with a byte cap: an oversized body is never buffered whole.
    const text = await readCappedText(request, maxBytes);
    if (typeof text !== "string") return { ok: false, response: chatFailure("too_long") };
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: chatFailure("invalid") };
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Fail closed before reading anything from the request: the signed-in
 * ThreadLink user, or the reason to refuse (unauthenticated / unavailable).
 */
export async function ownerSignedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

/** A JSON body answered with no-store. */
export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: NO_STORE });
