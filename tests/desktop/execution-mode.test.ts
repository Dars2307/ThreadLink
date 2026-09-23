// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The desktop app's execution-mode surface, driven through the real renderer.
 *
 * The behaviour being pinned is what the user actually hit: a link set up as an
 * exact conversation kept saying "close Claude and send again", and there was
 * no way to change it short of setting the device up from scratch.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");

const NATIVE = "31a711b2-740c-4fe5-a551-e20e8080dce1";
const WORKSPACE = "C:\\Users\\joel\\ThreadLink";

type Conversation = {
  provider: string;
  title: string;
  mode: "worker" | "resume" | "fresh";
  nativeSessionId: string | null;
  workerNativeSessionId: string | null;
  sessionId: string | null;
  localBindingRef: string;
  busy: boolean;
};

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  provider: "claude-code",
  title: "ThreadLink Alpha v0.1 bootstrap",
  mode: "resume",
  nativeSessionId: NATIVE,
  workerNativeSessionId: null,
  sessionId: "tlses_adb44e6d9603477ebc0d0ae41b8f7be9",
  localBindingRef: `cc:${NATIVE}`,
  busy: false,
  ...over,
});

function appState(conversations: Conversation[], over: Record<string, unknown> = {}) {
  return {
    signedIn: true,
    baseUrl: "https://threadlink-one.vercel.app",
    pendingSignIn: null,
    error: null,
    notice: null,
    localPaused: false,
    settings: { autoStart: true, notifications: true },
    snapshot: {
      status: "online",
      detail: null,
      identity: { label: "Nickron", platform: "windows", kind: "desktop" },
      runtime: { runtimeId: "tlrun_00000000000000000000000000000001", label: "Nickron" },
      providers: [
        {
          id: "claude-code",
          name: "Claude Code",
          available: true,
          version: "2.1.266",
          supportsBackgroundWorker: true,
          supportsExactResume: true,
        },
      ],
      workspaces: [
        {
          path: WORKSPACE,
          name: "ThreadLink",
          workspaceId: "tlwsp_1",
          exists: true,
          conversations,
        },
      ],
      pendingLinks: [],
      lastHeartbeatAt: new Date().toISOString(),
      tasksCompleted: 3,
      needsAttention: false,
      ...(over.snapshot as object),
    },
    ...over,
  };
}

let calls: {
  attach: unknown[][];
  setMode: unknown[][];
};
let setModeResult: { ok: boolean; error?: string };

function mount(state: unknown) {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  (window as unknown as { threadlink: unknown }).threadlink = {
    getState: async () => state,
    onState: () => {},
    attach: vi.fn(async (...args: unknown[]) => {
      calls.attach.push(args);
      return { ok: true };
    }),
    setMode: vi.fn(async (...args: unknown[]) => {
      calls.setMode.push(args);
      return setModeResult;
    }),
    detach: vi.fn(),
    decideLink: vi.fn(),
    attachForLink: vi.fn(),
    addWorkspace: vi.fn(async () => ({ ok: true, path: WORKSPACE })),
    listConversations: vi.fn(async () => [
      {
        nativeSessionId: NATIVE,
        title: "ThreadLink Alpha v0.1 bootstrap",
        lastUsedAt: new Date().toISOString(),
        busy: true,
        attached: false,
        runtime: "claude-code",
      },
    ]),
    detectedWorkspaces: vi.fn(async () => [{ path: WORKSPACE, lastUsedAt: null }]),
    setPaused: vi.fn(),
    restart: vi.fn(),
    signOut: vi.fn(),
    openDashboard: vi.fn(),
    openExternal: vi.fn(),
    setSettings: vi.fn(),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(),
  };
  new Function(APP_JS)();
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const buttonWith = (text: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(text),
  ) as HTMLButtonElement | undefined;

const navTo = async (label: string) => {
  [...document.querySelectorAll("#nav button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label))
    ?.dispatchEvent(new Event("click"));
  await settle();
};

const modeOption = (name: string) =>
  [...document.querySelectorAll(".mode-option")].find((o) =>
    (o.textContent ?? "").includes(name),
  ) as HTMLElement | undefined;

beforeEach(() => {
  calls = { attach: [], setMode: [] };
  setModeResult = { ok: true };
});

describe("the app's shape", () => {
  it("offers the five sections, not one long page", async () => {
    mount(appState([conversation()]));
    await settle();
    expect([...document.querySelectorAll("#nav button")].map((b) => b.textContent?.trim())).toEqual(
      ["Home", "Conversations", "Runtime", "Notifications", "Settings"],
    );
  });

  it("keeps identifiers out of the everyday view", async () => {
    mount(appState([conversation({ mode: "worker" })]));
    await settle();
    await navTo("Conversations");
    const text = document.getElementById("view")?.textContent ?? "";
    expect(text).toContain("ThreadLink Alpha v0.1 bootstrap");
    expect(text).not.toMatch(/tlses_|tlrun_|tlwsp_|cc:|31a711b2/);
  });

  it("puts the raw detail under Advanced on the Runtime page", async () => {
    mount(appState([conversation({ mode: "worker" })]));
    await settle();
    await navTo("Runtime");
    const advanced = document.querySelector("details.advanced");
    expect(advanced).toBeTruthy();
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    expect(advanced?.textContent).toContain(NATIVE);
  });
});

describe("what a linked conversation says", () => {
  it("names the mode and says Ready for a background worker", async () => {
    mount(appState([conversation({ mode: "worker" })]));
    await settle();
    const text = document.getElementById("view")?.textContent ?? "";
    expect(text).toContain("Background worker");
    expect(text).toContain("Ready");
    expect(text).not.toMatch(/in use|close Claude/i);
  });

  it("stays Ready even if the source conversation is reported open", async () => {
    // The worker is ThreadLink's own conversation: the user's being open is
    // not a problem, and saying otherwise is what sent them round in circles.
    mount(appState([conversation({ mode: "worker", busy: true })]));
    await settle();
    const text = document.getElementById("view")?.textContent ?? "";
    expect(text).toContain("Ready");
    expect(text).not.toContain("Claude is currently open");
  });

  it("says plainly when an exact conversation is open", async () => {
    mount(appState([conversation({ mode: "resume", busy: true })]));
    await settle();
    const text = document.getElementById("view")?.textContent ?? "";
    expect(text).toContain("Exact conversation");
    expect(text).toContain("Claude is currently open");
  });
});

describe("attaching a conversation", () => {
  it("offers both modes with background worker already chosen", async () => {
    mount(appState([]));
    await settle();
    await navTo("Conversations");
    buttonWith("Attach another")!.dispatchEvent(new Event("click"));
    await settle();

    const worker = modeOption("Background worker");
    const exact = modeOption("Exact conversation");
    expect(worker).toBeTruthy();
    expect(exact).toBeTruthy();
    expect(worker?.querySelector("input")?.checked).toBe(true);
    expect(exact?.querySelector("input")?.checked).toBe(false);
    expect(worker?.textContent).toContain("Works while Claude Code is open");
    expect(exact?.textContent).toContain("must not already be open");
  });

  it("attaches in background mode by default", async () => {
    mount(appState([]));
    await settle();
    await navTo("Conversations");
    buttonWith("Attach another")!.dispatchEvent(new Event("click"));
    await settle();
    buttonWith("Attach")!.dispatchEvent(new Event("click"));
    await settle();

    expect(calls.attach).toHaveLength(1);
    expect(calls.attach[0]![3]).toBe("worker");
  });

  it("attaches in exact mode when that is deliberately chosen", async () => {
    mount(appState([]));
    await settle();
    await navTo("Conversations");
    buttonWith("Attach another")!.dispatchEvent(new Event("click"));
    await settle();
    const input = modeOption("Exact conversation")!.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    buttonWith("Attach")!.dispatchEvent(new Event("click"));
    await settle();

    expect(calls.attach[0]![3]).toBe("resume");
  });

  it("says so when the provider cannot work in the background", async () => {
    const state = appState([], {
      snapshot: {
        providers: [
          {
            id: "claude-code",
            name: "Claude Code",
            available: true,
            version: "1.0.0",
            supportsBackgroundWorker: false,
            supportsExactResume: true,
          },
        ],
      },
    });
    // The state helper merges `snapshot`, so restore the parts it replaced.
    (state.snapshot as Record<string, unknown>).workspaces = [
      { path: WORKSPACE, name: "ThreadLink", workspaceId: "tlwsp_1", exists: true, conversations: [] },
    ];
    (state.snapshot as Record<string, unknown>).status = "online";
    (state.snapshot as Record<string, unknown>).pendingLinks = [];
    mount(state);
    await settle();
    await navTo("Conversations");
    buttonWith("Attach another")!.dispatchEvent(new Event("click"));
    await settle();

    const worker = modeOption("Background worker")!;
    expect(worker.querySelector("input")?.disabled).toBe(true);
    expect(worker.textContent).toContain("cannot do this on this computer");
  });
});

describe("changing the mode of an existing link", () => {
  it("offers the switch on an attached conversation", async () => {
    mount(appState([conversation({ mode: "resume" })]));
    await settle();
    await navTo("Conversations");
    expect(buttonWith("Change mode")).toBeTruthy();
  });

  it("switches an exact link to a background worker in one step", async () => {
    mount(appState([conversation({ mode: "resume" })]));
    await settle();
    await navTo("Conversations");
    buttonWith("Change mode")!.dispatchEvent(new Event("click"));
    await settle();

    const worker = modeOption("Background worker")!.querySelector("input") as HTMLInputElement;
    worker.checked = true;
    worker.dispatchEvent(new Event("change"));
    buttonWith("Confirm")!.dispatchEvent(new Event("click"));
    await settle();

    expect(calls.setMode).toEqual([[WORKSPACE, `cc:${NATIVE}`, "worker"]]);
  });

  it("promises not to disturb anything else", async () => {
    mount(appState([conversation({ mode: "resume" })]));
    await settle();
    await navTo("Conversations");
    buttonWith("Change mode")!.dispatchEvent(new Event("click"));
    await settle();
    const text = document.getElementById("view")?.textContent ?? "";
    expect(text).toContain("stay as they are");
    expect(text).not.toMatch(/set up|sign in again|reconnect/i);
  });

  it("shows a failure instead of silently doing nothing", async () => {
    setModeResult = { ok: false, error: "Claude Code cannot work in the background." };
    mount(appState([conversation({ mode: "resume" })]));
    await settle();
    await navTo("Conversations");
    buttonWith("Change mode")!.dispatchEvent(new Event("click"));
    await settle();
    buttonWith("Confirm")!.dispatchEvent(new Event("click"));
    await settle();

    const problem = document.querySelector("p.danger-text") as HTMLElement | null;
    expect(problem?.hidden).toBe(false);
    expect(problem?.textContent).toBe("Claude Code cannot work in the background.");
    // And the retry is still there.
    expect(buttonWith("Confirm")!.disabled).toBe(false);
  });

  it("cannot be asked for on a new-conversation-each-time binding", async () => {
    mount(
      appState([
        conversation({
          mode: "fresh",
          nativeSessionId: null,
          localBindingRef: "cc:fresh",
          title: "New conversation for each request",
        }),
      ]),
    );
    await settle();
    await navTo("Conversations");
    expect(buttonWith("Change mode")!.disabled).toBe(true);
  });
});
