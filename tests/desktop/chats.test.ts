// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bodyView,
  chatHeader,
  chatRow,
  chatSections,
  ChatService,
  chatState,
  cleanText,
  eventView,
  hueOf,
  identityOf,
  liveView,
  RateLimiter,
  splitBlocks,
  validBody,
  validChatId,
  validKey,
  validPage,
} from "../../desktop/src/chats.ts";
import { agentsSummary, freshnessOf, healthView, healthViews } from "../../desktop/src/health.ts";
import { hostView } from "../../desktop/src/model.ts";

/**
 * 0.10 desktop: Chats (list + the same server timeline as the web), Agents →
 * <provider>, This computer, and one health-freshness rule. The chat API is a
 * fake here; the renderer is the real one, driven through a fake bridge.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const HTML = readFileSync(join(ROOT, "desktop", "renderer", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "desktop", "renderer", "app.js"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "desktop", "src", "main.ts"), "utf8");
const PRELOAD = readFileSync(join(ROOT, "desktop", "src", "preload.cts"), "utf8");

const CHAT = `tlcht_${"a".repeat(32)}`;
const CHAT2 = `tlcht_${"b".repeat(32)}`;
const ROOM = `tlrom_${"c".repeat(32)}`;

const claude = {
  kind: "agent" as const,
  provider: "claude-code",
  name: "Claude Code",
  shortName: "Claude",
  health: "ready",
  healthCheckedAt: null,
};
const codex = { ...claude, provider: "codex", name: "Codex", shortName: "Codex" };
const owner = { ...claude, kind: "owner" as const, provider: null, name: "You", shortName: "You" };

function item(over: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    name: "Prism Review",
    mode: "team" as const,
    roomId: ROOM,
    projectName: "Prism",
    pinned: false,
    archived: false,
    participants: [owner, claude, codex],
    lastMessage: null,
    lastActivityAt: "2026-09-26T10:00:00.000Z",
    unread: false,
    needsAttention: false,
    activeJob: null,
    runtimeLabel: "Nickron's PC",
    runtimeOnline: true,
    ...over,
  };
}

function ev(seq: number, over: Record<string, unknown> = {}) {
  return {
    seq,
    id: `tlcev_${seq}`,
    createdAt: "2026-09-26T10:00:00.000Z",
    authorKind: "agent" as const,
    authorProvider: "codex",
    authorLabel: "Codex",
    authorRole: "reviewer",
    audience: null,
    eventType: "agent_message",
    messageType: "review",
    body: `message ${seq}`,
    visibility: "visible" as const,
    delivery: null,
    client: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

describe("chat list rows", () => {
  it("shows name, project, mode badge, participants from metadata and state", () => {
    expect(chatRow(item() as never)).toMatchObject({
      name: "Prism Review",
      project: "Prism",
      modeBadge: "TEAM",
      participants: "Claude Code + Codex",
      state: "Ready",
    });
    expect(
      chatState({
        needsAttention: false,
        activeJob: { jobId: "j", mode: "team", status: "building" },
      }),
    ).toBe("Working");
    expect(chatState({ needsAttention: true, activeJob: null })).toBe("Needs you");
    expect(
      chatState({
        needsAttention: false,
        activeJob: { jobId: "j", mode: "team", status: "completed" },
      }),
    ).toBe("Ready");
  });

  it("names an unknown provider from its metadata, never a switch", () => {
    const cursor = { ...claude, provider: "cursor", name: "Cursor", shortName: "Cursor" };
    expect(chatRow(item({ participants: [cursor] }) as never).participants).toBe("Cursor");
  });

  it("groups pinned first, then recent or by project, bounded", () => {
    const chats = [
      item({ chatId: CHAT, name: "A", pinned: true }),
      item({ chatId: CHAT2, name: "B", projectName: null, roomId: null }),
      item({
        chatId: `tlcht_${"d".repeat(32)}`,
        name: "C",
        lastActivityAt: "2026-09-26T11:00:00.000Z",
      }),
    ] as never[];
    expect(chatSections(chats, "recent").map((s) => [s.title, s.rows.map((r) => r.name)])).toEqual([
      ["Pinned", ["A"]],
      ["Recent", ["C", "B"]],
    ]);
    expect(chatSections(chats, "project").map((s) => [s.title, s.rows.map((r) => r.name)])).toEqual(
      [
        ["Pinned", ["A"]],
        ["Prism", ["C"]],
        ["No project", ["B"]],
      ],
    );
    const many = Array.from({ length: 80 }, (_, i) =>
      item({ chatId: `tlcht_${i.toString(16).padStart(32, "0")}`, name: `n${i}` }),
    ) as never[];
    expect(chatSections(many, "recent")[0]!.rows).toHaveLength(50);
  });

  it("builds the header 'Prism · Team · Claude Code + Codex' and the host line", () => {
    expect(chatHeader(item() as never)).toMatchObject({
      name: "Prism Review",
      sub: "Prism · Team · Claude Code + Codex",
      host: "Runs on Nickron's PC · online",
    });
  });
});

describe("identities", () => {
  it("styles You, the controller, ThreadLink and each agent by metadata", () => {
    const parts = [claude, codex];
    expect(identityOf(ev(1, { authorKind: "owner" }) as never, parts)).toMatchObject({
      kind: "you",
      label: "You",
    });
    expect(
      identityOf(ev(1, { authorKind: "controller", authorLabel: "ChatGPT" }) as never, parts),
    ).toMatchObject({
      kind: "controller",
      label: "ChatGPT",
    });
    expect(identityOf(ev(1, { authorKind: "threadlink" }) as never, parts).label).toBe(
      "ThreadLink",
    );
    expect(identityOf(ev(1) as never, parts)).toMatchObject({
      kind: "agent",
      label: "Codex · reviewer",
      hue: hueOf("codex"),
    });
  });

  it("names an unknown provider neutrally, with a stable colour", () => {
    const id = identityOf(
      ev(1, { authorProvider: "gemini-cli", authorLabel: "", authorRole: null }) as never,
      [],
    );
    expect(id.label).toBe("Agent (gemini-cli)");
    expect(id.hue).toBe(hueOf("gemini-cli"));
    expect(hueOf("gemini-cli")).toBeGreaterThanOrEqual(0);
    expect(hueOf("gemini-cli")).toBeLessThan(6);
  });

  it("describes delivery states for the owner's own messages only", () => {
    const mine = eventView(
      ev(2, { authorKind: "owner", delivery: { state: "queued", for: ["Codex"] } }) as never,
      [],
    );
    expect(mine.delivery).toBe("Queued for Codex");
    expect(
      eventView(ev(3, { delivery: { state: "seen", by: ["Codex"] } }) as never, []).delivery,
    ).toBeNull();
  });

  it("shows a live row for a running run", () => {
    expect(
      liveView(
        {
          runId: "tlarn_1",
          provider: "claude-code",
          providerName: null,
          role: "builder",
          activity: "building",
          startedAt: null,
          lastActivityAt: null,
        },
        [claude],
      ),
    ).toMatchObject({ label: "Claude Code · builder", activity: "building" });
  });
});

describe("rendering safety of bodies", () => {
  it("strips ANSI, control characters and bidi overrides", () => {
    const raw = "\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0000\u0007 \u202eevil";
    expect(cleanText(raw)).toBe("red ok evil");
  });

  it("keeps code blocks preformatted and separate", () => {
    expect(splitBlocks("Look:\n```ts\nconst a = 1;\n```\nDone")).toEqual([
      { t: "text", v: "Look:" },
      { t: "code", v: "const a = 1;" },
      { t: "text", v: "Done" },
    ]);
  });

  it("collapses huge bodies and caps what it holds", () => {
    const huge = "x".repeat(200_000);
    const v = bodyView(huge);
    expect(v.collapsed).toBe(true);
    expect(v.truncated).toBe(true);
    expect(JSON.stringify(v.preview).length).toBeLessThan(2_000);
    expect(bodyView("short").collapsed).toBe(false);
    const tall = bodyView(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    expect(tall.collapsed).toBe(true);
    expect(tall.truncated).toBe(false);
  });
});

describe("health freshness (one calculation)", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  it("says Ready · checked 23 s ago only while fresh", () => {
    expect(healthView("codex", "ready", "2026-09-26T11:59:37Z", now).status).toBe(
      "Ready · checked 23 s ago",
    );
    const stale = healthView("codex", "ready", "2026-09-26T09:50:00Z", now);
    expect(stale.status).toBe("Stale · last checked 2 h ago");
    expect(stale.line).toBe("Codex — Stale");
    expect(stale.fresh).toBe("stale");
    // Never Ready with stale words.
    for (const at of ["2026-09-26T09:00:00Z", null]) {
      const v = healthView("codex", "ready", at, now);
      expect(v.text === "Ready" && /Stale|last checked|not checked/.test(v.status)).toBe(false);
    }
  });

  it("keeps problems as they are, with when they were seen", () => {
    expect(freshnessOf("needs_sign_in", "2026-09-26T11:58:00Z", now)).toMatchObject({
      fresh: "problem",
      text: "Needs sign-in",
      when: "checked 2 min ago",
    });
    expect(freshnessOf("unknown", null, now)).toMatchObject({ fresh: "unknown", when: null });
  });

  it("summarises agents without ever saying Claude is open", () => {
    const views = healthViews(
      {
        teamProviders: [
          {
            provider: "claude-code",
            health: "ready",
            healthCheckedAt: new Date(now - 1000).toISOString(),
          },
          {
            provider: "codex",
            health: "ready",
            healthCheckedAt: new Date(now - 1000).toISOString(),
          },
        ],
      },
      now,
    );
    expect(agentsSummary(views, 0)).toBe("2 agents ready");
    expect(agentsSummary(views, 1)).toBe("1 agent working");
    expect(agentsSummary([], 0)).toBe("Execution host online");
  });
});

describe("This computer", () => {
  it("shows the host, version and protocol, and a friendly update notice", () => {
    const snap = {
      status: "online",
      runtime: { label: "Nickron", minProtocol: 10 },
      identity: { platform: "windows" },
    };
    expect(hostView(snap, { version: "0.10.0", protocol: 10 })).toMatchObject({
      label: "Nickron",
      online: true,
      updateRequired: false,
      updateText: null,
    });
    const old = hostView(snap, { version: "0.9.0", protocol: null });
    expect(old.updateRequired).toBe(true);
    expect(old.updateText).toBe(
      "ThreadLink on Nickron needs an update before Team work can start.",
    );
  });
});

// ---------------------------------------------------------------------------
// IPC validation and the service
// ---------------------------------------------------------------------------

describe("IPC validation", () => {
  it("accepts only allow-listed shapes", () => {
    expect(validChatId(CHAT)).toBe(CHAT);
    for (const bad of ["tlcht_x", `${CHAT}/../x`, 5, null, {}, `tlrom_${"a".repeat(32)}`]) {
      expect(validChatId(bad)).toBeNull();
    }
    expect(validKey("abcdefgh-1234")).toBe("abcdefgh-1234");
    expect(validKey("short")).toBeNull();
    expect(validKey("has space in it")).toBeNull();
    expect(validBody("  hi  ")).toBe("hi");
    expect(validBody("   ")).toBeNull();
    expect(validBody("x".repeat(4001))).toBeNull();
    expect(validBody("x".repeat(4000))).toHaveLength(4000);
    expect(validBody(42)).toBeNull();
    expect(validPage(undefined)).toEqual({});
    expect(validPage({ after: 5 })).toEqual({ after: 5 });
    expect(validPage({ before: 7 })).toEqual({ before: 7 });
    expect(validPage({ after: -1 })).toBeNull();
    expect(validPage({ after: 1, before: 2 })).toBeNull();
    expect(validPage({ limit: 1000 })).toBeNull();
    expect(validPage([1])).toBeNull();
  });

  it("rate-limits per operation and key", () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.take("a"), r.take("a"), r.take("a"), r.take("b")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(r.take("a")).toBe(true);
  });
});

function fakeApi() {
  const calls: { op: string; args: unknown[] }[] = [];
  const api = {
    listChats: vi.fn(async () => {
      calls.push({ op: "list", args: [] });
      return [item(), item({ chatId: CHAT2, name: "Other", pinned: true })];
    }),
    getChat: vi.fn(async (id: string) => ({ ...item({ chatId: id }), lastReadSeq: 0 })),
    events: vi.fn(async (id: string, page?: unknown) => {
      calls.push({ op: "events", args: [id, page] });
      return {
        events: [ev(1), ev(2, { visibility: "technical" })],
        cursor: 2,
        hasOlder: false,
        activeJob: null,
        live: [],
      };
    }),
    post: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "post", args });
      return { ok: true as const, routed: "new_job", jobId: "tljob_1" };
    }),
    markRead: vi.fn(async () => undefined),
    createChat: vi.fn(),
  };
  return { api, calls };
}

describe("ChatService (main's chat IPC, without Electron)", () => {
  it("fails closed when signed out and never reaches the API with bad input", async () => {
    const off = new ChatService(async () => null);
    expect(await off.sections("recent")).toEqual({ ok: false, error: "unavailable" });
    const { api } = fakeApi();
    const svc = new ChatService(async () => api as never);
    expect(await svc.open("not-a-chat")).toEqual({ ok: false, error: "invalid" });
    expect(await svc.send(CHAT, "", "abcdefgh")).toEqual({ ok: false, error: "invalid" });
    expect(await svc.send(CHAT, "hi", "bad key")).toEqual({ ok: false, error: "invalid" });
    expect(await svc.events(CHAT, { after: "1" })).toEqual({ ok: false, error: "invalid" });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.events).not.toHaveBeenCalled();
  });

  it("opens a chat as views, hides technical rows, and polls with the cursor", async () => {
    const { api, calls } = fakeApi();
    const svc = new ChatService(async () => api as never);
    const opened = await svc.open(CHAT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.chat.sub).toBe("Prism · Team · Claude Code + Codex");
    expect(opened.page.events.map((e) => e.seq)).toEqual([1]);
    expect(opened.page.events[0]!.identity.label).toBe("Codex · reviewer");
    await svc.events(CHAT, { after: 2 });
    expect(calls.filter((c) => c.op === "events").at(-1)!.args).toEqual([CHAT, { after: 2 }]);
  });

  it("sends with the renderer's idempotency key and passes only the fixed refusal sentence", async () => {
    const { api } = fakeApi();
    const svc = new ChatService(async () => api as never);
    expect(await svc.send(CHAT, " @codex review it ", "key-12345678")).toEqual({
      ok: true,
      routed: "new_job",
    });
    expect(api.post).toHaveBeenCalledWith(CHAT, "@codex review it", "key-12345678");
    api.post.mockResolvedValueOnce({
      ok: false,
      reason: "provider_unhealthy",
      message: "Codex needs sign-in\u001b[2J before work can start.",
      stored: true,
    } as never);
    expect(await svc.send(CHAT, "again", "key-87654321")).toEqual({
      ok: false,
      error: "failed",
      message: "Codex needs sign-in before work can start. Your message is in the chat.",
    });
  });

  it("maps API errors to fixed codes and rate-limits sends", async () => {
    const { api } = fakeApi();
    let t = 0;
    const svc = new ChatService(
      async () => api as never,
      () => t,
    );
    api.getChat.mockRejectedValueOnce(
      Object.assign(new Error("secret tlc_xyz"), { name: "ChatApiError", status: 401 }),
    );
    expect(await svc.open(CHAT)).toEqual({ ok: false, error: "signed_out" });
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await svc.send(CHAT, `m${i}`, `key-0000000${i}`)).ok);
    expect(results.filter((r) => r === false)).toHaveLength(2);
    t = 20_000;
    expect((await svc.send(CHAT, "later", "key-99999999")).ok).toBe(true);
  });
});

describe("the IPC surface", () => {
  it("adds exactly the chat channels, each validated in main", () => {
    for (const ch of [
      "chats:list",
      "chat:open",
      "chat:events",
      "chat:send",
      "chat:read",
      "open:logs",
    ]) {
      expect(MAIN_TS).toContain(`ipcMain.handle("${ch}"`);
      expect(PRELOAD).toContain(`"${ch}"`);
    }
    expect(MAIN_TS).toContain("chats.send(chatId, body, key)");
    // The credential stays in main: the preload never exposes a token or the client.
    expect(PRELOAD).not.toMatch(/token|chatClientFor|Authorization/i);
  });
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

type Bridge = Record<string, ReturnType<typeof vi.fn>>;
let bridge: Bridge;
let pages: unknown[];

function appState() {
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
            mode: "resume",
            nativeSessionId: "n1",
            localBindingRef: "cc:n1",
            busy: true,
          },
        ],
      },
    ],
    pendingLinks: [],
    activity: [],
    team: [],
    teamProviders: [],
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
    health: [],
    work: [],
    agentsLine: "2 agents ready",
    host: {
      label: "Nickron",
      platform: "windows",
      online: true,
      version: "0.10.0",
      protocol: 10,
      updateRequired: false,
      updateText: null,
    },
  };
}

const view = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  id: `tlcev_${seq}`,
  at: "2026-09-26T10:00:00.000Z",
  identity: { kind: "agent", label: "Codex · reviewer", hue: 2 },
  body: {
    preview: [{ t: "text", v: `message ${seq}` }],
    full: null,
    collapsed: false,
    truncated: false,
  },
  delivery: null,
  note: false,
  ...over,
});

let listeners: ((s: unknown) => void)[];
function mount(state = appState()) {
  document.body.innerHTML = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  listeners = [];
  pages = [];
  bridge = {
    getState: vi.fn(async () => state),
    onState: vi.fn((cb: (s: unknown) => void) => listeners.push(cb)),
    checkProviders: vi.fn(async () => ({ ok: true, providers: [] })),
    getPlans: vi.fn(async () => ({ ok: false, error: "unavailable" })),
    openDashboard: vi.fn(),
    openExternal: vi.fn(),
    openLogs: vi.fn(),
    listChats: vi.fn(async () => ({
      ok: true,
      sections: [
        {
          title: "Recent",
          rows: [
            chatRow(item() as never),
            chatRow(
              item({
                chatId: CHAT2,
                name: "<img src=x onerror=alert(1)>",
                needsAttention: true,
              }) as never,
            ),
          ],
        },
      ],
    })),
    openChat: vi.fn(async () => ({
      ok: true,
      chat: chatHeader(item() as never),
      page: { events: [view(1), view(2)], cursor: 2, hasOlder: true, live: [], working: false },
    })),
    chatEvents: vi.fn(async (_id: string, page: { after?: number; before?: number }) => {
      pages.push(page);
      if (page.before !== undefined)
        return { ok: true, page: { events: [view(0)], cursor: 0, hasOlder: false, live: [] } };
      return { ok: true, page: { events: [], cursor: 2, hasOlder: false, live: [] } };
    }),
    sendChat: vi.fn(async () => ({ ok: true, routed: "new_job" })),
    markChatRead: vi.fn(async () => ({ ok: true })),
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

async function openFirstChat() {
  mount();
  await settle();
  await navTo("Chats");
  await settle();
  (document.querySelector(".chat-row") as HTMLButtonElement).dispatchEvent(new Event("click"));
  await settle();
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("the Chats screen", () => {
  it("lists chats with mode badge, participants and state, as text", async () => {
    mount();
    await settle();
    await navTo("Chats");
    await settle();
    const rows = [...document.querySelectorAll(".chat-row")].map((r) => r.textContent);
    expect(rows[0]).toContain("Prism Review");
    expect(rows[0]).toContain("Prism · Claude Code + Codex");
    expect(rows[0]).toContain("TEAM");
    expect(rows[0]).toContain("Ready");
    expect(rows[1]).toContain("<img src=x onerror=alert(1)>");
    expect(rows[1]).toContain("Needs you");
    expect(document.querySelector("#view img")).toBeNull();
    expect(viewText()).not.toContain("tlcht_");
  });

  it("never shows a global 'Claude is open' status", async () => {
    mount();
    await settle();
    expect(document.getElementById("status-title")?.textContent).toBe("2 agents ready");
    for (const label of ["Home", "Chats", "This computer", "Settings"]) {
      await navTo(label);
      expect(viewText(), label).not.toMatch(/Claude is (currently )?open/);
    }
    expect(APP_JS).not.toContain("Claude is currently open");
    expect(HTML).not.toContain("Claude is currently open");
  });
});

describe("an open chat", () => {
  it("shows the header, the timeline and identities", async () => {
    await openFirstChat();
    expect(document.getElementById("chat-title")?.textContent).toBe("Prism Review");
    expect(document.getElementById("chat-sub")?.textContent).toBe(
      "Prism · Team · Claude Code + Codex",
    );
    const msgs = [...document.querySelectorAll(".msg")];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.classList.contains("id-agent")).toBe(true);
    expect((msgs[0] as HTMLElement).dataset.hue).toBe("2");
    expect(msgs[0]!.querySelector(".msg-who")?.textContent).toBe("Codex · reviewer");
    expect((document.getElementById("chat-older") as HTMLElement).hidden).toBe(false);
  });

  it("appends new rows without rebuilding on state snapshots", async () => {
    await openFirstChat();
    const first = document.querySelector(".msg");
    for (const cb of listeners) cb(appState());
    await settle();
    expect(document.querySelector(".msg")).toBe(first);
    expect(document.querySelectorAll(".msg")).toHaveLength(2);
  });

  it("loads older rows above, once", async () => {
    await openFirstChat();
    (document.getElementById("chat-older") as HTMLButtonElement).dispatchEvent(new Event("click"));
    await settle();
    expect(pages).toContainEqual({ before: 1 });
    const seqs = [...document.querySelectorAll(".msg")].map((m) => (m as HTMLElement).dataset.seq);
    expect(seqs).toEqual(["0", "1", "2"]);
    expect((document.getElementById("chat-older") as HTMLElement).hidden).toBe(true);
  });

  it("sends through the API with a key per message, reusing it only on retry", async () => {
    await openFirstChat();
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    const send = document.getElementById("chat-send") as HTMLButtonElement;
    bridge.sendChat!.mockResolvedValueOnce({ ok: false, error: "failed" });
    input.value = "@codex review auth";
    send.dispatchEvent(new Event("click"));
    await settle();
    expect(document.getElementById("chat-problem")?.textContent).toBe(
      "Couldn't reach ThreadLink. Try again.",
    );
    expect(input.value).toBe("@codex review auth");
    send.dispatchEvent(new Event("click"));
    await settle();
    const [a, b] = bridge.sendChat!.mock.calls;
    expect(a![0]).toBe(CHAT);
    expect(a![1]).toBe("@codex review auth");
    expect(b![2]).toBe(a![2]);
    expect(input.value).toBe("");
    input.value = "next";
    send.dispatchEvent(new Event("click"));
    await settle();
    expect(bridge.sendChat!.mock.calls[2]![2]).not.toBe(a![2]);
    // A successful send polls the cursor straight away.
    expect(pages).toContainEqual({ after: 2 });
  });

  it("renders code blocks preformatted and bodies as text only", async () => {
    mount();
    bridge.openChat = vi.fn(async () => ({
      ok: true,
      chat: chatHeader(item() as never),
      page: {
        events: [
          view(5, {
            body: {
              preview: [
                { t: "text", v: "<script>alert(1)</script>" },
                { t: "code", v: "rm -rf <b>" },
              ],
              full: [{ t: "text", v: "full text" }],
              collapsed: true,
              truncated: false,
            },
          }),
        ],
        cursor: 5,
        hasOlder: false,
        live: [
          { runId: "r", label: "Claude Code · builder", activity: "building", startedAt: null },
        ],
      },
    }));
    await settle();
    await navTo("Chats");
    (document.querySelector(".chat-row") as HTMLButtonElement).dispatchEvent(new Event("click"));
    await settle();
    expect(document.querySelector("#view script")).toBeNull();
    expect(document.querySelector("#view b")).toBeNull();
    expect(document.querySelector(".msg pre.code-block code")?.textContent).toBe("rm -rf <b>");
    expect(document.querySelector(".msg-text")?.textContent).toBe("<script>alert(1)</script>");
    expect(document.getElementById("chat-live")?.textContent).toContain(
      "Claude Code · builder · building",
    );
    const more = document.querySelector(".msg-more") as HTMLButtonElement;
    more.dispatchEvent(new Event("click"));
    expect(document.querySelector(".msg-body")?.textContent).toBe("full text");
  });
});

describe("Agents → Claude Code and This computer", () => {
  it("keeps the execution-mode detail under Agents → Claude Code only", async () => {
    mount();
    await settle();
    expect(viewText()).not.toContain("Attached conversations");
    await navTo("Agents");
    expect(document.getElementById("agent-claude-code")?.textContent).toContain(
      "Attached conversations",
    );
  });

  it("shows host, version, protocol and a logs link", async () => {
    mount();
    await settle();
    await navTo("This computer");
    const text = viewText();
    expect(text).toContain("Version 0.10.0");
    expect(text).toContain("Protocol10");
    expect((document.getElementById("update-card") as HTMLElement).hidden).toBe(true);
    document.getElementById("open-logs")!.dispatchEvent(new Event("click"));
    expect(bridge.openLogs).toHaveBeenCalled();
  });
});
