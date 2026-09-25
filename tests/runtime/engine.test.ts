import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationBinding, ProviderAdapter } from "../../runtime/src/adapters/types.ts";
import { ApiError, type RuntimeView } from "../../runtime/src/api.ts";
import { ACTIVITY_LIMIT, RuntimeEngine, type EngineEvent } from "../../runtime/src/engine.ts";
import type { Executor } from "../../runtime/src/executor.ts";
import { loadWorkspaceState, saveWorkspaceState } from "../../runtime/src/state.ts";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const B1 = "33333333-3333-4333-8333-333333333333";

let dir: string;
let wsA: string;
let wsB: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-engine-"));
  wsA = join(dir, "ThreadLink");
  wsB = join(dir, "Nova");
  mkdirSync(wsA);
  mkdirSync(wsB);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runtimeView = (over: Partial<RuntimeView> = {}): RuntimeView => ({
  runtimeId: "tlrun_00000000000000000000000000000001",
  label: "Joel's Laptop",
  platform: "windows",
  kind: "desktop",
  paused: false,
  restartRequestedAt: null,
  settings: { autoStart: true, autoReconnect: true, notifications: true },
  status: "active",
  ...over,
});

function fakeApi() {
  let n = 0;
  const sessions = new Map<string, string>(); // localBindingRef -> tlses_
  const queue = new Map<string, { taskId: string; title: string; content: string }[]>();
  const api = {
    registerRuntime: vi.fn(async () => runtimeView()),
    runtimeHeartbeat: vi.fn(async (input: { busySessionIds: string[] }) => {
      void input;
      return runtimeView();
    }),
    upsertWorkspace: vi.fn(async (i: { workspaceKey: string }) => ({
      workspaceId: `tlwsp_${i.workspaceKey.slice(0, 32)}`,
    })),
    registerConversation: vi.fn(async (i: { localBindingRef: string }) => {
      if (!sessions.has(i.localBindingRef))
        sessions.set(i.localBindingRef, `tlses_${String(++n).padStart(32, "0")}`);
      return { sessionId: sessions.get(i.localBindingRef)!, created: true };
    }),
    links: vi.fn(async (sessionId: string) => {
      void sessionId;
      return [];
    }),
    runtimeLinks: vi.fn(async (): Promise<unknown[]> => []),
    approvePairing: vi.fn(async (_s: string, linkId: string) => ({ linkId, status: "active" })),
    declinePairing: vi.fn(async () => ({})),
    inbox: vi.fn(async (sessionId: string) =>
      (queue.get(sessionId) ?? []).map((t) => ({ ...t, priority: "C", status: "queued" })),
    ),
    // Answer with the task that was actually queued: a claim that invents a
    // title hides whether the real one is carried through.
    claim: vi.fn(async (taskId: string) => {
      const queued = [...queue.values()].flat().find((t) => t.taskId === taskId);
      return {
        taskId,
        title: queued?.title ?? "t",
        content: queued?.content ?? "c",
        priority: "C",
        status: "claimed",
      };
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
  };
  return { api, sessions, queue };
}

function fakeAdapter(running: Set<string> = new Set()) {
  const executed: { workspace: string; binding: ConversationBinding }[] = [];
  const adapter: ProviderAdapter = {
    id: "claude-code",
    displayName: "Claude Code",
    detect: async () => ({ available: true, version: "2.1.266" }),
    capabilities: () => ({ "claude-code": "available", "claude-resume": "available" }),
    supports: () => ({
      supportsExactResume: true,
      supportsFork: true,
      supportsBackgroundWorker: true,
      supportsBusyDetection: true,
    }),
    discoverWorkspaces: async () => [],
    discoverConversations: async (workspace) => [
      { nativeSessionId: A1, title: "Dashboard redesign", lastUsedAt: new Date(), workspace },
    ],
    conversationExists: async (_w, id) => [A1, A2, B1].includes(id),
    runningConversationIds: async () => running,
    createExecutor: (workspace, binding): Executor => ({
      name: "fake",
      execute: async (task) => {
        executed.push({ workspace, binding });
        return {
          ok: true,
          result: `${binding.mode === "resume" ? binding.nativeSessionId : "fresh"}:${task.content}`,
          artifacts: [],
        };
      },
    }),
  };
  return { adapter, executed };
}

function engine(api: ReturnType<typeof fakeApi>["api"], adapter: ProviderAdapter, extra = {}) {
  return new RuntimeEngine({
    api: api as never,
    configDir: join(dir, "cfg"),
    adapters: [adapter],
    identity: { label: "Joel's Laptop", platform: "windows", kind: "desktop" },
    version: "0.6.6",
    repo: async () => ({
      remote: "github.com/dars2307/threadlink",
      fingerprint: "a".repeat(64),
      branch: "main",
    }),
    taskHeartbeatMs: 60_000,
    ...extra,
  });
}

describe("ThreadLink Runtime engine", () => {
  it("one Runtime handles multiple workspaces and multiple conversations per workspace", async () => {
    const { api, sessions, queue } = fakeApi();
    const { adapter, executed } = fakeAdapter();
    const e = engine(api, adapter);
    await e.register();
    await e.attach(wsA, A1, "Dashboard redesign", "resume");
    await e.attach(wsA, A2, "Security review", "resume");
    await e.attach(wsB, B1, "Nova implementation", "resume");

    const snap = e.snapshot();
    expect(snap.workspaces.map((w) => w.name).sort()).toEqual(["Nova", "ThreadLink"]);
    expect(
      snap.workspaces.find((w) => w.name === "ThreadLink")!.conversations.map((c) => c.title),
    ).toEqual(["Dashboard redesign", "Security review"]);
    expect(new Set(sessions.values()).size).toBe(3); // three distinct tlses_

    // One task for each conversation in the same workspace goes to exactly that conversation.
    const sA1 = sessions.get(`cc:${A1}`)!;
    const sA2 = sessions.get(`cc:${A2}`)!;
    queue.set(sA1, [{ taskId: "tltask_1", title: "a1", content: "x" }]);
    queue.set(sA2, [{ taskId: "tltask_2", title: "a2", content: "y" }]);
    expect(await e.deliverOnce()).toBe(2);
    expect(executed).toEqual([
      { workspace: wsA, binding: { mode: "resume", nativeSessionId: A1 } },
      { workspace: wsA, binding: { mode: "resume", nativeSessionId: A2 } },
    ]);
    // The executor echoes the conversation it ran in and the task's own
    // content, so this also shows each task reached the right conversation.
    expect(api.complete).toHaveBeenCalledWith("tltask_1", sA1, expect.any(String), `${A1}:x`, []);
    expect(api.complete).toHaveBeenCalledWith("tltask_2", sA2, expect.any(String), `${A2}:y`, []);
  });

  it("a restarted Runtime keeps its workspaces, conversations and ThreadLink sessions", async () => {
    const { api, sessions } = fakeApi();
    const first = engine(api, fakeAdapter().adapter);
    await first.register();
    await first.attach(wsA, A1, "Dashboard redesign", "resume");
    const before = first.snapshot().workspaces[0]!.conversations[0]!.sessionId;

    const second = engine(api, fakeAdapter().adapter); // new process, same config dir
    await second.register();
    await second.sync();
    const after = second.snapshot().workspaces[0]!.conversations[0]!;
    expect(after.sessionId).toBe(before);
    expect(after.title).toBe("Dashboard redesign");
    expect(sessions.size).toBe(1);
  });

  it("reports busy conversations in the heartbeat", async () => {
    const { api, sessions } = fakeApi();
    const e = engine(api, fakeAdapter(new Set([A2])).adapter);
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    await e.attach(wsA, A2, "two", "resume");
    await e.heartbeat();
    expect(api.runtimeHeartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ busySessionIds: [sessions.get(`cc:${A2}`)] }),
    );
    expect(e.snapshot().workspaces[0]!.conversations.map((c) => c.busy)).toEqual([false, true]);
  });

  it("refuses to attach a conversation that does not exist in the workspace", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    await expect(e.attach(wsA, "99999999-9999-4999-8999-999999999999", null)).rejects.toThrow();
  });

  it("reconnects after network loss, and pauses/restarts on instruction from ThreadLink", async () => {
    const { api } = fakeApi();
    let beats = 0;
    api.runtimeHeartbeat.mockImplementation(async () => {
      beats++;
      if (beats === 2 || beats === 3) throw new ApiError(0, "network");
      if (beats === 5)
        return runtimeView({ paused: true, restartRequestedAt: "2026-09-22T12:00:00Z" });
      return runtimeView();
    });
    const events: EngineEvent[] = [];
    const statuses: string[] = [];
    const stop = new AbortController();
    const e = engine(api, fakeAdapter().adapter, {
      heartbeatMs: 0,
      sleep: async () => {
        if (beats >= 7) stop.abort();
      },
    });
    e.on((ev) => {
      events.push(ev);
      if (ev.type === "snapshot" && statuses.at(-1) !== ev.snapshot.status)
        statuses.push(ev.snapshot.status);
    });
    await e.attach(wsA, A1, "one", "resume");
    const result = await e.run(stop.signal);
    expect(result).toBe("stopped");
    expect(statuses).toEqual(expect.arrayContaining(["online", "offline", "paused"]));
    expect(statuses.indexOf("offline")).toBeLessThan(statuses.lastIndexOf("online"));
    expect(events.filter((ev) => ev.type === "restart-requested")).toHaveLength(1);
  });

  it("does not claim while paused", async () => {
    const { api, sessions, queue } = fakeApi();
    api.runtimeHeartbeat.mockResolvedValue(runtimeView({ paused: true }));
    const stop = new AbortController();
    const e = engine(api, fakeAdapter().adapter, { sleep: async () => stop.abort() });
    await e.register();
    await e.attach(wsA, A1, "one", "resume");
    queue.set(sessions.get(`cc:${A1}`)!, [{ taskId: "tltask_1", title: "x", content: "y" }]);
    await e.run(stop.signal);
    expect(api.claim).not.toHaveBeenCalled();
  });

  it("stops on a revoked Runtime (403) and on a rejected credential (401)", async () => {
    for (const [status, expected] of [
      [403, "revoked"],
      [401, "signed-out"],
    ] as const) {
      const { api } = fakeApi();
      api.registerRuntime.mockRejectedValue(new ApiError(status, "x"));
      const e = engine(api, fakeAdapter().adapter, { sleep: async () => {} });
      expect(await e.run(new AbortController().signal)).toBe(expected);
    }
  });

  it("only one Runtime engine runs per machine (CLI and desktop share the lock)", async () => {
    const { api } = fakeApi();
    const stop = new AbortController();
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => (release = r));
    const first = engine(api, fakeAdapter().adapter, { sleep: () => blocked });
    const running = first.run(stop.signal);
    await new Promise((r) => setTimeout(r, 50));
    const second = engine(api, fakeAdapter().adapter);
    expect(await second.run(new AbortController().signal)).toBe("stopped");
    expect(second.snapshot().detail).toMatch(/already running/);
    stop.abort();
    release();
    await running;
  });

  it("surfaces link requests and approves them for the exact conversation", async () => {
    const { api, sessions } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    await e.attach(wsA, A1, "Dashboard redesign", "resume");
    const sid = sessions.get(`cc:${A1}`)!;
    api.runtimeLinks.mockResolvedValue([
      {
        linkId: "tllnk_1",
        status: "pending",
        paused: false,
        agentSessionId: sid,
        controllerDisplayName: "Phase 6.6 planning",
        requestedAt: new Date().toISOString(),
        approvedAt: null,
        conversation: {
          displayName: "Dashboard redesign",
          localBindingRef: `cc:${A1}`,
          provider: "claude-code",
          mode: "resume",
          nativeSessionId: A1,
          workspaceId: "tlwsp_1",
          workspaceName: "A",
          workspacePath: wsA,
        },
      },
    ]);
    const seen: EngineEvent[] = [];
    e.on((ev) => ev.type === "link-request" && seen.push(ev));
    const pending = await e.refreshPendingLinks();
    expect(pending).toEqual([
      {
        linkId: "tllnk_1",
        sessionId: sid,
        from: "Phase 6.6 planning",
        conversation: "Dashboard redesign",
        attached: true,
        reattach: null,
      },
    ]);
    expect(seen).toHaveLength(1);
    await e.approveLink("tllnk_1");
    expect(api.approvePairing).toHaveBeenCalledWith(sid, "tllnk_1");
  });

  it("finds a request for a conversation this computer has detached, and offers it back", async () => {
    // The dead end this replaced: detaching hid the request from the only
    // place it could be answered.
    const { api, sessions } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    await e.attach(wsA, A1, "Dashboard redesign", "resume");
    const sid = sessions.get(`cc:${A1}`)!;
    api.runtimeLinks.mockResolvedValue([
      {
        linkId: "tllnk_1",
        status: "pending",
        paused: false,
        agentSessionId: sid,
        controllerDisplayName: "ChatGPT",
        requestedAt: new Date().toISOString(),
        approvedAt: null,
        conversation: {
          displayName: "Dashboard redesign",
          localBindingRef: `cc:${A1}`,
          provider: "claude-code",
          mode: "resume",
          nativeSessionId: A1,
          workspaceId: "tlwsp_1",
          workspaceName: "A",
          workspacePath: wsA,
        },
      },
    ]);

    await e.detach(wsA, `cc:${A1}`);
    const afterDetach = await e.refreshPendingLinks();
    expect(afterDetach).toHaveLength(1);
    expect(afterDetach[0]).toMatchObject({ attached: false });
    expect(afterDetach[0]?.reattach).toMatchObject({ nativeSessionId: A1, workspacePath: wsA });

    // It must not be approved behind the user's back.
    await expect(e.approveLink("tllnk_1")).rejects.toThrow(/Attach .* again before approving/);
    expect(api.approvePairing).not.toHaveBeenCalled();

    // Attaching it again restores the ability to approve, on the same session.
    const back = await e.attachForLink("tllnk_1");
    expect(back).toMatchObject({ attached: true, sessionId: sid });
    await e.approveLink("tllnk_1");
    expect(api.approvePairing).toHaveBeenCalledWith(sid, "tllnk_1");

    // Declining never needed the conversation back in the first place.
    expect(api.declinePairing).not.toHaveBeenCalled();
  });

  it("lets the user decline a request whose conversation is detached", async () => {
    const { api, sessions } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    await e.attach(wsA, A1, "Dashboard redesign", "resume");
    const sid = sessions.get(`cc:${A1}`)!;
    api.runtimeLinks.mockResolvedValue([
      {
        linkId: "tllnk_2",
        status: "pending",
        paused: false,
        agentSessionId: sid,
        controllerDisplayName: "ChatGPT",
        requestedAt: new Date().toISOString(),
        approvedAt: null,
        conversation: {
          displayName: "Dashboard redesign",
          localBindingRef: `cc:${A1}`,
          provider: "claude-code",
          mode: "resume",
          nativeSessionId: A1,
          workspaceId: "tlwsp_1",
          workspaceName: "A",
          workspacePath: wsA,
        },
      },
    ]);
    await e.detach(wsA, `cc:${A1}`);
    await e.refreshPendingLinks();
    await e.declineLink("tllnk_2");
    expect(api.declinePairing).toHaveBeenCalledWith(sid, "tllnk_2");
  });
});

describe("when ThreadLink cannot be reached", () => {
  it("stops on an address that is not ThreadLink, instead of retrying forever", async () => {
    const { api } = fakeApi();
    // An old deployment serving its not-found page: retrying cannot fix it.
    api.registerRuntime.mockRejectedValue(new ApiError(200, "not-threadlink"));
    const e = engine(api, fakeAdapter().adapter, {
      sleep: async () => {},
      baseUrlLabel: "threadlink-iz4qemadi-ash-murrays-projects.vercel.app",
    });
    expect(await e.run(new AbortController().signal)).toBe("wrong-address");
    const snap = e.snapshot();
    expect(snap.needsAttention).toBe(true);
    expect(snap.detail).toMatch(/threadlink-iz4qemadi.*is not answering as ThreadLink/);
  });

  it("keeps retrying a network outage but asks for help once it drags on", async () => {
    const { api } = fakeApi();
    api.registerRuntime.mockRejectedValue(new ApiError(0, "network"));
    const stop = new AbortController();
    const e = engine(api, fakeAdapter().adapter, { sleep: async () => {} });
    const seen: { attention: boolean; detail: string | null }[] = [];
    e.on((event) => {
      if (event.type === "snapshot" && event.snapshot.status === "offline") {
        seen.push({ attention: event.snapshot.needsAttention, detail: event.snapshot.detail });
        if (event.snapshot.needsAttention) stop.abort();
      }
    });
    await e.run(stop.signal);
    // It keeps trying (never terminates on its own) but eventually says so.
    expect(seen[0]).toMatchObject({
      attention: false,
      detail: "Can't reach ThreadLink. Retrying…",
    });
    expect(seen.at(-1)?.attention).toBe(true);
    expect(seen.at(-1)?.detail).toMatch(/Still can't reach ThreadLink/);
  });
});

describe("changing how an attached conversation runs", () => {
  /**
   * The point of this operation: a link that was set up as an exact
   * conversation can become a background worker without the user redoing the
   * device setup, and without losing the ChatGPT link that points at it.
   */
  it("keeps the same ThreadLink session, so the link survives the switch", async () => {
    const { api, sessions } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "resume");
    const before = sessions.get(attached.localBindingRef)!;

    const after = await e.setConversationMode(wsA, attached.localBindingRef, "worker");

    expect(after.mode).toBe("worker");
    expect(after.localBindingRef).toBe(attached.localBindingRef);
    expect(sessions.get(after.localBindingRef)).toBe(before);
    expect(new Set(sessions.values()).size).toBe(1);
    // The server was told the new mode under the existing binding reference.
    expect(api.registerConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({ localBindingRef: attached.localBindingRef, mode: "worker" }),
    );
  });

  it("keeps the user's own Claude conversation, so switching back resumes it", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "resume");

    await e.setConversationMode(wsA, attached.localBindingRef, "worker");
    const back = await e.setConversationMode(wsA, attached.localBindingRef, "resume");

    expect(back.mode).toBe("resume");
    expect(back.nativeSessionId).toBe(A1);
  });

  it("survives a restart: the new mode is what was written down", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "resume");
    await e.setConversationMode(wsA, attached.localBindingRef, "worker");

    const restarted = engine(api, fakeAdapter().adapter);
    await restarted.register();
    await restarted.sync();
    const conv = restarted
      .snapshot()
      .workspaces.flatMap((w) => w.conversations)
      .find((c) => c.localBindingRef === attached.localBindingRef);
    expect(conv?.mode).toBe("worker");
  });

  it("does nothing when the mode is already what was asked for", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    const calls = api.registerConversation.mock.calls.length;

    const same = await e.setConversationMode(wsA, attached.localBindingRef, "worker");

    expect(same.mode).toBe("worker");
    expect(api.registerConversation.mock.calls.length).toBe(calls);
  });

  it("refuses background mode on a provider that cannot do it, instead of falling back", async () => {
    const { api } = fakeApi();
    const { adapter } = fakeAdapter();
    const limited: ProviderAdapter = {
      ...adapter,
      supports: () => ({
        supportsExactResume: true,
        supportsFork: false,
        supportsBackgroundWorker: false,
        supportsBusyDetection: true,
      }),
    };
    const e = engine(api, limited);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "resume");

    await expect(e.setConversationMode(wsA, attached.localBindingRef, "worker")).rejects.toThrow(
      /background/i,
    );
    // And it really did not change: no silent fallback either way.
    expect(
      e
        .snapshot()
        .workspaces.flatMap((w) => w.conversations)
        .find((c) => c.localBindingRef === attached.localBindingRef)?.mode,
    ).toBe("resume");
  });

  it("drops the worker conversation when switching back to exact mode", async () => {
    // The server rejects a worker conversation id on a non-worker binding, so
    // a switch back that kept it would fail with a constraint error. This is
    // the path a user takes after a worker has actually run at least once.
    const { api } = fakeApi();
    const cfg = join(dir, "cfg");
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");

    // Stand in for a worker run having happened.
    const ws = await loadWorkspaceState(cfg, wsA);
    ws.conversations.find(
      (c) => c.localBindingRef === attached.localBindingRef,
    )!.workerNativeSessionId = "99999999-9999-4999-8999-999999999999";
    await saveWorkspaceState(cfg, ws);

    const restarted = engine(api, fakeAdapter().adapter);
    await restarted.register();
    await restarted.sync();
    expect(api.registerConversation.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "worker",
      workerNativeSessionId: "99999999-9999-4999-8999-999999999999",
    });

    await restarted.setConversationMode(wsA, attached.localBindingRef, "resume");

    expect(api.registerConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        localBindingRef: attached.localBindingRef,
        mode: "resume",
        workerNativeSessionId: null,
      }),
    );
    const after = await loadWorkspaceState(cfg, wsA);
    expect(
      after.conversations.find((c) => c.localBindingRef === attached.localBindingRef)
        ?.workerNativeSessionId ?? null,
    ).toBeNull();
  });

  it("refuses a binding that has no conversation to run", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const fresh = await e.attach(wsA, null, null);

    await expect(e.setConversationMode(wsA, fresh.localBindingRef, "worker")).rejects.toThrow();
  });

  it("refuses a conversation that is not attached here", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    await e.attach(wsA, A1, "Bootstrap", "resume");

    await expect(e.setConversationMode(wsA, "cc:nope", "worker")).rejects.toThrow();
  });
});

describe("what counts as 'in use'", () => {
  it("an open Claude conversation blocks only the exact-mode binding", async () => {
    const { api } = fakeApi();
    // The user's own conversation A1 is open in Claude Code right now.
    const { adapter } = fakeAdapter(new Set([A1]));
    const e = engine(api, adapter);
    await e.register();
    const exact = await e.attach(wsA, A1, "Bootstrap", "resume");
    const worker = await e.attach(wsA, A1, "Bootstrap", "worker");
    await e.heartbeat();

    const conversations = e.snapshot().workspaces.flatMap((w) => w.conversations);
    const busyOf = (ref: string) => conversations.find((c) => c.localBindingRef === ref)?.busy;
    expect(busyOf(exact.localBindingRef)).toBe(true);
    expect(busyOf(worker.localBindingRef)).toBe(false);
  });

  it("does not report a background worker as busy to ThreadLink", async () => {
    const { api, sessions } = fakeApi();
    const { adapter } = fakeAdapter(new Set([A1]));
    const e = engine(api, adapter);
    await e.register();
    const worker = await e.attach(wsA, A1, "Bootstrap", "worker");
    await e.heartbeat();

    // The web dashboard reads this; reporting it busy is what made a worker
    // link say "Claude conversation in use" while working perfectly.
    const call = api.runtimeHeartbeat.mock.calls.at(-1)?.[0] as { busySessionIds: string[] };
    expect(call.busySessionIds).not.toContain(sessions.get(worker.localBindingRef));
    expect(call.busySessionIds).toEqual([]);
  });
});

describe("mirroring background work back to the user", () => {
  /**
   * Claude Code has no supported way to write into a conversation the user has
   * open, and ThreadLink deliberately forks so their transcript is untouched.
   * The mirror is how they can still follow along -- so it has to say enough to
   * be useful and nothing that belongs to the conversation itself.
   */
  const activityOf = (e: RuntimeEngine) => {
    const seen: EngineEvent[] = [];
    e.on((event) => seen.push(event));
    return () =>
      seen
        .filter((x) => x.type === "activity")
        .map((x) => (x as Extract<EngineEvent, { type: "activity" }>).activity);
  };

  it("mirrors a background task from start to finish", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    const activity = activityOf(e);
    queue.set(sessions.get(attached.localBindingRef)!, [
      { taskId: "tltask_1", title: "Phase 6.8", content: "secret prompt" },
    ]);

    await e.deliverOnce();

    const entries = activity();
    expect(entries.map((x) => x.event)).toEqual(["task_started", "task_completed"]);
    expect(entries[0]).toMatchObject({
      title: "Phase 6.8",
      conversation: "Bootstrap",
      mode: "worker",
      localBindingRef: attached.localBindingRef,
    });
    expect(entries[0]!.at).toBeTruthy();
  });

  it("never carries the prompt, the result or a diff", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    const activity = activityOf(e);
    queue.set(sessions.get(attached.localBindingRef)!, [
      {
        taskId: "tltask_1",
        title: "Phase 6.8",
        content: "export const API_KEY = 'sk-live-must-never-appear'",
      },
    ]);

    await e.deliverOnce();

    const text = JSON.stringify(activity());
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("export const");
  });

  it("explains a failure without quoting the agent's error", async () => {
    const { api, sessions, queue } = fakeApi();
    const { adapter } = fakeAdapter();
    const failing: ProviderAdapter = {
      ...adapter,
      createExecutor: () => ({
        name: "fake",
        execute: async () => ({
          ok: false as const,
          reason: "background_mode_unsupported" as const,
          error: "raw error quoting /home/secret/path and the prompt",
        }),
      }),
    };
    const e = engine(api, failing);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    const activity = activityOf(e);
    queue.set(sessions.get(attached.localBindingRef)!, [
      { taskId: "tltask_1", title: "Phase 6.8", content: "x" },
    ]);

    await e.deliverOnce();

    const entries = activity();
    expect(entries.at(-1)).toMatchObject({
      event: "task_failed",
      detail: "This agent cannot work in the background.",
    });
    expect(JSON.stringify(entries)).not.toContain("/home/secret/path");
  });

  it("says which conversation the work belongs to, and how it ran", async () => {
    // Two conversations in the same workspace, one exact and one background:
    // a feed that cannot tell them apart is not worth having.
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const worker = await e.attach(wsA, A1, "Bootstrap", "worker");
    const exact = await e.attach(wsA, A2, "Security review", "resume");
    const activity = activityOf(e);
    queue.set(sessions.get(worker.localBindingRef)!, [
      { taskId: "tltask_1", title: "one", content: "x" },
    ]);
    queue.set(sessions.get(exact.localBindingRef)!, [
      { taskId: "tltask_2", title: "two", content: "y" },
    ]);

    await e.deliverOnce();

    const entries = activity();
    const byTitle = (t: string) => entries.filter((x) => x.title === t);
    expect(byTitle("one")[0]).toMatchObject({ conversation: "Bootstrap", mode: "worker" });
    expect(byTitle("two")[0]).toMatchObject({ conversation: "Security review", mode: "resume" });
    expect(entries.every((x) => x.workspace === "ThreadLink")).toBe(true);
  });
});

describe("the mirror as a feed the app can read", () => {
  const queueFor = (
    api: ReturnType<typeof fakeApi>["api"],
    sessions: Map<string, string>,
    queue: Map<string, { taskId: string; title: string; content: string }[]>,
    ref: string,
    tasks: { taskId: string; title: string; content: string }[],
  ) => {
    void api;
    queue.set(sessions.get(ref)!, tasks);
  };

  it("keeps the mirrored lines in the snapshot, newest first", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");

    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_1", title: "First", content: "x" },
    ]);
    await e.deliverOnce();
    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_2", title: "Second", content: "y" },
    ]);
    await e.deliverOnce();

    const activity = e.snapshot().activity;
    expect(activity.map((a) => `${a.title}:${a.event}`)).toEqual([
      "Second:task_completed",
      "Second:task_started",
      "First:task_completed",
      "First:task_started",
    ]);
  });

  it("mirrors a milestone once, however many times it is reported", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_1", title: "Once", content: "x" },
    ]);

    await e.deliverOnce();
    // The same task offered again (a retry, a duplicate snapshot) adds nothing.
    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_1", title: "Once", content: "x" },
    ]);
    await e.deliverOnce();

    expect(e.snapshot().activity.filter((a) => a.event === "task_completed")).toHaveLength(1);
  });

  it("does not grow without limit", async () => {
    const { api, sessions, queue } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    for (let i = 0; i < ACTIVITY_LIMIT; i++) {
      queueFor(api, sessions, queue, attached.localBindingRef, [
        { taskId: `tltask_${i}`, title: `T${i}`, content: "x" },
      ]);
      await e.deliverOnce();
    }
    expect(e.snapshot().activity).toHaveLength(ACTIVITY_LIMIT);
    expect(e.snapshot().activity[0]!.title).toBe(`T${ACTIVITY_LIMIT - 1}`);
  });

  it("carries a safe one-line summary of what came back", async () => {
    const { api, sessions, queue } = fakeApi();
    const { adapter } = fakeAdapter();
    const talkative: ProviderAdapter = {
      ...adapter,
      createExecutor: () => ({
        name: "fake",
        execute: async () => ({
          ok: true as const,
          result:
            "Added the activity feed.\n\n```ts\nconst KEY = 'sk-live-abcdefghijklmnop';\n```\n",
          artifacts: [],
        }),
      }),
    };
    const e = engine(api, talkative);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_1", title: "Feed", content: "x" },
    ]);

    await e.deliverOnce();

    const done = e.snapshot().activity.find((a) => a.event === "task_completed")!;
    expect(done.summary).toBe("Added the activity feed.");
    expect(JSON.stringify(e.snapshot().activity)).not.toContain("sk-live");
  });

  it("reports a task that is waiting on a person as blocked, not failed", async () => {
    const { api, sessions, queue } = fakeApi();
    const { adapter } = fakeAdapter();
    const waiting: ProviderAdapter = {
      ...adapter,
      createExecutor: () => ({
        name: "fake",
        execute: async () => ({
          ok: false as const,
          error: "Claude requested permissions to edit src/index.ts, but you have not granted it.",
          blocked: "approval_required" as const,
        }),
      }),
    };
    const e = engine(api, waiting);
    await e.register();
    const attached = await e.attach(wsA, A1, "Bootstrap", "worker");
    const session = sessions.get(attached.localBindingRef)!;
    queueFor(api, sessions, queue, attached.localBindingRef, [
      { taskId: "tltask_1", title: "Needs you", content: "x" },
    ]);

    await e.deliverOnce();

    // Reported to ThreadLink as blocked; the claim is deliberately not dropped.
    expect(api.blocked).toHaveBeenCalledWith(
      "tltask_1",
      session,
      expect.any(String),
      "approval_required",
    );
    expect(api.fail).not.toHaveBeenCalled();
    const entry = e.snapshot().activity.find((a) => a.event === "task_blocked")!;
    expect(entry).toMatchObject({
      blocked: "approval_required",
      detail: "Claude needs your permission to continue.",
    });
    // The agent's own words can name files and quote the prompt.
    expect(JSON.stringify(e.snapshot().activity)).not.toContain("src/index.ts");
  });
});

describe("routing a Team Mode job", () => {
  const teamJob = JSON.stringify({ kind: "threadlink.team_job", version: 1 });

  it("sends a task the server marked as a team job to Team Mode", async () => {
    const { api, sessions, queue } = fakeApi();
    const { adapter, executed } = fakeAdapter();
    const teamRan: string[] = [];
    const e = engine(api, adapter, {
      teamExecutor: () => ({
        name: "team",
        execute: async (task: { taskId: string }) => {
          teamRan.push(task.taskId);
          return { ok: true as const, result: "Team result: PASS", artifacts: [] };
        },
      }),
    });
    await e.register();
    const attached = await e.attach(wsA, A1, "Prism", "worker");
    const session = sessions.get(attached.localBindingRef)!;
    queue.set(session, [{ taskId: "tltask_team", title: "Build reports", content: teamJob }]);
    api.claim.mockImplementationOnce(async (taskId: string) => ({
      taskId,
      taskType: "team",
      title: "Build reports",
      content: teamJob,
      priority: "C",
      status: "claimed",
    }));

    await e.deliverOnce();

    expect(teamRan).toEqual(["tltask_team"]);
    // The conversation's own executor was not used for it.
    expect(executed).toHaveLength(0);
    expect(api.complete).toHaveBeenCalledWith(
      "tltask_team",
      session,
      expect.any(String),
      "Team result: PASS",
      [],
    );
  });

  it("does not treat an ordinary task as a team job because of what its text says", async () => {
    // A controller can put anything in a task's content. Only the server's
    // task type decides, so shaped text cannot start a team run.
    const { api, sessions, queue } = fakeApi();
    const { adapter, executed } = fakeAdapter();
    const teamRan: string[] = [];
    const e = engine(api, adapter, {
      teamExecutor: () => ({
        name: "team",
        execute: async (task: { taskId: string }) => {
          teamRan.push(task.taskId);
          return { ok: true as const, result: "x", artifacts: [] };
        },
      }),
    });
    await e.register();
    const attached = await e.attach(wsA, A1, "Prism", "worker");
    queue.set(sessions.get(attached.localBindingRef)!, [
      { taskId: "tltask_plain", title: "Looks like a team job", content: teamJob },
    ]);

    await e.deliverOnce();

    expect(teamRan).toEqual([]);
    expect(executed).toHaveLength(1);
  });
});

describe("telling ThreadLink which Team Mode agents this computer has", () => {
  const found = [
    {
      provider: "claude-code" as const,
      installed: true,
      executable: "C:\Users\joel\bin\claude.exe",
      version: "2.1.266",
      authenticated: true,
      authMethod: "claude.ai",
      detectedPlan: "max",
      models: [
        {
          id: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          description: null,
          efforts: [],
          defaultEffort: null,
          source: "configured" as const,
        },
      ],
      currentModel: null,
      capabilities: {} as never,
      usage: { remaining: "unknown" as const },
      detail: "free text that stays local",
    },
  ];

  it("reports each agent with only the keys the server accepts", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter, { discoverTeam: async () => found });
    await e.refreshTeamProviders();
    expect(api.reportProviderDetection).toHaveBeenCalledTimes(1);
    const [provider, detected] = api.reportProviderDetection.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(provider).toBe("claude-code");
    expect(Object.keys(detected).sort()).toEqual(
      [
        "authMethod",
        "authenticated",
        "capabilities",
        "currentModel",
        "detectedAt",
        "detectedPlan",
        "installed",
        "models",
        "usage",
        "version",
      ].sort(),
    );
    // The local path and free-text detail never leave this computer.
    expect(JSON.stringify(detected)).not.toContain("claude.exe");
    expect(JSON.stringify(detected)).not.toContain("free text");
  });

  it("shows the agents in the snapshot for the app", async () => {
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter, { discoverTeam: async () => found });
    await e.refreshTeamProviders();
    expect(e.snapshot().teamProviders).toMatchObject([
      {
        provider: "claude-code",
        installed: true,
        authenticated: true,
        detectedPlan: "max",
        remaining: "unknown",
      },
    ]);
  });

  it("does not run discovery unless the app asks for it", async () => {
    // Discovery spawns the real CLIs. An engine built without it must not.
    const { api } = fakeApi();
    const e = engine(api, fakeAdapter().adapter);
    await e.refreshTeamProviders();
    expect(api.reportProviderDetection).not.toHaveBeenCalled();
    expect(e.snapshot().teamProviders).toEqual([]);
  });

  it("keeps working if ThreadLink cannot be told", async () => {
    const { api } = fakeApi();
    api.reportProviderDetection.mockRejectedValue(new Error("offline"));
    const e = engine(api, fakeAdapter().adapter, { discoverTeam: async () => found });
    await expect(e.refreshTeamProviders()).resolves.toHaveLength(1);
  });
});

describe("provider plans and capabilities for the desktop app", () => {
  const claude = {
    provider: "claude-code" as const,
    installed: true,
    executable: "C:\bin\claude.exe",
    version: "2.1.266",
    authenticated: true,
    authMethod: "claude.ai",
    detectedPlan: "max",
    models: [],
    currentModel: null,
    capabilities: {} as never,
    usage: { remaining: "unknown" as const },
  };
  const profiles = [
    {
      provider: "claude-code" as const,
      declaredPlan: "max_5x",
      usagePolicy: "balanced",
      paidUsageEnabled: false,
      detected: {},
      detectedAt: null,
    },
  ];

  it("joins the owner's profiles with what this computer found, Cursor included as detect-only", async () => {
    const { api } = fakeApi();
    const withPlans = { ...api, providerProfiles: vi.fn(async () => profiles) };
    const e = engine(withPlans as never, fakeAdapter().adapter, {
      discoverTeam: async () => [claude],
      detectCursor: () => ({ found: true, command: "agent" as const }),
    });
    await e.refreshTeamProviders();
    const view = await e.getProviderProfiles();
    expect(view.profiles[0]).toMatchObject({
      provider: "claude-code",
      declaredPlan: "max_5x",
      detected: { detectedPlan: "max" },
      capability: { status: "available" },
    });
    expect(view.profiles[1]).toMatchObject({ provider: "codex", declaredPlan: null });
    expect(view.capabilities.find((c) => c.id === "cursor")).toMatchObject({
      status: "not_supported_yet",
      routable: false,
    });
    expect(e.snapshot().providerCapabilities.map((c) => c.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
  });

  it("sets only a known plan for a known provider, and returns what the server stored", async () => {
    const { api } = fakeApi();
    const setDeclaredPlan = vi.fn(async () => ({
      profiles: [{ ...profiles[0]!, declaredPlan: "max_20x" }],
    }));
    const e = engine({ ...api, setDeclaredPlan } as never, fakeAdapter().adapter);
    await expect(e.setProviderPlan("codex", "team")).rejects.toThrow(/plan/);
    await expect(e.setProviderPlan("cursor" as never, "pro")).rejects.toThrow(/provider/);
    expect(setDeclaredPlan).not.toHaveBeenCalled();
    const view = await e.setProviderPlan("claude-code", "max_20x");
    expect(setDeclaredPlan).toHaveBeenCalledWith("claude-code", "max_20x");
    expect(view.profiles[0]!.declaredPlan).toBe("max_20x");
  });
});
