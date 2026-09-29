import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderAdapter } from "../../runtime/src/adapters/types.ts";
import { ApiError, type RuntimeView } from "../../runtime/src/api.ts";
import { RuntimeEngine, taskLane } from "../../runtime/src/engine.ts";
import type { Executor, TaskInput } from "../../runtime/src/executor.ts";

/**
 * docs/design/threadlink-0.11.md §3.1-§3.3: liveness independent of work,
 * the wake long-poll, and background execution with lane limits.
 */

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";

let dir: string;
let wsA: string;
let wsB: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-engine-011-"));
  wsA = join(dir, "Prism");
  wsB = join(dir, "Nova");
  mkdirSync(wsA);
  mkdirSync(wsB);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const view = (): RuntimeView => ({
  runtimeId: "tlrun_00000000000000000000000000000001",
  label: "Nickron PC",
  platform: "windows",
  kind: "desktop",
  paused: false,
  restartRequestedAt: null,
  settings: {},
  status: "active",
});

const CHAT = (n: number) => `tlcht_${String(n).padStart(32, "0")}`;
const job = (lane: "chat" | "work", chat: number) =>
  JSON.stringify({ kind: "threadlink.team_job", version: 1, lane, chatId: CHAT(chat) });

type Queued = { taskId: string; title: string; content: string; taskType?: string };

function fakeApi() {
  let n = 0;
  const sessions = new Map<string, string>();
  const queue = new Map<string, Queued[]>();
  const claimedAt = new Map<string, number>();
  const api = {
    registerRuntime: vi.fn(async () => view()),
    runtimeHeartbeat: vi.fn(async () => view()),
    upsertWorkspace: vi.fn(async (i: { workspaceKey: string }) => ({
      workspaceId: `tlwsp_${i.workspaceKey.slice(0, 32)}`,
    })),
    registerConversation: vi.fn(async (i: { localBindingRef: string }) => {
      if (!sessions.has(i.localBindingRef))
        sessions.set(i.localBindingRef, `tlses_${String(++n).padStart(32, "0")}`);
      return { sessionId: sessions.get(i.localBindingRef)!, created: true };
    }),
    links: vi.fn(async () => []),
    runtimeLinks: vi.fn(async (): Promise<unknown[]> => []),
    approvePairing: vi.fn(async () => ({})),
    declinePairing: vi.fn(async () => ({})),
    inbox: vi.fn(async (sessionId: string) =>
      (queue.get(sessionId) ?? []).map((t) => ({
        ...t,
        priority: "C",
        status: claimedAt.has(t.taskId) ? "working" : "queued",
      })),
    ),
    claim: vi.fn(async (taskId: string) => {
      const queued = [...queue.values()].flat().find((t) => t.taskId === taskId)!;
      if (claimedAt.has(taskId)) throw new ApiError(409, "conflict");
      claimedAt.set(taskId, Date.now());
      return { ...queued, priority: "C", status: "claimed" };
    }),
    start: vi.fn(async () => ({})),
    heartbeat: vi.fn(async () => ({})),
    progress: vi.fn(async () => ({})),
    complete: vi.fn(async (taskId: string, sessionId: string) => {
      queue.set(
        sessionId,
        (queue.get(sessionId) ?? []).filter((t) => t.taskId !== taskId),
      );
      return {};
    }),
    fail: vi.fn(async () => ({})),
    blocked: vi.fn(async () => ({})),
    reportProviderDetection: vi.fn(async () => ({})),
    teamWrite: vi.fn(async () => ({})),
  };
  return { api, sessions, queue, claimedAt };
}

const adapter: ProviderAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  detect: async () => ({ available: true, version: "2.1.266" }),
  capabilities: () => ({}),
  supports: () => ({
    supportsExactResume: true,
    supportsFork: true,
    supportsBackgroundWorker: true,
    supportsBusyDetection: true,
  }),
  discoverWorkspaces: async () => [],
  discoverConversations: async () => [],
  conversationExists: async () => true,
  runningConversationIds: async () => new Set<string>(),
  createExecutor: (): Executor => ({
    name: "fake",
    execute: async () => ({ ok: true, result: "done", artifacts: [] }),
  }),
};

/** A team executor whose jobs run until the test releases them. */
function gatedTeam() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const release = (taskId: string) => gates.get(taskId)?.();
  const executor: Executor = {
    name: "team",
    execute: (task: TaskInput) =>
      new Promise((resolve) => {
        started.push(task.taskId);
        gates.set(task.taskId, () => resolve({ ok: true, result: "ok", artifacts: [] }));
      }),
  };
  return { started, release, executor };
}

const tinySleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, Math.min(ms, 15));
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

function engine(api: ReturnType<typeof fakeApi>["api"], extra: Record<string, unknown> = {}) {
  return new RuntimeEngine({
    api: api as never,
    configDir: join(dir, "cfg"),
    adapters: [adapter],
    identity: { label: "Nickron PC", platform: "windows", kind: "desktop" },
    version: "0.11.0",
    repo: async () => ({ remote: null, fingerprint: null, branch: null }),
    sleep: tinySleep,
    backoff: { minMs: 10, maxMs: 20, factor: 2, jitter: 0 },
    ...extra,
  });
}

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("lane of a delivered task (§3.3)", () => {
  it("is read from the job document; anything else is work", () => {
    expect(taskLane({ taskType: "team", content: job("chat", 1) })).toEqual({
      lane: "chat",
      chatId: CHAT(1),
    });
    expect(taskLane({ taskType: "team", content: job("work", 1) }).lane).toBe("work");
    expect(taskLane({ taskType: "team", content: "{broken" }).lane).toBe("work");
    // A controller cannot make an ordinary task a chat job by shaping its text.
    expect(taskLane({ taskType: "general", content: job("chat", 1) }).lane).toBe("work");
    expect(
      taskLane({
        taskType: "team",
        content: JSON.stringify({ lane: "chat", chatId: "tlcht_../../x" }),
      }),
    ).toEqual({ lane: "chat", chatId: null });
  });
});

describe("liveness is independent of work (§3.1)", () => {
  it("keeps heartbeating on its own timer while a long job runs", async () => {
    const { api, sessions, queue } = fakeApi();
    const team = gatedTeam();
    const e = engine(api, { heartbeatMs: 30, teamExecutor: () => team.executor });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    queue.set(sessions.get(`cc:${A1}`)!, [
      { taskId: "tltask_long", title: "long", content: job("work", 1), taskType: "team" },
    ]);
    const stop = new AbortController();
    const running = e.run(stop.signal);
    await until(() => team.started.includes("tltask_long"));
    const before = api.runtimeHeartbeat.mock.calls.length;
    await new Promise((r) => setTimeout(r, 400));
    // At 30 ms per beat, a blocked loop would have sent none.
    expect(api.runtimeHeartbeat.mock.calls.length - before).toBeGreaterThanOrEqual(4);
    expect(e.snapshot().status).toBe("online");
    team.release("tltask_long");
    stop.abort();
    expect(await running).toBe("stopped");
  });

  it("sends one heartbeat at a time even when the loop and the timer both want one", async () => {
    const { api } = fakeApi();
    let release: () => void = () => {};
    api.runtimeHeartbeat.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(view()))),
    );
    const e = engine(api);
    await e.register();
    const a = e.heartbeat();
    const b = e.heartbeat();
    await until(() => api.runtimeHeartbeat.mock.calls.length === 1);
    release();
    await Promise.all([a, b]);
    expect(api.runtimeHeartbeat).toHaveBeenCalledTimes(1);
  });
});

describe("background execution and lane limits (§3.3)", () => {
  it("runs a chat task while a work job runs, and the next work task waits behind it", async () => {
    const { api, sessions, queue } = fakeApi();
    const team = gatedTeam();
    const e = engine(api, { heartbeatMs: 60_000, teamExecutor: () => team.executor });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    const s = sessions.get(`cc:${A1}`)!;
    queue.set(s, [
      { taskId: "tltask_w1", title: "w1", content: job("work", 1), taskType: "team" },
      { taskId: "tltask_w2", title: "w2", content: job("work", 1), taskType: "team" },
      // Behind a work task that must wait: still picked (no head-of-line blocking).
      { taskId: "tltask_c1", title: "c1", content: job("chat", 1), taskType: "team" },
    ]);
    const stop = new AbortController();
    const running = e.run(stop.signal);
    await until(() => team.started.includes("tltask_c1") && team.started.includes("tltask_w1"));
    await new Promise((r) => setTimeout(r, 60));
    expect(team.started).not.toContain("tltask_w2");
    expect(
      e
        .runningTasks()
        .map((t) => t.lane)
        .sort(),
    ).toEqual(["chat", "work"]);
    team.release("tltask_c1");
    team.release("tltask_w1");
    await until(() => team.started.includes("tltask_w2"));
    team.release("tltask_w2");
    stop.abort();
    await running;
  });

  it("runs work jobs of different workspaces side by side", async () => {
    const { api, sessions, queue } = fakeApi();
    const team = gatedTeam();
    const e = engine(api, { heartbeatMs: 60_000, teamExecutor: () => team.executor });
    await e.register();
    await e.attach(wsA, A1, "a", "resume");
    await e.attach(wsB, A2, "b", "resume");
    queue.set(sessions.get(`cc:${A1}`)!, [
      { taskId: "tltask_a", title: "a", content: job("work", 1), taskType: "team" },
    ]);
    queue.set(sessions.get(`cc:${A2}`)!, [
      { taskId: "tltask_b", title: "b", content: job("work", 2), taskType: "team" },
    ]);
    const stop = new AbortController();
    const running = e.run(stop.signal);
    await until(() => team.started.length === 2);
    team.release("tltask_a");
    team.release("tltask_b");
    stop.abort();
    await running;
  });

  it("runs at most three chat jobs at once, one per chat, oldest first", async () => {
    const { api, sessions, queue } = fakeApi();
    const team = gatedTeam();
    const e = engine(api, { heartbeatMs: 60_000, teamExecutor: () => team.executor });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    queue.set(sessions.get(`cc:${A1}`)!, [
      { taskId: "tltask_a1", title: "", content: job("chat", 1), taskType: "team" },
      { taskId: "tltask_a2", title: "", content: job("chat", 1), taskType: "team" },
      { taskId: "tltask_b1", title: "", content: job("chat", 2), taskType: "team" },
      { taskId: "tltask_c1", title: "", content: job("chat", 3), taskType: "team" },
      { taskId: "tltask_d1", title: "", content: job("chat", 4), taskType: "team" },
    ]);
    const stop = new AbortController();
    const running = e.run(stop.signal);
    await until(() => team.started.length === 3);
    await new Promise((r) => setTimeout(r, 60));
    expect(team.started).toEqual(["tltask_a1", "tltask_b1", "tltask_c1"]);
    // A slot frees: the next of chat 1 (FIFO) or chat 4 may start, never a2 before a1 ends.
    team.release("tltask_a1");
    await until(() => team.started.length === 4);
    expect(team.started[3]).toMatch(/tltask_(a2|d1)/);
    await until(() => team.started.length === 4);
    for (const id of ["tltask_a2", "tltask_b1", "tltask_c1", "tltask_d1"]) team.release(id);
    await until(() => team.started.length === 5);
    team.release("tltask_a2");
    team.release("tltask_d1");
    stop.abort();
    await running;
    expect(api.claim).toHaveBeenCalledTimes(5);
  });

  it("deliverOnce still delivers and waits, as before 0.11", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api);
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    await e.attach(wsA, A2, "two", "resume");
    queue.set(sessions.get(`cc:${A1}`)!, [{ taskId: "tltask_1", title: "x", content: "y" }]);
    queue.set(sessions.get(`cc:${A2}`)!, [{ taskId: "tltask_2", title: "x", content: "y" }]);
    // Two ordinary tasks in one workspace: one after the other, both delivered.
    expect(await e.deliverOnce()).toBe(2);
    expect(api.complete).toHaveBeenCalledTimes(2);
  });
});

describe("wake long-poll (§3.2)", () => {
  it("claims a task well within 1.5 s of the server saying one is queued", async () => {
    const { api, sessions, queue } = fakeApi();
    const team = gatedTeam();
    let wakeUp: (v: { pending: number }) => void = () => {};
    const wake = vi.fn(
      (wait: number) =>
        new Promise<{ pending: number }>((r) => {
          expect(wait).toBeLessThanOrEqual(25);
          wakeUp = r;
        }),
    );
    // The idle back-off alone would take 60 s here.
    const e = engine({ ...api, wake } as never, {
      heartbeatMs: 60_000,
      teamExecutor: () => team.executor,
      backoff: { minMs: 60_000, maxMs: 60_000, factor: 2, jitter: 0 },
      sleep: (ms: number, signal: AbortSignal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        }),
    });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    const stop = new AbortController();
    const running = e.run(stop.signal);
    await until(() => wake.mock.calls.length === 1);
    queue.set(sessions.get(`cc:${A1}`)!, [
      { taskId: "tltask_chat", title: "hi", content: job("chat", 1), taskType: "team" },
    ]);
    const posted = Date.now();
    wakeUp({ pending: 1 });
    await until(() => team.started.includes("tltask_chat"), 1_500);
    expect(Date.now() - posted).toBeLessThan(1_500);
    // Idle again: one wake in flight, not more.
    await until(() => wake.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(wake).toHaveBeenCalledTimes(2);
    team.release("tltask_chat");
    stop.abort();
    await running;
  });

  it("falls back to the idle back-off when the server has no wake endpoint", async () => {
    const { api } = fakeApi();
    const wake = vi.fn(async () => {
      throw new ApiError(404, "not_found");
    });
    const sleeps: number[] = [];
    const stop = new AbortController();
    const e = engine({ ...api, wake } as never, {
      heartbeatMs: 60_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        if (sleeps.length >= 4) stop.abort();
      },
    });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    await e.run(stop.signal);
    // Asked once, then remembered as unsupported: the back-off takes over.
    expect(wake).toHaveBeenCalledTimes(1);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("never spins when the server says work is queued that this Runtime cannot claim", async () => {
    const { api } = fakeApi();
    const wake = vi.fn(async () => ({ pending: 1 }));
    const sleeps: number[] = [];
    const stop = new AbortController();
    const e = engine({ ...api, wake } as never, {
      heartbeatMs: 60_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        if (sleeps.length >= 3) stop.abort();
      },
    });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    await e.run(stop.signal);
    // Every "pending" with nothing claimable is followed by a real back-off.
    expect(wake.mock.calls.length).toBeLessThanOrEqual(sleeps.length + 1);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });
});
