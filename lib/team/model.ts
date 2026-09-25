import { z } from "zod";

/**
 * Team Mode vocabulary and wire schemas for the server.
 *
 * The enumerations DUPLICATE runtime/src/team/types.ts on purpose: the root
 * tsconfig excludes runtime/, so lib/ does not import Runtime code. A test
 * (tests/team-server.test.ts) asserts these lists equal the Runtime's, and the
 * migration's CHECK constraints mirror them too (supabase/tests 011).
 */

export const AGENT_PROVIDERS = ["claude-code", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const TEAM_ROLES = [
  "coordinator",
  "planner",
  "builder",
  "reviewer",
  "security_reviewer",
  "test_reviewer",
  "integrator",
  "investigator",
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const ROOM_STATUSES = ["active", "archived", "deleted"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const JOB_STATUSES = [
  "queued",
  "normalising",
  "planning",
  "building",
  "reviewing",
  "integrating",
  "inspecting",
  "completed",
  "needs_fix",
  "blocked",
  "needs_user_decision",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_VERDICTS = ["PASS", "NEEDS_FIX", "BLOCKED", "NEEDS_USER_DECISION"] as const;
export type JobVerdict = (typeof JOB_VERDICTS)[number];

export const NODE_STATUSES = [
  "pending",
  "ready",
  "running",
  "in_review",
  "changes_requested",
  "approved",
  "integrated",
  "failed",
  "skipped",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const MESSAGE_TYPES = [
  "proposal",
  "review",
  "finding",
  "response",
  "handoff",
  "question",
  "decision",
  "completion",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const FINDING_SEVERITIES = ["blocking", "important", "non_blocking"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  "correctness",
  "security",
  "architecture",
  "edge_case",
  "tests",
  "performance",
  "requirements",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_STATUSES = ["open", "resolved", "wont_fix"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const MODEL_CLASSES = ["FAST", "BALANCED", "STRONG", "FRONTIER"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const USAGE_POLICIES = ["conservative", "balanced", "maximum_quality", "manual"] as const;
export type UsagePolicy = (typeof USAGE_POLICIES)[number];

export const CLAUDE_PLANS = [
  "free",
  "pro",
  "max_5x",
  "max_20x",
  "team",
  "enterprise",
  "unknown",
] as const;
export type ClaudePlan = (typeof CLAUDE_PLANS)[number];

export const CHATGPT_PLANS = [
  "free",
  "go",
  "plus",
  "pro",
  "business_standard",
  "business_premium",
  "enterprise",
  "edu",
  "unknown",
] as const;
export type ChatgptPlan = (typeof CHATGPT_PLANS)[number];

export const TEAM_LIMITS = {
  planningRounds: { min: 1, max: 5, default: 2 },
  reviewRounds: { min: 1, max: 6, default: 3 },
  parallelAgents: { min: 1, max: 4, default: 2 },
} as const;

export const ARBITRATION_ORDER = [
  "user_decision",
  "project_decision",
  "security",
  "data_integrity",
  "correctness",
  "architecture",
  "maintainability",
  "performance",
  "style",
] as const;

/** Runner outcomes (design 3.1 `failure`) plus "ok". */
export const USAGE_OUTCOMES = [
  "ok",
  "model_mismatch",
  "access_mismatch",
  "quota_exhausted",
  "not_authenticated",
  "not_installed",
  "timeout",
  "provider_error",
] as const;

/** Statuses only set_final may reach (plus "failed", which the carrier task sets). */
export const TERMINAL_JOB_STATUSES = [
  "completed",
  "needs_fix",
  "blocked",
  "needs_user_decision",
  "failed",
  "cancelled",
] as const;

/** Server-side byte bounds. The Runtime redacts; the server enforces size. */
export const TEAM_SIZE_LIMITS = {
  goalBytes: 8000,
  bodyBytes: 8 * 1024,
  specBytes: 32 * 1024,
  planBytes: 64 * 1024,
  evidenceBytes: 32 * 1024,
  decisionJsonBytes: 16 * 1024,
  nodesPerCall: 100,
  /** HTTP body cap for the runtime write endpoint (largest op + envelope). */
  writeBodyBytes: 160 * 1024,
} as const;

// ---------------------------------------------------------------------------
// IDs and small primitives
// ---------------------------------------------------------------------------
export const roomIdSchema = z.string().regex(/^tlrom_[0-9a-f]{32}$/);
export const jobIdSchema = z.string().regex(/^tljob_[0-9a-f]{32}$/);
export const findingIdSchema = z.string().regex(/^tlfnd_[0-9a-f]{32}$/);

const encoder = new TextEncoder();
export const byteLength = (value: string) => encoder.encode(value).length;
const jsonBytes = (value: unknown) => byteLength(JSON.stringify(value) ?? "");

/** Non-empty text bounded in bytes (the database bounds bytes, not chars). */
export const boundedText = (maxBytes: number) =>
  z
    .string()
    .refine((v) => v.trim().length > 0, "must not be blank")
    .refine((v) => byteLength(v) <= maxBytes, `must be at most ${maxBytes} bytes`);

const oneLine = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v) && v.trim().length > 0, "single line");

const boundedJson = (maxBytes: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => jsonBytes(v) <= maxBytes, `must be at most ${maxBytes} bytes`);

export const NODE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const nodeKeySchema = z.string().regex(NODE_KEY_PATTERN);
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@[\]-]{1,200}$/;

/** Test commands ThreadLink itself runs. Max 10, one line each, <= 300 chars. */
export const verifyCommandsSchema = z.array(oneLine(300)).max(10);

// ---------------------------------------------------------------------------
// TeamSpec (partial from the controller, full from the Runtime)
// ---------------------------------------------------------------------------
const specList = z.array(boundedText(2000)).max(50);
export const SPEC_LIST_FIELDS = [
  "requirements",
  "constraints",
  "architectureConstraints",
  "securityConstraints",
  "filesAndSystems",
  "testsRequired",
  "doNotChange",
  "deploymentRules",
  "definitionOfDone",
] as const;

export const teamSpecSchema = z
  .object({
    goal: boundedText(TEAM_SIZE_LIMITS.goalBytes).optional(),
    requirements: specList.optional(),
    constraints: specList.optional(),
    architectureConstraints: specList.optional(),
    securityConstraints: specList.optional(),
    filesAndSystems: specList.optional(),
    testsRequired: specList.optional(),
    doNotChange: specList.optional(),
    deploymentRules: specList.optional(),
    definitionOfDone: specList.optional(),
  })
  .strict()
  .refine(
    (v) => jsonBytes(v) <= TEAM_SIZE_LIMITS.specBytes,
    `spec must be at most ${TEAM_SIZE_LIMITS.specBytes} bytes`,
  );
export type TeamSpecInput = z.infer<typeof teamSpecSchema>;

/** The controller-side spec: everything but the goal (the goal is its own field). */
export const controllerSpecSchema = z
  .object({
    requirements: specList.optional(),
    constraints: specList.optional(),
    architectureConstraints: specList.optional(),
    securityConstraints: specList.optional(),
    filesAndSystems: specList.optional(),
    testsRequired: specList.optional(),
    doNotChange: specList.optional(),
    deploymentRules: specList.optional(),
    definitionOfDone: specList.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Runtime write operations: the request body of POST /api/team/jobs/[jobId]/state
// ---------------------------------------------------------------------------
const provider = z.enum(AGENT_PROVIDERS);
const party = z.enum(["claude-code", "codex", "threadlink"]);
const round = z.number().int().min(0).max(6);
const providerList = z.array(provider).max(2);

const nodeInput = z
  .object({
    key: nodeKeySchema,
    title: z.string().trim().min(1).max(200),
    description: boundedText(4000).optional(),
    scope: boundedText(2000).nullish(),
    files: z.array(z.string().min(1).max(512)).max(200).optional(),
    dependsOn: z.array(nodeKeySchema).max(32).optional(),
    owner: provider,
    reviewer: provider.nullish(),
    status: z.enum(NODE_STATUSES).optional(),
    worktreeBranch: z
      .string()
      .regex(/^[A-Za-z0-9._/+-]{1,200}$/)
      .nullish(),
  })
  .strict()
  // Safety invariant, checked here and by the table: never self-review.
  .refine((n) => !n.reviewer || n.reviewer !== n.owner, "reviewer must differ from owner");

export const teamWriteOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_spec"), payload: z.object({ spec: teamSpecSchema }).strict() }),
  z.object({
    op: z.literal("set_plan"),
    payload: z
      .object({
        plan: boundedJson(TEAM_SIZE_LIMITS.planBytes),
        planHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        approvedBy: providerList.optional(),
        round: z.number().int().min(0).max(5).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("upsert_nodes"),
    payload: z
      .object({
        nodes: z.array(nodeInput).min(1).max(TEAM_SIZE_LIMITS.nodesPerCall),
        decisionNumber: z.number().int().min(1).max(99_999).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("set_node_status"),
    payload: z
      .object({
        key: nodeKeySchema,
        status: z.enum(NODE_STATUSES),
        authorship: z.enum(["single", "mixed"]).optional(),
        worktreeBranch: z
          .string()
          .regex(/^[A-Za-z0-9._/+-]{1,200}$/)
          .optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("add_message"),
    payload: z
      .object({
        sender: party,
        senderRole: z.enum(TEAM_ROLES).optional(),
        receiver: party.nullish(),
        node: nodeKeySchema.nullish(),
        type: z.enum(MESSAGE_TYPES),
        round: round.optional(),
        body: boundedText(TEAM_SIZE_LIMITS.bodyBytes),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("add_finding"),
    payload: z
      .object({
        node: nodeKeySchema.nullish(),
        round: round.optional(),
        phase: z.enum(["planning", "review", "inspection"]).optional(),
        severity: z.enum(FINDING_SEVERITIES),
        category: z.enum(FINDING_CATEGORIES),
        summary: z.string().trim().min(1).max(200),
        detail: z
          .string()
          .refine(
            (v) => byteLength(v) <= TEAM_SIZE_LIMITS.bodyBytes,
            "detail exceeds the limit in bytes",
          )
          .optional(),
        file: z.string().min(1).max(400).nullish(),
        line: z.number().int().min(0).max(10_000_000).nullish(),
        raisedBy: party,
      })
      .strict(),
  }),
  z.object({
    op: z.literal("set_finding_status"),
    payload: z
      .object({
        findingId: findingIdSchema,
        status: z.enum(FINDING_STATUSES),
        round: round.optional(),
        resolution: boundedText(4000).optional(),
        decisionNumber: z.number().int().min(1).max(99_999).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("add_decision"),
    payload: z
      .object({
        topic: z.string().trim().min(1).max(200),
        resolution: boundedText(4000).nullish(),
        approvedBy: providerList.optional(),
        evidence: z
          .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .refine(
            (v) => jsonBytes(v) <= TEAM_SIZE_LIMITS.decisionJsonBytes,
            "evidence exceeds the limit in bytes",
          )
          .nullish(),
        proposals: z
          .array(z.unknown())
          .max(10)
          .refine(
            (v) => jsonBytes(v) <= TEAM_SIZE_LIMITS.decisionJsonBytes,
            "proposals exceed the limit in bytes",
          )
          .optional(),
        basis: z.enum(ARBITRATION_ORDER).optional(),
        needsUser: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("open_round"),
    payload: z
      .object({
        kind: z.enum(["planning", "review"]),
        round: z.number().int().min(1).max(100).optional(),
        node: nodeKeySchema.nullish(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("record_usage"),
    payload: z
      .object({
        provider,
        role: z.enum(TEAM_ROLES),
        node: nodeKeySchema.nullish(),
        requestedModel: z.string().regex(MODEL_ID_PATTERN),
        observedModel: z.string().regex(MODEL_ID_PATTERN).nullish(),
        effort: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .nullish(),
        modelClass: z.enum(MODEL_CLASSES),
        reason: boundedText(1000),
        escalatedFrom: z.enum(MODEL_CLASSES).nullish(),
        escalationReason: boundedText(1000).nullish(),
        outcome: z.enum(USAGE_OUTCOMES),
        inputTokens: z.number().int().min(0).max(1_000_000_000).nullish(),
        outputTokens: z.number().int().min(0).max(1_000_000_000).nullish(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("set_status"),
    payload: z
      .object({
        // Phase moves only; verdict statuses belong to set_final.
        status: z.enum([
          "normalising",
          "planning",
          "building",
          "reviewing",
          "integrating",
          "inspecting",
          "cancelled",
        ]),
        line: oneLine(200).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("set_final"),
    payload: z
      .object({
        verdict: z.enum(JOB_VERDICTS),
        summary: boundedText(4000).optional(),
        evidence: boundedJson(TEAM_SIZE_LIMITS.evidenceBytes),
      })
      .strict(),
  }),
]);
export type TeamWriteOp = z.infer<typeof teamWriteOpSchema>;

export const teamWriteRequestSchema = z
  .object({
    sessionId: z.string().regex(/^tlses_[0-9a-f]{32}$/),
    claimRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    op: z.string(),
    payload: z.unknown(),
  })
  .strict();

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Translates the Runtime's (camelCase) operation into the strict SQL payload
 * that team_job_write validates again. Pure; unit-tested.
 */
export function toSqlPayload(input: TeamWriteOp): Record<string, unknown> {
  switch (input.op) {
    case "set_spec":
      return { spec: input.payload.spec };
    case "set_plan":
      return compact({
        plan: input.payload.plan,
        client_hash: input.payload.planHash,
        approved_by: input.payload.approvedBy,
        round: input.payload.round,
      });
    case "upsert_nodes":
      return compact({
        nodes: input.payload.nodes.map((n) =>
          compact({
            key: n.key,
            title: n.title,
            description: n.description,
            owner_provider: n.owner,
            reviewer_provider: n.reviewer ?? undefined,
            depends_on: n.dependsOn,
            scope: n.scope ?? undefined,
            files: n.files,
            worktree_branch: n.worktreeBranch ?? undefined,
            status: n.status,
          }),
        ),
        decision_number: input.payload.decisionNumber,
      });
    case "set_node_status":
      return compact({
        key: input.payload.key,
        status: input.payload.status,
        authorship: input.payload.authorship,
        worktree_branch: input.payload.worktreeBranch,
      });
    case "add_message":
      return compact({
        node_key: input.payload.node ?? undefined,
        sender: input.payload.sender,
        sender_role: input.payload.senderRole,
        receiver: input.payload.receiver ?? undefined,
        type: input.payload.type,
        round: input.payload.round,
        body: input.payload.body,
      });
    case "add_finding": {
      const p = input.payload;
      const location = p.file ? (p.line ? `${p.file}:${p.line}` : p.file) : undefined;
      return compact({
        node_key: p.node ?? undefined,
        severity: p.severity,
        category: p.category,
        title: p.summary,
        body: p.detail && p.detail.trim() ? p.detail : p.summary,
        location,
        raised_by: p.raisedBy,
        round: p.round,
        phase: p.phase,
      });
    }
    case "set_finding_status":
      return compact({
        finding_id: input.payload.findingId,
        status: input.payload.status,
        round: input.payload.round,
        resolution: input.payload.resolution,
        decision_number: input.payload.decisionNumber,
      });
    case "add_decision":
      return compact({
        title: input.payload.topic,
        resolution: input.payload.resolution ?? undefined,
        approved_by: input.payload.approvedBy,
        evidence: input.payload.evidence ?? undefined,
        proposals: input.payload.proposals,
        basis: input.payload.basis,
        requires_user: input.payload.needsUser,
      });
    case "open_round":
      return compact({
        kind: input.payload.kind,
        round: input.payload.round,
        node_key: input.payload.node ?? undefined,
      });
    case "record_usage": {
      const p = input.payload;
      return compact({
        node_key: p.node ?? undefined,
        provider: p.provider,
        role: p.role,
        requested_model: p.requestedModel,
        observed_model: p.observedModel ?? undefined,
        model_class: p.modelClass,
        effort: p.effort ?? undefined,
        reason: p.reason,
        escalated_from: p.escalatedFrom ?? undefined,
        escalation_reason: p.escalationReason ?? undefined,
        outcome: p.outcome,
        input_tokens: p.inputTokens ?? undefined,
        output_tokens: p.outputTokens ?? undefined,
      });
    }
    case "set_status":
      return compact({ status: input.payload.status, line: input.payload.line });
    case "set_final":
      return compact({
        verdict: input.payload.verdict,
        summary: input.payload.summary,
        evidence: input.payload.evidence,
      });
  }
}

// ---------------------------------------------------------------------------
// Controller inputs
// ---------------------------------------------------------------------------
export const createRoomInputSchema = z
  .object({
    sessionId: z.string().regex(/^tlses_[0-9a-f]{32}$/),
    name: oneLine(100),
    threadLinkId: z
      .string()
      .regex(/^tllnk_[0-9a-f]{32}$/)
      .optional(),
  })
  .strict();

export const startTeamJobInputSchema = z
  .object({
    sessionId: z.string().regex(/^tlses_[0-9a-f]{32}$/),
    roomId: roomIdSchema,
    goal: boundedText(TEAM_SIZE_LIMITS.goalBytes),
    spec: controllerSpecSchema.optional(),
    maxPlanningRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.planningRounds.min)
      .max(TEAM_LIMITS.planningRounds.max)
      .optional(),
    maxReviewRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.reviewRounds.min)
      .max(TEAM_LIMITS.reviewRounds.max)
      .optional(),
    parallelAgents: z
      .number()
      .int()
      .min(TEAM_LIMITS.parallelAgents.min)
      .max(TEAM_LIMITS.parallelAgents.max)
      .optional(),
    // No verifyCommands here: ThreadLink runs them itself, outside any agent
    // sandbox, so only the project's owner sets them (in the room policy).
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
  })
  .strict();

export const teamLogPageSchema = z.object({
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Rows returned by the database, and their view shapes
// ---------------------------------------------------------------------------
const count = z.coerce.number().int().min(0);

export const roomRowSchema = z.object({
  room_id: roomIdSchema,
  name: z.string(),
  status: z.enum(ROOM_STATUSES),
  workspace_id: z.string(),
  workspace_name: z.string().nullable(),
  agent_session_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  policy: z.object({
    parallel_agents: z.number(),
    max_planning_rounds: z.number(),
    max_review_rounds: z.number(),
    usage_policy: z.enum(USAGE_POLICIES),
    cross_review: z.boolean(),
    final_inspection: z.boolean(),
    worktree_isolation: z.boolean(),
    verify_commands: z.array(z.string()),
  }),
  agents: z.array(
    z.object({
      provider: z.enum(AGENT_PROVIDERS),
      name: z.string(),
      roles: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
  open_jobs: count,
  created_at: z.string(),
  updated_at: z.string(),
  created: z.boolean().optional(),
  recent_jobs: z
    .array(
      z.object({
        job_id: jobIdSchema,
        goal: z.string(),
        status: z.enum(JOB_STATUSES),
        verdict: z.enum(JOB_VERDICTS).nullable(),
        started_here: z.boolean(),
        created_at: z.string(),
      }),
    )
    .optional(),
});
export type RoomRow = z.infer<typeof roomRowSchema>;

export type RoomView = {
  roomId: string;
  name: string;
  status: RoomStatus;
  workspace: string | null;
  agent: string | null;
  policy: {
    parallelAgents: number;
    maxPlanningRounds: number;
    maxReviewRounds: number;
    usagePolicy: UsagePolicy;
    crossReview: boolean;
    finalInspection: boolean;
    worktreeIsolation: boolean;
    verifyCommands: string[];
  };
  agents: { provider: AgentProvider; name: string; roles: string[]; enabled: boolean }[];
  openJobs: number;
  createdAt: string;
  updatedAt: string;
};

export function toRoomView(r: RoomRow): RoomView {
  return {
    roomId: r.room_id,
    name: r.name,
    status: r.status,
    workspace: r.workspace_name,
    agent: r.agent_name,
    policy: {
      parallelAgents: r.policy.parallel_agents,
      maxPlanningRounds: r.policy.max_planning_rounds,
      maxReviewRounds: r.policy.max_review_rounds,
      usagePolicy: r.policy.usage_policy,
      crossReview: r.policy.cross_review,
      finalInspection: r.policy.final_inspection,
      worktreeIsolation: r.policy.worktree_isolation,
      verifyCommands: r.policy.verify_commands,
    },
    agents: r.agents,
    openJobs: r.open_jobs,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const teamStatusRowSchema = z.object({
  job_id: jobIdSchema,
  room_id: roomIdSchema,
  room_name: z.string(),
  task_id: z.string(),
  task_status: z.string(),
  status: z.enum(JOB_STATUSES),
  verdict: z.enum(JOB_VERDICTS).nullable(),
  line: z.string().nullable(),
  summary: z.string().nullable(),
  goal: z.string(),
  rounds: z.object({
    planning: z.object({ n: z.number(), max: z.number() }),
    review: z.object({ n: z.number(), max: z.number() }),
  }),
  parallel_agents: z.number(),
  plan_hash: z.string().nullable(),
  // Always a boolean from the database now; an older row's null means "no".
  plan_approved: z
    .boolean()
    .nullable()
    .transform((v) => v ?? false),
  nodes_total: count,
  nodes: z.array(
    z.object({
      key: z.string(),
      owner: z.enum(AGENT_PROVIDERS),
      reviewer: z.enum(AGENT_PROVIDERS).nullable(),
      status: z.enum(NODE_STATUSES),
    }),
  ),
  open_findings: z.object({ blocking: count, important: count, non_blocking: count }),
  decisions_needing_user: count,
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
  created: z.boolean().optional(),
});
export type TeamStatusRow = z.infer<typeof teamStatusRowSchema>;

export type TeamStatus = {
  jobId: string;
  roomId: string;
  roomName: string;
  taskId: string;
  taskStatus: string;
  status: JobStatus;
  verdict: JobVerdict | null;
  line: string | null;
  summary: string | null;
  goal: string;
  rounds: { planning: { n: number; max: number }; review: { n: number; max: number } };
  parallelAgents: number;
  planHash: string | null;
  planApproved: boolean;
  nodesTotal: number;
  nodes: {
    key: string;
    owner: AgentProvider;
    reviewer: AgentProvider | null;
    status: NodeStatus;
  }[];
  openFindings: { blocking: number; important: number; nonBlocking: number };
  decisionsNeedingUser: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export function toTeamStatus(r: TeamStatusRow): TeamStatus {
  return {
    jobId: r.job_id,
    roomId: r.room_id,
    roomName: r.room_name,
    taskId: r.task_id,
    taskStatus: r.task_status,
    status: r.status,
    verdict: r.verdict,
    line: r.line,
    summary: r.summary,
    goal: r.goal,
    rounds: r.rounds,
    parallelAgents: r.parallel_agents,
    planHash: r.plan_hash,
    planApproved: r.plan_approved,
    nodesTotal: r.nodes_total,
    nodes: r.nodes,
    openFindings: {
      blocking: r.open_findings.blocking,
      important: r.open_findings.important,
      nonBlocking: r.open_findings.non_blocking,
    },
    decisionsNeedingUser: r.decisions_needing_user,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

/** TL-00042: the human label of a decision number. */
export function decisionLabel(n: number): string {
  return `TL-${String(n).padStart(5, "0")}`;
}

export const teamWriteResultSchema = teamStatusRowSchema.extend({
  op: z.string(),
  result: z.object({
    finding_id: z.string().optional(),
    decision_id: z.string().optional(),
    number: z.number().optional(),
    message_id: z.string().optional(),
    usage_event_id: z.string().optional(),
    plan_hash: z.string().optional(),
    round: z.number().optional(),
    opened: z.boolean().optional(),
  }),
});

export const teamLogRowSchema = teamStatusRowSchema.extend({
  spec_input: z.record(z.string(), z.unknown()).nullable(),
  spec: z.record(z.string(), z.unknown()).nullable(),
  plan: z.record(z.string(), z.unknown()).nullable(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  nodes_detail: z.array(z.record(z.string(), z.unknown())),
  entries: z.array(z.record(z.string(), z.unknown()).and(z.object({ kind: z.string() }))),
  total: count,
  offset: count,
  next_offset: z.number().nullable(),
});
