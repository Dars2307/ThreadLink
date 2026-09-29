/**
 * Team Mode orchestrator.
 *
 * Takes one team job from goal to verdict: normalise the goal, plan it with a
 * bounded review, commit ownership, build units of work in parallel in their
 * own worktrees, have the other agent review each one, fix within a bounded
 * number of rounds, integrate in a deterministic order, run the owner's tests
 * itself, and finish with an independent inspection.
 *
 * The rules that make it trustworthy are enforced here, in code, rather than
 * asked of the models:
 *
 *   - Every loop has a budget, and an exhausted budget is reported as such.
 *     A PASS is never manufactured.
 *   - The reviewer of a unit of work is never the provider that wrote it, and
 *     the final inspector is never the provider that integrated.
 *   - A provider that fails, runs out of usage, or runs a model or sandbox
 *     other than the one asked for is never quietly replaced by another.
 *   - An APPROVED review with a blocking or important finding is not approved.
 *   - Tests are run by ThreadLink, not taken on an agent's word, and only the
 *     owner's commands are run.
 *
 * Solo and Builder + Reviewer jobs (job.mode) skip the planning council and the
 * final inspection but keep every other rule: one unit of work, the builder in
 * its worktree, the other provider reviewing in a pair, ThreadLink's own tests.
 * Owner notes reach each agent's next prompt, delimited; an owner's stop
 * request ends the job at the next round boundary.
 *
 * 0.10 (docs/design/threadlink-0.10.md): every agent execution is a recorded
 * run (run_started / run_activity / run_finished) with its provenance; every
 * agent chat message is that run's own `teamMessage`, never text ThreadLink
 * composes for it, and replies point at what they answer. Findings move
 * through open / fixed / disputed / resolved / dismissed; a provider failure
 * or timeout becomes the owner's choice instead of a substitution; owner
 * controls are honoured at their boundary; a job journal lets a crashed
 * Runtime tell a finished job from an interrupted one. Provider differences
 * come from the capability registry (capabilities.ts), never from a switch on
 * a provider id here.
 *
 * Everything it depends on is injected, so each rule can be tested directly.
 */

import type { VerdictReason } from "./verdict-reasons.ts";
import { createHash } from "node:crypto";

import {
  ActivityReporter,
  phaseActivity,
  WRITE_STEPS,
  type ActivityClock,
  type RunActivity,
  type StepKind,
} from "./activity.ts";
import { capabilitiesOf, type ProviderCapabilities } from "./capabilities.ts";
import type { ProviderHealth } from "./health.ts";
import type { JobJournal, ProcessRegistry } from "./registry.ts";
import { finalReportMarkdown, type ReportFinding } from "./report.ts";
import type { ProcessHooks, ProcessTimings } from "./runner.ts";
import { increasedTimeoutMs, stepTimeoutMs } from "./timeouts.ts";
import {
  assignRoles,
  PROVIDER_NAME,
  rolesDecisionText,
  type RoleAssignment,
  type RoleCandidate,
} from "./roles.ts";
import { deriveStages, type TeamStage } from "./stages.ts";
import { handleExhausted, type FailoverAction } from "./failover.ts";

import { redactText, summarize } from "../summary.ts";
import type { TeamJobDefinition } from "./job.ts";
import {
  BUILD_SCHEMA,
  INSPECTION_SCHEMA,
  SPEC_SCHEMA,
  buildPrompt,
  codeReviewPrompt,
  effectiveVerdict,
  inspectionPrompt,
  isSubstantive,
  normalisePrompt,
  OWNER_DISAGREEMENTS,
  planPrompt,
  planReviewPrompt,
  planSchema,
  reviewSchema,
  teamMessageOf,
  withOwnerNotes,
  type BuildReport,
  type Finding,
  type Inspection,
  type Plan,
  type PlannedNode,
  type PromptContext,
  type RefFinding,
  type Review,
  type TeamSpec,
} from "./prompts.ts";
import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type JobMode,
  type JobVerdict,
  type ModelClass,
  type NodeStatus,
  type TeamRole,
} from "./types.ts";
import {
  ackControlPayload,
  artifactPayload,
  changePayload,
  decisionPayload,
  findingPayload,
  findingStatusPayload,
  messagePayload,
  notesConsumedPayload,
  OPS_0_10,
  type OPS_0_11,
  parseChoiceId,
  parseChoices,
  parseControl,
  parseDecisionNumber,
  parseFindingId,
  parseMessageId,
  parseOwnerNotes,
  parseRunId,
  READ_OWNER_NOTES_OP,
  readChoicesPayload,
  requestChoicePayload,
  runActivityPayload,
  runFinishedPayload,
  runStartedPayload,
  isInterruptedRefusal,
  setFinalPayload,
  threadlinkDecisionTitle,
  type FindingLifecycle,
  type JobControl,
  type OwnerNote,
  type RunEndStatus,
  type RunFailureCategory,
  type RunTimings,
  type WireRef,
} from "./wire.ts";
import type { WorktreeManager, WorktreeRecord } from "./worktrees.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The subset of the agent runner contract (design §3.1) the orchestrator uses. */
export type RunAccess = "read-only" | "workspace-write";

export type AgentRunRequest = {
  provider: AgentProvider;
  role: TeamRole;
  cwd: string;
  prompt: string;
  model: string;
  effort?: string;
  access: RunAccess;
  outputSchema?: object;
  resumeThreadId?: string;
  /** 0.11: "chat" for a Fast Chat turn (runner.ts). */
  purpose?: "team" | "chat";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Real activity signals (activity.ts). Runners without an event stream never call it. */
  onActivity?: (activity: RunActivity) => void;
  /** The process this run started (process registry). */
  onProcess?: ProcessHooks;
};

export type AgentRunResult = {
  ok: boolean;
  text: string;
  structured?: unknown;
  threadId: string | null;
  requestedModel: string;
  observedModel: string | null;
  observedEffort: string | null;
  accessVerified: boolean;
  /** Set by the runner only after its own observed-vs-requested model check passed. */
  modelVerified?: boolean;
  permissionDenials: number;
  error?: string;
  failure?:
    | "model_mismatch"
    | "access_mismatch"
    | "quota_exhausted"
    | "not_authenticated"
    | "not_installed"
    | "timeout"
    | "cancelled"
    | "provider_error";
  /** 0.11 (§5): the reset time a quota failure's own output stated (ISO), else null. */
  resetsAt?: string | null;
  /** 0.11 (§3.6): measured around the provider process. */
  timings?: ProcessTimings;
};

export type AgentRunner = {
  readonly provider: AgentProvider;
  /**
   * True when the provider reports the sandbox it actually ran in (Codex's
   * rollout does; Claude Code's output does not). A runner that can prove it
   * must; one that cannot is held to the checks ThreadLink can make itself.
   */
  readonly verifiesAccess?: boolean;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
};

export type RouteRequest = {
  provider: AgentProvider;
  role: TeamRole;
  complexity: PlannedNode["complexity"];
  risk: PlannedNode["risk"];
  previousFailures: number;
  disputedFindings: number;
};

export type RouteResult =
  | {
      ok: true;
      model: string;
      effort: string | null;
      modelClass: ModelClass;
      reason: string;
      escalatedFrom?: ModelClass;
      escalationReason?: string;
    }
  | { ok: false; reason: string; options: string[] };

export type GraphNode = { key: string; dependsOn: string[]; files: string[]; readOnly?: boolean };

export type GraphPort = {
  /** Throws with a readable message if the graph is not a valid DAG. */
  validate(nodes: GraphNode[]): void;
  /** Keys to start now, respecting dependencies, overlap and the parallel limit. */
  schedule(
    nodes: GraphNode[],
    statuses: Record<string, NodeStatus>,
    parallelLimit: number,
  ): string[];
  /** Deterministic merge order. */
  integrationOrder(nodes: GraphNode[]): string[];
  /** Changed files that fall outside a unit's agreed scope. */
  outOfScope(files: string[], scope: string[]): string[];
  /** Serialisations added because units touch the same files, for the log. */
  serialisations(nodes: GraphNode[]): { before: string; after: string; reason: string }[];
};

export type VerifyResult = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
};

/**
 * Writes one piece of state for the job and returns the server's answer.
 * Throws on failure, and the job stops: state the owner cannot see is state
 * the team must not act on.
 */
export type StateSink = (
  op: TeamOp,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | void>;

export type TeamOp =
  | "set_status"
  | "set_spec"
  | "set_plan"
  | "upsert_nodes"
  | "set_node_status"
  | "add_message"
  | "add_finding"
  | "set_finding_status"
  | "add_decision"
  | "open_round"
  | "record_usage"
  | "set_final"
  /** Collects the owner's undelivered notes; the server marks them delivered. */
  | typeof READ_OWNER_NOTES_OP
  // 0.10 (wire.ts OPS_0_10)
  | (typeof OPS_0_10)[keyof typeof OPS_0_10]
  // 0.11 (wire.ts OPS_0_11)
  | (typeof OPS_0_11)[keyof typeof OPS_0_11];

/**
 * Provider health, as the Runtime last observed it with a real authenticated
 * call (health.ts). The orchestrator asks before any agent runs and tells it
 * about every failed run.
 */
export type HealthPort = {
  /** Each provider's health, re-checked first if the cached result is stale. */
  ensure(providers: AgentProvider[]): Promise<Partial<Record<AgentProvider, ProviderHealth>>>;
  /** A run failed; an auth or usage failure changes the provider's health at once. */
  noteFailure?(
    provider: AgentProvider,
    failure: NonNullable<AgentRunResult["failure"]>,
    details?: { resetsAt?: string | null },
  ): void;
  /** Probes one provider now (after a sign-in failure) and returns what it found. */
  confirm?(provider: AgentProvider): Promise<ProviderHealth>;
  /** Failed runs per provider recently, for role assignment. */
  recentFailures?(): Partial<Record<AgentProvider, number>>;
  /** 0.11: the reset time an exhausted provider stated, when it did (never estimated). */
  resetsAt?(provider: AgentProvider): string | null;
};

export type OrchestratorDeps = {
  runners: Partial<Record<AgentProvider, AgentRunner>>;
  /** Absent: a provider with a runner counts as ready, one without as not installed. */
  health?: HealthPort;
  /** The classes of the selectable models each provider has here, for role assignment. */
  modelClasses?: Partial<Record<AgentProvider, ModelClass[]>>;
  route(request: RouteRequest): RouteResult;
  graph: GraphPort;
  worktrees: WorktreeManager;
  verify(
    cwd: string,
    commands: string[],
    options?: { timeoutMs?: number },
  ): Promise<VerifyResult[]>;
  sink: StateSink;
  /** Called whenever the concise state changes, for the desktop app's feed. */
  onProgress?(progress: TeamProgress): void;
  /** A provider ran out of included usage; remembered so the next job does not retry it. */
  onExhausted?(provider: AgentProvider, model: string, resetsAt?: string | null): void;
  /** 0.11: a fresh check said an exhausted provider is ready again. */
  onRecovered?(provider: AgentProvider): void;
  /** 0.11 (§3.6): job created → claimed, sent with every run's timings. */
  queueMs?: number | null;
  /** 0.11 (§5): failover notices already sent by this Runtime (one per chat per exhaustion). */
  noticesSent?: Set<string>;
  signal?: AbortSignal;
  /** Overrides every step's timeout (tests). Otherwise: per step kind, timeouts.ts. */
  timeoutMs?: number;
  /** The provider capability registry (capabilities.ts). Injectable for tests. */
  capabilities?: (provider: AgentProvider) => ProviderCapabilities | null;
  /** Crash-recovery journal for this job (registry.ts). */
  journal?: JobJournal;
  /** The processes this Runtime started (registry.ts); stop_now kills only these. */
  processes?: ProcessRegistry;
  /** Clock for waiting on the owner (choices, pause). */
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
  /** How often to ask whether the owner decided (default 15 s). */
  choicePollMs?: number;
  /** How long to wait for a decision before the job ends NEEDS_FIX (default 24 h). */
  choiceWaitMs?: number;
  /** How often a running step asks for the owner's control (default 15 s; 0 = never). */
  controlPollMs?: number;
  /** Activity rate limiting (tests). */
  activityClock?: ActivityClock;
  activityMinIntervalMs?: number;
  /**
   * Which start of this job this is on this computer (crash recovery). Worktree
   * branches and run keys carry it, so a restarted job never collides with, or
   * is mistaken for, the runs of the one before.
   */
  attempt?: number;
};

export type TeamProgress = {
  jobId: string;
  /** The room's friendly name, e.g. "Prism". */
  room: string;
  /** One safe line about the goal, for the card title. */
  goal: string;
  status: string;
  /** Set once the job has finished. */
  verdict: JobVerdict | null;
  line: string;
  /** Each unit of work: who owns it, who reviews it (null in a solo job), where it stands. */
  units: {
    title: string;
    owner: AgentProvider;
    reviewer: AgentProvider | null;
    status: NodeStatus;
  }[];
  agents: { provider: AgentProvider; doing: string }[];
  openFindings: number;
  reviewRound: number;
  maxReviewRounds: number;
  /**
   * The honest stage list (docs/design/chat-first.md §3), derived from what
   * really happened: Plan is done only once a plan was persisted and approved.
   */
  stages: TeamStage[];
};

export type { TeamStage } from "./stages.ts";

export type TeamOutcome = {
  verdict: JobVerdict;
  summary: string;
  /** Why it is not a PASS, as a fixed code. Absent for PASS. */
  reason?: VerdictReason;
  evidence: Evidence;
  /** Who built and reviewed each unit, for the controller's concise report. */
  units: UnitSummary[];
};

export type UnitSummary = {
  key: string;
  title: string;
  owner: AgentProvider;
  /** Null in a solo job: nobody but ThreadLink's own tests checks the work. */
  reviewer: AgentProvider | null;
  status: NodeStatus;
  authoredBy: AgentProvider[];
  reviewedBy: AgentProvider[];
};

export type Evidence = {
  base: string;
  baseExcludedUncommittedChanges: boolean;
  planHash: string | null;
  integrationBranch: string | null;
  diffFingerprint: string | null;
  commits: string[];
  tests: VerifyResult[];
  uncertainty: string[];
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** A finding this job raised, with ThreadLink's reference for it and where it stands. */
type TrackedFinding = {
  /** "F1", "F2", ...: how agents refer to it. */
  ref: string;
  /** The server's id, when it gave one. */
  id: string | null;
  finding: Finding;
  status: FindingLifecycle;
  unit: string | null;
  raisedBy: AgentProvider | "threadlink";
};

type NodeState = {
  plan: PlannedNode;
  owner: AgentProvider;
  /** Never the owner. Null only in a solo job, which has no reviewer. */
  reviewer: AgentProvider | null;
  status: NodeStatus;
  worktree: WorktreeRecord | null;
  failures: number;
  authoredBy: Set<AgentProvider>;
  reviewedBy: Set<AgentProvider>;
  commits: string[];
  /** Substantive findings still standing against this unit (open, fixed-but-unconfirmed, disputed). */
  openFindings: TrackedFinding[];
  /**
   * The owner answered findings by changing nothing: it disagrees with them.
   * If the budget runs out that way, the two agents disagree, and that is a
   * decision for the owner of the project, not a routine "needs fix".
   */
  disputed: boolean;
};

/** One agent run as the orchestrator knows it once it has finished. */
type CallResult = AgentRunResult & {
  structured: unknown;
  /** Who actually ran it (the owner may have chosen another agent after a failure). */
  provider: AgentProvider;
  role: TeamRole;
  participantKey: string;
  /** The server's run id, when it gave one. */
  runId: string | null;
};

type CallOptions = {
  step: StepKind;
  /** The unit of work, when the step is about one. */
  unit: string | null;
  round: number;
  cwd: string;
  /** The worktree the run happens in, so its effect can be checked. */
  worktree?: WorktreeRecord;
  /** Built per provider: after a failure the owner may choose another agent. */
  prompt: (provider: AgentProvider) => string;
  access: RunAccess;
  outputSchema: object;
  /**
   * Continuity (§2): runs sharing a session key may resume the same
   * participant's native session. Absent: always a fresh session.
   */
  session?: string;
  /** Agents that may not take this step if the owner asks for another one. */
  exclude?: AgentProvider[];
  route: {
    complexity: PlannedNode["complexity"];
    risk: PlannedNode["risk"];
    previousFailures?: number;
    disputedFindings?: number;
  };
};

/** A logged chat message, for scoped context. */
type LoggedMessage = {
  id: string | null;
  from: AgentProvider;
  role: TeamRole;
  type: string;
  body: string;
  unit: string | null;
};

/**
 * The server refused to start a write step because an earlier attempt of
 * this job ran one and the owner has not answered yet (§6). The executor
 * turns it into the owner's `interrupted` choice; it is never a verdict.
 */
export class InterruptedRefusal extends Error {
  readonly step: StepKind;
  readonly provider: AgentProvider;
  constructor(step: StepKind, provider: AgentProvider) {
    super("The server is waiting for the owner to resume an interrupted job.");
    this.name = "InterruptedRefusal";
    this.step = step;
    this.provider = provider;
  }
}

/**
 * 0.11 (§5): an independent review could not happen because its reviewer ran
 * out of included usage and nobody else may review this work. The work goes
 * on; the job can then finish REVIEW_PENDING, never PASS.
 */
class ReviewSkipped extends Error {
  readonly provider: AgentProvider;
  constructor(provider: AgentProvider) {
    super("The independent review is waiting for the reviewer's usage to reset.");
    this.name = "ReviewSkipped";
    this.provider = provider;
  }
}

/** §3.5: minor disagreements settle after at most this many planning exchanges. */
export const PLAN_NEGOTIATION_EXCHANGES = 2;

/** A run that must stop the whole job, with the verdict it earns. */
class Stop extends Error {
  readonly verdict: JobVerdict;
  /** A fixed code the chat turns into a fixed sentence (never agent text). */
  readonly reason: VerdictReason;
  /** The agent this verdict is about, when there is one (set_final `provider`). */
  readonly provider: AgentProvider | null;
  constructor(
    verdict: JobVerdict,
    message: string,
    reason: VerdictReason,
    provider: AgentProvider | null = null,
  ) {
    super(message);
    this.name = "Stop";
    this.verdict = verdict;
    this.reason = reason;
    this.provider = provider;
  }
}

/** Why a provider that is not ready stops a job before any agent runs. */
function healthStop(provider: AgentProvider, health: ProviderHealth): Stop {
  const name = providerName(provider);
  switch (health) {
    case "needs_sign_in":
      return new Stop(
        "BLOCKED",
        `${name} needs you to sign in again on this computer.`,
        "agent_needs_sign_in",
        provider,
      );
    case "api_key_auth":
      return new Stop(
        "BLOCKED",
        `${name} is signed in with an API key, which would bill per use, so ThreadLink did not use it. Sign in with your subscription instead.`,
        "api_key_auth",
        provider,
      );
    case "usage_exhausted":
      return new Stop(
        "BLOCKED",
        `${name} has reached its usage limit. ThreadLink did not switch to another agent.`,
        "usage_exhausted",
        provider,
      );
    case "not_installed":
      return new Stop(
        "BLOCKED",
        `${name} is not available on this computer. ThreadLink will not substitute another agent for it.`,
        "agent_unavailable",
        provider,
      );
    default:
      return new Stop(
        "BLOCKED",
        `${name} could not be checked on this computer, so ThreadLink did not start the work. Try again in a moment.`,
        "agent_unavailable",
        provider,
      );
  }
}

/** A provider's name for people: the registry's display name, never a guess. */
function providerName(provider: string): string {
  return (
    (PROVIDER_NAME as Record<string, string>)[provider] ??
    capabilitiesOf(provider)?.displayName ??
    provider
  );
}

const NO_RISK = { security: false, database: false, architecture: false, deployment: false };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const REVIEW_STEPS: ReadonlySet<StepKind> = new Set([
  "plan_review",
  "review",
  "security_review",
  "inspection",
]);

const MINUTE = 60_000;

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }),
};

/** The run's end state and failure category, from the runner's fixed failure codes. */
function runEnd(result: AgentRunResult): { status: RunEndStatus; failure: RunFailureCategory } {
  switch (result.failure) {
    case "timeout":
      return { status: "timed_out", failure: "timeout" };
    case "cancelled":
      return { status: "cancelled", failure: "cancelled" };
    case "quota_exhausted":
    case "not_authenticated":
    case "model_mismatch":
    case "access_mismatch":
      return { status: "failed", failure: result.failure };
    default:
      return { status: "failed", failure: "provider_error" };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class TeamOrchestrator {
  readonly #d: OrchestratorDeps;
  readonly #job: TeamJobDefinition;
  readonly #nodes = new Map<string, NodeState>();
  /** Declared and overlap-implied dependencies, per unit. */
  readonly #deps = new Map<string, string[]>();
  #status = "queued";
  #reviewRound = 0;
  #evidence: Evidence = {
    base: "",
    baseExcludedUncommittedChanges: false,
    planHash: null,
    integrationBranch: null,
    diffFingerprint: null,
    commits: [],
    tests: [],
    uncertainty: [],
  };
  readonly #doing = new Map<AgentProvider, string>();
  #finalVerdict: JobVerdict | null = null;
  /** Stops every agent run in this job: on cancellation, or when one unit stops it. */
  readonly #abort = new AbortController();
  readonly #mode: JobMode;
  /** Owner notes collected from the server, waiting for each agent's next turn. */
  readonly #notes = new Map<AgentProvider, OwnerNote[]>();
  /** Note ids already queued, so a note the server sends twice is delivered once. */
  readonly #seenNotes = new Set<string>();
  #notesUnavailable = false;
  /** Nothing new starts: the current round finishes, then the job ends (cancel_queued, 0.9 stop). */
  #stopRequested = false;
  /** Why the owner's stop ended the job, in fixed words. */
  #stopWhy = "";
  /** stop_now: every running agent of this job was killed. */
  #stopNow = false;
  /** The owner's current control, as the server last reported it. */
  #control: JobControl | null = null;
  #controlAt: string | null = null;
  #planningRoundsDone = 0;
  #buildRoundsDone = 0;
  /** Who takes which role (roles.ts), decided before any agent runs. */
  #roles: RoleAssignment | null = null;
  /** The agents of this job: the chat's participants, or the room's agents. */
  #participants: AgentProvider[] = [];
  /** Preflight health, for choosing whom the owner may pick instead. */
  #health = new Map<AgentProvider, ProviderHealth>();
  /** Solo and pair: who builds, and who reviews (null in solo). Set from #roles. */
  #builderHolder: AgentProvider | null = null;
  #reviewer: AgentProvider | null = null;
  /** The last non-terminal status reached, for the stage list. */
  #phase = "queued";
  #specDone = false;
  /** Set only after a plan was persisted with its approvals. */
  #planApproved = false;
  #finalReason: VerdictReason | null = null;
  /** Every finding this job raised, in order (report, lifecycle). */
  readonly #findings: TrackedFinding[] = [];
  /** Messages posted, for scoped context. */
  readonly #messages: LoggedMessage[] = [];
  /** Decisions so far, in ThreadLink's fixed words, for scoped context. */
  readonly #decisionLog: string[] = [];
  /** Native sessions per participant and session key (continuity, §2). */
  readonly #sessions = new Map<
    string,
    { sessionId: string; runKey: string; chatId: string | null }
  >();
  /** Run keys used, so every run has its own. */
  readonly #runKeys = new Set<string>();
  /** read_choices is not available on this server: no control polling during runs. */
  #choicesUnavailable = false;
  #lastControlPoll = 0;
  /** Who did the final inspection, for the report. */
  #inspector: AgentProvider | null = null;
  /** 0.11: reviewers whose independent review could not happen (usage exhausted). */
  readonly #reviewPending = new Set<AgentProvider>();
  /** 0.11: the reset time each exhausted provider stated, when it did. */
  readonly #resets = new Map<AgentProvider, string | null>();
  /**
   * 0.11: reviewers that were out of usage when the job started and whose
   * reviews the failover policy left pending: they are never run in this job.
   */
  readonly #pendingReviewers = new Set<AgentProvider>();

  constructor(job: TeamJobDefinition, deps: OrchestratorDeps) {
    this.#job = job;
    this.#d = deps;
    this.#mode = job.mode ?? "team";
    // Cancelling the job (the caller's signal) cancels every agent run in it.
    if (deps.signal?.aborted) this.#abort.abort();
    deps.signal?.addEventListener("abort", () => this.#abort.abort(), { once: true });
  }

  /** Runs the job to a verdict. Never throws for an ordinary failure: it reports one. */
  async run(workspace: string): Promise<TeamOutcome> {
    const worktrees = this.#d.worktrees;
    let set: Awaited<ReturnType<WorktreeManager["begin"]>> | null = null;
    try {
      const needs = this.#mode === "team" ? this.#requireTeam() : this.#requireSimple();
      // Preflight: before any agent runs, every agent the job needs must be
      // ready, checked with a real call if the last check is stale. A provider
      // that is not ready ends the job here; nobody else takes its place.
      const health = await this.#preflight(needs.required, needs.candidates);
      this.#health = health;
      // 0.11 §5: an agent already out of usage is handled by the job's
      // failover policy, not by stopping the job (a 0.10 job still stops).
      const exhausted = [...new Set([...needs.required, ...needs.candidates])].filter(
        (p) => health.get(p) === "usage_exhausted",
      );
      this.#roles =
        exhausted.length && this.#job.failoverPolicy
          ? await this.#rolesWithExhausted(needs, health, exhausted)
          : this.#assignRoles(needs.candidates, health);
      if (this.#mode !== "team") {
        this.#builderHolder = this.#roles.builders[0]!;
        this.#reviewer = this.#mode === "pair" ? (this.#roles.reviewers[0] ?? null) : null;
      }
      this.#notePaidUsage();
      // The first write goes before anything touches the disk: it is refused
      // unless this Runtime holds the claim for a job the server created, so a
      // forged or stale job stops here with nothing to clean up.
      await this.#setStatus(
        "normalising",
        this.#mode === "team" ? "Turning the request into a specification" : "Starting",
      );
      await this.#decision(
        "Roles",
        rolesDecisionText(this.#roles),
        [],
        {
          coordinator: this.#roles.coordinator,
          planner: this.#roles.planner,
          integrator: this.#roles.integrator,
          builders: this.#roles.builders,
          reviewers: this.#roles.reviewers,
        },
        false,
      );
      set = await worktrees.begin(workspace, this.#worktreeJob());
      this.#evidence.base = set.base;
      this.#evidence.baseExcludedUncommittedChanges = set.dirty;
      if (set.dirty) {
        this.#evidence.uncertainty.push(
          "The repository had uncommitted changes. The team worked from the last commit, so those changes are not part of this result.",
        );
      }

      let outcome = this.#mode === "team" ? await this.#runTeam(set) : await this.#runSimple(set);
      this.#noteUndelivered();
      let pendingFor: AgentProvider | null = null;
      // A review the job needed did not happen: never a PASS (§5).
      if (outcome.verdict === "PASS" && this.#reviewPending.size) {
        pendingFor = [...this.#reviewPending][0]!;
        const who = [...this.#reviewPending].map((p) => providerName(p)).join(" and ");
        outcome = {
          ...outcome,
          verdict: "REVIEW_PENDING",
          reason: "usage_exhausted",
          summary: `Work complete · review pending. ${who}'s independent review could not run because its included usage ran out; it has not reviewed this work yet.`,
        };
        this.#evidence.uncertainty.push(
          `${who} did not review this work: its included usage ran out during the job.`,
        );
      }
      await this.#finish(outcome.verdict, outcome.summary, outcome.reason, pendingFor);
      return outcome;
    } catch (error) {
      // Not a verdict: the executor asks the owner (resume / stop).
      if (error instanceof InterruptedRefusal) throw error;
      this.#noteUndelivered();
      const verdict = error instanceof Stop ? error.verdict : "BLOCKED";
      const reason: VerdictReason = error instanceof Stop ? error.reason : "unexpected_error";
      const provider = error instanceof Stop ? error.provider : null;
      const summary =
        error instanceof Stop
          ? error.message
          : `The team stopped because of an unexpected error: ${redactText(
              (error as Error)?.message ?? String(error),
              500,
            )}`;
      await this.#finish(verdict, summary, reason, provider).catch(() => undefined);
      return { verdict, summary, reason, evidence: this.#evidence, units: this.#units() };
    } finally {
      // Worktree directories go; branches stay, so the work and its history
      // are the user's to keep or discard.
      if (set) await worktrees.cleanup(set, { keepBranches: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------

  /** The room's agents, and the job's participants (the chat's, or the room's). */
  #members(): { room: Set<AgentProvider>; participants: AgentProvider[] } {
    const room = new Set(this.#job.agents.map((a) => a.provider));
    const participants = this.#job.participants?.length
      ? [...this.#job.participants]
      : [...new Set(this.#job.agents.map((a) => a.provider))];
    for (const p of participants) {
      if (!room.has(p)) {
        throw new Stop(
          "NEEDS_USER_DECISION",
          `${providerName(p)} is part of this chat but not of its project, so it cannot work here. Add it to the project, or remove it from the chat.`,
          "agent_not_in_project",
          p,
        );
      }
    }
    this.#participants = participants;
    return { room, participants };
  }

  /**
   * A team is two or more different providers. With only one, cross-review is
   * impossible, and quietly letting one agent review itself would be exactly
   * the thing Team Mode exists to prevent. Every participant is needed.
   */
  #requireTeam(): { required: AgentProvider[]; candidates: AgentProvider[] } {
    const { participants } = this.#members();
    if (participants.length < 2) {
      const missing = AGENT_PROVIDERS.filter((p) => !participants.includes(p));
      throw new Stop(
        "NEEDS_USER_DECISION",
        missing.length
          ? `${missing.map((p) => providerName(p)).join(" and ")} ${missing.length > 1 ? "are" : "is"} not part of this room, so the work cannot be cross-reviewed. Add another agent, or run this as a single-agent task.`
          : "Team needs two different agents, so that nobody reviews their own work. Add another agent, or run this as a single-agent task.",
        "agent_not_in_project",
      );
    }
    return { required: participants, candidates: participants };
  }

  /**
   * Solo and Builder + Reviewer. A builder or reviewer the owner chose must be
   * in the room and ready here; one they left to ThreadLink is chosen from the
   * ready participants (roles.ts). Neither is ever replaced by another agent.
   */
  #requireSimple(): { required: AgentProvider[]; candidates: AgentProvider[] } {
    const { room, participants } = this.#members();
    const overrides = this.#job.roleOverrides ?? {};
    const builder = this.#job.builder ?? overrides.builder ?? null;
    if ((builder && !room.has(builder)) || participants.length === 0) {
      throw new Stop(
        "NEEDS_USER_DECISION",
        "This job does not name an agent in the room to build it. Say who should build it.",
        "agent_not_in_project",
      );
    }
    if (this.#mode === "solo") {
      return { required: builder ? [builder] : [], candidates: builder ? [builder] : participants };
    }
    const reviewer = this.#job.reviewer ?? overrides.reviewer ?? null;
    if (reviewer && (!room.has(reviewer) || reviewer === builder)) {
      throw new Stop(
        "NEEDS_USER_DECISION",
        reviewer === builder
          ? `${providerName(reviewer)} cannot review its own work. Choose another reviewer.`
          : `${providerName(reviewer)} is not part of this room, so it cannot review. Add it to the room, or run this as Solo.`,
        "agent_not_in_project",
        reviewer,
      );
    }
    const others = participants.filter((p) => p !== builder);
    if (others.length === 0 || participants.length < 2) {
      const missing = AGENT_PROVIDERS.filter((p) => !room.has(p));
      const whose = builder ? `${providerName(builder)}'s` : "the";
      throw new Stop(
        "NEEDS_USER_DECISION",
        missing.length
          ? `${missing.map((p) => providerName(p)).join(" or ")} is not part of this room, so it cannot review ${whose} work. Add it to the room, or run this as Solo.`
          : `There is no other agent in this chat to review ${whose} work. Add one, or run this as Solo.`,
        "agent_not_in_project",
      );
    }
    const required = [builder, reviewer].filter((p): p is AgentProvider => p !== null);
    return { required, candidates: participants };
  }

  #notePaidUsage(): void {
    if (!this.#job.policy.paidUsage) return;
    // The owner has allowed paid usage, but the agents run with API keys
    // stripped from their environment, so they can only ever use the included
    // subscription. Say so rather than imply otherwise.
    this.#evidence.uncertainty.push(
      this.#mode === "team"
        ? "Paid usage is allowed on your profile, but Team Mode only uses your included subscription usage. No paid usage was used."
        : "Paid usage is allowed on your profile, but ThreadLink's agents only use your included subscription usage. No paid usage was used.",
    );
  }

  /**
   * Each candidate's health: asked of the health port (which probes if the
   * cached result is stale) and never better than what this job can run -- a
   * provider with no runner is not installed as far as this job is concerned.
   * A required provider that is not ready stops the job before any agent runs.
   */
  async #preflight(
    required: AgentProvider[],
    candidates: AgentProvider[],
  ): Promise<Map<AgentProvider, ProviderHealth>> {
    const all = [...new Set([...required, ...candidates])];
    let reported: Partial<Record<AgentProvider, ProviderHealth>> = {};
    if (this.#d.health) {
      try {
        reported = await this.#d.health.ensure(all);
      } catch {
        reported = {};
      }
    }
    const health = new Map<AgentProvider, ProviderHealth>();
    for (const p of all) {
      const runner = this.#d.runners[p];
      let h: ProviderHealth;
      if (!this.#d.health) h = runner ? "ready" : "not_installed";
      else {
        h = reported[p] ?? "unknown";
        if (h === "ready" && !runner) h = "not_installed";
      }
      health.set(p, h);
    }
    for (const p of required) {
      const h = health.get(p)!;
      // 0.11: out of usage is the failover policy's to handle (#rolesWithExhausted),
      // but only for a job from a server that sent one. Sign-in, API-key and
      // not-installed problems still stop the job here.
      if (h === "usage_exhausted" && this.#job.failoverPolicy) continue;
      if (h !== "ready") throw healthStop(p, h);
    }
    return health;
  }

  /**
   * 0.11 §5: roles when an agent the job needs is already out of included
   * usage at the start. The job's failover policy decides (auto: continue
   * with the ready agents and say so once; ask: the owner's usage_exhausted
   * choice; wait: wait for the reset). A review the exhausted agent would
   * have done, and nobody else independent can do, is left pending: it is
   * never run in this job and the job cannot PASS. Nobody reviews their own work.
   */
  async #rolesWithExhausted(
    needs: { required: AgentProvider[]; candidates: AgentProvider[] },
    health: Map<AgentProvider, ProviderHealth>,
    exhausted: AgentProvider[],
  ): Promise<RoleAssignment> {
    const x = exhausted[0]!;
    const resetsAt = this.#d.health?.resetsAt?.(x) ?? null;
    this.#resets.set(x, resetsAt);
    // Who else could take over: every participant's health, not only the
    // candidates the owner's choice named (a solo job names one).
    const unknown = this.#participants.filter((p) => !health.has(p));
    if (unknown.length) {
      let reported: Partial<Record<AgentProvider, ProviderHealth>> = {};
      try {
        reported = this.#d.health ? await this.#d.health.ensure(unknown) : {};
      } catch {
        reported = {};
      }
      for (const p of unknown) {
        const runner = this.#d.runners[p];
        const h = this.#d.health ? (reported[p] ?? "unknown") : runner ? "ready" : "not_installed";
        health.set(p, h === "ready" && !runner ? "not_installed" : h);
      }
    }
    const ready = this.#participants.filter(
      (p) => health.get(p) === "ready" && this.#d.runners[p] !== undefined,
    );
    const overrides = this.#job.roleOverrides ?? {};
    const reasons: string[] = [];
    const name = providerName;
    const out = `${name(x)}'s included usage has run out`;

    let role: "builder" | "reviewer" | "participant";
    let alternatives: AgentProvider[] = [];
    let reviewPending: { continueWith: AgentProvider | null } | null = null;
    let noticeReviewPending = false;
    /** Builds the roles once the decision is known. */
    let build: (action: "other" | "skip", to: AgentProvider | null) => RoleAssignment;

    if (this.#mode === "solo") {
      role = "builder";
      alternatives = ready.filter((p) => p !== x);
      build = (_a, to) => {
        reasons.push(`${name(to!)} builds (${out})`);
        return {
          ok: true,
          coordinator: to!,
          planner: to!,
          integrator: to!,
          builders: [to!],
          reviewers: [],
          reasons,
        };
      };
    } else if (this.#mode === "pair") {
      const builderWanted = this.#job.builder ?? overrides.builder ?? null;
      const reviewerWanted = this.#job.reviewer ?? overrides.reviewer ?? null;
      if (
        x === builderWanted ||
        (builderWanted === null && reviewerWanted !== null && reviewerWanted !== x)
      ) {
        // The builder is out: a ready agent builds. If that agent is the only
        // one who could review, the review waits for the exhausted builder.
        role = "builder";
        const newBuilder = ready.find((p) => p !== reviewerWanted) ?? ready[0] ?? null;
        alternatives = newBuilder ? [newBuilder] : [];
        const independent = ready.find((p) => p !== newBuilder) ?? null;
        noticeReviewPending = independent === null;
        build = (_a, to) => {
          const reviewer = independent ?? x;
          if (!independent) this.#pendingReviewers.add(x);
          reasons.push(`${name(to!)} builds (${out})`);
          reasons.push(
            independent
              ? `${name(reviewer)} reviews`
              : `${name(x)}'s independent review is pending until its usage is back`,
          );
          return {
            ok: true,
            coordinator: to!,
            planner: to!,
            integrator: to!,
            builders: [to!],
            reviewers: [reviewer],
            reasons,
          };
        };
      } else {
        // The reviewer (chosen, or the only other agent) is out.
        role = "reviewer";
        const builder =
          builderWanted && health.get(builderWanted) === "ready"
            ? builderWanted
            : (ready[0] ?? null);
        if (!builder) throw healthStop(x, "usage_exhausted");
        alternatives = ready.filter((p) => p !== builder);
        if (!alternatives.length) reviewPending = { continueWith: builder };
        build = (action, to) => {
          const reviewer = action === "other" ? to! : x;
          if (action === "skip") this.#pendingReviewers.add(x);
          reasons.push(`${name(builder)} builds`);
          reasons.push(
            action === "other"
              ? `${name(reviewer)} reviews (${out})`
              : `${name(x)}'s independent review is pending until its usage is back`,
          );
          return {
            ok: true,
            coordinator: builder,
            planner: builder,
            integrator: builder,
            builders: [builder],
            reviewers: [reviewer],
            reasons,
          };
        };
      }
    } else {
      // Team: continue with the ready participants.
      role = "participant";
      if (ready.length >= 2) {
        alternatives = ready;
        build = () => {
          const assigned = this.#assignRoles(ready, health);
          return {
            ...assigned,
            reasons: [...assigned.reasons, `${name(x)} is not taking part (${out})`],
          };
        };
      } else if (ready.length === 1) {
        const only = ready[0]!;
        reviewPending = { continueWith: only };
        build = () => {
          this.#pendingReviewers.add(x);
          reasons.push(
            `${name(only)} coordinates, plans and builds (${out}); every review by ${name(x)} is pending until its usage is back`,
          );
          return {
            ok: true,
            coordinator: only,
            planner: only,
            integrator: only,
            builders: [only],
            reviewers: [x],
            reasons,
          };
        };
      } else {
        throw healthStop(x, "usage_exhausted");
      }
    }
    if (!alternatives.length && !reviewPending) throw healthStop(x, "usage_exhausted");

    const action = await handleExhausted(
      {
        provider: x,
        resetsAt,
        policy: this.#job.failoverPolicy ?? "ask",
        alternatives,
        reviewPending,
        noticeReviewPending,
        params: { role: role === "participant" ? null : role, step: null },
        key: `${this.#worktreeJob()}:preflight:${x}`,
      },
      {
        write: (op, payload) => this.#write(op as TeamOp, payload),
        recheck: this.#d.health?.confirm ? (p) => this.#d.health!.confirm!(p) : undefined,
        clock: this.#d.clock ?? realClock,
        signal: this.#abort.signal,
        choicePollMs: this.#d.choicePollMs,
        choiceWaitMs: this.#d.choiceWaitMs,
        noticesSent: this.#d.noticesSent,
        chatId: this.#job.chatId ?? null,
        onRecovered: (p) => this.#d.onRecovered?.(p),
      },
    );
    switch (action.action) {
      case "retry":
        // A fresh check says it is back: the job runs as it would have.
        health.set(x, "ready");
        this.#resets.delete(x);
        return this.#assignRoles(needs.candidates, health);
      case "other":
        return build("other", action.provider);
      case "skip":
        return build("skip", action.continueWith);
      default:
        if (action.why === "owner") {
          throw new Stop("NEEDS_USER_DECISION", `Stopped by you: ${out}.`, "stopped_by_owner", x);
        }
        throw healthStop(x, "usage_exhausted");
    }
  }

  #assignRoles(
    candidates: AgentProvider[],
    health: Map<AgentProvider, ProviderHealth>,
  ): RoleAssignment {
    const participants: RoleCandidate[] = candidates.map((provider) => ({
      provider,
      health: health.get(provider) ?? "unknown",
      modelClasses: this.#d.modelClasses?.[provider] ?? [],
    }));
    const roomPrefs = Object.fromEntries(this.#job.agents.map((a) => [a.provider, a.roles]));
    const overrides = { ...(this.#job.roleOverrides ?? {}) };
    if (this.#job.builder) overrides.builder = this.#job.builder;
    if (this.#job.reviewer) overrides.reviewer = this.#job.reviewer;
    const result = assignRoles({
      mode: this.#mode,
      participants,
      roomPrefs,
      overrides,
      history: { recentFailures: this.#d.health?.recentFailures?.() ?? {} },
      seed: this.#job.jobId,
    });
    if (result.ok) return result;
    if (result.provider && result.health && result.health !== "ready") {
      throw healthStop(result.provider, result.health);
    }
    throw new Stop(result.verdict, result.message, "agent_not_in_project", result.provider);
  }

  /** The best-ranked reviewer that is not `author`: nobody reviews their own work. */
  #reviewerFor(author: AgentProvider): AgentProvider {
    const reviewer = this.#roles?.reviewers.find((p) => p !== author);
    if (!reviewer) {
      throw new Stop(
        "NEEDS_USER_DECISION",
        `There is no other agent to review ${providerName(author)}'s work.`,
        "agent_not_in_project",
      );
    }
    return reviewer;
  }

  #roleOf(role: "coordinator" | "planner" | "integrator"): AgentProvider {
    if (!this.#roles) throw new Error("Roles were used before they were assigned.");
    return this.#roles[role];
  }

  #caps(provider: AgentProvider): ProviderCapabilities | null {
    return (this.#d.capabilities ?? capabilitiesOf)(provider);
  }

  /** Worktree names for this start of the job: a restarted job never reuses a branch. */
  #worktreeJob(): string {
    const attempt = this.#d.attempt ?? 1;
    return attempt > 1 ? `${shortJob(this.#job.jobId)}-r${attempt}` : shortJob(this.#job.jobId);
  }

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  /** Team Mode: normalise, plan with a council, build, cross-review, integrate, inspect. */
  async #runTeam(set: Awaited<ReturnType<WorktreeManager["begin"]>>): Promise<TeamOutcome> {
    // Even read-only work happens in a worktree, never in the user's own
    // checkout, so "it did not write anything" is something we can check.
    const planning = await this.#d.worktrees.create(set, "planning");
    const spec = await this.#normalise(planning);
    await this.#checkStop();
    const plan = await this.#plan(spec, planning);
    await this.#checkStop();
    await this.#assign(plan);
    await this.#build(spec, set);
    const integration = await this.#integrate(set);
    await this.#checkStop();
    return this.#inspect(spec, integration);
  }

  /**
   * Solo and Builder + Reviewer. No planning council: the owner's request is
   * one unit of work, recorded as the plan and approved by the builder that
   * takes it on. In a pair the other provider reviews it, with fix rounds
   * bounded by the review budget, exactly as a Team Mode unit is reviewed.
   * Then ThreadLink integrates it and runs the owner's tests itself.
   */
  async #runSimple(set: Awaited<ReturnType<WorktreeManager["begin"]>>): Promise<TeamOutcome> {
    const builder = this.#builderHolder!;
    const reviewer = this.#reviewer;
    const spec = this.#specFromJob();
    await this.#write("set_spec", { spec: redactDeep(spec) });
    this.#specDone = true;
    await this.#checkStop();

    await this.#setStatus("planning", "Recording the plan");
    const plan: Plan = {
      summary:
        reviewer === null
          ? `One unit of work, built by ${providerName(builder)}.`
          : this.#pendingReviewers.has(reviewer)
            ? `One unit of work, built by ${providerName(builder)}. ${providerName(reviewer)}'s review is pending until its usage is back.`
            : `One unit of work, built by ${providerName(builder)} and reviewed by ${providerName(reviewer)}.`,
      nodes: [
        {
          key: "work",
          title: goalTitle(this.#job.goal),
          scope: "Deliver the owner's request as specified.",
          files: [],
          dependsOn: [],
          suggestedOwner: builder,
          rationale: this.#resets.size
            ? // A usage failover chose these agents, not the owner: say only that.
              `${providerName(builder)} took this on because ${[...this.#resets.keys()].map((p) => providerName(p)).join(" and ")} ran out of included usage.`
            : reviewer === null
              ? `The owner asked ${providerName(builder)} to do this on its own.`
              : `The owner asked ${providerName(builder)} to build this and ${providerName(reviewer)} to review it.`,
          complexity: "medium",
          risk: { ...NO_RISK },
        },
      ],
      risks: [],
    };
    const planHash = sha256(JSON.stringify(plan));
    this.#evidence.planHash = planHash;
    // The builder is the only agent that takes the plan on. The reviewer, in a
    // pair, approves the work itself -- and that approval is what gates a PASS.
    await this.#write("set_plan", { plan: redactDeep(plan), planHash, approvedBy: [builder] });
    this.#planApproved = true;
    // No "plan" decision in the chat: a one-unit job has nothing to decide.
    // Its roles are already the "Roles chosen" decision.
    await this.#checkStop();

    await this.#assign(plan, [builder]);
    await this.#build(spec, set);
    const integration = await this.#integrate(set, builder);
    // A unit that changed nothing is not merged, so the tests may not have run yet.
    if (!this.#evidence.tests.length) await this.#runTests(integration.record, "on the result");
    await this.#checkStop();
    this.#evidence.diffFingerprint = await this.#d.worktrees.fingerprint(integration.record);

    const unit = [...this.#nodes.values()][0]!;
    const parts: string[] = [];
    if (!unit.commits.length) {
      parts.push(`${providerName(builder)} finished without changing any files.`);
      this.#evidence.uncertainty.push(`${providerName(builder)} made no changes.`);
    } else if (reviewer === null) {
      parts.push(`Built by ${providerName(builder)}. Nobody else reviewed it (Solo).`);
    } else {
      parts.push(`Built by ${providerName(builder)} and approved by ${providerName(reviewer)}.`);
    }
    if (this.#job.verifyCommands.length) {
      parts.push("ThreadLink ran your tests on the result and they passed.");
    } else {
      parts.push("No test commands were given, so ThreadLink ran no tests of its own.");
      this.#evidence.uncertainty.push(
        "No test commands were given, so ThreadLink ran no tests of its own.",
      );
      // Solo with no tests: nothing but the builder itself checked the work,
      // which is not a PASS. The owner decides whether it is good enough.
      if (reviewer === null) {
        parts.push(
          "Nothing reviewed or tested this work: check it yourself, or add test commands in the project settings.",
        );
        return this.#verdict("NEEDS_USER_DECISION", parts.join(" "), "no_review_or_tests");
      }
    }
    return this.#verdict("PASS", parts.join(" "));
  }

  /** The specification for a job with no normalising step: the owner's own words. */
  #specFromJob(): TeamSpec {
    const spec: TeamSpec = {
      goal: this.#job.goal,
      requirements: [],
      constraints: [],
      architectureConstraints: [],
      securityConstraints: [],
      filesAndSystems: [],
      testsRequired: [],
      doNotChange: [],
      deploymentRules: [],
      definitionOfDone: [],
    };
    for (const [field, value] of Object.entries(this.#job.spec)) {
      if (Array.isArray(value) && value.length) (spec as Record<string, unknown>)[field] = value;
    }
    return spec;
  }

  // -------------------------------------------------------------------------
  // Owner notes, controls and stop requests
  // -------------------------------------------------------------------------

  /**
   * Collects notes the owner sent since the last look and queues each for the
   * agent(s) it is addressed to. The server marks them queued when read and
   * seen when a run consumes them (§5), so they are held here until that
   * agent's next turn. A failure to collect is not fatal -- the owner is told
   * their notes may not have arrived -- because controls are also seen on
   * every other write.
   */
  async #collectNotes(): Promise<void> {
    if (this.#notesUnavailable) return;
    let answer: Record<string, unknown>;
    try {
      answer = await this.#write(READ_OWNER_NOTES_OP, {});
    } catch {
      this.#notesUnavailable = true;
      this.#evidence.uncertainty.push(
        "ThreadLink could not collect the notes you sent during this job, so the agents may not have seen them.",
      );
      return;
    }
    this.#queueNotes(answer);
  }

  #queueNotes(answer: unknown): void {
    const agents: AgentProvider[] =
      this.#mode === "team"
        ? this.#participants
        : [this.#builderHolder, this.#reviewer].filter((p): p is AgentProvider => p !== null);
    for (const note of parseOwnerNotes(answer)) {
      if (this.#seenNotes.has(note.id)) continue;
      this.#seenNotes.add(note.id);
      const to = note.audience === "team" ? agents : agents.filter((a) => a === note.audience);
      for (const provider of to) {
        this.#notes.set(provider, [...(this.#notes.get(provider) ?? []), note]);
      }
    }
  }

  /** The notes waiting for this provider, removed from its queue. */
  #takeNotes(provider: AgentProvider): OwnerNote[] {
    const notes = this.#notes.get(provider) ?? [];
    this.#notes.delete(provider);
    return notes;
  }

  /** Notes that reached no agent are reported, not dropped silently. */
  #noteUndelivered(): void {
    for (const [provider, notes] of this.#notes) {
      if (!notes.length) continue;
      const many = notes.length > 1;
      this.#evidence.uncertainty.push(
        `${notes.length} note${many ? "s" : ""} you sent arrived after ${providerName(provider)} had finished its part, so it did not see ${many ? "them" : "it"}.`,
      );
    }
    this.#notes.clear();
  }

  /**
   * The owner's control (§5), from any write answer. stop_now takes effect at
   * once: every provider process this job started is killed (only those).
   * The others are honoured at their boundary.
   */
  #applyControl(answer: unknown): void {
    const parsed = parseControl(answer);
    if (!parsed) return;
    if (parsed.control === this.#control && parsed.requestedAt === this.#controlAt) return;
    this.#control = parsed.control;
    this.#controlAt = parsed.requestedAt;
    switch (parsed.control) {
      case "stop_now":
        if (this.#stopNow) return;
        this.#stopNow = true;
        this.#stopWhy = "Stopped by you. The agents that were working were stopped.";
        this.#abort.abort();
        void this.#d.processes
          ?.killJob(this.#job.jobId)
          .catch(() => 0)
          .then(() => this.#ackControl("stop_now"));
        if (!this.#d.processes) void this.#ackControl("stop_now");
        return;
      case "cancel_queued":
        if (!this.#stopRequested) {
          this.#stopRequested = true;
          this.#stopWhy = "";
          void this.#ackControl("cancel_queued");
        }
        return;
      case "resume":
        this.#control = null;
        void this.#ackControl("resume");
        return;
      default:
        return;
    }
  }

  /** At a round boundary: stop here if the owner asked. */
  async #checkStop(): Promise<void> {
    await this.#collectNotes();
    if (this.#stopNow) throw this.#stopped();
    if (this.#stopRequested) throw this.#stopped();
  }

  #stopped(): Stop {
    if (this.#stopWhy) return new Stop("NEEDS_USER_DECISION", this.#stopWhy, "stopped_by_owner");
    const round = this.#buildRoundsDone || this.#planningRoundsDone;
    return new Stop(
      "NEEDS_USER_DECISION",
      `Stopped by you after round ${round}.`,
      "stopped_by_owner",
    );
  }

  /**
   * After every agent step: stop_now ends the job; stop_after_review ends it
   * once a review has finished (the review's findings are recorded first:
   * nothing new starts); pause_after_step waits here for resume.
   */
  async #afterStep(step: StepKind): Promise<void> {
    if (this.#stopNow) throw this.#stopped();
    if (this.#control === "stop_after_review" && REVIEW_STEPS.has(step) && !this.#stopRequested) {
      this.#stopRequested = true;
      this.#stopWhy = "Stopped by you after the review.";
      await this.#ackControl("stop_after_review");
    }
    if (this.#control === "pause_after_step") await this.#waitWhilePaused();
  }

  /** Paused by the owner: nothing new starts until they resume or stop. Bounded like a choice. */
  async #waitWhilePaused(): Promise<void> {
    const clock = this.#d.clock ?? realClock;
    const deadline = clock.now() + (this.#d.choiceWaitMs ?? 24 * 60 * MINUTE);
    const phase = this.#phase;
    await this.#ackControl("pause_after_step");
    await this.#write("set_status", { status: "paused", line: "Paused by you" }).catch(
      () => undefined,
    );
    this.#progress("Paused by you");
    while (this.#control === "pause_after_step") {
      if (this.#stopNow) throw this.#stopped();
      if (clock.now() >= deadline) {
        throw new Stop(
          "NEEDS_USER_DECISION",
          "The job was paused for 24 hours without being resumed, so it ended here.",
          "stopped_by_owner",
        );
      }
      await clock.sleep(this.#d.choicePollMs ?? 15_000, this.#abort.signal);
      if (this.#abort.signal.aborted && !this.#stopNow) throw this.#stopped();
      await this.#pollControl(true);
    }
    if (this.#stopNow) throw this.#stopped();
    await this.#setStatus(phase, "Resumed");
  }

  /** Tells the server a control was honoured at its boundary (best effort). */
  async #ackControl(control: JobControl): Promise<void> {
    try {
      await this.#d.sink(OPS_0_10.ackControl, ackControlPayload(control));
    } catch {
      /* the control still took effect here; the server just keeps showing it */
    }
  }

  /**
   * Asks the server for the job's state (through read_choices, which carries
   * it), at most once per controlPollMs unless `force`. A server without
   * read_choices is remembered and not asked again.
   */
  async #pollControl(force = false): Promise<void> {
    if (this.#choicesUnavailable) return;
    const clock = this.#d.clock ?? realClock;
    const every = this.#d.controlPollMs ?? 15_000;
    if (!force && (every <= 0 || clock.now() - this.#lastControlPoll < every)) return;
    this.#lastControlPoll = clock.now();
    try {
      await this.#write(OPS_0_10.readChoices, readChoicesPayload([]));
    } catch {
      this.#choicesUnavailable = true;
    }
  }

  // -------------------------------------------------------------------------
  // Normalise
  // -------------------------------------------------------------------------

  async #normalise(workspace: WorktreeRecord): Promise<TeamSpec> {
    const coordinator = this.#roleOf("coordinator");
    this.#doing.set(coordinator, "Turning the request into a specification");
    const result = await this.#call(coordinator, "coordinator", {
      step: "normalise",
      unit: null,
      round: 0,
      cwd: workspace.path,
      worktree: workspace,
      prompt: () => normalisePrompt(this.#job.goal, this.#job.spec),
      access: "read-only",
      outputSchema: SPEC_SCHEMA,
      route: { complexity: "low", risk: NO_RISK },
    });
    const restated = stripMessage(result.structured as TeamSpec & { teamMessage?: string });
    // The owner's own words win over any restatement of them.
    const spec: TeamSpec = { ...restated, goal: this.#job.goal };
    for (const [field, value] of Object.entries(this.#job.spec)) {
      if (Array.isArray(value) && value.length) (spec as Record<string, unknown>)[field] = value;
    }
    await this.#write("set_spec", { spec: redactDeep(spec) });
    this.#specDone = true;
    await this.#message(result, this.#roleOf("planner"), "proposal", 0);
    this.#doing.delete(coordinator);
    return spec;
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  async #plan(spec: TeamSpec, workspace: WorktreeRecord): Promise<Plan> {
    await this.#setStatus("planning", "Planning the work");
    const planner = this.#roleOf("planner");
    const reviewer = this.#reviewerFor(planner);
    const builders = this.#roles?.builders ?? this.#participants;
    let previous: { plan: Plan; review: Review } | undefined;
    /** The last review message, which a revision answers. */
    let reviewMessage: LoggedMessage | null = null;
    let rounds = this.#job.budgets.maxPlanningRounds;

    for (let round = 1; round <= rounds; round++) {
      if (round > 1) await this.#checkStop();
      await this.#write("open_round", { kind: "planning", round });
      this.#doing.set(planner, "Proposing a plan");
      const proposal = await this.#call(planner, "planner", {
        step: "plan",
        unit: null,
        round,
        cwd: workspace.path,
        worktree: workspace,
        prompt: (p) =>
          planPrompt(
            spec,
            providerName(p),
            previous,
            builders.map((id) => ({ id, name: providerName(id) })),
            this.#context(reviewMessage ? [reviewMessage] : []),
          ),
        access: "read-only",
        outputSchema: planSchema(builders),
        // Planning revisions continue the planner's own session (§2).
        session: "plan",
        exclude: [reviewer],
        route: { complexity: "high", risk: { ...NO_RISK, architecture: true } },
      });
      const plan = normalisePlan(stripMessage(proposal.structured as Plan));
      const proposalMessage = await this.#message(
        proposal,
        reviewer,
        round === 1 ? "proposal" : "response",
        round,
        { replyTo: reviewMessage?.id ? { kind: "message", id: reviewMessage.id } : null },
      );

      // A plan that is not a valid graph is a blocking problem the planner has
      // to fix, not something to repair quietly on its behalf.
      const graphError = this.#graphError(plan);
      if (graphError) {
        const finding: Finding = {
          severity: "blocking",
          category: "architecture",
          summary: "The plan's units of work do not form a valid dependency graph.",
          detail: graphError,
          file: null,
          line: null,
        };
        await this.#finding(null, round, "planning", finding, "threadlink", null);
        this.#planningRoundsDone = round;
        previous = {
          plan,
          review: {
            verdict: "REVISE",
            summary: graphError,
            findings: [finding],
            ownershipObjections: [],
          },
        };
        reviewMessage = null;
        continue;
      }

      this.#doing.set(reviewer, "Reviewing the plan");
      const reviewed = await this.#reviewOrSkip(reviewer, "reviewer", {
        step: "plan_review",
        unit: null,
        round,
        cwd: workspace.path,
        worktree: workspace,
        prompt: (p) =>
          planReviewPrompt(
            spec,
            plan,
            providerName(p),
            this.#context(proposalMessage ? [proposalMessage] : []),
          ),
        access: "read-only",
        outputSchema: reviewSchema(builders),
        exclude: [planner],
        route: { complexity: "high", risk: { ...NO_RISK, architecture: true } },
      });
      if (!reviewed) {
        // Nobody may review this plan now: the planner's plan is used and the
        // independent review is pending (the job cannot PASS).
        const planHash = sha256(JSON.stringify(plan));
        this.#evidence.planHash = planHash;
        await this.#write("set_plan", {
          plan: redactDeep(plan),
          planHash,
          approvedBy: [planner],
          round,
        });
        this.#planApproved = true;
        this.#planningRoundsDone = round;
        await this.#decision(
          "Plan recorded",
          `${providerName(planner)}'s plan was used without an independent review: ${providerName(reviewer)}'s included usage ran out.`,
          [planner],
          { planHash, units: plan.nodes.map((n) => n.key) },
          false,
        );
        return plan;
      }
      const review = reviewed.structured as Review;
      reviewMessage = await this.#message(reviewed, planner, "review", round, {
        replyTo: proposalMessage?.id ? { kind: "message", id: proposalMessage.id } : null,
      });
      const raised: TrackedFinding[] = [];
      for (const f of review.findings ?? []) {
        raised.push(
          await this.#finding(null, round, "planning", f, reviewed.provider, reviewed.runId),
        );
      }
      this.#planningRoundsDone = round;

      const verdict = effectiveVerdict(review);
      if (verdict === "APPROVED") {
        const planHash = sha256(JSON.stringify(plan));
        this.#evidence.planHash = planHash;
        await this.#write("set_plan", {
          plan: redactDeep(plan),
          planHash,
          approvedBy: [planner, reviewed.provider],
          round,
        });
        this.#planApproved = true;
        // Objections from earlier rounds were answered by the plan the reviewer approved.
        for (const f of this.#findings) {
          if (
            f.unit === null &&
            f.status === "open" &&
            !raised.includes(f) &&
            isSubstantive(f.finding)
          ) {
            await this.#setFindingStatus(f, "resolved", reviewed.runId, round);
          }
        }
        await this.#decision(
          "Plan agreed",
          `Agreed after ${round} planning round${round === 1 ? "" : "s"}.`,
          [planner, reviewed.provider],
          { planHash, units: plan.nodes.map((n) => n.key) },
          false,
        );
        return plan;
      }
      if (verdict === "BLOCKED") {
        throw new Stop(
          "BLOCKED",
          `${providerName(reviewed.provider)} judged the plan cannot proceed: ${redactText(review.summary, 400)}`,
          "plan_blocked",
        );
      }
      previous = { plan, review: stripMessage(review) };
      // §3.5: only an owner-level disagreement goes to the owner. A technical
      // one is negotiated for at most two exchanges, then arbitrated: the
      // coordinator's side (the planner's plan) wins and every objection stays
      // on record as a finding.
      const ownerLevel =
        review.disagreementCategory !== undefined &&
        OWNER_DISAGREEMENTS.has(review.disagreementCategory);
      if (!ownerLevel && round >= Math.min(rounds, PLAN_NEGOTIATION_EXCHANGES)) {
        return this.#arbitrate(plan, planner, reviewed.provider, round);
      }
      // Budget spent with owner-level objections open: the owner decides (§4).
      if (round === rounds && (await this.#planDisagreement(planner, reviewer, rounds))) {
        rounds++;
      }
    }

    // Still disputed after the budget: that is for the owner, not the models.
    await this.#decision(
      "Plan not agreed",
      "The planning budget ran out with substantive objections still open.",
      [],
      { rounds },
      true,
    );
    throw new Stop(
      "NEEDS_USER_DECISION",
      `${providerName(planner)} and ${providerName(reviewer)} did not agree a plan within ${rounds} rounds. The open objections are in the team log.`,
      "agents_disagree",
    );
  }

  /**
   * Arbitration of a technical planning disagreement (§3.5): the plan on the
   * table is adopted, recorded as a ThreadLink decision; the reviewer's
   * objections stay open as findings, visible to the builders and the owner.
   */
  async #arbitrate(
    plan: Plan,
    planner: AgentProvider,
    reviewer: AgentProvider,
    round: number,
  ): Promise<Plan> {
    const planHash = sha256(JSON.stringify(plan));
    this.#evidence.planHash = planHash;
    const coordinator = this.#roles?.coordinator ?? planner;
    const approvedBy = [...new Set([planner, coordinator])];
    await this.#write("set_plan", { plan: redactDeep(plan), planHash, approvedBy, round });
    this.#planApproved = true;
    const open = this.#findings.filter(
      (f) => f.unit === null && f.status === "open" && isSubstantive(f.finding),
    ).length;
    await this.#decision(
      "Disagreement settled",
      `${providerName(reviewer)} and ${providerName(planner)} disagreed on technical points after ${round} planning round${round === 1 ? "" : "s"}. ${providerName(coordinator)}'s plan was adopted${open ? `; ${providerName(reviewer)}'s ${open} open objection${open === 1 ? " is" : "s are"} kept as findings` : ""}.`,
      approvedBy,
      { planHash, units: plan.nodes.map((n) => n.key), openObjections: open },
      false,
    );
    return plan;
  }

  /** A plan still disputed when the budget runs out: the owner may allow one more round. */
  async #planDisagreement(
    planner: AgentProvider,
    reviewer: AgentProvider,
    rounds: number,
  ): Promise<boolean> {
    const choice = await this.#ask(
      "plan_disagreement",
      { planner, reviewer, rounds },
      ["extra_round", "stop"],
      `plan:disagreement:${rounds}`,
    );
    if (choice === null || choice === "stop") return false;
    if (choice === "expired") {
      throw new Stop(
        "NEEDS_USER_DECISION",
        `${providerName(planner)} and ${providerName(reviewer)} did not agree a plan, and no decision was made within 24 hours.`,
        "agents_disagree",
      );
    }
    await this.#setStatus("planning", "Planning the work");
    return choice === "extra_round";
  }

  #graphError(plan: Plan): string | null {
    if (!plan.nodes.length) return "The plan has no units of work.";
    try {
      this.#d.graph.validate(plan.nodes.map(toGraphNode));
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  async #assign(plan: Plan, committedBy: AgentProvider[] = this.#participants): Promise<void> {
    const builders = this.#roles?.builders ?? [];
    for (const node of plan.nodes) {
      // The plan names each unit's owner. One that cannot build in this job
      // (not a participant, or not ready) never gets the unit: it goes to the
      // best-ranked builder that can, and that is recorded.
      let owner = node.suggestedOwner;
      if (!builders.includes(owner)) {
        const given = builders[0];
        if (!given) {
          throw new Stop(
            "NEEDS_USER_DECISION",
            "No agent in this job can build.",
            "agent_not_in_project",
          );
        }
        await this.#decision(
          "Unit reassigned",
          `${node.title} was given to ${providerName(given)}. The plan suggested ${providerName(owner) || "an agent"}, which is not building in this job.`,
          [],
          { unit: node.key, suggested: owner, owner: given },
          false,
        );
        node.suggestedOwner = given;
        owner = given;
      }
      this.#nodes.set(node.key, {
        plan: node,
        owner,
        // The one rule that is never negotiable: nobody reviews their own work.
        // A solo job has no reviewer at all rather than a pretend one.
        reviewer: this.#mode === "solo" ? null : this.#reviewerFor(owner),
        status: "pending",
        worktree: null,
        failures: 0,
        authoredBy: new Set([owner]),
        reviewedBy: new Set(),
        commits: [],
        openFindings: [],
        disputed: false,
      });
    }
    await this.#write("upsert_nodes", {
      nodes: [...this.#nodes.values()].map((n) => ({
        key: n.plan.key,
        title: redactText(n.plan.title, 200),
        scope: redactText(n.plan.scope, 2_000),
        files: n.plan.files,
        dependsOn: n.plan.dependsOn,
        owner: n.owner,
        reviewer: n.reviewer,
        status: n.status,
      })),
    });
    for (const n of plan.nodes) this.#deps.set(n.key, [...n.dependsOn]);
    for (const s of this.#d.graph.serialisations(plan.nodes.map(toGraphNode))) {
      this.#deps.get(s.after)?.push(s.before);
      await this.#decision(
        "Units run one after the other",
        `${s.after} runs after ${s.before}: ${s.reason}`,
        [],
        { before: s.before, after: s.after },
        false,
      );
    }
    // Solo and pair have one unit: "work split into units" would be noise.
    if (this.#mode === "team") {
      await this.#decision(
        "Ownership committed",
        plan.nodes.map((n) => `${n.key}: ${providerName(n.suggestedOwner)}`).join("; "),
        committedBy,
        { owners: Object.fromEntries(plan.nodes.map((n) => [n.key, n.suggestedOwner])) },
        false,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Build and review
  // -------------------------------------------------------------------------

  async #build(spec: TeamSpec, set: Awaited<ReturnType<WorktreeManager["begin"]>>): Promise<void> {
    await this.#setStatus("building", "Building");
    // "reviewing" is reported per unit through node status; the job stays
    // "building" until every unit has been approved or has failed.
    const graphNodes = [...this.#nodes.values()].map((n) => toGraphNode(n.plan));
    const statuses = () =>
      Object.fromEntries([...this.#nodes].map(([k, n]) => [k, n.status])) as Record<
        string,
        NodeStatus
      >;
    const running = new Map<string, Promise<void>>();

    for (;;) {
      // Once the owner has asked to stop, running units finish their current
      // round and nothing new starts.
      const next = this.#stopRequested
        ? []
        : this.#d.graph
            .schedule(graphNodes, statuses(), this.#job.budgets.parallelAgents)
            .filter((key) => !running.has(key) && this.#nodes.get(key)?.status === "pending");
      for (const key of next) {
        const node = this.#nodes.get(key)!;
        node.status = "running";
        running.set(
          key,
          this.#buildNode(spec, set, node).finally(() => running.delete(key)),
        );
      }
      if (!running.size) break;
      try {
        await Promise.race(running.values());
      } catch (error) {
        // One unit has stopped the job. The others must stop too, and be
        // waited for: cleaning up a worktree an agent is still writing to
        // fails, and leaving the agent running would be worse.
        this.#abort.abort();
        await Promise.allSettled(running.values());
        throw error;
      }
    }

    if (this.#stopRequested || this.#stopNow) throw this.#stopped();
    await this.#checkStop();

    const failed = [...this.#nodes.values()].filter((n) => n.status === "failed");
    const disputed = failed.filter((n) => n.disputed);
    if (disputed.length) {
      for (const n of disputed) {
        await this.#decision(
          "Agents disagree",
          `${providerName(n.owner)} and ${n.reviewer ? providerName(n.reviewer) : "the reviewer"} disagree about ${n.plan.title}. ${providerName(n.owner)} declined to change it in response to the review, and the review budget ran out. Open findings: ${
            n.openFindings.map((f) => f.finding.summary).join("; ") || "none recorded"
          }.`,
          [],
          { unit: n.plan.key, findings: n.openFindings.map((f) => f.finding.summary) },
          true,
        );
      }
      throw new Stop(
        "NEEDS_USER_DECISION",
        `The agents disagree about ${disputed.map((n) => n.plan.title).join(", ")} and could not settle it within ${this.#job.budgets.maxReviewRounds} review rounds. Both positions are in the team log.`,
        "agents_disagree",
      );
    }
    const stuck = [...this.#nodes.values()].filter((n) => n.status === "pending");
    if (failed.length) {
      throw new Stop(
        "NEEDS_FIX",
        `${failed.map((n) => n.plan.title).join(", ")} did not pass review within ${this.#job.budgets.maxReviewRounds} rounds. The open findings are in the team log.`,
        "review_not_passed",
      );
    }
    if (stuck.length) {
      throw new Stop(
        "BLOCKED",
        `${stuck.map((n) => n.plan.title).join(", ")} could not start because work they depend on did not finish.`,
        "dependency_not_finished",
      );
    }
  }

  async #buildNode(
    spec: TeamSpec,
    set: Awaited<ReturnType<WorktreeManager["begin"]>>,
    node: NodeState,
  ): Promise<void> {
    node.worktree = await this.#startFromDependencies(
      await this.#d.worktrees.create(set, node.plan.key),
      node,
    );
    await this.#nodeStatus(node, "running");
    let fixing: TrackedFinding[] | undefined;
    /** The review the builder is answering, and the builder's last message (which a re-review answers). */
    let reviewMessage: LoggedMessage | null = null;
    let buildMessage: LoggedMessage | null = null;

    for (let round = 0; round <= this.#job.budgets.maxReviewRounds; round++) {
      if (round > 0) {
        // A round boundary. If the owner asked to stop, this unit ends here,
        // as it stands; #build then ends the job.
        await this.#collectNotes();
        if (this.#stopRequested || this.#stopNow) return;
        this.#reviewRound = Math.max(this.#reviewRound, round);
        await this.#write("open_round", { kind: "review", round, node: node.plan.key });
      }

      // Build (or fix).
      this.#doing.set(
        node.owner,
        fixing ? `Fixing ${node.plan.title}` : `Building ${node.plan.title}`,
      );
      this.#progress(
        `${providerName(node.owner)} — ${fixing ? "fixing" : "building"} ${node.plan.title}`,
      );
      const toFix: RefFinding[] | undefined = fixing?.map((f) => ({
        ...f.finding,
        ref: f.ref,
        status: f.status,
      }));
      const built = await this.#call(node.owner, "builder", {
        step: "build",
        unit: node.plan.key,
        round,
        cwd: node.worktree.path,
        worktree: node.worktree,
        prompt: (p) =>
          buildPrompt(
            spec,
            node.plan,
            providerName(p),
            toFix,
            this.#context(reviewMessage ? [reviewMessage] : []),
          ),
        access: "workspace-write",
        outputSchema: BUILD_SCHEMA,
        // Fix rounds continue the builder's own session for this unit (§2).
        session: `unit:${node.plan.key}`,
        exclude: node.reviewer ? [node.reviewer] : [],
        route: {
          complexity: node.plan.complexity,
          risk: node.plan.risk,
          previousFailures: node.failures,
        },
      });
      node.authoredBy.add(built.provider);
      const report = built.structured as BuildReport;
      const commit = await this.#d.worktrees.commit(node.worktree, `${node.plan.title}`, {
        authoredBy: [...node.authoredBy].map((p) => providerName(p)),
        reviewedBy: [...node.reviewedBy].map((p) => providerName(p)),
        job: this.#job.jobId,
        task: node.plan.key,
      });
      if (commit) node.commits.push(commit);
      // A fix round that changed nothing is the owner disagreeing, not fixing.
      if (fixing?.length && !commit) node.disputed = true;
      else if (commit) node.disputed = false;

      // Scope is part of the plan both agents agreed. A change outside it would
      // collide with another unit at integration, so it is put back here and
      // recorded, rather than trusted to the prompt.
      const changed = await this.#d.worktrees.changedFiles(node.worktree);
      const stray = [
        ...new Set([
          ...this.#d.graph.outOfScope(changed, node.plan.files),
          // Files that steer the agents themselves. A builder that rewrote
          // them could instruct its own reviewer, so they are never kept.
          ...changed.filter(isProtectedPath),
        ]),
      ].sort();
      if (stray.length) {
        const reverted = await this.#d.worktrees.revertPaths(
          node.worktree,
          stray,
          `ThreadLink: undo changes outside ${node.plan.title}'s scope`,
        );
        if (reverted) node.commits.push(reverted);
        await this.#decision(
          "Out-of-scope changes undone",
          `${providerName(built.provider)} changed ${stray.join(", ")}, which the plan did not give ${node.plan.title}. Those changes were undone.`,
          [],
          { unit: node.plan.key, files: stray },
          false,
        );
      }

      // The builder's answer to each finding it was asked to fix (§4).
      if (fixing?.length) {
        const responses = new Map(
          (report.findingResponses ?? [])
            .filter((r) => r && typeof r.ref === "string")
            .map((r) => [r.ref, r.response]),
        );
        for (const f of fixing) {
          const response = responses.get(f.ref);
          if (response === "fixed" && commit)
            await this.#setFindingStatus(f, "fixed", built.runId, round);
          else if (response === "disputed" || (!commit && response !== "fixed")) {
            await this.#setFindingStatus(f, "disputed", built.runId, round);
          }
        }
        if (fixing.every((f) => f.status === "disputed")) node.disputed = true;
      }

      buildMessage = await this.#message(
        built,
        node.reviewer ?? "threadlink",
        // The builder's own report is worth reading in the chat: a completion,
        // not a technical handoff.
        fixing ? "response" : "completion",
        round,
        {
          node: node.plan.key,
          replyTo: fixing?.[0]?.id
            ? { kind: "finding", id: fixing[0].id }
            : reviewMessage?.id
              ? { kind: "message", id: reviewMessage.id }
              : null,
          refs: (fixing ?? [])
            .filter((f) => f.id)
            .map((f) => ({ kind: "finding" as const, id: f.id! })),
        },
      );
      // The change card is recorded while the review runs: the review needs
      // the worktree, not the card (0.11 §3.5). Its failure still stops the job.
      const recording = commit ? this.#recordChange(node, built) : Promise.resolve();
      recording.catch(() => undefined);

      // Solo has no reviewer. In Team Mode the room may turn cross-review off;
      // a pair exists to be reviewed, so it never skips it.
      const reviewer = node.reviewer;
      const reviews =
        this.#mode === "pair" || (this.#mode === "team" && this.#job.policy.crossReview);
      if (!reviews || reviewer === null) {
        await recording;
        this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);
        await this.#nodeStatus(node, "approved");
        this.#doing.delete(node.owner);
        return;
      }
      if (this.#stopNow) {
        await recording;
        return;
      }
      // Nobody reviews their own work: after a usage failover the reviewer may
      // have built this unit itself. Then the review waits for the other agent.
      if (node.authoredBy.has(reviewer)) {
        await recording;
        // The review waits for the agent that ran out of usage.
        const exhausted = [...this.#resets.keys()].find((p) => p !== reviewer);
        this.#reviewPending.add(exhausted ?? node.owner);
        this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);
        await this.#nodeStatus(node, "approved");
        this.#doing.delete(node.owner);
        return;
      }

      // Review, by the other provider, read-only, on exactly this code.
      await this.#nodeStatus(node, "in_review");
      const fingerprint = await this.#d.worktrees.fingerprint(node.worktree);
      const diff = await this.#d.worktrees.diff(node.worktree);
      this.#doing.set(reviewer, `Reviewing ${providerName(node.owner)}'s ${node.plan.title}`);
      this.#progress(`${providerName(reviewer)} — reviewing ${node.plan.title}`);
      const prior: RefFinding[] = node.openFindings.map((f) => ({
        ...f.finding,
        ref: f.ref,
        status: f.status,
      }));
      const reviewed = await this.#reviewOrSkip(reviewer, "reviewer", {
        step: "review",
        unit: node.plan.key,
        round,
        cwd: node.worktree.path,
        worktree: node.worktree,
        prompt: (p) =>
          codeReviewPrompt(
            spec,
            node.plan,
            diff,
            providerName(p),
            [...this.#nodes.values()]
              .filter((other) => other !== node)
              .map((other) => ({ ...other.plan, owner: providerName(other.owner) })),
            prior,
            this.#context(buildMessage ? [buildMessage] : []),
          ),
        access: "read-only",
        outputSchema: reviewSchema(this.#roles?.builders ?? this.#participants),
        // Reviews are always fresh: an independent look (§2).
        exclude: [...node.authoredBy],
        route: {
          complexity: node.plan.complexity,
          risk: node.plan.risk,
          disputedFindings: node.openFindings.length,
        },
      });
      await recording;
      if (!reviewed) {
        // The reviewer ran out of usage and nobody else may review it: the
        // unit goes on unreviewed and the job cannot PASS (§5).
        this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);
        await this.#nodeStatus(node, "approved");
        this.#doing.delete(node.owner);
        this.#doing.delete(reviewer);
        return;
      }
      // The review only counts for the code it was shown.
      if ((await this.#d.worktrees.fingerprint(node.worktree)) !== fingerprint) {
        throw new Stop(
          "BLOCKED",
          `${node.plan.title} changed while it was being reviewed.`,
          "changed_during_review",
        );
      }
      node.reviewedBy.add(reviewed.provider);
      const review = reviewed.structured as Review;
      reviewMessage = await this.#message(reviewed, node.owner, "review", round, {
        node: node.plan.key,
        replyTo: buildMessage?.id ? { kind: "message", id: buildMessage.id } : null,
      });

      // Earlier findings: what the reviewer says became of each. One it no
      // longer mentions is resolved (it is not raised again); one it says is
      // still open stays open, and a disputed one stays disputed.
      const verdicts = new Map(
        (review.priorFindings ?? [])
          .filter((p) => p && typeof p.ref === "string")
          .map((p) => [p.ref, p.status]),
      );
      const kept: TrackedFinding[] = [];
      for (const old of node.openFindings) {
        const said = verdicts.get(old.ref);
        if (said === "open") {
          if (old.status === "fixed")
            await this.#setFindingStatus(old, "open", reviewed.runId, round);
          kept.push(old);
        } else if (said === "dismissed") {
          // The reviewer withdrew its own finding. A blocking or important one
          // is only dismissed with a recorded decision (the server insists).
          const serious =
            old.finding.severity === "blocking" || old.finding.severity === "important";
          const decisionNumber = serious
            ? await this.#decision(
                "Finding dismissed",
                `${providerName(reviewed.provider)} withdrew finding ${old.ref} on re-review.`,
                [reviewed.provider],
                { unit: node.plan.key, finding: old.ref },
                false,
              )
            : null;
          await this.#setFindingStatus(old, "dismissed", reviewed.runId, round, decisionNumber);
        } else {
          await this.#setFindingStatus(old, "resolved", reviewed.runId, round);
        }
      }
      node.openFindings = kept;
      for (const f of review.findings ?? []) {
        const tracked = await this.#finding(
          node.plan.key,
          round,
          "review",
          f,
          reviewed.provider,
          reviewed.runId,
          node.owner,
        );
        if (isSubstantive(f)) node.openFindings.push(tracked);
      }
      this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);

      const stillOpen = kept.some((f) => isSubstantive(f.finding));
      if (effectiveVerdict(review) === "APPROVED" && !stillOpen) {
        await this.#nodeStatus(node, "approved");
        this.#doing.delete(node.owner);
        this.#doing.delete(reviewer);
        return;
      }
      // BLOCKED and REVISE both go back to the owner. A code reviewer's
      // "blocked" means "this must not ship as it is", which is exactly what
      // the fix loop is for -- in a real run it was a one-line export fix.
      // The review budget still bounds it, and an exhausted budget fails the
      // unit rather than passing it.
      node.failures++;
      fixing = node.openFindings;
      await this.#nodeStatus(node, "changes_requested");
    }

    // Budget spent with substantive findings still open. Reported, never waved through.
    await this.#nodeStatus(node, "failed");
  }

  /**
   * A code change card (§4): the unit's real diffstat from git and its diff
   * (stored by the server as the diff artifact), tied to the builder's run.
   * A change is only ever attributed to a recorded run: without one, no card.
   */
  async #recordChange(node: NodeState, built: CallResult): Promise<void> {
    if (!built.runId) return;
    const record = node.worktree!;
    const stat = await this.#d.worktrees.diffStat(record);
    const head = await this.#d.worktrees.head(record);
    // Files that commonly hold secrets are left out of the shared diff by git
    // itself and named only; the rest is redacted before it is sent.
    const diff = await this.#d.worktrees.sharedDiff(record, 500 * 1024);
    const hidden = diff.excluded.length
      ? `${diff.excluded.length} file${diff.excluded.length === 1 ? "" : "s"} not shown: ${diff.excluded
          .slice(0, 20)
          .map((f) => redactText(f, 200))
          .join(", ")}\n\n`
      : "";
    await this.#write(
      OPS_0_10.addChange,
      changePayload({
        nodeKey: node.plan.key,
        runId: built.runId,
        filesChanged: stat.filesChanged,
        insertions: stat.insertions,
        deletions: stat.deletions,
        files: stat.files.map((f) => redactText(f, 400)),
        branch: record.branch,
        commit: head,
        // ThreadLink runs the owner's tests at integration, not per unit; an
        // agent's own claim about tests is not evidence.
        tests: [],
        diff: hidden + redactText(diff.text, 600_000),
      }),
    );
  }

  /**
   * A unit that depends on others must see their work: a backend that builds on
   * a schema needs the schema. Its worktree therefore starts from the job's base
   * with each dependency's approved branch merged in, and everything after that
   * point -- the diff its reviewer sees, the scope check -- is measured from
   * there, so the dependencies' own changes are not reviewed twice or undone.
   */
  async #startFromDependencies(record: WorktreeRecord, node: NodeState): Promise<WorktreeRecord> {
    const order = this.#d.graph.integrationOrder(
      [...this.#nodes.values()].map((n) => toGraphNode(n.plan)),
    );
    const wanted = new Set(this.#deps.get(node.plan.key) ?? []);
    let merged = false;
    for (const key of order) {
      if (!wanted.has(key)) continue;
      const dep = this.#nodes.get(key);
      if (!dep?.worktree || !dep.commits.length) continue;
      const result = await this.#d.worktrees.merge(
        record,
        dep.worktree.branch,
        `Start ${node.plan.title} from ${dep.plan.title}`,
      );
      if (!result.ok) {
        await this.#decision(
          "Unit cannot start from its dependency",
          `${node.plan.title} and ${dep.plan.title} conflict in ${result.conflicts.join(", ") || "unknown files"}.`,
          [],
          { unit: node.plan.key, dependency: key, conflicts: result.conflicts },
          true,
        );
        throw new Stop(
          "NEEDS_USER_DECISION",
          `${node.plan.title} conflicts with ${dep.plan.title}, which it depends on. ThreadLink will not resolve that on its own.`,
          "merge_conflict",
        );
      }
      merged = true;
    }
    if (!merged) return record;
    return { ...record, base: await this.#d.worktrees.head(record) };
  }

  // -------------------------------------------------------------------------
  // Integrate
  // -------------------------------------------------------------------------

  async #integrate(
    set: Awaited<ReturnType<WorktreeManager["begin"]>>,
    integrator: AgentProvider = this.#roleOf("integrator"),
  ): Promise<{ record: WorktreeRecord; integrator: AgentProvider }> {
    if (this.#control === "stop_before_integration") {
      await this.#ackControl("stop_before_integration");
      throw new Stop(
        "NEEDS_USER_DECISION",
        "Stopped by you before integration. Each unit's work is on its own branch.",
        "stopped_by_owner",
      );
    }
    await this.#setStatus("integrating", "Integrating");
    const record = await this.#d.worktrees.create(set, "integration");
    this.#evidence.integrationBranch = record.branch;

    const order = this.#d.graph.integrationOrder(
      [...this.#nodes.values()].map((n) => toGraphNode(n.plan)),
    );
    for (const key of order) {
      const node = this.#nodes.get(key)!;
      if (!node.worktree || !node.commits.length) {
        await this.#nodeStatus(node, "integrated");
        continue;
      }
      const merged = await this.#d.worktrees.merge(
        record,
        node.worktree.branch,
        `Integrate ${node.plan.title}`,
      );
      if (!merged.ok) {
        // Resolving a conflict is a decision about intent. Not ours to guess.
        await this.#decision(
          "Merge conflict",
          `${node.plan.title} conflicts in ${merged.conflicts.join(", ") || "unknown files"}.`,
          [],
          { conflicts: merged.conflicts },
          true,
        );
        throw new Stop(
          "NEEDS_USER_DECISION",
          `${node.plan.title} conflicts with work already integrated (${merged.conflicts.join(", ")}). ThreadLink will not resolve a conflict on its own.`,
          "merge_conflict",
        );
      }
      this.#evidence.commits.push(merged.commit);
      await this.#nodeStatus(node, "integrated");
      // Tests after every meaningful integration step, not only at the end.
      await this.#runTests(record, `after integrating ${node.plan.title}`);
    }
    return { record, integrator };
  }

  async #runTests(record: WorktreeRecord, when: string): Promise<void> {
    if (!this.#job.verifyCommands.length) return;
    const results = await this.#d.verify(record.path, this.#job.verifyCommands, {
      timeoutMs: this.#timeout("verify"),
    });
    this.#evidence.tests = results.map((r) => ({ ...r, output: redactText(r.output, 4_000) }));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      throw new Stop(
        "NEEDS_FIX",
        `Tests failed ${when}: ${failed.map((r) => r.command).join(", ")}.`,
        "tests_failed",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Inspect
  // -------------------------------------------------------------------------

  async #inspect(
    spec: TeamSpec,
    integration: { record: WorktreeRecord; integrator: AgentProvider },
  ): Promise<TeamOutcome> {
    const fingerprint = await this.#d.worktrees.fingerprint(integration.record);
    this.#evidence.diffFingerprint = fingerprint;

    if (!this.#job.verifyCommands.length) {
      this.#evidence.uncertainty.push(
        "No test commands were given, so ThreadLink ran no tests of its own.",
      );
    }

    if (!this.#job.policy.finalInspection) {
      return this.#verdict("PASS", "Integrated. Final inspection was turned off for this room.");
    }

    await this.#setStatus("inspecting", "Final inspection");
    // Never the integrator, and always a fresh session: no memory of building it.
    const inspector = this.#reviewerFor(integration.integrator);
    this.#doing.set(inspector, "Inspecting the whole change");
    const diff = await this.#d.worktrees.diff(integration.record, 400_000);
    const inspected = await this.#reviewOrSkip(inspector, "security_reviewer", {
      step: "inspection",
      unit: null,
      round: this.#reviewRound,
      cwd: integration.record.path,
      worktree: integration.record,
      prompt: (p) =>
        inspectionPrompt(
          spec,
          diff,
          testEvidence(this.#evidence.tests),
          providerName(p),
          this.#context([]),
        ),
      access: "read-only",
      outputSchema: INSPECTION_SCHEMA,
      exclude: [integration.integrator],
      route: {
        complexity: "high",
        risk: { security: true, database: false, architecture: true, deployment: false },
      },
    });
    if (!inspected) {
      return this.#verdict(
        "PASS",
        "Integrated. The final inspection is waiting: the inspector's included usage ran out.",
      );
    }
    this.#inspector = inspected.provider;
    if ((await this.#d.worktrees.fingerprint(integration.record)) !== fingerprint) {
      throw new Stop(
        "BLOCKED",
        "The integrated change moved during the final inspection.",
        "changed_during_review",
      );
    }
    const inspection = inspected.structured as Inspection;
    await this.#message(inspected, integration.integrator, "review", this.#reviewRound);
    for (const f of inspection.findings) {
      await this.#finding(
        null,
        this.#reviewRound,
        "inspection",
        f,
        inspected.provider,
        inspected.runId,
      );
    }
    this.#evidence.uncertainty.push(...inspection.uncertainty.map((u) => redactText(u, 500)));

    // The model's PASS is necessary, not sufficient.
    const substantive = inspection.findings.filter(isSubstantive);
    const unmet = inspection.requirementsMet.filter((r) => !r.met);
    const testsFailed = this.#evidence.tests.some((t) => !t.ok);
    let verdict: JobVerdict = inspection.verdict;
    if (verdict === "PASS" && (substantive.length || unmet.length || testsFailed)) {
      verdict = "NEEDS_FIX";
    }
    return this.#verdict(
      verdict,
      redactText(inspection.summary, 1_000),
      verdict === "PASS" ? undefined : "inspection_found_issues",
    );
  }

  #verdict(verdict: JobVerdict, summary: string, reason?: VerdictReason): TeamOutcome {
    return { verdict, summary, reason, evidence: this.#evidence, units: this.#units() };
  }

  #units(): UnitSummary[] {
    return [...this.#nodes.values()].map((n) => ({
      key: n.plan.key,
      title: n.plan.title,
      owner: n.owner,
      reviewer: n.reviewer,
      status: n.status,
      authoredBy: [...n.authoredBy],
      reviewedBy: [...n.reviewedBy],
    }));
  }

  // -------------------------------------------------------------------------
  // Agent calls
  // -------------------------------------------------------------------------

  #timeout(step: StepKind): number {
    return this.#d.timeoutMs ?? stepTimeoutMs(step, this.#job.timeouts ?? {});
  }

  /**
   * Runs one step with an agent, as recorded runs. A failure that is not about
   * safety (usage, sign-in, a provider error, a timeout) becomes the owner's
   * choice -- retry, another agent, more time, or stop -- and the job waits
   * for it. Nothing is ever retried on another provider unless the owner
   * chose that. Without a server that takes choices, the job stops, as before.
   */
  async #call(provider: AgentProvider, role: TeamRole, options: CallOptions): Promise<CallResult> {
    let current = provider;
    let timeoutMs = this.#timeout(options.step);
    let signInRetried = false;
    for (let attempt = 1; ; attempt++) {
      const result = await this.#runOnce(current, role, options, timeoutMs);
      if (result.ok) {
        await this.#afterStep(options.step);
        return result;
      }
      if (this.#stopNow) throw this.#stopped();
      if (this.#abort.signal.aborted) {
        throw new Stop("BLOCKED", `${providerName(current)} was stopped.`, "agent_failed");
      }
      this.#noteFailure(current, result);
      if (result.failure === "quota_exhausted") {
        const action = await this.#onExhausted(current, role, options, result, attempt);
        if (action.action === "other") {
          current = action.provider;
          continue;
        }
        if (action.action === "retry") continue;
        if (action.action === "skip") throw new ReviewSkipped(current);
        if (this.#stopNow) throw this.#stopped();
        if (action.why === "owner") {
          throw new Stop(
            "NEEDS_USER_DECISION",
            `Stopped by you after ${providerName(current)} ran out of included usage.`,
            "stopped_by_owner",
            current,
          );
        }
        throw this.#failureStop(current, result);
      }
      // A sign-in failure can be a one-off token refresh failure. Probe the
      // SAME provider now; only if it answers ready is the call repeated once.
      if (result.failure === "not_authenticated" && !signInRetried && this.#d.health?.confirm) {
        signInRetried = true;
        const now = await this.#d.health.confirm(current).catch(() => "unknown" as const);
        if (now === "ready") continue;
      }
      const decision = await this.#decideOnFailure(
        current,
        role,
        options,
        result,
        timeoutMs,
        attempt,
      );
      if (!decision) throw this.#failureStop(current, result);
      if (decision.action === "retry") continue;
      if (decision.action === "other") {
        current = decision.provider;
        continue;
      }
      if (decision.action === "increase") {
        timeoutMs = decision.timeoutMs;
        continue;
      }
      throw new Stop(
        "NEEDS_USER_DECISION",
        `Stopped by you after ${providerName(current)} could not finish.`,
        "stopped_by_owner",
        current,
      );
    }
  }

  /**
   * A review step that may be skipped when its reviewer runs out of usage and
   * nobody else may review (§5): null then, and the review is pending.
   */
  async #reviewOrSkip(
    provider: AgentProvider,
    role: TeamRole,
    options: CallOptions,
  ): Promise<CallResult | null> {
    // Out of usage since the start of the job, and the owner's policy left its
    // reviews pending: it is not run at all.
    if (this.#pendingReviewers.has(provider)) {
      this.#reviewPending.add(provider);
      return null;
    }
    try {
      return await this.#call(provider, role, options);
    } catch (error) {
      if (!(error instanceof ReviewSkipped)) throw error;
      this.#reviewPending.add(error.provider);
      return null;
    }
  }

  /**
   * A provider ran out of included usage during a step (§5). The job's
   * failover policy decides: another ready agent takes the step (auto), the
   * owner is asked (ask), or the step waits for the provider (wait). A review
   * nobody else may do is skipped and left pending. The exhausted provider is
   * only run again after a fresh check says it is ready.
   */
  async #onExhausted(
    provider: AgentProvider,
    role: TeamRole,
    options: CallOptions,
    result: AgentRunResult,
    attempt: number,
  ): Promise<FailoverAction> {
    const resetsAt = result.resetsAt ?? null;
    this.#resets.set(provider, resetsAt);
    this.#health.set(provider, "usage_exhausted");
    const ready = (p: AgentProvider) =>
      p !== provider &&
      this.#d.runners[p] !== undefined &&
      (this.#health.get(p) ?? "ready") === "ready";
    const excluded = new Set(options.exclude ?? []);
    const strict = this.#participants.filter((p) => ready(p) && !excluded.has(p));
    const loose = this.#participants.filter(ready);
    const review = REVIEW_STEPS.has(options.step);
    const key = `${this.#worktreeJob()}:${options.step}:${options.unit ?? "job"}:r${options.round}:${provider}:${role}:q${attempt}`;
    return handleExhausted(
      {
        provider,
        resetsAt,
        policy: this.#job.failoverPolicy ?? "ask",
        // A review goes to another independent reviewer only; building and
        // planning may pass to any ready agent (whose own work then cannot be
        // reviewed by itself -- see the independence guard in #buildNode).
        alternatives: review ? strict : strict.length ? strict : loose,
        reviewPending: review && !strict.length ? { continueWith: loose[0] ?? null } : null,
        params: {
          step: options.step,
          role,
          unit: this.#choiceUnit(options.unit),
        },
        key,
      },
      {
        write: (op, payload) => this.#write(op as TeamOp, payload),
        recheck: this.#d.health?.confirm ? (p) => this.#d.health!.confirm!(p) : undefined,
        clock: this.#d.clock ?? realClock,
        signal: this.#abort.signal,
        choicePollMs: this.#d.choicePollMs,
        choiceWaitMs: this.#d.choiceWaitMs,
        noticesSent: this.#d.noticesSent,
        chatId: this.#job.chatId ?? null,
        onRecovered: (p) => {
          this.#health.set(p, "ready");
          this.#d.onRecovered?.(p);
        },
      },
    );
  }

  /** One agent run: run_started, the run, run_finished, usage. */
  async #runOnce(
    provider: AgentProvider,
    role: TeamRole,
    options: CallOptions,
    timeoutMs: number,
  ): Promise<CallResult> {
    const runner = this.#d.runners[provider];
    if (!runner) {
      throw new Stop(
        "BLOCKED",
        `${providerName(provider)} is not available. It was not replaced.`,
        "agent_unavailable",
        provider,
      );
    }
    const route = this.#d.route({
      provider,
      role,
      complexity: options.route.complexity,
      risk: options.route.risk,
      previousFailures: options.route.previousFailures ?? 0,
      disputedFindings: options.route.disputedFindings ?? 0,
    });
    if (!route.ok) {
      await this.#decision(
        "No model to use",
        `${providerName(provider)}: ${route.reason}`,
        [],
        { options: route.options },
        true,
      );
      throw new Stop("NEEDS_USER_DECISION", route.reason, "no_suitable_model");
    }
    const caps = this.#caps(provider);
    const participantKey = `${provider}:${role}`;

    // Anything the owner has said to this agent since its last turn goes into
    // this one, delimited and redacted (prompts.ts, withOwnerNotes).
    const contextStart = performance.now();
    await this.#collectNotes();
    const notes = this.#takeNotes(provider);
    const prompt = withOwnerNotes(options.prompt(provider), notes, (text) =>
      redactText(text, 4_000),
    );

    // Continuity (§2): only this participant's own session for the same key
    // in this job, and only when the provider can resume. Never across chats.
    const sessionKey = options.session ? `${participantKey}|${options.session}` : null;
    const previous = sessionKey ? this.#sessions.get(sessionKey) : undefined;
    const resume =
      previous && caps?.nativeSession.resume && previous.chatId === (this.#job.chatId ?? null)
        ? previous
        : undefined;

    const contextMs = Math.round(performance.now() - contextStart);
    const runKey = this.#runKey(options, participantKey);
    const write = options.access === "workspace-write" || WRITE_STEPS.has(options.step);
    this.#d.journal?.stepStarted({
      runKey,
      kind: options.step,
      write,
      provider,
      startedAt: new Date().toISOString(),
    });
    let started: Record<string, unknown>;
    const persistStart = performance.now();
    try {
      started = await this.#write(
        OPS_0_10.runStarted,
        runStartedPayload({
          runKey,
          provider,
          participantKey,
          role,
          requestedModel: route.model,
          effort: route.effort,
          access: options.access,
          nodeKey: options.unit,
          worktreeLabel: options.worktree
            ? redactText(`${this.#job.roomName} / ${options.worktree.key}`, 120)
            : null,
          timeoutMs,
          continuity: resume ? "resumed" : "fresh",
          resumedFromRunKey: resume?.runKey ?? null,
          activity: phaseActivity(options.step),
        }),
      );
    } catch (error) {
      // Nothing started: the journal must not remember a running step.
      this.#d.journal?.stepFinished(runKey, false);
      // A re-claimed job whose earlier attempt ran a write step: the server
      // refuses new write runs until the owner answers (§6). That is an
      // interruption for the owner, never a failure to work around.
      if (write && isInterruptedRefusal(error))
        throw new InterruptedRefusal(options.step, provider);
      throw error;
    }
    const runId = parseRunId(started);
    const persistMs = Math.round(performance.now() - persistStart);
    if (notes.length && runId) await this.#consumeNotes(runId, notes);

    // Live activity from real signals only: the run's phase now, and the
    // provider's own events if its capabilities say it streams them.
    const reporter = runId
      ? new ActivityReporter(
          async (activity) => {
            await this.#write(OPS_0_10.runActivity, runActivityPayload(runId, activity));
          },
          { clock: this.#d.activityClock, minIntervalMs: this.#d.activityMinIntervalMs },
        )
      : null;
    // run_started carried the phase activity; provider events follow, rate-limited.
    reporter?.primed();
    const poll =
      (this.#d.controlPollMs ?? 15_000) > 0
        ? setInterval(() => void this.#pollControl(), this.#d.controlPollMs ?? 15_000)
        : null;

    let result: AgentRunResult;
    try {
      result = await runner.run({
        provider,
        role,
        cwd: options.cwd,
        prompt,
        model: route.model,
        effort: route.effort ?? undefined,
        access: options.access,
        outputSchema: options.outputSchema,
        resumeThreadId: resume?.sessionId,
        timeoutMs,
        signal: this.#abort.signal,
        onActivity: caps?.activity === "events" && reporter ? (a) => reporter.signal(a) : undefined,
        onProcess: this.#d.processes
          ? {
              started: (child) =>
                this.#d.processes!.started(
                  {
                    pid: child.pid!,
                    provider,
                    runId,
                    jobId: this.#job.jobId,
                    startedAt: new Date().toISOString(),
                  },
                  child,
                ),
              exited: (pid) => this.#d.processes!.exited(pid),
            }
          : undefined,
      });
    } catch (error) {
      // A runner that throws is a crash, recorded as one; the job then stops.
      if (runId) {
        await this.#write(
          OPS_0_10.runFinished,
          runFinishedPayload({
            runId,
            status: "failed",
            observedModel: null,
            modelVerified: false,
            accessVerified: false,
            nativeSessionId: null,
            nativeSessionKind: null,
            failure: "crashed",
            exitClean: false,
          }),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      if (poll) clearInterval(poll);
      await reporter?.stop();
    }

    // What ThreadLink can verify about the run, before anything is used.
    const verifies =
      Boolean(runner.verifiesAccess) || caps?.accessVerification === "provider_reported";
    let accessProblem: Stop | null = null;
    let clean: boolean | null = null;
    if (result.ok) {
      if (verifies && !result.accessVerified) {
        accessProblem = new Stop(
          "BLOCKED",
          `${providerName(provider)} could not confirm it ran with ${options.access} access, so its work was not used.`,
          "access_mismatch",
        );
      } else if (options.access === "read-only") {
        clean = options.worktree ? await this.#d.worktrees.isClean(options.worktree) : false;
        if (!options.worktree) {
          accessProblem = new Stop(
            "BLOCKED",
            "A read-only run had no workspace ThreadLink could check afterwards.",
            "access_mismatch",
          );
        } else if (!clean) {
          accessProblem = new Stop(
            "BLOCKED",
            `${providerName(provider)} changed files during a read-only ${
              options.worktree.key === "planning" ? "planning" : "review"
            } step, so its work was not used.`,
            "access_mismatch",
          );
        }
      }
    }
    const accessVerified = verifies
      ? result.accessVerified && clean !== false
      : options.access === "read-only" && clean === true;
    // Only the runner can say the model was verified: it compared the two.
    const modelVerified = result.modelVerified === true && Boolean(result.observedModel);
    const unstructured =
      result.ok &&
      !accessProblem &&
      (result.structured === undefined || result.structured === null);
    const completed = result.ok && !accessProblem && !unstructured;
    const end = completed
      ? null
      : accessProblem
        ? ({ status: "failed", failure: "access_mismatch" } as const)
        : unstructured
          ? ({ status: "failed", failure: "provider_error" } as const)
          : runEnd(result);

    if (runId) {
      const t = result.timings;
      const timings: Partial<RunTimings> = {
        ...(this.#d.queueMs != null ? { queueMs: this.#d.queueMs } : {}),
        contextMs,
        persistMs,
        ...(t ? { spawnMs: t.spawnMs, providerMs: t.providerMs } : {}),
        ...(t?.firstEventMs != null ? { firstEventMs: t.firstEventMs } : {}),
      };
      await this.#write(
        OPS_0_10.runFinished,
        runFinishedPayload({
          runId,
          status: end?.status ?? "completed",
          observedModel: result.observedModel,
          modelVerified,
          accessVerified,
          nativeSessionId: caps?.nativeSession.exposed ? result.threadId : null,
          nativeSessionKind: caps?.nativeSession.kind ?? null,
          failure: end?.failure ?? null,
          exitClean: result.ok,
          timings,
        }),
      );
    }
    this.#d.journal?.stepFinished(runKey, completed && !write);

    await this.#write("record_usage", {
      provider,
      role,
      requestedModel: route.model,
      observedModel: result.observedModel,
      effort: result.observedEffort ?? route.effort,
      modelClass: route.modelClass,
      reason: route.reason,
      escalatedFrom: route.escalatedFrom ?? null,
      escalationReason: route.escalationReason ?? null,
      outcome: result.ok
        ? "ok"
        : result.failure === "cancelled"
          ? "provider_error"
          : (result.failure ?? "provider_error"),
    });

    if (sessionKey && result.threadId && caps?.nativeSession.exposed) {
      this.#sessions.set(sessionKey, {
        sessionId: result.threadId,
        runKey,
        chatId: this.#job.chatId ?? null,
      });
    }
    if (accessProblem) throw accessProblem;
    if (unstructured) {
      throw new Stop(
        "BLOCKED",
        `${providerName(provider)} did not answer in the required format, so its answer was not guessed at.`,
        "agent_failed",
      );
    }
    return { ...result, structured: result.structured, provider, role, participantKey, runId };
  }

  /** The unit a choice names: none in solo/pair, whose single unit is the whole job. */
  #choiceUnit(unit: string | null): string | null {
    return this.#mode === "team" ? unit : null;
  }

  /** A unique, deterministic key per run: job, start, step, unit, round, participant. */
  #runKey(options: CallOptions, participantKey: string): string {
    const base = [
      this.#worktreeJob(),
      options.step,
      options.unit ?? "job",
      `r${options.round}`,
      participantKey,
    ].join(":");
    for (let n = 1; ; n++) {
      const key = `${base}:a${n}`;
      if (!this.#runKeys.has(key)) {
        this.#runKeys.add(key);
        return key;
      }
    }
  }

  /** Tells the server which run consumed which owner notes (§5 delivery: seen). */
  async #consumeNotes(runId: string, notes: OwnerNote[]): Promise<void> {
    const payload = notesConsumedPayload(
      runId,
      notes.map((n) => n.id),
    );
    if (!payload) return;
    try {
      const answer = await this.#write(READ_OWNER_NOTES_OP, payload);
      this.#queueNotes(answer);
    } catch {
      this.#evidence.uncertainty.push(
        "ThreadLink could not record which agent saw your notes, so their delivery state may be out of date.",
      );
    }
  }

  /** Health and usage learn from every failed run at once. */
  #noteFailure(provider: AgentProvider, result: AgentRunResult): void {
    try {
      if (result.failure !== "cancelled") {
        this.#d.health?.noteFailure?.(provider, result.failure ?? "provider_error", {
          resetsAt: result.resetsAt ?? null,
        });
      }
    } catch {
      /* health reporting must never change how the job ends */
    }
    if (result.failure === "quota_exhausted")
      this.#d.onExhausted?.(provider, result.requestedModel, result.resetsAt ?? null);
  }

  /**
   * The owner's choice after a failed run (§4, §6), or null when this failure
   * is not one to ask about (model or sandbox mismatch, not installed: those
   * stop the job) or the server takes no choices.
   */
  async #decideOnFailure(
    provider: AgentProvider,
    role: TeamRole,
    options: CallOptions,
    result: AgentRunResult,
    timeoutMs: number,
    attempt: number,
  ): Promise<
    | { action: "retry" }
    | { action: "other"; provider: AgentProvider }
    | { action: "increase"; timeoutMs: number }
    | { action: "stop" }
    | null
  > {
    const failure = result.failure ?? "provider_error";
    if (!["quota_exhausted", "not_authenticated", "provider_error", "timeout"].includes(failure)) {
      return null;
    }
    const excluded = new Set<AgentProvider>([provider, ...(options.exclude ?? [])]);
    const other =
      this.#participants.find(
        (p) =>
          !excluded.has(p) &&
          this.#d.runners[p] !== undefined &&
          (this.#health.get(p) ?? "ready") === "ready",
      ) ?? null;
    const key = `${this.#worktreeJob()}:${options.step}:${options.unit ?? "job"}:r${options.round}:${provider}:${role}:c${attempt}`;
    if (failure === "timeout") {
      const more = increasedTimeoutMs(timeoutMs);
      const choice = await this.#ask(
        "timeout",
        {
          provider,
          otherProvider: other,
          role,
          step: options.step,
          unit: this.#choiceUnit(options.unit),
          minutes: Math.round(timeoutMs / MINUTE),
        },
        [
          "retry",
          ...(other ? (["retry_other"] as const) : []),
          ...(more ? (["increase_timeout"] as const) : []),
          "stop",
        ],
        key,
        (result as Partial<CallResult>).runId ?? null,
      );
      if (choice === null) return null;
      if (choice === "expired") {
        throw new Stop(
          "NEEDS_FIX",
          `${providerName(provider)} timed out after ${Math.round(timeoutMs / MINUTE)} min and no decision was made within 24 hours.`,
          "agent_timed_out",
          provider,
        );
      }
      if (choice === "retry") return { action: "retry" };
      if (choice === "retry_other" && other) return { action: "other", provider: other };
      if (choice === "increase_timeout" && more) return { action: "increase", timeoutMs: more };
      return { action: "stop" };
    }
    const choice = await this.#ask(
      "provider_failure",
      {
        provider,
        otherProvider: other,
        role,
        step: options.step,
        unit: this.#choiceUnit(options.unit),
        failure,
      },
      [
        // §5: a provider that is out of usage is never simply retried.
        ...(this.#health.get(provider) === "usage_exhausted" ? [] : (["retry"] as const)),
        ...(other ? (["use_other"] as const) : []),
        "stop",
      ],
      key,
      (result as Partial<CallResult>).runId ?? null,
    );
    if (choice === null) return null;
    if (choice === "expired") {
      throw new Stop(
        "NEEDS_FIX",
        `${providerName(provider)} could not continue and no decision was made within 24 hours.`,
        "agent_failed",
        provider,
      );
    }
    if (choice === "retry" && this.#health.get(provider) !== "usage_exhausted") {
      return { action: "retry" };
    }
    if (choice === "use_other" && other) return { action: "other", provider: other };
    return { action: "stop" };
  }

  /**
   * Creates a choice for the owner and waits for it (§4): the key they chose,
   * "expired" after the wait, or null when the server takes no choices (the
   * caller then stops, as it did before choices existed).
   */
  async #ask<K extends "provider_failure" | "timeout" | "plan_disagreement">(
    kind: K,
    params: Record<string, string | number | null>,
    options: readonly string[],
    idempotencyKey: string,
    runId: string | null = null,
  ): Promise<string | "expired" | null> {
    let choiceId: string | null;
    try {
      choiceId = parseChoiceId(
        await this.#write(
          OPS_0_10.requestChoice,
          requestChoicePayload(kind, params, options as never, idempotencyKey, runId),
        ),
      );
    } catch {
      return null;
    }
    if (!choiceId) return null;
    this.#progress("Waiting for your decision");
    const clock = this.#d.clock ?? realClock;
    const deadline = clock.now() + (this.#d.choiceWaitMs ?? 24 * 60 * MINUTE);
    for (;;) {
      if (this.#stopNow) throw this.#stopped();
      const answer = await this.#write(OPS_0_10.readChoices, readChoicesPayload([choiceId]));
      const state = parseChoices(answer).find((c) => c.id === choiceId);
      if (this.#stopNow) throw this.#stopped();
      if (state?.status === "chosen") {
        const chosen =
          state.chosenKey && options.includes(state.chosenKey) ? state.chosenKey : "stop";
        // The job goes back to the phase it was in.
        if (chosen !== "stop") await this.#setStatus(this.#phase, "Continuing after your decision");
        return chosen;
      }
      if (state?.status === "expired") return "expired";
      if (state?.status === "cancelled") return "stop";
      if (clock.now() >= deadline) return "expired";
      await clock.sleep(this.#d.choicePollMs ?? 15_000, this.#abort.signal);
      if (this.#abort.signal.aborted) {
        if (this.#stopNow) throw this.#stopped();
        throw new Stop(
          "BLOCKED",
          "The job was stopped while waiting for your decision.",
          "agent_failed",
        );
      }
    }
  }

  /** Every provider failure that is not the owner's choice stops the job. None is answered by switching provider. */
  #failureStop(provider: AgentProvider, result: AgentRunResult): Stop {
    const name = providerName(provider);
    switch (result.failure) {
      case "quota_exhausted":
        return new Stop(
          "NEEDS_USER_DECISION",
          `${name} usage is exhausted. ThreadLink is waiting rather than switching agents or paying for more. You can wait for the reset, continue with the other agent only, or choose a smaller model.`,
          "usage_exhausted",
          provider,
        );
      case "model_mismatch":
        return new Stop(
          "BLOCKED",
          `${name} ran ${result.observedModel ?? "a different model"} instead of ${result.requestedModel}. ThreadLink does not accept a model it did not choose.`,
          "model_mismatch",
        );
      case "access_mismatch":
        return new Stop(
          "BLOCKED",
          `${name} did not run with the sandbox ThreadLink asked for.`,
          "access_mismatch",
        );
      case "not_authenticated":
        return new Stop(
          "BLOCKED",
          `${name} needs you to sign in again on this computer.`,
          "agent_needs_sign_in",
          provider,
        );
      case "not_installed":
        return new Stop(
          "BLOCKED",
          `${name} is not installed on this computer.`,
          "agent_unavailable",
          provider,
        );
      case "timeout":
        return new Stop("NEEDS_FIX", `${name} did not finish in time.`, "agent_timed_out");
      default:
        return new Stop(
          "BLOCKED",
          `${name} failed: ${redactText(result.error ?? "no detail", 300)}`,
          "agent_failed",
        );
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async #write(op: TeamOp, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answer = (await this.#d.sink(op, payload)) ?? {};
    // Every answer carries the job's state, including the owner's control.
    this.#applyControl(answer);
    return answer;
  }

  async #setStatus(status: string, line: string): Promise<void> {
    this.#status = status;
    this.#phase = status;
    this.#d.journal?.phase(status);
    await this.#write("set_status", { status, line });
    this.#progress(line);
  }

  async #nodeStatus(node: NodeState, status: NodeStatus): Promise<void> {
    node.status = status;
    await this.#write("set_node_status", { key: node.plan.key, status });
    this.#progress(`${node.plan.title}: ${status.replace(/_/g, " ")}`);
  }

  /**
   * Posts a run's own `teamMessage` as that agent's chat message (§3), tied to
   * the run, replying to what it answers. Never composes text for an agent:
   * a run with no message of its own posts nothing.
   */
  async #message(
    run: CallResult,
    to: AgentProvider | "threadlink",
    type: string,
    round: number,
    options: { node?: string | null; replyTo?: WireRef | null; refs?: WireRef[] } = {},
  ): Promise<LoggedMessage | null> {
    const body = teamMessageOf(run.structured);
    if (!body) return null;
    const redacted = redactText(body);
    const answer = await this.#write(
      "add_message",
      messagePayload({
        sender: run.provider,
        senderRole: run.role,
        receiver: to,
        node: options.node ?? null,
        type,
        round,
        body: redacted,
        modelObserved: run.observedModel,
        runId: run.runId,
        replyTo: options.replyTo ?? null,
        refs: options.refs ?? [],
      }),
    );
    const logged: LoggedMessage = {
      id: parseMessageId(answer),
      from: run.provider,
      role: run.role,
      type,
      body: redacted,
      unit: options.node ?? null,
    };
    this.#messages.push(logged);
    return logged;
  }

  /** Scoped context for a prompt: decisions so far and the messages this step answers. */
  #context(messages: LoggedMessage[]): PromptContext {
    return {
      decisions: this.#decisionLog.slice(-20),
      messages: messages.map((m) => ({
        from: providerName(m.from),
        role: m.role,
        type: m.type,
        body: m.body,
      })),
    };
  }

  async #finding(
    node: string | null,
    round: number,
    phase: "planning" | "review" | "inspection",
    f: Finding,
    raisedBy: AgentProvider | "threadlink",
    runId: string | null,
    owner: AgentProvider | null = null,
  ): Promise<TrackedFinding> {
    const answer = await this.#write(
      "add_finding",
      findingPayload(
        {
          node,
          round,
          phase,
          severity: f.severity,
          category: f.category,
          summary: redactText(f.summary, 200),
          detail: redactText(f.detail),
          file: f.file,
          line: f.line,
          raisedBy,
        },
        { runId, ownerParticipant: owner ? `${owner}:builder` : null },
      ),
    );
    const tracked: TrackedFinding = {
      ref: `F${this.#findings.length + 1}`,
      id: parseFindingId(answer),
      finding: f,
      status: "open",
      unit: node,
      raisedBy,
    };
    this.#findings.push(tracked);
    return tracked;
  }

  async #setFindingStatus(
    f: TrackedFinding,
    status: FindingLifecycle,
    runId: string | null,
    round: number,
    decisionNumber: number | null = null,
  ): Promise<void> {
    if (f.status === status) return;
    f.status = status;
    if (!f.id) return;
    await this.#write(
      "set_finding_status",
      findingStatusPayload({ findingId: f.id, status, runId, round, decisionNumber }),
    );
  }

  /**
   * A decision in ThreadLink's own words (§4, title_source "threadlink"). The
   * server accepts only its fixed titles (wire.ts THREADLINK_DECISION_TITLES);
   * a decision with no fixed title is not sent -- it is kept in the job's
   * evidence instead, so nothing is lost and no title is bent to fit.
   */
  async #decision(
    topic: string,
    resolution: string,
    approvedBy: AgentProvider[],
    evidence: Record<string, unknown>,
    needsUser: boolean,
  ): Promise<number | null> {
    this.#decisionLog.push(redactText(`${topic}: ${resolution}`, 400));
    const title = threadlinkDecisionTitle(topic);
    if (!title) {
      this.#evidence.uncertainty.push(redactText(`${topic}: ${resolution}`, 500));
      return null;
    }
    // A question for the owner has no resolution yet: sending one would make
    // the server count it as settled. The explanation travels as evidence.
    const answer = await this.#write(
      "add_decision",
      decisionPayload(
        {
          topic: title,
          ...(needsUser ? {} : { resolution: redactText(resolution, 2_000) }),
          approvedBy,
          evidence: redactDeep(needsUser ? { ...evidence, question: resolution } : evidence),
          needsUser,
        },
        { titleSource: "threadlink" },
      ),
    );
    return parseDecisionNumber(answer);
  }

  async #finish(
    verdict: JobVerdict,
    summary: string,
    reason?: VerdictReason,
    provider: AgentProvider | null = null,
  ): Promise<void> {
    this.#finalVerdict = verdict;
    this.#finalReason = reason && verdict !== "PASS" ? reason : null;
    this.#status = verdict === "PASS" ? "completed" : verdict.toLowerCase();
    this.#doing.clear();
    // The report is a convenience: a failure to store it never holds up the verdict.
    await this.#write(
      OPS_0_10.addArtifact,
      artifactPayload({
        kind: "report",
        title: "Final report",
        mime: "text/markdown",
        content: this.#report(verdict, summary),
        runId: null,
        requestKey: `${this.#worktreeJob()}:final-report`,
      }),
    ).catch(() => {
      this.#evidence.uncertainty.push("ThreadLink could not store the final report for this job.");
    });
    const payload = setFinalPayload({
      verdict,
      summary: redactText(summary, 2_000),
      reason: this.#finalReason ?? undefined,
      provider: verdict === "PASS" ? null : provider,
      evidence: this.#evidence,
    });
    this.#d.journal?.finalComputed(JSON.parse(JSON.stringify(payload)));
    await this.#write("set_final", payload);
    this.#d.journal?.finalSynced(null);
    this.#progress(`${verdict}: ${summarize(summary) ?? verdict}`);
  }

  /** The final report (§4), from job data only. */
  #report(verdict: JobVerdict, summary: string): string {
    const roles = new Map<AgentProvider, Set<string>>();
    const add = (p: AgentProvider | null | undefined, r: string) => {
      if (!p) return;
      roles.set(p, (roles.get(p) ?? new Set()).add(r));
    };
    if (this.#roles && this.#mode === "team") {
      add(this.#roles.coordinator, "coordinator");
      add(this.#roles.planner, "planner");
      add(this.#roles.integrator, "integrator");
    }
    for (const n of this.#nodes.values()) {
      for (const p of n.authoredBy) add(p, "builder");
      for (const p of n.reviewedBy) add(p, "reviewer");
    }
    add(this.#inspector, "final inspector");
    const findings: ReportFinding[] = this.#findings.map((f) => ({
      severity: f.finding.severity,
      status: f.status,
      title: f.finding.summary,
      unit: f.unit,
      raisedBy: f.raisedBy === "threadlink" ? "ThreadLink" : providerName(f.raisedBy),
    }));
    return finalReportMarkdown({
      room: this.#job.roomName,
      verdict,
      summary,
      reason: this.#finalReason,
      mode: this.#mode,
      units: [...this.#nodes.values()].map((n) => ({
        key: n.plan.key,
        title: n.plan.title,
        owner: [...n.authoredBy].map((p) => providerName(p)).join(" + "),
        reviewer: n.reviewedBy.size
          ? [...n.reviewedBy].map((p) => providerName(p)).join(", ")
          : null,
        status: n.status,
      })),
      findings,
      tests: this.#evidence.tests.map((t) => ({
        command: t.command,
        ok: t.ok,
        exitCode: t.exitCode,
      })),
      agents: [...roles].map(([p, r]) => ({ name: providerName(p), roles: [...r] })),
      finalVerifier: this.#inspector ? providerName(this.#inspector) : null,
      integrationBranch: this.#evidence.integrationBranch,
      uncertainty: this.#evidence.uncertainty,
    });
  }

  #progress(line: string): void {
    this.#d.onProgress?.({
      jobId: this.#job.jobId,
      room: this.#job.roomName,
      goal: summarize(this.#job.goal) ?? "Team job",
      status: this.#status,
      verdict: this.#finalVerdict,
      line,
      units: [...this.#nodes.values()].map((n) => ({
        title: n.plan.title,
        owner: n.owner,
        reviewer: n.reviewer,
        status: n.status,
      })),
      agents: [...this.#doing].map(([provider, doing]) => ({ provider, doing })),
      openFindings: [...this.#nodes.values()].reduce((n, s) => n + s.openFindings.length, 0),
      reviewRound: this.#reviewRound,
      maxReviewRounds: this.#job.budgets.maxReviewRounds,
      stages: deriveStages({
        mode: this.#mode,
        phase: this.#phase,
        specDone: this.#specDone,
        planApproved: this.#planApproved,
        reviews: this.#mode === "pair" || (this.#mode === "team" && this.#job.policy.crossReview),
        units: [...this.#nodes.values()],
        verdict: this.#finalVerdict,
        reason: this.#finalReason,
      }),
    });
  }
}

/** A structured answer without its teamMessage (which is posted, not stored as data). */
function stripMessage<T extends { teamMessage?: string }>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const rest = { ...value };
  delete rest.teamMessage;
  return rest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redacts every string in an agent-written structure before it leaves this computer. */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value, 4_000) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}

/**
 * Paths that configure or instruct the agents, or run code on git operations.
 * A unit's scope never covers them.
 */
const PROTECTED_PATH = [
  /(^|\/)(CLAUDE|AGENTS)\.md$/i,
  /^\.claude(\/|$)/i,
  /^\.codex(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
  /^\.husky(\/|$)/i,
  /^\.githooks(\/|$)/i,
  /^\.gitmodules$/i,
  /^\.threadlink(\/|$)/i,
];

export function isProtectedPath(path: string): boolean {
  const normalised = path.split(String.fromCharCode(92)).join("/");
  return PROTECTED_PATH.some((pattern) => pattern.test(normalised));
}

function toGraphNode(n: PlannedNode): GraphNode {
  return { key: n.key, dependsOn: n.dependsOn, files: n.files };
}

/** Keys become branch and directory names, so they are normalised before use. */
function normalisePlan(plan: Plan): Plan {
  const keyOf = (k: string) =>
    k
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unit";
  return {
    ...plan,
    nodes: plan.nodes.map((n) => ({
      ...n,
      key: keyOf(n.key),
      dependsOn: n.dependsOn.map(keyOf),
    })),
  };
}

/** A unit title from the owner's goal: its first line, redacted, one line, bounded. */
function goalTitle(goal: string): string {
  const line = redactText(goal, 2_000)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!line) return "The requested change";
  return line.length <= 120 ? line : `${line.slice(0, 119).trimEnd()}…`;
}

/** Job ids are long; worktree and branch names use a short, still-unique form. */
function shortJob(jobId: string): string {
  return jobId.replace(/^tljob_/, "").slice(0, 12);
}

function testEvidence(tests: VerifyResult[]): string {
  if (!tests.length) return "No test commands were configured, so none were run.";
  return tests
    .map(
      (t) => `${t.ok ? "PASSED" : "FAILED"} (exit ${t.exitCode ?? "?"}): ${t.command}\n${t.output}`,
    )
    .join("\n\n");
}
