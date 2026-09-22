import { z } from "zod";

import { idPattern } from "@/lib/ids";
import {
  NATIVE_SESSION_MODES,
  sessionIdSchema,
  sessionRowSchema,
  setNativeSessionInputSchema,
  toClientSession,
  type ClientSession,
} from "@/lib/sessions/model";

import { call, validate, type ClientDatabase } from "./operations";

/**
 * Native (provider) session attachment. The native ID is adapter metadata: the
 * database stores it on the agent's own tlses_ and nothing routes by it.
 */
export async function setNativeSession(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<ClientSession> {
  const input = validate(setNativeSessionInputSchema, rawInput);
  const row = await call(
    db,
    "set_native_session",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_mode: input.mode,
      p_native_session_id: input.nativeSessionId ?? null,
      p_workspace_path: input.workspacePath ?? null,
    },
    (data) => sessionRowSchema.parse(data),
  );
  return toClientSession(row);
}

const agentSessionRowSchema = z.object({
  id: z.string().regex(idPattern("sessionBinding")),
  display_name: z.string().nullable(),
  workspace_name: z.string().nullable(),
  native_session_mode: z.enum(NATIVE_SESSION_MODES),
  last_seen_at: z.string().nullable(),
  link_status: z.enum(["pending", "active"]).nullable(),
  runtime_label: z.string().nullable().optional(),
  runtime_online: z.boolean().nullable().optional(),
  busy: z.boolean().nullable().optional(),
});

export type AgentSessionOption = {
  sessionId: string;
  displayName: string | null;
  workspaceName: string | null;
  attachedToExistingSession: boolean;
  lastSeenAt: string | null;
  linkStatus: "pending" | "active" | null;
  /** Which Runtime (device/environment) this conversation lives on. */
  runtimeLabel: string | null;
  runtimeOnline: boolean;
  /** True while the conversation is open elsewhere; ThreadLink will not write into it. */
  busy: boolean;
};

/** Controller-only: the owner's Claude Code sessions this conversation could link to. */
export async function listAgentSessions(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
): Promise<AgentSessionOption[]> {
  const id = validate(sessionIdSchema, sessionId);
  const rows = await call(
    db,
    "list_agent_sessions",
    { p_token_hash: credentialHash, p_session_id: id },
    (data) => z.array(agentSessionRowSchema).max(200).parse(data),
  );
  return rows.map((row) => ({
    sessionId: row.id,
    displayName: row.display_name,
    workspaceName: row.workspace_name,
    attachedToExistingSession: row.native_session_mode === "resume",
    lastSeenAt: row.last_seen_at,
    linkStatus: row.link_status,
    runtimeLabel: row.runtime_label ?? null,
    runtimeOnline: row.runtime_online === true,
    busy: row.busy === true,
  }));
}
