/**
 * Plugs Team Mode into the Runtime's ordinary task pipeline.
 *
 * A team job arrives as a normal ThreadLink task (task type "team"), so it is
 * claimed, leased, heartbeated and completed exactly like any other. This
 * executor is what runs in the middle: it parses the job, finds out which
 * agents and models this computer actually has, runs the orchestrator, and
 * hands back a short report for the controller. The full log stays in
 * ThreadLink, behind get_team_log.
 */

import type { ExecutionResult, Executor, TaskInput } from "../executor.ts";
import { summarize } from "../summary.ts";
import { discoverProviders, type ProviderDiscovery } from "./discovery.ts";
import type { ProviderHealthMonitor } from "./health.ts";
import type { ChatSessionStore } from "./chat-sessions.ts";
import {
  FAST_CHAT_DEFAULT_FOLLOWUPS,
  FAST_CHAT_MAX_FOLLOWUPS,
  FastChatCoordinator,
} from "./fast-chat.ts";
import { parseTeamJob, TeamJobError } from "./job.ts";
import { classifyModels, isSelectable, type ModelClassOverrides } from "./models.ts";
import {
  InterruptedRefusal,
  TeamOrchestrator,
  type AgentRunner,
  type HealthPort,
  type TeamOp,
  type TeamOutcome,
  type TeamProgress,
} from "./orchestrator.ts";
import { graphPort, routePort } from "./ports.ts";
import type { RouteOverride } from "./router.ts";
import { createRunners } from "./providers.ts";
import {
  classifyRecovery,
  leftByAnotherProcess,
  type JobJournal,
  type JournalStore,
  type JobJournalState,
  type ProcessEntry,
  type ProcessRegistry,
  type RecoveryReport,
} from "./registry.ts";
import type { AgentProvider, ModelClass } from "./types.ts";
import {
  OPS_0_10,
  parseChoiceId,
  parseChoices,
  readChoicesPayload,
  requestChoicePayload,
} from "./wire.ts";
import { UsageGovernor } from "./usage.ts";
import { runVerify } from "./verify.ts";
import { WorktreeManager } from "./worktrees.ts";

export const TEAM_TASK_TYPE = "team";

export type TeamWrite = (
  jobId: string,
  sessionId: string,
  claimRef: string,
  op: TeamOp,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type TeamExecutorOptions = {
  /** The attached workspace the team works in. */
  workspace: string;
  sessionId: string;
  claimRef: string;
  write: TeamWrite;
  /** Shared across jobs so exhaustion and user preferences persist. */
  governor: UsageGovernor;
  classOverrides?: ModelClassOverrides;
  /**
   * Provider health, shared with the Runtime: checked at claim (re-probed if
   * older than 10 minutes) and told about every failed run. Absent: a provider
   * with a runner counts as ready.
   */
  health?: ProviderHealthMonitor;
  /** Injectable for tests; real discovery and real CLIs otherwise. */
  discover?: () => Promise<ProviderDiscovery[]>;
  runners?: (found: ProviderDiscovery[]) => Partial<Record<AgentProvider, AgentRunner>>;
  worktrees?: WorktreeManager;
  verify?: typeof runVerify;
  onProgress?(progress: TeamProgress): void;
  log?(message: string): void;
  /** 0.10 crash recovery: per-job journals in configDir (registry.ts). */
  journals?: JournalStore;
  /** 0.10: the provider processes this Runtime started (stop_now kills only these). */
  processes?: ProcessRegistry;
  /** Process entries a previous Runtime left behind (classification only). */
  staleProcesses?: readonly ProcessEntry[];
  /** Jobs running in this process now, shared by every executor of one Runtime. */
  activeJobs?: Set<string>;
  /** Called with the classification of a job a previous Runtime left behind. */
  onRecovery?(report: RecoveryReport): void;
  /** Waiting on the owner (tests). */
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
  choicePollMs?: number;
  choiceWaitMs?: number;
  controlPollMs?: number;
  /**
   * 0.11: the Runtime's last discovery, when it is recent. A Fast Chat turn
   * uses it instead of spawning every CLI again (seconds per turn). Work jobs
   * always discover afresh, as before.
   */
  cachedDiscovery?: () => ProviderDiscovery[] | null;
  /** 0.11 (§3.4.6): native session continuity for Fast Chat, in configDir. */
  chatSessions?: ChatSessionStore;
  /** 0.11 (§5): failover notices already sent (one per chat per exhaustion). */
  noticesSent?: Set<string>;
  /** FAST_CHAT_MAX_FOLLOWUPS (default 1, hard cap 2). */
  maxFollowups?: number;
  /** Fast Chat: the working-tree fingerprint used to verify read-only Claude runs. */
  snapshot?: (cwd: string) => Promise<string | null>;
};

const NAME: Record<AgentProvider, string> = { "claude-code": "Claude Code", codex: "Codex" };

// Subscription-only sign-in and runner creation live with the provider
// adapters (providers.ts); re-exported here for existing callers.
export { SUBSCRIPTION_AUTH, usableForTeam } from "./providers.ts";

export class TeamExecutor implements Executor {
  readonly name = "team";
  readonly #o: TeamExecutorOptions;

  constructor(options: TeamExecutorOptions) {
    this.#o = options;
  }

  async execute(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult> {
    let job;
    try {
      job = parseTeamJob(task.content);
    } catch (error) {
      // A job we cannot read is refused whole rather than half-guessed.
      return {
        ok: false,
        error: error instanceof TeamJobError ? error.message : "This team job could not be read.",
      };
    }
    // One job runs once on this computer at a time: a redelivered carrier task
    // for a job that is still running here is refused, never run twice.
    const active = this.#o.activeJobs ?? new Set<string>();
    if (active.has(job.jobId)) {
      return { ok: false, error: "This team job is already running on this computer." };
    }
    active.add(job.jobId);
    try {
      const queueMs = queueTime(task);
      if (job.lane === "chat") return await this.#executeChat(job, signal, queueMs);
      return await this.#execute(job, signal, queueMs);
    } finally {
      active.delete(job.jobId);
    }
  }

  /** The sink for this job: every write is claim-gated by the server. */
  #sink(jobId: string) {
    return (op: TeamOp, payload: Record<string, unknown>) =>
      this.#o.write(jobId, this.#o.sessionId, this.#o.claimRef, op, payload);
  }

  /**
   * 0.11 Fast Chat (fast-chat.ts): no journal, no worktree, no DAG. Read-only
   * turns in the project folder; the carrier task completes when the turn does.
   */
  async #executeChat(
    job: ReturnType<typeof parseTeamJob>,
    signal: AbortSignal,
    queueMs: number | null,
  ): Promise<ExecutionResult> {
    const cached = this.#o.cachedDiscovery?.() ?? null;
    const found = cached?.length
      ? cached
      : await (this.#o.discover ?? (() => discoverProviders()))();
    const available = selectable(found, this.#o.classOverrides);
    const monitor = this.#o.health;
    const governor = this.#o.governor;
    const coordinator = new FastChatCoordinator(job, {
      runners: (this.#o.runners ?? createRunners)(found),
      route: routePort({
        available,
        policy: job.policy.usagePolicy,
        overrides: job.policy.overrides as RouteOverride[],
        governor,
      }),
      sink: this.#sink(job.jobId),
      health: monitor
        ? {
            peek: (providers) =>
              Object.fromEntries(providers.map((p) => [p, monitor.get(p).health])),
            recheck: (provider) => monitor.confirm(provider),
            noteFailure: (provider, failure, details) =>
              monitor.noteFailure(provider, failure, details),
          }
        : undefined,
      sessions: this.#o.chatSessions,
      processes: this.#o.processes,
      onExhausted: (provider, resetsAt) => governor.markExhausted(provider, null, epoch(resetsAt)),
      isExhausted: (provider) => !governor.isAvailable(provider, null, Date.now()),
      snapshot: this.#o.snapshot,
      signal,
      clock: this.#o.clock,
      choicePollMs: this.#o.choicePollMs,
      choiceWaitMs: this.#o.choiceWaitMs,
      controlPollMs: this.#o.controlPollMs,
      maxFollowups: this.#o.maxFollowups ?? maxFollowupsFromEnv(),
      queueMs,
      noticesSent: this.#o.noticesSent,
      log: this.#o.log,
    });
    const outcome = await coordinator.run(this.#o.workspace);
    const who = outcome.answered.map((p) => NAME[p]).join(", ");
    return {
      ok: true,
      result:
        outcome.status === "completed"
          ? `Fast chat answered by ${who || "nobody"}.`
          : outcome.status === "cancelled"
            ? "Fast chat stopped by the owner."
            : "Fast chat: no agent could answer.",
      artifacts: [],
    };
  }

  async #execute(
    job: ReturnType<typeof parseTeamJob>,
    signal: AbortSignal,
    queueMs: number | null = null,
  ): Promise<ExecutionResult> {
    // Crash recovery (docs/design/threadlink-0.10.md §6): a journal left by a
    // Runtime that stopped mid-job says what may and may not happen next.
    let previous = this.#o.journals?.read(job.jobId) ?? null;
    let recoveryNote: string | null = null;
    // Another Runtime process on this computer (sharing this config
    // directory) is running this job right now: that is not a crash.
    if (previous && previous.runtimePid !== process.pid && !leftByAnotherProcess(previous)) {
      return {
        ok: false,
        error: "This team job is already running in another ThreadLink Runtime on this computer.",
      };
    }
    if (previous) {
      const report = classifyRecovery(previous, this.#o.staleProcesses ?? []);
      this.#o.onRecovery?.(report);
      this.#o.log?.(`team job ${job.jobId} recovered: ${report.classification}`);
      const settled = await this.#recover(job, previous, report, signal);
      if (settled) return settled;
      recoveryNote =
        report.classification === "resumable"
          ? "ThreadLink restarted this job after the Runtime stopped. Only steps that change nothing were repeated."
          : "ThreadLink restarted this job from its approved plan after you chose to resume it. Work on the earlier attempt's branches was not reused.";
    }

    const found = await (this.#o.discover ?? (() => discoverProviders()))();
    const available = found.flatMap((p) =>
      classifyModels(
        p.provider,
        p.models.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          description: m.description,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort,
        })),
        this.#o.classOverrides,
      ).filter(isSelectable),
    );

    const modelClasses: Partial<Record<AgentProvider, ModelClass[]>> = {};
    for (const m of available) {
      if (m.legacy) continue;
      (modelClasses[m.provider] ??= []).push(m.modelClass);
    }
    const monitor = this.#o.health;
    const health: HealthPort | undefined = monitor
      ? {
          ensure: async (providers) => {
            const records = await monitor.ensureFresh(providers, { found });
            return Object.fromEntries(providers.map((p) => [p, records[p]?.health ?? "unknown"]));
          },
          noteFailure: (provider, failure, details) =>
            monitor.noteFailure(provider, failure, details),
          confirm: (provider) => monitor.confirm(provider),
          resetsAt: (provider) => monitor.get(provider).resetsAt ?? null,
          recentFailures: () => monitor.recentFailures(),
        }
      : undefined;

    // A write step refused because an earlier attempt was interrupted (§6):
    // the owner decides, and only "resume" runs the job again. Bounded.
    for (let attempt = 0; ; attempt++) {
      const journal = this.#o.journals?.open(job.jobId, previous) ?? undefined;
      try {
        return await this.#runOrchestrator(
          job,
          signal,
          found,
          available,
          modelClasses,
          health,
          journal,
          recoveryNote,
          queueMs,
        );
      } catch (error) {
        if (!(error instanceof InterruptedRefusal) || attempt >= 2) throw error;
        const report: RecoveryReport = {
          jobId: job.jobId,
          classification: "interrupted",
          phase: journal?.state.phase ?? "unknown",
          attempt: journal?.state.attempt ?? 1,
          runningWriteStep: { kind: error.step, provider: error.provider },
          lastSafeStep: journal?.state.lastSafeStep ?? null,
          orphanedProcesses: 0,
        };
        this.#o.onRecovery?.(report);
        const state = journal?.state ?? null;
        const settled = await this.#recover(job, state ?? emptyJournal(job.jobId), report, signal);
        if (settled) return settled;
        previous = state;
        recoveryNote =
          "ThreadLink restarted this job from its approved plan after you chose to resume it. Work on the earlier attempt's branches was not reused.";
      }
    }
  }

  async #runOrchestrator(
    job: ReturnType<typeof parseTeamJob>,
    signal: AbortSignal,
    found: ProviderDiscovery[],
    available: ReturnType<typeof classifyModels>,
    modelClasses: Partial<Record<AgentProvider, ModelClass[]>>,
    health: HealthPort | undefined,
    journal: JobJournal | undefined,
    recoveryNote: string | null,
    queueMs: number | null = null,
  ): Promise<ExecutionResult> {
    const orchestrator = new TeamOrchestrator(job, {
      runners: (this.#o.runners ?? createRunners)(found),
      health,
      modelClasses,
      route: routePort({
        available,
        policy: job.policy.usagePolicy,
        overrides: job.policy.overrides as RouteOverride[],
        governor: this.#o.governor,
      }),
      graph: graphPort(),
      worktrees: this.#o.worktrees ?? new WorktreeManager(),
      verify: (cwd, commands) => (this.#o.verify ?? runVerify)(cwd, commands, { signal }),
      sink: this.#sink(job.jobId),
      onProgress: this.#o.onProgress,
      journal,
      processes: this.#o.processes,
      attempt: journal?.state.attempt ?? 1,
      clock: this.#o.clock,
      choicePollMs: this.#o.choicePollMs,
      choiceWaitMs: this.#o.choiceWaitMs,
      controlPollMs: this.#o.controlPollMs,
      // Remembered across jobs, so the next one does not retry a spent
      // provider. Subscription usage is per account: the whole provider is out
      // until the reset it stated (or until a fresh check says it is back).
      onExhausted: (provider, _model, resetsAt) =>
        this.#o.governor.markExhausted(provider, null, epoch(resetsAt ?? null)),
      onRecovered: (provider) => this.#o.governor.clearExhausted(provider),
      queueMs,
      noticesSent: this.#o.noticesSent,
      signal,
    });

    this.#o.log?.(`team job ${job.jobId} started in ${job.roomName}`);
    const outcome = await orchestrator.run(this.#o.workspace);
    if (recoveryNote) outcome.evidence.uncertainty.push(recoveryNote);
    this.#o.log?.(`team job ${job.jobId} finished: ${outcome.verdict}`);
    const report = teamReport(job.roomName, job.goal, outcome);
    // Kept, so a redelivered carrier task for a finished job is answered, not re-run.
    if (journal?.state.finalSynced) journal.finalSynced(report);
    // The carrier task is complete whatever the verdict: the team did its job
    // and reached one. NEEDS_FIX or BLOCKED is the answer, not a crash.
    return { ok: true, result: report, artifacts: [] };
  }

  /**
   * Acts on a recovered job. Returns the task result when the job is settled
   * here (already finished, verdict resent, or stopped by the owner), or null
   * to run it (resumable, or interrupted and the owner chose to resume).
   */
  async #recover(
    job: ReturnType<typeof parseTeamJob>,
    previous: JobJournalState,
    report: RecoveryReport,
    signal: AbortSignal,
  ): Promise<ExecutionResult | null> {
    const sink = this.#sink(job.jobId);
    const done = (text: string): ExecutionResult => ({ ok: true, result: text, artifacts: [] });
    const headline = (final: Record<string, unknown>) =>
      [
        `Team result: ${typeof final.verdict === "string" ? final.verdict : "unknown"}`,
        `${job.roomName} — ${summarize(job.goal) ?? "team job"}`,
        "",
        typeof final.summary === "string" ? final.summary : "",
      ].join("\n");
    switch (report.classification) {
      case "completed":
        // The server has the verdict: the job is never run twice.
        return done(previous.report ?? headline(previous.final ?? {}));
      case "completed_unsynced": {
        // The verdict was computed; send it again (set_final is idempotent).
        const final = previous.final!;
        await sink("set_final", final);
        const journal = this.#o.journals!.open(job.jobId, previous);
        journal.finalComputed(final);
        const text = headline(final);
        journal.finalSynced(text);
        return done(text);
      }
      case "resumable":
        return null;
      case "interrupted": {
        // A step that changes files was running, or had run. It is never
        // re-run on ThreadLink's own initiative: the owner decides.
        const choice = await this.#askInterrupted(job.jobId, report, signal);
        if (choice === "resume") return null;
        const final = {
          verdict: "NEEDS_USER_DECISION",
          summary:
            choice === "stop"
              ? "ThreadLink was interrupted while the team was working, and you chose to stop. Work already done is on the job's branches."
              : "ThreadLink was interrupted while an agent was changing files. It did not run that step again on its own. Start the job again when you are ready.",
          reason: choice === "stop" ? "stopped_by_owner" : "unexpected_error",
          evidence: {
            base: "",
            baseExcludedUncommittedChanges: false,
            planHash: null,
            integrationBranch: null,
            diffFingerprint: null,
            commits: [],
            tests: [],
            uncertainty: [
              "ThreadLink was interrupted while this job was running on this computer.",
            ],
          },
        };
        const journal = this.#o.journals?.open(job.jobId, previous);
        journal?.finalComputed(final);
        await sink("set_final", final);
        const text = headline(final);
        journal?.finalSynced(text);
        return done(text);
      }
    }
  }

  /** The owner's choice for an interrupted job: "resume", "stop", or null (no choice possible). */
  async #askInterrupted(
    jobId: string,
    report: RecoveryReport,
    signal: AbortSignal,
  ): Promise<"resume" | "stop" | null> {
    const sink = this.#sink(jobId);
    // The job shows as interrupted while the owner decides (§6).
    await sink("set_status", {
      status: "interrupted",
      line: "Interrupted: waiting for your decision",
    }).catch(() => undefined);
    let choiceId: string | null;
    try {
      choiceId = parseChoiceId(
        await sink(
          OPS_0_10.requestChoice,
          requestChoicePayload(
            "interrupted",
            {
              step: report.runningWriteStep?.kind ?? null,
              provider: report.runningWriteStep?.provider ?? null,
              phase: report.phase,
            },
            ["resume", "stop"],
            `${jobId}:interrupted:${report.attempt}`,
          ),
        ),
      );
    } catch {
      return null;
    }
    if (!choiceId) return null;
    const clock = this.#o.clock ?? {
      now: () => Date.now(),
      sleep: (ms: number, s: AbortSignal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          s.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        }),
    };
    const deadline = clock.now() + (this.#o.choiceWaitMs ?? 24 * 60 * 60_000);
    while (!signal.aborted && clock.now() < deadline) {
      const state = parseChoices(
        await sink(OPS_0_10.readChoices, readChoicesPayload([choiceId])),
      ).find((c) => c.id === choiceId);
      if (state?.status === "chosen") return state.chosenKey === "resume" ? "resume" : "stop";
      if (state && state.status !== "pending") return "stop";
      await clock.sleep(this.#o.choicePollMs ?? 15_000, signal);
    }
    return "stop";
  }
}

/**
 * The controller's concise answer. Who did what and how it ended, not the
 * conversation it took to get there: that is what get_team_log is for.
 */
export function teamReport(room: string, goal: string, outcome: TeamOutcome): string {
  const mark: Record<string, string> = { integrated: "✓", approved: "✓", failed: "✗" };
  const lines = [
    `Team result: ${outcome.verdict}`,
    `${room} — ${summarize(goal) ?? "team job"}`,
    "",
    outcome.summary,
  ];
  if (outcome.units.length) {
    lines.push("", "Work:");
    for (const u of outcome.units) {
      const reviewed = u.reviewedBy.length
        ? ` (reviewed by ${u.reviewedBy.map((p) => NAME[p]).join(", ")})`
        : "";
      lines.push(
        `${mark[u.status] ?? "○"} ${u.title} — ${u.authoredBy.map((p) => NAME[p]).join(" + ")}${reviewed}`,
      );
    }
  }
  if (outcome.evidence.tests.length) {
    lines.push("", "Tests (run by ThreadLink):");
    for (const t of outcome.evidence.tests)
      lines.push(`${t.ok ? "passed" : "FAILED"} — ${t.command}`);
  }
  if (outcome.evidence.integrationBranch) {
    lines.push("", `Result branch: ${outcome.evidence.integrationBranch}`);
  }
  if (outcome.evidence.uncertainty.length) {
    lines.push("", "Worth knowing:");
    for (const u of outcome.evidence.uncertainty) lines.push(`- ${u}`);
  }
  lines.push(
    "",
    "The full team log, with every review and decision, is available from get_team_log.",
  );
  return lines.join("\n");
}

/** A stand-in journal state when there is no journal store (tests, embedded). */
function emptyJournal(jobId: string): JobJournalState {
  return {
    version: 1,
    jobId,
    runtimePid: process.pid,
    attempt: 1,
    phase: "unknown",
    activeSteps: [],
    writeStarted: true,
    lastSafeStep: null,
    final: null,
    finalSynced: false,
    report: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Job created → claimed, from the server's own timestamps on the envelope (§3.6). */
function queueTime(task: TaskInput): number | null {
  const created = task.createdAt ? Date.parse(task.createdAt) : NaN;
  const claimed = task.claimedAt ? Date.parse(task.claimedAt) : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(claimed) || claimed < created) return null;
  return Math.round(claimed - created);
}

function epoch(iso: string | null): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function selectable(found: ProviderDiscovery[], overrides?: ModelClassOverrides) {
  return found.flatMap((p) =>
    classifyModels(
      p.provider,
      p.models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      })),
      overrides,
    ).filter(isSelectable),
  );
}

/** FAST_CHAT_MAX_FOLLOWUPS from the environment: 0-2, default 1. */
export function maxFollowupsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FAST_CHAT_MAX_FOLLOWUPS;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) return FAST_CHAT_DEFAULT_FOLLOWUPS;
  return Math.min(n, FAST_CHAT_MAX_FOLLOWUPS);
}
