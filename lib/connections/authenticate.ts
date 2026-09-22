import { z } from "zod";

import { idPattern } from "@/lib/ids";

import {
  extractBearerToken,
  hashConnectionToken,
  isWellFormedConnectionToken,
} from "./credentials";
import { CONNECTION_PLATFORMS, CONNECTION_ROLES } from "./model";

/** Trusted identity of an authenticated non-human client. */
export type ConnectionIdentity = {
  readonly connectionId: string;
  readonly ownerUserId: string;
  readonly platform: (typeof CONNECTION_PLATFORMS)[number];
  readonly role: (typeof CONNECTION_ROLES)[number];
  readonly status: "active" | "idle";
};

/** Internal-only failure reasons (for server logs). Never returned to clients. */
export type ConnectionAuthFailure = "missing" | "malformed" | "rejected" | "unavailable";

export type ConnectionAuthResult =
  { ok: true; identity: ConnectionIdentity } | { ok: false; reason: ConnectionAuthFailure };

export type ConnectionAuthDatabase = {
  rpc(
    fn: "authenticate_connection",
    args: { p_token_hash: string },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

const identitySchema = z
  .object({
    connection_id: z.string().regex(idPattern("connection")),
    owner_user_id: z.string().regex(idPattern("user")),
    platform: z.enum(CONNECTION_PLATFORMS),
    role: z.enum(CONNECTION_ROLES),
    status: z.enum(["active", "idle"]),
  })
  .strict();

/**
 * Verifies a connection credential from an Authorization header value.
 * Fails closed; malformed tokens are rejected before any database call.
 */
export async function authenticateConnectionToken(
  authorization: string | null | undefined,
  deps: { secret: string; db: ConnectionAuthDatabase },
): Promise<ConnectionAuthResult> {
  const token = extractBearerToken(authorization);
  if (token === null) return { ok: false, reason: "missing" };
  if (!isWellFormedConnectionToken(token)) return { ok: false, reason: "malformed" };

  let tokenHash: string;
  try {
    tokenHash = hashConnectionToken(token, deps.secret);
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  try {
    const { data, error } = await deps.db.rpc("authenticate_connection", {
      p_token_hash: tokenHash,
    });
    if (error) return { ok: false, reason: "unavailable" };
    if (data === null || data === undefined) return { ok: false, reason: "rejected" };
    const parsed = identitySchema.safeParse(data);
    if (!parsed.success) return { ok: false, reason: "unavailable" };
    const row = parsed.data;
    return {
      ok: true,
      identity: Object.freeze({
        connectionId: row.connection_id,
        ownerUserId: row.owner_user_id,
        platform: row.platform,
        role: row.role,
        status: row.status,
      }),
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
