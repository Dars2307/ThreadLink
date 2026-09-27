import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ActivityReporter,
  codexEventActivity,
  phaseActivity,
  RUN_ACTIVITIES,
  STEP_KINDS,
  type ActivityClock,
  type RunActivity,
} from "../../runtime/src/team/activity.ts";
import {
  capabilitiesOf,
  capabilitiesReport,
  capabilityFlags,
  PROVIDER_CAPABILITIES,
} from "../../runtime/src/team/capabilities.ts";
import { parseTeamJob, TeamJobError } from "../../runtime/src/team/job.ts";
import {
  BUILD_SCHEMA,
  INSPECTION_SCHEMA,
  buildPrompt,
  planPrompt,
  planSchema,
  REVIEW_SCHEMA,
  reviewSchema,
  SPEC_SCHEMA,
  teamMessageOf,
} from "../../runtime/src/team/prompts.ts";
import {
  classifyRecovery,
  JournalStore,
  ProcessRegistry,
  type JobJournalState,
} from "../../runtime/src/team/registry.ts";
import { finalReportMarkdown } from "../../runtime/src/team/report.ts";
import {
  increasedTimeoutMs,
  parseTimeoutOverrides,
  STEP_TIMEOUT_DEFAULTS_MIN,
  stepTimeoutMs,
} from "../../runtime/src/team/timeouts.ts";
import {
  artifactPayload,
  ARTIFACT_MAX_BYTES,
  CHOICE_KIND_OPTIONS,
  parseChoiceId,
  parseChoices,
  parseControl,
  parseMessageId,
  parseRunId,
  requestChoicePayload,
  runFinishedPayload,
  RUNTIME_PROTOCOL,
} from "../../runtime/src/team/wire.ts";
import { CHOICE_KINDS, JOB_CONTROLS, RUN_ACTIVITIES as SHARED_ACTIVITIES } from "@/lib/chat/types";

const JOB = `tljob_${"a".repeat(32)}`;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const RUN = (n: number) => `tlarn_${hex(n)}`;
const CHC = (n: number) => `tlchc_${hex(n)}`;

// ---------------------------------------------------------------------------
// Shared vocabulary stays in step with lib/chat/types.ts
// ---------------------------------------------------------------------------

describe("0.10 vocabulary", () => {
  it("matches the shared types", () => {
    expect([...RUN_ACTIVITIES]).toEqual([...SHARED_ACTIVITIES]);
    for (const kind of Object.keys(CHOICE_KIND_OPTIONS)) {
      expect(CHOICE_KINDS as readonly string[]).toContain(kind);
    }
    const controls = parseControl({ control: "stop_now" });
    expect(controls?.control).toBe("stop_now");
    for (const c of JOB_CONTROLS) expect(parseControl({ control: c })?.control).toBe(c);
  });

  it("speaks protocol 10", () => {
    expect(RUNTIME_PROTOCOL).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

describe("wire.ts (0.10)", () => {
  it("reads ids strictly and fails closed", () => {
    expect(parseRunId({ runId: RUN(1) })).toBe(RUN(1));
    expect(parseRunId({ runId: "tlarn_; drop" })).toBeNull();
    expect(parseRunId({ runId: "tlarn_abc" })).toBeNull();
    expect(parseRunId({})).toBeNull();
    expect(parseRunId(null)).toBeNull();
    expect(parseMessageId({ messageId: "tlcev_1" })).toBe("tlcev_1");
    expect(parseMessageId({ eventId: "tlcev_2" })).toBe("tlcev_2");
    expect(parseMessageId({ messageId: "x y" })).toBeNull();
    expect(parseChoiceId({ choiceId: CHC(1) })).toBe(CHC(1));
    expect(parseChoiceId({ choiceId: "nope" })).toBeNull();
  });

  it("parses decided choices and drops malformed entries", () => {
    expect(
      parseChoices({
        choices: [
          { choiceId: CHC(1), status: "chosen", chosenKey: "retry" },
          { choiceId: CHC(2), status: "pending", chosenKey: null },
          { choiceId: CHC(3), status: "weird" },
          { choiceId: "bad", status: "chosen", chosenKey: "retry" },
          { choiceId: CHC(4), status: "chosen", chosenKey: "DROP TABLE" },
        ],
      }),
    ).toEqual([
      { id: CHC(1), status: "chosen", chosenKey: "retry" },
      { id: CHC(2), status: "pending", chosenKey: null },
      { id: CHC(4), status: "chosen", chosenKey: null },
    ]);
  });

  it("reads the owner's control, and the 0.9 stop flag as cancel_queued", () => {
    expect(parseControl({ control: "pause_after_step", controlRequestedAt: "t" })).toEqual({
      control: "pause_after_step",
      requestedAt: "t",
    });
    expect(parseControl({ control: "explode" })).toBeNull();
    expect(parseControl({ stopRequestedAt: "2026-09-25T10:00:00Z" })?.control).toBe(
      "cancel_queued",
    );
    expect(parseControl({ stopRequestedAt: true })).toBeNull();
  });

  it("offers only allow-listed choice options", () => {
    const p = requestChoicePayload("timeout", { provider: "codex" }, ["retry", "stop"], "k");
    expect(p).toEqual({
      kind: "timeout",
      params: { provider: "codex" },
      options: [{ key: "retry" }, { key: "stop" }],
      idempotencyKey: "k",
    });
    const forged = requestChoicePayload(
      "provider_failure",
      {},
      ["retry", "pay_more" as never, "stop"],
      "k",
    );
    expect(forged.options).toEqual([{ key: "retry" }, { key: "stop" }]);
  });

  it("never sends a malformed native session id or an unverified model", () => {
    const p = runFinishedPayload({
      runId: RUN(1),
      exitClean: true,
      status: "completed",
      observedModel: "bad model; x",
      modelVerified: false,
      accessVerified: true,
      nativeSessionId: "--resume evil",
      nativeSessionKind: "claude_session",
      failure: null,
    });
    expect(p).toMatchObject({
      observedModel: null,
      nativeSessionId: null,
      nativeSessionKind: null,
    });
    expect(p).not.toHaveProperty("failure");
  });

  it("cuts artifacts to 512 KiB", () => {
    const p = artifactPayload({
      kind: "diff",
      title: "t",
      mime: "text/x-diff",
      content: "é".repeat(ARTIFACT_MAX_BYTES),
      runId: null,
    });
    expect(Buffer.byteLength(p.content as string)).toBeLessThanOrEqual(ARTIFACT_MAX_BYTES);
    expect(p.content as string).toMatch(/cut to 512 KiB/);
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const clock: ActivityClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= now) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  return { clock, advance };
}

describe("run activity", () => {
  it("maps Codex event types to the fixed enum, never reading text", () => {
    const ev = (type: string, item: Record<string, unknown>) => ({ type, item });
    expect(
      codexEventActivity(
        ev("item.started", { type: "command_execution", command: "npx vitest run" }),
        "builder",
      ),
    ).toBe("testing");
    expect(
      codexEventActivity(
        ev("item.started", { type: "command_execution", command: "rg foo" }),
        "reviewer",
      ),
    ).toBe("reading");
    expect(codexEventActivity(ev("item.completed", { type: "file_change" }), "builder")).toBe(
      "building",
    );
    expect(codexEventActivity(ev("item.completed", { type: "file_change" }), "reviewer")).toBe(
      "reading",
    );
    expect(
      codexEventActivity(ev("item.completed", { type: "agent_message", text: "x" }), "builder"),
    ).toBe("responding");
    expect(
      codexEventActivity(
        ev("item.completed", { type: "reasoning", text: "secret thoughts" }),
        "builder",
      ),
    ).toBeNull();
    expect(codexEventActivity({ type: "turn.completed" }, "builder")).toBeNull();
    expect(codexEventActivity("garbage", "builder")).toBeNull();
    for (const step of STEP_KINDS) expect(RUN_ACTIVITIES).toContain(phaseActivity(step));
  });

  it("sends at most one update per 5 s, the latest one, and only on a real signal", async () => {
    const sent: RunActivity[] = [];
    const { clock, advance } = fakeClock();
    const settle = () => new Promise((r) => setImmediate(r));
    const r = new ActivityReporter(async (a) => void sent.push(a), { clock });
    r.signal("reading");
    await settle();
    expect(sent).toEqual(["reading"]);
    r.signal("building");
    r.signal("testing");
    advance(4_000);
    await settle();
    expect(sent).toEqual(["reading"]);
    advance(1_000);
    await settle();
    expect(sent).toEqual(["reading", "testing"]);
    // Silence sends nothing: a stalled run looks stalled.
    advance(60_000);
    await settle();
    expect(sent).toHaveLength(2);
    r.signal("responding");
    await r.stop();
    r.signal("building");
    advance(10_000);
    await settle();
    expect(sent).toEqual(["reading", "testing", "responding"]);
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe("timeout policy", () => {
  it("has the contract's defaults and bounds", () => {
    expect(STEP_TIMEOUT_DEFAULTS_MIN).toEqual({
      normalise: 10,
      plan: 15,
      plan_review: 15,
      build: 30,
      review: 30,
      security_review: 40,
      inspection: 30,
      verify: 30,
    });
    expect(stepTimeoutMs("build")).toBe(30 * 60_000);
    expect(stepTimeoutMs("build", { build: 45 })).toBe(45 * 60_000);
    expect(increasedTimeoutMs(30 * 60_000)).toBe(60 * 60_000);
    expect(increasedTimeoutMs(100 * 60_000)).toBe(120 * 60_000);
    expect(increasedTimeoutMs(120 * 60_000)).toBeNull();
  });

  it("refuses project overrides outside 2-120 minutes, or for unknown steps", () => {
    expect(parseTimeoutOverrides({ review: 2, build: 120 })).toEqual({ review: 2, build: 120 });
    expect(() => parseTimeoutOverrides({ review: 1 })).toThrow();
    expect(() => parseTimeoutOverrides({ review: 121 })).toThrow();
    expect(() => parseTimeoutOverrides({ review: 2.5 })).toThrow();
    expect(() => parseTimeoutOverrides({ nap: 5 })).toThrow();
    const doc = (timeouts: unknown) =>
      JSON.stringify({
        kind: "threadlink.team_job",
        version: 1,
        jobId: JOB,
        roomId: `tlrom_${"b".repeat(32)}`,
        roomName: "Prism",
        goal: "g",
        budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 2 },
        policy: {
          usagePolicy: "balanced",
          paidUsage: false,
          crossReview: true,
          finalInspection: true,
          worktreeIsolation: true,
        },
        agents: [{ provider: "codex", displayName: "Codex", roles: [] }],
        timeouts,
      });
    expect(parseTeamJob(doc({ build: 60 })).timeouts).toEqual({ build: 60 });
    expect(parseTeamJob(doc(undefined)).timeouts).toEqual({});
    expect(() => parseTeamJob(doc({ build: 500 }))).toThrow(TeamJobError);
  });
});

// ---------------------------------------------------------------------------
// Schemas: teamMessage everywhere, owners from the job
// ---------------------------------------------------------------------------

describe("structured answers", () => {
  it("every schema requires a teamMessage", () => {
    for (const schema of [
      SPEC_SCHEMA,
      planSchema(),
      REVIEW_SCHEMA,
      BUILD_SCHEMA,
      INSPECTION_SCHEMA,
    ]) {
      expect(schema.required as readonly string[]).toContain("teamMessage");
      expect((schema.properties as Record<string, unknown>).teamMessage).toMatchObject({
        type: "string",
      });
    }
  });

  it("names the job's builders, not a fixed pair", () => {
    const owners = ["claude-code", "codex", "gemini-cli"];
    const plan = planSchema(owners);
    const node = (
      plan.properties.nodes.items.properties as unknown as Record<string, { enum?: string[] }>
    ).suggestedOwner!;
    expect(node.enum).toEqual(owners);
    expect(
      (
        reviewSchema(owners).properties.ownershipObjections.items.properties
          .proposedOwner as unknown as { enum: string[] }
      ).enum,
    ).toEqual(owners);
    const prompt = planPrompt(
      {
        goal: "g",
        requirements: [],
        constraints: [],
        architectureConstraints: [],
        securityConstraints: [],
        filesAndSystems: [],
        testsRequired: [],
        doNotChange: [],
        deploymentRules: [],
        definitionOfDone: [],
      },
      "Codex",
      undefined,
      owners.map((id) => ({ id, name: id })),
    );
    expect(prompt).toContain("gemini-cli");
    expect(prompt).toMatch(/not your private reasoning/);
  });

  it("takes the agent's own message, never inventing one", () => {
    expect(teamMessageOf({ teamMessage: "  I split it in two.  ", summary: "s" })).toBe(
      "I split it in two.",
    );
    expect(teamMessageOf({ summary: "Built it." })).toBe("Built it.");
    expect(teamMessageOf({ teamMessage: "   " })).toBeNull();
    expect(teamMessageOf({})).toBeNull();
    expect(teamMessageOf({ teamMessage: "x".repeat(5_000) })!.length).toBe(1_200);
  });

  it("posts the run's own summary when its teamMessage is a placeholder (seen in Production)", () => {
    expect(
      teamMessageOf({
        teamMessage: "Test",
        summary: "Prism is an internal AcronIQ analytics tool; the README describes its setup.",
      }),
    ).toBe("Prism is an internal AcronIQ analytics tool; the README describes its setup.");
    // A short message stands when nothing better was written by the same run.
    expect(teamMessageOf({ teamMessage: "Done.", summary: "ok" })).toBe("Done.");
  });

  it("tells the builder to answer a question in its message", () => {
    const prompt = buildPrompt(
      {
        goal: "Explain the README. Do not edit files.",
        requirements: [],
        constraints: [],
        architectureConstraints: [],
        securityConstraints: [],
        filesAndSystems: [],
        testsRequired: [],
        doNotChange: [],
        deploymentRules: [],
        definitionOfDone: [],
      } as never,
      { key: "work", title: "Explain", scope: "Answer", files: [], dependsOn: [] } as never,
      "claude-code",
    );
    expect(prompt).toMatch(/answer it fully in\s+`teamMessage`/);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("provider capabilities", () => {
  it("are facts per adapter, and unknown providers have none", () => {
    expect(capabilitiesOf("claude-code")).toMatchObject({
      accessVerification: "threadlink_checks_only",
      nativeSession: { kind: "claude_session", resume: true },
      activity: "phase",
    });
    expect(capabilitiesOf("codex")).toMatchObject({
      accessVerification: "provider_reported",
      nativeSession: { kind: "codex_thread", openInProvider: { supported: false } },
      activity: "events",
    });
    expect(capabilitiesOf("cursor")).toBeNull();
    expect(capabilitiesOf("__proto__")).toBeNull();
    for (const id of Object.keys(PROVIDER_CAPABILITIES)) {
      expect(JSON.parse(JSON.stringify(capabilitiesReport(id)))).toEqual(capabilitiesReport(id));
      expect(Object.values(capabilityFlags(id)).every((v) => typeof v === "boolean")).toBe(true);
    }
  });

  it("keep provider switches out of the orchestrator", () => {
    const source = readFileSync(join(__dirname, "../../runtime/src/team/orchestrator.ts"), "utf8");
    // No comparison, switch case or record key on a provider id: behaviour comes from capabilities.
    expect(source).not.toMatch(/["'](?:claude-code|codex)["']/);
    expect(source).not.toMatch(/case\s+["'](?:claude-code|codex)/);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery and the process registry
// ---------------------------------------------------------------------------

const journal = (over: Partial<JobJournalState> = {}): JobJournalState => ({
  version: 1,
  jobId: JOB,
  runtimePid: 999_999,
  attempt: 1,
  phase: "building",
  activeSteps: [],
  writeStarted: false,
  lastSafeStep: null,
  final: null,
  finalSynced: false,
  report: null,
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("crash recovery classification", () => {
  const step = (write: boolean) => ({
    runKey: "k",
    kind: write ? ("build" as const) : ("review" as const),
    write,
    provider: "codex",
    startedAt: "",
  });
  it.each([
    ["final computed, not synced", { final: { verdict: "PASS" } }, "completed_unsynced"],
    ["final synced", { final: { verdict: "PASS" }, finalSynced: true }, "completed"],
    [
      "final pending while a build was running",
      { final: { verdict: "PASS" }, activeSteps: [step(true)] },
      "completed_unsynced",
    ],
    ["nothing running, nothing written", {}, "resumable"],
    ["a read-only review was running", { activeSteps: [step(false)] }, "resumable"],
    ["a build was running", { activeSteps: [step(true)] }, "interrupted"],
    ["a build had run, nothing running now", { writeStarted: true }, "interrupted"],
  ] as const)("%s → %s", (_name, over, expected) => {
    expect(classifyRecovery(journal(over as Partial<JobJournalState>)).classification).toBe(
      expected,
    );
  });

  it("counts the dead Runtime's processes for the job, and never acts on them", () => {
    const r = classifyRecovery(journal({ activeSteps: [step(true)] }), [
      { pid: 1, provider: "codex", runId: null, jobId: JOB, startedAt: "" },
      { pid: 2, provider: "codex", runId: null, jobId: `tljob_${"c".repeat(32)}`, startedAt: "" },
    ]);
    expect(r).toMatchObject({
      classification: "interrupted",
      orphanedProcesses: 1,
      runningWriteStep: { kind: "build", provider: "codex" },
    });
  });

  it("journals survive a restart in configDir and reopen with the next attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-journal-"));
    const store = new JournalStore(dir);
    const j = store.open(JOB);
    j.phase("building");
    j.stepStarted(step(true));
    const reread = new JournalStore(dir).read(JOB)!;
    expect(reread).toMatchObject({ phase: "building", writeStarted: true, attempt: 1 });
    expect(classifyRecovery(reread).classification).toBe("interrupted");
    const next = store.open(JOB, reread);
    expect(next.state.attempt).toBe(2);
    next.finalComputed({ verdict: "PASS" });
    expect(classifyRecovery(store.read(JOB)!).classification).toBe("completed_unsynced");
    next.finalSynced("report");
    expect(classifyRecovery(store.read(JOB)!).classification).toBe("completed");
    expect(store.read("../../etc/passwd")).toBeNull();
  });
});

describe("the process registry", () => {
  it("kills only the processes ThreadLink started for that job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-procs-"));
    const registry = new ProcessRegistry(dir);
    const hold = ["-e", "setTimeout(() => {}, 60000)"];
    const mine = spawn(process.execPath, hold, { stdio: "ignore" });
    const otherJob = spawn(process.execPath, hold, { stdio: "ignore" });
    const stranger = spawn(process.execPath, hold, { stdio: "ignore" });
    const exited = (c: ReturnType<typeof spawn>) =>
      new Promise<void>((r) => (c.exitCode !== null ? r() : c.once("exit", () => r())));
    try {
      const other = `tljob_${"c".repeat(32)}`;
      registry.started(
        { pid: mine.pid!, provider: "codex", runId: RUN(1), jobId: JOB, startedAt: "" },
        mine,
      );
      registry.started(
        { pid: otherJob.pid!, provider: "codex", runId: RUN(2), jobId: other, startedAt: "" },
        otherJob,
      );
      expect(
        JSON.parse(readFileSync(join(dir, "team-processes.json"), "utf8")).entries,
      ).toHaveLength(2);

      expect(await registry.killJob(JOB)).toBe(1);
      await exited(mine);
      expect(mine.exitCode !== null || mine.signalCode !== null).toBe(true);
      expect(otherJob.exitCode).toBeNull();
      expect(stranger.exitCode).toBeNull();
      expect(registry.list().map((e) => e.jobId)).toEqual([other]);

      // A later Runtime sees the file's entries as stale: for classification, never killed.
      const later = new ProcessRegistry(dir);
      // (same process in this test: entries written by this pid are not stale)
      expect(later.takeStale()).toEqual([]);
    } finally {
      for (const c of [mine, otherJob, stranger]) c.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// The final report
// ---------------------------------------------------------------------------

describe("the final report", () => {
  it("is built from job data: verdict, units, findings by state, tests, team", () => {
    const md = finalReportMarkdown({
      room: "Prism",
      verdict: "NEEDS_FIX",
      summary: "Tests failed after integrating Unit a.",
      reason: "tests_failed",
      mode: "team",
      units: [
        {
          key: "a",
          title: "Unit | a",
          owner: "Codex",
          reviewer: "Claude Code",
          status: "integrated",
        },
      ],
      findings: [
        {
          severity: "blocking",
          status: "resolved",
          title: "Off by one",
          unit: "a",
          raisedBy: "Claude Code",
        },
        {
          severity: "important",
          status: "disputed",
          title: "Naming sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          unit: "a",
          raisedBy: "Codex",
        },
      ],
      tests: [{ command: "npm test", ok: false, exitCode: 1 }],
      agents: [{ name: "Codex", roles: ["builder"] }],
      finalVerifier: null,
      integrationBranch: "threadlink/x/integration",
      uncertainty: [],
    });
    expect(md).toContain("**Verdict:** NEEDS_FIX (tests_failed)");
    expect(md).toContain("Unit \\| a");
    expect(md).toContain("FAILED (exit 1)");
    expect(md).toContain("Remaining open items: 1");
    expect(md).not.toContain("sk-ant-api03-AAAA");
  });
});

// ---------------------------------------------------------------------------
// Security review fixes
// ---------------------------------------------------------------------------

describe("security review fixes", () => {
  it("never passes ThreadLink's own credential or settings to an agent", async () => {
    const { buildAgentEnv, isScrubbedVariable } = await import("../../runtime/src/team/env.ts");
    const { env, removed } = buildAgentEnv({
      PATH: "/bin",
      THREADLINK_BRIDGE_TOKEN: "tl_secret",
      threadlink_base_url: "https://x",
      CLAUDE_CODE_OAUTH_TOKEN: "kept: subscription sign-in",
    });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "kept: subscription sign-in" });
    expect(removed).toEqual(["THREADLINK_BRIDGE_TOKEN", "threadlink_base_url"]);
    expect(isScrubbedVariable("THREADLINK_BRIDGE_TOKEN")).toBe(true);
  });

  it("the single-task executor uses the same scrubbed environment", () => {
    const source = readFileSync(join(__dirname, "../../runtime/src/executor.ts"), "utf8");
    expect(source).toMatch(/env: buildAgentEnv\(process\.env\)\.env/);
  });

  it("an unreadable journal is an interruption, never a fresh start", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "tl-journal-bad-"));
    mkdirSync(join(dir, "team-jobs"), { recursive: true });
    writeFileSync(join(dir, "team-jobs", `${JOB}.json`), "{ not json");
    const store = new JournalStore(dir);
    const j = store.read(JOB)!;
    expect(j).toMatchObject({ unreadable: true, writeStarted: true });
    expect(classifyRecovery(j).classification).toBe("interrupted");
    expect(store.list().map((x) => x.jobId)).toEqual([JOB]);
    // The next attempt keeps the record that a write may have happened.
    expect(store.open(JOB, j).state.writeStarted).toBe(true);
  });

  it("keeps writeStarted across attempts", () => {
    const store = new JournalStore(null);
    const first = store.open(JOB);
    first.stepStarted({
      runKey: "b",
      kind: "build",
      write: true,
      provider: "codex",
      startedAt: "",
    });
    first.stepFinished("b", false);
    const second = store.open(JOB, store.read(JOB));
    expect(second.state).toMatchObject({ attempt: 2, writeStarted: true });
    expect(classifyRecovery(second.state).classification).toBe("interrupted");
  });

  it("a journal of a Runtime process that is still running is not a crash", async () => {
    const { leftByAnotherProcess } = await import("../../runtime/src/team/registry.ts");
    const now = Date.now();
    const recent = journal({ runtimePid: 4242, updatedAt: new Date(now - 60_000).toISOString() });
    expect(leftByAnotherProcess(recent, () => true, now)).toBe(false);
    expect(leftByAnotherProcess(recent, () => false, now)).toBe(true);
    // A live pid with a journal untouched for hours is a reused pid, not that Runtime.
    const stale = journal({
      runtimePid: 4242,
      updatedAt: new Date(now - 5 * 3_600_000).toISOString(),
    });
    expect(leftByAnotherProcess(stale, () => true, now)).toBe(true);
    expect(leftByAnotherProcess(journal({ runtimePid: process.pid }), () => true, now)).toBe(false);
  });

  it("recognises the server's refusal of a write run on an interrupted job", async () => {
    const { isInterruptedRefusal, wireKey } = await import("../../runtime/src/team/wire.ts");
    expect(isInterruptedRefusal({ status: 409, kind: "job_interrupted" })).toBe(true);
    expect(isInterruptedRefusal({ status: 409, kind: "interrupted" })).toBe(true);
    expect(isInterruptedRefusal(new Error("resume_required"))).toBe(true);
    expect(isInterruptedRefusal(new Error("invalid provider"))).toBe(false);
    // Idempotency keys: valid keys unchanged; others hashed (SHA-256, 32 hex).
    expect(wireKey("abc:build:r0")).toBe("abc:build:r0");
    const long = wireKey("x".repeat(200));
    expect(long).toMatch(/^k:[0-9a-f]{32}$/);
    expect(wireKey("x".repeat(200))).toBe(long);
    expect(wireKey("héllo")).toMatch(/^k:[0-9a-f]{32}$/);
  });

  it("killTree never touches a child that has already exited", async () => {
    const { killTree } = await import("../../runtime/src/team/runner.ts");
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((r) => child.once("exit", () => r()));
    const kill = vi.spyOn(process, "kill");
    await killTree(child);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
});
