import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleExhausted,
  nextRecheckAt,
  RECHECK_INTERVAL_MS,
  type FailoverDeps,
} from "../../runtime/src/team/failover.ts";
import { ProviderHealthMonitor } from "../../runtime/src/team/health.ts";
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
import { classifyFailureText, parseResetTime } from "../../runtime/src/team/runner.ts";
import type { AgentProvider } from "../../runtime/src/team/types.ts";
import { UsageGovernor } from "../../runtime/src/team/usage.ts";
import { runFinishedPayload, runStartedPayload } from "../../runtime/src/team/wire.ts";
import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * docs/design/threadlink-0.11.md §5 (usage exhaustion and failover) and §3.5
 * (planning-round policy), plus the wire additions of §3.6.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

// ---------------------------------------------------------------------------
// Reset times: only what the provider printed (fixtures), never invented
// ---------------------------------------------------------------------------

describe("reset times from quota messages", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");

  it("reads Claude Code's machine-readable epoch form", () => {
    expect(parseResetTime("Claude AI usage limit reached|1790679600", now)).toBe(
      new Date(1790679600 * 1000).toISOString(),
    );
  });

  it("reads Claude Code's 'resets <time> (<zone>)' form in that zone", () => {
    // 3pm in London on 29 Sep 2026 (BST, UTC+1) is 14:00 UTC.
    expect(parseResetTime("5-hour limit reached ∙ resets 3pm (Europe/London)", now)).toBe(
      "2026-09-29T14:00:00.000Z",
    );
    // Already past today: the next day.
    expect(parseResetTime("You've hit your limit · resets 9am (UTC)", now)).toBe(
      "2026-09-30T09:00:00.000Z",
    );
    expect(parseResetTime("Weekly limit reached · resets Oct 3, 5pm (America/New_York)", now)).toBe(
      "2026-10-03T21:00:00.000Z",
    );
  });

  it("reads Codex's 'try again at' and 'try again in' forms", () => {
    expect(
      parseResetTime(
        "You've hit your usage limit. Upgrade to Pro or try again at Oct 3rd, 2026 5:12 PM (UTC).",
        now,
      ),
    ).toBe("2026-10-03T17:12:00.000Z");
    expect(parseResetTime("Rate limit reached. Please try again in 2 hours 5 minutes.", now)).toBe(
      new Date(now + 2 * 3_600_000 + 5 * 60_000).toISOString(),
    );
    expect(parseResetTime("usage limit reached; try again in 3 days", now)).toBe(
      new Date(now + 3 * 86_400_000).toISOString(),
    );
  });

  it("returns null when no reset time was stated, or it cannot be read exactly", () => {
    for (const text of [
      "You've hit your usage limit.",
      "429 Too Many Requests",
      "resets soon",
      "try again later",
      "resets 3pm (Mars/Olympus)",
      "Claude AI usage limit reached|12",
    ]) {
      expect(parseResetTime(text, now)).toBeNull();
    }
    // Still classified as a quota failure: the reset time is extra, not required.
    expect(classifyFailureText("You've hit your usage limit.")).toBe("quota_exhausted");
    // Codex 0.158, seen for real: a workspace with no credits is out of included usage.
    expect(classifyFailureText("Your workspace is out of credits. Add credits to continue.")).toBe(
      "quota_exhausted",
    );
  });
});

// ---------------------------------------------------------------------------
// Health and governor
// ---------------------------------------------------------------------------

describe("exhaustion is recorded with the stated reset only", () => {
  it("health keeps resetsAt for usage_exhausted and reports it; router treats it as unavailable", () => {
    const monitor = new ProviderHealthMonitor({
      discover: async () => [],
      probe: async () => "ok",
    });
    monitor.noteFailure("codex", "quota_exhausted", { resetsAt: "2026-09-29T15:00:00Z" });
    expect(monitor.get("codex")).toMatchObject({
      health: "usage_exhausted",
      resetsAt: "2026-09-29T15:00:00.000Z",
    });
    monitor.noteFailure("claude-code", "quota_exhausted");
    expect(monitor.get("claude-code").resetsAt).toBeNull();

    const governor = new UsageGovernor();
    governor.markExhausted("codex", null, Date.parse("2026-09-29T15:00:00Z"));
    expect(governor.exhausted(Date.parse("2026-09-29T14:00:00Z")).has("codex")).toBe(true);
    expect(governor.isAvailable("codex", null, Date.parse("2026-09-29T15:01:00Z"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The failover decision (no git)
// ---------------------------------------------------------------------------

function fakeClock(start = Date.parse("2026-09-29T10:00:00Z")) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => (now += ms),
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
}

function failoverDeps(
  answers: (op: string, payload: Record<string, unknown>) => Record<string, unknown> | void,
  over: Partial<FailoverDeps> = {},
) {
  const ops: { op: string; payload: Record<string, unknown> }[] = [];
  const time = fakeClock();
  const deps: FailoverDeps = {
    write: async (op, payload) => {
      ops.push({ op, payload });
      return answers(op, payload) ?? {};
    },
    clock: time.clock,
    signal: new AbortController().signal,
    choicePollMs: 15_000,
    ...over,
  };
  return { ops, deps, time };
}

const CHOICE = `tlchc_${"c".repeat(32)}`;
const chosen = (key: string) => ({ choices: [{ id: CHOICE, status: "chosen", chosenKey: key }] });

describe("failover policy (§5)", () => {
  it("auto: continues with another ready agent and says so once", async () => {
    const { ops, deps } = failoverDeps(() => undefined, { noticesSent: new Set() });
    const action = await handleExhausted(
      {
        provider: "codex",
        resetsAt: null,
        policy: "auto",
        alternatives: ["claude-code"],
        key: "k",
      },
      deps,
    );
    expect(action).toEqual({ action: "other", provider: "claude-code" });
    expect(ops).toEqual([
      {
        op: "failover_notice",
        payload: { from: "codex", to: "claude-code", reviewPending: false, resetsAt: null },
      },
    ]);
  });

  it("auto: a review nobody else may do is left pending, and the notice says so", async () => {
    const { ops, deps } = failoverDeps(() => undefined);
    const action = await handleExhausted(
      {
        provider: "codex",
        resetsAt: "2026-09-29T15:00:00Z",
        policy: "auto",
        alternatives: [],
        reviewPending: { continueWith: "claude-code" },
        key: "k",
      },
      deps,
    );
    expect(action).toEqual({ action: "skip", continueWith: "claude-code" });
    expect(ops[0]!.payload).toEqual({
      from: "codex",
      to: "claude-code",
      reviewPending: true,
      resetsAt: "2026-09-29T15:00:00.000Z",
    });
  });

  it("ask: offers continue_other / check_again / wait / stop, never retry", async () => {
    const { ops, deps } = failoverDeps((op) =>
      op === "request_choice"
        ? { choiceId: CHOICE }
        : op === "read_choices"
          ? chosen("continue_other")
          : undefined,
    );
    const action = await handleExhausted(
      { provider: "codex", resetsAt: null, policy: "ask", alternatives: ["claude-code"], key: "k" },
      deps,
    );
    const choice = ops.find((o) => o.op === "request_choice")!.payload;
    expect(choice.kind).toBe("usage_exhausted");
    expect((choice.options as { key: string }[]).map((o) => o.key)).toEqual([
      "continue_other",
      "check_again",
      "wait",
      "stop",
    ]);
    expect(action).toEqual({ action: "other", provider: "claude-code" });
  });

  it("check_again runs a fresh check and retries only when it is ready; otherwise asks again", async () => {
    let checks = 0;

    const recheck = vi.fn(async () => (++checks === 1 ? "usage_exhausted" : "ready") as never);
    const { ops, deps } = failoverDeps(
      (op) => {
        if (op === "request_choice") return { choiceId: CHOICE };
        if (op === "read_choices") return chosen("check_again");
      },
      { recheck },
    );
    const action = await handleExhausted(
      { provider: "codex", resetsAt: null, policy: "ask", alternatives: [], key: "k" },
      deps,
    );
    expect(action).toEqual({ action: "retry" });
    expect(recheck).toHaveBeenCalledTimes(2);
    // Asked twice: the first check said still exhausted.
    expect(ops.filter((o) => o.op === "request_choice")).toHaveLength(2);
    const keys = ops.filter((o) => o.op === "request_choice").map((o) => o.payload.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("wait: rechecks at the stated reset + 1 minute, then every 15 minutes, never hammering", async () => {
    const reset = "2026-09-29T11:00:00Z";
    const at: number[] = [];
    let checks = 0;
    const { deps, time } = failoverDeps(() => undefined, {
      recheck: async () => {
        at.push(time.clock.now());
        return (++checks >= 3 ? "ready" : "usage_exhausted") as never;
      },
    });
    const action = await handleExhausted(
      { provider: "codex", resetsAt: reset, policy: "wait", alternatives: [], key: "k" },
      // No choice support at all: waiting still works.
      deps,
    );
    expect(action).toEqual({ action: "retry" });
    expect(at[0]).toBe(Date.parse(reset) + 60_000);
    expect(at[1]! - at[0]!).toBe(RECHECK_INTERVAL_MS);
    expect(at[2]! - at[1]!).toBe(RECHECK_INTERVAL_MS);
    expect(nextRecheckAt(null, 0)).toBe(RECHECK_INTERVAL_MS);
  });

  it("stop ends it; a 24-hour wait ends it", async () => {
    const stop = failoverDeps((op) =>
      op === "request_choice"
        ? { choiceId: CHOICE }
        : op === "read_choices"
          ? chosen("stop")
          : undefined,
    );
    expect(
      await handleExhausted(
        { provider: "codex", resetsAt: null, policy: "ask", alternatives: [], key: "k" },
        stop.deps,
      ),
    ).toEqual({ action: "stop", why: "owner" });

    const never = failoverDeps(
      (op) => (op === "request_choice" ? { choiceId: CHOICE } : undefined),
      { choiceWaitMs: 60 * 60_000 },
    );
    expect(
      await handleExhausted(
        { provider: "codex", resetsAt: null, policy: "ask", alternatives: [], key: "k" },
        never.deps,
      ),
    ).toEqual({ action: "stop", why: "expired" });
  });
});

// ---------------------------------------------------------------------------
// In a real job (git worktrees, scripted agents)
// ---------------------------------------------------------------------------

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-failover-"));
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

const baseJob = (over: Partial<TeamJobDefinition> = {}): TeamJobDefinition => ({
  jobId: `tljob_${"a".repeat(32)}`,
  roomId: `tlrom_${"b".repeat(32)}`,
  roomName: "Prism",
  goal: "Add a health endpoint.",
  spec: {},
  budgets: { maxPlanningRounds: 3, maxReviewRounds: 2, parallelAgents: 1 },
  policy: {
    usagePolicy: "balanced",
    paidUsage: false,
    crossReview: true,
    finalInspection: true,
    worktreeIsolation: true,
    overrides: [],
  },
  agents: [
    { provider: "claude-code", displayName: "Claude Code", roles: ["planner", "builder"] },
    { provider: "codex", displayName: "Codex", roles: ["reviewer", "builder"] },
  ],
  verifyCommands: [],
  mode: "pair",
  builder: "claude-code",
  reviewer: "codex",
  ...over,
});

const approve: Review = {
  verdict: "APPROVED",
  summary: "ok",
  findings: [],
  ownershipObjections: [],
};

type Script = {
  fail?: (req: AgentRunRequest, n: number) => Partial<AgentRunResult> | null;
  planReview?: (round: number) => Review;
  choose?: (kind: string) => string | null;
};

function harness(script: Script = {}) {
  const calls: { provider: AgentProvider; role: string; prompt: string }[] = [];
  const counts = new Map<string, number>();

  let reviewRounds = 0;
  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: provider === "codex",
    async run(req) {
      calls.push({ provider, role: req.role, prompt: req.prompt });
      const k = `${provider}:${req.role}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      const base: AgentRunResult = {
        ok: true,
        text: "",
        threadId: null,
        requestedModel: req.model,
        observedModel: req.model,
        modelVerified: true,
        observedEffort: null,
        accessVerified: true,
        permissionDenials: 0,
        timings: { spawnMs: 3, firstEventMs: 4, providerMs: 9 },
      };
      const forced = script.fail?.(req, n);
      if (forced) return { ...base, ok: false, ...forced };
      let structured: unknown;
      if (req.prompt.includes("precise engineering specification")) {
        structured = {
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
      } else if (req.role === "planner") {
        structured = {
          summary: "One unit.",
          nodes: [
            {
              key: "health",
              title: "Health endpoint",
              scope: "Add it",
              files: ["health.ts"],
              dependsOn: [],
              suggestedOwner: "claude-code",
              rationale: "fits",
              complexity: "low",
              risk: { security: false, database: false, architecture: false, deployment: false },
            },
          ],
          risks: [],
        } satisfies Plan;
      } else if (req.prompt.includes("Review the plan")) {
        structured = (script.planReview ?? (() => approve))(++reviewRounds);
      } else if (req.role === "builder") {
        writeFileSync(join(req.cwd, "health.ts"), `export const ok = ${n};\n`);
        structured = {
          teamMessage: "Added the health endpoint returning ok.",
          summary: "Built",
          filesChanged: ["health.ts"],
          testsRun: [],
          openQuestions: [],
          findingResponses: [],
        };
      } else if (req.prompt.includes("Review the change")) {
        structured = { ...approve, teamMessage: "Reviewed: looks correct." };
      } else if (req.prompt.includes("final independent inspection")) {
        structured = {
          verdict: "PASS",
          summary: "Meets the spec.",
          findings: [],
          requirementsMet: [],
          uncertainty: [],
        };
      }
      return { ...base, structured };
    },
  });
  const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
  let choices = 0;
  let pendingKind = "";
  const deps = {
    runners: { "claude-code": runner("claude-code"), codex: runner("codex") },
    route: (req: { provider: AgentProvider }) => ({
      ok: true as const,
      model: req.provider === "codex" ? "gpt-5.5" : "claude-sonnet-5",
      effort: null,
      modelClass: "BALANCED" as const,
      reason: "test",
    }),
    graph: graphPort(),
    worktrees: new WorktreeManager(),
    verify: async (_c: string, commands: string[]): Promise<VerifyResult[]> =>
      commands.map((command) => ({ command, ok: true, exitCode: 0, output: "ok" })),
    sink: async (op: TeamOp, payload: Record<string, unknown>) => {
      ops.push({ op, payload });
      if (op === "run_started") return { runId: `tlarn_${String(ops.length).padStart(32, "0")}` };
      if (op === "request_choice" && script.choose) {
        pendingKind = String(payload.kind);
        return { choiceId: `tlchc_${String(++choices).padStart(32, "0")}` };
      }
      if (op === "read_choices" && script.choose && pendingKind) {
        const key = script.choose(pendingKind);
        const ids = (payload.choiceIds as string[]) ?? [];
        return key && ids[0]
          ? { choices: [{ id: ids[0], status: "chosen", chosenKey: key }] }
          : { choices: [] };
      }
      return {};
    },
    clock: { now: () => Date.now(), sleep: async () => undefined },
    choicePollMs: 1,
    controlPollMs: 0,
  };
  return { calls, ops, deps };
}

const quota = (req: AgentRunRequest, provider: AgentProvider, role: string) =>
  req.provider === provider && req.role === role
    ? {
        failure: "quota_exhausted" as const,
        error: "usage limit reached",
        resetsAt: "2026-09-29T15:00:00.000Z",
      }
    : null;

describe("failover in an engineering job (§5)", () => {
  it("auto: the reviewer runs out, the work finishes and the verdict is REVIEW_PENDING, never PASS", async () => {
    const h = harness({ fail: (req) => quota(req, "codex", "reviewer") });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "auto" }), h.deps).run(
      repo,
    );
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(outcome.summary).toMatch(/review pending/i);
    // Claude never reviewed its own work.
    expect(h.calls.some((c) => c.provider === "claude-code" && c.role === "reviewer")).toBe(false);
    const notice = h.ops.find((o) => o.op === "failover_notice")!.payload;
    expect(notice).toEqual({
      from: "codex",
      to: "claude-code",
      reviewPending: true,
      resetsAt: "2026-09-29T15:00:00.000Z",
    });
    const final = h.ops.find((o) => o.op === "set_final")!.payload;
    expect(final.verdict).toBe("REVIEW_PENDING");
    expect(final.provider).toBe("codex");
  });

  it("auto: the builder runs out, another ready agent builds, and its own work is not self-reviewed", async () => {
    const h = harness({ fail: (req) => quota(req, "claude-code", "builder") });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "auto" }), h.deps).run(
      repo,
    );
    expect(h.calls.filter((c) => c.role === "builder").map((c) => c.provider)).toEqual([
      "claude-code",
      "codex",
    ]);
    // Codex built it, so Codex does not review it: the review waits for Claude.
    expect(h.calls.some((c) => c.provider === "codex" && c.role === "reviewer")).toBe(false);
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(h.ops.find((o) => o.op === "failover_notice")!.payload).toMatchObject({
      from: "claude-code",
      to: "codex",
      reviewPending: false,
    });
  });

  it("ask: check_again retries only after a fresh check says ready", async () => {
    let confirmed = 0;
    const h = harness({
      fail: (req, n) => (n === 1 ? quota(req, "codex", "reviewer") : null),
      choose: (kind) => (kind === "usage_exhausted" ? "check_again" : null),
    });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "ask" }), {
      ...h.deps,
      health: {
        ensure: async (ps: AgentProvider[]) => Object.fromEntries(ps.map((p) => [p, "ready"])),
        confirm: async () => (++confirmed, "ready" as const),
      },
    }).run(repo);
    expect(confirmed).toBe(1);
    expect(outcome.verdict).toBe("PASS");
    expect(h.calls.filter((c) => c.provider === "codex" && c.role === "reviewer")).toHaveLength(2);
    const choice = h.ops.find((o) => o.op === "request_choice")!.payload;
    expect(choice.kind).toBe("usage_exhausted");
    expect((choice.options as { key: string }[]).map((o) => o.key)).not.toContain("retry");
  });

  it("a job from an older server (no policy) asks, and without choices stops: never a silent switch", async () => {
    const h = harness({ fail: (req) => quota(req, "codex", "reviewer") });
    const outcome = await new TeamOrchestrator(baseJob(), h.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(outcome.reason).toBe("usage_exhausted");
    expect(h.calls.some((c) => c.provider === "claude-code" && c.role === "reviewer")).toBe(false);
  });

  it("sends each run's timings in run_finished", async () => {
    const h = harness();
    await new TeamOrchestrator(baseJob({ failoverPolicy: "auto" }), {
      ...h.deps,
      queueMs: 250,
    }).run(repo);
    const finished = h.ops.filter((o) => o.op === "run_finished").map((o) => o.payload);
    expect(finished.length).toBeGreaterThan(0);
    for (const f of finished) {
      expect(f.timings).toMatchObject({ queueMs: 250, spawnMs: 3, firstEventMs: 4, providerMs: 9 });
    }
  });
});

describe("planning-round policy (§3.5)", () => {
  const revise = (category?: Review["disagreementCategory"]): Review => ({
    verdict: "REVISE",
    summary: "Use a different module layout.",
    findings: [
      {
        severity: "important",
        category: "architecture",
        summary: "Prefer a module per route",
        detail: "d",
        file: null,
        line: null,
      },
    ],
    ownershipObjections: [],
    ...(category ? { disagreementCategory: category } : {}),
  });

  it("settles a technical disagreement after two exchanges: the coordinator's plan wins, objections stay findings", async () => {
    const h = harness({ planReview: () => revise("technical") });
    const outcome = await new TeamOrchestrator(
      baseJob({ mode: "team", builder: null, reviewer: null, failoverPolicy: "auto" }),
      h.deps,
    ).run(repo);
    expect(h.calls.filter((c) => c.role === "planner")).toHaveLength(2);
    expect(h.ops.some((o) => o.op === "request_choice")).toBe(false);
    const settled = h.ops.find(
      (o) => o.op === "add_decision" && o.payload.topic === "Disagreement settled",
    )!;
    expect(settled.payload.titleSource).toBe("threadlink");
    expect(String(settled.payload.resolution)).not.toMatch(/tl[a-z]{3}_/);
    expect(h.ops.find((o) => o.op === "set_plan")!.payload.approvedBy).toContain("claude-code");
    // The objections were recorded as findings and never resolved by fiat.
    expect(
      h.ops.filter((o) => o.op === "add_finding" && o.payload.phase === "planning"),
    ).toHaveLength(2);
    expect(["PASS", "NEEDS_FIX"]).toContain(outcome.verdict);
    expect(h.calls.some((c) => c.role === "builder")).toBe(true);
  });

  it("asks the owner only for an owner-level disagreement", async () => {
    const h = harness({ planReview: () => revise("security_policy") });
    const outcome = await new TeamOrchestrator(
      baseJob({
        mode: "team",
        builder: null,
        reviewer: null,
        budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 1 },
      }),
      h.deps,
    ).run(repo);
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    expect(h.ops.filter((o) => o.op === "request_choice").map((o) => o.payload.kind)).toEqual([
      "plan_disagreement",
    ]);
    expect(h.calls.some((c) => c.role === "builder")).toBe(false);
  });
});

describe("wire additions (§3.4.6, §3.6)", () => {
  it("run_started carries sessionReason; run_finished carries only valid timings", () => {
    const started = runStartedPayload({
      runKey: "k",
      provider: "codex",
      participantKey: "codex:investigator",
      role: "investigator",
      requestedModel: "gpt-5.5",
      effort: null,
      access: "read-only",
      nodeKey: null,
      worktreeLabel: null,
      timeoutMs: 1,
      continuity: "resumed",
      resumedFromRunKey: null,
      activity: null,
      sessionReason: "resumed",
    });
    expect(started.sessionReason).toBe("resumed");
    const finished = runFinishedPayload({
      runId: `tlarn_${"1".repeat(32)}`,
      status: "completed",
      observedModel: "gpt-5.5",
      modelVerified: true,
      accessVerified: true,
      nativeSessionId: null,
      nativeSessionKind: null,
      failure: null,
      exitClean: true,
      timings: { queueMs: 12.6, spawnMs: -1, providerMs: Number.NaN, persistMs: 3 },
    });
    expect(finished.timings).toEqual({ queueMs: 13, persistMs: 3 });
    expect(
      runFinishedPayload({
        runId: `tlarn_${"1".repeat(32)}`,
        status: "completed",
        observedModel: null,
        modelVerified: false,
        accessVerified: false,
        nativeSessionId: null,
        nativeSessionKind: null,
        failure: null,
        exitClean: true,
      }),
    ).not.toHaveProperty("timings");
  });
});

// ---------------------------------------------------------------------------
// An agent already out of usage when the job starts (lead's acceptance repro)
// ---------------------------------------------------------------------------

describe("an agent out of usage before the job starts (§5)", () => {
  const RESET = "2026-09-29T15:00:00.000Z";
  /** Health as the Runtime's probe left it; `confirm` is a fresh check. */
  const withHealth = (
    h: ReturnType<typeof harness>,
    state: Partial<Record<AgentProvider, string>>,
    confirm: () => string = () => "usage_exhausted",
  ) => {
    let checks = 0;
    const verified: string[][] = [];
    return {
      verified,
      checks: () => checks,
      deps: {
        ...h.deps,
        verify: async (_c: string, commands: string[]): Promise<VerifyResult[]> => {
          verified.push(commands);
          return commands.map((command) => ({ command, ok: true, exitCode: 0, output: "ok" }));
        },
        health: {
          ensure: async (ps: AgentProvider[]) =>
            Object.fromEntries(ps.map((p) => [p, state[p] ?? "ready"])) as never,
          confirm: async () => (checks++, confirm() as never),
          resetsAt: (p: AgentProvider) => (state[p] === "usage_exhausted" ? RESET : null),
        },
      },
    };
  };
  const runsOf = (h: ReturnType<typeof harness>, p: AgentProvider) =>
    h.calls.filter((c) => c.provider === p);
  const notices = (h: ReturnType<typeof harness>) =>
    h.ops.filter((o) => o.op === "failover_notice").map((o) => o.payload);

  it("1. pair, reviewer exhausted, auto: one notice, Claude builds, checks run, REVIEW_PENDING, no Codex run", async () => {
    const h = harness();
    const w = withHealth(h, { codex: "usage_exhausted" });
    const outcome = await new TeamOrchestrator(
      baseJob({ failoverPolicy: "auto", verifyCommands: ["npm test"] }),
      w.deps,
    ).run(repo);
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(runsOf(h, "codex")).toHaveLength(0);
    expect(runsOf(h, "claude-code").map((c) => c.role)).toEqual(["builder"]);
    expect(w.verified.length).toBeGreaterThan(0);
    expect(notices(h)).toEqual([
      { from: "codex", to: "claude-code", reviewPending: true, resetsAt: RESET },
    ]);
    const final = h.ops.find((o) => o.op === "set_final")!.payload;
    expect(final).toMatchObject({
      verdict: "REVIEW_PENDING",
      reason: "usage_exhausted",
      provider: "codex",
    });
    // Nothing claims a review that did not happen, or a choice the owner did not make.
    const plan = h.ops.find((o) => o.op === "set_plan")!.payload.plan as Plan;
    expect(plan.summary).not.toMatch(/reviewed by Codex/);
    expect(plan.summary).toMatch(/pending/);
    expect(JSON.stringify(plan.nodes[0])).not.toMatch(/owner asked/i);
    expect(String(final.summary)).not.toMatch(/reviewed it|approved by/i);
  });

  it("2. ask: the usage_exhausted choice (never retry); continue_other goes on as auto", async () => {
    const h = harness({
      choose: (kind) => (kind === "usage_exhausted" ? "continue_other" : null),
    });
    const w = withHealth(h, { codex: "usage_exhausted" });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "ask" }), w.deps).run(
      repo,
    );
    const choice = h.ops.find((o) => o.op === "request_choice")!.payload;
    expect(choice).toMatchObject({
      kind: "usage_exhausted",
      params: { provider: "codex", otherProvider: "claude-code", resetsAt: RESET },
    });
    expect((choice.options as { key: string }[]).map((o) => o.key)).toEqual([
      "continue_other",
      "check_again",
      "wait",
      "stop",
    ]);
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(runsOf(h, "codex")).toHaveLength(0);
    expect(notices(h)).toHaveLength(1);
  });

  it("2. ask: check_again re-asks while still exhausted; Codex reviews once a fresh check says ready", async () => {
    let answer = 0;
    const h = harness({ choose: () => "check_again" });
    const w = withHealth(h, { codex: "usage_exhausted" }, () =>
      ++answer >= 2 ? "ready" : "usage_exhausted",
    );
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "ask" }), w.deps).run(
      repo,
    );
    expect(w.checks()).toBe(2);
    expect(h.ops.filter((o) => o.op === "request_choice")).toHaveLength(2);
    expect(outcome.verdict).toBe("PASS");
    expect(runsOf(h, "codex").map((c) => c.role)).toEqual(["reviewer"]);
    expect(notices(h)).toHaveLength(0);
  });

  it("2. ask: stop ends the job before any agent runs", async () => {
    const h = harness({ choose: () => "stop" });
    const w = withHealth(h, { codex: "usage_exhausted" });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "ask" }), w.deps).run(
      repo,
    );
    expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "stopped_by_owner" });
    expect(h.calls).toHaveLength(0);
  });

  it("3. pair, builder exhausted, auto: the ready agent builds and its own work is not self-reviewed", async () => {
    const h = harness();
    const w = withHealth(h, { "claude-code": "usage_exhausted" });
    const outcome = await new TeamOrchestrator(baseJob({ failoverPolicy: "auto" }), w.deps).run(
      repo,
    );
    expect(runsOf(h, "claude-code")).toHaveLength(0);
    expect(runsOf(h, "codex").map((c) => c.role)).toEqual(["builder"]);
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(notices(h)).toEqual([
      { from: "claude-code", to: "codex", reviewPending: true, resetsAt: RESET },
    ]);
  });

  it("3. solo, the solo agent exhausted, auto: another ready agent builds; with none, BLOCKED as before", async () => {
    const h = harness();
    const w = withHealth(h, { "claude-code": "usage_exhausted" });
    const outcome = await new TeamOrchestrator(
      baseJob({
        mode: "solo",
        reviewer: null,
        failoverPolicy: "auto",
        verifyCommands: ["npm test"],
      }),
      w.deps,
    ).run(repo);
    expect(runsOf(h, "codex").map((c) => c.role)).toEqual(["builder"]);
    expect(runsOf(h, "claude-code")).toHaveLength(0);
    expect(notices(h)).toEqual([
      { from: "claude-code", to: "codex", reviewPending: false, resetsAt: RESET },
    ]);
    expect(outcome.verdict).toBe("PASS");

    const none = harness();
    const w2 = withHealth(none, { "claude-code": "usage_exhausted", codex: "needs_sign_in" });
    const blocked = await new TeamOrchestrator(
      baseJob({ mode: "solo", reviewer: null, failoverPolicy: "auto" }),
      w2.deps,
    ).run(repo);
    expect(blocked).toMatchObject({ verdict: "BLOCKED", reason: "usage_exhausted" });
    expect(none.calls).toHaveLength(0);
  });

  it("4. team with one participant exhausted, auto: the other does the work and its reviews are pending", async () => {
    const h = harness();
    const w = withHealth(h, { codex: "usage_exhausted" });
    const outcome = await new TeamOrchestrator(
      baseJob({ mode: "team", builder: null, reviewer: null, failoverPolicy: "auto" }),
      w.deps,
    ).run(repo);
    expect(runsOf(h, "codex")).toHaveLength(0);
    expect(runsOf(h, "claude-code").some((c) => c.role === "builder")).toBe(true);
    expect(outcome.verdict).toBe("REVIEW_PENDING");
    expect(notices(h)).toEqual([
      { from: "codex", to: "claude-code", reviewPending: true, resetsAt: RESET },
    ]);
  });

  it("keeps stopping for sign-in problems, and for a job from an older server (no policy)", async () => {
    const signIn = harness();
    const w = withHealth(signIn, { codex: "needs_sign_in" });
    expect(
      await new TeamOrchestrator(baseJob({ failoverPolicy: "auto" }), w.deps).run(repo),
    ).toMatchObject({ verdict: "BLOCKED", reason: "agent_needs_sign_in" });
    const old = harness();
    const w2 = withHealth(old, { codex: "usage_exhausted" });
    expect(await new TeamOrchestrator(baseJob(), w2.deps).run(repo)).toMatchObject({
      verdict: "BLOCKED",
      reason: "usage_exhausted",
    });
    expect(signIn.calls).toHaveLength(0);
    expect(old.calls).toHaveLength(0);
    expect(old.ops.some((o) => o.op === "failover_notice")).toBe(false);
  });
});
