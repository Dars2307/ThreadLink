import { z } from "zod";

import { JOB_MODES, type JobMode } from "@/lib/chat/types";

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
  // 0.10: non-terminal waits (a step was interrupted; paused by the owner).
  "interrupted",
  "paused",
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

/**
 * wont_fix is the pre-0.10 name for dismissed (still readable). accepted,
 * disputed and fixed are still open: they block a PASS like open does.
 */
export const FINDING_STATUSES = [
  "open",
  "resolved",
  "wont_fix",
  "accepted",
  "disputed",
  "fixed",
  "dismissed",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
/** The states that still block a PASS (SQL finding_open_states()). */
export const FINDING_OPEN_STATES = ["open", "accepted", "disputed", "fixed"] as const;

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

/** Why a job ended as it did (mirrors runtime/src/team/verdict-reasons.ts and the SQL check). */
export const VERDICT_REASONS = [
  "tests_failed",
  "review_not_passed",
  "agents_disagree",
  "dependency_not_finished",
  "plan_blocked",
  "agent_unavailable",
  "agent_not_in_project",
  "usage_exhausted",
  "model_mismatch",
  "access_mismatch",
  "agent_timed_out",
  "agent_failed",
  "changed_during_review",
  "inspection_found_issues",
  "no_review_or_tests",
  "stopped_by_owner",
  "unexpected_error",
  "merge_conflict",
  "no_suitable_model",
  // 0.9 chat-first
  "agent_needs_sign_in",
  "api_key_auth",
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
  /** 0.10: artifact and diff text (add_artifact, add_change). */
  artifactBytes: 512 * 1024,
  /** HTTP body cap for the runtime write endpoint (largest op + envelope; artifacts are JSON-escaped). */
  writeBodyBytes: 1152 * 1024,
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
/** The model the Runtime OBSERVED on an agent message (chat_events pattern). */
export const OBSERVED_MODEL_PATTERN = /^[A-Za-z0-9._:[\]/-]{1,100}$/;

export { JOB_MODES, type JobMode };
export const JOB_ORIGINS = ["controller", "owner"] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

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

// 0.10 primitives (docs/design/threadlink-0.10.md sections 2-6).
export const runIdSchema = z.string().regex(/^tlarn_[0-9a-f]{32}$/);
export const choiceIdSchema = z.string().regex(/^tlchc_[0-9a-f]{32}$/);
export const artifactIdSchema = z.string().regex(/^tlart_[0-9a-f]{32}$/);
/** A provider id of the registry (public.agent_providers.id). */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
/** "codex:coordinator", "claude-code:reviewer:2". */
export const PARTICIPANT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}:[a-z_]{1,40}(:[0-9]{1,3})?$/;
/** Idempotency keys (run_key, choice request key). Long keys are hashed server-side. */
const wireKey = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "single line");
export const RUN_STATUS_VALUES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;
export const RUN_ACTIVITY_VALUES = [
  "queued",
  "reading",
  "planning",
  "building",
  "reviewing",
  "testing",
  "waiting",
  "responding",
  "integrating",
] as const;
export const RUN_FAILURES = [
  "not_authenticated",
  "quota_exhausted",
  "timeout",
  "model_mismatch",
  "access_mismatch",
  "cancelled",
  "crashed",
  "provider_error",
] as const;
export const CHOICE_KIND_VALUES = [
  "provider_failure",
  "timeout",
  "plan_disagreement",
  "interrupted",
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
] as const;
export const REF_KINDS = ["finding", "decision", "node", "artifact", "message", "choice"] as const;
export const ARTIFACT_KINDS = [
  "report",
  "plan",
  "diff",
  "test_report",
  "notes",
  "export",
  "user_attachment",
] as const;
export const ARTIFACT_MIMES = [
  "text/plain",
  "text/markdown",
  "text/x-diff",
  "application/json",
] as const;
export const JOB_CONTROL_VALUES = [
  "pause_after_step",
  "stop_after_review",
  "stop_before_integration",
  "stop_now",
  "cancel_queued",
  "resume",
] as const;
/**
 * The Runtime's step kinds (runtime StepKind) -> the fixed step words a
 * choice may show (SQL choice_steps()). Anything else is dropped.
 */
export const CHOICE_STEP_WORDS: Record<string, string> = {
  normalise: "understanding the request",
  plan: "planning",
  plan_review: "reviewing the plan",
  build: "building",
  fix: "building",
  review: "reviewing",
  security_review: "security review",
  inspection: "inspection",
  verify: "testing",
  test: "testing",
  integrate: "integrating",
  integration: "integrating",
};
const wireRef = z
  .object({
    kind: z.enum(REF_KINDS),
    id: z.string().min(1).max(64),
  })
  .strict();

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
        /** What the Runtime observed the model to be for this turn (never the requested one). */
        modelObserved: z.string().regex(OBSERVED_MODEL_PATTERN).nullish(),
        /** 0.10: the run that wrote it (required for an agent from protocol 10). */
        runId: runIdSchema.nullish(),
        /**
         * 0.10: what it replies to. A message (chat row tlcev_ / team message
         * tlamg_) becomes the reply; a finding, decision, choice, node or
         * artifact becomes the reference (and a reply to that card).
         */
        replyTo: z.union([wireRef, z.string().min(1).max(64)]).nullish(),
        /** 0.10: what it refers to. The first one is stored. */
        refs: z.array(wireRef).max(20).optional(),
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
        /** 0.10: the raising run (required for an agent from protocol 10). */
        runId: runIdSchema.nullish(),
        /** 0.10: the participant expected to act on it ("claude-code:builder"). */
        ownerParticipant: z.string().regex(PARTICIPANT_KEY_PATTERN).nullish(),
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
        /** 0.10: the run that changed it. */
        runId: runIdSchema.nullish(),
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
        /** 0.10: a fixed ThreadLink title, or the agent's own (then runId). */
        titleSource: z.enum(["threadlink", "agent"]).optional(),
        runId: runIdSchema.nullish(),
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
          "interrupted",
          "paused",
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
        reason: z.enum(VERDICT_REASONS).optional(),
        /** 0.9: the provider the reason is about (a participant of the job). */
        provider: provider.optional(),
        evidence: boundedJson(TEAM_SIZE_LIMITS.evidenceBytes),
      })
      .strict(),
  }),
  z.object({
    // The owner's undelivered notes to this job (claim-gated, delivered once).
    // 0.10: runId = the run that reads them; or {consumedByRunId, noteIds} to
    // record which run consumed notes already delivered.
    op: z.literal("read_owner_notes"),
    payload: z
      .object({
        limit: z.number().int().min(1).max(20).optional(),
        runId: runIdSchema.optional(),
        consumedByRunId: runIdSchema.optional(),
        noteIds: z
          .array(z.string().regex(/^tlcev_[0-9a-f]{32}$/))
          .min(1)
          .max(20)
          .optional(),
      })
      .strict()
      .refine(
        (p) => (p.noteIds === undefined) === (p.consumedByRunId === undefined),
        "noteIds with consumedByRunId",
      )
      .default({}),
  }),
  // ---------------------------------------------------------------- 0.10 ops
  z.object({
    op: z.literal("run_started"),
    payload: z
      .object({
        runKey: wireKey,
        provider: z.string().regex(PROVIDER_ID_PATTERN),
        participantKey: z.string().regex(PARTICIPANT_KEY_PATTERN),
        role: z.enum(TEAM_ROLES),
        requestedModel: z.string().regex(MODEL_ID_PATTERN).nullish(),
        effort: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .nullish(),
        access: z.enum(["read-only", "workspace-write"]).nullish(),
        nodeKey: nodeKeySchema.nullish(),
        worktreeLabel: z.string().min(1).max(120).nullish(),
        timeoutMs: z.number().int().min(1000).max(7_200_000).nullish(),
        continuity: z.enum(["fresh", "resumed", "forked"]).optional(),
        resumedFromRunKey: wireKey.nullish(),
        activity: z.enum(RUN_ACTIVITY_VALUES).optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("run_activity"),
    payload: z.object({ runId: runIdSchema, activity: z.enum(RUN_ACTIVITY_VALUES) }).strict(),
  }),
  z.object({
    op: z.literal("run_finished"),
    payload: z
      .object({
        runId: runIdSchema,
        status: z.enum(["completed", "failed", "cancelled", "timed_out", "interrupted"]),
        observedModel: z.string().regex(MODEL_ID_PATTERN).nullish(),
        modelVerified: z.boolean().optional(),
        accessVerified: z.boolean().optional(),
        nativeSessionId: z
          .string()
          // Starts alphanumeric; a claude_session id must be a UUID (checked by the database).
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
          .nullish(),
        nativeSessionKind: z.enum(["claude_session", "codex_thread", "other"]).nullish(),
        failure: z.enum(RUN_FAILURES).nullish(),
        exitClean: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("request_choice"),
    payload: z
      .object({
        kind: z.enum(CHOICE_KIND_VALUES),
        /** Idempotency (the Runtime's own key). `requestKey` is accepted as an alias. */
        idempotencyKey: wireKey.optional(),
        requestKey: wireKey.optional(),
        runId: runIdSchema.nullish(),
        /** Trusted runtime state only; the server builds the title and labels. */
        params: z
          .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.null()]))
          .refine((v) => Object.keys(v).length <= 20, "too many params")
          .optional(),
        /** A subset of the kind's allow-list, as keys or {key}. */
        options: z
          .array(z.union([z.string().max(40), z.object({ key: z.string().max(40) }).strict()]))
          .min(1)
          .max(6)
          .optional(),
      })
      .strict()
      .refine(
        (p) => p.idempotencyKey !== undefined || p.requestKey !== undefined,
        "idempotencyKey required",
      ),
  }),
  z.object({
    op: z.literal("read_choices"),
    payload: z
      .object({ choiceIds: z.array(choiceIdSchema).max(20).optional() })
      .strict()
      .default({}),
  }),
  z.object({
    op: z.literal("add_change"),
    payload: z
      .object({
        nodeKey: nodeKeySchema.nullish(),
        runId: runIdSchema,
        filesChanged: z.number().int().min(0).max(100_000),
        insertions: z.number().int().min(0).max(100_000_000),
        deletions: z.number().int().min(0).max(100_000_000),
        files: z.array(z.string().min(1).max(512)).max(200).optional(),
        branch: z
          .string()
          .regex(/^[A-Za-z0-9._/+-]{1,200}$/)
          .nullish(),
        commit: z
          .string()
          .regex(/^[0-9a-f]{7,64}$/)
          .nullish(),
        tests: z
          .array(z.object({ command: oneLine(300), ok: z.boolean() }).strict())
          .max(20)
          .optional(),
        /** Optional diff text: stored as a redacted diff artifact. */
        diff: z
          .string()
          .refine((v) => byteLength(v) <= TEAM_SIZE_LIMITS.artifactBytes, "diff too large")
          .optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("add_artifact"),
    payload: z
      .object({
        kind: z.enum(["report", "plan", "diff", "test_report", "notes", "export"]),
        title: oneLine(200),
        mime: z.enum(ARTIFACT_MIMES),
        content: z
          .string()
          .refine((v) => v.trim().length > 0, "must not be blank")
          .refine((v) => byteLength(v) <= TEAM_SIZE_LIMITS.artifactBytes, "content too large"),
        runId: runIdSchema.nullish(),
        nodeKey: nodeKeySchema.nullish(),
        requestKey: wireKey.optional(),
      })
      .strict(),
  }),
  z.object({
    op: z.literal("ack_control"),
    payload: z.object({ control: z.enum(JOB_CONTROL_VALUES) }).strict(),
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
    case "add_message": {
      const p = input.payload;
      const reply = p.replyTo ?? undefined;
      const replyIsMessage =
        typeof reply === "string" || (reply !== undefined && reply.kind === "message");
      const replyId = typeof reply === "string" ? reply : reply?.id;
      const ref = !replyIsMessage && reply && typeof reply !== "string" ? reply : p.refs?.[0];
      return compact({
        node_key: p.node ?? undefined,
        sender: p.sender,
        sender_role: p.senderRole,
        receiver: p.receiver ?? undefined,
        type: p.type,
        round: p.round,
        body: p.body,
        model_observed: p.modelObserved ?? undefined,
        run_id: p.runId ?? undefined,
        reply_to: replyIsMessage ? replyId : undefined,
        ref_kind: ref?.kind,
        ref_id: ref?.id,
      });
    }
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
        run_id: p.runId ?? undefined,
        owner_participant: p.ownerParticipant ?? undefined,
        // 0.10: the structured file:line (line 0 means "no line").
        file_path: p.file ?? undefined,
        line: p.file && p.line ? p.line : undefined,
      });
    }
    case "set_finding_status":
      return compact({
        finding_id: input.payload.findingId,
        status: input.payload.status,
        round: input.payload.round,
        resolution: input.payload.resolution,
        decision_number: input.payload.decisionNumber,
        run_id: input.payload.runId ?? undefined,
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
        title_source: input.payload.titleSource,
        run_id: input.payload.runId ?? undefined,
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
        reason: input.payload.reason,
        provider: input.payload.provider,
        evidence: input.payload.evidence,
      });
    case "read_owner_notes":
      return compact({
        limit: input.payload.limit,
        run_id: input.payload.consumedByRunId ?? input.payload.runId,
        note_ids: input.payload.noteIds,
      });
    case "run_started": {
      const p = input.payload;
      return compact({
        run_key: wireKeyToSql(p.runKey),
        provider: p.provider,
        participant_key: p.participantKey,
        role: p.role,
        requested_model: p.requestedModel ?? undefined,
        effort: p.effort ?? undefined,
        access: p.access ?? undefined,
        node_key: p.nodeKey ?? undefined,
        worktree_label: p.worktreeLabel ?? undefined,
        timeout_ms: p.timeoutMs ?? undefined,
        continuity: p.continuity,
        resumed_from_run_key: p.resumedFromRunKey ? wireKeyToSql(p.resumedFromRunKey) : undefined,
        activity: p.activity,
      });
    }
    case "run_activity":
      return { run_id: input.payload.runId, activity: input.payload.activity };
    case "run_finished": {
      const p = input.payload;
      return compact({
        run_id: p.runId,
        status: p.status,
        observed_model: p.observedModel ?? undefined,
        model_verified: p.modelVerified,
        access_verified: p.accessVerified,
        native_session_id: p.nativeSessionId ?? undefined,
        native_session_kind: p.nativeSessionId ? (p.nativeSessionKind ?? undefined) : undefined,
        failure: p.failure ?? undefined,
        exit_clean: p.exitClean,
      });
    }
    case "request_choice": {
      const p = input.payload;
      const params = p.params ?? {};
      const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
      // plan_disagreement names the planner and the reviewer.
      const who = str(params.provider) ?? str(params.planner);
      const other = str(params.otherProvider) ?? str(params.reviewer);
      const step = str(params.step);
      const minutes = params.minutes;
      return compact({
        request_key: wireKeyToSql((p.idempotencyKey ?? p.requestKey)!),
        kind: p.kind,
        run_id: p.runId ?? undefined,
        provider: who,
        other_provider: other,
        step: step ? (CHOICE_STEP_WORDS[step] ?? undefined) : undefined,
        minutes:
          typeof minutes === "number" &&
          Number.isInteger(minutes) &&
          minutes >= 1 &&
          minutes <= 1440
            ? minutes
            : undefined,
        node_key: str(params.unit) ?? str(params.nodeKey),
        options: p.options?.map((o) => (typeof o === "string" ? o : o.key)),
      });
    }
    case "read_choices":
      return compact({ choice_ids: input.payload.choiceIds });
    case "add_change": {
      const p = input.payload;
      return compact({
        node_key: p.nodeKey ?? undefined,
        run_id: p.runId,
        files_changed: p.filesChanged,
        insertions: p.insertions,
        deletions: p.deletions,
        files: p.files,
        branch: p.branch ?? undefined,
        commit: p.commit ?? undefined,
        tests: p.tests,
        diff: p.diff,
      });
    }
    case "add_artifact": {
      const p = input.payload;
      return compact({
        request_key: p.requestKey ? wireKeyToSql(p.requestKey) : undefined,
        kind: p.kind,
        title: p.title,
        mime: p.mime,
        content: p.content,
        run_id: p.runId ?? undefined,
        node_key: p.nodeKey ?? undefined,
      });
    }
    case "ack_control":
      return { control: input.payload.control };
  }
}

/** SHA-256 of bytes, as lowercase hex (pure, so this module stays browser-safe). */
export function sha256Hex(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * A Runtime idempotency key as the database stores it ([A-Za-z0-9._:-], at
 * most 128). Any other key becomes "k:" + the first 32 hex characters of its
 * SHA-256 (the same rule as runtime/src/team/wire.ts wireKey, so a key the
 * Runtime already shortened is kept, and a raw one maps to the same value).
 */
export function wireKeyToSql(key: string): string {
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return key;
  return `k:${sha256Hex(encoder.encode(key)).slice(0, 32)}`;
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
    /** solo: one builder; pair: builder + the other provider reviewing; team: Team Mode. */
    mode: z.enum(JOB_MODES).optional(),
    /** Who builds, for solo/pair. Ignored for team. */
    builder: z.enum(AGENT_PROVIDERS).optional(),
    /** 0.9: the chat this work belongs to (same account and project); default = the project's default chat. */
    chatId: z
      .string()
      .regex(/^tlcht_[0-9a-f]{32}$/)
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
  // Optional so a row from before collaboration chat still parses (as Team Mode).
  mode: z.enum(JOB_MODES).optional(),
  builder: z.enum(AGENT_PROVIDERS).nullable().optional(),
  origin: z.enum(JOB_ORIGINS).optional(),
  stop_requested_at: z.string().nullable().optional(),
  // 0.9 chat-first (optional: older rows parse).
  chat_id: z.string().nullable().optional(),
  last_phase: z.enum(JOB_STATUSES).nullable().optional(),
  role_overrides: z.record(z.string(), z.string()).nullable().optional(),
  verdict_reason: z.string().nullable().optional(),
  verdict_provider: z.enum(AGENT_PROVIDERS).nullable().optional(),
  retried_from_job_id: z.string().nullable().optional(),
  // 0.10 (optional: older rows parse).
  control: z.enum(JOB_CONTROL_VALUES).nullable().optional(),
  control_requested_at: z.string().nullable().optional(),
  pending_choices: count.optional(),
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
  mode: JobMode;
  /** Solo/pair builder; null for Team Mode. */
  builder: AgentProvider | null;
  origin: JobOrigin;
  /** Set when the owner said "@team stop": finish the current round, then stop. */
  stopRequestedAt: string | null;
  /** 0.9: the chat this job belongs to. */
  chatId?: string | null;
  /** 0.9: the last non-terminal status reached (null: unknown). */
  lastPhase?: JobStatus | null;
  /** 0.9: roles pinned for this job (e.g. {coordinator: "codex"} on a retry). */
  roleOverrides?: Record<string, string> | null;
  verdictReason?: string | null;
  verdictProvider?: AgentProvider | null;
  retriedFromJobId?: string | null;
  /** 0.10: the owner's latest control (honour at its boundary, then ack_control). */
  control?: (typeof JOB_CONTROL_VALUES)[number] | null;
  controlRequestedAt?: string | null;
  /** 0.10: choices waiting for the owner. */
  pendingChoices?: number;
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
    mode: r.mode ?? "team",
    builder: r.builder ?? null,
    origin: r.origin ?? "controller",
    stopRequestedAt: r.stop_requested_at ?? null,
    // 0.9 fields only when the database sent them (an older row stays as it was).
    ...(r.chat_id !== undefined ? { chatId: r.chat_id } : {}),
    ...(r.last_phase !== undefined ? { lastPhase: r.last_phase } : {}),
    ...(r.role_overrides !== undefined ? { roleOverrides: r.role_overrides } : {}),
    ...(r.verdict_reason !== undefined ? { verdictReason: r.verdict_reason } : {}),
    ...(r.verdict_provider !== undefined ? { verdictProvider: r.verdict_provider } : {}),
    ...(r.retried_from_job_id !== undefined ? { retriedFromJobId: r.retried_from_job_id } : {}),
    ...(r.control !== undefined ? { control: r.control } : {}),
    ...(r.control_requested_at !== undefined ? { controlRequestedAt: r.control_requested_at } : {}),
    ...(r.pending_choices !== undefined ? { pendingChoices: r.pending_choices } : {}),
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
    notes: z
      .array(
        z.object({
          id: z.string(),
          seq: z.number(),
          // 0.10: the registry decides (a provider id or "team").
          audience: z.string().regex(/^(team|[a-z][a-z0-9-]{1,39})$/),
          body: z.string(),
          created_at: z.string(),
          chat_seq: z.number().nullable().optional(),
          consumed_by_run_id: z.string().nullable().optional(),
        }),
      )
      .optional(),
    // 0.10
    consumed: z.number().optional(),
    event_id: z.string().nullable().optional(),
    run_id: z.string().optional(),
    created: z.boolean().optional(),
    status: z.string().optional(),
    updated: z.boolean().optional(),
    throttled: z.boolean().optional(),
    finished: z.boolean().optional(),
    verified: z.boolean().optional(),
    choice_id: z.string().optional(),
    choices: z
      .array(
        z.object({
          choice_id: z.string(),
          kind: z.string(),
          status: z.enum(["pending", "chosen", "expired", "cancelled"]),
          chosen_key: z.string().nullable(),
          decided_at: z.string().nullable(),
          expires_at: z.string(),
          request_key: z.string().nullable(),
        }),
      )
      .optional(),
    artifact_id: z.string().nullable().optional(),
    cleared: z.boolean().optional(),
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
