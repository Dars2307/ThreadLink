import type { ThreadLinkUser } from "@/lib/auth/provision";
import { isThreadLinkId } from "@/lib/ids";

import { generateConnectionToken, hashConnectionToken, type IssuedCredential } from "./credentials";
import {
  ALPHA_ROLE_FOR_PLATFORM,
  parseOwnedConnections,
  registerConnectionInputSchema,
  type Connection,
} from "./model";

/**
 * Connection registration, revocation and credential rotation.
 *
 * - Owner comes from the verified ThreadLink user; the database derives it
 *   again from the JWT inside the SECURITY DEFINER functions.
 * - Raw tokens are generated here and only their HMAC reaches the database.
 * - Errors are generic; another user's connection is indistinguishable from
 *   a nonexistent one.
 */

type RpcError = { message: string; code?: string } | null;
export type RegistrationDatabase = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError }>;
};

export class ConnectionLimitError extends Error {
  constructor() {
    super("Active connection limit reached");
    this.name = "ConnectionLimitError";
  }
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super("Connection not found");
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionOperationError extends Error {
  constructor() {
    super("Connection operation failed");
    this.name = "ConnectionOperationError";
  }
}

export type RegisteredConnection = {
  connection: Connection;
  /** Returned exactly once. Never persist, log or place in a URL. */
  credential: IssuedCredential;
};

function mapError(error: RpcError): never {
  if (error?.code === "54000") throw new ConnectionLimitError();
  if (error?.code === "P0002") throw new ConnectionNotFoundError();
  throw new ConnectionOperationError();
}

function parseOwned(data: unknown, user: ThreadLinkUser): Connection {
  const [connection] = parseOwnedConnections([data], user.id);
  return connection;
}

export async function registerConnection(
  db: RegistrationDatabase,
  user: ThreadLinkUser,
  rawInput: unknown,
  secret: string,
): Promise<RegisteredConnection> {
  const input = registerConnectionInputSchema.parse(rawInput);
  const credential = generateConnectionToken();
  const { data, error } = await db.rpc("register_connection", {
    p_platform: input.platform,
    p_role: ALPHA_ROLE_FOR_PLATFORM[input.platform],
    p_display_name: input.displayName ?? null,
    p_token_hash: hashConnectionToken(credential.token, secret),
    p_token_prefix: credential.tokenPrefix,
  });
  if (error) mapError(error);
  return { connection: parseOwned(data, user), credential };
}

export async function revokeConnection(
  db: RegistrationDatabase,
  user: ThreadLinkUser,
  connectionId: unknown,
): Promise<Connection> {
  if (!isThreadLinkId("connection", connectionId)) throw new ConnectionNotFoundError();
  const { data, error } = await db.rpc("revoke_connection", { p_connection_id: connectionId });
  if (error) mapError(error);
  return parseOwned(data, user);
}

export async function rotateConnectionCredential(
  db: RegistrationDatabase,
  user: ThreadLinkUser,
  connectionId: unknown,
  secret: string,
): Promise<RegisteredConnection> {
  if (!isThreadLinkId("connection", connectionId)) throw new ConnectionNotFoundError();
  const credential = generateConnectionToken();
  const { data, error } = await db.rpc("rotate_connection_credential", {
    p_connection_id: connectionId,
    p_token_hash: hashConnectionToken(credential.token, secret),
    p_token_prefix: credential.tokenPrefix,
  });
  if (error) mapError(error);
  return { connection: parseOwned(data, user), credential };
}
