import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

import { authenticateConnectionToken, type ConnectionIdentity } from "./authenticate";

export type { ConnectionIdentity };

export class ConnectionAuthenticationError extends Error {
  constructor() {
    // Identical for every failure: missing, malformed, unknown, revoked, inactive.
    super("Connection authentication required");
    this.name = "ConnectionAuthenticationError";
  }
}

/**
 * Authenticates a non-human client request by its connection credential
 * (`Authorization: Bearer tlc_...`) and returns the trusted connection identity.
 *
 * This is the entry point for any route called by a ThreadLink client (MCP,
 * Claude Code bridge). It never accepts an identity from the request body.
 * Fails closed with a single generic error.
 */
export async function requireConnection(request: Request): Promise<ConnectionIdentity> {
  return (await requireConnectionContext(request)).identity;
}

/** Trusted connection context for routes that call connection-authenticated DB functions. */
export type ConnectionContext = {
  readonly identity: ConnectionIdentity;
  /** HMAC of the presented token. Server memory only; never log, persist or return it. */
  readonly credentialHash: string;
};

/**
 * Like `requireConnection`, but also returns the credential HMAC so the
 * database can re-verify the credential inside each operation (no caller-
 * supplied connection ID is ever trusted).
 */
export async function requireConnectionContext(request: Request): Promise<ConnectionContext> {
  let secret: string;
  try {
    secret = getServerEnv().THREADLINK_CONNECTION_SECRET;
  } catch {
    logFailure("unavailable");
    throw new ConnectionAuthenticationError();
  }

  const result = await authenticateConnectionToken(request.headers.get("authorization"), {
    secret,
    db: createAnonymousSupabaseClient(),
  });
  if (!result.ok) {
    logFailure(result.reason);
    throw new ConnectionAuthenticationError();
  }
  return Object.freeze({ identity: result.identity, credentialHash: result.credentialHash });
}

/** Generic 401 for connection-authenticated routes. */
export function connectionUnauthorizedResponse(): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="threadlink"', "Cache-Control": "no-store" },
    },
  );
}

// Logs the reason only. Never the token, its hash or any header value.
function logFailure(reason: string): void {
  console.warn(`[threadlink] connection authentication failed reason=${reason}`);
}
