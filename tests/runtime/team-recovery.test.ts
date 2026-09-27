import { describe, expect, it, vi } from "vitest";

import type { ProviderDiscovery } from "../../runtime/src/team/discovery.ts";
import { TeamExecutor } from "../../runtime/src/team/executor.ts";
import type { TeamOp } from "../../runtime/src/team/orchestrator.ts";
import { JournalStore, type RecoveryReport } from "../../runtime/src/team/registry.ts";
import { UsageGovernor } from "../../runtime/src/team/usage.ts";

/**
 * docs/design/threadlink-0.10.md §6: a job a previous Runtime left behind is
 * classified from its journal and acted on when its carrier task comes back:
 * a finished job is never run twice, a computed verdict is resent, a write
 * step that was running is never re-run without the owner, and a job with
 * nothing written continues.
 */

const JOB = `tljob_${"a".repeat(32)}`;
const hex = (n: number) => n.toString(16).padStart(32, "0");

const content = JSON.stringify({
  kind: "threadlink.team_job",
  version: 1,
  jobId: JOB,
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

const task = { taskId: "tltask_x", title: "t", content, priority: "C", taskType: "team" };

function setup(decide: string | null = null, legacy = false) {
  const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
  const journals = new JournalStore(null);
  const discover = vi.fn(async (): Promise<ProviderDiscovery[]> => []);
  const reports: RecoveryReport[] = [];
  const write = vi.fn(
    async (_j: string, _s: string, _c: string, op: TeamOp, payload: Record<string, unknown>) => {
      ops.push({ op, payload });
      if (op === "request_choice") {
        if (legacy) throw new Error("unknown op");
        return { choiceId: `tlchc_${hex(1)}` };
      }
      if (op === "read_choices") {
        return {
          choices: [
            {
              choiceId: `tlchc_${hex(1)}`,
              status: decide ? "chosen" : "pending",
              chosenKey: decide,
            },
          ],
        };
      }
      return {};
    },
  );
  const executor = new TeamExecutor({
    workspace: ".",
    sessionId: "tlses_x",
    claimRef: "r",
    write,
    governor: new UsageGovernor(),
    discover,
    runners: () => ({}),
    journals,
    activeJobs: new Set(),
    onRecovery: (r) => reports.push(r),
    choicePollMs: 1,
    choiceWaitMs: 200,
  });
  return {
    ops,
    journals,
    discover,
    executor,
    reports,
    run: () => executor.execute(task, new AbortController().signal),
  };
}

const FINAL = { verdict: "PASS", summary: "Built and reviewed.", evidence: { commits: [] } };

describe("recovering a team job on this computer", () => {
  it("completed: the verdict reached the server, so the job is answered, not run again", async () => {
    const s = setup();
    const j = s.journals.open(JOB);
    j.finalComputed(FINAL);
    j.finalSynced("Team result: PASS\nPrism — Build it.");
    const result = await s.run();
    expect(result).toMatchObject({ ok: true, result: "Team result: PASS\nPrism — Build it." });
    expect(s.ops).toEqual([]);
    expect(s.discover).not.toHaveBeenCalled();
    expect(s.reports[0]!.classification).toBe("completed");
  });

  it("completed_unsynced: the computed verdict is sent again, and no agent runs", async () => {
    const s = setup();
    s.journals.open(JOB).finalComputed(FINAL);
    const result = await s.run();
    expect(s.ops.map((o) => o.op)).toEqual(["set_final"]);
    expect(s.ops[0]!.payload).toEqual(FINAL);
    expect(s.discover).not.toHaveBeenCalled();
    expect((result as { result: string }).result).toMatch(/Team result: PASS/);
    expect(s.journals.read(JOB)).toMatchObject({ finalSynced: true });
  });

  it("interrupted: a build was running; the owner is asked, and stopping never re-runs it", async () => {
    const s = setup("stop");
    s.journals
      .open(JOB)
      .stepStarted({ runKey: "k", kind: "build", write: true, provider: "codex", startedAt: "" });
    const result = await s.run();
    expect(s.ops.map((o) => o.op)).toEqual([
      "set_status",
      "request_choice",
      "read_choices",
      "set_final",
    ]);
    expect(s.ops[0]!.payload).toMatchObject({ status: "interrupted" });
    expect(s.ops[1]!.payload).toMatchObject({
      kind: "interrupted",
      params: { step: "build", provider: "codex" },
      options: [{ key: "resume" }, { key: "stop" }],
    });
    expect(s.ops[3]!.payload).toMatchObject({
      verdict: "NEEDS_USER_DECISION",
      reason: "stopped_by_owner",
    });
    expect(s.discover).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("interrupted, on a server that takes no choices: the job ends, the step is not re-run", async () => {
    const s = setup(null, true);
    s.journals
      .open(JOB)
      .stepStarted({ runKey: "k", kind: "build", write: true, provider: "codex", startedAt: "" });
    await s.run();
    expect(s.ops.at(-1)).toMatchObject({
      op: "set_final",
      payload: { verdict: "NEEDS_USER_DECISION", reason: "unexpected_error" },
    });
    expect(s.discover).not.toHaveBeenCalled();
  });

  it("interrupted, and the owner resumes: the job runs again as a new attempt", async () => {
    const s = setup("resume");
    const j = s.journals.open(JOB);
    j.stepStarted({ runKey: "k", kind: "build", write: true, provider: "codex", startedAt: "" });
    j.stepFinished("k", false);
    await s.run();
    expect(s.discover).toHaveBeenCalledTimes(1);
    expect(s.journals.read(JOB)!.attempt).toBe(2);
  });

  it("resumable: nothing that writes had run, so the job continues without asking", async () => {
    const s = setup();
    const j = s.journals.open(JOB);
    j.phase("planning");
    j.stepStarted({
      runKey: "p",
      kind: "plan",
      write: false,
      provider: "claude-code",
      startedAt: "",
    });
    const result = await s.run();
    expect(s.reports[0]!.classification).toBe("resumable");
    expect(s.ops.some((o) => o.op === "request_choice")).toBe(false);
    expect(s.discover).toHaveBeenCalledTimes(1);
    expect(s.journals.read(JOB)!.attempt).toBe(2);
    expect((result as { result: string }).result).toMatch(/restarted this job/);
  });

  it("a journal of another Runtime process that is still running is not a crash: refused, not recovered", async () => {
    const s = setup();
    const j = s.journals.open(JOB);
    // The parent of this test process is alive: it stands in for another Runtime.
    j.state.runtimePid = process.ppid;
    j.stepStarted({ runKey: "k", kind: "build", write: true, provider: "codex", startedAt: "" });
    const result = await s.run();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/another ThreadLink Runtime/);
    expect(s.ops).toEqual([]);
    expect(s.discover).not.toHaveBeenCalled();
  });

  it("an unreadable journal fails closed: the owner decides, nothing re-runs", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tl-rec-bad-"));
    mkdirSync(join(dir, "team-jobs"));
    writeFileSync(join(dir, "team-jobs", `${JOB}.json`), "garbage");
    const ops: string[] = [];
    const discover = vi.fn(async (): Promise<ProviderDiscovery[]> => []);
    const executor = new TeamExecutor({
      workspace: ".",
      sessionId: "tlses_x",
      claimRef: "r",
      write: vi.fn(async (_j: string, _s: string, _c: string, op: TeamOp) => {
        ops.push(op);
        if (op === "request_choice") return { choiceId: `tlchc_${hex(1)}` };
        if (op === "read_choices")
          return {
            choices: [{ choiceId: `tlchc_${hex(1)}`, status: "chosen", chosenKey: "stop" }],
          };
        return {};
      }),
      governor: new UsageGovernor(),
      discover,
      journals: new JournalStore(dir),
      choicePollMs: 1,
    });
    await executor.execute(task, new AbortController().signal);
    expect(ops).toEqual(["set_status", "request_choice", "read_choices", "set_final"]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("never runs the same job twice at once on this computer", async () => {
    const s = setup();
    const active = new Set([JOB]);
    const executor = new TeamExecutor({
      workspace: ".",
      sessionId: "tlses_x",
      claimRef: "r",
      write: vi.fn(),
      governor: new UsageGovernor(),
      discover: s.discover,
      activeJobs: active,
    });
    const result = await executor.execute(task, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      error: "This team job is already running on this computer.",
    });
    expect(s.discover).not.toHaveBeenCalled();
  });
});
