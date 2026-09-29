import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseTeamJob, type TeamJobDefinition } from "../../runtime/src/team/job.ts";
import {
  refusedVerdictFallback,
  TeamOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type TeamOp,
  type VerifyResult,
} from "../../runtime/src/team/orchestrator.ts";
import { graphPort } from "../../runtime/src/team/ports.ts";
import type { Finding, Review } from "../../runtime/src/team/prompts.ts";
import { isReadOnlyRequest, readOnlyRule } from "../../runtime/src/team/read-only.ts";
import type { AgentProvider } from "../../runtime/src/team/types.ts";
import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * ThreadLink 0.11.1: "Do not change any files" makes a work job read-only.
 * Found in the Production acceptance run: a pair job asked to review without
 * changing anything went into fix rounds and changed 7 files.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

describe("the no-change detector (table)", () => {
  const READ_ONLY = [
    "Run the project's tests and review the authentication code for problems. Do not change any files.",
    "/work Run the project's tests and review the authentication code for problems. Do not change any files.",
    "Review the auth module but don't edit the code.",
    "Review the auth module but don’t edit the code.",
    "Please do not modify any files, just tell me what's wrong.",
    "Audit the repo without changing anything.",
    "Review the API without changing any files",
    "Read-only review of the payment flow please",
    "Keep it read-only and list the risks.",
    "Look at the migrations. No changes.",
    "Never touch the repository; explain the build.",
    "Don't make any changes, just review.",
    "Check the tests, make no changes",
    "Read-only: inspect the queue worker",
  ];
  const NOT_READ_ONLY = [
    "Fix the typo in the README. Do not change anything else.",
    "Refactor auth.ts; don't change any files outside src/auth.",
    "Make sure users do not modify any files in /etc.",
    "Do not change the public API while fixing the bug.",
    "Fix the bug where the settings page doesn't change the files.",
    "Add a read-only flag to the config file.",
    "Fix the read-only mode bug in the editor.",
    "Implement caching so there are no changes to the response format.",
    "Don't touch the code in auth.ts but fix the login page.",
    "Update the docs without changing the API",
    "Fix the failing login test.",
  ];
  it.each(READ_ONLY)("read-only: %s", (goal) => {
    expect(readOnlyRule(goal)).not.toBeNull();
  });
  it.each(NOT_READ_ONLY)("not read-only: %s", (goal) => {
    expect(isReadOnlyRequest(goal)).toBe(false);
  });

  it("marks only work jobs read-only", () => {
    const doc = (lane: string) =>
      parseTeamJob(
        JSON.stringify({
          kind: "threadlink.team_job",
          version: 1,
          jobId: `tljob_${"a".repeat(32)}`,
          roomId: `tlrom_${"b".repeat(32)}`,
          roomName: "Prism",
          goal: "Review the auth code. Do not change any files.",
          lane,
          failoverPolicy: "auto",
          agents: [{ provider: "codex", displayName: "Codex", roles: [] }],
          budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 1 },
          policy: {
            usagePolicy: "balanced",
            paidUsage: false,
            crossReview: true,
            finalInspection: true,
            worktreeIsolation: true,
          },
        }),
      );
    expect(doc("work").readOnly).toBe(true);
    expect(doc("chat").readOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A read-only job end to end (real git worktrees, scripted agents)
// ---------------------------------------------------------------------------

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-readonly-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "owner@example.com");
  git("config", "user.name", "Owner");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "auth.ts"), "export const check = () => true;\n");
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

const GOAL =
  "Run the project's tests and review the authentication code for problems. Do not change any files.";

const job = (over: Partial<TeamJobDefinition> = {}): TeamJobDefinition => ({
  jobId: `tljob_${"a".repeat(32)}`,
  roomId: `tlrom_${"b".repeat(32)}`,
  roomName: "Prism",
  goal: GOAL,
  spec: {},
  budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 1 },
  policy: {
    usagePolicy: "balanced",
    paidUsage: false,
    crossReview: true,
    finalInspection: true,
    worktreeIsolation: true,
    overrides: [],
  },
  agents: [
    { provider: "claude-code", displayName: "Claude Code", roles: [] },
    { provider: "codex", displayName: "Codex", roles: [] },
  ],
  verifyCommands: ["npm test"],
  mode: "pair",
  builder: "codex",
  reviewer: "claude-code",
  failoverPolicy: "auto",
  readOnly: true,
  ...over,
});

const finding = (severity: Finding["severity"], summary: string): Finding => ({
  severity,
  category: "security",
  summary,
  detail: "d",
  file: "auth.ts",
  line: 1,
});

function harness(script: {
  findings?: (provider: AgentProvider) => Finding[];
  write?: (req: AgentRunRequest) => void;
}) {
  const calls: { provider: AgentProvider; role: string; access: string }[] = [];
  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: provider === "codex",
    async run(req) {
      calls.push({ provider, role: req.role, access: req.access });
      script.write?.(req);
      const findings = script.findings?.(provider) ?? [];
      const structured: Review & { teamMessage: string } = {
        verdict: findings.length ? "REVISE" : "APPROVED",
        summary: "Reviewed.",
        findings,
        ownershipObjections: [],
        priorFindings: [],
        disagreementCategory: "none",
        teamMessage: `${provider} looked at the authentication code, read-only.`,
      };
      const result: AgentRunResult = {
        ok: true,
        text: "",
        structured,
        threadId: null,
        requestedModel: req.model,
        observedModel: req.model,
        modelVerified: true,
        observedEffort: null,
        accessVerified: true,
        permissionDenials: 0,
      };
      return result;
    },
  });
  const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
  const verified: string[][] = [];
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
    verify: async (_c: string, commands: string[]): Promise<VerifyResult[]> => {
      verified.push(commands);
      return commands.map((command) => ({ command, ok: true, exitCode: 0, output: "ok" }));
    },
    sink: async (op: TeamOp, payload: Record<string, unknown>) => {
      ops.push({ op, payload });
      if (op === "run_started") return { runId: `tlarn_${String(ops.length).padStart(32, "0")}` };
      if (op === "add_finding")
        return { findingId: `tlfnd_${String(ops.length).padStart(32, "0")}` };
      return {};
    },
    clock: { now: () => Date.now(), sleep: async () => undefined },
    choicePollMs: 1,
    controlPollMs: 0,
  };
  return { calls, ops, deps, verified };
}

// 0.11.2: a one-unit plan and node are recorded (a PASS needs them); nothing is built.
const NEVER = ["add_change", "open_round"] as const;

describe("a read-only work job (0.11.1)", () => {
  it("reports blocking findings for the owner to fix: no fix round, no code change, nothing integrated", async () => {
    const h = harness({
      findings: (p) =>
        p === "claude-code" ? [finding("blocking", "Session token never expires")] : [],
    });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
    expect(outcome.reason).toBe("review_not_passed");
    expect(outcome.summary).toMatch(/^Read-only review, as you asked: no files were changed\./);
    expect(outcome.summary).toContain("Session token never expires");
    // Every agent ran read-only; nobody built or fixed anything.
    expect(h.calls.every((c) => c.access === "read-only")).toBe(true);
    expect(h.calls.some((c) => c.role === "builder")).toBe(false);
    expect(h.calls.map((c) => `${c.provider}:${c.role}`)).toEqual([
      "codex:investigator",
      "claude-code:reviewer",
    ]);
    for (const op of NEVER) expect(h.ops.filter((o) => o.op === op)).toHaveLength(0);
    // Findings are recorded; ThreadLink ran the owner's checks itself.
    expect(h.ops.filter((o) => o.op === "add_finding")).toHaveLength(1);
    expect(h.verified).toEqual([["npm test"]]);
    // No branch was committed to, and the owner's checkout is untouched.
    for (const branch of git("branch", "--list", "threadlink/*").split(/s+/).filter(Boolean)) {
      expect(git("rev-list", `main..${branch}`)).toBe("");
    }
    expect(git("status", "--porcelain")).toBe("");
    expect(h.ops.find((o) => o.op === "set_final")!.payload.verdict).toBe("NEEDS_FIX");
  });

  it("passes when nothing blocking stands", async () => {
    const h = harness({ findings: () => [finding("non_blocking", "Naming")] });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.summary).toMatch(/Read-only review/);
    expect(h.ops.filter((o) => o.op === "add_change")).toHaveLength(0);
  });

  it("discards what an agent wrote anyway, and says so", async () => {
    const h = harness({
      write: (req) => {
        if (req.provider === "codex")
          writeFileSync(join(req.cwd, "auth.ts"), "export const x = 1;\n");
      },
    });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(outcome.evidence.uncertainty.join(" ")).toMatch(/discarded those changes/);
    expect(h.ops.filter((o) => o.op === "add_change")).toHaveLength(0);
    expect(readFileSync(join(repo, "auth.ts"), "utf8")).toBe("export const check = () => true;\n");
  });

  it("solo: one read-only pass, no reviewer", async () => {
    const h = harness({});
    const outcome = await new TeamOrchestrator(
      job({ mode: "solo", builder: "codex", reviewer: null }),
      h.deps,
    ).run(repo);
    expect(h.calls.map((c) => c.role)).toEqual(["investigator"]);
    expect(outcome.verdict).toBe("PASS");
  });

  it("team: one read-only pass and an independent read-only review, no plan or units", async () => {
    const h = harness({});
    const outcome = await new TeamOrchestrator(
      job({ mode: "team", builder: null, reviewer: null }),
      h.deps,
    ).run(repo);
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls.map((c) => c.provider)).size).toBe(2);
    expect(h.ops.filter((o) => o.op === "set_plan")).toHaveLength(1);
    expect(outcome.verdict).toBe("PASS");
  });

  it("an ordinary work job still builds (the detector decides, nothing else changes)", async () => {
    const h = harness({});
    await new TeamOrchestrator(job({ readOnly: false, goal: "Fix the login bug." }), h.deps).run(
      repo,
    );
    expect(h.calls.some((c) => c.role === "builder" && c.access === "workspace-write")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0.11.2: against a fake server that enforces the real set_final PASS rules
// (team_job_write set_final, migrations 0.10 + 0.11).
// ---------------------------------------------------------------------------

class Refused extends Error {
  readonly status = 409;
  readonly kind = "conflict";
  constructor(readonly reason: string | null) {
    super("ThreadLink request failed (409 conflict)");
  }
}

/** The server's set_final PASS checks, over the ops the Runtime sent. */
function strictSink(
  base: (op: TeamOp, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
  job: TeamJobDefinition,
  extra: { refuseAll?: string | null } = {},
) {
  const findings = new Map<string, { severity: string; status: string }>();
  const nodes = new Map<string, { status: string; reviewer: string | null }>();
  const runs = new Map<string, { provider: string; role: string; status: string }>();
  let planApproved = false;
  let seq = 0;
  const finals: Record<string, unknown>[] = [];
  const sink = async (op: TeamOp, payload: Record<string, unknown>) => {
    const answer = await base(op, payload);
    switch (op) {
      case "set_plan":
        planApproved = Array.isArray(payload.approvedBy) && payload.approvedBy.length > 0;
        break;
      case "upsert_nodes":
        for (const n of payload.nodes as { key: string; status: string; reviewer: string | null }[])
          nodes.set(n.key, { status: n.status, reviewer: n.reviewer });
        break;
      case "set_node_status":
        nodes.get(String(payload.key))!.status = String(payload.status);
        break;
      case "add_finding": {
        const id = `tlfnd_${String(++seq).padStart(32, "0")}`;
        findings.set(id, { severity: String(payload.severity), status: "open" });
        return { ...answer, findingId: id };
      }
      case "set_finding_status":
        findings.get(String(payload.findingId))!.status = String(payload.status);
        break;
      case "run_started":
        runs.set(String(answer.runId), {
          provider: String(payload.provider),
          role: String(payload.role),
          status: "running",
        });
        break;
      case "run_finished":
        runs.get(String(payload.runId))!.status = String(payload.status);
        break;
      case "set_final": {
        if (payload.verdict === "PASS") {
          if (extra.refuseAll !== undefined) throw new Refused(extra.refuseAll);
          if (job.mode === "solo" && job.verifyCommands.length === 0)
            throw new Refused("solo_unverified");
          const open = ["open", "accepted", "disputed", "fixed"];
          if (
            [...findings.values()].some(
              (f) => open.includes(f.status) && ["blocking", "important"].includes(f.severity),
            )
          )
            throw new Refused(null);
          if (
            !nodes.size ||
            [...nodes.values()].some(
              (n) => !["approved", "integrated", "skipped"].includes(n.status),
            )
          )
            throw new Refused(null);
          if (!planApproved) throw new Refused(null);
          for (const n of nodes.values()) {
            if (
              n.reviewer &&
              ![...runs.values()].some(
                (r) =>
                  r.provider === n.reviewer && r.status === "completed" && r.role === "reviewer",
              )
            )
              throw new Refused("review_missing");
          }
        }
        finals.push(payload);
        break;
      }
    }
    return answer;
  };
  return { sink, finals };
}

describe("a read-only job's verdict is one the server accepts (0.11.2)", () => {
  it("an important finding is a problem for the owner: NEEDS_FIX, accepted", async () => {
    const h = harness({
      findings: (p) =>
        p === "codex" ? [finding("important", "Passwords are logged on failure")] : [],
    });
    const strict = strictSink(h.deps.sink, job());
    const outcome = await new TeamOrchestrator(job(), { ...h.deps, sink: strict.sink }).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
    expect(outcome.reason).toBe("review_not_passed");
    expect(outcome.summary).toContain(
      "Read-only review, as you asked: no files were changed. 1 problem for you to fix: Passwords are logged on failure",
    );
    expect(strict.finals.map((f) => f.verdict)).toEqual(["NEEDS_FIX"]);
  });

  it("only minor findings and passing checks: PASS, and the server accepts it (plan, unit, review on record)", async () => {
    const h = harness({ findings: () => [finding("non_blocking", "Naming could be clearer")] });
    const strict = strictSink(h.deps.sink, job());
    const outcome = await new TeamOrchestrator(job(), { ...h.deps, sink: strict.sink }).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(strict.finals.map((f) => f.verdict)).toEqual(["PASS"]);
    expect(h.ops.filter((o) => o.op === "add_change")).toHaveLength(0);
    expect(h.calls.every((c) => c.access === "read-only")).toBe(true);
  });

  it("solo with no checks and nothing to fix: NEEDS_USER_DECISION (nothing verified it), which the server accepts", async () => {
    const solo = job({ mode: "solo", builder: "codex", reviewer: null, verifyCommands: [] });
    const h = harness({});
    const strict = strictSink(h.deps.sink, solo);
    const outcome = await new TeamOrchestrator(solo, { ...h.deps, sink: strict.sink }).run(repo);
    expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "no_review_or_tests" });
    expect(outcome.summary).toMatch(/Nothing independent verified this review/);
    expect(strict.finals.map((f) => f.verdict)).toEqual(["NEEDS_USER_DECISION"]);
  });

  it("a refused PASS falls back to the strongest accepted verdict, never 'unexpected error'", async () => {
    const h = harness({});
    const strict = strictSink(h.deps.sink, job(), { refuseAll: "review_missing" });
    const outcome = await new TeamOrchestrator(job(), { ...h.deps, sink: strict.sink }).run(repo);
    expect(outcome.verdict).toBe("NEEDS_FIX");
    expect(outcome.reason).toBe("review_not_passed");
    expect(outcome.summary).toMatch(/could not record this as a pass: the independent review/);
    expect(outcome.evidence.uncertainty.join(" ")).toMatch(/could not record this job as a pass/);
    expect(strict.finals.map((f) => f.verdict)).toEqual(["NEEDS_FIX"]);
    expect(JSON.stringify(outcome)).not.toMatch(/unexpected error/);
  });

  it("maps refusals to fixed verdicts and leaves other errors alone", () => {
    expect(refusedVerdictFallback(new Refused("solo_unverified"), "PASS")).toMatchObject({
      verdict: "NEEDS_USER_DECISION",
      reason: "no_review_or_tests",
    });
    expect(refusedVerdictFallback(new Refused(null), "REVIEW_PENDING")).toMatchObject({
      verdict: "NEEDS_FIX",
    });
    expect(refusedVerdictFallback(new Refused(null), "NEEDS_FIX")).toBeNull();
    expect(refusedVerdictFallback({ status: 500, kind: "unavailable" }, "PASS")).toBeNull();
  });
});
