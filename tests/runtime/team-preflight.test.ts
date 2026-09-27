import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { teamWriteOpSchema } from "@/lib/team/model";

import type { ProviderHealth } from "../../runtime/src/team/health.ts";
import type { TeamJobDefinition } from "../../runtime/src/team/job.ts";
import {
  TeamOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type HealthPort,
  type TeamOp,
  type TeamProgress,
  type VerifyResult,
} from "../../runtime/src/team/orchestrator.ts";
import { graphPort } from "../../runtime/src/team/ports.ts";
import type { Plan } from "../../runtime/src/team/prompts.ts";
import { assignRoles } from "../../runtime/src/team/roles.ts";
import type { AgentProvider } from "../../runtime/src/team/types.ts";
import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * Preflight, provider-neutral roles and honest stages, driven through the
 * orchestrator with real git worktrees and scripted agents. No real CLI runs.
 */

// Real git worktrees are slow on a loaded machine: generous limits, never a false failure.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-preflight-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "owner@example.com");
  git("config", "user.name", "Owner");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "# Prism\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repo, windowsHide: true });
  } catch {
    /* already gone */
  }
  rmSync(repo, { recursive: true, force: true });
});

const ALL_ROLES = ["coordinator", "planner", "builder", "reviewer", "integrator"] as never;
const BOTH = [
  { provider: "claude-code" as const, displayName: "Claude", roles: ALL_ROLES },
  { provider: "codex" as const, displayName: "Codex", roles: ALL_ROLES },
];

// The first 12 hex digits name the job's branches, so each job in one repository differs there.
const jobId = (i: number) => `tljob_${i.toString(16).padStart(12, "0")}${"a".repeat(20)}`;

const job = (over: Partial<TeamJobDefinition> = {}): TeamJobDefinition => ({
  jobId: jobId(7),
  roomId: `tlrom_${"b".repeat(32)}`,
  roomName: "Prism",
  goal: "Add a mul function.",
  spec: {},
  budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 2 },
  policy: {
    usagePolicy: "balanced",
    paidUsage: false,
    crossReview: true,
    finalInspection: true,
    worktreeIsolation: true,
    overrides: [],
  },
  agents: BOTH,
  verifyCommands: ["npm test"],
  ...over,
});

const SPEC = {
  goal: "x",
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

const plan = (owner: AgentProvider): Plan => ({
  summary: "AGENT-WRITTEN plan summary.",
  nodes: [
    {
      key: "work",
      title: "Unit work",
      scope: "s",
      files: ["mul.js"],
      dependsOn: [],
      suggestedOwner: owner,
      rationale: "r",
      complexity: "medium",
      risk: { security: false, database: false, architecture: false, deployment: false },
    },
  ],
  risks: [],
});

const APPROVE = { verdict: "APPROVED", summary: "ok", findings: [], ownershipObjections: [] };

type Script = {
  health?: Partial<Record<AgentProvider, ProviderHealth>>;
  owner?: AgentProvider;
  fail?: (req: AgentRunRequest, provider: AgentProvider) => Partial<AgentRunResult> | null;
  runners?: AgentProvider[];
};

function harness(script: Script = {}) {
  const calls: { provider: AgentProvider; role: string; kind: string }[] = [];
  const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
  const progress: TeamProgress[] = [];
  const noted: [AgentProvider, string][] = [];
  const ensured: AgentProvider[][] = [];

  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: false,
    async run(req) {
      let kind = "other";
      let structured: unknown;
      if (req.prompt.includes("precise engineering specification")) {
        kind = "normalise";
        structured = SPEC;
      } else if (req.role === "planner") {
        kind = "plan";
        structured = plan(script.owner ?? "codex");
      } else if (req.prompt.includes("Review the plan")) {
        kind = "plan-review";
        structured = APPROVE;
      } else if (req.role === "builder") {
        kind = "build";
        writeFileSync(join(req.cwd, "mul.js"), "// v1\n");
        structured = { summary: "Built", filesChanged: [], testsRun: [], openQuestions: [] };
      } else if (req.prompt.includes("Review the change")) {
        kind = "code-review";
        structured = APPROVE;
      } else if (req.prompt.includes("final independent inspection")) {
        kind = "inspect";
        structured = {
          verdict: "PASS",
          summary: "ok",
          findings: [],
          requirementsMet: [],
          uncertainty: [],
        };
      }
      calls.push({ provider, role: req.role, kind });
      const forced = script.fail?.(req, provider) ?? null;
      return {
        ok: true,
        text: "",
        structured,
        threadId: null,
        requestedModel: req.model,
        observedModel: req.model,
        observedEffort: null,
        accessVerified: true,
        permissionDenials: 0,
        ...(forced ?? {}),
      };
    },
  });

  const health: HealthPort = {
    ensure: vi.fn(async (providers: AgentProvider[]) => {
      ensured.push([...providers]);
      return Object.fromEntries(providers.map((p) => [p, script.health?.[p] ?? "ready"]));
    }),
    noteFailure: (provider, failure) => noted.push([provider, failure]),
    recentFailures: () => ({}),
  };
  const available = script.runners ?? ["claude-code", "codex"];
  const deps = {
    runners: Object.fromEntries(available.map((p) => [p, runner(p)])),
    health,
    modelClasses: { "claude-code": ["FRONTIER" as const], codex: ["FRONTIER" as const] },
    route: (req: { provider: AgentProvider }) => ({
      ok: true as const,
      model: req.provider === "codex" ? "gpt-6-sol" : "claude-sonnet-5",
      effort: "medium",
      modelClass: "BALANCED" as const,
      reason: "test",
    }),
    graph: graphPort(),
    worktrees: new WorktreeManager(),
    verify: async (_cwd: string, commands: string[]): Promise<VerifyResult[]> =>
      commands.map((command) => ({ command, ok: true, exitCode: 0, output: "" })),
    sink: async (op: TeamOp, payload: Record<string, unknown>) => {
      ops.push({ op, payload });
      return {};
    },
    onProgress: (p: TeamProgress) => progress.push(p),
  };
  return {
    calls,
    ops,
    deps,
    progress,
    noted,
    ensured,
    of: (op: TeamOp) => ops.filter((o) => o.op === op).map((o) => o.payload),
    stages: () =>
      progress
        .at(-1)!
        .stages.map((s) => `${s.key}:${s.state}`)
        .join(" "),
  };
}

// ---------------------------------------------------------------------------
describe("preflight: before any agent runs", () => {
  it("blocks a team job when Claude Code needs sign-in: no agent call, no plan, no status past normalising", async () => {
    const h = harness({ health: { "claude-code": "needs_sign_in" } });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);

    expect(outcome).toMatchObject({ verdict: "BLOCKED", reason: "agent_needs_sign_in" });
    expect(h.calls).toEqual([]);
    expect(h.of("set_final")).toEqual([
      expect.objectContaining({
        verdict: "BLOCKED",
        reason: "agent_needs_sign_in",
        provider: "claude-code",
        summary: "Claude Code needs you to sign in again on this computer.",
      }),
    ]);
    for (const op of ["set_plan", "set_spec", "open_round", "record_usage"] as TeamOp[]) {
      expect(h.of(op), op).toEqual([]);
    }
    const statuses = h.of("set_status").map((p) => p.status);
    expect(statuses.every((s) => s === "normalising")).toBe(true);
    // Both participants were checked before anything ran.
    expect(h.ensured[0]).toEqual(["claude-code", "codex"]);
    expect(h.stages()).toBe(
      "understanding:failed plan:skipped build:skipped review:skipped integration:skipped",
    );
  });

  it("reports each unhealthy state with its own reason, and names the provider", async () => {
    const cases: [ProviderHealth, string][] = [
      ["api_key_auth", "api_key_auth"],
      ["usage_exhausted", "usage_exhausted"],
      ["not_installed", "agent_unavailable"],
      ["unknown", "agent_unavailable"],
    ];
    for (const [health, reason] of cases) {
      const h = harness({ health: { codex: health } });
      const outcome = await new TeamOrchestrator(
        job({ mode: "solo", builder: "codex" }),
        h.deps,
      ).run(repo);
      expect(outcome.verdict, health).toBe("BLOCKED");
      expect(h.of("set_final")[0], health).toMatchObject({ reason, provider: "codex" });
      expect(h.calls, health).toEqual([]);
    }
  });

  it("never substitutes: an explicit builder that needs sign-in blocks, even with another agent ready", async () => {
    const h = harness({ health: { "claude-code": "needs_sign_in" } });
    const outcome = await new TeamOrchestrator(
      job({ mode: "pair", builder: "claude-code" }),
      h.deps,
    ).run(repo);
    expect(outcome.reason).toBe("agent_needs_sign_in");
    expect(h.calls).toEqual([]);
  });

  it("a solo job left to ThreadLink goes to an agent that is ready", async () => {
    const h = harness({ health: { "claude-code": "needs_sign_in" } });
    const outcome = await new TeamOrchestrator(job({ mode: "solo", builder: null }), h.deps).run(
      repo,
    );
    expect(outcome.verdict).toBe("PASS");
    expect(new Set(h.calls.map((c) => c.provider))).toEqual(new Set(["codex"]));
  });

  it("refuses a role override whose provider is not ready, rather than giving the role away", async () => {
    const h = harness({ health: { codex: "needs_sign_in" } });
    const outcome = await new TeamOrchestrator(
      job({ roleOverrides: { coordinator: "codex" } }),
      h.deps,
    ).run(repo);
    expect(outcome).toMatchObject({ verdict: "BLOCKED", reason: "agent_needs_sign_in" });
    expect(h.of("set_final")[0]).toMatchObject({ provider: "codex" });
    expect(h.calls).toEqual([]);
  });

  it("without a health port, an agent with no runner is unavailable (as before)", async () => {
    const h = harness({ runners: ["claude-code"] });
    // No health port at all, as older callers construct the orchestrator.
    const deps = { ...h.deps, health: undefined };
    const outcome = await new TeamOrchestrator(job(), deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "BLOCKED", reason: "agent_unavailable" });
    expect(outcome.summary).toMatch(/Codex is not available/);
  });
});

// ---------------------------------------------------------------------------
describe("an auth failure in the middle of a job", () => {
  it("stops BLOCKED with agent_needs_sign_in, names the provider and reports health at once", async () => {
    const h = harness({
      fail: (req, provider) =>
        provider === "codex" && req.role === "builder"
          ? {
              ok: false,
              failure: "not_authenticated",
              error: "Codex failed (exit 1): Not logged in. Please run `codex login`",
            }
          : null,
    });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(outcome).toMatchObject({
      verdict: "BLOCKED",
      reason: "agent_needs_sign_in",
      summary: "Codex needs you to sign in again on this computer.",
    });
    expect(h.of("set_final")[0]).toMatchObject({ provider: "codex" });
    expect(h.noted).toEqual([["codex", "not_authenticated"]]);
    // The plan was agreed before the failure, so it is shown done; Build failed.
    expect(h.stages()).toBe(
      "understanding:done plan:done build:failed review:skipped integration:skipped",
    );
  });

  // Seen for real: Claude Code's OAuth refresh failed once, the next call worked.
  const oauthOnce = () => {
    let failed = false;
    return (req: { role: string }, provider: AgentProvider) => {
      if (provider !== "claude-code" || failed) return null;
      failed = true;
      return {
        ok: false,
        failure: "not_authenticated" as const,
        error: "Claude Code reported an error (exit 1): Failed to refresh OAuth token",
      };
    };
  };

  it("a one-off token refresh failure: a fresh check says ready, the SAME agent is asked once more", async () => {
    const h = harness({ fail: oauthOnce() });
    const confirm = vi.fn(async () => "ready" as const);
    h.deps.health.confirm = confirm;
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(confirm).toHaveBeenCalledWith("claude-code");
    expect(outcome.verdict).toBe("PASS");
    // The failed attempt is on record, and nothing moved to another provider.
    expect(h.of("record_usage").some((u) => u.outcome === "not_authenticated")).toBe(true);
  });

  it("a confirmed sign-out stops the job: no retry, no substitution", async () => {
    const h = harness({ fail: oauthOnce() });
    h.deps.health.confirm = vi.fn(async () => "needs_sign_in" as const);
    const before = h.calls.length;
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "BLOCKED", reason: "agent_needs_sign_in" });
    expect(h.of("set_final")[0]).toMatchObject({ provider: "claude-code" });
    // Claude Code was called exactly once for the failing step; Codex never took it over.
    const claudeCalls = h.calls.slice(before).filter((c) => c.provider === "claude-code");
    expect(claudeCalls.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe("provider-neutral roles in a real job", () => {
  it("a job where Codex coordinates calls Codex to normalise", async () => {
    const h = harness();
    await new TeamOrchestrator(job({ roleOverrides: { coordinator: "codex" } }), h.deps).run(repo);
    expect(h.calls.find((c) => c.kind === "normalise")?.provider).toBe("codex");
  });

  it("follows assignRoles: coordinator normalises, planner plans, someone else reviews the plan", async () => {
    // Find a job id where automatic assignment makes Codex the coordinator.
    const ready = (p: AgentProvider) => ({
      provider: p,
      health: "ready" as const,
      modelClasses: ["FRONTIER" as const],
    });
    let id = -1;
    let expected = null as null | { coordinator: AgentProvider; planner: AgentProvider };
    for (let i = 0; i < 50 && !expected; i++) {
      const r = assignRoles({
        mode: "team",
        participants: [ready("claude-code"), ready("codex")],
        roomPrefs: { "claude-code": ALL_ROLES, codex: ALL_ROLES },
        seed: jobId(i),
      });
      if (r.ok && r.coordinator === "codex") {
        id = i;
        expected = { coordinator: r.coordinator, planner: r.planner };
      }
    }
    expect(expected).not.toBeNull();
    const h = harness();
    const outcome = await new TeamOrchestrator(job({ jobId: jobId(id) }), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(h.calls.find((c) => c.kind === "normalise")?.provider).toBe("codex");
    expect(h.calls.find((c) => c.kind === "plan")?.provider).toBe(expected!.planner);
    const planReviewer = h.calls.find((c) => c.kind === "plan-review")!.provider;
    expect(planReviewer).not.toBe(expected!.planner);
    // Nobody reviews their own work.
    const build = h.calls.find((c) => c.kind === "build")!;
    const review = h.calls.find((c) => c.kind === "code-review")!;
    expect(review.provider).not.toBe(build.provider);
  });

  it("records the assignment as a decision in fixed words the server accepts", async () => {
    const h = harness();
    await new TeamOrchestrator(job({ roleOverrides: { coordinator: "codex" } }), h.deps).run(repo);
    const roles = h.of("add_decision").find((d) => d.topic === "Roles chosen")!;
    expect(roles.resolution).toMatch(/^Roles: Codex coordinates \(you chose it\);/);
    expect(JSON.stringify(roles)).not.toContain("AGENT-WRITTEN");
    expect(roles.evidence).toMatchObject({ coordinator: "codex" });
    expect(teamWriteOpSchema.safeParse({ op: "add_decision", payload: roles }).success).toBe(true);
  });

  it("does not assume a Claude builder in Builder + Reviewer: an unnamed builder is assigned", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const h = harness();
      await new TeamOrchestrator(job({ jobId: jobId(i), mode: "pair" }), h.deps).run(repo);
      const build = h.calls.find((c) => c.kind === "build")!;
      const review = h.calls.find((c) => c.kind === "code-review")!;
      expect(review.provider).not.toBe(build.provider);
      seen.add(build.provider);
    }
    expect(seen.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("stages in the desktop feed", () => {
  it("failure during normalisation", async () => {
    const h = harness({
      fail: (req) =>
        req.prompt.includes("precise engineering specification")
          ? { ok: false, failure: "provider_error", error: "boom" }
          : null,
    });
    await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(h.stages()).toBe(
      "understanding:failed plan:skipped build:skipped review:skipped integration:skipped",
    );
  });

  it("failure before the first planning round, and during planning: Plan never shows done", async () => {
    const h = harness({
      fail: (req) =>
        req.role === "planner" ? { ok: false, failure: "provider_error", error: "boom" } : null,
    });
    await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(h.stages()).toBe(
      "understanding:done plan:failed build:skipped review:skipped integration:skipped",
    );
    for (const p of h.progress) {
      expect(p.stages.find((s) => s.key === "plan")!.state).not.toBe("done");
    }

    const during = harness({
      fail: (req) =>
        req.prompt.includes("Review the plan")
          ? { ok: false, failure: "timeout", error: "slow" }
          : null,
    });
    await new TeamOrchestrator(job({ jobId: jobId(99) }), during.deps).run(repo);
    expect(during.stages()).toBe(
      "understanding:done plan:failed build:skipped review:skipped integration:skipped",
    );
  });

  it("a passing job ends with every stage done", async () => {
    const h = harness();
    await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(h.stages()).toBe("understanding:done plan:done build:done review:done integration:done");
    // While it ran, Plan turned done only after the plan was written.
    const firstDone = h.progress.findIndex(
      (p) => p.stages.find((s) => s.key === "plan")!.state === "done",
    );
    const planWritten = h.ops.findIndex((o) => o.op === "set_plan");
    expect(firstDone).toBeGreaterThan(-1);
    expect(planWritten).toBeGreaterThan(-1);
  });
});
