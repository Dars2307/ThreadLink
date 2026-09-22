import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { getServerEnv } from "@/lib/env/server";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import type { Connection } from "./model";
import { listConnections } from "./queries";
import {
  registerConnection,
  revokeConnection,
  rotateConnectionCredential,
  type RegisteredConnection,
} from "./registration";

/** Connections owned by the verified caller (with non-secret credential metadata). */
export async function listMyConnections(): Promise<Connection[]> {
  const user = await requireThreadLinkUser();
  return listConnections(createUserSupabaseClient(), user);
}

/**
 * Registers a connection owned by the verified caller and issues its first
 * credential. `rawInput` is untrusted and cannot carry ownership or role.
 * The returned raw token must be shown once and then discarded.
 */
export async function registerMyConnection(rawInput: unknown): Promise<RegisteredConnection> {
  const user = await requireThreadLinkUser();
  const secret = getServerEnv().THREADLINK_CONNECTION_SECRET;
  return registerConnection(createUserSupabaseClient(), user, rawInput, secret);
}

/** Revokes one of the caller's connections. Idempotent. */
export async function revokeMyConnection(connectionId: unknown): Promise<Connection> {
  const user = await requireThreadLinkUser();
  return revokeConnection(createUserSupabaseClient(), user, connectionId);
}

/** Replaces the credential of one of the caller's active connections. */
export async function rotateMyConnectionCredential(
  connectionId: unknown,
): Promise<RegisteredConnection> {
  const user = await requireThreadLinkUser();
  const secret = getServerEnv().THREADLINK_CONNECTION_SECRET;
  return rotateConnectionCredential(createUserSupabaseClient(), user, connectionId, secret);
}
