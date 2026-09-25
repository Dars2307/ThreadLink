import { z } from "zod";

import {
  call,
  ClientOperationError,
  validate,
  type ClientDatabase,
} from "@/lib/client-api/operations";
import { sessionIdSchema } from "@/lib/sessions/model";

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

export async function startTeamJob(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ job: TeamStatus; created: boolean }> {
  const input = validate(startTeamJobInputSchema, rawInput);
  const row = await call(
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
    },
    (data) => teamStatusRowSchema.parse(data),
  );
  return { job: toTeamStatus(row), created: row.created === true };
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
};

export type OwnerNote = {
  id: string;
  seq: number;
  audience: "claude-code" | "codex" | "team";
  body: string;
  createdAt: string;
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
    }));
  }
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
