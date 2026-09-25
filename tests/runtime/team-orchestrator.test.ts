import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamJobDefinition } from "../../runtime/src/team/job.ts";
import {
  TeamOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type TeamOp,
  type VerifyResult,
} from "../../runtime/src/team/orchestrator.ts";
import { graphPort } from "../../runtime/src/team/ports.ts";
import type { Plan, Review } from "../../runtime/src/team/prompts.ts";
import type { AgentProvider } from "../../runtime/src/team/types.ts";
import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * The orchestrator's rules, each driven end to end: real git worktrees, the
 * real task graph, and scripted agents that behave however a test needs them
 * to -- agree, disagree, run out of usage, or run the wrong model.
 */

vi.setConfig({ testTimeout: 120_000 });

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-team-"));
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const job = (over: Partial<TeamJobDefinition> = {}): TeamJobDefinition => ({
  jobId: `tljob_${"a".repeat(32)}`,
  roomId: `tlrom_${"b".repeat(32)}`,
  roomName: "Prism",
  goal: "Build the new Prism reporting workflow.",
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
    {
      provider: "claude-code",
      displayName: "Prism Claude",
      roles: ["planner", "builder", "integrator"],
    },
    { provider: "codex", displayName: "Prism Codex", roles: ["builder", "reviewer"] },
  ],
  verifyCommands: ["npm test"],
  ...over,
});

const SPEC = {
  goal: "x",
  requirements: ["Reports"],
  constraints: [],
  architectureConstraints: [],
  securityConstraints: [],
  filesAndSystems: [],
  testsRequired: [],
  doNotChange: [],
  deploymentRules: [],
  definitionOfDone: [],
};

const node = (key: string, owner: AgentProvider, files: string[], dependsOn: string[] = []) => ({
  key,
  title: `Unit ${key}`,
  scope: `Build ${key}`,
  files,
  dependsOn,
  suggestedOwner: owner,
  rationale: "fits",
  complexity: "medium" as const,
  risk: { security: false, database: false, architecture: false, deployment: false },
});

const PLAN: Plan = {
  summary: "Backend by Claude, UI by Codex.",
  nodes: [node("backend", "claude-code", ["backend.ts"]), node("ui", "codex", ["ui.ts"])],
  risks: [],
};

const approve = (summary = "Looks right."): Review => ({
  verdict: "APPROVED",
  summary,
  findings: [],
  ownershipObjections: [],
});

const revise = (summary = "Fix it.", severity: "blocking" | "important" = "blocking"): Review => ({
  verdict: "REVISE",
  summary,
  findings: [
    {
      severity,
      category: "correctness",
      summary: "Off by one",
      detail: "loop bound",
      file: null,
      line: null,
    },
  ],
  ownershipObjections: [],
});

type Call = {
  provider: AgentProvider;
  role: string;
  key: string | null;
  access: string;
  cwd: string;
  start: number;
  end: number;
};

type Script = {
  plan?: (round: number) => Plan;
  planReview?: (round: number) => Review;
  codeReview?: (key: string, round: number) => Review;
  inspection?: () => {
    verdict: "PASS" | "NEEDS_FIX" | "BLOCKED" | "NEEDS_USER_DECISION";
    summary: string;
    findings: Review["findings"];
    requirementsMet: { requirement: string; met: boolean; evidence: string }[];
    uncertainty: string[];
  };
  build?: (key: string, cwd: string, round: number) => void;
  /** Set false for plans whose units must not run together. */
  parallelProbe?: boolean;
  /** Lets a test make a "read-only" run write something. */
  sideEffect?: (req: AgentRunRequest) => void;
  fail?: (req: AgentRunRequest) => Partial<AgentRunResult> | null;
};

function team(script: Script = {}) {
  const calls: Call[] = [];
  const rounds = {
    plan: 0,
    planReview: 0,
    build: new Map<string, number>(),
    review: new Map<string, number>(),
  };

  const keyOf = (prompt: string) => /\(([a-z0-9-]+)\)/.exec(prompt)?.[1] ?? null;

  // Proves parallelism without depending on timing: each builder waits until
  // the other has started (or gives up after a few seconds, if run serially).
  let building = 0;
  let maxBuilding = 0;
  const bothBuilding = () =>
    new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () =>
        maxBuilding >= 2 || Date.now() - started > 3_000 ? resolve() : setTimeout(tick, 10);
      tick();
    });

  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: provider === "codex",
    async run(req) {
      const start = Date.now();
      const key = keyOf(req.prompt);
      const base: AgentRunResult = {
        ok: true,
        text: "",
        threadId: `${provider}-thread-${calls.length}`,
        requestedModel: req.model,
        observedModel: req.model,
        observedEffort: req.effort ?? null,
        accessVerified: true,
        permissionDenials: 0,
      };
      const forced = script.fail?.(req);
      let structured: unknown;

      if (req.prompt.includes("precise engineering specification")) {
        structured = SPEC;
      } else if (req.role === "planner") {
        structured = (script.plan ?? (() => PLAN))(++rounds.plan);
      } else if (req.prompt.includes("Review the plan")) {
        structured = (script.planReview ?? (() => approve()))(++rounds.planReview);
      } else if (req.role === "builder") {
        const r = (rounds.build.get(key!) ?? 0) + 1;
        rounds.build.set(key!, r);
        building++;
        maxBuilding = Math.max(maxBuilding, building);
        if (r === 1 && script.parallelProbe !== false) await bothBuilding();
        building--;
        (
          script.build ??
          ((k, cwd) => writeFileSync(join(cwd, `${k}.ts`), `export const v = ${r};\n`))
        )(key!, req.cwd, r);
        structured = {
          summary: `Built ${key}`,
          filesChanged: [`${key}.ts`],
          testsRun: [],
          openQuestions: [],
        };
      } else if (req.prompt.includes("Review the change")) {
        const r = (rounds.review.get(key!) ?? 0) + 1;
        rounds.review.set(key!, r);
        structured = (script.codeReview ?? (() => approve()))(key!, r);
      } else if (req.prompt.includes("final independent inspection")) {
        structured = (
          script.inspection ??
          (() => ({
            verdict: "PASS" as const,
            summary: "Meets the specification.",
            findings: [],
            requirementsMet: [{ requirement: "Reports", met: true, evidence: "tests" }],
            uncertainty: [],
          }))
        )();
      }
      script.sideEffect?.(req);
      calls.push({
        provider,
        role: req.role,
        key,
        access: req.access,
        cwd: req.cwd,
        start,
        end: Date.now(),
      });
      return { ...base, structured, ...(forced ?? {}) };
    },
  });

  const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
  let findingSeq = 0;
  const verified: string[][] = [];
  const deps = {
    runners: { "claude-code": runner("claude-code"), codex: runner("codex") },
    route: vi.fn((req: { provider: AgentProvider }) => ({
      ok: true as const,
      model: req.provider === "codex" ? "gpt-6-sol" : "claude-sonnet-5",
      effort: "medium",
      modelClass: "BALANCED" as const,
      reason: "Medium-complexity work.",
    })),
    graph: graphPort(),
    worktrees: new WorktreeManager(),
    verify: vi.fn(async (_cwd: string, commands: string[]): Promise<VerifyResult[]> => {
      verified.push(commands);
      return commands.map((command) => ({ command, ok: true, exitCode: 0, output: "ok" }));
    }),
    sink: vi.fn(async (op: TeamOp, payload: Record<string, unknown>) => {
      ops.push({ op, payload });
      if (op === "add_finding")
        return { findingId: `tlfnd_${String(++findingSeq).padStart(32, "0")}` };
      return {};
    }),
  };
  return {
    calls,
    ops,
    deps,
    verified,
    maxBuilding: () => maxBuilding,
    final: () => ops.find((o) => o.op === "set_final")?.payload,
  };
}

// ---------------------------------------------------------------------------
// The acceptance path
// ---------------------------------------------------------------------------

describe("a team job that goes well", () => {
  it("plans, builds in parallel, cross-reviews, integrates, tests and passes", async () => {
    const t = team();
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);

    expect(outcome.verdict).toBe("PASS");
    expect(t.final()).toMatchObject({ verdict: "PASS" });

    // Each unit was built by its owner and reviewed by the other provider.
    const builds = t.calls.filter((c) => c.role === "builder");
    const reviews = t.calls.filter((c) => c.role === "reviewer" && c.key);
    expect(builds.find((b) => b.key === "backend")?.provider).toBe("claude-code");
    expect(builds.find((b) => b.key === "ui")?.provider).toBe("codex");
    expect(reviews.find((r) => r.key === "backend")?.provider).toBe("codex");
    expect(reviews.find((r) => r.key === "ui")?.provider).toBe("claude-code");

    // Builders write; every review is read-only.
    expect(builds.every((b) => b.access === "workspace-write")).toBe(true);
    expect(t.calls.filter((c) => c.role !== "builder").every((c) => c.access === "read-only")).toBe(
      true,
    );

    // The two builds genuinely ran at the same time.
    expect(t.maxBuilding()).toBe(2);

    // The integrated result contains both units, on a branch left for the user.
    const branch = outcome.evidence.integrationBranch!;
    expect(git("show", `${branch}:backend.ts`)).toContain("export const v");
    expect(git("show", `${branch}:ui.ts`)).toContain("export const v");

    // Tests were run by ThreadLink, with the owner's commands.
    expect(t.verified.flat()).toContain("npm test");
    expect(outcome.evidence.tests.every((r) => r.ok)).toBe(true);
  });

  it("never touches the user's own checkout", async () => {
    writeFileSync(join(repo, "README.md"), "# Prism — my uncommitted edit\n");
    const t = team();
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# Prism — my uncommitted edit\n");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // And it says the result was built without that edit.
    expect(outcome.evidence.baseExcludedUncommittedChanges).toBe(true);
    expect(outcome.evidence.uncertainty.join(" ")).toMatch(/uncommitted changes/);
  });

  it("has the final inspection done by the provider that did not integrate", async () => {
    const t = team();
    await new TeamOrchestrator(job(), t.deps).run(repo);
    const inspection = t.calls.find((c) => c.role === "security_reviewer")!;
    // Claude integrates in this room, so Codex inspects.
    expect(inspection.provider).toBe("codex");
  });

  it("records every model it chose, with the reason", async () => {
    const t = team();
    await new TeamOrchestrator(job(), t.deps).run(repo);
    const usage = t.ops.filter((o) => o.op === "record_usage").map((o) => o.payload);
    expect(usage.length).toBeGreaterThan(5);
    for (const u of usage) {
      expect(u.requestedModel).toBeTruthy();
      expect(u.observedModel).toBe(u.requestedModel);
      expect(String(u.reason).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Review loops
// ---------------------------------------------------------------------------

describe("the review loop", () => {
  it("sends blocking findings back to the owner, and passes once they are fixed", async () => {
    const t = team({
      codeReview: (key, round) => (key === "backend" && round === 1 ? revise() : approve()),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);

    expect(outcome.verdict).toBe("PASS");
    // Claude built backend twice: once, then again to fix.
    expect(t.calls.filter((c) => c.role === "builder" && c.key === "backend")).toHaveLength(2);
    expect(
      t.ops.some((o) => o.op === "set_finding_status" && o.payload.status === "resolved"),
    ).toBe(true);
  });

  it("sends a BLOCKED code review back to the owner to fix, like a real run needed", async () => {
    // Real run: Claude reviewed Codex's mul.js, found `module.exports = mul`
    // against a test that destructures { mul }, and said BLOCKED. That is a
    // one-line fix for the owner, not the end of the unit.
    const t = team({
      codeReview: (key, round) =>
        key === "ui" && round === 1
          ? { ...revise("Export is wrong."), verdict: "BLOCKED" as const }
          : approve(),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(t.calls.filter((c) => c.role === "builder" && c.key === "ui")).toHaveLength(2);
  });

  it("still fails a unit whose reviews stay BLOCKED once the budget is spent", async () => {
    const t = team({
      codeReview: (key) =>
        key === "ui" ? { ...revise("Still wrong."), verdict: "BLOCKED" as const } : approve(),
    });
    const outcome = await new TeamOrchestrator(
      job({ budgets: { maxPlanningRounds: 2, maxReviewRounds: 1, parallelAgents: 2 } }),
      t.deps,
    ).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
  });

  it("does not manufacture a PASS when the budget runs out", async () => {
    const t = team({ codeReview: (key) => (key === "backend" ? revise() : approve()) });
    const outcome = await new TeamOrchestrator(
      job({ budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 2 } }),
      t.deps,
    ).run(repo);

    expect(outcome.verdict).toBe("NEEDS_FIX");
    expect(t.final()).toMatchObject({ verdict: "NEEDS_FIX" });
    // One build plus two fix rounds, then it stopped.
    expect(t.calls.filter((c) => c.role === "builder" && c.key === "backend")).toHaveLength(3);
  });

  it("treats an APPROVED review that still has a blocking finding as not approved", async () => {
    const t = team({
      codeReview: (key, round) =>
        key === "ui" && round === 1
          ? { ...revise("Approved, but…"), verdict: "APPROVED" as const }
          : approve(),
    });
    await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(t.calls.filter((c) => c.role === "builder" && c.key === "ui")).toHaveLength(2);
  });

  it("does not reopen a round for non-blocking style comments", async () => {
    const t = team({
      codeReview: () => ({
        verdict: "APPROVED",
        summary: "Fine, minor style.",
        findings: [
          {
            severity: "non_blocking",
            category: "correctness",
            summary: "Prefer const",
            detail: "",
            file: null,
            line: null,
          },
        ],
        ownershipObjections: [],
      }),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(t.calls.filter((c) => c.role === "builder")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("planning", () => {
  it("revises the plan on a substantive objection and records the agreement", async () => {
    const t = team({
      planReview: (round) => (round === 1 ? revise("Split differently.") : approve()),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(t.calls.filter((c) => c.role === "planner")).toHaveLength(2);
    const plan = t.ops.find((o) => o.op === "set_plan")!.payload;
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.ops.some((o) => o.op === "add_decision" && o.payload.topic === "Plan agreed")).toBe(
      true,
    );
  });

  it("hands an unresolved plan to the owner instead of debating forever", async () => {
    const t = team({ planReview: () => revise("Still wrong.") });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(t.calls.filter((c) => c.role === "planner")).toHaveLength(2);
    expect(t.calls.some((c) => c.role === "builder")).toBe(false);
  });

  it("treats a plan that is not a valid graph as a blocking finding for the planner", async () => {
    const cyclic: Plan = {
      summary: "loop",
      nodes: [node("a", "claude-code", ["a.ts"], ["b"]), node("b", "codex", ["b.ts"], ["a"])],
      risks: [],
    };
    const t = team({ plan: (round) => (round === 1 ? cyclic : PLAN) });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(
      t.ops.some((o) => o.op === "add_finding" && String(o.payload.detail).includes("loop")),
    ).toBe(true);
  });

  it("runs units that touch the same files one after the other, and says why", async () => {
    const overlapping: Plan = {
      summary: "Both touch shared.ts",
      nodes: [node("first", "claude-code", ["shared.ts"]), node("second", "codex", ["shared.ts"])],
      risks: [],
    };
    const t = team({
      plan: () => overlapping,
      build: (key, cwd) => writeFileSync(join(cwd, `${key}.ts`), `export const k = "${key}";\n`),
    });
    await new TeamOrchestrator(job(), t.deps).run(repo);
    const [a, b] = t.calls.filter((c) => c.role === "builder");
    expect(a!.end <= b!.start).toBe(true);
    expect(
      t.ops.some((o) => o.op === "add_decision" && String(o.payload.topic).startsWith("Run ")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Things that must stop the job, and must not be papered over
// ---------------------------------------------------------------------------

describe("when a provider cannot continue", () => {
  it("waits for the user when usage runs out, and never switches agents", async () => {
    const t = team({
      fail: (req) =>
        req.provider === "codex" && req.role === "builder"
          ? { ok: false, failure: "quota_exhausted", error: "usage limit reached" }
          : null,
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(outcome.summary).toMatch(/usage is exhausted/);
    // The UI unit was Codex's. Claude never built it in Codex's place.
    expect(
      t.calls.some((c) => c.provider === "claude-code" && c.role === "builder" && c.key === "ui"),
    ).toBe(false);
  });

  it("stops the other agent's work, and waits for it, when one unit stops the job", async () => {
    // A real run hit this: Codex's build stopped the job while Claude was still
    // building, and cleanup tried to delete the worktree Claude was writing to.
    const t = team({
      parallelProbe: false,
      fail: (req) =>
        req.provider === "codex" && req.role === "builder"
          ? { ok: false, failure: "quota_exhausted", error: "usage limit reached" }
          : null,
    });
    const claude = t.deps.runners["claude-code"];
    let sawAbort = false;
    let claudeFinishedAt = 0;
    t.deps.runners["claude-code"] = {
      provider: "claude-code",
      verifiesAccess: false,
      async run(req) {
        if (req.role !== "builder") return claude.run(req);
        // Build slowly, the way a real agent does, until told to stop.
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 20_000);
        });
        sawAbort = Boolean(req.signal?.aborted);
        claudeFinishedAt = Date.now();
        return {
          ok: false,
          text: "",
          threadId: null,
          requestedModel: req.model,
          observedModel: req.model,
          observedEffort: null,
          accessVerified: false,
          permissionDenials: 0,
          failure: "timeout",
        };
      },
    };
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    const returnedAt = Date.now();

    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(sawAbort).toBe(true);
    expect(claudeFinishedAt).toBeGreaterThan(0);
    expect(claudeFinishedAt).toBeLessThanOrEqual(returnedAt);
  });

  it("refuses work done by a model it did not choose", async () => {
    const t = team({
      fail: (req) =>
        req.provider === "claude-code" && req.role === "builder"
          ? { ok: false, failure: "model_mismatch", observedModel: "claude-opus-5-5" }
          : null,
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.summary).toMatch(/ran claude-opus-5-5 instead of/);
  });

  it("refuses a review that could not confirm it was read-only", async () => {
    const t = team({
      fail: (req) => (req.prompt.includes("Review the change") ? { accessVerified: false } : null),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.summary).toMatch(/could not confirm it ran with read-only access/);
  });

  it("refuses a 'read-only' review that changed files, whichever provider it was", async () => {
    // Claude cannot report its sandbox, so this observed check is what holds it
    // to read-only. It applies to Codex as well.
    const t = team({
      sideEffect: (req) => {
        if (req.provider === "claude-code" && req.prompt.includes("Review the change")) {
          writeFileSync(
            join(req.cwd, "sneaky.ts"),
            "export const x = 1;" + String.fromCharCode(10),
          );
        }
      },
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.summary).toMatch(/changed files during a read-only review/);
  });

  it("plans in its own worktree, never in the user's checkout", async () => {
    const t = team();
    await new TeamOrchestrator(job(), t.deps).run(repo);
    const planning = t.calls.filter((c) => c.role === "planner" || c.role === "coordinator");
    expect(planning.length).toBeGreaterThan(0);
    for (const c of planning) {
      expect(c.cwd).not.toBe(repo);
      expect(c.cwd).toContain(".threadlink");
    }
  });

  it("refuses to guess at an answer that is not in the required format", async () => {
    const t = team({
      fail: (req) => (req.prompt.includes("Review the plan") ? { structured: undefined } : null),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("BLOCKED");
  });

  it("needs both providers in the room: nobody reviews their own work", async () => {
    const t = team();
    const solo = job({
      agents: [{ provider: "claude-code", displayName: "Claude", roles: ["planner", "builder"] }],
    });
    const outcome = await new TeamOrchestrator(solo, t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(t.calls).toHaveLength(0);
  });

  it("does not run without an agent it needs, and does not substitute one", async () => {
    const t = team();
    const outcome = await new TeamOrchestrator(job(), {
      ...t.deps,
      runners: { "claude-code": t.deps.runners["claude-code"] },
    }).run(repo);
    expect(outcome.verdict).toBe("BLOCKED");
    expect(outcome.summary).toMatch(/Codex is not available/);
    expect(t.calls).toHaveLength(0);
  });

  it("never uses paid usage, even when the owner has allowed it, and says so", async () => {
    const t = team();
    const outcome = await new TeamOrchestrator(
      job({ policy: { ...job().policy, paidUsage: true } }),
      t.deps,
    ).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.evidence.uncertainty.join(" ")).toMatch(/No paid usage was used/);
  });

  it("asks the user when the router has no model it may use", async () => {
    const t = team();
    t.deps.route.mockImplementation((() => ({
      ok: false,
      reason: "No included usage left for Codex.",
      options: ["wait_for_reset", "ask_user"],
    })) as never);
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(t.ops.some((o) => o.op === "add_decision" && o.payload.needsUser === true)).toBe(true);
  });
});

describe("integration and inspection", () => {
  it("stops on a merge conflict and hands it to the owner", async () => {
    // Scope enforcement normally undoes the stray writes that would collide, so
    // it is switched off here to reach the conflict path, which stays as
    // defence in depth. Different declared files, so the units run in
    // parallel -- but both write shared.ts.
    const t = team({
      build: (key, cwd) => writeFileSync(join(cwd, "shared.ts"), `export const s = "${key}";\n`),
    });
    t.deps.graph = { ...t.deps.graph, outOfScope: () => [] };
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(outcome.summary).toMatch(/conflicts/);
    expect(t.ops.some((o) => o.op === "add_decision" && o.payload.needsUser === true)).toBe(true);
  });

  it("reports failing tests as NEEDS_FIX, however confident the agents were", async () => {
    const t = team();
    t.deps.verify.mockImplementation(async (_cwd, commands) =>
      commands.map((command) => ({ command, ok: false, exitCode: 1, output: "1 failed" })),
    );
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
    expect(outcome.summary).toMatch(/Tests failed/);
  });

  it("downgrades an inspection PASS that still has an important finding", async () => {
    const t = team({
      inspection: () => ({
        verdict: "PASS",
        summary: "Mostly fine.",
        findings: [
          {
            severity: "important",
            category: "security",
            summary: "RLS gap",
            detail: "",
            file: null,
            line: null,
          },
        ],
        requirementsMet: [],
        uncertainty: [],
      }),
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
  });

  it("says no tests were run when none were given, rather than implying they passed", async () => {
    const t = team();
    const outcome = await new TeamOrchestrator(job({ verifyCommands: [] }), t.deps).run(repo);
    expect(outcome.evidence.tests).toEqual([]);
    expect(outcome.evidence.uncertainty.join(" ")).toMatch(/ran no tests/);
  });
});

describe("what reaches the team log", () => {
  it("redacts secrets an agent writes into a review", async () => {
    const t = team({
      codeReview: () => approve("Uses key sk-ant-api03-abcdefghijklmnopqrstuvwx in config."),
    });
    await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(JSON.stringify(t.ops)).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwx");
  });

  it("records who wrote and who reviewed each unit in the commits", async () => {
    const t = team();
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    const log = git("log", outcome.evidence.integrationBranch!, "--format=%B");
    expect(log).toContain("Authored-by: Claude Code");
    expect(log).toContain("Authored-by: Codex");
  });
});

describe("keeping each unit to what the plan agreed", () => {
  it("undoes changes a builder made outside its unit's files, and records it", async () => {
    // Real run: Claude's add unit also wrote mul.js, which belonged to Codex.
    const t = team({
      build: (key, cwd, round) => {
        writeFileSync(join(cwd, `${key}.ts`), `export const v = ${round};\n`);
        if (key === "backend") writeFileSync(join(cwd, "ui.ts"), "export const stray = true;\n");
      },
    });
    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    const branch = outcome.evidence.integrationBranch!;
    // The integrated ui.ts is Codex's, not the stray one.
    expect(git("show", `${branch}:ui.ts`)).not.toContain("stray");
    expect(
      t.ops.some(
        (o) =>
          o.op === "add_decision" &&
          String(o.payload.topic).startsWith("Out-of-scope changes undone"),
      ),
    ).toBe(true);
  });

  it("tells a reviewer which other units exist, so it does not demand their files", async () => {
    const prompts: string[] = [];
    const t = team();
    const codex = t.deps.runners.codex;
    t.deps.runners.codex = {
      provider: "codex",
      verifiesAccess: true,
      run: (req) => {
        if (req.prompt.includes("Review the change")) prompts.push(req.prompt);
        return codex.run(req);
      },
    };
    await new TeamOrchestrator(job(), t.deps).run(repo);
    const review = prompts.find((p) => p.includes("(backend)"))!;
    expect(review).toContain("OTHER UNITS");
    expect(review).toContain("Unit ui (ui), owned by Codex: ui.ts");
    expect(review).toMatch(/expected to be missing here/);
  });

  it("hands a standoff to the owner when the builder declines every finding", async () => {
    // Real run: Codex kept saying "export the function directly", Claude kept
    // answering that the test needs an object and changed nothing.
    const t = team({
      codeReview: (key) => (key === "ui" ? revise("Export the function directly.") : approve()),
      build: (key, cwd) => writeFileSync(join(cwd, `${key}.ts`), "export const same = 1;\n"),
    });
    const outcome = await new TeamOrchestrator(
      job({ budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 2 } }),
      t.deps,
    ).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(outcome.summary).toMatch(/disagree/);
    expect(
      t.ops.some(
        (o) =>
          o.op === "add_decision" &&
          o.payload.needsUser === true &&
          String(o.payload.topic).includes("disagree"),
      ),
    ).toBe(true);
  });
});

describe("units that depend on other units", () => {
  it("start from their dependencies' approved work, and are reviewed only on their own change", async () => {
    // backend depends on schema: it must see schema.ts, and its reviewer must
    // not be shown schema.ts as part of backend's change.
    const dependent: Plan = {
      summary: "Schema first, then backend.",
      nodes: [
        node("schema", "codex", ["schema.ts"]),
        node("backend", "claude-code", ["backend.ts"], ["schema"]),
      ],
      risks: [],
    };
    let backendSawSchema = false;
    const diffs: Record<string, string> = {};
    const t = team({
      plan: () => dependent,
      parallelProbe: false,
      build: (key, cwd, round) => {
        if (key === "backend") backendSawSchema = existsSync(join(cwd, "schema.ts"));
        writeFileSync(join(cwd, `${key}.ts`), `export const v = ${round};\n`);
      },
    });
    const claude = t.deps.runners["claude-code"];
    const codex = t.deps.runners.codex;
    const capture = (r: AgentRunner): AgentRunner => ({
      provider: r.provider,
      verifiesAccess: r.verifiesAccess,
      run: (req) => {
        const key = /\(([a-z0-9-]+)\)/.exec(req.prompt)?.[1];
        if (key && req.prompt.includes("Review the change")) diffs[key] = req.prompt;
        return r.run(req);
      },
    });
    t.deps.runners = { "claude-code": capture(claude), codex: capture(codex) };

    const outcome = await new TeamOrchestrator(job(), t.deps).run(repo);

    expect(outcome.verdict).toBe("PASS");
    expect(backendSawSchema).toBe(true);
    // The backend review's diff is backend's change only.
    const backendDiff = diffs.backend!.split("BEGIN DIFF")[1] ?? "";
    expect(backendDiff).toContain("backend.ts");
    expect(backendDiff).not.toContain("schema.ts");
  });
});
