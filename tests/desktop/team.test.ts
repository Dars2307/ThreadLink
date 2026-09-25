// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planViews, type PlanProfile } from "../../desktop/src/plans.ts";

/**
 * Team Mode in the desktop app, driven through the real renderer.
 *
 * What is pinned: the owner can see at a glance who is doing what, how far the
 * review has got and how it ended, in plain words; the plan and usage shown are
 * only ever what the provider reported; and raw identifiers stay tucked away
 * behind a closed details section, with a working Copy button.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");

const NATIVE = "31a711b2-740c-4fe5-a551-e20e8080dce1";
const WORKSPACE = "C:\\Users\\joel\\ThreadLink";
const RUNTIME_ID = "tlrun_00000000000000000000000000000001";

type Unit = { title: string; owner: string; reviewer: string; status: string };
type Job = {
  jobId: string;
  room: string;
  goal: string;
  status: string;
  verdict: string | null;
  line: string;
  units: Unit[];
  agents: { provider: string; doing: string }[];
  openFindings: number;
  reviewRound: number;
  maxReviewRounds: number;
};

const job = (over: Partial<Job> = {}): Job => ({
  jobId: "tljob_0000000000000000000000000000000a",
  room: "Prism",
  goal: "Add a weekly report page",
  status: "building",
  verdict: null,
  line: "Claude Code — building Report backend",
  units: [
    { title: "Report backend", owner: "claude-code", reviewer: "codex", status: "approved" },
    { title: "Report UI", owner: "codex", reviewer: "claude-code", status: "running" },
    { title: "Report emails", owner: "claude-code", reviewer: "codex", status: "pending" },
    { title: "Report export", owner: "codex", reviewer: "claude-code", status: "failed" },
  ],
  agents: [
    { provider: "claude-code", doing: "Building backend" },
    { provider: "codex", doing: "Reviewing UI" },
  ],
  openFindings: 2,
  reviewRound: 1,
  maxReviewRounds: 3,
  ...over,
});

type Provider = {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  detectedPlan: string | null;
  models: { id: string; displayName: string }[];
  remaining: "unknown";
  detail: string | null;
};

const providers = (): Provider[] => [
  {
    provider: "claude-code",
    installed: true,
    authenticated: true,
    version: "2.1.266",
    detectedPlan: "max",
    models: [
      { id: "claude-opus-4-1", displayName: "Opus 4.1" },
      { id: "claude-sonnet-4-5", displayName: "Sonnet 4.5" },
    ],
    remaining: "unknown",
    detail: "C:\\Users\\joel\\.local\\bin\\claude.exe",
  },
  {
    provider: "codex",
    installed: true,
    authenticated: false,
    version: "0.44.0",
    detectedPlan: null,
    models: [{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }],
    remaining: "unknown",
    detail: null,
  },
];

function appState(snapshot: Record<string, unknown> = {}) {
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
      runtime: { runtimeId: RUNTIME_ID, label: "Nickron" },
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
          conversations: [
            {
              provider: "claude-code",
              title: "ThreadLink Alpha v0.1 bootstrap",
              mode: "worker",
              nativeSessionId: NATIVE,
              workerNativeSessionId: "9f0c1e22-0000-4000-8000-000000000001",
              sessionId: "tlses_adb44e6d9603477ebc0d0ae41b8f7be9",
              localBindingRef: `cc:${NATIVE}`,
              busy: false,
            },
          ],
        },
      ],
      pendingLinks: [],
      activity: [],
      team: [],
      teamProviders: providers(),
      lastHeartbeatAt: new Date().toISOString(),
      tasksCompleted: 3,
      needsAttention: false,
      ...snapshot,
    },
  };
}

let writeText: ReturnType<typeof vi.fn>;

/** What the server holds, as the main process would hand it to the renderer. */
let serverProfiles: PlanProfile[];
let getPlansFails: boolean;
let setPlanResult: ((provider: string, plan: string) => unknown) | null;
let bridgeCalls: { getPlans: number; setPlan: unknown[][]; openExternal: unknown[][] };

const profiles = (): PlanProfile[] => [
  {
    provider: "claude-code",
    declaredPlan: "max_20x",
    usagePolicy: "balanced",
    paidUsageEnabled: false,
    detectedPlan: "max",
  },
  {
    provider: "codex",
    declaredPlan: "unknown",
    usagePolicy: "conservative",
    paidUsageEnabled: false,
    detectedPlan: null,
  },
];

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
    openDashboard: vi.fn(),
    openExternal: vi.fn(async (...args: unknown[]) => {
      bridgeCalls.openExternal.push(args);
    }),
    setSettings: vi.fn(),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(),
    getPlans: vi.fn(async () => {
      bridgeCalls.getPlans++;
      if (getPlansFails) return { ok: false, error: "failed" };
      return { ok: true, stale: false, providers: planViews(serverProfiles, providers()) };
    }),
    setPlan: vi.fn(async (provider: string, plan: string) => {
      bridgeCalls.setPlan.push([provider, plan]);
      if (setPlanResult) return setPlanResult(provider, plan);
      serverProfiles = serverProfiles.map((p) =>
        p.provider === provider ? { ...p, declaredPlan: plan } : p,
      );
      return { ok: true, providers: planViews(serverProfiles, providers()) };
    }),
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

const viewText = () => document.getElementById("view")?.textContent ?? "";

/** The value next to a label in one provider card. */
const factOf = (card: number, label: string) => {
  const keys = [...document.querySelectorAll(".provider")[card]!.querySelectorAll(".kv .k")];
  return keys.find((k) => k.textContent === label)?.nextElementSibling?.textContent ?? null;
};

/** What the page says with every closed details section taken out. */
const visibleText = () => {
  const copy = document.getElementById("view")!.cloneNode(true) as HTMLElement;
  for (const d of [...copy.querySelectorAll("details")]) {
    if (!(d as HTMLDetailsElement).open) d.remove();
  }
  return copy.textContent ?? "";
};

const steps = () =>
  [...document.querySelectorAll(".team-job .step")].map((s) => ({
    state: (s as HTMLElement).dataset.state,
    sym: s.querySelector(".sym")?.textContent,
    text: s.querySelector(".step-text")?.textContent ?? "",
  }));

beforeEach(() => {
  serverProfiles = profiles();
  getPlansFails = false;
  setPlanResult = null;
  bridgeCalls = { getPlans: 0, setPlan: [], openExternal: [] };
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("navigation", () => {
  it("has the six sections", async () => {
    mount(appState());
    await settle();
    expect([...document.querySelectorAll("#nav button")].map((b) => b.textContent?.trim())).toEqual(
      ["Home", "Conversations", "Team", "This computer", "Notifications", "Settings"],
    );
  });

  it("keeps every existing section working", async () => {
    mount(appState());
    await settle();
    for (const [label, title] of [
      ["Conversations", "Conversations"],
      ["Team", "Team"],
      ["This computer", "This computer"],
      ["Notifications", "Notifications"],
      ["Settings", "Settings"],
      ["Home", "Home"],
    ]) {
      await navTo(label!);
      expect(document.getElementById("page-title")?.textContent).toBe(title);
      expect(document.getElementById("view")?.children.length).toBeGreaterThan(0);
    }
  });
});

describe("the Team page", () => {
  it("explains Team Mode when no job has run", async () => {
    mount(appState());
    await settle();
    await navTo("Team");
    const text = viewText();
    expect(text).toContain("Team Mode");
    expect(text).toContain(
      "Ask your controller (for example ChatGPT) to start a team job in a room",
    );
    expect(text).not.toContain("Ask ChatGPT");
    expect(document.querySelector(".team-job")).toBeNull();
  });

  it("shows the room, the goal and what each agent is doing", async () => {
    mount(appState({ team: [job()] }));
    await settle();
    await navTo("Team");
    expect(document.querySelector(".team-room")?.textContent).toBe("Prism Team");
    const text = viewText();
    expect(text).toContain("Add a weekly report page");
    const agents = [...document.querySelectorAll(".team-agent")].map((a) => a.textContent);
    expect(agents).toEqual(["Claude Code — Building backend", "Codex — Reviewing UI"]);
    expect(text).toContain("Review round 1 / 3 · 2 findings remaining");
  });

  it("lists newest first", async () => {
    mount(
      appState({
        team: [job({ room: "Newer" }), job({ room: "Older", jobId: "tljob_b" })],
      }),
    );
    await settle();
    await navTo("Team");
    expect([...document.querySelectorAll(".team-room")].map((h) => h.textContent)).toEqual([
      "Newer Team",
      "Older Team",
    ]);
  });

  it("marks each step done, in progress, waiting or failed", async () => {
    mount(appState({ team: [job()] }));
    await settle();
    await navTo("Team");
    const s = steps();
    expect(s[0]).toMatchObject({ state: "done", sym: "✓", text: "Plan" });
    expect(s[1]).toMatchObject({
      state: "done",
      sym: "✓",
      text: "Report backend — Claude Code, reviewed by Codex",
    });
    expect(s[2]).toMatchObject({ state: "active", sym: "●", text: "Report UI — Codex" });
    expect(s[3]).toMatchObject({ state: "waiting", sym: "○" });
    expect(s[4]).toMatchObject({ state: "failed", sym: "✕" });
    expect(s[5]).toMatchObject({ state: "waiting", sym: "○", text: "Integration → Final review" });
    // No graph words.
    expect(viewText()).not.toMatch(/\b(node|DAG|graph|in_review|changes_requested)\b/);
  });

  it.each([
    ["PASS", "Done — passed final review"],
    ["NEEDS_FIX", "Needs fixes"],
    ["BLOCKED", "Blocked"],
    ["NEEDS_USER_DECISION", "Needs your decision"],
  ])("says what %s means in plain words", async (verdict, words) => {
    mount(
      appState({
        team: [
          job({
            verdict,
            status: verdict === "PASS" ? "completed" : verdict.toLowerCase(),
            agents: [],
          }),
        ],
      }),
    );
    await settle();
    await navTo("Team");
    expect(document.querySelector(".team-verdict")?.textContent).toBe(words);
    expect(viewText()).not.toContain(verdict);
  });

  it("never shows a raw provider id", async () => {
    mount(appState({ team: [job()] }));
    await settle();
    await navTo("Team");
    expect(visibleText()).not.toMatch(/claude-code|\bcodex\b/);
  });
});

describe("Home", () => {
  it("summarises agents, conversations, team jobs and attention", async () => {
    mount(
      appState({
        team: [
          job(),
          job({ jobId: "tljob_c", verdict: "NEEDS_USER_DECISION", status: "needs_user_decision" }),
        ],
      }),
    );
    await settle();
    const tiles = [...document.querySelectorAll("#home-summary .tile")].map((t) => t.textContent);
    // Codex is installed but not signed in, so only Claude Code is online.
    expect(tiles).toEqual([
      "Claude CodeAgents online",
      "1Conversations linked",
      "1Team jobs running",
      "1Needs attention",
    ]);
    expect(document.getElementById("links")).toBeTruthy();
    expect(document.getElementById("home-activity")).toBeTruthy();
  });
});

describe("Providers & plans", () => {
  it("shows install, sign-in, plan, version and models for each provider", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const cards = [...document.querySelectorAll(".provider")];
    expect(cards).toHaveLength(2);
    const [claude, codex] = cards.map((c) => c.textContent ?? "");
    expect(claude).toContain("Claude Code");
    expect(claude).toContain("Installed");
    expect(claude).toContain("Signed in");
    expect(factOf(0, "Your plan")).toBe("Max 20×");
    expect(factOf(0, "Provider reported")).toBe("Max");
    expect(claude).toContain("2.1.266");
    expect(claude).toContain("Opus 4.1");
    expect(claude).toContain("Sonnet 4.5");
    expect(codex).toContain("Codex");
    expect(codex).toContain("Not signed in");
    expect(factOf(1, "Provider reported")).toBe(
      "Codex doesn't report your plan — ThreadLink uses the plan you chose.",
    );
    expect(codex).toContain("GPT-5 Codex");
    expect(claude).toContain("Remaining usage");
    expect(claude).toContain("not reported by Claude Code");
    expect(codex).toContain("not reported by Codex");
  });

  it("shows usage policy and paid usage from ThreadLink, read-only, and no usage number", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const text = viewText();
    expect(factOf(0, "Usage policy")).toBe("Balanced");
    expect(factOf(0, "Paid usage")).toBe("Off");
    expect(factOf(1, "Usage policy")).toBe("Conservative");
    // Only the plan can be changed here: one select per provider, nothing else.
    expect(document.querySelectorAll(".provider select")).toHaveLength(2);
    expect(document.querySelectorAll(".provider input")).toHaveLength(0);
    expect(text).toContain("web dashboard");
    expect(text).not.toMatch(/\d+\s*%/);
    for (const line of [...document.querySelectorAll(".provider .kv .v")]) {
      if (line.previousElementSibling?.textContent === "Remaining usage") {
        expect(line.textContent).not.toMatch(/\d/);
      }
    }
  });

  it("does not guess a plan the provider did not report", async () => {
    serverProfiles = serverProfiles.map((p) => ({ ...p, detectedPlan: null }));
    const list = providers().map((p) => ({ ...p, detectedPlan: null }));
    mount(appState({ teamProviders: list }));
    const bridge = (window as unknown as { threadlink: Record<string, unknown> }).threadlink;
    bridge.getPlans = async () => ({
      ok: true,
      stale: false,
      providers: planViews(serverProfiles, list),
    });
    await settle();
    await navTo("Settings");
    expect(document.querySelectorAll(".provider")).toHaveLength(2);
    expect(factOf(0, "Provider reported")).toBe("Claude Code hasn't reported a plan yet.");
    expect(factOf(1, "Provider reported")).toContain("Codex doesn't report your plan");
    expect(viewText()).not.toMatch(/Unknown|Not reported|Plan not reported/);
  });

  it("explains itself when no provider has been found", async () => {
    mount(appState({ teamProviders: [] }));
    await settle();
    await navTo("Settings");
    expect(viewText()).toContain("has not found Claude Code or Codex");
  });

  it("keeps the executable path under closed Technical details", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const details = document.querySelector(".provider details.tech") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details.textContent).toContain("claude.exe");
    expect(visibleText()).not.toContain("claude.exe");
  });
});

describe("choosing your plan from the desktop", () => {
  const selectOf = (i: number) =>
    document.querySelectorAll(".provider")[i]!.querySelector("select") as HTMLSelectElement;
  const saveOf = (i: number) =>
    document.querySelectorAll(".provider")[i]!.querySelector(".plan-save") as HTMLButtonElement;
  const noteOf = (i: number) =>
    document.querySelectorAll(".provider")[i]!.querySelector(".plan-note") as HTMLElement;
  const choose = async (i: number, value: string) => {
    const select = selectOf(i);
    select.value = value;
    select.dispatchEvent(new Event("change"));
    await settle();
  };

  it("says a plan that is not set is not set, and asks for one", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    expect(factOf(1, "Your plan")).toBe("Not set — choose your plan");
    expect(selectOf(1).value).toBe("unknown");
  });

  it("offers exactly the plan lists, with no generic Business", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const options = (i: number) => [...selectOf(i).options].map((o) => [o.value, o.textContent]);
    expect(options(0)).toEqual([
      ["free", "Free"],
      ["pro", "Pro"],
      ["max_5x", "Max 5×"],
      ["max_20x", "Max 20×"],
      ["team", "Team"],
      ["enterprise", "Enterprise"],
      ["unknown", "Not set"],
    ]);
    expect(options(1)).toEqual([
      ["free", "Free"],
      ["go", "Go"],
      ["plus", "Plus"],
      ["pro", "Pro"],
      ["business_standard", "Business Standard"],
      ["business_premium", "Business Premium"],
      ["enterprise", "Enterprise"],
      ["edu", "Edu"],
      ["unknown", "Not set"],
    ]);
  });

  it("saves, says Saved, and shows what the server now holds", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    expect(saveOf(1).disabled).toBe(true); // nothing to save yet
    await choose(1, "business_premium");
    expect(saveOf(1).disabled).toBe(false);
    saveOf(1).dispatchEvent(new Event("click"));
    await settle();

    expect(bridgeCalls.setPlan).toEqual([["codex", "business_premium"]]);
    expect(noteOf(1).hidden).toBe(false);
    expect(noteOf(1).textContent).toBe("Saved");
    expect(factOf(1, "Your plan")).toBe("Business Premium");
    expect(selectOf(1).value).toBe("business_premium");
  });

  it("keeps the saved plan after leaving and coming back (re-read from the server)", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    await choose(0, "pro");
    saveOf(0).dispatchEvent(new Event("click"));
    await settle();
    const before = bridgeCalls.getPlans;

    await navTo("Home");
    await navTo("Settings");
    expect(bridgeCalls.getPlans).toBe(before + 1);
    expect(factOf(0, "Your plan")).toBe("Pro");
    // The feedback belonged to the last visit.
    expect(noteOf(0).hidden).toBe(true);
  });

  it("says nothing changed when the save fails, and shows the server's plan", async () => {
    setPlanResult = () => ({ ok: false, error: "failed" });
    mount(appState());
    await settle();
    await navTo("Settings");
    await choose(0, "free");
    saveOf(0).dispatchEvent(new Event("click"));
    await settle();

    expect(noteOf(0).textContent).toBe("Couldn't save your plan — nothing changed");
    expect(noteOf(0).classList.contains("danger-text")).toBe(true);
    expect(factOf(0, "Your plan")).toBe("Max 20×");
  });

  it("treats a bridge that throws as a failed save", async () => {
    setPlanResult = () => {
      throw new Error("ipc down");
    };
    mount(appState());
    await settle();
    await navTo("Settings");
    await choose(1, "plus");
    saveOf(1).dispatchEvent(new Event("click"));
    await settle();
    expect(noteOf(1).textContent).toBe("Couldn't save your plan — nothing changed");
  });

  it("says so when the plan cannot be loaded, instead of inventing one", async () => {
    getPlansFails = true;
    mount(appState());
    await settle();
    await navTo("Settings");
    expect(viewText()).toContain("Couldn't load your plan from ThreadLink");
    expect(document.querySelectorAll(".provider select")).toHaveLength(0);
  });

  it("sends usage policy and paid usage changes to the browser", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const open = [...document.querySelectorAll(".provider button")].find(
      (b) => b.textContent === "Change in browser",
    )!;
    open.dispatchEvent(new Event("click"));
    await settle();
    expect(bridgeCalls.openExternal).toEqual([
      ["https://threadlink-one.vercel.app/dashboard/settings/providers"],
    ]);
  });

  it("renders plan text as text, never as markup", async () => {
    mount(appState());
    const bridge = (window as unknown as { threadlink: Record<string, unknown> }).threadlink;
    const views = planViews(serverProfiles, providers());
    views[0]!.reported = "<img src=x onerror=alert(1)>";
    bridge.getPlans = async () => ({ ok: true, stale: false, providers: views });
    await settle();
    await navTo("Settings");
    expect(document.querySelector(".provider img")).toBeNull();
    expect(factOf(0, "Provider reported")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("identifiers", () => {
  it("never shows a tl*_ identifier outside a closed details section", async () => {
    mount(appState({ team: [job()] }));
    await settle();
    for (const label of [
      "Home",
      "Conversations",
      "Team",
      "This computer",
      "Notifications",
      "Settings",
    ]) {
      await navTo(label);
      expect(visibleText(), label).not.toMatch(/\btl[a-z]*_/);
    }
  });

  it("puts the computer's id and folder path under Advanced, not on the page", async () => {
    mount(appState());
    await settle();
    await navTo("This computer");
    const advanced = document.querySelector("details.advanced") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.textContent).toContain(RUNTIME_ID);
    expect(advanced.textContent).toContain(WORKSPACE);
    expect(visibleText()).not.toContain(WORKSPACE);
  });

  it("copies the exact value with the Copy button", async () => {
    mount(appState());
    await settle();
    await navTo("This computer");
    const row = [...document.querySelectorAll(".copy-row")].find((r) =>
      r.textContent?.includes(RUNTIME_ID),
    )!;
    row.querySelector("button")!.dispatchEvent(new Event("click"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(RUNTIME_ID);
    expect(row.querySelector("button")?.textContent).toBe("Copied");
  });

  it("copies a provider's detail from Settings", async () => {
    mount(appState());
    await settle();
    await navTo("Settings");
    const row = [...document.querySelectorAll(".provider .copy-row")].find((r) =>
      r.textContent?.includes("claude.exe"),
    )!;
    row.querySelector("button")!.dispatchEvent(new Event("click"));
    await settle();
    expect(writeText).toHaveBeenCalledWith("C:\\Users\\joel\\.local\\bin\\claude.exe");
  });

  it("says so, instead of throwing, when there is no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    mount(appState());
    await settle();
    await navTo("This computer");
    const button = document.querySelector(".copy-row button") as HTMLButtonElement;
    button.dispatchEvent(new Event("click"));
    await settle();
    expect(button.textContent).toBe("Copy not available");
  });
});

describe("copy", () => {
  it("never calls a worktree a sandbox", () => {
    expect(`${HTML}\n${APP_JS}`).not.toMatch(/worktree[^.]*sandbox|sandbox[^.]*worktree/i);
  });
});
