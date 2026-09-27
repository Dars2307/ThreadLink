// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkAgain,
  CheckLimiter,
  HEALTH_CHECKERS,
  HEALTH_TEXT,
  healthBackend,
  healthViews,
  SIGN_IN_INSTRUCTION,
  type HealthView,
} from "../../desktop/src/health.ts";
import { statusLine, type AppState } from "../../desktop/src/model.ts";
import {
  deriveStages,
  normaliseStages,
  PhaseMemory,
  stagesFor,
  STAGE_SYMBOLS,
  stopReason,
  workView,
  type Stage,
} from "../../desktop/src/progress.ts";

/**
 * Chat-first desktop (0.9.0): honest stages, provider health with "Check
 * again", Chats/Agents navigation and a plain reason for a blocked job.
 *
 * The production failure this pins: a Team job ended BLOCKED during
 * normalisation because Claude Code could not refresh its OAuth token, and the
 * app showed "✓ Plan" for a plan that never existed.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "desktop", "src", "main.ts"), "utf8");
const PRELOAD = readFileSync(join(ROOT, "desktop", "src", "preload.cts"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8")) as {
  version: string;
};

const summary = (stages: Stage[]) =>
  stages.map((s) => `${STAGE_SYMBOLS[s.state]} ${s.label}`).join(" · ");

const blocked = (over: Record<string, unknown> = {}) => ({
  jobId: "tljob_06c4",
  room: "Prism",
  goal: "Add a weekly report page",
  status: "blocked",
  verdict: "BLOCKED",
  line: "BLOCKED",
  units: [],
  agents: [],
  openFindings: 0,
  reviewRound: 0,
  maxReviewRounds: 3,
  ...over,
});

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

describe("honest stages (derived for an older Runtime)", () => {
  it("failure before normalisation: nothing is done, and Plan is never ✓", () => {
    expect(summary(deriveStages(blocked({ status: "blocked" })))).toBe(
      "✕ Understanding request · – Plan · – Build · – Review · – Integration",
    );
    // Even a job that never got past "queued".
    expect(summary(deriveStages(blocked(), "queued"))).toBe(
      "✕ Understanding request · – Plan · – Build · – Review · – Integration",
    );
  });

  it("failure during normalisation (the production case)", () => {
    expect(summary(deriveStages(blocked(), "normalising"))).toBe(
      "✕ Understanding request · – Plan · – Build · – Review · – Integration",
    );
    expect(summary(deriveStages(blocked({ lastPhase: "normalising" })))).toBe(
      "✕ Understanding request · – Plan · – Build · – Review · – Integration",
    );
  });

  it("failure before the first planning round: understood, Plan ✕", () => {
    expect(summary(deriveStages(blocked({ last_phase: "planning" })))).toBe(
      "✓ Understanding request · ✕ Plan · – Build · – Review · – Integration",
    );
  });

  it("failure during planning, even with units proposed but none started", () => {
    const job = blocked({
      verdict: "NEEDS_USER_DECISION",
      status: "needs_user_decision",
      units: [
        { title: "A", owner: "codex", reviewer: "claude-code", status: "pending" },
        { title: "B", owner: "claude-code", reviewer: "codex", status: "ready" },
      ],
    });
    expect(summary(deriveStages(job, "planning"))).toBe(
      "✓ Understanding request · ✕ Plan · – Build · – Review · – Integration",
    );
    // An explicit "not approved" is believed over anything else.
    expect(deriveStages({ ...job, planApproved: false }, "building")[1]!.state).toBe("failed");
  });

  it("Plan ✓ only with evidence: explicit approval, or a unit that started", () => {
    expect(deriveStages(blocked({ planApproved: true }), "planning")[1]!.state).toBe("done");
    expect(deriveStages(blocked({ plan: { approved: true } }))[1]!.state).toBe("done");
    const started = blocked({
      units: [{ title: "A", owner: "codex", reviewer: "claude-code", status: "failed" }],
    });
    expect(summary(deriveStages(started))).toBe(
      "✓ Understanding request · ✓ Plan · ✕ Build · – Review · – Integration",
    );
  });

  it("a running job shows one active stage and nothing after it done", () => {
    expect(summary(deriveStages({ status: "normalising", verdict: null, units: [] }))).toBe(
      "● Understanding request · ○ Plan · ○ Build · ○ Review · ○ Integration",
    );
    expect(summary(deriveStages({ status: "planning", verdict: null, units: [] }))).toBe(
      "✓ Understanding request · ● Plan · ○ Build · ○ Review · ○ Integration",
    );
    const reviewing = {
      status: "reviewing",
      verdict: null,
      units: [{ title: "A", owner: "codex", reviewer: "claude-code", status: "in_review" }],
    };
    expect(summary(deriveStages(reviewing))).toBe(
      "✓ Understanding request · ✓ Plan · ✓ Build · ● Review · ○ Integration",
    );
  });

  it("PASS is done throughout; a solo job has no Review", () => {
    const solo = {
      status: "completed",
      verdict: "PASS",
      units: [{ title: "A", owner: "codex", reviewer: null, status: "integrated" }],
    };
    expect(summary(deriveStages(solo))).toBe(
      "✓ Understanding request · ✓ Plan · ✓ Build · ✓ Integration",
    );
    expect(
      deriveStages({ mode: "solo", status: "queued", verdict: null }).map((s) => s.key),
    ).not.toContain("review");
  });

  it("NEEDS_FIX after integration stops at Integration", () => {
    const job = {
      status: "needs_fix",
      verdict: "NEEDS_FIX",
      units: [{ title: "A", owner: "codex", reviewer: "claude-code", status: "integrated" }],
    };
    expect(summary(deriveStages(job))).toBe(
      "✓ Understanding request · ✓ Plan · ✓ Build · ✓ Review · ✕ Integration",
    );
  });
});

describe("stages the Runtime sends", () => {
  it("are shown as sent, with tolerant names and states", () => {
    const stages = stagesFor({
      status: "blocked",
      verdict: "BLOCKED",
      units: [],
      stages: [
        { key: "understanding", state: "failed" },
        { name: "Plan", status: "skipped" },
        { label: "Build", state: "skipped" },
        { id: "review", state: "skipped" },
        { key: "integration", state: "skipped" },
      ],
    });
    expect(summary(stages)).toBe(
      "✕ Understanding request · – Plan · – Build · – Review · – Integration",
    );
  });

  it("never turns an unknown state into progress", () => {
    expect(normaliseStages([{ key: "plan", state: "approved?" }])).toEqual([
      { key: "plan", label: "Plan", state: "waiting" },
    ]);
  });

  it("fall back to the derivation when nothing is recognisable", () => {
    expect(normaliseStages([{ key: "mystery", state: "done" }])).toBeNull();
    expect(normaliseStages("done")).toBeNull();
    expect(stagesFor(blocked({ stages: [{ key: "?" }] }))[0]!.state).toBe("failed");
  });
});

describe("remembering where a job was", () => {
  it("keeps the last non-terminal status per job, bounded", () => {
    const memory = new PhaseMemory(2);
    memory.observe([{ jobId: "a", status: "normalising" }]);
    memory.observe([
      { jobId: "a", status: "planning" },
      { jobId: "b", status: "building" },
    ]);
    memory.observe([{ jobId: "a", status: "blocked" }]); // terminal: not a phase
    expect(memory.get("a")).toBe("planning");
    memory.observe([{ jobId: "c", status: "planning" }]);
    expect(memory.get("a")).toBeNull(); // oldest dropped
    expect(memory.get("c")).toBe("planning");
    const view = workView([blocked({ jobId: "c" })], memory);
    expect(summary(view[0]!.jobs[0]!.stages)).toContain("✓ Understanding request · ✕ Plan");
  });
});

// ---------------------------------------------------------------------------
// Why a job stopped
// ---------------------------------------------------------------------------

describe("a blocked job says why, in fixed words", () => {
  it("names the provider that needs sign-in", () => {
    const why = stopReason(
      blocked({ reason: "agent_needs_sign_in", verdictProvider: "claude-code" }),
    );
    expect(why).toEqual({
      text: "Claude Code needs you to sign in again on this computer.",
      needsSignIn: true,
      instruction: SIGN_IN_INSTRUCTION,
    });
  });

  it("does not trust an unknown provider name", () => {
    expect(
      stopReason(blocked({ verdict_reason: "agent_needs_sign_in", verdict_provider: "<b>x</b>" }))
        ?.text,
    ).toBe("An agent needs you to sign in again on this computer.");
  });

  it("recognises the Runtime's sign-in summary when no reason code is sent", () => {
    expect(
      stopReason(blocked({ summary: "Codex needs you to sign in again on this computer." }))?.text,
    ).toBe("Codex needs you to sign in again on this computer.");
  });

  it("covers the other health reasons, and stays quiet otherwise", () => {
    expect(stopReason(blocked({ reason: "api_key_auth", verdictProvider: "codex" }))?.text).toBe(
      "Codex is signed in with an API key, which would bill per use; ThreadLink did not use it.",
    );
    expect(stopReason(blocked({ reason: "usage_exhausted" }))?.text).toBe(
      "An agent has reached its usage limit.",
    );
    expect(stopReason(blocked({ reason: "agent_failed", summary: "stderr: boom" }))).toBeNull();
    expect(stopReason(blocked({ verdict: "PASS", reason: "agent_needs_sign_in" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Grouping by chat
// ---------------------------------------------------------------------------

describe("running and recent work, by chat", () => {
  it("groups by chat id, then chat name, then room; running first", () => {
    const groups = workView([
      blocked({ jobId: "j1", chatId: "tlcht_1", chatName: "Report page" }),
      { ...blocked({ jobId: "j2", room: "Prism" }), status: "building", verdict: null },
      blocked({ jobId: "j3", chat: { id: "tlcht_1", name: "Report page" } }),
      blocked({ jobId: "j4", chat_name: "Loose chat" }),
    ]);
    expect(groups.map((g) => [g.name, g.byChat, g.running, g.jobs.map((j) => j.jobId)])).toEqual([
      ["Prism", false, 1, ["j2"]],
      ["Report page", true, 0, ["j1", "j3"]],
      ["Loose chat", true, 0, ["j4"]],
    ]);
  });

  it("ignores rows that are not jobs", () => {
    expect(workView([null, 3, { room: "x" }])).toEqual([]);
    expect(workView("nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("provider health texts", () => {
  it.each([
    ["ready", "Ready"],
    ["needs_sign_in", "Needs sign-in"],
    ["not_installed", "Not installed"],
    ["api_key_auth", "Uses an API key — sign in with your subscription"],
    ["usage_exhausted", "Usage limit reached"],
    ["unknown", "Not checked yet"],
  ])("%s reads %s", (health, words) => {
    const [claude] = healthViews({
      teamProviders: [
        {
          provider: "claude-code",
          installed: true,
          health,
          healthCheckedAt: new Date().toISOString(),
        },
      ],
    });
    expect(claude!.text).toBe(words);
    expect(claude!.line).toBe(`Claude Code — ${words}`);
    expect(claude!.instruction).toBe(health === "needs_sign_in" ? SIGN_IN_INSTRUCTION : null);
  });

  it("is 'Not checked yet' when the Runtime says nothing, even if 'signed in'", () => {
    const views = healthViews({
      teamProviders: [
        { provider: "claude-code", installed: true, authenticated: true },
        { provider: "codex", installed: false, authenticated: false },
      ],
    });
    expect(views.map((v) => v.line)).toEqual([
      "Claude Code — Not checked yet",
      "Codex — Not installed",
    ]);
    expect(healthViews(null).map((v) => v.health)).toEqual(["unknown", "unknown"]);
  });

  it("tolerates the Runtime's naming, and never passes free text on", () => {
    const views = healthViews({
      teamProviders: [
        {
          provider: "claude-code",
          healthStatus: "needs_sign_in",
          healthCheckedAt: "2026-09-26T08:00:00Z",
          healthDetail: "Failed to refresh OAuth token: stderr …",
          detail: "C:\\claude.exe",
        },
        { provider: "codex", health: { status: "ready", checkedAt: "not a date" } },
      ],
    });
    expect(views[0]).toMatchObject({
      health: "needs_sign_in",
      checkedAt: "2026-09-26T08:00:00.000Z",
    });
    expect(views[1]).toMatchObject({ health: "ready", checkedAt: null });
    expect(JSON.stringify(views)).not.toMatch(/OAuth|stderr|claude\.exe/);
    // A separate providerHealth record wins; nonsense values are unknown.
    expect(
      healthViews({
        teamProviders: [{ provider: "codex", health: "ready" }],
        providerHealth: { codex: "needs_sign_in", "claude-code": { health: "bogus" } },
      }).map((v) => v.health),
    ).toEqual(["unknown", "needs_sign_in"]);
  });

  it("covers every health value with fixed words", () => {
    expect(Object.keys(HEALTH_TEXT).sort()).toEqual([
      "api_key_auth",
      "needs_sign_in",
      "not_installed",
      "ready",
      "unknown",
      "usage_exhausted",
    ]);
  });
});

describe("Check again (main-side validation and rate limit)", () => {
  const read = (): HealthView[] => healthViews({ teamProviders: [] });

  it("refuses anything but a known provider or nothing, before probing", async () => {
    const check = vi.fn(async () => {});
    const limiter = new CheckLimiter(30_000, () => 0);
    for (const bad of ["claude", "CODEX", 1, {}, ["codex"], "a".repeat(5000)]) {
      expect(await checkAgain({ check }, bad, limiter, read)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(check).not.toHaveBeenCalled();
    // The refused calls did not use up the allowance.
    expect((await checkAgain({ check }, "codex", limiter, read)).ok).toBe(true);
  });

  it("allows one probe per 30 s", async () => {
    let now = 1_000_000;
    const limiter = new CheckLimiter(30_000, () => now);
    const check = vi.fn(async () => {});
    expect((await checkAgain({ check }, null, limiter, read)).ok).toBe(true);
    now += 10_000;
    expect(await checkAgain({ check }, "claude-code", limiter, read)).toEqual({
      ok: false,
      error: "too-soon",
      retryInSeconds: 20,
    });
    now += 20_000;
    expect((await checkAgain({ check }, undefined, limiter, read)).ok).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never runs two probes at once", async () => {
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>((r) => (release = r)));
    const limiter = new CheckLimiter(0, () => 0);
    const first = checkAgain({ check }, null, limiter, read);
    const second = await checkAgain({ check }, null, limiter, read);
    expect(second).toMatchObject({ ok: false, error: "too-soon" });
    release();
    expect((await first).ok).toBe(true);
  });

  it("fails closed without a Runtime method, and hides the probe's error", async () => {
    const limiter = new CheckLimiter();
    expect(await checkAgain(null, null, limiter, read)).toEqual({
      ok: false,
      error: "unavailable",
    });
    const result = await checkAgain(
      {
        check: async () => {
          throw new Error("Failed to refresh OAuth token: secret-ish stderr");
        },
      },
      null,
      new CheckLimiter(),
      read,
    );
    expect(result).toMatchObject({ ok: false, error: "failed" });
    expect(JSON.stringify(result)).not.toMatch(/OAuth|stderr/);
  });

  it("finds the engine's re-probe method by any agreed name, calling it bound", async () => {
    expect(healthBackend(null)).toBeNull();
    expect(healthBackend({ refreshTeamProviders: () => {} })).toBeNull();
    for (const name of HEALTH_CHECKERS) {
      const engine = {
        calls: 0,
        [name](this: { calls: number }) {
          this.calls++;
        },
      };
      await healthBackend(engine)!.check();
      expect(engine.calls).toBe(1);
    }
  });

  it("is wired in main and the preload, and nowhere else", () => {
    expect(MAIN_TS).toMatch(/ipcMain\.handle\("providers:check"/);
    expect(MAIN_TS).toContain("checkAgain(healthBackend(engine), rawProvider, healthLimiter");
    expect(PRELOAD).toContain(
      'checkProviders: (provider?: string) => ipcRenderer.invoke("providers:check", provider ?? null)',
    );
  });
});

describe("the tray", () => {
  it("says a provider needs sign-in before anything else", () => {
    const state = {
      signedIn: true,
      baseUrl: null,
      pendingSignIn: null,
      error: null,
      localPaused: false,
      settings: { autoStart: true, notifications: true },
      snapshot: {
        status: "online",
        providers: [{ id: "claude-code", available: true }],
        workspaces: [],
        pendingLinks: [],
      },
      health: healthViews({
        teamProviders: [{ provider: "claude-code", health: "needs_sign_in" }],
      }),
    } as unknown as AppState;
    expect(statusLine(state)).toEqual({
      title: "Claude Code needs sign-in",
      detail: "Claude Code — Needs sign-in",
      tone: "warn",
    });
  });
});

it("is version 0.10.2", () => {
  expect(PKG.version).toBe("0.10.2");
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

type Bridge = Record<string, ReturnType<typeof vi.fn>>;
let bridge: Bridge;

function appState(snapshot: Record<string, unknown> = {}) {
  const snap = {
    status: "online",
    detail: null,
    identity: { label: "Nickron", platform: "windows", kind: "desktop" },
    runtime: { runtimeId: "tlrun_1", label: "Nickron" },
    providers: [{ id: "claude-code", name: "Claude Code", available: true }],
    workspaces: [
      {
        path: "C:\\p",
        name: "ThreadLink",
        exists: true,
        conversations: [
          {
            provider: "claude-code",
            title: "Bootstrap",
            mode: "worker",
            nativeSessionId: "n1",
            localBindingRef: "cc:n1",
            busy: false,
          },
        ],
      },
    ],
    pendingLinks: [],
    activity: [],
    team: [],
    teamProviders: [
      {
        provider: "claude-code",
        installed: true,
        authenticated: true,
        health: "needs_sign_in",
        models: [],
      },
      {
        provider: "codex",
        installed: true,
        authenticated: true,
        health: "ready",
        healthCheckedAt: new Date(Date.now() - 23_000).toISOString(),
        models: [],
      },
    ],
    ...snapshot,
  };
  return {
    signedIn: true,
    baseUrl: "https://threadlink.example",
    pendingSignIn: null,
    error: null,
    notice: null,
    localPaused: false,
    settings: { autoStart: true, notifications: true },
    snapshot: snap,
    health: healthViews(snap),
    work: workView(snap.team, new PhaseMemory()),
  };
}

function mount(state: unknown) {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  bridge = {
    getState: vi.fn(async () => state),
    onState: vi.fn(),
    checkProviders: vi.fn(async () => ({ ok: true, providers: [] })),
    getPlans: vi.fn(async () => ({ ok: false, error: "unavailable" })),
    openDashboard: vi.fn(),
    openExternal: vi.fn(),
    detach: vi.fn(),
    setSettings: vi.fn(),
    signOut: vi.fn(),
  };
  (window as unknown as { threadlink: unknown }).threadlink = bridge;
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
const healthLines = () =>
  [...document.querySelectorAll("#view .health-line")].map((n) => n.textContent);

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("navigation", () => {
  it("reads Home · Chats · Agents · This computer · Notifications · Settings", async () => {
    mount(appState());
    await settle();
    expect([...document.querySelectorAll("#nav button")].map((b) => b.textContent?.trim())).toEqual(
      ["Home", "Chats", "Agents", "This computer", "Notifications", "Settings"],
    );
    expect(APP_JS).not.toMatch(/label: "(Team|Conversations)"/);
  });

  it("keeps the attach flow under Agents", async () => {
    mount(appState());
    await settle();
    await navTo("Agents");
    expect(document.getElementById("page-title")?.textContent).toBe("Agents");
    expect(viewText()).toContain("Attached conversations");
    expect(viewText()).toContain("Bootstrap");
    expect(viewText()).toContain("Background worker");
    expect(document.getElementById("add-more")).toBeTruthy();
  });
});

describe("provider health on screen", () => {
  it("shows each provider's health on Home, with the sign-in instruction", async () => {
    mount(appState());
    await settle();
    expect(healthLines()).toEqual(["Claude Code — Needs sign-in", "Codex — Ready"]);
    expect(viewText()).toContain(SIGN_IN_INSTRUCTION);
    // Health, not "signed in", decides who is online.
    const tiles = [...document.querySelectorAll("#home-summary .tile")].map((t) => t.textContent);
    expect(tiles[0]).toBe("CodexAgents online");
    expect(tiles[3]).toBe("1Needs attention");
  });

  it("shows it on Agents, with each agent's own section (Agents → <provider>)", async () => {
    mount(appState());
    await settle();
    await navTo("Agents");
    expect(healthLines()).toEqual(["Claude Code — Needs sign-in", "Codex — Ready"]);
    // One freshness verdict: "Ready · checked 23 s ago", never Ready beside stale words.
    expect(viewText()).toContain("checked 23 s ago");
    const cards = [...document.querySelectorAll(".provider")];
    expect(cards[0]!.textContent).toContain("Needs sign-in");
    expect(cards[0]!.textContent).toContain(SIGN_IN_INSTRUCTION);
    expect(cards[1]!.textContent).toContain("Ready · checked 23 s ago");
    expect(document.getElementById("agent-claude-code")?.textContent).toContain(
      "Attached conversations",
    );
    expect(document.getElementById("agent-codex")?.textContent).not.toContain(
      "Attached conversations",
    );
    expect(viewText()).not.toContain("Signed in");
    expect(document.querySelector("#agents-health .check-again")).toBeTruthy();
    // Settings no longer carries provider-specific settings.
    await navTo("Settings");
    expect(document.querySelectorAll(".provider")).toHaveLength(0);
    expect(document.getElementById("settings-agents")).toBeTruthy();
  });

  it("says 'Not checked yet' when main sent no health at all", async () => {
    const state = { ...appState(), health: undefined };
    mount(state);
    await settle();
    expect(healthLines()).toEqual(["Claude Code — Not checked yet", "Codex — Not checked yet"]);
  });

  it("Check again asks main once, then waits 30 s", async () => {
    mount(appState());
    await settle();
    const button = () => document.querySelector("#view .check-again") as HTMLButtonElement;
    expect(button().textContent).toBe("Check again");
    button().dispatchEvent(new Event("click"));
    button().dispatchEvent(new Event("click"));
    await settle();
    expect(bridge.checkProviders).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(document.querySelector("#view .check-note")?.textContent).toBe("Checked just now.");
    button().dispatchEvent(new Event("click"));
    await settle();
    expect(bridge.checkProviders).toHaveBeenCalledTimes(1);
  });

  it("shows only fixed words when the check fails, whatever main returned", async () => {
    mount(appState());
    bridge.checkProviders = vi.fn(async () => ({
      ok: false,
      error: "<img src=x onerror=alert(1)> stderr",
    }));
    await settle();
    (document.querySelector("#view .check-again") as HTMLButtonElement).dispatchEvent(
      new Event("click"),
    );
    await settle();
    expect(document.querySelector("#view .check-note")?.textContent).toBe(
      "Couldn't check right now. Try again in a moment.",
    );
    expect(document.querySelector("#view img")).toBeNull();
  });
});

describe("the Chats page", () => {
  const steps = () =>
    [...document.querySelectorAll(".team-job .step")].map(
      (s) =>
        `${s.querySelector(".sym")?.textContent} ${s.querySelector(".step-text")?.textContent}`,
    );

  it("never shows ✓ Plan for a job blocked before a plan existed", async () => {
    const memory = new PhaseMemory();
    memory.observe([{ jobId: "tljob_06c4", status: "normalising" }]);
    const state = appState({
      team: [blocked({ reason: "agent_needs_sign_in", verdictProvider: "claude-code" })],
    });
    state.work = workView(state.snapshot.team, memory);
    mount(state);
    await settle();
    await navTo("Chats");
    expect(steps()).toEqual([
      "✕ Understanding request",
      "– Plan",
      "– Build",
      "– Review",
      "– Integration",
    ]);
    const text = viewText();
    expect(text).not.toContain("✓");
    expect(text).not.toContain("Integration → Final review");
    expect(text).toContain("Claude Code needs you to sign in again on this computer.");
    expect(text).toContain(SIGN_IN_INSTRUCTION);
    expect(text).not.toMatch(/An agent failed/);
  });

  it("renders the Runtime's stages when it sends them", async () => {
    mount(
      appState({
        team: [
          {
            ...blocked(),
            status: "planning",
            verdict: null,
            stages: [
              { key: "understand", state: "done" },
              { key: "plan", state: "active" },
              { key: "build", state: "waiting" },
              { key: "review", state: "waiting" },
              { key: "integrate", state: "waiting" },
            ],
          },
        ],
      }),
    );
    await settle();
    await navTo("Chats");
    expect(steps()).toEqual([
      "✓ Understanding request",
      "● Plan",
      "○ Build",
      "○ Review",
      "○ Integration",
    ]);
  });

  it("groups by chat name and renders names as text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    mount(
      appState({
        team: [
          blocked({ jobId: "a", chatId: "tlcht_1", chatName: evil, goal: evil }),
          blocked({ jobId: "b", chatId: "tlcht_1", chatName: evil }),
          blocked({ jobId: "c", room: `${evil} room` }),
        ],
      }),
    );
    await settle();
    await navTo("Chats");
    expect([...document.querySelectorAll(".chat-name")].map((n) => n.textContent)).toEqual([
      evil,
      `${evil} room`,
    ]);
    expect(document.querySelectorAll(".chat-group")[0]!.querySelectorAll(".team-job")).toHaveLength(
      2,
    );
    expect(document.querySelector("#view img")).toBeNull();
    // The chat id is used for grouping only, never shown.
    expect(viewText()).not.toContain("tlcht_");
  });
});
