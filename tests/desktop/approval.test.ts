// @vitest-environment happy-dom
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../runtime/src/api.ts";
import { messageFor } from "../../desktop/src/model.ts";
import { RuntimeEngine } from "../../runtime/src/engine.ts";
import type { ProviderAdapter } from "../../runtime/src/adapters/types.ts";
import { saveWorkspaceState, serverWorkspaceKey } from "../../runtime/src/state.ts";

/**
 * The whole Approve path, from the click to the link becoming active:
 *
 *   renderer/app.js  ->  window.threadlink.decideLink  (the preload contract)
 *     ->  the main process's "link:decide" logic       (same code shape)
 *       ->  RuntimeEngine.approveLink                  (the real engine)
 *         ->  ThreadLinkApi.approvePairing             (fake server, real rules)
 *
 * Nothing is bypassed: the fake server refuses to approve a link that is not
 * pending, and refuses a session the caller does not own. The regression this
 * guards is a button that silently did nothing because the failure had nowhere
 * to go.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");

// A real folder: reattaching refuses a workspace that is not on this machine,
// which is correct behaviour and would otherwise mask the thing under test.
const WORKSPACE = mkdtempSync(join(tmpdir(), "tl-workspace-"));
const SESSION = "tlses_adb44e6d9603477ebc0d0ae41b8f7be9";
const LINK = "tllnk_6420871d6b2d41a2b1116d7d9a659180";
const NATIVE = "31a711b2-740c-4fe5-a551-e20e8080dce1";
const BINDING = `cc:${NATIVE}`;

type Server = {
  status: string;
  approvals: { sessionId: string; linkId: string }[];
  failWith: ApiError | Error | null;
};

function fakeServer(): { server: Server; api: Record<string, ReturnType<typeof vi.fn>> } {
  const server: Server = { status: "pending", approvals: [], failWith: null };
  const api = {
    registerRuntime: vi.fn(async () => runtimeView()),
    runtimeHeartbeat: vi.fn(async () => runtimeView()),
    upsertWorkspace: vi.fn(async () => ({ workspaceId: "tlwsp_1" })),
    registerConversation: vi.fn(async () => ({ sessionId: SESSION, created: false })),
    links: vi.fn(async () => []),
    // What /api/runtime/links returns: scoped to this Runtime's own sessions,
    // and independent of whatever is attached locally.
    runtimeLinks: vi.fn(async () =>
      server.status === "revoked"
        ? []
        : [
            {
              linkId: LINK,
              status: server.status,
              paused: false,
              agentSessionId: SESSION,
              controllerDisplayName: "ChatGPT",
              requestedAt: "2026-09-23T06:07:06.922Z",
              approvedAt: null,
              conversation: {
                displayName: "ThreadLink Alpha v0.1 bootstrap",
                localBindingRef: BINDING,
                provider: "claude-code",
                mode: "resume",
                nativeSessionId: NATIVE,
                workspaceId: "tlwsp_1",
                workspaceName: "ThreadLink",
                workspacePath: WORKSPACE,
              },
            },
          ],
    ),
    approvePairing: vi.fn(async (sessionId: string, linkId: string) => {
      server.approvals.push({ sessionId, linkId });
      if (server.failWith) throw server.failWith;
      // The real rules: only the owning session, only while pending, and
      // approving an already-active link is a no-op rather than an error.
      if (sessionId !== SESSION) throw new ApiError(403, "forbidden");
      if (linkId !== LINK) throw new ApiError(404, "not_found");
      if (server.status === "revoked") throw new ApiError(409, "not_pending");
      server.status = "active";
      return { linkId, agentSessionId: sessionId, status: "active" };
    }),
    declinePairing: vi.fn(async (sessionId: string, linkId: string) => {
      server.approvals.push({ sessionId, linkId });
      if (server.failWith) throw server.failWith;
      server.status = "revoked";
      return { linkId, agentSessionId: sessionId, status: "revoked" };
    }),
    inbox: vi.fn(async () => []),
  };
  return { server, api };
}

const runtimeView = () => ({
  runtimeId: "tlrun_1",
  label: "Joel's Laptop",
  platform: "windows",
  kind: "desktop",
  paused: false,
  restartRequestedAt: null,
  settings: {},
  status: "active",
});

const adapter: ProviderAdapter = {
  id: "claude-code",
  name: "Claude Code",
  detect: async () => ({ available: true, version: "2.1.266", capabilities: {} }),
  discoverWorkspaces: async () => [],
  listConversations: async () => [],
  runningConversationIds: async () => [],
  conversationExists: async () => true,
  execute: async () => ({ ok: true, content: "" }),
} as unknown as ProviderAdapter;

let dir: string;
let engine: RuntimeEngine;
let server: Server;
let api: ReturnType<typeof fakeServer>["api"];

/** The main process's "link:decide" handler: it always answers, never rejects. */
async function decideLink(linkId: unknown, approve: unknown) {
  const id = typeof linkId === "string" && linkId.length <= 64 ? linkId : null;
  if (!id) return { ok: false, error: "That link request is not valid." };
  try {
    if (approve === true) await engine.approveLink(id);
    else await engine.declineLink(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: messageFor(error) };
  }
}

async function mountApp() {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  const snapshot = engine.snapshot();
  const state = {
    signedIn: true,
    baseUrl: "https://threadlink-mcp-preview.vercel.app",
    snapshot,
    pendingSignIn: null,
    error: null,
    notice: null,
    localPaused: false,
    settings: { autoStart: true, notifications: true },
  };
  const listeners: ((s: unknown) => void)[] = [];
  (window as unknown as { threadlink: unknown }).threadlink = {
    getState: async () => state,
    onState: (cb: (s: unknown) => void) => listeners.push(cb),
    decideLink,
    attachForLink: async (linkId: string) => {
      try {
        await engine.attachForLink(linkId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: messageFor(error) };
      }
    },
    detach: vi.fn(),
    attach: vi.fn(),
    setMode: vi.fn(async () => ({ ok: true, mode: "worker" })),
    addWorkspace: vi.fn(),
    listConversations: vi.fn(async () => []),
    detectedWorkspaces: vi.fn(async () => []),
    setPaused: vi.fn(),
    restart: vi.fn(),
    signOut: vi.fn(),
    openDashboard: vi.fn(),
    openExternal: vi.fn(),
    setSettings: vi.fn(),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(),
  };
  // navigator.clipboard is not implemented in the test DOM; the page only uses
  // it behind a click we never make here.
  new Function(APP_JS)();
  await Promise.resolve();
  await Promise.resolve();
  return { state, listeners };
}

const approveButton = () =>
  [...document.querySelectorAll("#links button")].find((b) =>
    (b.textContent ?? "").startsWith("Approve"),
  ) as HTMLButtonElement | undefined;

const declineButton = () =>
  [...document.querySelectorAll("#links button")].find((b) =>
    (b.textContent ?? "").startsWith("Decline"),
  ) as HTMLButtonElement | undefined;

const reattachButton = () =>
  [...document.querySelectorAll("#links button")].find((b) =>
    (b.textContent ?? "").startsWith("Attach"),
  ) as HTMLButtonElement | undefined;

const problemText = () => {
  const p = document.querySelector("#links p.danger-text") as HTMLElement | null;
  return p && !p.hidden ? (p.textContent ?? "") : null;
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** Waits for work that touches the filesystem, without guessing at timings. */
const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tl-approval-"));
  ({ server, api } = fakeServer());
  await saveWorkspaceState(dir, {
    workspace: WORKSPACE,
    workspaceKey: serverWorkspaceKey(WORKSPACE),
    workspaceId: "tlwsp_1",
    conversations: [
      {
        provider: "claude-code",
        mode: "resume",
        nativeSessionId: NATIVE,
        title: "ThreadLink Alpha v0.1 bootstrap",
        localBindingRef: BINDING,
        sessionId: SESSION,
        attachedAt: new Date().toISOString(),
      },
    ],
  });
  engine = new RuntimeEngine({
    api: api as never,
    configDir: dir,
    adapters: [adapter],
    identity: { label: "Joel's Laptop", platform: "windows", kind: "desktop" },
    version: "0.6.6",
    repo: async () => ({ remote: null, fingerprint: null, branch: null }),
  });
  await engine.register();
  await engine.sync();
  await engine.refreshPendingLinks();
});

afterEach(async () => {
  document.body.innerHTML = "";
  await rm(dir, { recursive: true, force: true });
});

describe("approving a link request from the desktop app", () => {
  it("shows the pending request the server reported", async () => {
    await mountApp();
    expect(engine.snapshot().pendingLinks).toHaveLength(1);
    expect(engine.snapshot().pendingLinks[0]).toMatchObject({ linkId: LINK, sessionId: SESSION });
    expect(document.querySelector("#links")?.textContent).toContain("ChatGPT");
    expect(approveButton()).toBeTruthy();
  });

  it("sends exactly one approval and the link becomes active", async () => {
    await mountApp();
    approveButton()!.click();
    await settle();

    expect(api.approvePairing).toHaveBeenCalledTimes(1);
    expect(api.approvePairing).toHaveBeenCalledWith(SESSION, LINK);
    expect(server.status).toBe("active");
    // The user is told immediately, without waiting for the next poll.
    expect(document.querySelector("#links")?.textContent).toContain("Linked");
    expect(approveButton()).toBeUndefined();
  });

  it("is idempotent under repeated clicking", async () => {
    await mountApp();
    const button = approveButton()!;
    button.click();
    button.click();
    button.click();
    await settle();
    button.click();
    await settle();

    expect(api.approvePairing).toHaveBeenCalledTimes(1);
    expect(server.approvals).toEqual([{ sessionId: SESSION, linkId: LINK }]);
    expect(server.status).toBe("active");
  });

  it("shows a backend error instead of doing nothing, and allows a retry", async () => {
    await mountApp();
    server.failWith = new ApiError(403, "forbidden");
    approveButton()!.click();
    await settle();

    expect(problemText()).toBe("This computer is not allowed to approve that request.");
    expect(server.status).toBe("pending");
    // The buttons come back, so a retry is possible once the cause is fixed.
    expect(approveButton()!.disabled).toBe(false);

    server.failWith = null;
    approveButton()!.click();
    await settle();
    expect(server.status).toBe("active");
    expect(api.approvePairing).toHaveBeenCalledTimes(2);
  });

  it("still shows the request after the conversation is detached here", async () => {
    // The dead end this replaced: detaching used to hide the request from the
    // only place it could be answered.
    await engine.detach(WORKSPACE, BINDING);
    await engine.refreshPendingLinks();
    await mountApp();

    expect(engine.snapshot().pendingLinks).toHaveLength(1);
    const text = document.querySelector("#links")?.textContent ?? "";
    expect(text).toContain("not attached on this computer");
    expect(approveButton()!.disabled).toBe(true);
    expect(reattachButton()).toBeTruthy();
  });

  it("will not approve a detached conversation behind the user's back", async () => {
    await engine.detach(WORKSPACE, BINDING);
    await engine.refreshPendingLinks();
    const result = await decideLink(LINK, true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/again before approving/i);
    expect(api.approvePairing).not.toHaveBeenCalled();
    expect(server.status).toBe("pending");
  });

  it("reattaching from the request restores the ability to approve", async () => {
    await engine.detach(WORKSPACE, BINDING);
    await engine.refreshPendingLinks();
    await mountApp();

    reattachButton()!.click();
    await waitFor(
      () => engine.snapshot().pendingLinks[0]?.attached === true,
      "the conversation to be attached again",
    );

    // Same conversation, same ThreadLink session - not a new one.
    expect(api.registerConversation).toHaveBeenCalledWith(
      expect.objectContaining({ localBindingRef: BINDING, nativeSessionId: NATIVE }),
    );
    expect(engine.snapshot().pendingLinks[0]).toMatchObject({ attached: true, sessionId: SESSION });

    const result = await decideLink(LINK, true);
    expect(result.ok).toBe(true);
    expect(api.approvePairing).toHaveBeenCalledWith(SESSION, LINK);
    expect(server.status).toBe("active");
  });

  it("a request survives a restart of the Runtime", async () => {
    // Nothing about discovery is remembered locally, so a fresh engine with no
    // memory of the request finds it again.
    const fresh = new RuntimeEngine({
      api: api as never,
      configDir: dir,
      adapters: [adapter],
      identity: { label: "Joel's Laptop", platform: "windows", kind: "desktop" },
      version: "0.6.6",
      repo: async () => ({ remote: null, fingerprint: null, branch: null }),
    });
    await fresh.register();
    await fresh.sync();
    const pending = await fresh.refreshPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ linkId: LINK, attached: true });
  });

  it("declines through the same guarded path", async () => {
    await mountApp();
    declineButton()!.click();
    declineButton()?.click();
    await settle();
    expect(api.declinePairing).toHaveBeenCalledTimes(1);
    expect(server.status).toBe("revoked");
    expect(document.querySelector("#links")?.textContent).toContain("Declined");
  });
});
