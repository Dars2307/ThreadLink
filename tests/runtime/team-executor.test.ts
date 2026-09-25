import { describe, expect, it, vi } from "vitest";

import type { ProviderDiscovery } from "../../runtime/src/team/discovery.ts";
import { TeamExecutor, teamReport } from "../../runtime/src/team/executor.ts";
import type { TeamOutcome } from "../../runtime/src/team/orchestrator.ts";
import { UsageGovernor } from "../../runtime/src/team/usage.ts";

/**
 * The seam between Team Mode and the ordinary task pipeline: what the
 * controller is told, and what happens to a job that cannot be read or an
 * agent that is not signed in.
 */

const outcome = (over: Partial<TeamOutcome> = {}): TeamOutcome => ({
  verdict: "PASS",
  summary: "Meets the specification.",
  evidence: {
    base: "abc",
    baseExcludedUncommittedChanges: false,
    planHash: "f".repeat(64),
    integrationBranch: "threadlink/aaaaaaaaaaaa/integration",
    diffFingerprint: "e".repeat(64),
    commits: ["c1"],
    tests: [{ command: "npm test", ok: true, exitCode: 0, output: "ok" }],
    uncertainty: [],
  },
  units: [
    {
      key: "backend",
      title: "Report backend",
      owner: "claude-code",
      reviewer: "codex",
      status: "integrated",
      authoredBy: ["claude-code"],
      reviewedBy: ["codex"],
    },
    {
      key: "ui",
      title: "Report UI",
      owner: "codex",
      reviewer: "claude-code",
      status: "integrated",
      authoredBy: ["codex"],
      reviewedBy: ["claude-code"],
    },
  ],
  ...over,
});

describe("what the controller is told", () => {
  it("says the verdict, who built and reviewed what, and where the result is", () => {
    const report = teamReport("Prism", "Build the new Prism reporting workflow.", outcome());
    expect(report).toContain("Team result: PASS");
    expect(report).toContain("Prism — Build the new Prism reporting workflow.");
    expect(report).toContain("✓ Report backend — Claude Code (reviewed by Codex)");
    expect(report).toContain("✓ Report UI — Codex (reviewed by Claude Code)");
    expect(report).toContain("passed — npm test");
    expect(report).toContain("Result branch: threadlink/aaaaaaaaaaaa/integration");
    expect(report).toContain("get_team_log");
  });

  it("stays short: no internal messages, no identifiers", () => {
    const report = teamReport("Prism", "Goal.", outcome());
    expect(report.split("\n").length).toBeLessThan(25);
    expect(report).not.toMatch(/tljob_|tlrom_|tlses_|tlfnd_/);
  });

  it("says plainly when something was left out", () => {
    const report = teamReport(
      "Prism",
      "Goal.",
      outcome({
        verdict: "NEEDS_FIX",
        summary: "UI did not pass review within 3 rounds.",
        evidence: { ...outcome().evidence, uncertainty: ["The team worked from the last commit."] },
      }),
    );
    expect(report).toContain("Team result: NEEDS_FIX");
    expect(report).toContain("Worth knowing:");
    expect(report).toContain("The team worked from the last commit.");
  });
});

describe("running a team job", () => {
  const discovery = (over: Partial<ProviderDiscovery>[]): ProviderDiscovery[] =>
    over.map((o) => ({
      provider: "claude-code",
      installed: true,
      executable: "claude",
      version: "2.1.266",
      authenticated: true,
      authMethod: "claude.ai",
      detectedPlan: "max",
      models: [],
      currentModel: null,
      capabilities: {} as ProviderDiscovery["capabilities"],
      usage: { remaining: "unknown" },
      ...o,
    })) as ProviderDiscovery[];

  it("refuses a job it cannot read, without starting anything", async () => {
    const write = vi.fn();
    const discover = vi.fn();
    const executor = new TeamExecutor({
      workspace: ".",
      sessionId: "tlses_x",
      claimRef: "r",
      write,
      governor: new UsageGovernor(),
      discover,
    });
    const result = await executor.execute(
      { taskId: "tltask_x", title: "t", content: "{not json", priority: "C", taskType: "team" },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not give a signed-out agent a runner, so it is reported rather than used", async () => {
    const seen: string[][] = [];
    const executor = new TeamExecutor({
      workspace: ".",
      sessionId: "tlses_x",
      claimRef: "r",
      write: vi.fn(async () => ({})),
      governor: new UsageGovernor(),
      discover: async () =>
        discovery([
          { provider: "claude-code" },
          { provider: "codex", authenticated: false, executable: "codex.exe" },
        ]),
      runners: (found) => {
        const usable = found.filter((f) => f.installed && f.authenticated).map((f) => f.provider);
        seen.push(usable);
        return {};
      },
    });
    const job = JSON.stringify({
      kind: "threadlink.team_job",
      version: 1,
      jobId: `tljob_${"a".repeat(32)}`,
      roomId: `tlrom_${"b".repeat(32)}`,
      roomName: "Prism",
      goal: "Build it.",
      spec: {},
      budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 2 },
      policy: {
        usagePolicy: "balanced",
        paidUsage: false,
        crossReview: true,
        finalInspection: true,
        worktreeIsolation: true,
        overrides: [],
      },
      agents: [
        { provider: "claude-code", displayName: "Claude", roles: ["planner", "builder"] },
        { provider: "codex", displayName: "Codex", roles: ["reviewer"] },
      ],
      verifyCommands: [],
    });
    const result = await executor.execute(
      { taskId: "tltask_x", title: "t", content: job, priority: "C", taskType: "team" },
      new AbortController().signal,
    );
    expect(seen).toEqual([["claude-code"]]);
    // The job is still answered: with the reason, not a crash.
    expect(result.ok).toBe(true);
    expect((result as { result: string }).result).toMatch(/Team result: BLOCKED/);
  });
});
