// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as shared from "../../runtime/src/chat-presentation.ts";
import {
  CHOICE_ANSWERS,
  chatHeader,
  chatRow,
  ChatService,
  choiceAnswer,
  choiceCardOf,
  eventView,
  failoverView,
  fallbackPlacement,
  hostPresenceView,
  pageView,
  projectViews,
  validCreate,
  validLane,
  type Presentation,
} from "../../desktop/src/chats.ts";
import { healthViews } from "../../desktop/src/health.ts";
import { DEFAULT_SETTINGS, validSettingsPatch } from "../../desktop/src/settings.ts";

/**
 * ThreadLink 0.11 desktop (docs/design/threadlink-0.11.md §4, §5, §6, §7, §9):
 * the same product as the web. Same navigation, the same chat layout (one
 * scrolling timeline, sticky composer, right drawer), the shared placement
 * rules (ThreadLink quiet), choice cards answered with main's own words,
 * presence as You and the host, lanes, and the failover preference.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");
const CSS = readFileSync(join(ROOT, "desktop", "renderer", "styles.css"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "desktop", "src", "main.ts"), "utf8");
const PRELOAD = readFileSync(join(ROOT, "desktop", "src", "preload.cts"), "utf8");
const INDEX_TS = readFileSync(join(ROOT, "runtime", "src", "index.ts"), "utf8");

const PRESENT: Presentation = {
  chatPlacement: shared.chatPlacement as never,
  agentShortName: shared.agentShortName as never,
  humanSystemText: shared.humanSystemText as never,
};

const CHAT = `tlcht_${"a".repeat(32)}`;
const CHAT2 = `tlcht_${"b".repeat(32)}`;
const ROOM = `tlrom_${"c".repeat(32)}`;
const CHOICE = "tlcho_1234abcd";

const claude = {
  kind: "agent" as const,
  provider: "claude-code",
  name: "Claude Code",
  shortName: "Claude",
  health: "ready",
  healthCheckedAt: null,
};
const codex = { ...claude, provider: "codex", name: "Codex", shortName: "Codex" };

function item(over: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    name: "Prism Review",
    mode: "team" as const,
    roomId: ROOM,
    projectName: "Prism",
    pinned: false,
    archived: false,
    participants: [claude, codex],
    lastMessage: null,
    lastActivityAt: "2026-09-26T10:00:00.000Z",
    unread: false,
    needsAttention: false,
    activeJob: null,
    runtimeLabel: "Nickron PC",
    runtimeOnline: true,
    ...over,
  } as never;
}

function ev(seq: number, over: Record<string, unknown> = {}) {
  return {
    seq,
    id: `tlcev_${seq}`,
    createdAt: "2026-09-26T10:00:00.000Z",
    authorKind: "agent",
    authorProvider: "codex",
    authorLabel: "Codex",
    authorRole: null,
    audience: null,
    eventType: "agent_message",
    messageType: null,
    body: `message ${seq}`,
    visibility: "visible",
    delivery: null,
    client: null,
    payload: null,
    ...over,
  } as never;
}

const usageChoice = (seq: number, over: Record<string, unknown> = {}) =>
  ev(seq, {
    authorKind: "threadlink",
    authorProvider: null,
    eventType: "choice",
    body: "Codex usage is exhausted.",
    payload: {
      choiceId: CHOICE,
      kind: "usage_exhausted",
      title: "Codex usage is exhausted",
      status: "pending",
      options: [
        { key: "continue_other", label: "Continue with Claude" },
        { key: "retry", label: "Retry Codex" },
        { key: "check_again", label: "Check Codex again" },
        { key: "wait", label: "Wait for Codex" },
        { key: "stop", label: "Stop" },
      ],
      ...over,
    },
  });

// ---------------------------------------------------------------------------
// Placement, names, system text
// ---------------------------------------------------------------------------

describe("ThreadLink is quiet (§7)", () => {
  const rows = [
    ev(1),
    ev(2, { authorKind: "owner", authorProvider: null }),
    ev(3, { authorKind: "threadlink", authorProvider: null, eventType: "job_started" }),
    ev(4, { authorKind: "threadlink", authorProvider: null, eventType: "task_started" }),
    ev(5, { authorKind: "threadlink", authorProvider: null, eventType: "owner_routed" }),
    ev(6, { authorKind: "threadlink", authorProvider: null, eventType: "job_summary" }),
    ev(7, { authorKind: "threadlink", authorProvider: null, eventType: "provider_blocked" }),
    usageChoice(8),
    ev(9, {
      authorKind: "threadlink",
      authorProvider: null,
      eventType: "finding",
      payload: { severity: "blocking", status: "open" },
    }),
    ev(10, {
      authorKind: "threadlink",
      authorProvider: null,
      eventType: "finding",
      payload: { severity: "non_blocking", status: "open" },
    }),
    ev(11, { visibility: "technical" }),
  ];

  it("places rows with the shared module, and the fallback agrees with it", () => {
    const placed = rows.map((r) => eventView(r, [claude, codex], PRESENT).placement);
    expect(placed).toEqual([
      "chat",
      "chat",
      "activity",
      "activity",
      "activity",
      "chat",
      "chat",
      "chat",
      "chat",
      "activity",
      "activity",
    ]);
    for (const r of rows) expect(fallbackPlacement(r)).toBe(shared.chatPlacement(r));
  });

  it("main injects the shared module, which the embedded Runtime exports", () => {
    expect(MAIN_TS).toContain('fn("chatPlacement")');
    expect(MAIN_TS).toContain("new ChatService(chatApi, Date.now, sharedPresentation())");
    expect(INDEX_TS).toMatch(/chatPlacement.*from "\.\/chat-presentation\.ts"/);
  });

  it("names agents 'Claude' / 'Codex' and sides rows like the web", () => {
    const agent = eventView(
      ev(1, { authorProvider: "claude-code", authorRole: "builder" }),
      [claude],
      PRESENT,
    );
    expect(agent.identity).toMatchObject({ short: "Claude", full: "Claude Code", initial: "C" });
    expect(agent.identity.label).toBe("Claude · builder");
    expect(agent.side).toBe("left");
    expect(eventView(ev(2, { authorKind: "owner" }), [], PRESENT).side).toBe("right");
    expect(eventView(ev(3, { authorKind: "threadlink" }), [], PRESENT).side).toBe("center");
  });

  it("never shows ids or reason codes in ThreadLink's words", () => {
    const v = eventView(
      ev(4, {
        authorKind: "threadlink",
        authorProvider: null,
        eventType: "provider_blocked",
        body: "Codex is not ready (usage_exhausted). Job tljob_0123456789abcdef paused.",
      }),
      [],
      PRESENT,
    );
    const text = v.body.preview.map((b) => b.v).join(" ");
    expect(text).not.toMatch(/tljob_|usage_exhausted/);
    // The fallback scrubs too, without the shared module.
    const bare = eventView(
      ev(5, {
        authorKind: "threadlink",
        body: "Run tlrun_0123456789ab failed (provider_failure).",
      }),
      [],
    );
    expect(bare.body.preview.map((b) => b.v).join(" ")).not.toMatch(/tlrun_|provider_failure/);
  });
});

// ---------------------------------------------------------------------------
// Choice cards (§5, §6)
// ---------------------------------------------------------------------------

describe("choice cards", () => {
  it("never offers Retry for usage_exhausted, and answers with fixed words", () => {
    const card = choiceCardOf(usageChoice(8))!;
    expect(card.options.map((o) => o.label)).toEqual([
      "Continue with Claude",
      "Check Codex again",
      "Wait for Codex",
      "Stop",
    ]);
    expect(choiceAnswer(card, "continue_other")).toBe("continue with Claude");
    expect(choiceAnswer(card, "check_again")).toBe(CHOICE_ANSWERS.check_again);
    expect(choiceAnswer(card, "wait")).toBe("wait");
    expect(choiceAnswer(card, "stop")).toBe("stop");
    expect(choiceAnswer(card, "retry")).toBeNull();
  });

  it("offers start_work as Run this as work / Keep chatting", () => {
    const card = choiceCardOf(
      ev(3, {
        authorKind: "threadlink",
        eventType: "choice",
        payload: {
          choiceId: CHOICE,
          kind: "start_work",
          options: [
            { key: "run_work", label: "Run this as work" },
            { key: "keep_chatting", label: "Keep chatting" },
          ],
        },
      }),
    )!;
    expect(choiceAnswer(card, "run_work")).toBe("run it");
    expect(choiceAnswer(card, "keep_chatting")).toBe("keep chatting");
  });

  it("never answers an approval from the desktop", () => {
    const card = choiceCardOf(
      ev(3, {
        authorKind: "threadlink",
        eventType: "choice",
        payload: {
          choiceId: CHOICE,
          kind: "production_deploy",
          options: [{ key: "stop", label: "Stop" }],
        },
      }),
    )!;
    expect(card.approval).toBe(true);
    expect(card.options.every((o) => !o.answerable)).toBe(true);
    expect(choiceAnswer(card, "stop")).toBeNull();
  });

  it("ChatService posts main's words for a choice it showed, and nothing else", async () => {
    const post = vi.fn(async () => ({
      ok: true as const,
      routed: "choice_resolved",
      jobId: null,
      chosenLabel: "Continue with Claude",
    }));
    const api = {
      getChat: vi.fn(async () => ({ ...(item() as object), lastReadSeq: 0 })),
      events: vi.fn(async () => ({
        events: [usageChoice(8)],
        cursor: 8,
        hasOlder: false,
        activeJob: null,
        live: [],
      })),
      post,
      listChats: vi.fn(async () => []),
      markRead: vi.fn(),
      createChat: vi.fn(),
    };
    const svc = new ChatService(async () => api as never, Date.now, PRESENT);
    // Not shown yet: refused before anything is posted.
    expect(await svc.answer(CHAT, CHOICE, "wait", "key-00000001")).toEqual({
      ok: false,
      error: "invalid",
    });
    await svc.open(CHAT);
    expect(await svc.answer(CHAT, CHOICE, "retry", "key-00000002")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await svc.answer(CHAT, "<script>", "wait", "key-00000003")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(post).not.toHaveBeenCalled();
    expect(await svc.answer(CHAT, CHOICE, "continue_other", "key-00000004")).toEqual({
      ok: true,
      routed: "choice_resolved",
      chosenLabel: "Continue with Claude",
    });
    expect(post).toHaveBeenCalledWith(CHAT, "continue with Claude", "key-00000004");
    // Decided: a second answer is not sent.
    expect(await svc.answer(CHAT, CHOICE, "wait", "key-00000005")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("pages carry decided choices so cards on screen update", () => {
    const page = pageView(
      {
        events: [
          ev(9, {
            authorKind: "threadlink",
            eventType: "choice_resolved",
            payload: { choiceId: CHOICE, chosenLabel: "Wait for Codex" },
          }),
        ],
        cursor: 9,
        hasOlder: false,
        hasNewer: false,
        oldestCursor: 9,
        activeJob: null,
        live: [],
      } as never,
      [],
      PRESENT,
    );
    expect(page.resolved).toEqual([{ choiceId: CHOICE, label: "Wait for Codex" }]);
  });
});

// ---------------------------------------------------------------------------
// Lanes, create, overview, presence, failover, health
// ---------------------------------------------------------------------------

describe("lanes and new chats", () => {
  it("sends Auto as nothing and Chat only / Run work as lane", async () => {
    const post = vi.fn(async () => ({ ok: true as const, routed: "new_job", jobId: null }));
    const svc = new ChatService(async () => ({ post }) as never);
    await svc.send(CHAT, "hi", "key-00000001");
    await svc.send(CHAT, "hi", "key-00000002", "auto");
    await svc.send(CHAT, "why?", "key-00000003", "chat");
    await svc.send(CHAT, "fix it", "key-00000004", "work");
    expect(post.mock.calls).toEqual([
      [CHAT, "hi", "key-00000001"],
      [CHAT, "hi", "key-00000002"],
      [CHAT, "why?", "key-00000003", { lane: "chat" }],
      [CHAT, "fix it", "key-00000004", { lane: "work" }],
    ]);
    expect(await svc.send(CHAT, "x", "key-00000005", "fast")).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(validLane(undefined)).toBe("auto");
    expect(validLane("WORK")).toBeNull();
  });

  it("validates a new chat's name, project and mode in main", () => {
    expect(validCreate({ name: " Auth ", roomId: ROOM, mode: "pair" })).toEqual({
      name: "Auth",
      roomId: ROOM,
      mode: "pair",
    });
    expect(validCreate({ name: "Auth" })).toEqual({ name: "Auth", roomId: null, mode: undefined });
    for (const bad of [
      null,
      { name: "" },
      { name: "a\nb" },
      { name: "x".repeat(101) },
      { name: "A", roomId: "tlrom_x" },
      { name: "A", mode: "crew" },
      { name: "A", owner: "someone" },
    ])
      expect(validCreate(bad)).toBeNull();
  });
});

describe("presence (§4)", () => {
  it("says This computer only when the server says so, and the offline sentence", () => {
    expect(hostPresenceView(item())).toMatchObject({
      name: "Nickron PC",
      text: "Nickron PC · Online",
    });
    expect(hostPresenceView(item({ thisComputer: true, hostPresence: "working" }))).toMatchObject({
      name: "This computer",
      text: "This computer · Working",
    });
    const off = hostPresenceView(item({ hostPresence: "offline" }))!;
    expect(off.offlineNote).toBe(
      "You're connected. Nickron PC is offline — repository work and agent replies will resume when it reconnects.",
    );
    expect(chatHeader(item({ hostPresence: "offline" })).status).toEqual({
      text: "Nickron PC offline",
      tone: "off",
    });
    expect(
      chatHeader(item({ activeJob: { jobId: "j", mode: "team", status: "building" } })).status.text,
    ).toBe("Working");
    expect(hostPresenceView(item({ runtimeLabel: null, thisComputer: null }))).toBeNull();
  });
});

describe("overview, projects and failover", () => {
  it("answers chats, projects, needs-you and the failover preference in one request", async () => {
    const overview = vi.fn(async () => ({
      chats: [item(), item({ chatId: CHAT2, name: "Other", needsAttention: true, unread: true })],
      projects: [{ roomId: ROOM, name: "Prism", runtimeLabel: "Nickron PC", thisComputer: true }],
      runtime: {
        label: "Nickron PC",
        online: true,
        presence: "online",
        lastSeenAt: null,
        version: "0.11.0",
        protocol: 11,
        minProtocol: 10,
        updateRequired: false,
      },
      failoverPolicy: "ask",
    }));
    const svc = new ChatService(async () => ({ overview }) as never);
    const res = await svc.overview("recent");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projects[0]).toMatchObject({ name: "Prism", runsOn: "This computer" });
    expect(res.projects[0]!.chats.map((c) => c.name)).toEqual(["Prism Review", "Other"]);
    expect(res.needsYou.map((r) => r.name)).toEqual(["Other"]);
    expect(res.unread).toBe(1);
    expect(res.failover).toEqual(failoverView("ask"));
    expect(res.failover.editable).toBe(false);
    expect(res.failover.options.find((o) => o.chosen)?.label).toBe("Ask me first");
    expect(res.computer?.text).toBe("This computer · Online");
    expect(overview).toHaveBeenCalledTimes(1);
  });

  it("lists projects an older server only knows from chats", () => {
    expect(
      projectViews([], [item({ thisComputer: false })]).map((p) => [p.name, p.runsOn]),
    ).toEqual([["Prism", "Nickron PC"]]);
    expect(chatRow(item({ unread: true, unreadCount: 3 })).unreadCount).toBe(3);
  });
});

describe("usage reset time (§5)", () => {
  it("is shown only when the provider reported it", () => {
    const at = "2026-09-29T14:30:00.000Z";
    const [c, x] = healthViews({
      teamProviders: [
        { provider: "claude-code", health: "ready", healthCheckedAt: new Date().toISOString() },
        { provider: "codex", health: "usage_exhausted", resetsAt: at },
      ],
    });
    expect(c!.resetsAt).toBeUndefined();
    expect(x!.resetsAt).toBe(at);
    const [, y] = healthViews({
      teamProviders: [{ provider: "codex", health: "usage_exhausted" }],
    });
    expect(y!.resetsAt).toBeUndefined();
  });
});

describe("0.11 server routes: choices, failover, live subject", () => {
  it("decides a shown choice by key through the choices route (any non-approval option)", async () => {
    const decideChoice = vi.fn(async () => ({
      ok: true as const,
      choiceId: CHOICE,
      kind: "usage_exhausted",
      status: "chosen" as const,
      chosenKey: "check_again",
      chosenLabel: "Check Codex again",
      replayed: false,
      startedJobId: null,
    }));
    const post = vi.fn();
    const api = {
      getChat: vi.fn(async () => ({ ...(item() as object), lastReadSeq: 0 })),
      events: vi.fn(async () => ({
        events: [usageChoice(8)],
        cursor: 8,
        hasOlder: false,
        activeJob: null,
        live: [],
      })),
      post,
      decideChoice,
      listChats: vi.fn(async () => []),
      markRead: vi.fn(),
      createChat: vi.fn(),
    };
    const svc = new ChatService(async () => api as never, Date.now, PRESENT);
    await svc.open(CHAT);
    expect(await svc.answer(CHAT, CHOICE, "check_again", "key-00000001")).toEqual({
      ok: true,
      routed: "choice_resolved",
      chosenLabel: "Check Codex again",
    });
    expect(decideChoice).toHaveBeenCalledWith(CHAT, CHOICE, "check_again");
    expect(post).not.toHaveBeenCalled();
    // A refusal is the server's fixed sentence, cleaned.
    decideChoice.mockResolvedValueOnce({
      ok: false,
      reason: "other_computer",
      message: "This chat runs on another computer.\u001b[2J",
    } as never);
    await svc.open(CHAT);
    expect(await svc.answer(CHAT, CHOICE, "wait", "key-00000002")).toEqual({
      ok: false,
      error: "failed",
      message: "This chat runs on another computer.",
    });
  });

  it("changes the failover preference through main, validated", async () => {
    const setFailoverPolicy = vi.fn(async (p: string) => p);
    const svc = new ChatService(async () => ({ setFailoverPolicy }) as never);
    expect(await svc.setFailover("never")).toEqual({ ok: false, error: "invalid" });
    const res = await svc.setFailover("wait");
    expect(res).toEqual({ ok: true, failover: failoverView("wait", true) });
    expect(setFailoverPolicy).toHaveBeenCalledWith("wait");
    const old = new ChatService(async () => ({}) as never);
    expect(await old.setFailover("ask")).toEqual({ ok: false, error: "unavailable" });
  });

  it("shows the live row's subject (fixed words) when the server sends one", () => {
    const view = pageView(
      {
        events: [],
        cursor: 0,
        hasOlder: false,
        hasNewer: false,
        oldestCursor: null,
        activeJob: null,
        live: [
          {
            runId: "r",
            provider: "codex",
            providerName: "Codex",
            role: "reviewer",
            activity: "tool_use",
            subject: "Reviewing",
            startedAt: null,
            lastActivityAt: null,
          },
        ],
        hostPresence: "working",
      } as never,
      [codex],
      PRESENT,
    );
    expect(view.live[0]).toMatchObject({ label: "Codex · reviewer", activity: "Reviewing" });
    expect(view.hostPresence).toBe("working");
  });

  it("main and the preload wire the failover setting", () => {
    expect(MAIN_TS).toMatch(/ipcMain\.handle\("settings:failover"/);
    expect(PRELOAD).toContain('"settings:failover"');
  });
});

describe("the IPC surface (0.11)", () => {
  it("adds validated channels for overview, create, lanes and choice answers", () => {
    for (const ch of ["chats:overview", "chat:create", "chat:answer"]) {
      expect(MAIN_TS).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*"${ch}"`));
      expect(PRELOAD).toContain(`"${ch}"`);
    }
    expect(MAIN_TS).toContain("chats.answer(chatId, choiceId, option, key)");
    expect(PRELOAD).not.toMatch(/token|chatClientFor|Authorization/i);
    // The renderer names an option by key; it never supplies the words.
    expect(PRELOAD).toMatch(
      /answerChoice: \(chatId: string, choiceId: string, option: string, idempotencyKey: string\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

type Bridge = Record<string, ReturnType<typeof vi.fn>>;
let bridge: Bridge;
let polls: unknown[];
let nextPages: unknown[];

function appState() {
  const snap = {
    status: "online",
    detail: null,
    identity: { label: "Nickron PC", platform: "windows", kind: "desktop" },
    runtime: { runtimeId: "tlrun_1", label: "Nickron PC" },
    providers: [{ id: "claude-code", name: "Claude Code", available: true }],
    workspaces: [],
    pendingLinks: [],
    activity: [],
    team: [],
    teamProviders: [
      {
        provider: "claude-code",
        installed: true,
        health: "ready",
        healthCheckedAt: new Date().toISOString(),
        models: [],
      },
      {
        provider: "codex",
        installed: true,
        health: "usage_exhausted",
        resetsAt: "2026-09-29T14:30:00.000Z",
        models: [],
      },
    ],
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
    work: [],
    agentsLine: "1 agent ready",
    host: {
      label: "Nickron PC",
      platform: "windows",
      online: true,
      version: "0.11.0",
      protocol: 11,
      updateRequired: false,
      updateText: null,
    },
  };
}

function page(events: unknown[], over: Record<string, unknown> = {}) {
  return {
    ...pageView(
      {
        events,
        cursor: 20,
        hasOlder: false,
        hasNewer: false,
        oldestCursor: 1,
        activeJob: null,
        live: [],
      } as never,
      [claude, codex],
      PRESENT,
    ),
    ...over,
  };
}

function mount(opts: { header?: unknown; first?: unknown } = {}) {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  polls = [];
  nextPages = [];
  const header = opts.header ?? chatHeader(item(), null);
  bridge = {
    getState: vi.fn(async () => appState()),
    onState: vi.fn(),
    checkProviders: vi.fn(async () => ({ ok: true, providers: [] })),
    getPlans: vi.fn(async () => ({ ok: false, error: "unavailable" })),
    openDashboard: vi.fn(),
    openExternal: vi.fn(),
    openLogs: vi.fn(),
    setSettings: vi.fn(),
    chatsOverview: vi.fn(async () => ({
      ok: true,
      sections: [
        {
          title: "Recent",
          rows: [
            chatRow(item({ unread: true, unreadCount: 2 })),
            chatRow(item({ chatId: CHAT2, name: "Other", needsAttention: true })),
          ],
        },
      ],
      projects: projectViews(
        [{ roomId: ROOM, name: "Prism", runtimeLabel: "Nickron PC", thisComputer: true }],
        [item()],
      ),
      projectChoices: [{ roomId: ROOM, name: "Prism" }],
      total: 2,
      unread: 1,
      needsYou: [chatRow(item({ chatId: CHAT2, name: "Other", needsAttention: true }))],
      failover: failoverView("auto"),
      computer: hostPresenceView({
        runtimeLabel: "Nickron PC",
        runtimeOnline: true,
        thisComputer: true,
        hostPresence: "online",
      }),
    })),
    openChat: vi.fn(async () => ({
      ok: true,
      chat: header,
      page:
        opts.first ??
        page([
          ev(1, { authorKind: "owner", authorProvider: null, body: "@codex review auth" }),
          ev(2, {
            authorKind: "threadlink",
            authorProvider: null,
            eventType: "job_started",
            body: "Started the job.",
          }),
          ev(3, { body: "Looks fine." }),
          ev(4, { body: "One more thing." }),
          ev(5, {
            authorKind: "threadlink",
            authorProvider: null,
            eventType: "finding",
            body: "Blocking finding",
            payload: { severity: "blocking", status: "open", title: "Token in logs" },
          }),
        ]),
    })),
    chatEvents: vi.fn(async (_id: string, p: unknown) => {
      polls.push(p);
      return { ok: true, page: nextPages.shift() ?? page([], { cursor: 20 }) };
    }),
    sendChat: vi.fn(async () => ({ ok: true, routed: "new_job" })),
    answerChoice: vi.fn(async () => ({
      ok: true,
      routed: "choice_resolved",
      chosenLabel: "Continue with Claude",
    })),
    markChatRead: vi.fn(async () => ({ ok: true })),
    createChat: vi.fn(async () => ({
      ok: true,
      chat: chatRow(item({ chatId: CHAT2, name: "New one" })),
    })),
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

async function openChat(opts: Parameters<typeof mount>[0] = {}) {
  mount(opts);
  await settle();
  await navTo("Chats");
  await settle();
  (document.querySelector(".chat-row") as HTMLButtonElement).dispatchEvent(new Event("click"));
  await settle();
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("the same places as the web", () => {
  it("has one shadcn-style sidebar: Workspace, Projects, Settings", async () => {
    mount();
    await settle();
    const labels = [...document.querySelectorAll("#nav .nav-item")].map((b) =>
      b.querySelector(".sb-text")?.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Home",
      "Chats",
      "Agents",
      "Notifications",
      "This computer",
      "Projects",
      "Settings",
    ]);
    // Unread and needs-you counts, the same state as the web.
    const chats = document.querySelector('#nav .nav-item[data-section="chats"]')!;
    expect(chats.querySelector(".count")?.textContent).toBe("1");
    const alerts = document.querySelector('#nav .nav-item[data-section="notifications"]')!;
    expect(alerts.querySelector(".count")?.textContent).toBe("1");
    // The chats sub-list, with the unread pill; the search filters it.
    const subs = [...document.querySelectorAll("#nav .sb-sub")].map((b) => b.textContent);
    expect(subs[0]).toBe("Prism Review2");
    const search = document.getElementById("sb-search") as HTMLInputElement;
    search.value = "oth";
    search.dispatchEvent(new Event("input"));
    expect(
      [...document.querySelectorAll("#nav .sb-subs .sb-sub")].map((b) => b.textContent),
    ).toEqual(["Other"]);
    // Icons are real SVG elements built with DOM APIs.
    expect(chats.querySelector("svg path")).toBeTruthy();
  });

  it("Home shows You and this computer separately", async () => {
    mount();
    await settle();
    const presence = document.getElementById("home-presence")?.textContent ?? "";
    expect(presence).toContain("You · Connected");
    expect(presence).toContain("This computer · Online");
    expect(viewText()).not.toContain("Protocol");
  });

  it("Projects lists each project with where it runs and its chats", async () => {
    mount();
    await settle();
    await navTo("Projects");
    expect(viewText()).toContain("Runs on This computer");
    expect(viewText()).toContain("Prism Review");
  });

  it("Notifications lists what needs you", async () => {
    mount();
    await settle();
    await navTo("Notifications");
    expect(document.getElementById("needs-you")?.textContent).toContain("Other");
  });

  it("Settings shows the failover preference read-only, changed on the web", async () => {
    mount();
    await settle();
    await navTo("Settings");
    const box = document.getElementById("failover")!;
    expect(box.textContent).toContain("Continue with another included agent (default)");
    expect(box.textContent).toContain("Ask me first");
    expect(box.textContent).toContain("Wait for the same agent");
    const radios = [...box.querySelectorAll("input")] as HTMLInputElement[];
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect(radios[0]!.checked).toBe(true);
    document.getElementById("failover-web")!.dispatchEvent(new Event("click"));
    expect(bridge.openExternal).toHaveBeenCalledWith(
      "https://threadlink.example/dashboard/settings",
    );
  });

  it("Agents shows usage exhausted with the reported reset time", async () => {
    mount();
    await settle();
    await navTo("Agents");
    expect(viewText()).toContain("Codex — Usage limit reached");
    expect(document.querySelector(".health-resets")?.textContent).toMatch(/^Resets /);
  });

  it("This computer holds the runtime version, protocol and presence", async () => {
    mount();
    await settle();
    await navTo("This computer");
    expect(viewText()).toContain("Version 0.11.0");
    expect(document.getElementById("runtime-presence")?.textContent).toContain("You · Connected");
  });
});

describe("an open chat (the web layout)", () => {
  it("has a compact header, one scroll surface and a sticky composer", async () => {
    await openChat();
    expect(document.getElementById("shell")?.className).toBe("shell chat-route");
    expect(document.getElementById("chat-title")?.textContent).toBe("Prism Review");
    expect(document.getElementById("chat-mode")?.textContent).toBe("TEAM");
    expect(document.getElementById("chat-sub")?.textContent).toBe("Prism · Claude · Codex");
    expect(document.getElementById("chat-status-text")?.textContent).toBe("Ready");
    // Only the timeline scrolls on the chat route.
    expect(CSS).toMatch(/\.shell\.chat-route \.view \{\s*overflow: hidden;/);
    expect(CSS).toMatch(/\.chat-timeline \{[^}]*overflow-y: auto;/);
    expect(CSS).not.toMatch(/max-height: calc\(100vh - 300px\)/);
  });

  it("keeps routine rows out of the timeline and in the drawer's Activity", async () => {
    await openChat();
    const seqs = [...document.querySelectorAll("#chat-events .msg")].map(
      (m) => (m as HTMLElement).dataset.seq,
    );
    expect(seqs).toEqual(["1", "3", "4", "5"]);
    expect(document.getElementById("chat-events")?.textContent).not.toContain("Started the job");
    document.getElementById("chat-status")!.dispatchEvent(new Event("click"));
    await settle();
    const tabs = [...document.querySelectorAll(".drawer-tab")].map((t) => t.textContent);
    expect(tabs).toEqual(["Activity", "Progress", "Findings", "Details", "Provenance"]);
    (document.querySelectorAll(".drawer-tab")[0] as HTMLElement).dispatchEvent(new Event("click"));
    expect(document.getElementById("drawer-body")?.textContent).toContain("Started the job");
    (document.querySelectorAll(".drawer-tab")[2] as HTMLElement).dispatchEvent(new Event("click"));
    expect(document.getElementById("drawer-body")?.textContent).toContain("Token in logs");
    (document.querySelectorAll(".drawer-tab")[3] as HTMLElement).dispatchEvent(new Event("click"));
    const details = document.getElementById("drawer-body")?.textContent ?? "";
    expect(details).toContain("Connected");
    expect(details).toContain("Nickron PC · Online");
    expect(details).toContain("Claude Code, Codex");
  });

  it("puts you on the right and agents on the left with an initial, grouped", async () => {
    await openChat();
    const [you, a, b] = [...document.querySelectorAll("#chat-events .msg")] as HTMLElement[];
    expect(you!.classList.contains("side-right")).toBe(true);
    expect(you!.querySelector(".avatar")).toBeNull();
    expect(a!.classList.contains("side-left")).toBe(true);
    expect(a!.querySelector(".avatar")?.textContent).toBe("X");
    expect(a!.dataset.provider).toBe("codex");
    expect(a!.querySelector(".msg-who")?.textContent).toBe("Codex");
    expect(b!.classList.contains("cont")).toBe(true);
  });

  it("answers a usage choice with its own buttons, never 'Retry Codex'", async () => {
    await openChat({ first: page([usageChoice(8)]) });
    const buttons = [...document.querySelectorAll(".choice-card button")].map((b) => b.textContent);
    expect(buttons).toEqual([
      "Continue with Claude",
      "Check Codex again",
      "Wait for Codex",
      "Stop",
    ]);
    expect(viewText()).not.toContain("Retry Codex");
    (
      document.querySelector('.choice-card button[data-option="continue_other"]') as HTMLElement
    ).dispatchEvent(new Event("click"));
    await settle();
    const call = bridge.answerChoice!.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual([CHAT, CHOICE, "continue_other"]);
    expect(document.querySelector(".choice-card")?.textContent).toContain(
      "Answered: Continue with Claude",
    );
    expect(document.querySelectorAll(".choice-card button")).toHaveLength(0);
  });

  it("sends approvals to the web card", async () => {
    await openChat({
      first: page([
        ev(8, {
          authorKind: "threadlink",
          eventType: "choice",
          payload: {
            choiceId: CHOICE,
            kind: "migration",
            title: "Apply the migration?",
            options: [{ key: "approve", label: "Approve" }],
          },
        }),
      ]),
    });
    const button = document.querySelector(".choice-card button") as HTMLElement;
    expect(button.textContent).toBe("Decide in ThreadLink on the web");
    button.dispatchEvent(new Event("click"));
    expect(bridge.openExternal).toHaveBeenCalledWith(
      `https://threadlink.example/dashboard/chats/${CHAT}`,
    );
    expect(bridge.answerChoice).not.toHaveBeenCalled();
  });

  it("updates a card when a poll says the choice was decided", async () => {
    await openChat({ first: page([usageChoice(8)]) });
    nextPages.push({ ...page([]), resolved: [{ choiceId: CHOICE, label: "Wait for Codex" }] });
    (document.getElementById("chat-input") as HTMLTextAreaElement).value = "wait";
    document.getElementById("chat-send")!.dispatchEvent(new Event("click"));
    await settle();
    expect(document.querySelector(".choice-card")?.textContent).toContain(
      "Answered: Wait for Codex",
    );
  });

  it("sends the lane only when the owner picked one, then goes back to Auto", async () => {
    await openChat();
    const lanes = [...document.querySelectorAll(".lane-option")] as HTMLElement[];
    expect(lanes.map((l) => l.textContent)).toEqual(["Auto", "Chat only", "Run work"]);
    expect(lanes[0]!.getAttribute("aria-checked")).toBe("true");
    lanes[2]!.dispatchEvent(new Event("click"));
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    input.value = "fix the login bug";
    document.getElementById("chat-send")!.dispatchEvent(new Event("click"));
    await settle();
    input.value = "thanks";
    document.getElementById("chat-send")!.dispatchEvent(new Event("click"));
    await settle();
    const [a, b] = bridge.sendChat!.mock.calls;
    expect(a!.slice(0, 2)).toEqual([CHAT, "fix the login bug"]);
    expect(a![3]).toBe("work");
    expect(b).toHaveLength(3);
    expect(document.querySelector('.lane-option[aria-checked="true"]')?.textContent).toBe("Auto");
  });

  it("autocompletes @mentions from the chat's agents", async () => {
    await openChat();
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    input.value = "@co";
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input"));
    const list = document.getElementById("mention-list")!;
    expect(list.hidden).toBe(false);
    expect(list.textContent).toContain("@codex · Codex");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("@codex ");
    expect(bridge.sendChat).not.toHaveBeenCalled();
  });

  it("Enter sends and Shift+Enter does not", async () => {
    await openChat();
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    await settle();
    expect(bridge.sendChat).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(bridge.sendChat).toHaveBeenCalledTimes(1);
  });

  it("shows Jump to latest instead of pulling you down while you read", async () => {
    await openChat();
    const box = document.getElementById("chat-timeline")!;
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(box, "clientHeight", { configurable: true, value: 400 });
    box.scrollTop = 100;
    nextPages.push(page([ev(21, { body: "new one" }), ev(22, { body: "and another" })]));
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    // A poll (not a send) brings the new rows.
    await (async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 2100));
      await settle();
    })();
    expect(box.scrollTop).toBe(100);
    const pill = document.getElementById("chat-jump")!;
    expect(pill.hidden).toBe(false);
    expect(pill.textContent?.trim()).toBe("Jump to latest · 2 new");
    pill.dispatchEvent(new Event("click"));
    expect(box.scrollTop).toBe(2000);
    expect(pill.hidden).toBe(true);
    expect(input).toBeTruthy();
  });

  it("shows Stop while work runs and says when the host is offline", async () => {
    await openChat({
      header: chatHeader(item({ hostPresence: "offline" }), null),
      first: page([ev(1)], { working: true }),
    });
    expect((document.getElementById("chat-stop") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("chat-status-text")?.textContent).toBe("Nickron PC offline");
    expect(document.getElementById("chat-offline")?.textContent).toBe(
      "You're connected. Nickron PC is offline — repository work and agent replies will resume when it reconnects.",
    );
    document.getElementById("chat-stop")!.dispatchEvent(new Event("click"));
    await settle();
    expect(bridge.sendChat!.mock.calls[0]!.slice(0, 2)).toEqual([CHAT, "stop"]);
  });

  it("starts a new chat from the list", async () => {
    mount();
    await settle();
    await navTo("Chats");
    document.getElementById("new-chat")!.dispatchEvent(new Event("click"));
    (document.getElementById("new-chat-name") as HTMLInputElement).value = "New one";
    (document.getElementById("new-chat-project") as HTMLSelectElement).value = ROOM;
    const create = [...document.querySelectorAll("#new-chat-form button")].find(
      (b) => b.textContent === "Create",
    )!;
    create.dispatchEvent(new Event("click"));
    await settle();
    expect(bridge.createChat).toHaveBeenCalledWith({ name: "New one", roomId: ROOM, mode: "team" });
    expect(bridge.openChat).toHaveBeenCalledWith(CHAT2);
  });
});

describe("0.11 routes in the renderer", () => {
  it("makes the failover setting editable and shows what was stored", async () => {
    mount();
    const overview = bridge.chatsOverview!.getMockImplementation()! as (
      ...a: unknown[]
    ) => Promise<unknown>;
    bridge.chatsOverview = vi.fn(async (...a: unknown[]) => ({
      ...((await overview(...a)) as object),
      failover: failoverView("auto", true),
    }));
    bridge.setFailover = vi.fn(async () => ({ ok: true, failover: failoverView("ask", true) }));
    await settle();
    await navTo("Settings");
    await settle();
    const radios = () => [...document.querySelectorAll("#failover input")] as HTMLInputElement[];
    expect(radios().every((r) => !r.disabled)).toBe(true);
    expect(document.getElementById("failover-web")).toBeNull();
    radios()[1]!.checked = true;
    radios()[1]!.dispatchEvent(new Event("change"));
    await settle();
    expect(bridge.setFailover).toHaveBeenCalledWith("ask");
    expect(radios()[1]!.checked).toBe(true);
    expect(document.querySelector(".failover-note")?.textContent).toBe("Saved");
  });

  it("takes the host presence from chat pages over the header's", async () => {
    // The header (chat read) said online; the events page says offline now.
    await openChat({ first: page([ev(1)], { hostPresence: "offline" }) });
    expect(document.getElementById("chat-status-text")?.textContent).toBe("Nickron PC offline");
    expect((document.getElementById("chat-offline") as HTMLElement).hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Appearance (the approved canvas): theme, backdrop, motion
// ---------------------------------------------------------------------------

describe("appearance settings", () => {
  it("accepts only allow-listed keys and values from the renderer", () => {
    expect(
      validSettingsPatch({
        theme: "dark",
        backdrop: "grid",
        animate: false,
        autoStart: true,
        evil: "<script>",
      }),
    ).toEqual({ theme: "dark", backdrop: "grid", animate: false, autoStart: true });
    expect(validSettingsPatch({ theme: "neon", backdrop: "url(x)", animate: "yes" })).toEqual({});
    expect(validSettingsPatch(null)).toEqual({});
    expect(DEFAULT_SETTINGS).toMatchObject({ theme: "system", backdrop: "dusk", animate: true });
    expect(MAIN_TS).toContain("saveSettings(ctx.configDir, validSettingsPatch(patch))");
  });

  it("applies theme, backdrop and motion at once, and saves through main", async () => {
    mount();
    await settle();
    const root = document.documentElement;
    expect(root.dataset.backdrop).toBe("dusk");
    expect(root.classList.contains("bg-still")).toBe(false);
    await navTo("Settings");
    const pick = (group: string, value: string) => {
      const input = document.querySelector(`#${group} input[value="${value}"]`) as HTMLInputElement;
      input.checked = true;
      input.dispatchEvent(new Event("change"));
    };
    pick("set-theme", "dark");
    expect(root.classList.contains("dark")).toBe(true);
    pick("set-theme", "light");
    expect(root.classList.contains("dark")).toBe(false);
    pick("set-backdrop", "aurora");
    expect(root.dataset.backdrop).toBe("aurora");
    const animate = document.getElementById("set-animate") as HTMLInputElement;
    expect(animate.checked).toBe(true);
    animate.checked = false;
    animate.dispatchEvent(new Event("change"));
    expect(root.classList.contains("bg-still")).toBe(true);
    expect(bridge.setSettings!.mock.calls).toEqual([
      [{ theme: "dark" }],
      [{ theme: "light" }],
      [{ backdrop: "aurora" }],
      [{ animate: false }],
    ]);
  });

  it("pauses every animation while the window is hidden", async () => {
    mount();
    await settle();
    const root = document.documentElement;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.classList.contains("bg-paused")).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.classList.contains("bg-paused")).toBe(false);
  });

  it("keeps the backdrop cheap: its own fixed layer, transform/opacity only, off for reduced motion", () => {
    expect(HTML).toMatch(/<div id="backdrop" class="backdrop" aria-hidden="true">/);
    const block = (name: string) => {
      const start = CSS.indexOf(`@keyframes ${name} {`);
      let depth = 0;
      for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
        if (CSS[i] === "{") depth++;
        if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i + 1);
      }
      return "";
    };
    for (const name of ["tlDriftA", "tlDriftB", "tlDriftC", "tlPing", "tlFloat", "tlBeat"]) {
      const body = block(name);
      expect(body, name).not.toBe("");
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(new Set(props), name).toEqual(
        new Set(props.filter((p) => p === "transform" || p === "opacity")),
      );
    }
    expect(CSS).toMatch(
      /\.backdrop \{[^}]*position: fixed;[^}]*pointer-events: none;[^}]*contain: strict;/,
    );
    expect(CSS).toMatch(/\.bd-field \{[^}]*will-change: transform;/);
    expect(CSS).not.toMatch(/\.bd-field[^{]*\{[^}]*filter:/);
    expect(CSS).toMatch(/:root\.bg-paused \.bd-field/);
    expect(CSS).toMatch(/:root\.bg-still \.bd-field/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.bd-field/);
    // Light and dark tokens from the canvas.
    expect(CSS).toMatch(/:root \{\s*--bg: #ffffff;/);
    expect(CSS).toMatch(/:root\.dark \{\s*--bg: #0e0e13;/);
  });

  it("collapses the sidebar from the inset's toggle", async () => {
    mount();
    await settle();
    document.getElementById("sidebar-toggle")!.dispatchEvent(new Event("click"));
    expect(document.getElementById("shell")!.classList.contains("sidebar-collapsed")).toBe(true);
    document.getElementById("sidebar-toggle")!.dispatchEvent(new Event("click"));
    expect(document.getElementById("shell")!.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("This computer shows the stat cards and keeps folder paths off the page", async () => {
    mount();
    await settle();
    await navTo("This computer");
    const stats = [...document.querySelectorAll("#runtime-stats .stat")].map(
      (s) => s.querySelector(".stat-label")?.textContent,
    );
    expect(stats).toEqual(["Status", "ThreadLink app", "Agents here"]);
    expect(document.getElementById("runtime-stats")?.textContent).toContain("Up to date");
    expect(document.getElementById("runtime-stats")?.textContent).toContain("1 of 2 ready");
    expect(document.getElementById("pc-name")?.textContent).toBe("Nickron PC");
  });
});
