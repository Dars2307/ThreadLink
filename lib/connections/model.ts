import { z } from "zod";

import { idPattern } from "@/lib/ids";

/** Mirrors the CHECK constraints in supabase/migrations/*_connections.sql. */
export const CONNECTION_PLATFORMS = ["chatgpt", "claude-code"] as const;
export const CONNECTION_ROLES = ["controller", "agent"] as const;
export const CONNECTION_STATUSES = ["active", "idle", "revoked", "retired"] as const;

export type ConnectionPlatform = (typeof CONNECTION_PLATFORMS)[number];
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * Alpha role for each platform. The role is derived server-side, never chosen
 * by the caller: ChatGPT is the controller, Claude Code is the execution agent.
 * Roles stay a separate column so future providers are not hard-coded.
 */
export const ALPHA_ROLE_FOR_PLATFORM: Record<ConnectionPlatform, ConnectionRole> = {
  chatgpt: "controller",
  "claude-code": "agent",
};

/** Alpha abuse limit; mirrors threadlink_private.max_active_connections(). */
export const MAX_ACTIVE_CONNECTIONS = 10;

/**
 * What a caller may supply when registering a connection.
 *
 * `.strict()` rejects any extra key, so ownership and lifecycle fields such as
 * `owner_user_id`, `clerkUserId`, `id`, `role`, `status` or token material
 * cannot be smuggled in. Ownership is always derived from the verified caller.
 */
export const registerConnectionInputSchema = z
  .object({
    platform: z.enum(CONNECTION_PLATFORMS),
    displayName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type RegisterConnectionInput = z.infer<typeof registerConnectionInputSchema>;

/** Non-secret credential metadata. The hash is never selectable. */
export const credentialMetadataSchema = z.object({
  id: z.string().regex(idPattern("credential")),
  token_prefix: z.string().regex(/^tlc_[A-Za-z0-9_-]{6}$/),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export type CredentialMetadata = {
  id: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** Row shape returned by the database; validated before use. */
export const connectionRowSchema = z.object({
  id: z.string().regex(idPattern("connection")),
  owner_user_id: z.string().regex(idPattern("user")),
  platform: z.enum(CONNECTION_PLATFORMS),
  role: z.enum(CONNECTION_ROLES),
  status: z.enum(CONNECTION_STATUSES),
  display_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_seen_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  credential: credentialMetadataSchema.nullable().optional(),
});

export const CONNECTION_COLUMNS =
  "id, owner_user_id, platform, role, status, display_name, created_at, updated_at, last_seen_at, revoked_at";

/** Column list for the embedded, non-secret credential metadata. */
export const CREDENTIAL_METADATA_COLUMNS = "id, token_prefix, created_at, last_used_at, revoked_at";

export type Connection = {
  id: string;
  ownerUserId: string;
  platform: ConnectionPlatform;
  role: ConnectionRole;
  status: ConnectionStatus;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Most recent credential (active, or the one revoked with the connection). */
  credential: CredentialMetadata | null;
};

export class OwnershipViolationError extends Error {
  constructor() {
    super("Resource ownership check failed");
    this.name = "OwnershipViolationError";
  }
}

/**
 * Parses database rows and verifies every row belongs to `ownerUserId`.
 *
 * RLS should already guarantee this; this is the application-layer check.
 * A mismatch means isolation is broken, so we fail closed rather than filter.
 */
export function parseOwnedConnections(rows: unknown, ownerUserId: string): Connection[] {
  const parsed = z.array(connectionRowSchema).parse(rows);
  if (parsed.some((row) => row.owner_user_id !== ownerUserId)) {
    throw new OwnershipViolationError();
  }
  return parsed.map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    platform: row.platform,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    credential: row.credential
      ? {
          id: row.credential.id,
          tokenPrefix: row.credential.token_prefix,
          createdAt: row.credential.created_at,
          lastUsedAt: row.credential.last_used_at,
          revokedAt: row.credential.revoked_at,
        }
      : null,
  }));
}
