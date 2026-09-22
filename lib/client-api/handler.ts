import "server-only";

import {
  connectionUnauthorizedResponse,
  requireConnectionContext,
  type ConnectionContext,
} from "@/lib/connections/require-connection";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

import { ClientOperationError, type ClientDatabase, type ClientErrorKind } from "./operations";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

const STATUS: Record<Exclude<ClientErrorKind, "unauthorized">, number> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  too_large: 413,
  limit: 429,
  unavailable: 503,
};

export type ClientHandlerContext = ConnectionContext & { db: ClientDatabase };

/**
 * Wraps every connection-authenticated route:
 * 1. `requireConnectionContext(request)`: fail closed with a generic 401;
 * 2. run the operation with an identity-less (anon) Supabase client, so the
 *    database re-verifies the credential itself;
 * 3. map failures to generic, non-enumerating error bodies.
 * Never logs request bodies, headers or credentials.
 */
export async function handleClientRequest(
  request: Request,
  operation: (ctx: ClientHandlerContext) => Promise<unknown>,
): Promise<Response> {
  let ctx: ConnectionContext;
  try {
    ctx = await requireConnectionContext(request);
  } catch {
    return connectionUnauthorizedResponse();
  }

  try {
    const result = await operation({ ...ctx, db: createAnonymousSupabaseClient() });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const kind: ClientErrorKind =
      error instanceof ClientOperationError ? error.kind : "unavailable";
    if (kind === "unauthorized") return connectionUnauthorizedResponse();
    if (kind === "unavailable") console.error("[threadlink] client operation failed");
    return Response.json({ error: kind }, { status: STATUS[kind], headers: NO_STORE });
  }
}

/**
 * Parses a bounded JSON body. The declared Content-Length is checked before the
 * body is read, and the actual byte size after; oversized requests are rejected
 * before any expensive processing.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ClientOperationError("too_large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new ClientOperationError("too_large");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClientOperationError("invalid");
  }
}
