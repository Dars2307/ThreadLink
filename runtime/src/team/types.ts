/**
 * Team Mode vocabulary, shared by the Runtime, the server and the UI.
 *
 * These lists are the single source of truth for the TypeScript side; the SQL
 * check constraints in the Team Mode migration mirror them exactly. Changing a
 * value here without the migration is a bug that the tests are there to catch.
 * See docs/design/team-mode.md.
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

/** The only final answers a team job can give. There is no score. */
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

/** Only `blocking` and `important` may reopen a round. */
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

/**
 * A routing policy, not a quality ranking. Which model sits in which class is
 * a default the user can override per model.
 */
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

/** "Business", not "Team": the old name is only read when importing a setting. */
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

/** Budgets. Enforced in SQL too: a counter can never pass its budget. */
export const TEAM_LIMITS = {
  planningRounds: { min: 1, max: 5, default: 2 },
  reviewRounds: { min: 1, max: 6, default: 3 },
  parallelAgents: { min: 1, max: 4, default: 2 },
} as const;

/** The defaults a new Team room starts with. */
export const DEFAULT_TEAM_POLICY = {
  parallelAgents: TEAM_LIMITS.parallelAgents.default,
  maxPlanningRounds: TEAM_LIMITS.planningRounds.default,
  maxReviewRounds: TEAM_LIMITS.reviewRounds.default,
  paidUsage: false,
  usagePolicy: "balanced" as UsagePolicy,
  worktreeIsolation: true,
  crossReview: true,
  finalInspection: true,
} as const;

/**
 * Arbitration order, highest first. A disagreement that the evidence settles is
 * recorded as a decision; one that touches product behaviour, architecture,
 * money, security posture or irreversible data goes to the user instead.
 */
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
export type ArbitrationBasis = (typeof ARBITRATION_ORDER)[number];
