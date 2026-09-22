import { z } from "zod";

import { CONNECTION_PLATFORMS, CONNECTION_ROLES } from "@/lib/connections/model";
import { idPattern } from "@/lib/ids";

/**
 * Session bindings: ThreadLink-owned identities (tlses_) for one logical
 * client session. Provider references and display names are metadata only;
 * the tlses_ ID is canonical. Mirrors supabase/migrations/*_sessions_and_pairing.sql.
 */

export const SESSION_STATUSES = ["active", "idle", "retired", "revoked"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Client-chosen stable handle, unique per connection. Used for idempotent reconnects. */
export const LOCAL_BINDING_REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** Opaque provider metadata (never an identity). */
export const PROVIDER_SESSION_REF_PATTERN = /^[A-Za-z0-9._:/@#-]{1,255}$/;

/**
 * What a client may send when registering a session. `.strict()` rejects
 * owner, connection, role, platform and ID fields: those come from the
 * authenticated connection.
 */
export const registerSessionInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    providerSessionRef: z.string().regex(PROVIDER_SESSION_REF_PATTERN).optional(),
    localBindingRef: z.string().regex(LOCAL_BINDING_REF_PATTERN).optional(),
  })
  .strict();

export const sessionIdSchema = z.string().regex(idPattern("sessionBinding"));

export const sessionReferenceInputSchema = z.object({ sessionId: sessionIdSchema }).strict();

export const sessionRowSchema = z.object({
  id: sessionIdSchema,
  connection_id: z.string().regex(idPattern("connection")),
  platform: z.enum(CONNECTION_PLATFORMS),
  role: z.enum(CONNECTION_ROLES),
  display_name: z.string().nullable(),
  provider_session_ref: z.string().nullable(),
  local_binding_ref: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  retired_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created: z.boolean().optional(),
});

/** Safe client-facing view (no owner internals). */
export type ClientSession = {
  sessionId: string;
  connectionId: string;
  platform: (typeof CONNECTION_PLATFORMS)[number];
  role: (typeof CONNECTION_ROLES)[number];
  displayName: string | null;
  status: SessionStatus;
};

export function toClientSession(row: z.infer<typeof sessionRowSchema>): ClientSession {
  return {
    sessionId: row.id,
    connectionId: row.connection_id,
    platform: row.platform,
    role: row.role,
    displayName: row.display_name,
    status: row.status,
  };
}
