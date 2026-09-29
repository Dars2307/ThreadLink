import { z } from "zod";

import {
  call,
  ClientOperationError,
  validate,
  type ClientDatabase,
} from "@/lib/client-api/operations";
import {
  fixedHealthDetail,
  HEALTH_CHECKED_AT_PATTERN,
  healthMessage,
  parseHealthDetail,
  PROVIDER_HEALTH,
  type ProviderHealthEntry,
} from "@/lib/providers/health";
import { sessionIdSchema } from "@/lib/sessions/model";
import {
  PRIORITY_PATTERN,
  taskEnvelopeSchema,
  toTaskEnvelope,
  type TaskEnvelope,
} from "@/lib/tasks/model";

import {
  AGENT_PROVIDERS,
  CHATGPT_PLANS,
  CLAUDE_PLANS,
  createRoomInputSchema,
  decisionLabel,
  jobIdSchema,
  roomIdSchema,
  roomRowSchema,
  startTeamJobInputSchema,
  teamLogPageSchema,
  teamLogRowSchema,
  teamStatusRowSchema,
  teamWriteOpSchema,
  teamWriteRequestSchema,
  teamWriteResultSchema,
  toRoomView,
  toSqlPayload,
  toTeamStatus,
  type RoomView,
  type TeamStatus,
  ISO_INSTANT_PATTERN,
} from "./model";

/**
 * Team Mode client operations (connection-authenticated).
 *
 * Controller calls carry the controller's own session; the database resolves
 * ownership, the room's link and the job's origin itself. Runtime writes carry
 * the agent session and the carrier task's claim_ref; the database accepts them
 * only from the session that holds that claim. Nothing here trusts an owner,
 * room or route from the request.
 */

const parseStatus = (data: unknown): TeamStatus => toTeamStatus(teamStatusRowSchema.parse(data));
const parseRoom = (data: unknown) => roomRowSchema.parse(data);

export async function listRooms(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
): Promise<RoomView[]> {
  const session = validate(sessionIdSchema, sessionId);
  return call(db, "list_rooms", { p_token_hash: credentialHash, p_session_id: session }, (data) =>
    z.array(roomRowSchema).parse(data).map(toRoomView),
  );
}

export async function createRoom(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ room: RoomView; created: boolean }> {
  const input = validate(createRoomInputSchema, rawInput);
  const row = await call(
    db,
    "create_room",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_name: input.name,
      p_thread_link_id: input.threadLinkId ?? null,
    },
    parseRoom,
  );
  return { room: toRoomView(row), created: row.created === true };
}

export type RoomDetail = RoomView & {
  recentJobs: {
    jobId: string;
    goal: string;
    status: TeamStatus["status"];
    verdict: TeamStatus["verdict"];
    startedHere: boolean;
    createdAt: string;
  }[];
};

export async function getRoom(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
  roomId: unknown,
): Promise<RoomDetail> {
  const session = validate(sessionIdSchema, sessionId);
  const room = validate(roomIdSchema, roomId);
  const row = await call(
    db,
    "get_room",
    { p_token_hash: credentialHash, p_session_id: session, p_room_id: room },
    parseRoom,
  );
  return {
    ...toRoomView(row),
    recentJobs: (row.recent_jobs ?? []).map((j) => ({
      jobId: j.job_id,
      goal: j.goal,
      status: j.status,
      verdict: j.verdict,
      startedHere: j.started_here,
      createdAt: j.created_at,
    })),
  };
}

/**
 * A job start refused by the health gate (docs/design/chat-first.md section 2):
 * nothing was created. `health` comes from the database's machine-readable
 * DETAIL, parsed strictly; the sentence is built here from ids and fixed words:
 * "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer."
 */
export class ProviderUnhealthyError extends ClientOperationError {
  readonly health: ProviderHealthEntry[];
  readonly userMessage: string;
  constructor(health: ProviderHealthEntry[] | null) {
    super("conflict");
    this.name = "ProviderUnhealthyError";
    this.health = health ?? [];
    this.userMessage = healthMessage(this.health);
  }
}

type RpcErrorDetail = {
  message: string;
  code?: string;
  hint?: string | null;
  details?: string | null;
};

/** Like `call`, but a provider_unhealthy refusal becomes ProviderUnhealthyError. */
async function callGated<T>(
  db: ClientDatabase,
  fn: string,
  args: Record<string, unknown>,
  parse: (data: unknown) => T,
): Promise<T> {
  let result: { data: unknown; error: RpcErrorDetail | null };
  try {
    result = (await db.rpc(fn, args)) as { data: unknown; error: RpcErrorDetail | null };
  } catch {
    throw new ClientOperationError("unavailable");
  }
  if (result.error?.hint === "provider_unhealthy") {
    throw new ProviderUnhealthyError(parseHealthDetail(result.error.details));
  }
  return call({ rpc: async () => result }, fn, args, parse);
}

export async function startTeamJob(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ job: TeamStatus; created: boolean }> {
  const input = validate(startTeamJobInputSchema, rawInput);
  const row = await callGated(
    db,
    "start_team_job",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_room_id: input.roomId,
      p_goal: input.goal,
      p_spec: input.spec ?? null,
      p_max_planning_rounds: input.maxPlanningRounds ?? null,
      p_max_review_rounds: input.maxReviewRounds ?? null,
      p_parallel_agents: input.parallelAgents ?? null,
      p_verify_commands: null,
      p_idempotency_key: input.idempotencyKey ?? null,
      // Always sent (null = Team Mode), so the call resolves to the overload
      // that takes a mode; the database validates both.
      p_mode: input.mode ?? null,
      p_builder: input.builder ?? null,
      // 0.9: always sent (null = the project's default chat), so the call
      // resolves to the overload that takes a chat; validated by the database.
      p_chat_id: input.chatId ?? null,
    },
    (data) => teamStatusRowSchema.parse(data),
  );
  return { job: toTeamStatus(row), created: row.created === true };
}

export const createChatTaskInputSchema = z
  .object({
    originSessionId: z.string().regex(/^tlses_[0-9a-f]{32}$/),
    threadLinkId: z.string().regex(/^tllnk_[0-9a-f]{32}$/),
    chatId: z.string().regex(/^tlcht_[0-9a-f]{32}$/),
    title: z.string().trim().min(1).max(255),
    content: z.string().min(1).max(60_000),
    priority: z.string().regex(PRIORITY_PATTERN).optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
  })
  .strict();

/**
 * send_to_agent in a chat (0.9): an ordinary task over the caller's link that
 * lands in the named chat. The database checks the chat is this account's, in
 * a live project the link reaches; otherwise "not found" and nothing is made.
 */
export async function createChatTask(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ task: TaskEnvelope; created: boolean }> {
  const input = validate(createChatTaskInputSchema, rawInput);
  const row = await call(
    db,
    "create_chat_task",
    {
      p_token_hash: credentialHash,
      p_origin_session_id: input.originSessionId,
      p_thread_link_id: input.threadLinkId,
      p_chat_id: input.chatId,
      p_title: input.title,
      p_content: input.content,
      p_priority: input.priority ?? "C",
      p_idempotency_key: input.idempotencyKey ?? null,
      p_expires_in_seconds: null,
    },
    (data) => taskEnvelopeSchema.parse(data),
  );
  return { task: toTaskEnvelope(row), created: row.created === true };
}

export async function getTeamStatus(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
  jobId: unknown,
  roomId?: unknown,
): Promise<TeamStatus> {
  const session = validate(sessionIdSchema, sessionId);
  const job = validate(jobIdSchema, jobId);
  const room = roomId === undefined || roomId === null ? null : validate(roomIdSchema, roomId);
  return call(
    db,
    "get_team_status",
    { p_token_hash: credentialHash, p_session_id: session, p_job_id: job, p_room_id: room },
    parseStatus,
  );
}

export type TeamLog = TeamStatus & {
  specInput: Record<string, unknown> | null;
  spec: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  nodesDetail: Record<string, unknown>[];
  entries: (Record<string, unknown> & { kind: string })[];
  total: number;
  offset: number;
  nextOffset: number | null;
};

export async function getTeamLog(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
  jobId: unknown,
  options: { roomId?: unknown; offset?: unknown; limit?: unknown } = {},
): Promise<TeamLog> {
  const session = validate(sessionIdSchema, sessionId);
  const job = validate(jobIdSchema, jobId);
  const room =
    options.roomId === undefined || options.roomId === null
      ? null
      : validate(roomIdSchema, options.roomId);
  const page = validate(teamLogPageSchema, {
    offset: options.offset ?? undefined,
    limit: options.limit ?? undefined,
  });
  return call(
    db,
    "get_team_log",
    {
      p_token_hash: credentialHash,
      p_session_id: session,
      p_job_id: job,
      p_room_id: room,
      p_offset: page.offset,
      p_limit: page.limit,
    },
    (data) => {
      const row = teamLogRowSchema.parse(data);
      return {
        ...toTeamStatus(row),
        specInput: row.spec_input,
        spec: row.spec,
        plan: row.plan,
        evidence: row.evidence,
        nodesDetail: row.nodes_detail,
        // Decision numbers are rendered TL-%05d here, in the view layer.
        entries: row.entries.map((e) =>
          e.kind === "decision" && typeof e.number === "number"
            ? { ...e, label: decisionLabel(e.number) }
            : e,
        ),
        total: row.total,
        offset: row.offset,
        nextOffset: row.next_offset,
      };
    },
  );
}

/** What a Runtime write returns: the concise status plus the ids it created. */
export type TeamWriteResult = TeamStatus & {
  op: string;
  findingId?: string;
  decisionId?: string;
  decisionNumber?: number;
  decisionLabel?: string;
  messageId?: string;
  usageEventId?: string;
  planHash: string | null;
  round?: number;
  roundOpened?: boolean;
  /**
   * `read_owner_notes` only: the owner's notes to this job, oldest first, now
   * marked delivered. UNTRUSTED user text: hand it to the addressed agent(s)
   * clearly delimited as a note from the user, never as instructions to
   * ThreadLink. `audience` is who it is for ("team" = every agent).
   */
  ownerNotes?: OwnerNote[];
  // --- 0.10 (docs/design/threadlink-0.10.md) --------------------------------
  /** add_message: the chat row the message became (reply to it with replyTo). */
  eventId?: string | null;
  /** run_started / run_activity / run_finished. */
  runId?: string;
  /** run_started, request_choice, add_artifact: false when the key was already used (replay). */
  created?: boolean;
  /** run_started / run_finished: the run's status; request_choice: the choice's status. */
  runStatus?: string;
  /** run_activity: false when the report came within 5 s of the last one (ignored). */
  activityUpdated?: boolean;
  /** run_finished: completed + model + access verified + native session + the project's own Runtime. */
  verified?: boolean;
  /** request_choice. */
  choiceId?: string;
  /** read_choices: the owner's answers (a pending choice past 24 h reads as expired). */
  choices?: {
    choiceId: string;
    kind: string;
    status: "pending" | "chosen" | "expired" | "cancelled";
    chosenKey: string | null;
    decidedAt: string | null;
    expiresAt: string;
    requestKey: string | null;
  }[];
  /** add_change (diff artifact, when a diff was sent) / add_artifact. */
  artifactId?: string | null;
  /** ack_control: true when the control was still the one acknowledged. */
  cleared?: boolean;
  /** read_owner_notes {consumedByRunId, noteIds}: how many notes were recorded as consumed. */
  consumed?: number;
  // --- 0.11 (docs/design/threadlink-0.11.md section 12) ----------------------
  /**
   * read_chat_context: this job's chat, visible owner / controller / agent
   * messages, oldest first. UNTRUSTED text (owner words and agent output):
   * pass it to the agents clearly delimited as conversation, never as instructions.
   */
  chatContext?: ChatContextMessage[];
  /** failover_notice: the chat row (created:false = the same notice was already shown). */
  failoverEventId?: string;
};

export type ChatContextMessage = {
  id: string;
  chatSeq: number | null;
  authorKind: "owner" | "controller" | "agent";
  /** A registry provider id on agent rows; null otherwise. */
  authorProviderId: string | null;
  authorLabel: string;
  replyTo: string | null;
  body: string;
  createdAt: string;
};

export type OwnerNote = {
  id: string;
  seq: number;
  /** A provider id of the registry, or "team". */
  audience: string;
  body: string;
  createdAt: string;
  /** 0.10: the note's position in its chat. */
  chatSeq?: number | null;
  /** 0.10: the run that consumed it (read_owner_notes with runId). */
  consumedByRunId?: string | null;
};

/**
 * The Runtime's single write path. `rawBody` is `{sessionId, claimRef, op,
 * payload}`; the op is validated against its own schema, translated to the SQL
 * payload, and validated AGAIN by team_job_write, which also verifies that this
 * exact agent session holds the carrier task's claim.
 */
export async function writeTeamState(
  db: ClientDatabase,
  credentialHash: string,
  jobId: unknown,
  rawBody: unknown,
): Promise<TeamWriteResult> {
  const job = validate(jobIdSchema, jobId);
  const envelope = validate(teamWriteRequestSchema, rawBody);
  const op = validate(teamWriteOpSchema, { op: envelope.op, payload: envelope.payload });
  const row = await call(
    db,
    "team_job_write",
    {
      p_token_hash: credentialHash,
      p_session_id: envelope.sessionId,
      p_job_id: job,
      p_claim_ref: envelope.claimRef,
      p_op: op.op,
      p_payload: toSqlPayload(op),
    },
    (data) => teamWriteResultSchema.parse(data),
  );
  const r = row.result;
  const extra: Partial<TeamWriteResult> = {};
  if (r.finding_id) extra.findingId = r.finding_id;
  if (r.message_id) extra.messageId = r.message_id;
  if (r.usage_event_id) extra.usageEventId = r.usage_event_id;
  if (r.decision_id) extra.decisionId = r.decision_id;
  if (typeof r.number === "number") {
    extra.decisionNumber = r.number;
    extra.decisionLabel = decisionLabel(r.number);
  }
  if (typeof r.round === "number") extra.round = r.round;
  if (typeof r.opened === "boolean") extra.roundOpened = r.opened;
  if (r.notes) {
    extra.ownerNotes = r.notes.map((n) => ({
      id: n.id,
      seq: n.seq,
      audience: n.audience,
      body: n.body,
      createdAt: n.created_at,
      ...(n.chat_seq !== undefined ? { chatSeq: n.chat_seq } : {}),
      ...(n.consumed_by_run_id !== undefined ? { consumedByRunId: n.consumed_by_run_id } : {}),
    }));
  }
  // 0.10
  if (r.event_id !== undefined) extra.eventId = r.event_id;
  if (r.run_id) extra.runId = r.run_id;
  if (typeof r.created === "boolean") extra.created = r.created;
  if (r.status) extra.runStatus = r.status;
  if (typeof r.updated === "boolean") extra.activityUpdated = r.updated;
  if (typeof r.verified === "boolean") extra.verified = r.verified;
  if (r.choice_id) extra.choiceId = r.choice_id;
  if (r.choices) {
    extra.choices = r.choices.map((c) => ({
      choiceId: c.choice_id,
      kind: c.kind,
      status: c.status,
      chosenKey: c.chosen_key,
      decidedAt: c.decided_at,
      expiresAt: c.expires_at,
      requestKey: c.request_key,
    }));
  }
  if (r.artifact_id !== undefined) extra.artifactId = r.artifact_id;
  if (typeof r.cleared === "boolean") extra.cleared = r.cleared;
  if (typeof r.consumed === "number") extra.consumed = r.consumed;
  // 0.11
  if (r.messages) {
    extra.chatContext = r.messages.map((m) => ({
      id: m.id,
      chatSeq: m.chat_seq,
      authorKind: m.author_kind,
      authorProviderId: m.author_provider_id,
      authorLabel: m.author_label,
      replyTo: m.reply_to,
      body: m.body,
      createdAt: m.created_at,
    }));
  }
  if (row.op === "failover_notice" && r.event_id) extra.failoverEventId = r.event_id;
  return { ...toTeamStatus(row), op: row.op, ...extra };
}

// ---------------------------------------------------------------------------
// Runtime: provider profiles (read the owner's settings; report detection)
// ---------------------------------------------------------------------------
const providerProfileRowSchema = z.object({
  provider: z.enum(AGENT_PROVIDERS),
  declared_plan: z.string(),
  usage_policy: z.string(),
  paid_usage_enabled: z.boolean(),
  detected: z.record(z.string(), z.unknown()),
  detected_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type RuntimeProviderProfile = {
  provider: (typeof AGENT_PROVIDERS)[number];
  declaredPlan: string;
  usagePolicy: string;
  paidUsageEnabled: boolean;
  detected: Record<string, unknown>;
  detectedAt: string | null;
};

const toRuntimeProfile = (p: z.infer<typeof providerProfileRowSchema>): RuntimeProviderProfile => ({
  provider: p.provider,
  declaredPlan: p.declared_plan,
  usagePolicy: p.usage_policy,
  paidUsageEnabled: p.paid_usage_enabled,
  detected: p.detected,
  detectedAt: p.detected_at,
});

export async function getProviderProfiles(
  db: ClientDatabase,
  credentialHash: string,
): Promise<RuntimeProviderProfile[]> {
  return call(db, "get_provider_profiles", { p_token_hash: credentialHash }, (data) =>
    z.array(providerProfileRowSchema).parse(data).map(toRuntimeProfile),
  );
}

/**
 * Nothing identity- or credential-shaped may be in a detection document: not as
 * a key, at any depth, and no email address as a value. The same rule is
 * enforced again in SQL; this only refuses it earlier.
 */
const FORBIDDEN_DETECTION_KEY =
  /(email|org|organi[sz]ation|account|uuid|user_?id|token|secret|password|api_?key|credential|cookie)/i;
const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Walks the whole document. A document nested too deeply to walk is refused
 * rather than waved through: depth is not a reason to stop looking.
 */
function hasForbiddenContent(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") return EMAIL_VALUE.test(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenContent(v, depth + 1));
  return Object.entries(value).some(
    ([k, v]) => FORBIDDEN_DETECTION_KEY.test(k) || hasForbiddenContent(v, depth + 1),
  );
}

export const providerDetectionSchema = z
  .object({
    provider: z.enum(AGENT_PROVIDERS),
    detected: z
      .object({
        installed: z.boolean().optional(),
        version: z.string().max(80).nullable().optional(),
        authenticated: z.boolean().optional(),
        authMethod: z.string().max(40).nullable().optional(),
        detectedPlan: z.string().max(40).nullable().optional(),
        models: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
        currentModel: z.string().max(200).nullable().optional(),
        capabilities: z.record(z.string(), z.boolean()).optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
        detectedAt: z.string().max(40).optional(),
        // 0.9 health (docs/design/chat-first.md section 2). The detail is a fixed
        // Runtime sentence; the database also caps, pattern-checks and redacts it.
        health: z.enum(PROVIDER_HEALTH).optional(),
        healthCheckedAt: z.string().regex(HEALTH_CHECKED_AT_PATTERN).nullable().optional(),
        // Only the Runtime's fixed sentences are kept; anything else becomes null
        // (never refused: the health itself must still arrive).
        healthDetail: z
          .unknown()
          .optional()
          .transform((v) => (v === undefined ? undefined : fixedHealthDetail(v))),
        // 0.11: when the provider said its usage resets (usage_exhausted only; the
        // server keeps it only inside a sanity window, never invents one).
        resetsAt: z.string().regex(ISO_INSTANT_PATTERN).nullable().optional(),
      })
      .strict()
      .refine((d) => !hasForbiddenContent(d), "identity- or credential-shaped content")
      .refine((d) => new TextEncoder().encode(JSON.stringify(d)).length <= 16_384, "bytes"),
  })
  .strict();

export async function reportProviderDetection(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<RuntimeProviderProfile> {
  const input = validate(providerDetectionSchema, rawInput);
  return call(
    db,
    "report_provider_detection",
    { p_token_hash: credentialHash, p_provider: input.provider, p_detected: input.detected },
    (data) => toRuntimeProfile(providerProfileRowSchema.parse(data)),
  );
}

/**
 * The Runtime (desktop app) sets the owner's DECLARED plan for one provider.
 * Nothing else: usage policy and paid usage stay owner-only (dashboard). The
 * plan lists are per provider, and the database checks them again.
 */
export const runtimeProviderPlanSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("claude-code"), declaredPlan: z.enum(CLAUDE_PLANS) }).strict(),
  z.object({ provider: z.literal("codex"), declaredPlan: z.enum(CHATGPT_PLANS) }).strict(),
]);

export async function setRuntimeProviderPlan(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<RuntimeProviderProfile> {
  const input = validate(runtimeProviderPlanSchema, rawInput);
  return call(
    db,
    "set_runtime_provider_plan",
    {
      p_token_hash: credentialHash,
      p_provider: input.provider,
      p_declared_plan: input.declaredPlan,
    },
    (data) => toRuntimeProfile(providerProfileRowSchema.parse(data)),
  );
}

export { ClientOperationError };
