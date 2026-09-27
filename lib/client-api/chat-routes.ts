import { readCappedText } from "@/lib/http/body";
import "server-only";

import {
  requireConnectionContext,
  type ConnectionContext,
} from "@/lib/connections/require-connection";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

import {
  CHAT_API_STATUS,
  CHAT_CLIENTS,
  ChatApiError,
  chatApiMessage,
  type ChatApiReason,
  type ChatClient,
} from "./chats";
import type { ClientDatabase } from "./operations";

/**
 * The Runtime chat routes (/api/runtime/chats/**). Bearer = the computer's
 * Runtime (agent) credential; same-origin does not apply. In order:
 *   1. authenticate the credential (generic 401 on any failure);
 *   2. refuse any other credential kind (403) before touching the body;
 *   3. run the operation with an identity-less (anon) client, so the database
 *      re-verifies the credential, the Runtime (active, not paused) and the
 *      owner itself;
 *   4. answer {ok:false, reason, message} with a fixed sentence on refusal.
 * Never logs bodies, headers or credentials.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export function chatApiFailure(
  reason: ChatApiReason,
  extra: { message?: string; health?: unknown; stored?: boolean; eventId?: string | null } = {},
): Response {
  const headers: Record<string, string> = { ...NO_STORE };
  if (reason === "unauthenticated") headers["WWW-Authenticate"] = 'Bearer realm="threadlink"';
  return Response.json(
    {
      ok: false,
      reason,
      message: extra.message ?? chatApiMessage(reason),
      ...(Array.isArray(extra.health) && extra.health.length > 0 ? { health: extra.health } : {}),
      ...(extra.stored ? { stored: true } : {}),
      ...(extra.eventId ? { eventId: extra.eventId } : {}),
    },
    { status: CHAT_API_STATUS[reason], headers },
  );
}

export type RuntimeChatContext = ConnectionContext & { db: ClientDatabase };

export async function handleRuntimeChatRequest(
  request: Request,
  operation: (ctx: RuntimeChatContext) => Promise<unknown>,
): Promise<Response> {
  let ctx: ConnectionContext;
  try {
    ctx = await requireConnectionContext(request);
  } catch {
    return chatApiFailure("unauthenticated");
  }
  // Only a Runtime (agent) credential. A controller must use MCP.
  if (ctx.identity.role !== "agent") return chatApiFailure("forbidden");

  try {
    const result = await operation({ ...ctx, db: createAnonymousSupabaseClient() });
    if (result instanceof Response) return result;
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ChatApiError) {
      if (error.reason === "unavailable")
        console.error("[threadlink] runtime chat operation failed");
      return chatApiFailure(error.reason, { message: error.userMessage, health: error.health });
    }
    console.error("[threadlink] runtime chat operation failed");
    return chatApiFailure("unavailable");
  }
}

/**
 * Parses a bounded JSON object body: declared size, actual size, then JSON.
 * Throws ChatApiError too_large / invalid.
 */
export async function readChatJson(request: Request, maxBytes: number): Promise<unknown> {
  // Streamed with a byte cap: an oversized body is never buffered whole.
  let read: string | { tooLarge: true };
  try {
    read = await readCappedText(request, maxBytes);
  } catch {
    throw new ChatApiError("invalid");
  }
  if (typeof read !== "string") throw new ChatApiError("too_large");
  const text = read;
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ChatApiError("invalid");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatApiError("invalid");
  }
  return body;
}

export const CHAT_CLIENT_HEADER = "x-threadlink-client";

/**
 * Which client is posting: the `X-ThreadLink-Client` header or the body's
 * `client` field, each validated to desktop|terminal. At least one is
 * required; if both are sent they must agree.
 */
export function chatClientFrom(request: Request, body: unknown): ChatClient {
  const header = request.headers.get(CHAT_CLIENT_HEADER);
  const field =
    body !== null && typeof body === "object" && "client" in body
      ? (body as { client: unknown }).client
      : undefined;
  const ok = (v: unknown): v is ChatClient =>
    typeof v === "string" && (CHAT_CLIENTS as readonly string[]).includes(v);
  if (header !== null && !ok(header)) throw new ChatApiError("invalid");
  if (field !== undefined && !ok(field)) throw new ChatApiError("invalid");
  if (header !== null && field !== undefined && header !== field) throw new ChatApiError("invalid");
  const client = header ?? field;
  if (!ok(client)) throw new ChatApiError("invalid");
  return client;
}
