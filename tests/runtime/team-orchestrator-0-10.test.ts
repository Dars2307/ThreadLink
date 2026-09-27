import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { teamWriteOpSchema } from "@/lib/team/model";

import type { RunActivity } from "../../runtime/src/team/activity.ts";
import type { TeamJobDefinition } from "../../runtime/src/team/job.ts";
import {
  TeamOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type OrchestratorDeps,
  type TeamOp,
  type VerifyResult,
} from "../../runtime/src/team/orchestrator.ts";
import { graphPort } from "../../runtime/src/team/ports.ts";
import type { Plan, Review } from "../../runtime/src/team/prompts.ts";
import { ProcessRegistry } from "../../runtime/src/team/registry.ts";
import type { AgentProvider, JobMode } from "../../runtime/src/team/types.ts";
import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * docs/design/threadlink-0.10.md, runtime side, end to end with real git
 * worktrees, scripted agents and a sink that behaves like the 0.10 server
 * (and validates every payload against its schema): runs and provenance,
 * the agents' own messages and replies, findings, choices, controls,
 * continuity and the process registry.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-010-"));
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
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold a directory briefly after a killed child */
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CHAT = `tlcht_${"c".repeat(32)}`;

const job = (over: Partial<TeamJobDefinition> = {}): TeamJobDefinition => ({
  jobId: `tljob_${"a".repeat(32)}`,
  roomId: `tlrom_${"b".repeat(32)}`,
  roomName: "Prism",
  goal: "Add a mul function.",
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
    { provider: "claude-code", displayName: "Claude", roles: ["planner", "builder", "integrator"] },
    { provider: "codex", displayName: "Codex", roles: ["builder", "reviewer"] },
  ],
  verifyCommands: ["npm test"],
  chatId: CHAT,
  ...over,
});

const pair = (builder: AgentProvider, over: Partial<TeamJobDefinition> = {}) =>
  job({ mode: "pair" as JobMode, builder, ...over });

const finding = (summary = "Off by one") => ({
  severity: "blocking" as const,
  category: "correctness" as const,
  summary,
  detail: "loop bound",
  file: "mul.js",
  line: 1,
});

const approve = (over: Partial<Review> = {}): Review => ({
  teamMessage: "Reviewed: it does what was asked.",
  verdict: "APPROVED",
  summary: "Looks right.",
  findings: [],
  priorFindings: [],
  ownershipObjections: [],
  ...over,
});

const revise = (): Review => ({
  teamMessage: "One blocking problem: the loop bound.",
  verdict: "REVISE",
  summary: "Fix it.",
  findings: [finding()],
  priorFindings: [],
  ownershipObjections: [],
});

const SPEC = {
  teamMessage: "I restated the request as a specification.",
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

const PLAN: Plan = {
  teamMessage: "Proposal: one unit, mul, built by Claude.",
  summary: "One unit.",
  nodes: [
    {
      key: "mul",
      title: "Mul function",
      scope: "Add mul",
      files: ["mul.js"],
      dependsOn: [],
      suggestedOwner: "claude-code",
      rationale: "small",
      complexity: "low",
      risk: { security: false, database: false, architecture: false, deployment: false },
    },
  ],
  risks: [],
};

type Call = {
  provider: AgentProvider;
  role: string;
  prompt: string;
  access: string;
  resumeThreadId?: string;
  timeoutMs?: number;
  events: boolean;
};

type Fail = Partial<AgentRunResult> | "hang" | null | undefined;

type Script = {
  codeReview?: (round: number) => Review;
  planReview?: (round: number) => Review;
  build?: (round: number) => Record<string, unknown>;
  inspection?: () => Record<string, unknown>;
  /** A forced failure for this call (n = the provider's call count). */
  fail?: (req: AgentRunRequest, n: number) => Fail;
  /** The owner's choice for a request_choice (null: leave it pending). */
  decide?: (kind: string, options: string[], n: number) => string | null;
  /** Extra answer fields per op (controls). */
  answer?: (
    op: TeamOp,
    payload: Record<string, unknown>,
    n: number,
  ) => Record<string, unknown> | null;
  /** Owner notes for read_owner_notes. */
  notes?: () => unknown[] | null;
  /** Legacy server: no 0.10 ops. */
  legacy?: boolean;
};

function harness(script: Script = {}) {
  const calls: Call[] = [];
  const ops: { op: TeamOp; payload: Record<string, unknown>; answer: Record<string, unknown> }[] =
    [];
  const rejected: { op: string; issues: string }[] = [];
  const counts: Record<string, number> = {};
  let builds = 0;
  let reviews = 0;
  let planReviews = 0;
  let seq = 0;
  let opCount = 0;
  const runsByKey = new Map<string, string>();
  const choices = new Map<string, { kind: string; options: string[]; polls: number; n: number }>();
  let choiceCount = 0;
  const children: ChildProcess[] = [];

  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: provider === "codex",
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      const n = (counts[provider] = (counts[provider] ?? 0) + 1);
      calls.push({
        provider,
        role: req.role,
        prompt: req.prompt,
        access: req.access,
        resumeThreadId: req.resumeThreadId,
        timeoutMs: req.timeoutMs,
        events: Boolean(req.onActivity),
      });
      const base: AgentRunResult = {
        ok: true,
        text: "",
        threadId:
          req.resumeThreadId ??
          `${provider === "codex" ? "0199" : "2222"}${String(calls.length).padStart(4, "0")}-0000-4000-8000-000000000000`,
        requestedModel: req.model,
        observedModel: req.model,
        observedEffort: null,
        accessVerified: true,
        // The runner's own model check passed (runner.ts modelVerified).
        modelVerified: true,
        permissionDenials: 0,
      };
      const forced = script.fail?.(req, n);
      if (forced === "hang") {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
          stdio: "ignore",
        });
        children.push(child);
        req.onProcess?.started(child);
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise((r) => setTimeout(r, 200));
        req.onProcess?.exited(child.pid!);
        return { ...base, ok: false, failure: "cancelled", error: "stopped" };
      }
      if (forced) return { ...base, ok: false, ...forced };
      // Codex streams events; the orchestrator gives Claude no activity hook.
      for (const a of ["reading", "building", "testing", "responding"] as RunActivity[]) {
        req.onActivity?.(a);
      }
      let structured: unknown;
      if (req.prompt.includes("precise engineering specification")) structured = SPEC;
      else if (req.role === "planner") structured = PLAN;
      else if (req.prompt.includes("Review the plan"))
        structured = (script.planReview ?? (() => approve()))(++planReviews);
      else if (req.role === "builder") {
        const round = ++builds;
        writeFileSync(
          join(req.cwd, "mul.js"),
          `export const mul = (a, b) => a * b; // v${round}\n`,
        );
        structured = {
          teamMessage: round === 1 ? "Built mul in mul.js." : "Fixed the loop bound.",
          summary: `Built v${round}`,
          filesChanged: ["mul.js"],
          testsRun: [],
          openQuestions: [],
          findingResponses: round === 1 ? [] : [{ ref: "F1", response: "fixed", note: "done" }],
          ...(script.build?.(round) ?? {}),
        };
      } else if (req.prompt.includes("Review the change")) {
        structured = (script.codeReview ?? (() => approve()))(++reviews);
      } else if (req.prompt.includes("final independent inspection")) {
        structured = script.inspection?.() ?? {
          teamMessage: "Final check: meets the specification.",
          verdict: "PASS",
          summary: "ok",
          findings: [],
          requirementsMet: [],
          uncertainty: [],
        };
      }
      return { ...base, structured };
    },
  });

  const sink = async (op: TeamOp, payload: Record<string, unknown>) => {
    const n = ++opCount;
    const parsed = teamWriteOpSchema.safeParse({ op, payload });
    if (!parsed.success) rejected.push({ op, issues: JSON.stringify(parsed.error.issues) });
    let answer: Record<string, unknown> = {};
    const legacyOnly =
      script.legacy &&
      ![
        "set_status",
        "set_spec",
        "set_plan",
        "upsert_nodes",
        "set_node_status",
        "add_message",
        "add_finding",
        "set_finding_status",
        "add_decision",
        "open_round",
        "record_usage",
        "set_final",
        "read_owner_notes",
      ].includes(op);
    if (legacyOnly) throw new Error(`unknown op ${op}`);
    switch (op) {
      case "run_started": {
        const key = String(payload.runKey);
        if (!runsByKey.has(key)) runsByKey.set(key, `tlarn_${hex(++seq)}`);
        answer = { runId: runsByKey.get(key), created: true };
        break;
      }
      case "add_message":
        answer = script.legacy
          ? {}
          : { messageId: `tlamg_${hex(++seq)}`, eventId: `tlcev_${hex(++seq)}` };
        break;
      case "add_finding":
        answer = { findingId: `tlfnd_${hex(++seq)}` };
        break;
      case "request_choice": {
        const id = `tlchc_${hex(++seq)}`;
        const options = (payload.options as { key: string }[]).map((o) => o.key);
        choices.set(id, { kind: String(payload.kind), options, polls: 0, n: ++choiceCount });
        answer = { choiceId: id };
        break;
      }
      case "read_choices": {
        const ids = (payload.choiceIds as string[]) ?? [];
        answer = {
          choices: ids.flatMap((id) => {
            const c = choices.get(id);
            if (!c) return [];
            c.polls++;
            const chosen = script.decide?.(c.kind, c.options, c.n) ?? null;
            return [
              {
                choiceId: id,
                kind: c.kind,
                status: chosen === "__expired" ? "expired" : chosen ? "chosen" : "pending",
                chosenKey: chosen && chosen !== "__expired" ? chosen : null,
              },
            ];
          }),
        };
        break;
      }
      case "read_owner_notes":
        if (!payload.consumedByRunId && script.notes) {
          const notes = script.notes();
          if (notes) answer = { ownerNotes: notes };
        }
        break;
      default:
        break;
    }
    const extra = script.answer?.(op, payload, n) ?? {};
    answer = { ...answer, ...extra };
    ops.push({ op, payload, answer });
    return answer;
  };

  const verified: string[][] = [];
  const deps: OrchestratorDeps = {
    runners: { "claude-code": runner("claude-code"), codex: runner("codex") },
    route: (req) => ({
      ok: true as const,
      model: req.provider === "codex" ? "gpt-6-sol" : "claude-sonnet-5",
      effort: "medium",
      modelClass: "BALANCED" as const,
      reason: "test",
    }),
    graph: graphPort(),
    worktrees: new WorktreeManager(),
    verify: async (_cwd: string, commands: string[]): Promise<VerifyResult[]> => {
      verified.push(commands);
      return commands.map((command) => ({ command, ok: true, exitCode: 0, output: "" }));
    },
    sink,
    choicePollMs: 5,
    controlPollMs: 20,
    clock: {
      now: () => Date.now(),
      sleep: (ms, signal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        }),
    },
  };
  const of = (op: TeamOp) => ops.filter((o) => o.op === op);
  return {
    calls,
    ops,
    deps,
    rejected,
    children,
    of,
    runs: () =>
      of("run_started").map((o) => ({ ...o.payload, runId: o.answer.runId as string })) as (Record<
        string,
        unknown
      > & { runId: string })[],
    finished: (runId: string) => of("run_finished").find((o) => o.payload.runId === runId)?.payload,
  };
}

// ---------------------------------------------------------------------------
// Runs, messages, replies, findings, changes (§2-§4)
// ---------------------------------------------------------------------------

describe("a Builder + Reviewer job with one fix round", () => {
  it("records every run, posts each agent's own teamMessage tied to its run, and wires the replies", async () => {
    const h = harness({
      codeReview: (r) =>
        r === 1 ? revise() : approve({ priorFindings: [{ ref: "F1", status: "resolved" }] }),
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    // Every payload is one the 0.10 server accepts.
    expect(h.rejected).toEqual([]);

    const runs = h.runs();
    expect(runs.map((r) => `${r.participantKey}/${r.continuity}`)).toEqual([
      "claude-code:builder/fresh",
      "codex:reviewer/fresh",
      "claude-code:builder/resumed",
      "codex:reviewer/fresh",
    ]);
    // run_started carries the phase activity; access and timeout per step.
    expect(runs[0]).toMatchObject({
      activity: "building",
      access: "workspace-write",
      timeoutMs: 30 * 60_000,
      nodeKey: "work",
    });
    expect(runs[1]).toMatchObject({ activity: "reviewing", access: "read-only" });

    // The agents' own words, not ThreadLink's, and each tied to the run that wrote it.
    const messages = h.of("add_message");
    expect(messages.map((m) => m.payload.body)).toEqual([
      "Built mul in mul.js.",
      "One blocking problem: the loop bound.",
      "Fixed the loop bound.",
      "Reviewed: it does what was asked.",
    ]);
    messages.forEach((m, i) => {
      expect(m.payload.runId).toBe(runs[i]!.runId);
      expect(m.payload.sender).toBe(runs[i]!.provider);
    });
    expect(messages.map((m) => m.payload.type)).toEqual([
      "completion",
      "review",
      "response",
      "review",
    ]);

    // Replies: review → build; fix → the finding; re-review → the fix.
    const findingId = h.of("add_finding")[0]!.answer.findingId;
    expect(messages[0]!.payload.replyTo).toBeUndefined();
    expect(messages[1]!.payload.replyTo).toEqual({
      kind: "message",
      id: messages[0]!.answer.messageId,
    });
    expect(messages[2]!.payload.replyTo).toEqual({ kind: "finding", id: findingId });
    expect(messages[3]!.payload.replyTo).toEqual({
      kind: "message",
      id: messages[2]!.answer.messageId,
    });

    // Finding lifecycle: raised by the reviewer's run, fixed by the builder's, resolved by the re-review.
    expect(h.of("add_finding")[0]!.payload).toMatchObject({
      runId: runs[1]!.runId,
      ownerParticipant: "claude-code:builder",
    });
    expect(h.of("set_finding_status").map((o) => [o.payload.status, o.payload.runId])).toEqual([
      ["fixed", runs[2]!.runId],
      ["resolved", runs[3]!.runId],
    ]);

    // Provenance: native sessions, verification as far as it goes.
    const claudeBuild = h.finished(runs[0]!.runId)!;
    expect(claudeBuild).toMatchObject({
      status: "completed",
      nativeSessionKind: "claude_session",
      modelVerified: true,
      // Claude does not report its sandbox, and a write run cannot be checked by ThreadLink.
      accessVerified: false,
      exitClean: true,
    });
    expect(claudeBuild.nativeSessionId).toBe(
      h.calls[0]!.resumeThreadId ?? claudeBuild.nativeSessionId,
    );
    expect(h.finished(runs[1]!.runId)).toMatchObject({
      nativeSessionKind: "codex_thread",
      accessVerified: true,
      modelVerified: true,
    });

    // Continuity: the fix round resumed the builder's own session; reviews were fresh.
    const builds = h.calls.filter((c) => c.role === "builder");
    expect(builds[0]!.resumeThreadId).toBeUndefined();
    expect(builds[1]!.resumeThreadId).toBe(claudeBuild.nativeSessionId);
    expect(runs[2]!.resumedFromRunKey).toBe(runs[0]!.runKey);
    expect(h.calls.filter((c) => c.role === "reviewer").every((c) => !c.resumeThreadId)).toBe(true);

    // Code change cards: real diffstat from git, tied to the builder's run, with the diff.
    const changes = h.of("add_change").map((o) => o.payload);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      nodeKey: "work",
      runId: runs[0]!.runId,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      files: ["mul.js"],
      tests: [],
    });
    expect(String(changes[0]!.commit)).toMatch(/^[0-9a-f]{40}$/);
    expect(String(changes[0]!.diff)).toContain("mul.js");
    expect(changes[1]).toMatchObject({ runId: runs[2]!.runId, insertions: 1 });

    // Decisions carry ThreadLink's fixed title source. A one-unit job posts
    // only who takes which role: no plan or "work split" noise.
    expect(h.of("add_decision").every((d) => d.payload.titleSource === "threadlink")).toBe(true);
    expect(h.of("add_decision").map((d) => d.payload.topic)).toEqual(["Roles chosen"]);

    // The final report, from job data, before the verdict.
    const names = h.ops.map((o) => o.op);
    expect(names.indexOf("add_artifact")).toBeLessThan(names.indexOf("set_final"));
    const report = h.of("add_artifact")[0]!.payload;
    expect(report).toMatchObject({ kind: "report", mime: "text/markdown", title: "Final report" });
    expect(String(report.content)).toContain("**Verdict:** PASS");
    expect(String(report.content)).toMatch(/\| blocking \| .*1/);
  });

  it("posts nothing for a run that gave no message of its own, and never invents one", async () => {
    const silent = approve();
    delete (silent as Partial<Review>).teamMessage;
    (silent as { summary: string }).summary = "";
    const h = harness({ codeReview: () => silent });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    const senders = h.of("add_message").map((m) => m.payload.sender);
    expect(senders).toEqual(["claude-code"]);
  });

  it("rate-limits activity to real Codex events and gives Claude no activity hook", async () => {
    const h = harness();
    await new TeamOrchestrator(pair("codex"), h.deps).run(repo);
    const codexBuild = h.calls.find((c) => c.provider === "codex")!;
    const claudeReview = h.calls.find((c) => c.provider === "claude-code")!;
    expect(codexBuild.events).toBe(true);
    expect(claudeReview.events).toBe(false);
    // Four events inside five seconds of run_started: nothing sent yet (the
    // start already reported the phase). Only real signals, never a timer.
    const activity = h.of("run_activity");
    expect(activity.length).toBeLessThanOrEqual(1);
    for (const a of activity)
      expect(["reading", "building", "testing", "responding"]).toContain(a.payload.activity);
  });

  it("tells the server which run consumed each owner note", async () => {
    const note = `tlcev_${hex(99)}`;
    let sent = false;
    const h = harness({
      notes: () => {
        if (sent) return null;
        sent = true;
        return [{ id: note, seq: 1, audience: "codex", body: "Check negatives.", createdAt: "x" }];
      },
    });
    await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    const reviewRun = h.runs().find((r) => r.provider === "codex")!;
    const consumed = h.of("read_owner_notes").filter((o) => o.payload.consumedByRunId);
    expect(consumed.map((o) => o.payload)).toEqual([
      { consumedByRunId: reviewRun.runId, noteIds: [note] },
    ]);
    expect(h.calls.find((c) => c.provider === "codex")!.prompt).toContain("Check negatives.");
  });
});

// ---------------------------------------------------------------------------
// Findings: disputes
// ---------------------------------------------------------------------------

describe("finding lifecycle", () => {
  it("a disputed finding that the reviewer keeps open blocks the unit; one it dismisses does not", async () => {
    const h = harness({
      build: (r) =>
        r === 1
          ? {}
          : { findingResponses: [{ ref: "F1", response: "disputed", note: "intended" }] },
      codeReview: (r) =>
        r === 1 ? revise() : approve({ priorFindings: [{ ref: "F1", status: "dismissed" }] }),
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    expect(h.of("set_finding_status").map((o) => o.payload.status)).toEqual([
      "disputed",
      "dismissed",
    ]);
    // A serious finding is only dismissed with a recorded decision, first
    // (the server refuses otherwise -- seen for real in the 0.10 acceptance run).
    const opsInOrder = h.ops.map((o) => `${o.op}:${o.payload.topic ?? o.payload.status ?? ""}`);
    const decided = opsInOrder.indexOf("add_decision:Finding dismissed");
    expect(decided).toBeGreaterThan(-1);
    expect(decided).toBeLessThan(opsInOrder.indexOf("set_finding_status:dismissed"));

    const h2 = harness({
      build: (r) =>
        r === 1 ? {} : { findingResponses: [{ ref: "F1", response: "fixed", note: "done" }] },
      // The reviewer approves but says F1 still stands: not an approval.
      codeReview: (r) =>
        r === 1 ? revise() : approve({ priorFindings: [{ ref: "F1", status: "open" }] }),
    });
    const blocked = await new TeamOrchestrator(
      pair("claude-code", {
        jobId: `tljob_${"d".repeat(32)}`,
        budgets: { maxPlanningRounds: 1, maxReviewRounds: 1, parallelAgents: 1 },
      }),
      h2.deps,
    ).run(repo);
    expect(blocked.verdict).toBe("NEEDS_FIX");
    expect(h2.of("set_finding_status").map((o) => o.payload.status)).toEqual(["fixed", "open"]);
  });
});

// ---------------------------------------------------------------------------
// Failures become the owner's choice (§4, §6)
// ---------------------------------------------------------------------------

describe("provider failure and timeout choices", () => {
  it("provider failure → choice → the owner retries the same agent", async () => {
    const h = harness({
      fail: (req, n) =>
        req.role === "builder" && n === 1
          ? { failure: "provider_error", error: "stream disconnected" }
          : null,
      decide: () => "retry",
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    const choice = h.of("request_choice")[0]!.payload;
    expect(choice).toMatchObject({
      kind: "provider_failure",
      params: { provider: "claude-code", step: "build" },
    });
    // A one-unit job's choice never names its internal unit ("work").
    expect(choice.params).not.toHaveProperty("unit", "work");
    expect((choice.params as Record<string, unknown>).unit ?? null).toBeNull();
    // Nobody else may build a unit its reviewer reviews: no "use other" here.
    expect((choice.options as { key: string }[]).map((o) => o.key)).toEqual(["retry", "stop"]);
    const failedRun = h.runs()[0]!;
    expect(choice.runId).toBe(failedRun.runId);
    expect(h.finished(failedRun.runId)).toMatchObject({
      status: "failed",
      failure: "provider_error",
    });
    expect(h.calls.filter((c) => c.role === "builder").map((c) => c.provider)).toEqual([
      "claude-code",
      "claude-code",
    ]);
    expect(h.rejected).toEqual([]);
  });

  it("provider failure → the owner stops: the job ends, nobody is substituted", async () => {
    const h = harness({
      fail: (req) =>
        req.role === "builder" ? { failure: "quota_exhausted", error: "limit" } : null,
      decide: () => "stop",
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "stopped_by_owner" });
    expect(h.calls.map((c) => c.provider)).toEqual(["claude-code"]);
  });

  it("timeout → choice → increase the timeout, within the bounds", async () => {
    const h = harness({
      fail: (req, n) =>
        req.role === "reviewer" && n === 1 ? { failure: "timeout", error: "slow" } : null,
      decide: (kind, options) =>
        kind === "timeout" && options.includes("increase_timeout") ? "increase_timeout" : "stop",
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    const reviews = h.calls.filter((c) => c.role === "reviewer");
    expect(reviews.map((c) => c.timeoutMs)).toEqual([30 * 60_000, 60 * 60_000]);
    const choice = h.of("request_choice")[0]!.payload;
    expect(choice).toMatchObject({
      kind: "timeout",
      params: { provider: "codex", step: "review", minutes: 30 },
    });
    expect(h.finished(h.runs()[1]!.runId)).toMatchObject({
      status: "timed_out",
      failure: "timeout",
    });
  });

  it("timeout → retry with the other agent, when one may take the step", async () => {
    let normalisations = 0;
    const h = harness({
      fail: (req) =>
        req.role === "coordinator" && ++normalisations === 1
          ? { failure: "timeout", error: "slow" }
          : null,
      decide: (_k, options) => (options.includes("retry_other") ? "retry_other" : "stop"),
    });
    const outcome = await new TeamOrchestrator(job(), h.deps).run(repo);
    const normalise = h.calls.filter((c) => c.prompt.includes("precise engineering specification"));
    expect(normalise.map((c) => c.provider)).toHaveLength(2);
    expect(normalise[0]!.provider).not.toBe(normalise[1]!.provider);
    expect(outcome.verdict).toBe("PASS");
    // The plan review replies to the plan proposal.
    const msgs = h.of("add_message");
    const proposal = msgs.find(
      (m) => m.payload.type === "proposal" && m.payload.senderRole === "planner",
    )!;
    const planReview = msgs.find(
      (m) => m.payload.type === "review" && m.payload.round === 1 && !m.payload.node,
    )!;
    expect(planReview.payload.replyTo).toEqual({ kind: "message", id: proposal.answer.messageId });
    expect(h.rejected).toEqual([]);
  });

  it("no decision within the wait: NEEDS_FIX, never a guess", async () => {
    const h = harness({
      fail: (req) => (req.role === "builder" ? { failure: "timeout", error: "slow" } : null),
      decide: () => null,
    });
    h.deps.choiceWaitMs = 60;
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "NEEDS_FIX", reason: "agent_timed_out" });
  });

  it("a model mismatch is never a choice: it stops", async () => {
    const h = harness({
      fail: (req) =>
        req.role === "builder" ? { failure: "model_mismatch", observedModel: "other" } : null,
      decide: () => "retry",
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "BLOCKED", reason: "model_mismatch" });
    expect(h.of("request_choice")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Controls (§5)
// ---------------------------------------------------------------------------

describe("the owner's controls", () => {
  const onRunFinished = (
    control: string,
    which: (p: Record<string, unknown>, n: number) => boolean,
  ) => {
    let n = 0;
    let on = false;
    return (op: TeamOp, payload: Record<string, unknown>) => {
      if (op === "run_finished" && which(payload, ++n)) on = true;
      return on ? { control, controlRequestedAt: "2026-09-26T10:00:00Z" } : null;
    };
  };

  it("stop_after_review: the review finishes and is recorded, then nothing new starts", async () => {
    const h = harness({
      codeReview: () => revise(),
      answer: onRunFinished("stop_after_review", (_p, n) => n === 1),
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "stopped_by_owner" });
    expect(outcome.summary).toBe("Stopped by you after the review.");
    expect(h.calls.map((c) => c.role)).toEqual(["builder", "reviewer"]);
    expect(h.of("add_finding")).toHaveLength(1);
    expect(h.of("ack_control" as TeamOp).map((o) => o.payload.control)).toContain(
      "stop_after_review",
    );
  });

  it("stop_before_integration: units finish, integration never starts", async () => {
    const h = harness({ answer: () => ({ control: "stop_before_integration" }) });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "stopped_by_owner" });
    expect(h.of("set_status").map((o) => o.payload.status)).not.toContain("integrating");
    expect(h.calls.map((c) => c.role)).toEqual(["builder", "reviewer"]);
  });

  it("pause_after_step waits after the step, and resume continues", async () => {
    let paused = false;
    let polls = 0;
    const h = harness({
      answer: (op) => {
        if (op === "run_finished" && !paused) {
          paused = true;
          return { control: "pause_after_step", controlRequestedAt: "t1" };
        }
        if (paused && op === "read_choices" && ++polls >= 3)
          return { control: "resume", controlRequestedAt: "t2" };
        return null;
      },
    });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.verdict).toBe("PASS");
    const statuses = h.of("set_status").map((o) => o.payload.status);
    expect(statuses).toContain("paused");
    expect(statuses[statuses.indexOf("paused") + 1]).toBe("building");
    expect(h.of("ack_control" as TeamOp).map((o) => o.payload.control)).toEqual([
      "pause_after_step",
      "resume",
    ]);
  });

  it("stop_now kills only the processes ThreadLink started for this job", async () => {
    const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      let seenRun = false;
      const h = harness({
        fail: (req) => (req.role === "builder" ? "hang" : null),
        answer: (op) => {
          if (op === "run_started") seenRun = true;
          return seenRun && op === "read_choices"
            ? { control: "stop_now", controlRequestedAt: "t" }
            : null;
        },
      });
      const registry = new ProcessRegistry(null);
      h.deps.processes = registry;
      const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
      expect(outcome).toMatchObject({ verdict: "NEEDS_USER_DECISION", reason: "stopped_by_owner" });
      const child = h.children[0]!;
      await new Promise<void>((r) =>
        child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", () => r()),
      );
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
      expect(registry.list()).toEqual([]);
      expect(h.finished(h.runs()[0]!.runId)).toMatchObject({
        status: "cancelled",
        failure: "cancelled",
      });
    } finally {
      stranger.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// Continuity and restarts
// ---------------------------------------------------------------------------

describe("what a change card may carry", () => {
  it("leaves secret-bearing files out of the shared diff, naming them only", async () => {
    const h = harness({
      build: () => ({}),
    });
    const runner = h.deps.runners["claude-code"]!;
    h.deps.runners["claude-code"] = {
      ...runner,
      provider: "claude-code",
      run: async (req) => {
        if (req.role === "builder") {
          writeFileSync(join(req.cwd, ".env"), "API_TOKEN=supersecretvalue123\n");
        }
        return runner.run(req);
      },
    };
    await new TeamOrchestrator(pair("claude-code", { spec: {} }), h.deps).run(repo);
    const change = h.of("add_change")[0]!.payload;
    expect(String(change.diff)).toMatch(/^1 file not shown: \.env\n/);
    expect(String(change.diff)).not.toContain("supersecretvalue123");
    expect(String(change.diff)).toContain("mul.js");
  });
});

describe("native session continuity", () => {
  it("is never carried into another chat's job", async () => {
    const first = harness();
    await new TeamOrchestrator(pair("claude-code"), first.deps).run(repo);
    const second = harness();
    await new TeamOrchestrator(
      pair("claude-code", { jobId: `tljob_${"d".repeat(32)}`, chatId: `tlcht_${"e".repeat(32)}` }),
      second.deps,
    ).run(repo);
    expect(second.calls.every((c) => c.resumeThreadId === undefined)).toBe(true);
    expect(second.runs().every((r) => r.continuity === "fresh")).toBe(true);
  });

  it("a restarted job uses new branches and new run keys", async () => {
    const h = harness();
    h.deps.attempt = 2;
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    expect(outcome.evidence.integrationBranch).toMatch(/aaaaaaaaaaaa-r2\/integration$/);
    expect(h.runs().every((r) => String(r.runKey).startsWith("aaaaaaaaaaaa-r2:"))).toBe(true);
  });
});

describe("a re-claimed job the server holds as interrupted", () => {
  it("a refused write run is handed back as an interruption, never a verdict", async () => {
    const h = harness({
      answer: (op, payload) => {
        if (op === "run_started" && payload.access === "workspace-write") {
          throw Object.assign(new Error("interrupted"), { status: 409, kind: "job_interrupted" });
        }
        return null;
      },
    });
    const { InterruptedRefusal } = await import("../../runtime/src/team/orchestrator.ts");
    await expect(
      new TeamOrchestrator(pair("claude-code"), h.deps).run(repo),
    ).rejects.toBeInstanceOf(InterruptedRefusal);
    expect(h.calls).toEqual([]);
    expect(h.of("set_final")).toEqual([]);
  });
});

describe("a legacy server", () => {
  it("without 0.10 ops: the job still runs, messages carry no run, and failures stop as before", async () => {
    const h = harness({ legacy: true });
    const outcome = await new TeamOrchestrator(pair("claude-code"), h.deps).run(repo);
    // Refusing run_started is the server refusing the job: it stops, fail closed.
    expect(outcome.verdict).toBe("BLOCKED");
    expect(h.calls).toEqual([]);
  });
});
