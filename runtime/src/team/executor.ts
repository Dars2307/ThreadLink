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
import { parseTeamJob, TeamJobError } from "./job.ts";
import { classifyModels, isSelectable, type ModelClassOverrides } from "./models.ts";
import {
  TeamOrchestrator,
  type AgentRunner,
  type TeamOp,
  type TeamOutcome,
  type TeamProgress,
} from "./orchestrator.ts";
import { graphPort, routePort } from "./ports.ts";
import type { RouteOverride } from "./router.ts";
import { createRunners } from "./providers.ts";
import type { AgentProvider } from "./types.ts";
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
  /** Injectable for tests; real discovery and real CLIs otherwise. */
  discover?: () => Promise<ProviderDiscovery[]>;
  runners?: (found: ProviderDiscovery[]) => Partial<Record<AgentProvider, AgentRunner>>;
  worktrees?: WorktreeManager;
  verify?: typeof runVerify;
  onProgress?(progress: TeamProgress): void;
  log?(message: string): void;
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

    const orchestrator = new TeamOrchestrator(job, {
      runners: (this.#o.runners ?? createRunners)(found),
      route: routePort({
        available,
        policy: job.policy.usagePolicy,
        overrides: job.policy.overrides as RouteOverride[],
        governor: this.#o.governor,
      }),
      graph: graphPort(),
      worktrees: this.#o.worktrees ?? new WorktreeManager(),
      verify: (cwd, commands) => (this.#o.verify ?? runVerify)(cwd, commands, { signal }),
      sink: (op, payload) =>
        this.#o.write(job.jobId, this.#o.sessionId, this.#o.claimRef, op, payload),
      onProgress: this.#o.onProgress,
      // Remembered across jobs, so the next one does not retry a spent provider.
      onExhausted: (provider, model) => this.#o.governor.markExhausted(provider, model),
      signal,
    });

    this.#o.log?.(`team job ${job.jobId} started in ${job.roomName}`);
    const outcome = await orchestrator.run(this.#o.workspace);
    this.#o.log?.(`team job ${job.jobId} finished: ${outcome.verdict}`);
    // The carrier task is complete whatever the verdict: the team did its job
    // and reached one. NEEDS_FIX or BLOCKED is the answer, not a crash.
    return { ok: true, result: teamReport(job.roomName, job.goal, outcome), artifacts: [] };
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
