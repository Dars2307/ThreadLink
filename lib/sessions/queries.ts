import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import {
  CONNECTION_PLATFORMS,
  CONNECTION_ROLES,
  OwnershipViolationError,
} from "@/lib/connections/model";
import { idPattern, isThreadLinkId } from "@/lib/ids";
import { linkRowSchema, toThreadLinkView, type ThreadLinkView } from "@/lib/pairing/model";

import { NATIVE_SESSION_MODES, SESSION_STATUSES } from "./model";

/**
 * Human (dashboard) reads of sessions and links. USER-SCOPED client only:
 * RLS limits rows to the signed-in owner, and every row is re-checked here.
 */

const ownerSessionSchema = z.object({
  id: z.string().regex(idPattern("sessionBinding")),
  owner_user_id: z.string(),
  connection_id: z.string().regex(idPattern("connection")),
  display_name: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  native_session_mode: z.enum(NATIVE_SESSION_MODES),
  native_provider_session_id: z.string().nullable(),
  workspace_path: z.string().nullable(),
  native_attached_at: z.string().nullable(),
  runtime_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  provider: z.string().nullable(),
  native_busy: z.boolean(),
  connections: z.object({
    platform: z.enum(CONNECTION_PLATFORMS),
    role: z.enum(CONNECTION_ROLES),
  }),
});

export type OwnerSession = {
  sessionId: string;
  connectionId: string;
  platform: (typeof CONNECTION_PLATFORMS)[number];
  role: (typeof CONNECTION_ROLES)[number];
  displayName: string | null;
  status: (typeof SESSION_STATUSES)[number];
  createdAt: string;
  lastSeenAt: string | null;
  nativeSessionMode: (typeof NATIVE_SESSION_MODES)[number];
  /** Adapter metadata only (render masked). */
  nativeSessionId: string | null;
  workspacePath: string | null;
  nativeAttachedAt: string | null;
  runtimeId: string | null;
  workspaceId: string | null;
  provider: string | null;
  busy: boolean;
};

export async function listSessions(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<OwnerSession[]> {
  const { data, error } = await db
    .from("session_bindings")
    .select(
      "id, owner_user_id, connection_id, display_name, status, created_at, last_seen_at, native_session_mode, native_provider_session_id, workspace_path, native_attached_at, runtime_id, workspace_id, provider, native_busy, connections(platform, role)",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Failed to load sessions");
  const rows = z.array(ownerSessionSchema).parse(data);
  if (rows.some((row) => row.owner_user_id !== user.id)) throw new OwnershipViolationError();
  return rows.map((row) => ({
    sessionId: row.id,
    connectionId: row.connection_id,
    platform: row.connections.platform,
    role: row.connections.role,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    nativeSessionMode: row.native_session_mode,
    nativeSessionId: row.native_provider_session_id,
    workspacePath: row.workspace_path,
    nativeAttachedAt: row.native_attached_at,
    runtimeId: row.runtime_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    busy: row.native_busy,
  }));
}

const ownerLinkSchema = linkRowSchema.extend({ owner_user_id: z.string() });

export async function listThreadLinks(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<ThreadLinkView[]> {
  const { data, error } = await db
    .from("thread_links")
    .select(
      "id, owner_user_id, controller_session_id, agent_session_id, status, revoked_reason, requested_at, approved_at, revoked_at",
    )
    .order("requested_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Failed to load thread links");
  const rows = z.array(ownerLinkSchema).parse(data);
  if (rows.some((row) => row.owner_user_id !== user.id)) throw new OwnershipViolationError();
  return rows.map(toThreadLinkView);
}

export class ThreadLinkNotFoundError extends Error {
  constructor() {
    super("Thread link not found");
    this.name = "ThreadLinkNotFoundError";
  }
}

/** Owner revocation from the dashboard (Clerk-authenticated). Idempotent. */
export async function revokeThreadLinkAsOwner(
  db: SupabaseClient,
  linkId: unknown,
): Promise<ThreadLinkView> {
  if (!isThreadLinkId("threadLink", linkId)) throw new ThreadLinkNotFoundError();
  const { data, error } = await db.rpc("revoke_thread_link", { p_link_id: linkId });
  if (error) {
    if (error.code === "P0002") throw new ThreadLinkNotFoundError();
    throw new Error("Failed to revoke thread link");
  }
  return toThreadLinkView(linkRowSchema.parse(data));
}

/** Owner opens a pairing from the dashboard. Starts pending; the agent session must approve. */
export async function ownerRequestPairing(
  db: SupabaseClient,
  controllerSessionId: unknown,
  agentSessionId: unknown,
): Promise<ThreadLinkView> {
  if (
    !isThreadLinkId("sessionBinding", controllerSessionId) ||
    !isThreadLinkId("sessionBinding", agentSessionId)
  ) {
    throw new ThreadLinkNotFoundError();
  }
  const { data, error } = await db.rpc("owner_request_pairing", {
    p_controller_session_id: controllerSessionId,
    p_agent_session_id: agentSessionId,
  });
  if (error) {
    if (error.code === "P0002") throw new ThreadLinkNotFoundError();
    throw new Error("Failed to request pairing");
  }
  return toThreadLinkView(linkRowSchema.parse(data));
}
