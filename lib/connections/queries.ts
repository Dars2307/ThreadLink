import type { SupabaseClient } from "@supabase/supabase-js";

import type { ThreadLinkUser } from "@/lib/auth/provision";

import {
  CONNECTION_COLUMNS,
  createConnectionInputSchema,
  parseOwnedConnections,
  type Connection,
} from "./model";

/**
 * Connection queries. Always called with a USER-SCOPED client (RLS enforced)
 * and the ThreadLink user resolved from the verified session.
 *
 * Owner IDs are never sent on writes: the database derives `owner_user_id`
 * from the JWT. Results are re-checked against `user.id`.
 */

export async function listConnections(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<Connection[]> {
  const { data, error } = await db
    .from("connections")
    .select(CONNECTION_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Failed to load connections");
  return parseOwnedConnections(data, user.id);
}

export async function createConnection(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawInput: unknown,
): Promise<Connection> {
  const input = createConnectionInputSchema.parse(rawInput);
  const { data, error } = await db
    .from("connections")
    .insert({
      platform: input.platform,
      role: input.role,
      display_name: input.displayName ?? null,
    })
    .select(CONNECTION_COLUMNS)
    .single();
  if (error) throw new Error("Failed to create connection");
  const [connection] = parseOwnedConnections([data], user.id);
  return connection;
}
