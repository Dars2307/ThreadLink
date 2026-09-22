import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import type { Connection } from "./model";
import { createConnection, listConnections } from "./queries";

/** Connections owned by the verified caller. */
export async function listMyConnections(): Promise<Connection[]> {
  const user = await requireThreadLinkUser();
  return listConnections(createUserSupabaseClient(), user);
}

/**
 * Creates a connection owned by the verified caller. `rawInput` may come from
 * an untrusted source; it is validated strictly and cannot carry ownership.
 */
export async function createMyConnection(rawInput: unknown): Promise<Connection> {
  const user = await requireThreadLinkUser();
  return createConnection(createUserSupabaseClient(), user, rawInput);
}
