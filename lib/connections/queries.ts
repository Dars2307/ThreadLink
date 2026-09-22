import type { SupabaseClient } from "@supabase/supabase-js";

import type { ThreadLinkUser } from "@/lib/auth/provision";

import {
  CONNECTION_COLUMNS,
  CREDENTIAL_METADATA_COLUMNS,
  parseOwnedConnections,
  type Connection,
} from "./model";

/**
 * Connection reads. Always called with a USER-SCOPED client (RLS enforced)
 * and the ThreadLink user resolved from the verified session. Results are
 * re-checked against `user.id`. Writes go through ./registration.ts.
 */
export async function listConnections(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<Connection[]> {
  const { data, error } = await db
    .from("connections")
    .select(`${CONNECTION_COLUMNS}, connection_credentials(${CREDENTIAL_METADATA_COLUMNS})`)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Failed to load connections");

  const rows = (data ?? []).map((row) => {
    const { connection_credentials: credentials, ...rest } = row as Record<string, unknown> & {
      connection_credentials?: { created_at: string }[] | null;
    };
    const latest = [...(credentials ?? [])].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    return { ...rest, credential: latest ?? null };
  });
  return parseOwnedConnections(rows, user.id);
}
