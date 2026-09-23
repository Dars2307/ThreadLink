import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationBinding, ProviderAdapter } from "../../runtime/src/adapters/types.ts";
import { ApiError, type RuntimeView } from "../../runtime/src/api.ts";
import { RuntimeEngine, type EngineEvent } from "../../runtime/src/engine.ts";
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
    claim: vi.fn(async (taskId: string) => ({
      taskId,
      title: "t",
      content: "c",
      priority: "C",
      status: "claimed",
    })),
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
    expect(api.complete).toHaveBeenCalledWith("tltask_1", sA1, expect.any(String), `${A1}:c`, []);
    expect(api.complete).toHaveBeenCalledWith("tltask_2", sA2, expect.any(String), `${A2}:c`, []);
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

    await expect(
      e.setConversationMode(wsA, attached.localBindingRef, "worker"),
    ).rejects.toThrow(/background/i);
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
    ws.conversations.find((c) => c.localBindingRef === attached.localBindingRef)!.
      workerNativeSessionId = "99999999-9999-4999-8999-999999999999";
    await saveWorkspaceState(cfg, ws);

    const restarted = engine(api, fakeAdapter().adapter);
    await restarted.register();
    await restarted.sync();
    expect(
      api.registerConversation.mock.calls.at(-1)?.[0],
    ).toMatchObject({ mode: "worker", workerNativeSessionId: "99999999-9999-4999-8999-999999999999" });

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
