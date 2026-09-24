// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mirrored activity feed, driven through the real renderer.
 *
 * In background-worker mode the work runs in a Claude conversation the user
 * cannot see, and nothing can be written into the one they do have open. The
 * feed is the whole answer to "did it do anything?", so what it says, who it
 * says it about, and what it refuses to leak are all pinned here.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");

const NATIVE = "31a711b2-740c-4fe5-a551-e20e8080dce1";
const OTHER_NATIVE = "7c2f0f9a-1111-4444-9999-aaaaaaaaaaaa";
const WORKSPACE = "C:\\Users\\joel\\ThreadLink";
const BOOTSTRAP = "ThreadLink Alpha v0.1 bootstrap";
const DASHBOARD = "Dashboard polish";

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
  title: BOOTSTRAP,
  mode: "worker",
  nativeSessionId: NATIVE,
  workerNativeSessionId: null,
  sessionId: "tlses_adb44e6d9603477ebc0d0ae41b8f7be9",
  localBindingRef: `cc:${NATIVE}`,
  busy: false,
  ...over,
});

type Activity = {
  taskId: string;
  event: "task_started" | "task_completed" | "task_failed" | "task_lost" | "task_blocked";
  title: string;
  conversation: string;
  localBindingRef: string;
  workspace: string;
  mode: "worker" | "resume" | "fresh";
  at: string;
  detail?: string;
  summary?: string;
  blocked?: "plan_mode" | "approval_required" | "user_input_required";
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const activity = (over: Partial<Activity> = {}): Activity => ({
  taskId: "tltsk_9f3c1d8e2b4a4c6f8d0e1a2b3c4d5e6f",
  event: "task_started",
  title: "Fix the sign-in redirect",
  conversation: BOOTSTRAP,
  localBindingRef: `cc:${NATIVE}`,
  workspace: WORKSPACE,
  mode: "worker",
  at: minutesAgo(3),
  ...over,
});

function appState(conversations: Conversation[], activities: Activity[] = []) {
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
      activity: activities,
      needsAttention: false,
    },
  };
}

let openDashboard: ReturnType<typeof vi.fn>;

function mount(state: unknown) {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  (window as unknown as { threadlink: unknown }).threadlink = {
    getState: async () => state,
    onState: () => {},
    attach: vi.fn(async () => ({ ok: true })),
    setMode: vi.fn(async () => ({ ok: true })),
    detach: vi.fn(),
    decideLink: vi.fn(),
    attachForLink: vi.fn(),
    addWorkspace: vi.fn(async () => ({ ok: true, path: WORKSPACE })),
    listConversations: vi.fn(async () => []),
    detectedWorkspaces: vi.fn(async () => []),
    setPaused: vi.fn(),
    restart: vi.fn(),
    signOut: vi.fn(),
    openDashboard,
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

const navTo = async (label: string) => {
  [...document.querySelectorAll("#nav button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label))
    ?.dispatchEvent(new Event("click"));
  await settle();
};

/** Every mirrored line on screen, in the order it is painted. */
const feedItems = () => [...document.querySelectorAll(".activity-item")] as HTMLElement[];
const feedText = () => feedItems().map((n) => n.textContent ?? "");

/** The conversation card a mirrored line hangs under, by the card's title. */
const groupsOnConversations = () =>
  [...document.querySelectorAll("#attached > *")].map((group) => ({
    title: group.querySelector(".item .title")?.textContent ?? "",
    lines: [...group.querySelectorAll(".activity-item")].map((n) => n.textContent ?? ""),
    empty: [...group.querySelectorAll(".activity .empty")].map((n) => n.textContent ?? ""),
  }));

/** A worker task from start to finish, newest first, as the runtime mirrors it. */
const completedRun = (): Activity[] => [
  activity({
    event: "task_completed",
    at: minutesAgo(2),
    summary: "Updated the redirect and added a test.",
  }),
  activity({ event: "task_started", at: minutesAgo(9) }),
];

beforeEach(() => {
  openDashboard = vi.fn();
});

describe("what one mirrored line says", () => {
  const lineFor = async (over: Partial<Activity>) => {
    mount(appState([conversation()], [activity(over)]));
    await settle();
    return feedText()[0] ?? "";
  };

  it("says a task started and where it is running", async () => {
    const text = await lineFor({ event: "task_started" });
    expect(text).toContain("Task started");
    expect(text).toContain("Fix the sign-in redirect");
    expect(text).toContain("Running in background worker");
  });

  it("says a task completed, with the safe summary", async () => {
    const text = await lineFor({
      event: "task_completed",
      summary: "Updated the redirect and added a test.",
    });
    expect(text).toContain("Task completed");
    expect(text).toContain("Updated the redirect and added a test.");
  });

  it("still reads sensibly when a completed task has no summary", async () => {
    const text = await lineFor({ event: "task_completed" });
    expect(text).toContain("Task completed");
    expect(text).toContain("Fix the sign-in redirect");
    expect(text).toMatch(/Finished/i);
    expect(text).not.toContain("undefined");
  });

  it("says a task failed, using the safe explanation", async () => {
    const text = await lineFor({
      event: "task_failed",
      detail: "The project folder is missing.",
    });
    expect(text).toContain("Task failed");
    expect(text).toContain("The project folder is missing.");
  });

  it("says plainly what a blocked task is waiting for", async () => {
    expect(await lineFor({ event: "task_blocked", blocked: "approval_required" })).toContain(
      "Claude needs your permission to continue.",
    );
    expect(await lineFor({ event: "task_blocked", blocked: "user_input_required" })).toContain(
      "Claude is waiting for an answer from you.",
    );
    expect(await lineFor({ event: "task_blocked", blocked: "plan_mode" })).toContain(
      "Claude is in Plan Mode",
    );
  });

  it("says a task was interrupted rather than going quiet", async () => {
    const text = await lineFor({ event: "task_lost" });
    expect(text).toContain("Task interrupted");
    expect(text).toMatch(/stopped before finishing/i);
  });

  it("shows how long ago it happened, not a raw timestamp", async () => {
    const at = minutesAgo(12);
    mount(appState([conversation()], [activity({ at })]));
    await settle();
    const text = feedText()[0] ?? "";
    expect(text).toContain("12 min ago");
    expect(text).not.toContain(at);
  });
});

describe("whose conversation a line belongs to", () => {
  const two = () =>
    appState(
      [
        conversation(),
        conversation({
          title: DASHBOARD,
          nativeSessionId: OTHER_NATIVE,
          localBindingRef: `cc:${OTHER_NATIVE}`,
        }),
      ],
      [
        activity({
          event: "task_completed",
          title: "Tidy the header",
          conversation: DASHBOARD,
          localBindingRef: `cc:${OTHER_NATIVE}`,
          at: minutesAgo(1),
          summary: "Trimmed the header spacing.",
        }),
        ...completedRun(),
      ],
    );

  it("files each line under its own conversation, not one flat list", async () => {
    mount(two());
    await settle();
    await navTo("Conversations");

    const groups = groupsOnConversations();
    expect(groups.map((g) => g.title)).toEqual([BOOTSTRAP, DASHBOARD]);
    expect(groups[0]!.lines.join(" ")).toContain("Fix the sign-in redirect");
    expect(groups[0]!.lines.join(" ")).not.toContain("Tidy the header");
    expect(groups[1]!.lines.join(" ")).toContain("Tidy the header");
    expect(groups[1]!.lines.join(" ")).not.toContain("Fix the sign-in redirect");
  });

  it("names the conversation on the mixed feed on Home", async () => {
    mount(two());
    await settle();

    const home = document.getElementById("home-activity")?.textContent ?? "";
    expect(home).toContain(`in ${BOOTSTRAP}`);
    expect(home).toContain(`in ${DASHBOARD}`);
  });

  it("keeps lines from a conversation that is no longer attached", async () => {
    mount(
      appState(
        [conversation()],
        [
          activity({
            event: "task_completed",
            title: "Tidy the header",
            conversation: DASHBOARD,
            localBindingRef: `cc:${OTHER_NATIVE}`,
            summary: "Trimmed the header spacing.",
          }),
        ],
      ),
    );
    await settle();
    await navTo("Conversations");

    const groups = groupsOnConversations();
    expect(groups.map((g) => g.title)).toEqual([BOOTSTRAP, DASHBOARD]);
    expect(groups[1]!.title).toBe(DASHBOARD);
    expect(document.getElementById("view")?.textContent).toContain("No longer attached");
  });
});

describe("order and quantity", () => {
  it("keeps the newest line first", async () => {
    mount(appState([conversation()], completedRun()));
    await settle();

    const [first, second] = feedText();
    expect(first).toContain("Task completed");
    expect(second).toContain("Task started");
  });

  it("does not turn into a log file", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      activity({ title: `Task ${i}`, at: minutesAgo(i + 1) }),
    );
    mount(appState([conversation()], many));
    await settle();

    const shown = feedItems().length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(10);
    expect(feedText()[0]).toContain("Task 0");
  });
});

describe("what the feed must never show", () => {
  it("keeps identifiers out of the feed, on Home and on Conversations", async () => {
    const state = appState([conversation()], completedRun());
    mount(state);
    await settle();
    const home = document.getElementById("view")?.textContent ?? "";
    expect(home).toContain("Task completed");
    expect(home).not.toMatch(/tltsk_|tlses_|tlrun_|tlwsp_|cc:|31a711b2/);

    await navTo("Conversations");
    const conversations = document.getElementById("view")?.textContent ?? "";
    expect(conversations).toContain("Task completed");
    expect(conversations).not.toMatch(/tltsk_|tlses_|tlrun_|tlwsp_|cc:|31a711b2/);
  });

  it("builds the feed as real nodes, never as interpolated markup", async () => {
    mount(
      appState(
        [conversation()],
        [
          activity({
            event: "task_completed",
            title: "<img src=x onerror=alert(1)>",
            summary: "<script>alert(2)</script>",
          }),
        ],
      ),
    );
    await settle();

    const item = feedItems()[0]!;
    expect(item.querySelector("img")).toBeNull();
    expect(item.querySelector("script")).toBeNull();
    expect(item.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("seeing the whole story", () => {
  it("offers the dashboard from Home rather than showing the full result", async () => {
    mount(appState([conversation()], completedRun()));
    await settle();

    document.getElementById("home-activity-dashboard")!.dispatchEvent(new Event("click"));
    expect(openDashboard).toHaveBeenCalledTimes(1);
  });

  it("offers the dashboard beside a conversation's own feed", async () => {
    mount(appState([conversation()], completedRun()));
    await settle();
    await navTo("Conversations");

    const open = [...document.querySelectorAll(".activity button")].find((b) =>
      (b.textContent ?? "").includes("Open dashboard"),
    ) as HTMLButtonElement | undefined;
    expect(open).toBeTruthy();
    open!.dispatchEvent(new Event("click"));
    expect(openDashboard).toHaveBeenCalledTimes(1);
  });
});

describe("before anything has run", () => {
  it("says something useful on Home instead of an empty box", async () => {
    mount(appState([conversation()]));
    await settle();

    const home = document.getElementById("home-activity")?.textContent ?? "";
    expect(feedItems()).toHaveLength(0);
    expect(home).toMatch(/No activity yet/i);
    expect(home).toMatch(/shows up here/i);
  });

  it("says so under a conversation that has not run anything", async () => {
    mount(appState([conversation()]));
    await settle();
    await navTo("Conversations");

    const groups = groupsOnConversations();
    expect(groups[0]!.empty.join(" ")).toMatch(/Nothing has run here yet/i);
    expect(groups[0]!.empty.join(" ")).toMatch(/ChatGPT/);
  });

  it("does not offer the dashboard on a conversation with no activity", async () => {
    mount(appState([conversation()]));
    await settle();
    await navTo("Conversations");

    const buttons = [...document.querySelectorAll(".activity button")];
    expect(buttons).toHaveLength(0);
  });
});
