import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ChatClient,
  parseChatItem,
  parseEventsPage,
  type ChatApi,
  type ChatEventsPage,
  type ChatListItem,
  type ChatTimelineEvent,
} from "../../runtime/src/chat-client.ts";
import { parseChatCommand } from "../../runtime/src/tui/args.ts";
import {
  formatStatus,
  READ_ONLY_COMMANDS,
  readOnlyEngine,
  RUNTIME_ONLY_METHODS,
} from "../../runtime/src/tui/commands.ts";
import {
  choiceHint,
  formatEvent,
  formatHeader,
  formatLive,
  placementOf,
} from "../../runtime/src/tui/format.ts";
import { ChatSession } from "../../runtime/src/tui/session.ts";

/**
 * The terminal in 0.11 (docs/design/threadlink-0.11.md §4, §6, §7, §10):
 * only conversation rows by default (`--all` for Activity), presence as You
 * and the host, `/chat` and `/work` passed to the server, natural choice
 * answers reported, lanes on the client, and no terminal command ever
 * registers or heartbeats this computer.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = readFileSync(join(ROOT, "runtime", "src", "cli.ts"), "utf8");
const TOKEN = `tlc_${"A".repeat(43)}`;
const CHAT = `tlcht_${"a".repeat(32)}`;
const ROOM = `tlrom_${"d".repeat(32)}`;

const agent = (provider: string, name: string, shortName = name) => ({
  kind: "agent" as const,
  provider,
  name,
  shortName,
  health: null,
  healthCheckedAt: null,
});

function chat(over: Partial<ChatListItem> = {}): ChatListItem {
  return {
    chatId: CHAT,
    name: "Prism Review",
    mode: "team",
    roomId: ROOM,
    projectName: "Prism",
    pinned: false,
    archived: false,
    participants: [agent("claude-code", "Claude Code", "Claude"), agent("codex", "Codex")],
    lastMessage: null,
    lastActivityAt: "2026-09-26T10:00:00.000Z",
    unread: false,
    needsAttention: false,
    activeJob: null,
    runtimeLabel: "Nickron PC",
    runtimeOnline: true,
    ...over,
  };
}

function ev(seq: number, over: Partial<ChatTimelineEvent> = {}): ChatTimelineEvent {
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
  };
}

const system = (
  seq: number,
  eventType: string,
  body: string,
  payload: Record<string, unknown> | null = null,
) =>
  ev(seq, {
    authorKind: "threadlink",
    authorProvider: null,
    authorLabel: "ThreadLink",
    eventType,
    body,
    payload,
  });

const usageChoice = (seq: number, kind = "usage_exhausted") =>
  system(seq, "choice", "Codex usage is exhausted.", {
    choiceId: "tlcho_1",
    kind,
    status: "pending",
    options: [
      { key: "continue_other", label: "Continue with Claude" },
      { key: "retry", label: "Retry Codex" },
      { key: "check_again", label: "Check Codex again" },
      { key: "wait", label: "Wait for Codex" },
      { key: "stop", label: "Stop" },
    ],
  });

function page(events: ChatTimelineEvent[], over: Partial<ChatEventsPage> = {}): ChatEventsPage {
  return {
    events,
    cursor: events.at(-1)?.seq ?? 0,
    hasOlder: false,
    hasNewer: false,
    oldestCursor: null,
    activeJob: null,
    live: [],
    ...over,
  };
}

function fakeApi(first: ChatTimelineEvent[], polls: (ChatEventsPage | Error)[] = []) {
  const posts: unknown[][] = [];
  const api: ChatApi = {
    listChats: vi.fn(async () => [chat()]),
    getChat: vi.fn(async () => ({ ...chat(), lastReadSeq: 0 })),
    events: vi.fn(async (_id: string, p?: { after?: number }) => {
      if (p?.after === undefined) return page(first);
      const next = polls.shift();
      if (next instanceof Error) throw next;
      return next ?? page([], { cursor: p.after });
    }),
    post: vi.fn(async (...args: unknown[]) => {
      posts.push(args);
      return { ok: true as const, routed: "new_job", jobId: null };
    }),
    markRead: vi.fn(async () => undefined),
    createChat: vi.fn(),
  };
  return { api, posts };
}

function session(api: ChatApi, all = false) {
  const printed: string[] = [];
  let k = 0;
  const s = new ChatSession(
    chat(),
    api,
    { print: (l) => printed.push(...l) },
    {
      all,
      newKey: () => `key-0000000${++k}`,
    },
  );
  return { s, printed };
}

describe("threadlink chat prints the conversation, not ThreadLink's narration (§7, §10)", () => {
  const rows = [
    ev(1, { authorKind: "owner", authorProvider: null, body: "@team review auth" }),
    system(2, "job_started", "Started job tljob_0123456789abcdef."),
    system(3, "task_started", "Codex started reviewing."),
    ev(4, { body: "Auth looks fine." }),
    system(5, "job_summary", "Work complete."),
  ];

  it("shows only chat rows by default", async () => {
    const { api } = fakeApi(rows);
    const { s, printed } = session(api);
    await s.start();
    const text = printed.join("\n");
    expect(text).toContain("@team review auth");
    expect(text).toContain("Auth looks fine.");
    expect(text).toContain("Work complete.");
    expect(text).not.toContain("Started job");
    expect(text).not.toContain("Codex started reviewing");
    expect(rows.map(placementOf)).toEqual(["chat", "activity", "activity", "chat", "chat"]);
  });

  it("--all shows the Activity rows too, still without ids", async () => {
    expect(parseChatCommand("chat", ["chat", "Prism"], { all: true })).toEqual({
      ok: true,
      value: { command: "chat", query: "Prism", all: true },
    });
    const { api } = fakeApi(rows);
    const { s, printed } = session(api, true);
    await s.start();
    const text = printed.join("\n");
    expect(text).toContain("Started job");
    expect(text).toContain("Codex started reviewing");
    expect(text).not.toContain("tljob_");
  });

  it("names agents Claude and Codex", () => {
    expect(
      formatEvent(
        ev(1, { authorProvider: "claude-code", authorLabel: "Claude Code", authorRole: "builder" }),
        chat().participants,
      ),
    ).toMatch(/^\[\d\d:\d\d\] Claude · builder\n/);
  });
});

describe("presence as You and the host (§4)", () => {
  it("prints You · Connected beside the host, and This computer when the server says", () => {
    expect(formatHeader(chat())[2]).toBe("You · Connected   Nickron PC · Online");
    expect(formatHeader(chat({ thisComputer: true, hostPresence: "working" }))[2]).toBe(
      "You · Connected   This computer · Working",
    );
  });

  it("says when this terminal loses ThreadLink, and when the host changes", async () => {
    const { api } = fakeApi(
      [ev(1)],
      [
        new Error("network"),
        page([], { cursor: 1, hostPresence: "online" }),
        page([], { cursor: 1, hostPresence: "offline" }),
      ],
    );
    const { s, printed } = session(api);
    await s.start();
    printed.length = 0;
    expect(await s.poll()).toBe("error");
    expect(printed).toEqual(["You · Reconnecting"]);
    await s.poll();
    expect(printed.at(-1)).toBe("You · Connected");
    await s.poll();
    expect(printed.slice(-2)).toEqual([
      "Nickron PC · Offline",
      "You're connected. Repository work and agent replies will resume when it reconnects.",
    ]);
  });

  it("status shows You and the host's presence, never registering anything", () => {
    const lines = formatStatus({
      runtimeLabel: "Nickron PC",
      platform: "windows",
      kind: "execution host",
      paused: false,
      online: true,
      lastHeartbeatAt: null,
      version: "0.11.0",
      protocol: 11,
      updateRequired: false,
      agents: [],
      working: 0,
      presence: "working",
      connected: true,
    });
    expect(lines[0]).toBe("You:            Connected");
    expect(lines[1]).toContain("Execution host: Nickron PC (windows, execution host) · Working");
  });
});

describe("lanes and natural answers (§2.4, §6)", () => {
  it("passes /chat and /work to the server as messages", async () => {
    const { api, posts } = fakeApi([ev(1)]);
    const { s, printed } = session(api);
    await s.start();
    await s.handleLine("/chat what does this module do?");
    await s.handleLine("/work fix the login bug");
    await s.handleLine("/workshop");
    expect(posts.map((p) => p[1])).toEqual([
      "/chat what does this module do?",
      "/work fix the login bug",
    ]);
    expect(printed.at(-1)).toBe("Unknown command /workshop. Type /help.");
  });

  it("reports a message that answered the open question", async () => {
    const { api } = fakeApi([usageChoice(1)]);
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      routed: "choice_resolved",
      jobId: null,
      chosenLabel: "Continue with Claude",
    });
    const { s, printed } = session(api);
    await s.start();
    expect(printed.join("\n")).toContain(
      "Reply with: Continue with Claude · Check Codex again · Wait for Codex · Stop",
    );
    expect(printed.join("\n")).not.toContain("Retry Codex");
    await s.handleLine("@Claude continue");
    expect(printed).toContain("ThreadLink: Answered — Continue with Claude.");
  });

  it("sends approvals to the web card", () => {
    expect(choiceHint(usageChoice(1, "production_deploy"))).toBe(
      "  Decide this on the card in ThreadLink on the web.",
    );
    expect(
      choiceHint(system(2, "choice", "x", { kind: "start_work", status: "chosen", options: [] })),
    ).toBeNull();
  });
});

describe("the chat client in 0.11", () => {
  function client(reply: unknown) {
    const bodies: unknown[] = [];
    const c = new ChatClient({
      baseUrl: "https://threadlink.example",
      token: TOKEN,
      client: "terminal",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        bodies.push(init.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify(reply));
      }) as unknown as typeof fetch,
    });
    return { c, bodies };
  }

  it("sends a lane only for Chat only / Run work, and reads choice_resolved", async () => {
    const { c, bodies } = client({
      ok: true,
      routed: "choice_resolved",
      jobId: null,
      chosenLabel: "Wait for Codex",
      lane: "chat",
    });
    expect(await c.post(CHAT, "wait", "key-12345678")).toEqual({
      ok: true,
      routed: "choice_resolved",
      jobId: null,
      chosenLabel: "Wait for Codex",
      lane: "chat",
    });
    await c.post(CHAT, "hi", "key-12345679", { lane: "auto" });
    await c.post(CHAT, "why?", "key-12345670", { lane: "chat" });
    await c.post(CHAT, "fix it", "key-12345671", { lane: "work" });
    expect(bodies.map((b) => (b as { lane?: string }).lane)).toEqual([
      undefined,
      undefined,
      "chat",
      "work",
    ]);
    await expect(c.post(CHAT, "x", "key-12345672", { lane: "fast" as never })).rejects.toThrow(
      "Invalid lane.",
    );
  });

  it("reads payloads, live activity, deliveries and presence tolerantly", () => {
    const p = parseEventsPage(
      {
        events: [
          {
            cursor: 3,
            id: "e3",
            authorKind: "threadlink",
            eventType: "choice",
            body: "b",
            payload: { choiceId: "x", options: [] },
          },
          {
            cursor: 4,
            id: "e4",
            authorKind: "threadlink",
            body: "b",
            payload: { big: "x".repeat(20_000) },
          },
        ],
        cursor: 4,
        activity: [
          {
            runId: "r1",
            provider: "codex",
            providerName: "Codex",
            role: "reviewer",
            activity: "reviewing",
          },
        ],
        deliveries: [{ cursor: 1, delivery: { state: "seen", by: ["Codex"] } }],
        host: { presence: "working" },
      },
      null,
    );
    expect(p.events[0]!.payload).toEqual({ choiceId: "x", options: [] });
    expect(p.events[1]!.payload).toBeNull();
    expect(p.live.map((r) => r.runId)).toEqual(["r1"]);
    expect(p.deliveries).toEqual([{ seq: 1, delivery: { state: "seen", by: ["Codex"] } }]);
    expect(p.hostPresence).toBe("working");
    const item = parseChatItem({
      chatId: CHAT,
      name: "n",
      thisComputer: true,
      hostPresence: "reconnecting",
      unreadCount: 4,
      unread: true,
    })!;
    expect(item).toMatchObject({
      thisComputer: true,
      hostPresence: "reconnecting",
      unreadCount: 4,
    });
    expect(
      parseChatItem({ chatId: CHAT, name: "n", hostPresence: "<b>" })!.hostPresence,
    ).toBeNull();
  });

  it("overview reads chats, projects, this computer and the failover preference in one request", async () => {
    const { c, bodies } = client({
      chats: [{ chatId: CHAT, name: "n" }],
      projects: [{ roomId: ROOM, name: "Prism", runtimeLabel: "Nickron PC", thisComputer: true }],
      runtime: {
        label: "Nickron PC",
        online: true,
        presence: "online",
        version: "0.11.0",
        protocol: 11,
      },
      settings: { failoverPolicy: "wait" },
    });
    const o = await c.overview();
    expect(bodies).toHaveLength(1);
    expect(o.chats).toHaveLength(1);
    expect(o.projects[0]).toMatchObject({ name: "Prism", thisComputer: true });
    expect(o.runtime).toMatchObject({ presence: "online", protocol: 11 });
    expect(o.failoverPolicy).toBe("wait");
    const { c: other } = client({ chats: [], failoverPolicy: "sometimes" });
    expect((await other.overview()).failoverPolicy).toBeNull();
  });
});

describe("0.11 routes in the chat client", () => {
  const CHOICE = `tlchc_${"e".repeat(32)}`;
  function client(reply: unknown, status = 200) {
    const sent: { url: string; method: string; body: unknown }[] = [];
    const c = new ChatClient({
      baseUrl: "https://threadlink.example",
      token: TOKEN,
      client: "desktop",
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({
          url: String(url),
          method: String(init.method),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(reply), { status });
      }) as unknown as typeof fetch,
    });
    return { c, sent };
  }

  it("decides a choice by key and reads the answer", async () => {
    const { c, sent } = client({
      choiceId: CHOICE,
      kind: "usage_exhausted",
      status: "chosen",
      chosenKey: "continue_other",
      chosenLabel: "Continue with Claude",
      decidedAt: "2026-09-29T10:00:00Z",
      replayed: false,
      startedJobId: null,
    });
    expect(await c.decideChoice(CHAT, CHOICE, "continue_other")).toEqual({
      ok: true,
      choiceId: CHOICE,
      kind: "usage_exhausted",
      status: "chosen",
      chosenKey: "continue_other",
      chosenLabel: "Continue with Claude",
      replayed: false,
      startedJobId: null,
    });
    expect(sent[0]).toMatchObject({
      url: `https://threadlink.example/api/runtime/chats/${CHAT}/choices/${CHOICE}`,
      method: "POST",
      body: { key: "continue_other" },
    });
    await expect(c.decideChoice(CHAT, "tlcho_x", "wait")).rejects.toThrow("not a choice");
    await expect(c.decideChoice(CHAT, CHOICE, "Wait!")).rejects.toThrow("not an option");
  });

  it("treats a 409 refusal as an answer with its fixed sentence", async () => {
    const { c } = client(
      { ok: false, reason: "other_computer", message: "This chat runs on another computer." },
      409,
    );
    expect(await c.decideChoice(CHAT, CHOICE, "wait")).toEqual({
      ok: false,
      reason: "other_computer",
      message: "This chat runs on another computer.",
    });
  });

  it("reads and writes the failover preference", async () => {
    const { c, sent } = client({ failoverPolicy: "ask", updatedAt: "2026-09-29T10:00:00Z" });
    expect(await c.getFailoverPolicy()).toBe("ask");
    expect(await c.setFailoverPolicy("ask")).toBe("ask");
    expect(sent.map((x) => [x.method, x.url.replace("https://threadlink.example", "")])).toEqual([
      ["GET", "/api/runtime/settings/failover"],
      ["PUT", "/api/runtime/settings/failover"],
    ]);
    expect(sent[1]!.body).toEqual({ failoverPolicy: "ask" });
    await expect(c.setFailoverPolicy("never" as never)).rejects.toThrow("not a failover choice");
  });

  it("reads host presence from chat reads and the live row's subject", () => {
    const item = parseChatItem({
      chatId: CHAT,
      name: "n",
      host: { label: "Nickron PC", presence: "reconnecting", lastSeenAt: "2026-09-29T10:00:00Z" },
    })!;
    expect(item.hostPresence).toBe("reconnecting");
    const p = parseEventsPage(
      {
        events: [],
        cursor: 3,
        host: { label: "Nickron PC", presence: "offline", lastSeenAt: null },
        serverNow: "2026-09-29T10:00:00Z",
        activity: [{ runId: "r", provider: "codex", role: "reviewer", subject: "Reviewing" }],
      },
      2,
    );
    expect(p.hostPresence).toBe("offline");
    expect(p.live[0]!.subject).toBe("Reviewing");
    expect(formatLive(p.live[0]!, chat().participants)).toBe("  … Codex · reviewer · Reviewing");
  });
});

describe("no terminal command registers or heartbeats this computer (§4 regression)", () => {
  it("a read-only engine refuses to register, heartbeat or deliver, and does everything else", async () => {
    class FakeEngine {
      #calls: string[] = [];
      get calls() {
        return this.#calls;
      }
      async register() {
        this.#calls.push("register");
      }
      async heartbeat() {
        this.#calls.push("heartbeat");
      }
      async run() {
        this.#calls.push("run");
      }
      async deliverOnce() {
        this.#calls.push("deliverOnce");
        return 0;
      }
      async loadWorkspaces() {
        this.#calls.push("loadWorkspaces");
        return [];
      }
      async refreshPendingLinks() {
        this.#calls.push("links");
        return [];
      }
    }
    const inner = new FakeEngine();
    const engine = readOnlyEngine(inner);
    for (const m of RUNTIME_ONLY_METHODS)
      await expect(
        (engine as unknown as Record<string, () => Promise<unknown>>)[m]!(),
      ).rejects.toThrow("never registers or heartbeats");
    await engine.loadWorkspaces();
    await engine.refreshPendingLinks();
    expect(inner.calls).toEqual(["loadWorkspaces", "links"]);
  });

  it("cli.ts gives every terminal command a read-only engine; only run/attach/setup register", () => {
    expect([...READ_ONLY_COMMANDS]).toEqual(
      expect.arrayContaining(["chats", "chat", "new", "agents", "status", "sessions", "links"]),
    );
    expect(CLI).toContain('const runtimeCommand = command === "run" || command === "attach";');
    expect(CLI).toContain("readOnlyEngine(engineFor(api))");
    expect(CLI).toContain("await readOnlyEngine(engineFor(api)).checkProviders()");
    // Where register/heartbeat still appear: setup (the Runtime's own setup), run, attach.
    const lines = CLI.split("\n");
    const at = (re: RegExp) => lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
    const branchOf = (i: number) => {
      for (let j = i; j >= 0; j--) {
        const m = /if \(command === "([a-z]+)"/.exec(lines[j]!);
        if (m) return m[1];
      }
      return null;
    };
    const registering = at(/\.(register|heartbeat)\(\)/).map(branchOf);
    expect(new Set(registering)).toEqual(new Set(["setup", "run", "attach"]));
    // The chat commands never build an engine that could register.
    const chatCommand = CLI.slice(
      CLI.indexOf("async function chatCommand"),
      CLI.indexOf("async function main"),
    );
    expect(chatCommand).not.toMatch(/\.(register|heartbeat|run|deliverOnce)\(/);
    expect(chatCommand).not.toMatch(/engineFor\(api\)\.(?!checkProviders)/);
  });
});
