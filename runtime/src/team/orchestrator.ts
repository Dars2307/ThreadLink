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
 * Everything it depends on is injected, so each rule can be tested directly.
 */

import type { VerdictReason } from "./verdict-reasons.ts";
import { createHash } from "node:crypto";

import { redactText, summarize } from "../summary.ts";
import type { TeamJobDefinition } from "./job.ts";
import {
  BUILD_SCHEMA,
  INSPECTION_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  SPEC_SCHEMA,
  buildPrompt,
  codeReviewPrompt,
  effectiveVerdict,
  inspectionPrompt,
  isSubstantive,
  normalisePrompt,
  planPrompt,
  planReviewPrompt,
  withOwnerNotes,
  type BuildReport,
  type Finding,
  type Inspection,
  type Plan,
  type PlannedNode,
  type Review,
  type TeamSpec,
} from "./prompts.ts";
import type {
  AgentProvider,
  JobMode,
  JobVerdict,
  ModelClass,
  NodeStatus,
  TeamRole,
} from "./types.ts";
import {
  modelObserved,
  parseOwnerNotes,
  READ_OWNER_NOTES_OP,
  stopRequested,
  type OwnerNote,
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
  timeoutMs?: number;
  signal?: AbortSignal;
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
  permissionDenials: number;
  error?: string;
  failure?:
    | "model_mismatch"
    | "access_mismatch"
    | "quota_exhausted"
    | "not_authenticated"
    | "not_installed"
    | "timeout"
    | "provider_error";
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
  | typeof READ_OWNER_NOTES_OP;

export type OrchestratorDeps = {
  runners: Partial<Record<AgentProvider, AgentRunner>>;
  route(request: RouteRequest): RouteResult;
  graph: GraphPort;
  worktrees: WorktreeManager;
  verify(cwd: string, commands: string[]): Promise<VerifyResult[]>;
  sink: StateSink;
  /** Called whenever the concise state changes, for the desktop app's feed. */
  onProgress?(progress: TeamProgress): void;
  /** A provider ran out of included usage; remembered so the next job does not retry it. */
  onExhausted?(provider: AgentProvider, model: string): void;
  signal?: AbortSignal;
  timeoutMs?: number;
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
};

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

type NodeState = {
  plan: PlannedNode;
  owner: AgentProvider;
  /** Never the owner. Null only in a solo job, which has no reviewer. */
  reviewer: AgentProvider | null;
  status: NodeStatus;
  worktree: WorktreeRecord | null;
  threadId: string | null;
  failures: number;
  authoredBy: Set<AgentProvider>;
  reviewedBy: Set<AgentProvider>;
  commits: string[];
  openFindings: (Finding & { id: string | null })[];
  /**
   * The owner answered findings by changing nothing: it disagrees with them.
   * If the budget runs out that way, the two agents disagree, and that is a
   * decision for the owner of the project, not a routine "needs fix".
   */
  disputed: boolean;
};

/** A run that must stop the whole job, with the verdict it earns. */
class Stop extends Error {
  readonly verdict: JobVerdict;
  /** A fixed code the chat turns into a fixed sentence (never agent text). */
  readonly reason: VerdictReason;
  constructor(verdict: JobVerdict, message: string, reason: VerdictReason) {
    super(message);
    this.name = "Stop";
    this.verdict = verdict;
    this.reason = reason;
  }
}

const OTHER: Record<AgentProvider, AgentProvider> = {
  "claude-code": "codex",
  codex: "claude-code",
};

const PROVIDER_NAME: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const NO_RISK = { security: false, database: false, architecture: false, deployment: false };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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
  /** The owner asked the job to stop: the current round finishes, nothing new starts. */
  #stopRequested = false;
  #planningRoundsDone = 0;
  #buildRoundsDone = 0;
  /** Solo and pair: who builds, and who reviews (null in solo). */
  #builder: AgentProvider = "claude-code";
  #reviewer: AgentProvider | null = null;

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
      if (this.#mode === "team") this.#requireTeam();
      else this.#requireSimple();
      // The first write goes before anything touches the disk: it is refused
      // unless this Runtime holds the claim for a job the server created, so a
      // forged or stale job stops here with nothing to clean up.
      await this.#setStatus(
        "normalising",
        this.#mode === "team" ? "Turning the request into a specification" : "Starting",
      );
      set = await worktrees.begin(workspace, shortJob(this.#job.jobId));
      this.#evidence.base = set.base;
      this.#evidence.baseExcludedUncommittedChanges = set.dirty;
      if (set.dirty) {
        this.#evidence.uncertainty.push(
          "The repository had uncommitted changes. The team worked from the last commit, so those changes are not part of this result.",
        );
      }

      const outcome = this.#mode === "team" ? await this.#runTeam(set) : await this.#runSimple(set);
      this.#noteUndelivered();
      await this.#finish(outcome.verdict, outcome.summary, outcome.reason);
      return outcome;
    } catch (error) {
      this.#noteUndelivered();
      const verdict = error instanceof Stop ? error.verdict : "BLOCKED";
      const reason: VerdictReason = error instanceof Stop ? error.reason : "unexpected_error";
      const summary =
        error instanceof Stop
          ? error.message
          : `The team stopped because of an unexpected error: ${redactText(
              (error as Error)?.message ?? String(error),
              500,
            )}`;
      await this.#finish(verdict, summary, reason).catch(() => undefined);
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

  /**
   * A team is two different providers. With only one, cross-review is
   * impossible, and quietly letting one agent review itself would be exactly
   * the thing Team Mode exists to prevent.
   */
  #requireTeam(): void {
    const present = new Set(this.#job.agents.map((a) => a.provider));
    for (const provider of ["claude-code", "codex"] as const) {
      if (!present.has(provider)) {
        throw new Stop(
          "NEEDS_USER_DECISION",
          `${PROVIDER_NAME[provider]} is not part of this room, so its work cannot be cross-reviewed. Add it to the room, or run this as a single-agent task.`,
          "agent_not_in_project",
        );
      }
      if (!this.#d.runners[provider]) {
        throw new Stop(
          "BLOCKED",
          `${PROVIDER_NAME[provider]} is not available on this computer. ThreadLink will not substitute another agent for it.`,
          "agent_unavailable",
        );
      }
    }
    if (this.#job.policy.paidUsage) {
      // The owner has allowed paid usage, but Team Mode's agents run with API
      // keys stripped from their environment, so they can only ever use the
      // included subscription. Say so rather than imply otherwise.
      this.#evidence.uncertainty.push(
        "Paid usage is allowed on your profile, but Team Mode only uses your included subscription usage. No paid usage was used.",
      );
    }
  }

  /**
   * Solo and Builder + Reviewer: the builder must be in the room and available
   * here; in a pair, so must the other provider, which reviews. Neither is
   * ever replaced by the other: a missing agent stops the job.
   */
  #requireSimple(): void {
    const present = new Set(this.#job.agents.map((a) => a.provider));
    const builder = this.#job.builder;
    if (!builder || !present.has(builder)) {
      throw new Stop(
        "NEEDS_USER_DECISION",
        "This job does not name an agent in the room to build it. Say who should build it.",
        "agent_not_in_project",
      );
    }
    if (!this.#d.runners[builder]) {
      throw new Stop(
        "BLOCKED",
        `${PROVIDER_NAME[builder]} is not available on this computer. ThreadLink will not substitute another agent for it.`,
        "agent_unavailable",
      );
    }
    this.#builder = builder;
    if (this.#mode === "pair") {
      const reviewer = OTHER[builder];
      if (!present.has(reviewer)) {
        throw new Stop(
          "NEEDS_USER_DECISION",
          `${PROVIDER_NAME[reviewer]} is not part of this room, so it cannot review ${PROVIDER_NAME[builder]}'s work. Add it to the room, or run this as Solo.`,
          "agent_not_in_project",
        );
      }
      if (!this.#d.runners[reviewer]) {
        throw new Stop(
          "BLOCKED",
          `${PROVIDER_NAME[reviewer]} is not available on this computer, so it cannot review. ThreadLink will not substitute another agent for it.`,
          "agent_unavailable",
        );
      }
      this.#reviewer = reviewer;
    }
    if (this.#job.policy.paidUsage) {
      this.#evidence.uncertainty.push(
        "Paid usage is allowed on your profile, but ThreadLink's agents only use your included subscription usage. No paid usage was used.",
      );
    }
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
    const builder = this.#builder;
    const reviewer = this.#reviewer;
    const spec = this.#specFromJob();
    await this.#write("set_spec", { spec: redactDeep(spec) });
    await this.#checkStop();

    await this.#setStatus("planning", "Recording the plan");
    const plan: Plan = {
      summary:
        reviewer === null
          ? `One unit of work, built by ${PROVIDER_NAME[builder]}.`
          : `One unit of work, built by ${PROVIDER_NAME[builder]} and reviewed by ${PROVIDER_NAME[reviewer]}.`,
      nodes: [
        {
          key: "work",
          title: goalTitle(this.#job.goal),
          scope: "Deliver the owner's request as specified.",
          files: [],
          dependsOn: [],
          suggestedOwner: builder,
          rationale:
            reviewer === null
              ? `The owner asked ${PROVIDER_NAME[builder]} to do this on its own.`
              : `The owner asked ${PROVIDER_NAME[builder]} to build this and ${PROVIDER_NAME[reviewer]} to review it.`,
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
    await this.#decision(
      "Plan recorded",
      reviewer === null
        ? `Solo: ${PROVIDER_NAME[builder]} builds the request as one unit of work. There is no reviewer; ThreadLink runs the tests.`
        : `Builder + Reviewer: ${PROVIDER_NAME[builder]} builds the request as one unit of work and ${PROVIDER_NAME[reviewer]} reviews it.`,
      [builder],
      { planHash, mode: this.#mode },
      false,
    );
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
      parts.push(`${PROVIDER_NAME[builder]} finished without changing any files.`);
      this.#evidence.uncertainty.push(`${PROVIDER_NAME[builder]} made no changes.`);
    } else if (reviewer === null) {
      parts.push(`Built by ${PROVIDER_NAME[builder]}. Nobody else reviewed it (Solo).`);
    } else {
      parts.push(`Built by ${PROVIDER_NAME[builder]} and approved by ${PROVIDER_NAME[reviewer]}.`);
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
  // Owner notes and stop requests
  // -------------------------------------------------------------------------

  /**
   * Collects notes the owner sent since the last look and queues each for the
   * agent(s) it is addressed to. The server marks them delivered when read, so
   * they are held here until that agent's next turn. A failure to collect is
   * not fatal -- the owner is told their notes may not have arrived -- because
   * a stop request is also seen on every other write.
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
    const agents: AgentProvider[] =
      this.#mode === "team"
        ? ["claude-code", "codex"]
        : this.#reviewer
          ? [this.#builder, this.#reviewer]
          : [this.#builder];
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
        `${notes.length} note${many ? "s" : ""} you sent arrived after ${PROVIDER_NAME[provider]} had finished its part, so it did not see ${many ? "them" : "it"}.`,
      );
    }
    this.#notes.clear();
  }

  /** At a round boundary: stop here if the owner asked. */
  async #checkStop(): Promise<void> {
    await this.#collectNotes();
    if (this.#stopRequested) throw this.#stopped();
  }

  #stopped(): Stop {
    const round = this.#buildRoundsDone || this.#planningRoundsDone;
    return new Stop(
      "NEEDS_USER_DECISION",
      `Stopped by you after round ${round}.`,
      "stopped_by_owner",
    );
  }

  // -------------------------------------------------------------------------
  // Normalise
  // -------------------------------------------------------------------------

  async #normalise(workspace: WorktreeRecord): Promise<TeamSpec> {
    const planner = this.#roleHolder("planner", "claude-code");
    const result = await this.#call(planner, "coordinator", {
      cwd: workspace.path,
      worktree: workspace,
      prompt: normalisePrompt(this.#job.goal, this.#job.spec),
      access: "read-only",
      outputSchema: SPEC_SCHEMA,
      route: { complexity: "low", risk: NO_RISK },
    });
    const produced = result.structured as TeamSpec;
    // The owner's own words win over any restatement of them.
    const spec: TeamSpec = { ...produced, goal: this.#job.goal };
    for (const [field, value] of Object.entries(this.#job.spec)) {
      if (Array.isArray(value) && value.length) (spec as Record<string, unknown>)[field] = value;
    }
    await this.#write("set_spec", { spec: redactDeep(spec) });
    return spec;
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  async #plan(spec: TeamSpec, workspace: WorktreeRecord): Promise<Plan> {
    await this.#setStatus("planning", "Planning the work");
    const planner = this.#roleHolder("planner", "claude-code");
    const reviewer = OTHER[planner];
    let previous: { plan: Plan; review: Review } | undefined;

    for (let round = 1; round <= this.#job.budgets.maxPlanningRounds; round++) {
      if (round > 1) await this.#checkStop();
      await this.#write("open_round", { kind: "planning", round });
      this.#doing.set(planner, "Proposing a plan");
      const proposal = await this.#call(planner, "planner", {
        cwd: workspace.path,
        worktree: workspace,
        prompt: planPrompt(spec, PROVIDER_NAME[planner], previous),
        access: "read-only",
        outputSchema: PLAN_SCHEMA,
        route: { complexity: "high", risk: { ...NO_RISK, architecture: true } },
      });
      const plan = normalisePlan(proposal.structured as Plan);
      await this.#message(planner, reviewer, "proposal", round, plan.summary, proposal);

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
        await this.#finding(null, round, "planning", finding, "threadlink");
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
        continue;
      }

      this.#doing.set(reviewer, "Reviewing the plan");
      const reviewed = await this.#call(reviewer, "reviewer", {
        cwd: workspace.path,
        worktree: workspace,
        prompt: planReviewPrompt(spec, plan, PROVIDER_NAME[reviewer]),
        access: "read-only",
        outputSchema: REVIEW_SCHEMA,
        route: { complexity: "high", risk: { ...NO_RISK, architecture: true } },
      });
      const review = reviewed.structured as Review;
      await this.#message(reviewer, planner, "review", round, review.summary, reviewed);
      for (const f of review.findings) await this.#finding(null, round, "planning", f, reviewer);
      for (const o of review.ownershipObjections) {
        await this.#message(
          reviewer,
          planner,
          "proposal",
          round,
          `${PROVIDER_NAME[o.proposedOwner]} should own ${o.nodeKey}: ${o.reason}`,
          reviewed,
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
          approvedBy: [planner, reviewer],
          round,
        });
        await this.#decision(
          "Plan agreed",
          `Agreed after ${round} planning round${round === 1 ? "" : "s"}.`,
          [planner, reviewer],
          { planHash, units: plan.nodes.map((n) => n.key) },
          false,
        );
        return plan;
      }
      if (verdict === "BLOCKED") {
        throw new Stop(
          "BLOCKED",
          `${PROVIDER_NAME[reviewer]} judged the plan cannot proceed: ${redactText(review.summary, 400)}`,
          "plan_blocked",
        );
      }
      previous = { plan, review };
    }

    // Still disputed after the budget: that is for the owner, not the models.
    await this.#decision(
      "Plan not agreed",
      "The planning budget ran out with substantive objections still open.",
      [],
      { rounds: this.#job.budgets.maxPlanningRounds },
      true,
    );
    throw new Stop(
      "NEEDS_USER_DECISION",
      `Claude Code and Codex did not agree a plan within ${this.#job.budgets.maxPlanningRounds} rounds. The open objections are in the team log.`,
      "agents_disagree",
    );
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

  async #assign(
    plan: Plan,
    committedBy: AgentProvider[] = ["claude-code", "codex"],
  ): Promise<void> {
    for (const node of plan.nodes) {
      const owner = node.suggestedOwner;
      this.#nodes.set(node.key, {
        plan: node,
        owner,
        // The one rule that is never negotiable: nobody reviews their own work.
        // A solo job has no reviewer at all rather than a pretend one.
        reviewer: this.#mode === "solo" ? null : OTHER[owner],
        status: "pending",
        worktree: null,
        threadId: null,
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
        `Run ${s.after} after ${s.before}`,
        s.reason,
        [],
        { before: s.before, after: s.after },
        false,
      );
    }
    await this.#decision(
      "Ownership committed",
      plan.nodes.map((n) => `${n.key}: ${PROVIDER_NAME[n.suggestedOwner]}`).join("; "),
      committedBy,
      { owners: Object.fromEntries(plan.nodes.map((n) => [n.key, n.suggestedOwner])) },
      false,
    );
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

    if (this.#stopRequested) throw this.#stopped();
    await this.#checkStop();

    const failed = [...this.#nodes.values()].filter((n) => n.status === "failed");
    const disputed = failed.filter((n) => n.disputed);
    if (disputed.length) {
      for (const n of disputed) {
        await this.#decision(
          `${PROVIDER_NAME[n.owner]} and ${n.reviewer ? PROVIDER_NAME[n.reviewer] : "the reviewer"} disagree about ${n.plan.title}`,
          `${PROVIDER_NAME[n.owner]} declined to change it in response to the review, and the review budget ran out. Open findings: ${
            n.openFindings.map((f) => f.summary).join("; ") || "none recorded"
          }.`,
          [],
          { unit: n.plan.key, findings: n.openFindings.map((f) => f.summary) },
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
    let fixing: Finding[] | undefined;

    for (let round = 0; round <= this.#job.budgets.maxReviewRounds; round++) {
      if (round > 0) {
        // A round boundary. If the owner asked to stop, this unit ends here,
        // as it stands; #build then ends the job.
        await this.#collectNotes();
        if (this.#stopRequested) return;
        this.#reviewRound = Math.max(this.#reviewRound, round);
        await this.#write("open_round", { kind: "review", round, node: node.plan.key });
      }

      // Build (or fix).
      this.#doing.set(
        node.owner,
        fixing ? `Fixing ${node.plan.title}` : `Building ${node.plan.title}`,
      );
      this.#progress(
        `${PROVIDER_NAME[node.owner]} — ${fixing ? "fixing" : "building"} ${node.plan.title}`,
      );
      const built = await this.#call(node.owner, "builder", {
        cwd: node.worktree.path,
        prompt: buildPrompt(spec, node.plan, PROVIDER_NAME[node.owner], fixing),
        access: "workspace-write",
        outputSchema: BUILD_SCHEMA,
        resumeThreadId: node.threadId ?? undefined,
        route: {
          complexity: node.plan.complexity,
          risk: node.plan.risk,
          previousFailures: node.failures,
        },
      });
      node.threadId = built.threadId ?? node.threadId;
      const report = built.structured as BuildReport;
      const commit = await this.#d.worktrees.commit(node.worktree, `${node.plan.title}`, {
        authoredBy: [...node.authoredBy].map((p) => PROVIDER_NAME[p]),
        reviewedBy: [...node.reviewedBy].map((p) => PROVIDER_NAME[p]),
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
          `Out-of-scope changes undone in ${node.plan.title}`,
          `${PROVIDER_NAME[node.owner]} changed ${stray.join(", ")}, which the plan did not give this unit. Those changes were undone.`,
          [],
          { unit: node.plan.key, files: stray },
          false,
        );
      }
      await this.#message(
        node.owner,
        node.reviewer ?? "threadlink",
        // The builder's own report is worth reading in the chat: a completion,
        // not a technical handoff.
        fixing ? "response" : "completion",
        round,
        report.summary,
        built,
      );

      // Solo has no reviewer. In Team Mode the room may turn cross-review off;
      // a pair exists to be reviewed, so it never skips it.
      const reviewer = node.reviewer;
      const reviews =
        this.#mode === "pair" || (this.#mode === "team" && this.#job.policy.crossReview);
      if (!reviews || reviewer === null) {
        this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);
        await this.#nodeStatus(node, "approved");
        this.#doing.delete(node.owner);
        return;
      }

      // Review, by the other provider, read-only, on exactly this code.
      await this.#nodeStatus(node, "in_review");
      const fingerprint = await this.#d.worktrees.fingerprint(node.worktree);
      const diff = await this.#d.worktrees.diff(node.worktree);
      this.#doing.set(reviewer, `Reviewing ${PROVIDER_NAME[node.owner]}'s ${node.plan.title}`);
      this.#progress(`${PROVIDER_NAME[reviewer]} — reviewing ${node.plan.title}`);
      const reviewed = await this.#call(reviewer, "reviewer", {
        cwd: node.worktree.path,
        worktree: node.worktree,
        prompt: codeReviewPrompt(
          spec,
          node.plan,
          diff,
          PROVIDER_NAME[reviewer],
          [...this.#nodes.values()]
            .filter((other) => other !== node)
            .map((other) => ({ ...other.plan, owner: PROVIDER_NAME[other.owner] })),
        ),
        access: "read-only",
        outputSchema: REVIEW_SCHEMA,
        route: {
          complexity: node.plan.complexity,
          risk: node.plan.risk,
          disputedFindings: node.openFindings.length,
        },
      });
      // The review only counts for the code it was shown.
      if ((await this.#d.worktrees.fingerprint(node.worktree)) !== fingerprint) {
        throw new Stop(
          "BLOCKED",
          `${node.plan.title} changed while it was being reviewed.`,
          "changed_during_review",
        );
      }
      node.reviewedBy.add(reviewer);
      const review = reviewed.structured as Review;
      await this.#message(reviewer, node.owner, "review", round, review.summary, reviewed);

      // Findings from the previous round that this review no longer raises are resolved.
      for (const old of node.openFindings) await this.#resolveFinding(old, round);
      node.openFindings = [];
      for (const f of review.findings) {
        const id = await this.#finding(node.plan.key, round, "review", f, reviewer);
        if (isSubstantive(f)) node.openFindings.push({ ...f, id });
      }
      this.#buildRoundsDone = Math.max(this.#buildRoundsDone, round + 1);

      if (effectiveVerdict(review) === "APPROVED") {
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
          `${node.plan.title} cannot start from ${dep.plan.title}`,
          `Their changes conflict in ${result.conflicts.join(", ") || "unknown files"}.`,
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
    integrator: AgentProvider = this.#roleHolder("integrator", "claude-code"),
  ): Promise<{ record: WorktreeRecord; integrator: AgentProvider }> {
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
          `Conflict integrating ${node.plan.title}`,
          `Conflicts in ${merged.conflicts.join(", ") || "unknown files"}.`,
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
    const results = await this.#d.verify(record.path, this.#job.verifyCommands);
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
    const inspector = OTHER[integration.integrator];
    this.#doing.set(inspector, "Inspecting the whole change");
    const diff = await this.#d.worktrees.diff(integration.record, 400_000);
    const inspected = await this.#call(inspector, "security_reviewer", {
      cwd: integration.record.path,
      worktree: integration.record,
      prompt: inspectionPrompt(
        spec,
        diff,
        testEvidence(this.#evidence.tests),
        PROVIDER_NAME[inspector],
      ),
      access: "read-only",
      outputSchema: INSPECTION_SCHEMA,
      route: {
        complexity: "high",
        risk: { security: true, database: false, architecture: true, deployment: false },
      },
    });
    if ((await this.#d.worktrees.fingerprint(integration.record)) !== fingerprint) {
      throw new Stop(
        "BLOCKED",
        "The integrated change moved during the final inspection.",
        "changed_during_review",
      );
    }
    const inspection = inspected.structured as Inspection;
    for (const f of inspection.findings) {
      await this.#finding(null, this.#reviewRound, "inspection", f, inspector);
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

  async #call(
    provider: AgentProvider,
    role: TeamRole,
    options: {
      cwd: string;
      /** The worktree the run happens in, so its effect can be checked. */
      worktree?: WorktreeRecord;
      prompt: string;
      access: RunAccess;
      outputSchema: object;
      resumeThreadId?: string;
      route: {
        complexity: PlannedNode["complexity"];
        risk: PlannedNode["risk"];
        previousFailures?: number;
        disputedFindings?: number;
      };
    },
  ): Promise<AgentRunResult & { structured: unknown }> {
    const runner = this.#d.runners[provider];
    if (!runner) {
      throw new Stop(
        "BLOCKED",
        `${PROVIDER_NAME[provider]} is not available. It was not replaced.`,
        "agent_unavailable",
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
        `${PROVIDER_NAME[provider]} has no model to use`,
        route.reason,
        [],
        { options: route.options },
        true,
      );
      throw new Stop("NEEDS_USER_DECISION", route.reason, "no_suitable_model");
    }

    // Anything the owner has said to this agent since its last turn goes into
    // this one, delimited and redacted (prompts.ts, withOwnerNotes).
    await this.#collectNotes();
    const notes = this.#takeNotes(provider);
    const prompt = withOwnerNotes(options.prompt, notes, (text) => redactText(text, 4_000));

    const result = await runner.run({
      provider,
      role,
      cwd: options.cwd,
      prompt,
      model: route.model,
      effort: route.effort ?? undefined,
      access: options.access,
      outputSchema: options.outputSchema,
      resumeThreadId: options.resumeThreadId,
      timeoutMs: this.#d.timeoutMs,
      signal: this.#abort.signal,
    });

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
      outcome: result.ok ? "ok" : (result.failure ?? "provider_error"),
    });

    if (!result.ok) throw this.#failure(provider, result);
    await this.#verifyAccess(provider, runner, options, result);
    if (result.structured === undefined || result.structured === null) {
      throw new Stop(
        "BLOCKED",
        `${PROVIDER_NAME[provider]} did not answer in the required format, so its answer was not guessed at.`,
        "agent_failed",
      );
    }
    return result as AgentRunResult & { structured: unknown };
  }

  /**
   * Checks the run did not have more access than it asked for, using the
   * strongest evidence available:
   *
   *   - a provider that reports its sandbox must report the one we asked for;
   *   - a read-only run must leave its worktree exactly as it found it, which
   *     ThreadLink checks itself and does not take on trust from either
   *     provider.
   *
   * A write run by a provider that cannot report its sandbox (Claude Code) is
   * limited by its permission mode, not by a sandbox. That is recorded, and the
   * docs and UI say so; worktrees are isolation for git, not a security boundary.
   */
  async #verifyAccess(
    provider: AgentProvider,
    runner: AgentRunner,
    options: { access: RunAccess; worktree?: WorktreeRecord },
    result: AgentRunResult,
  ): Promise<void> {
    if (runner.verifiesAccess && !result.accessVerified) {
      throw new Stop(
        "BLOCKED",
        `${PROVIDER_NAME[provider]} could not confirm it ran with ${options.access} access, so its work was not used.`,
        "access_mismatch",
      );
    }
    if (options.access === "read-only") {
      if (!options.worktree) {
        throw new Stop(
          "BLOCKED",
          "A read-only run had no workspace ThreadLink could check afterwards.",
          "access_mismatch",
        );
      }
      if (!(await this.#d.worktrees.isClean(options.worktree))) {
        throw new Stop(
          "BLOCKED",
          `${PROVIDER_NAME[provider]} changed files during a read-only ${
            options.worktree.key === "planning" ? "planning" : "review"
          } step, so its work was not used.`,
          "access_mismatch",
        );
      }
    }
  }

  /** Every provider failure stops the job. None of them is answered by switching provider. */
  #failure(provider: AgentProvider, result: AgentRunResult): Stop {
    const name = PROVIDER_NAME[provider];
    switch (result.failure) {
      case "quota_exhausted":
        this.#d.onExhausted?.(provider, result.requestedModel);
        return new Stop(
          "NEEDS_USER_DECISION",
          `${name} usage is exhausted. ThreadLink is waiting rather than switching agents or paying for more. You can wait for the reset, continue with the other agent only, or choose a smaller model.`,
          "usage_exhausted",
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
          `${name} is not signed in on this computer.`,
          "agent_unavailable",
        );
      case "not_installed":
        return new Stop(
          "BLOCKED",
          `${name} is not installed on this computer.`,
          "agent_unavailable",
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

  #roleHolder(role: TeamRole, fallback: AgentProvider): AgentProvider {
    return this.#job.agents.find((a) => a.roles.includes(role))?.provider ?? fallback;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async #write(op: TeamOp, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answer = (await this.#d.sink(op, payload)) ?? {};
    // Every answer carries the job's state, including an owner's stop request.
    if (stopRequested(answer)) this.#stopRequested = true;
    return answer;
  }

  async #setStatus(status: string, line: string): Promise<void> {
    this.#status = status;
    await this.#write("set_status", { status, line });
    this.#progress(line);
  }

  async #nodeStatus(node: NodeState, status: NodeStatus): Promise<void> {
    node.status = status;
    await this.#write("set_node_status", { key: node.plan.key, status });
    this.#progress(`${node.plan.title}: ${status.replace(/_/g, " ")}`);
  }

  async #message(
    from: AgentProvider | "threadlink",
    to: AgentProvider | "threadlink",
    type: string,
    round: number,
    body: string,
    /** The run this message reports on, for the model it was observed to use. */
    run?: Pick<AgentRunResult, "observedModel">,
  ): Promise<void> {
    const model = modelObserved(run?.observedModel);
    // The role the sender spoke in, so the chat can say "Codex (builder)".
    const role =
      from === "threadlink"
        ? undefined
        : type === "review"
          ? "reviewer"
          : type === "proposal"
            ? "planner"
            : ["handoff", "response", "completion"].includes(type)
              ? "builder"
              : undefined;
    await this.#write("add_message", {
      sender: from,
      ...(role ? { senderRole: role } : {}),
      receiver: to,
      type,
      round,
      body: redactText(body),
      ...(model ? { modelObserved: model } : {}),
    });
  }

  async #finding(
    node: string | null,
    round: number,
    phase: "planning" | "review" | "inspection",
    f: Finding,
    raisedBy: AgentProvider | "threadlink",
  ): Promise<string | null> {
    const answer = await this.#write("add_finding", {
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
    });
    return typeof answer.findingId === "string" ? answer.findingId : null;
  }

  async #resolveFinding(f: { id: string | null }, round: number): Promise<void> {
    if (!f.id) return;
    await this.#write("set_finding_status", { findingId: f.id, status: "resolved", round });
  }

  async #decision(
    topic: string,
    resolution: string,
    approvedBy: AgentProvider[],
    evidence: Record<string, unknown>,
    needsUser: boolean,
  ): Promise<void> {
    // A question for the owner has no resolution yet: sending one would make
    // the server count it as settled. The explanation travels as evidence.
    await this.#write("add_decision", {
      topic: redactText(topic, 200),
      ...(needsUser ? {} : { resolution: redactText(resolution, 2_000) }),
      approvedBy,
      evidence: redactDeep(needsUser ? { ...evidence, question: resolution } : evidence),
      needsUser,
    });
  }

  async #finish(verdict: JobVerdict, summary: string, reason?: VerdictReason): Promise<void> {
    this.#finalVerdict = verdict;
    this.#status = verdict === "PASS" ? "completed" : verdict.toLowerCase();
    this.#doing.clear();
    await this.#write("set_final", {
      verdict,
      summary: redactText(summary, 2_000),
      ...(reason && verdict !== "PASS" ? { reason } : {}),
      evidence: this.#evidence,
    });
    this.#progress(`${verdict}: ${summarize(summary) ?? verdict}`);
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
    });
  }
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
