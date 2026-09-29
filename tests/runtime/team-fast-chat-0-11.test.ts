import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildClaudeArgs, buildClaudePrompt } from "../../runtime/src/team/runners/claude.ts";
import { buildCodexArgs, buildCodexPrompt } from "../../runtime/src/team/runners/codex.ts";
import {
  ChatSessionStore,
  SESSION_MAX_TURNS,
  workspaceKey,
} from "../../runtime/src/team/chat-sessions.ts";
import { maxFollowupsFromEnv } from "../../runtime/src/team/executor.ts";
import {
  CHAT_SCHEMA,
  FastChatCoordinator,
  isPlaceholder,
  isSmallTalk,
  type FastChatDeps,
} from "../../runtime/src/team/fast-chat.ts";
import { parseTeamJob, type TeamJobDefinition } from "../../runtime/src/team/job.ts";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from "../../runtime/src/team/orchestrator.ts";
import type { AgentProvider } from "../../runtime/src/team/types.ts";

/**
 * docs/design/threadlink-0.11.md §3.4: the Fast Chat lane.
 */

const JOB = `tljob_${"a".repeat(32)}`;
const CHAT_1 = `tlcht_${"1".repeat(32)}`;
const CHAT_2 = `tlcht_${"2".repeat(32)}`;
const SOURCE = `tlcev_${"e".repeat(32)}`;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const THREAD = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-fastchat-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function chatJob(over: Record<string, unknown> = {}): TeamJobDefinition {
  return parseTeamJob(
    JSON.stringify({
      kind: "threadlink.team_job",
      version: 1,
      jobId: JOB,
      roomId: `tlrom_${"b".repeat(32)}`,
      roomName: "Prism",
      goal: "What does the auth middleware do when the token has expired?",
      lane: "chat",
      failoverPolicy: "auto",
      sourceEventId: SOURCE,
      chatId: CHAT_1,
      mode: "team",
      responders: ["claude-code", "codex"],
      participants: ["claude-code", "codex"],
      agents: [
        { provider: "claude-code", displayName: "Claude Code", roles: [] },
        { provider: "codex", displayName: "Codex", roles: [] },
      ],
      ...over,
    }),
  );
}

type Op = {
  op: string;
  payload: Record<string, unknown>;
  at: number;
  answer?: Record<string, unknown>;
};

type Answer = Partial<{ message: string; needsWork: boolean; workReason: string }> & {
  delayMs?: number;
  fail?: AgentRunResult["failure"];
  resetsAt?: string | null;
  threadId?: string;
};

function harness(
  answers: Partial<Record<AgentProvider, (req: AgentRunRequest, n: number) => Answer>>,
  over: Partial<FastChatDeps> = {},
) {
  const ops: Op[] = [];
  const requests: { provider: AgentProvider; req: AgentRunRequest; at: number }[] = [];
  let runs = 0;
  let messages = 0;
  const control: { value: string | null } = { value: null };
  const sink: FastChatDeps["sink"] = async (op, payload) => {
    const record: Op = { op, payload, at: Date.now() };
    ops.push(record);
    const answer = await respond(op);
    record.answer = answer;
    return answer;
  };
  const respond = async (op: string): Promise<Record<string, unknown>> => {
    const base = control.value ? { control: control.value, controlRequestedAt: "t" } : {};
    switch (op) {
      case "run_started":
        return { ...base, runId: `tlarn_${hex(++runs)}` };
      case "add_message":
        return { ...base, messageId: `tlcev_${hex(1000 + ++messages)}` };
      case "read_chat_context":
        return {
          ...base,
          messages: [
            {
              id: `tlcev_${hex(1)}`,
              chatSeq: 1,
              authorKind: "owner",
              authorProviderId: null,
              authorLabel: "You",
              replyTo: null,
              body: "Earlier: we moved auth to middleware.",
              createdAt: "2026-09-29T10:00:00Z",
            },
          ],
        };
      case "request_choice":
        return { ...base, choiceId: `tlchc_${hex(7)}` };
      default:
        return base;
    }
  };
  const counts = new Map<AgentProvider, number>();
  const runner = (provider: AgentProvider): AgentRunner => ({
    provider,
    verifiesAccess: provider === "codex",
    async run(req) {
      const n = (counts.get(provider) ?? 0) + 1;
      counts.set(provider, n);
      requests.push({ provider, req, at: Date.now() });
      const a = answers[provider]?.(req, n) ?? { message: `${provider} says hello there.` };
      if (a.delayMs) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, a.delayMs);
          req.signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
      if (req.signal?.aborted) {
        return {
          ok: false,
          text: "",
          threadId: null,
          requestedModel: req.model,
          observedModel: null,
          observedEffort: null,
          accessVerified: false,
          permissionDenials: 0,
          failure: "cancelled",
        };
      }
      const threadId =
        a.threadId ?? req.resumeThreadId ?? THREAD(n + (provider === "codex" ? 50 : 0));
      if (a.fail) {
        return {
          ok: false,
          text: "",
          threadId: null,
          requestedModel: req.model,
          observedModel: null,
          observedEffort: null,
          accessVerified: false,
          permissionDenials: 0,
          failure: a.fail,
          resetsAt: a.resetsAt ?? null,
          error: "usage limit reached",
          timings: { spawnMs: 5, firstEventMs: 10, providerMs: 30 },
        };
      }
      return {
        ok: true,
        text: "",
        structured: {
          message: a.message ?? "",
          needsWork: a.needsWork ?? false,
          workReason: a.workReason ?? "",
        },
        threadId,
        requestedModel: req.model,
        observedModel: req.model,
        modelVerified: true,
        observedEffort: null,
        accessVerified: provider === "codex",
        permissionDenials: 0,
        timings: { spawnMs: 7, firstEventMs: 12, providerMs: 40 },
      };
    },
  });
  const deps: FastChatDeps = {
    runners: { "claude-code": runner("claude-code"), codex: runner("codex") },
    route: (r) => ({
      ok: true,
      model: r.provider === "codex" ? "gpt-5.5" : "claude-sonnet-5",
      effort: null,
      modelClass: "BALANCED",
      reason: "test",
    }),
    sink,
    snapshot: async () => "same",
    controlPollMs: 0,
    queueMs: 420,
    ...over,
  };
  return { ops, requests, deps, control };
}

const of = (ops: Op[], op: string) => ops.filter((o) => o.op === op);

describe("first turns (§3.4.3)", () => {
  it("run concurrently, and each answer is posted the moment it returns", async () => {
    const h = harness({
      "claude-code": () => ({
        message: "Claude: it returns 401 and clears the cookie.",
        delayMs: 20,
      }),
      codex: () => ({ message: "Codex: it redirects to /login after a 401.", delayMs: 250 }),
    });
    const outcome = await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    expect(outcome.status).toBe("completed");
    const [claude, codex] = ["claude-code", "codex"].map(
      (p) => h.requests.find((r) => r.provider === p)!.at,
    );
    // Both started before either could have finished: concurrent.
    expect(Math.abs(claude! - codex!)).toBeLessThan(100);
    const posts = of(h.ops, "add_message").filter((m) => m.payload.round === 0);
    expect(posts.map((m) => m.payload.sender)).toEqual(["claude-code", "codex"]);
    // Claude's answer was posted long before Codex finished.
    expect(posts[1]!.at - posts[0]!.at).toBeGreaterThan(150);
    // run_started → add_message (with the run) → run_finished, per turn.
    const claudeRun = of(h.ops, "run_started").find((o) => o.payload.provider === "claude-code")!;
    const idx = (o: Op) => h.ops.indexOf(o);
    const claudeMsg = posts[0]!;
    const claudeFinish = of(h.ops, "run_finished").find(
      (o) => o.payload.runId === claudeMsg.payload.runId,
    )!;
    expect(idx(claudeRun)).toBeLessThan(idx(claudeMsg));
    expect(idx(claudeMsg)).toBeLessThan(idx(claudeFinish));
    expect(of(h.ops, "set_status").at(-1)!.payload.status).toBe("completed");
  });

  it("runs read-only in the project folder, with the chat schema, and records timings", async () => {
    const h = harness({});
    await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    for (const { req } of h.requests) {
      expect(req.access).toBe("read-only");
      expect(req.cwd).toBe(dir);
      expect(req.purpose).toBe("chat");
      expect(req.outputSchema).toBe(CHAT_SCHEMA);
      expect(req.prompt).toContain("token has expired");
    }
    // First turns get the scoped context: this chat's recent messages.
    for (const { req } of h.requests.slice(0, 2)) {
      expect(req.prompt).toContain("we moved auth to middleware");
    }
    const finished = of(h.ops, "run_finished")[0]!.payload;
    expect(finished.timings).toMatchObject({
      queueMs: 420,
      spawnMs: 7,
      firstEventMs: 12,
      providerMs: 40,
    });
    expect((finished.timings as Record<string, number>).contextMs).toBeGreaterThanOrEqual(0);
    expect((finished.timings as Record<string, number>).persistMs).toBeGreaterThanOrEqual(0);
    // Model verified exactly as 0.10: only the runner's own check counts.
    expect(finished.modelVerified).toBe(true);
    // No worktree, no plan, no nodes, no verdict.
    for (const op of ["set_plan", "upsert_nodes", "set_final", "open_round"]) {
      expect(of(h.ops, op)).toHaveLength(0);
    }
  });

  it("the read-only flags are the real CLI flags", () => {
    const req: AgentRunRequest = {
      provider: "claude-code",
      role: "investigator",
      cwd: dir,
      prompt: "hi",
      model: "claude-sonnet-5",
      access: "read-only",
      purpose: "chat",
    };
    const claude = buildClaudeArgs(req);
    expect(claude.join(" ")).toContain("--permission-mode plan");
    expect(claude).not.toContain("--bare");
    expect(buildClaudePrompt(req)).toMatch(/^\[ThreadLink Fast Chat\]/);
    const codex = buildCodexArgs({ ...req, provider: "codex", model: "gpt-5.5" });
    expect(codex.join(" ")).toContain("-s read-only");
    expect(buildCodexPrompt({ ...req, provider: "codex" })).toMatch(/^\[ThreadLink Fast Chat\]/);
    const resumed = buildCodexArgs({
      ...req,
      provider: "codex",
      model: "gpt-5.5",
      resumeThreadId: THREAD(1),
    });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", THREAD(1)]);
    expect(resumed).toContain('sandbox_mode="read-only"');
    expect(buildClaudeArgs({ ...req, resumeThreadId: THREAD(2) }).slice(0, 3)).toEqual([
      "-p",
      "--resume",
      THREAD(2),
    ]);
  });

  it("never posts a placeholder as an agent's answer (0.10.1 guard)", async () => {
    const h = harness({
      "claude-code": () => ({ message: "Test" }),
      codex: () => ({ message: "   " }),
    });
    const outcome = await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    expect(of(h.ops, "add_message")).toHaveLength(0);
    expect(outcome.status).toBe("failed");
    expect(of(h.ops, "set_status").at(-1)!.payload.status).toBe("failed");
    expect(isPlaceholder("Done.")).toBe(true);
    expect(isPlaceholder("Done: the middleware now checks expiry first.")).toBe(false);
  });

  it("answers with the solo agent only", async () => {
    const h = harness({});
    await new FastChatCoordinator(
      chatJob({ mode: "solo", builder: "codex", responders: null }),
      h.deps,
    ).run(dir);
    expect(new Set(h.requests.map((r) => r.provider))).toEqual(new Set(["codex"]));
  });
});

describe("the bounded follow-up (§3.4.4)", () => {
  it("is one round by default, sees the others' answers, replies to them, and may decline", async () => {
    const h = harness({
      "claude-code": (req, n) =>
        n === 1
          ? { message: "It returns 401 and the client refreshes." }
          : { message: "" /* nothing new: nothing is posted */ },
      codex: (req, n) =>
        n === 1
          ? { message: "It redirects to the login page." }
          : {
              message: req.prompt.includes("It returns 401")
                ? "Correction: the redirect only happens for page routes; APIs get 401."
                : "?",
            },
    });
    const outcome = await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    const followups = of(h.ops, "add_message").filter((m) => m.payload.round === 1);
    expect(followups).toHaveLength(1);
    expect(followups[0]!.payload.sender).toBe("codex");
    // It replies to Claude's first answer.
    const firstClaude = of(h.ops, "add_message").find(
      (m) => m.payload.round === 0 && m.payload.sender === "claude-code",
    )!;
    const claudeMessageId = firstClaude.answer!.messageId;
    expect(claudeMessageId).toMatch(/^tlcev_/);
    expect(followups[0]!.payload.replyTo).toEqual({ kind: "message", id: claudeMessageId });
    expect(h.requests.filter((r) => r.provider === "codex")).toHaveLength(2);
    // The declined follow-up is still a recorded, completed run with no message.
    expect(of(h.ops, "run_started")).toHaveLength(4);
    expect(outcome.posted).toBe(3);
  });

  it("never runs for small talk, or with a single answer", async () => {
    const h = harness({});
    await new FastChatCoordinator(chatJob({ goal: "@team hi!" }), h.deps).run(dir);
    expect(h.requests).toHaveLength(2);
    const solo = harness({});
    await new FastChatCoordinator(chatJob({ responders: ["codex"] }), solo.deps).run(dir);
    expect(solo.requests).toHaveLength(1);
    expect(isSmallTalk("thanks both!")).toBe(true);
    expect(isSmallTalk("what does the auth middleware do?")).toBe(false);
  });

  it("is capped: FAST_CHAT_MAX_FOLLOWUPS defaults to 1 and never exceeds 2", async () => {
    expect(maxFollowupsFromEnv({})).toBe(1);
    expect(maxFollowupsFromEnv({ FAST_CHAT_MAX_FOLLOWUPS: "0" })).toBe(0);
    expect(maxFollowupsFromEnv({ FAST_CHAT_MAX_FOLLOWUPS: "9" })).toBe(2);
    expect(maxFollowupsFromEnv({ FAST_CHAT_MAX_FOLLOWUPS: "x" })).toBe(1);
    // Agents that always have something to add still stop after the cap.
    const h = harness(
      {
        "claude-code": (_r, n) => ({ message: `Claude point number ${n} about expiry.` }),
        codex: (_r, n) => ({ message: `Codex point number ${n} about expiry.` }),
      },
      { maxFollowups: 5 },
    );
    await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    expect(h.requests).toHaveLength(2 * 3); // first + 2 follow-up rounds
  });
});

describe("escalation to work (§2.5)", () => {
  it("offers start_work with the source message when an agent says it needs real work", async () => {
    const h = harness({
      codex: () => ({
        message: "I can explain, but fixing it needs a code change.",
        needsWork: true,
        workReason: "Change the middleware.",
      }),
    });
    const outcome = await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    const choices = of(h.ops, "request_choice");
    expect(choices).toHaveLength(1);
    expect(choices[0]!.payload).toMatchObject({
      kind: "start_work",
      params: { sourceEventId: SOURCE },
      options: [{ key: "run_work" }, { key: "keep_chatting" }],
    });
    expect(outcome.needsWork).toBe(true);
  });
});

describe("availability and failover in chat (§3.4.2, §5)", () => {
  it("skips an agent that is out of usage, with one quiet notice", async () => {
    const noticesSent = new Set<string>();
    const h = harness(
      {},
      {
        health: { peek: () => ({ "claude-code": "ready", codex: "usage_exhausted" }) },
        noticesSent,
      },
    );
    await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    expect(h.requests.map((r) => r.provider)).toEqual(["claude-code"]);
    expect(of(h.ops, "failover_notice")).toHaveLength(1);
    expect(of(h.ops, "failover_notice")[0]!.payload).toEqual({
      from: "codex",
      to: "claude-code",
      reviewPending: false,
      resetsAt: null,
    });
    // The next turn of the same chat does not repeat the notice.
    const again = harness(
      {},
      {
        health: { peek: () => ({ "claude-code": "ready", codex: "usage_exhausted" }) },
        noticesSent,
      },
    );
    await new FastChatCoordinator(chatJob(), again.deps).run(dir);
    expect(of(again.ops, "failover_notice")).toHaveLength(0);
  });

  it("auto: an agent that runs out mid-turn, answering alone, is replaced by an available one", async () => {
    const exhausted: string[] = [];
    const h = harness(
      {
        codex: () => ({ fail: "quota_exhausted", resetsAt: "2026-09-29T15:00:00.000Z" }),
      },
      { onExhausted: (p) => exhausted.push(p) },
    );
    const outcome = await new FastChatCoordinator(chatJob({ responders: ["codex"] }), h.deps).run(
      dir,
    );
    expect(exhausted).toEqual(["codex"]);
    expect(h.requests.map((r) => r.provider)).toEqual(["codex", "claude-code"]);
    expect(of(h.ops, "failover_notice")[0]!.payload).toMatchObject({
      from: "codex",
      to: "claude-code",
      resetsAt: "2026-09-29T15:00:00.000Z",
    });
    expect(outcome.answered).toEqual(["claude-code"]);
  });

  it("skips a responder that needs sign-in without a notice", async () => {
    const h = harness({}, { health: { peek: () => ({ codex: "needs_sign_in" }) } });
    await new FastChatCoordinator(chatJob(), h.deps).run(dir);
    expect(h.requests.map((r) => r.provider)).toEqual(["claude-code"]);
    expect(of(h.ops, "failover_notice")).toHaveLength(0);
  });
});

describe("stop (§3.4)", () => {
  it("stop_now aborts every in-flight chat run and ends the job cancelled", async () => {
    const h = harness({
      "claude-code": () => ({ message: "slow answer", delayMs: 5_000 }),
      codex: () => ({ message: "slow answer", delayMs: 5_000 }),
    });
    const started = Date.now();
    const coordinator = new FastChatCoordinator(chatJob(), {
      ...h.deps,
      controlPollMs: 20,
      // The owner presses Stop while both agents are thinking.
      sink: async (op, payload) => {
        if (op === "read_choices") h.control.value = "stop_now";
        return h.deps.sink(op, payload);
      },
    });
    const outcome = await coordinator.run(dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcome.status).toBe("cancelled");
    expect(of(h.ops, "add_message")).toHaveLength(0);
    expect(of(h.ops, "set_status").at(-1)!.payload.status).toBe("cancelled");
  });
});

describe("native session continuity (§3.4.6)", () => {
  it("resumes the chat's session on the next turn, and records why", async () => {
    const sessions = new ChatSessionStore(join(dir, "cfg"));
    const first = harness(
      { codex: () => ({ message: "First answer about expiry." }) },
      { sessions },
    );
    await new FastChatCoordinator(chatJob({ responders: ["codex"] }), first.deps).run(dir);
    expect(of(first.ops, "run_started")[0]!.payload).toMatchObject({
      continuity: "fresh",
      sessionReason: "fresh_first_turn",
    });
    const threadId = first.requests[0]!.req.resumeThreadId;
    expect(threadId).toBeUndefined();

    // A new Runtime process reads the same store from the config directory.
    const later = harness({}, { sessions: new ChatSessionStore(join(dir, "cfg")) });
    await new FastChatCoordinator(chatJob({ responders: ["codex"] }), later.deps).run(dir);
    expect(later.requests[0]!.req.resumeThreadId).toBe(THREAD(51));
    expect(of(later.ops, "run_started")[0]!.payload).toMatchObject({
      continuity: "resumed",
      sessionReason: "resumed",
    });
  });

  it("never reuses a session across chats or workspaces", async () => {
    const store = new ChatSessionStore(join(dir, "cfg"));
    store.record(CHAT_1, "codex", dir, THREAD(9), false);
    expect(store.plan(CHAT_1, "codex", dir)).toMatchObject({ resume: THREAD(9) });
    expect(store.plan(CHAT_2, "codex", dir)).toEqual({
      resume: null,
      reason: "fresh_first_turn",
    });
    expect(store.plan(CHAT_1, "codex", join(dir, "other-project"))).toEqual({
      resume: null,
      reason: "fresh_first_turn",
    });
    expect(store.plan(CHAT_1, "claude-code", dir).resume).toBeNull();
    expect(store.plan(null, "codex", dir).resume).toBeNull();

    // In a real turn: chat 2 starts fresh even though chat 1 has a session.
    const h = harness({}, { sessions: store });
    await new FastChatCoordinator(chatJob({ chatId: CHAT_2, responders: ["codex"] }), h.deps).run(
      dir,
    );
    expect(h.requests[0]!.req.resumeThreadId).toBeUndefined();
    expect(of(h.ops, "run_started")[0]!.payload.sessionReason).toBe("fresh_first_turn");
  });

  it("rotates after 30 turns or 24 hours", () => {
    let now = Date.parse("2026-09-29T10:00:00Z");
    const store = new ChatSessionStore(null, { now: () => now });
    store.record(CHAT_1, "claude-code", dir, THREAD(1), false);
    for (let i = 1; i < SESSION_MAX_TURNS; i++) {
      store.record(CHAT_1, "claude-code", dir, THREAD(1), true);
    }
    expect(store.plan(CHAT_1, "claude-code", dir)).toEqual({
      resume: null,
      reason: "fresh_rotated",
    });
    store.record(CHAT_1, "claude-code", dir, THREAD(2), false);
    expect(store.plan(CHAT_1, "claude-code", dir).resume).toBe(THREAD(2));
    now += 24 * 60 * 60_000;
    expect(store.plan(CHAT_1, "claude-code", dir).reason).toBe("fresh_rotated");
  });

  it("starts fresh when resuming fails, and says so", async () => {
    const sessions = new ChatSessionStore(null);
    sessions.record(CHAT_1, "codex", dir, THREAD(77), false);
    const h = harness(
      {
        codex: (req) =>
          req.resumeThreadId ? { fail: "provider_error" } : { message: "Fresh answer here." },
      },
      { sessions },
    );
    await new FastChatCoordinator(chatJob({ responders: ["codex"] }), h.deps).run(dir);
    expect(h.requests.map((r) => r.req.resumeThreadId ?? null)).toEqual([THREAD(77), null]);
    expect(of(h.ops, "run_started").map((o) => o.payload.sessionReason)).toEqual([
      "resumed",
      "fresh_resume_failed",
    ]);
    expect(of(h.ops, "add_message")).toHaveLength(1);
    // The failed session is forgotten; the new one is remembered.
    expect(sessions.plan(CHAT_1, "codex", dir).resume).not.toBe(THREAD(77));
  });

  it("a hand-edited store cannot point one chat at another chat's session", () => {
    const file = join(dir, "cfg", "fast-chat-sessions.json");
    mkdirSync(join(dir, "cfg"), { recursive: true });
    const entry = {
      chatId: CHAT_1,
      provider: "codex",
      workspace: workspaceKey(dir),
      sessionId: THREAD(5),
      turns: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      lastRunKey: null,
    };
    // Keys are rebuilt from each entry's own fields; a bad entry is dropped.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [entry, { ...entry, chatId: "tlcht_../other", sessionId: THREAD(6) }],
      }),
    );
    const reread = new ChatSessionStore(join(dir, "cfg"));
    expect(reread.plan(CHAT_2, "codex", dir).resume).toBeNull();
    expect(reread.plan(CHAT_1, "codex", dir).resume).toBe(THREAD(5));
    expect(reread.list()).toHaveLength(1);
  });
});

describe("the chat job document (§2.2)", () => {
  it("carries lane, failover policy, source and responders; older documents are work", () => {
    const job = chatJob();
    expect(job).toMatchObject({
      lane: "chat",
      failoverPolicy: "auto",
      sourceEventId: SOURCE,
      responders: ["claude-code", "codex"],
    });
    const old = parseTeamJob(
      JSON.stringify({
        kind: "threadlink.team_job",
        version: 1,
        jobId: JOB,
        roomId: `tlrom_${"b".repeat(32)}`,
        roomName: "Prism",
        goal: "Fix it.",
        budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 1 },
        policy: {
          usagePolicy: "balanced",
          paidUsage: false,
          crossReview: true,
          finalInspection: true,
          worktreeIsolation: true,
        },
        agents: [{ provider: "codex", displayName: "Codex", roles: [] }],
      }),
    );
    expect(old.lane).toBe("work");
    // 0.10 behaviour for a job from an older server: ask, never switch silently.
    expect(old.failoverPolicy).toBe("ask");
    expect(() => chatJob({ lane: "fast" })).toThrow(/lane/);
    expect(() => chatJob({ failoverPolicy: "pay" })).toThrow(/failoverPolicy/);
    expect(() => chatJob({ responders: ["cursor"] })).toThrow(/responders/);
  });
});
