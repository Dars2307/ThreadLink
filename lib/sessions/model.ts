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
  native_provider_session_id: z.string().nullable().optional(),
  native_session_mode: z.enum(["fresh", "resume", "continue", "worker"]).optional(),
  worker_native_session_id: z.string().nullable().optional(),
  workspace_path: z.string().nullable().optional(),
  native_attached_at: z.string().nullable().optional(),
  created: z.boolean().optional(),
});

export const NATIVE_SESSION_MODES = ["fresh", "resume", "continue", "worker"] as const;
export type NativeSessionMode = (typeof NATIVE_SESSION_MODES)[number];
/** Claude Code session IDs are lowercase UUIDs. */
export const NATIVE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Agent-only: which native provider session this tlses_ resumes (metadata, never identity). */
export const setNativeSessionInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    mode: z.enum(NATIVE_SESSION_MODES),
    nativeSessionId: z.string().regex(NATIVE_SESSION_ID_PATTERN).nullable().optional(),
    workspacePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) => ![...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127),
        "no control characters",
      )
      .optional(),
  })
  .strict()
  .refine((v) => (v.mode === "resume") === Boolean(v.nativeSessionId), {
    message: "resume mode requires nativeSessionId (and only resume carries one)",
  });

/** Safe client-facing view (no owner internals). */
export type ClientSession = {
  sessionId: string;
  connectionId: string;
  platform: (typeof CONNECTION_PLATFORMS)[number];
  role: (typeof CONNECTION_ROLES)[number];
  displayName: string | null;
  status: SessionStatus;
  /** fresh | resume | continue. The native ID and path are not echoed back to clients. */
  nativeSessionMode: NativeSessionMode;
  /** Worker mode: the background conversation ThreadLink created, if any. */
  workerNativeSessionId: string | null;
};

export function toClientSession(row: z.infer<typeof sessionRowSchema>): ClientSession {
  return {
    sessionId: row.id,
    connectionId: row.connection_id,
    platform: row.platform,
    role: row.role,
    displayName: row.display_name,
    status: row.status,
    nativeSessionMode: row.native_session_mode ?? "fresh",
    workerNativeSessionId: row.worker_native_session_id ?? null,
  };
}
