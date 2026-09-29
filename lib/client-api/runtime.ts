import { z } from "zod";

import { generateConnectionToken, hashConnectionToken } from "@/lib/connections/credentials";
import { idPattern } from "@/lib/ids";
import {
  LOCAL_BINDING_REF_PATTERN,
  NATIVE_SESSION_ID_PATTERN,
  sessionRowSchema,
} from "@/lib/sessions/model";

import { call, ClientOperationError, validate, type ClientDatabase } from "./operations";

/**
 * Runtime (agent credential) operations. The database derives owner, runtime
 * and connection from the credential; these schemas only bound the shape of
 * the Runtime's self-description.
 */

const runtimeRowSchema = z.object({
  id: z.string().regex(/^tlrun_[0-9a-f]{32}$/),
  label: z.string(),
  platform: z.string(),
  kind: z.string(),
  version: z.string().nullable(),
  capabilities: z.record(z.string(), z.string()),
  settings: z.record(z.string(), z.boolean()),
  paused: z.boolean(),
  restart_requested_at: z.string().nullable(),
  status: z.string(),
  last_seen_at: z.string().nullable(),
  // 0.10 (optional: a database before the 0.10 migration does not send them).
  protocol: z.number().int().optional(),
  protocol_reported: z.boolean().optional(),
  min_protocol: z.number().int().optional(),
  update_required: z.boolean().optional(),
  // 0.11: the newest protocol, and whether this Runtime is older than it.
  current_protocol: z.number().int().optional(),
  update_available: z.boolean().optional(),
});

export type RuntimeView = {
  runtimeId: string;
  label: string;
  platform: string;
  kind: string;
  paused: boolean;
  restartRequestedAt: string | null;
  settings: Record<string, boolean>;
  status: string;
  /** 0.10: the protocol the server judges this Runtime by (reported, or its minor version). */
  protocol?: number;
  /** 0.10: the current protocol (RUNTIME_PROTOCOL); older Runtimes should update. */
  minProtocol?: number;
  /** 0.10: true when this Runtime is older than the minimum protocol ("needs an update"). */
  updateRequired?: boolean;
  /** 0.11: the newest protocol (11); a 0.10 Runtime keeps working but gets no Fast Chat. */
  currentProtocol?: number;
  /** 0.11: true when a newer protocol exists (offer the update; work still runs). */
  updateAvailable?: boolean;
};

const toView = (r: z.infer<typeof runtimeRowSchema>): RuntimeView => ({
  runtimeId: r.id,
  label: r.label,
  platform: r.platform,
  kind: r.kind,
  paused: r.paused,
  restartRequestedAt: r.restart_requested_at,
  settings: r.settings,
  status: r.status,
  ...(r.protocol !== undefined ? { protocol: r.protocol } : {}),
  ...(r.min_protocol !== undefined ? { minProtocol: r.min_protocol } : {}),
  ...(r.update_required !== undefined ? { updateRequired: r.update_required } : {}),
  ...(r.current_protocol !== undefined ? { currentProtocol: r.current_protocol } : {}),
  ...(r.update_available !== undefined ? { updateAvailable: r.update_available } : {}),
});

const VERSION = z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/);
/**
 * 0.10: RUNTIME_PROTOCOL (docs/design/threadlink-0.10.md section 8). Optional:
 * a Runtime that does not send it is judged by its version (0.9.x = 9).
 */
const PROTOCOL = z.number().int().min(1).max(1000);

const registerSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    platform: z.enum(["windows", "macos", "linux", "other"]),
    kind: z.enum(["desktop", "cli", "remote"]),
    version: VERSION,
    protocol: PROTOCOL.optional(),
  })
  .strict();

export async function registerRuntime(db: ClientDatabase, hash: string, raw: unknown) {
  const i = validate(registerSchema, raw);
  const row = await call(
    db,
    "register_runtime",
    {
      p_token_hash: hash,
      p_label: i.label,
      p_platform: i.platform,
      p_kind: i.kind,
      p_version: i.version,
      ...(i.protocol !== undefined ? { p_protocol: i.protocol } : {}),
    },
    (d) => runtimeRowSchema.parse(d),
  );
  return toView(row);
}

const heartbeatSchema = z
  .object({
    version: VERSION,
    capabilities: z.record(z.string().max(40), z.string().max(20)),
    busySessionIds: z.array(z.string().regex(idPattern("sessionBinding"))).max(200),
    protocol: PROTOCOL.optional(),
  })
  .strict();

export async function runtimeHeartbeat(db: ClientDatabase, hash: string, raw: unknown) {
  const i = validate(heartbeatSchema, raw);
  const row = await call(
    db,
    "runtime_heartbeat",
    {
      p_token_hash: hash,
      p_version: i.version,
      p_capabilities: i.capabilities,
      p_busy_session_ids: i.busySessionIds,
      ...(i.protocol !== undefined ? { p_protocol: i.protocol } : {}),
    },
    (d) => runtimeRowSchema.parse(d),
  );
  return toView(row);
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const workspaceSchema = z
  .object({
    workspaceKey: hex64,
    displayName: z.string().trim().min(1).max(100),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => ![...p].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)),
    repoRemote: z
      .string()
      .regex(/^[a-z0-9._~/-]{3,300}$/)
      .nullable(),
    repoFingerprint: hex64.nullable(),
    branch: z
      .string()
      .regex(/^[A-Za-z0-9._/+-]{1,200}$/)
      .nullable(),
  })
  .strict();

export async function upsertWorkspace(db: ClientDatabase, hash: string, raw: unknown) {
  const i = validate(workspaceSchema, raw);
  const row = await call(
    db,
    "upsert_runtime_workspace",
    {
      p_token_hash: hash,
      p_workspace_key: i.workspaceKey,
      p_display_name: i.displayName,
      p_path: i.path,
      p_repo_remote: i.repoRemote,
      p_repo_fingerprint: i.repoFingerprint,
      p_branch: i.branch,
    },
    (d) => z.object({ id: z.string().regex(/^tlwsp_[0-9a-f]{32}$/) }).parse(d),
  );
  return { workspaceId: row.id };
}

const conversationSchema = z
  .object({
    workspaceId: z.string().regex(/^tlwsp_[0-9a-f]{32}$/),
    localBindingRef: z.string().regex(LOCAL_BINDING_REF_PATTERN),
    displayName: z.string().trim().min(1).max(100),
    provider: z.literal("claude-code"),
    mode: z.enum(["resume", "worker", "fresh"]),
    nativeSessionId: z.string().regex(NATIVE_SESSION_ID_PATTERN).nullable(),
    /** Worker mode only: the background conversation ThreadLink created. */
    workerNativeSessionId: z.string().regex(NATIVE_SESSION_ID_PATTERN).nullable().optional(),
  })
  .strict()
  // Exact mode needs the conversation; worker mode may name the one it was
  // branched from; a fresh conversation must name none.
  .refine((v) => v.mode !== "resume" || Boolean(v.nativeSessionId))
  .refine((v) => !v.nativeSessionId || v.mode === "resume" || v.mode === "worker")
  .refine((v) => !v.workerNativeSessionId || v.mode === "worker");

export async function registerConversation(db: ClientDatabase, hash: string, raw: unknown) {
  const i = validate(conversationSchema, raw);
  const row = await call(
    db,
    "register_runtime_session",
    {
      p_token_hash: hash,
      p_workspace_id: i.workspaceId,
      p_local_binding_ref: i.localBindingRef,
      p_display_name: i.displayName,
      p_provider: i.provider,
      p_mode: i.mode,
      p_native_session_id: i.nativeSessionId,
      p_worker_native_session_id: i.workerNativeSessionId ?? null,
    },
    (d) => sessionRowSchema.parse(d),
  );
  return { sessionId: row.id, created: row.created === true };
}

/** Runtime self-rotation: a new credential is minted server-side and returned once. */
export async function rotateOwnCredential(db: ClientDatabase, hash: string, secret: string) {
  const credential = generateConnectionToken();
  await call(
    db,
    "rotate_own_credential",
    {
      p_token_hash: hash,
      p_new_token_hash: hashConnectionToken(credential.token, secret),
      p_new_token_prefix: credential.tokenPrefix,
    },
    (d) => z.object({ connection_id: z.string() }).parse(d),
  );
  return { token: credential.token };
}

/**
 * Link requests for this Runtime's own sessions.
 *
 * The Runtime asks the server rather than reading its local files, so a
 * request stays visible - and explains itself - even when its conversation has
 * been detached on this computer. Only what the Runtime UI needs is returned:
 * notably not the controller's session id.
 */
const runtimeLinkRowSchema = z.object({
  id: z.string().regex(idPattern("threadLink")),
  status: z.enum(["pending", "active"]),
  paused: z.boolean(),
  agent_session_id: z.string().regex(idPattern("sessionBinding")),
  controller_display_name: z.string().nullable(),
  requested_at: z.string(),
  approved_at: z.string().nullable(),
  conversation: z.object({
    display_name: z.string().nullable(),
    local_binding_ref: z.string(),
    provider: z.string().nullable(),
    mode: z.string().nullable(),
    native_session_id: z.string().nullable(),
    workspace_id: z.string().nullable(),
    workspace_name: z.string().nullable(),
    workspace_path: z.string().nullable(),
  }),
});

export type RuntimeLinkView = {
  linkId: string;
  status: "pending" | "active";
  paused: boolean;
  agentSessionId: string;
  controllerDisplayName: string | null;
  requestedAt: string;
  approvedAt: string | null;
  conversation: {
    displayName: string | null;
    localBindingRef: string;
    provider: string | null;
    mode: string | null;
    nativeSessionId: string | null;
    workspaceId: string | null;
    workspaceName: string | null;
    workspacePath: string | null;
  };
};

export async function listRuntimeLinks(
  db: ClientDatabase,
  hash: string,
): Promise<RuntimeLinkView[]> {
  const rows = await call(db, "list_runtime_links", { p_token_hash: hash }, (d) =>
    z.array(runtimeLinkRowSchema).parse(d),
  );
  return rows.map((row) => ({
    linkId: row.id,
    status: row.status,
    paused: row.paused,
    agentSessionId: row.agent_session_id,
    controllerDisplayName: row.controller_display_name,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    conversation: {
      displayName: row.conversation.display_name,
      localBindingRef: row.conversation.local_binding_ref,
      provider: row.conversation.provider,
      mode: row.conversation.mode,
      nativeSessionId: row.conversation.native_session_id,
      workspaceId: row.conversation.workspace_id,
      workspaceName: row.conversation.workspace_name,
      workspacePath: row.conversation.workspace_path,
    },
  }));
}

// ---------------------------------------------------------------------------
// 0.11 wake long-poll (docs/design/threadlink-0.11.md section 3.2)
// ---------------------------------------------------------------------------
export const WAKE_MAX_WAIT_SECONDS = 25;
export const WAKE_DEFAULT_WAIT_SECONDS = 20;
export const WAKE_POLL_MS = 750;

const pendingRowSchema = z.object({
  pending: z.number().int().min(0),
  paused: z.boolean().optional(),
});

export type WakeResult = { pending: number; paused?: boolean };

/** `?wait=` in whole seconds, 0..25 (default 20). Anything else is invalid. */
export function parseWakeWait(raw: string | null): number {
  if (raw === null || raw === "") return WAKE_DEFAULT_WAIT_SECONDS;
  if (!/^[0-9]{1,3}$/.test(raw)) throw new ClientOperationError("invalid");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > WAKE_MAX_WAIT_SECONDS)
    throw new ClientOperationError("invalid");
  return n;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Holds the request until this Runtime has something to claim (a queued task
 * for one of its sessions, or a lapsed lease), checking the database about
 * every 750 ms, or until `wait` seconds pass ({pending: 0}) or the client goes
 * away. The first check counts against the owner's wake rate limit; waiting is
 * also proof of life (it refreshes the Runtime's last_seen_at, throttled).
 */
export async function waitForWork(
  db: ClientDatabase,
  hash: string,
  rawWait: string | null,
  signal?: AbortSignal,
  options: { pollMs?: number; now?: () => number } = {},
): Promise<WakeResult> {
  const waitSeconds = parseWakeWait(rawWait);
  const pollMs = options.pollMs ?? WAKE_POLL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitSeconds * 1000;
  const check = (begin: boolean) =>
    call(db, "runtime_pending_count", { p_token_hash: hash, p_begin: begin }, (d) =>
      pendingRowSchema.parse(d),
    );
  let row = await check(true);
  while (row.pending === 0 && !row.paused && !signal?.aborted) {
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(pollMs, left), signal);
    if (signal?.aborted) break;
    row = await check(false);
  }
  return { pending: row.pending, ...(row.paused ? { paused: true } : {}) };
}
