import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_API,
  ChatApiError,
  ChatClient,
  chatClientFor,
  parseChatEvent,
  parseEventsPage,
  type ChatApi,
  type ChatEventsPage,
  type ChatListItem,
  type ChatTimelineEvent,
} from "../../runtime/src/chat-client.ts";
import { saveConfig } from "../../runtime/src/state.ts";
import { parseChatCommand, resolveChat, resolveProject } from "../../runtime/src/tui/args.ts";
import {
  agentRowsFromProfiles,
  agentsSummary,
  formatAgents,
  formatStatus,
  runChats,
  runNew,
} from "../../runtime/src/tui/commands.ts";
import {
  chatState,
  deliveryText,
  formatChatList,
  formatEvent,
  formatHeader,
  formatLive,
  freshness,
  identityOf,
} from "../../runtime/src/tui/format.ts";
import { ChatSession, nextPollDelay, runChatSession } from "../../runtime/src/tui/session.ts";
import { safeBody, safeLine, safeText } from "../../runtime/src/tui/text.ts";

/**
 * The terminal client (`threadlink chats | chat | new | agents | status`),
 * driven against a fake chat API. The real one is the same server timeline
 * as the web, reached with this computer's stored Runtime credential.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = readFileSync(join(ROOT, "runtime", "src", "cli.ts"), "utf8");
const TOKEN = `tlc_${"A".repeat(43)}`;
const CHAT = `tlcht_${"a".repeat(32)}`;
const CHAT2 = `tlcht_${"b".repeat(32)}`;
const CHAT3 = `tlcht_${"c".repeat(32)}`;
const ROOM = `tlrom_${"d".repeat(32)}`;

const agent = (provider: string, name: string) => ({
  kind: "agent" as const,
  provider,
  name,
  shortName: name,
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
    participants: [agent("claude-code", "Claude Code"), agent("codex", "Codex")],
    lastMessage: null,
    lastActivityAt: "2026-09-26T10:00:00.000Z",
    unread: false,
    needsAttention: false,
    activeJob: null,
    runtimeLabel: null,
    runtimeOnline: null,
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
    authorRole: "reviewer",
    audience: null,
    eventType: "agent_message",
    messageType: null,
    body: `message ${seq}`,
    visibility: "visible",
    delivery: null,
    client: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Arguments and resolution
// ---------------------------------------------------------------------------

describe("argument parsing", () => {
  it("parses the five commands", () => {
    expect(parseChatCommand("chats", ["chats"], {})).toEqual({
      ok: true,
      value: { command: "chats" },
    });
    expect(parseChatCommand("chat", ["chat", "Prism", "Review"], {})).toEqual({
      ok: true,
      value: { command: "chat", query: "Prism Review" },
    });
    expect(parseChatCommand("new", ["new"], { project: "Prism", mode: "TEAM" })).toEqual({
      ok: true,
      value: { command: "new", project: "Prism", mode: "team", name: "Prism chat" },
    });
    expect(parseChatCommand("new", ["new"], { name: "Auth pass" })).toMatchObject({
      ok: true,
      value: { project: null, mode: undefined, name: "Auth pass" },
    });
    expect(parseChatCommand("agents", ["agents"], { check: true })).toEqual({
      ok: true,
      value: { command: "agents", check: true },
    });
  });

  it("refuses what it does not understand", () => {
    expect(parseChatCommand("chat", ["chat"], {}).ok).toBe(false);
    expect(parseChatCommand("new", ["new"], { mode: "swarm" })).toEqual({
      ok: false,
      error: "--mode must be solo, pair or team.",
    });
    expect(parseChatCommand("chats", ["chats", "extra"], {}).ok).toBe(false);
    expect(parseChatCommand("chat", ["chat", "x".repeat(200)], {}).ok).toBe(false);
  });
});

describe("resolving a chat by name or id", () => {
  const chats = [
    chat(),
    chat({ chatId: CHAT2, name: "Prism Deploy" }),
    chat({
      chatId: CHAT3,
      name: "Auth review",
      projectName: "Nova",
      roomId: `tlrom_${"e".repeat(32)}`,
    }),
  ];
  it("finds by id, exact name, any case and unique prefix", () => {
    expect(resolveChat(chats, CHAT3)).toMatchObject({ ok: true, value: { name: "Auth review" } });
    expect(resolveChat(chats, "Prism Review")).toMatchObject({ ok: true, value: { chatId: CHAT } });
    expect(resolveChat(chats, "prism deploy")).toMatchObject({
      ok: true,
      value: { chatId: CHAT2 },
    });
    expect(resolveChat(chats, "auth")).toMatchObject({ ok: true, value: { chatId: CHAT3 } });
  });

  it("lists names (never ids) when ambiguous, and says so when nothing matches", () => {
    const r = resolveChat(chats, "prism");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Prism Review");
      expect(r.error).toContain("Prism Deploy");
      expect(r.error).not.toContain("tlcht_");
    }
    expect(resolveChat(chats, "zzz")).toMatchObject({ ok: false });
    expect(resolveChat(chats, `tlcht_${"f".repeat(32)}`)).toMatchObject({ ok: false });
  });

  it("maps a project name to its room", () => {
    expect(resolveProject(chats, "prism")).toEqual({ ok: true, value: ROOM });
    const none = resolveProject(chats, "Mars");
    expect(none.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Safe output
// ---------------------------------------------------------------------------

describe("terminal-safe text", () => {
  it("strips CSI, OSC, DCS, C1 controls and bidi overrides", () => {
    const raw =
      "\u001b[2J\u001b[H\u001b[31mred\u001b[0m" +
      "\u001b]0;pwned title\u0007" +
      "\u001bP+q\u001b\\" +
      "\u009b1;1H ok\u0000\u0008 \u202eevil\r\nnext";
    expect(safeText(raw)).toBe("red ok evil\nnext");
    expect(safeText(raw)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("keeps single lines single, and collapses huge bodies", () => {
    expect(safeLine("a\n\tb   c", 120)).toBe("a b c");
    expect(safeLine("x".repeat(50), 10)).toHaveLength(10);
    const body = safeBody(Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n"));
    expect(body.split("\n")).toHaveLength(41);
    expect(body).toContain("message shortened");
  });
});

describe("formatting", () => {
  it("lists chats pinned first with project, mode and state, never ids", () => {
    const lines = formatChatList([
      chat({ name: "Old", lastActivityAt: "2026-09-20T00:00:00Z" }),
      chat({
        chatId: CHAT2,
        name: "Pinned one",
        pinned: true,
        lastActivityAt: "2026-09-01T00:00:00Z",
      }),
      chat({
        chatId: CHAT3,
        name: "Busy",
        activeJob: { jobId: "j", mode: "team", status: "building" },
      }),
    ]);
    expect(lines[1]).toContain("Pinned one");
    expect(lines[1]!.startsWith(" *")).toBe(true);
    expect(lines[2]).toContain("Busy");
    expect(lines[2]).toContain("Working");
    expect(lines.join("\n")).toContain("Team");
    expect(lines.join("\n")).not.toContain("tlcht_");
  });

  it("prints the header the brief asks for", () => {
    expect(formatHeader(chat())).toEqual([
      "ThreadLink — Prism Review",
      "Prism · Team · Claude Code + Codex",
    ]);
    expect(formatHeader(chat({ runtimeLabel: "Nickron's PC", runtimeOnline: false }))[2]).toBe(
      "Runs on Nickron's PC · offline",
    );
  });

  it("names every author by identity, unknown providers neutrally", () => {
    const parts = chat().participants;
    expect(identityOf(ev(1, { authorKind: "owner" }), parts)).toBe("You");
    expect(identityOf(ev(1, { authorKind: "threadlink" }), parts)).toBe("ThreadLink");
    expect(identityOf(ev(1, { authorKind: "controller", authorLabel: "ChatGPT" }), parts)).toBe(
      "ChatGPT",
    );
    expect(identityOf(ev(1), parts)).toBe("Codex · reviewer");
    expect(
      identityOf(ev(1, { authorProvider: "gemini-cli", authorLabel: "", authorRole: null }), parts),
    ).toBe("Agent (gemini-cli)");
  });

  it("strips escapes from bodies and shows delivery for the owner's messages", () => {
    const out = formatEvent(
      ev(3, {
        authorKind: "owner",
        body: "\u001b[1Aoverwrite\u001b]52;c;Y2xpcA==\u0007 done",
        delivery: { state: "queued", for: ["Codex"] },
      }),
    );
    expect(out).toMatch(/^\[\d\d:\d\d\] You {2}\(queued for Codex\)\n {2}overwrite done$/);
    expect(out).not.toContain("\u001b");
    expect(deliveryText({ state: "seen", by: ["Claude Code"] })).toBe("seen by Claude Code");
  });

  it("shows live activity for runs that have not spoken yet", () => {
    const now = Date.parse("2026-09-26T10:03:00Z");
    expect(
      formatLive(
        {
          runId: "r",
          provider: "claude-code",
          providerName: null,
          role: "reviewer",
          activity: "reviewing",
          startedAt: "2026-09-26T10:00:00Z",
          lastActivityAt: null,
        },
        chat().participants,
        now,
      ),
    ).toBe("  … Claude Code · reviewer · reviewing · 3 min");
  });

  it("uses one freshness rule: never Ready with stale text", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(freshness("ready", "2026-09-26T11:59:37Z", now).text).toBe("Ready · checked 23 s ago");
    expect(freshness("ready", "2026-09-26T09:50:00Z", now).text).toBe(
      "Stale · last checked 2 h ago",
    );
    expect(freshness("ready", null, now).state).toBe("stale");
    expect(freshness("needs_sign_in", null, now).text).toBe("Needs sign-in");
    expect(chatState({ needsAttention: true, activeJob: null })).toBe("Needs you");
  });

  it("status and agents never say Claude is open", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    const rows = agentRowsFromProfiles([
      {
        provider: "claude-code",
        detected: {
          installed: true,
          version: "2.1",
          health: "ready",
          healthCheckedAt: "2026-09-26T11:59:00Z",
        },
        detectedAt: null,
      },
      { provider: "codex", detected: { installed: false }, detectedAt: null },
    ]);
    expect(formatAgents(rows, now)).toEqual([
      "Claude Code  Ready · checked 1 min ago  (2.1)",
      "Codex        Not installed",
    ]);
    expect(agentsSummary(rows, 0, now)).toBe("1 agent ready");
    expect(agentsSummary(rows, 2, now)).toBe("2 agents working");
    expect(agentsSummary([], 0, now)).toBe("Execution host online");
    const status = formatStatus(
      {
        runtimeLabel: "Nickron",
        platform: "windows",
        kind: "cli",
        paused: false,
        online: true,
        lastHeartbeatAt: "2026-09-26T11:59:50Z",
        version: "0.10.0",
        protocol: 10,
        updateRequired: true,
        agents: rows,
        working: 0,
      },
      now,
    ).join("\n");
    expect(status).toContain("Execution host: Nickron (windows, cli) · Online");
    expect(status).toContain("0.10.0 · protocol 10");
    expect(status).toContain("ThreadLink on Nickron needs an update before Team work can start.");
    expect(status).not.toMatch(/Claude is|currently open/);
  });
});

// ---------------------------------------------------------------------------
// The interactive session
// ---------------------------------------------------------------------------

function fakeApi(
  pages: { after?: unknown; events: ChatTimelineEvent[]; hasOlder?: boolean }[] = [],
) {
  const calls: { op: string; args: unknown[] }[] = [];
  let polls = 0;
  const api: ChatApi & { calls: typeof calls } = {
    calls,
    listChats: vi.fn(async () => [chat()]),
    getChat: vi.fn(async () => ({
      ...chat({
        activeJob: { jobId: "j", mode: "team", status: "reviewing" },
        runtimeLabel: "Nickron",
        runtimeOnline: true,
      }),
      lastReadSeq: 0,
    })),
    events: vi.fn(
      async (
        id: string,
        page?: { after?: number; before?: number; limit?: number },
      ): Promise<ChatEventsPage> => {
        calls.push({ op: "events", args: [id, page] });
        if (page?.before !== undefined)
          return {
            events: [ev(0)],
            cursor: 0,
            hasOlder: false,
            hasNewer: false,
            oldestCursor: null,
            activeJob: null,
            live: [],
          };
        if (page?.after === undefined)
          return {
            events: [ev(1), ev(2, { visibility: "technical", body: "hidden" })],
            cursor: 2,
            hasOlder: true,
            hasNewer: false,
            oldestCursor: null,
            activeJob: null,
            live: [],
          };
        const next = pages[polls++];
        const events = next?.events ?? [];
        return {
          events,
          cursor: events.at(-1)?.seq ?? page.after,
          hasOlder: false,
          hasNewer: false,
          oldestCursor: null,
          activeJob: null,
          live: [],
        };
      },
    ),
    post: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "post", args });
      return { ok: true as const, routed: "new_job", jobId: "tljob_1" };
    }),
    markRead: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: "read", args });
    }),
    createChat: vi.fn(async (input: unknown) => {
      calls.push({ op: "create", args: [input] });
      return chat({ chatId: CHAT2, name: "Prism chat" });
    }),
  };
  return api;
}

function session(api: ChatApi, keys = ["key-00000001", "key-00000002", "key-00000003"]) {
  const printed: string[] = [];
  let k = 0;
  const s = new ChatSession(
    chat(),
    api,
    { print: (l) => printed.push(...l) },
    { newKey: () => keys[k++]! },
  );
  return { s, printed };
}

describe("threadlink chat", () => {
  it("prints the header, the latest page (visible rows only) and marks it read", async () => {
    const api = fakeApi();
    const { s, printed } = session(api);
    await s.start();
    const text = printed.join("\n");
    expect(text).toContain("ThreadLink — Prism Review");
    expect(text).toContain("Prism · Team · Claude Code + Codex");
    expect(text).toContain("Codex · reviewer");
    expect(text).toContain("message 1");
    expect(text).not.toContain("hidden");
    expect(text).toContain("/older");
    expect(api.markRead).toHaveBeenCalledWith(CHAT, 2);
    expect(s.cursor).toBe(2);
  });

  it("polls the per-chat cursor and prints only new rows", async () => {
    const api = fakeApi([{ events: [ev(3)] }, { events: [] }, { events: [ev(3), ev(4)] }]);
    const { s, printed } = session(api);
    await s.start();
    printed.length = 0;
    expect(await s.poll()).toBe("new");
    expect(await s.poll()).toBe("idle");
    expect(await s.poll()).toBe("new");
    expect(printed.filter((l) => l.includes("message 3"))).toHaveLength(1);
    expect(printed.join("\n")).toContain("message 4");
    const afters = api.calls
      .filter((c) => c.op === "events")
      .map((c) => (c.args[1] as { after?: number })?.after);
    expect(afters).toEqual([undefined, 2, 3, 3]);
  });

  it("sends a message (incl. @mentions) with a fresh key each time", async () => {
    const api = fakeApi();
    const { s } = session(api);
    await s.start();
    await s.handleLine("@codex please review auth");
    await s.handleLine("and the tests");
    const posts = api.calls.filter((c) => c.op === "post").map((c) => c.args);
    expect(posts).toEqual([
      [CHAT, "@codex please review auth", "key-00000001"],
      [CHAT, "and the tests", "key-00000002"],
    ]);
  });

  it("retries a message that did not arrive with the SAME key", async () => {
    const api = fakeApi();
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ChatApiError(0, "network"));
    const { s, printed } = session(api);
    await s.start();
    await s.handleLine("ship it");
    expect(printed.join("\n")).toContain("/retry");
    await s.handleLine("/retry");
    const posts = (api.post as ReturnType<typeof vi.fn>).mock.calls;
    expect(posts).toHaveLength(2);
    expect(posts[1]![2]).toBe(posts[0]![2]);
    await s.handleLine("/retry");
    expect(printed.at(-1)).toBe("Nothing to retry.");
  });

  it("prints a refusal as ThreadLink's fixed sentence, safely", async () => {
    const api = fakeApi();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "provider_unhealthy",
      message: "Codex needs sign-in.\u001b[2J",
      stored: true,
    });
    const { s, printed } = session(api);
    await s.start();
    await s.handleLine("go");
    expect(printed.at(-1)).toBe("ThreadLink: Codex needs sign-in. (your message is in the chat)");
  });

  it("/quit leaves without cancelling anything; /status and /older work", async () => {
    const api = fakeApi();
    const { s, printed } = session(api);
    await s.start();
    await s.handleLine("/status");
    expect(printed.join("\n")).toContain("Prism Review · Working · Claude Code + Codex");
    expect(printed.join("\n")).toContain("Runs on Nickron");
    await s.handleLine("/older");
    expect(printed.join("\n")).toContain("message 0");
    const before = api.calls.length;
    expect(await s.handleLine("/quit")).toBe("quit");
    expect(s.closed).toBe(true);
    expect(printed.at(-1)).toContain("keeps going");
    // Leaving sends nothing: no stop message, no post, no further poll.
    expect(api.calls.slice(before)).toEqual([]);
    expect(await s.poll()).toBe("idle");
    expect(api.calls.slice(before)).toEqual([]);
    expect(await s.handleLine("/nope")).toBe("continue");
  });

  it("runs until /quit with a self-rescheduling poll", async () => {
    const api = fakeApi([{ events: [ev(5)] }]);
    const printed: string[] = [];
    const s = new ChatSession(chat(), api, { print: (l) => printed.push(...l) });
    const handlers: Record<string, (x?: string) => void> = {};
    const reader = {
      on: (event: string, cb: (x?: string) => void) => {
        handlers[event] = cb;
        return reader;
      },
      prompt: vi.fn(),
      close: vi.fn(() => handlers.close?.()),
    };
    const timers: (() => void)[] = [];
    const done = runChatSession(s, reader as never, {
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    });
    await vi.waitFor(() => expect(timers.length).toBe(1));
    timers.shift()!();
    await vi.waitFor(() => expect(printed.join("\n")).toContain("message 5"));
    handlers.line!("/quit");
    await done;
    expect(reader.close).toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("backs off when idle or failing, and speeds up on news", () => {
    expect(nextPollDelay(2000, "idle")).toBe(3000);
    expect(nextPollDelay(14000, "idle")).toBe(15000);
    expect(nextPollDelay(15000, "new")).toBe(2000);
    expect(nextPollDelay(2000, "error")).toBe(5000);
    expect(nextPollDelay(40000, "error")).toBe(60000);
  });
});

describe("threadlink chats / new", () => {
  it("lists chats", async () => {
    const out: string[] = [];
    expect(await runChats(fakeApi(), (l = "") => out.push(l))).toBe(0);
    expect(out.join("\n")).toContain("Prism Review");
  });

  it("creates a chat in the named project with the chosen mode", async () => {
    const api = fakeApi();
    const out: string[] = [];
    expect(
      await runNew(api, { project: "prism", mode: "team", name: "Prism chat" }, (l = "") =>
        out.push(l),
      ),
    ).toBe(0);
    expect(api.createChat).toHaveBeenCalledWith({ name: "Prism chat", roomId: ROOM, mode: "team" });
    expect(out.join("\n")).toContain('threadlink chat "Prism chat"');
    expect(
      await runNew(api, { project: "Mars", mode: "team", name: "x" }, (l = "") => out.push(l)),
    ).toBe(1);
    // A project with no chats yet is found through the list's `projects`.
    const empty = fakeApi();
    empty.listChats = vi.fn(async () => []);
    empty.listProjects = vi.fn(async () => [{ roomId: ROOM, name: "Prism", runtimeLabel: null }]);
    expect(
      await runNew(empty, { project: "Prism", mode: undefined, name: "First" }, () => {}),
    ).toBe(0);
    expect(empty.createChat).toHaveBeenCalledWith({ name: "First", roomId: ROOM });
  });
});

// ---------------------------------------------------------------------------
// The client and its credential
// ---------------------------------------------------------------------------

describe("chat client auth reuse", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("uses the stored Runtime credential, only in the Authorization header", async () => {
    dir = mkdtempSync(join(tmpdir(), "tl-tui-"));
    await saveConfig(dir, { baseUrl: "https://threadlink.example" });
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(
        JSON.stringify({
          chats: [{ chatId: CHAT, name: "Prism Review", mode: "team", participants: [] }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = await chatClientFor(
      {
        configDir: dir,
        store: {
          description: "fake",
          load: async () => TOKEN,
          save: async () => {},
          clear: async () => {},
        },
      },
      "terminal",
      { fetchImpl, env: {} },
    );
    expect(client).toBeInstanceOf(ChatClient);
    const list = await client!.listChats();
    expect(list.map((c) => c.name)).toEqual(["Prism Review"]);
    expect(seen[0]!.url).toBe(`https://threadlink.example${CHAT_API.list}`);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-ThreadLink-Client"]).toBe("terminal");
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it("is null (never a prompt for a secret) when this computer is not signed in", async () => {
    dir = mkdtempSync(join(tmpdir(), "tl-tui-"));
    await saveConfig(dir, { baseUrl: "https://threadlink.example" });
    const store = {
      description: "fake",
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    };
    expect(await chatClientFor({ configDir: dir, store }, "terminal", { env: {} })).toBeNull();
  });

  it("posts {body, idempotencyKey, client} and never leaks the token in errors", async () => {
    const bodies: unknown[] = [];
    const client = new ChatClient({
      baseUrl: "https://threadlink.example",
      token: TOKEN,
      client: "terminal",
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (String(url).endsWith("/messages")) {
          bodies.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({ ok: true, routed: "note_to_active_job", jobId: null }),
          );
        }
        return new Response(
          JSON.stringify({ ok: false, reason: "unauthenticated", message: `bad ${TOKEN}` }),
          { status: 401 },
        );
      }) as unknown as typeof fetch,
    });
    expect(await client.post(CHAT, " hi ", "key-12345678")).toEqual({
      ok: true,
      routed: "note_to_active_job",
      jobId: null,
    });
    expect(bodies).toEqual([{ body: "hi", idempotencyKey: "key-12345678", client: "terminal" }]);
    const error = await client.listChats().catch((e: unknown) => e as ChatApiError);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).status).toBe(401);
    // The server's message is passed on sanitised; the client never adds the token itself.
    expect(String((error as Error).stack ?? "")).not.toContain("Bearer");
    await expect(client.events("not-a-chat")).rejects.toThrow("That is not a chat.");
  });

  it("reads the per-chat `cursor` of docs/chat-api.md and marks read with {cursor}", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const client = new ChatClient({
      baseUrl: "https://threadlink.example",
      token: TOKEN,
      client: "desktop",
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
        if (String(url).includes("/events"))
          return new Response(
            JSON.stringify({
              chatId: CHAT,
              events: [
                {
                  id: "e13",
                  cursor: 13,
                  authorKind: "owner",
                  authorLabel: "You",
                  body: "hi",
                  visibility: "visible",
                },
                {
                  id: "e14",
                  cursor: 14,
                  authorKind: "agent",
                  authorProvider: "codex",
                  body: "ok",
                  visibility: "visible",
                },
              ],
              cursor: 14,
              oldestCursor: 13,
              hasMore: true,
              activeJob: null,
            }),
          );
        if (String(url).endsWith("/read"))
          return new Response(JSON.stringify({ ok: true, lastReadCursor: 14 }));
        if (String(url).endsWith(CHAT))
          return new Response(
            JSON.stringify({ chatId: CHAT, name: "Prism Review", mode: "team", lastReadCursor: 9 }),
          );
        return new Response(
          JSON.stringify({
            chats: [],
            projects: [
              { roomId: ROOM, name: "Prism", runtimeLabel: "Nickron", thisComputer: true },
            ],
          }),
        );
      }) as unknown as typeof fetch,
    });
    const latest = await client.events(CHAT);
    expect(latest.events.map((e) => e.seq)).toEqual([13, 14]);
    expect(latest).toMatchObject({ cursor: 14, oldestCursor: 13, hasOlder: true, hasNewer: false });
    const poll = await client.events(CHAT, { after: 12 });
    expect(poll).toMatchObject({ hasOlder: false, hasNewer: true });
    expect(sent.at(-1)!.url).toContain("/events?after=12");
    await client.markRead(CHAT, 14);
    expect(sent.at(-1)!.body).toEqual({ cursor: 14 });
    expect((await client.getChat(CHAT)).lastReadSeq).toBe(9);
    expect(await client.listProjects()).toEqual([
      { roomId: ROOM, name: "Prism", runtimeLabel: "Nickron" },
    ]);
    await expect(client.post(CHAT, "x".repeat(4001), "key-12345678")).rejects.toThrow("1-4000");
  });

  it("parses pages tolerantly with the per-chat cursor", () => {
    const page = parseEventsPage(
      {
        events: [
          {
            chatSeq: 7,
            id: "e7",
            authorKind: "agent",
            authorProvider: "codex",
            body: "b",
            createdAt: "2026-09-26T10:00:00Z",
          },
          {
            seq: 3,
            id: "e3",
            authorKind: "owner",
            body: "a",
            delivery: { state: "seen", by: ["Codex"] },
          },
          { id: "bad" },
          { chatSeq: 8, id: "e8", authorKind: "wizard" },
        ],
        hasMore: true,
        live: [
          { runId: "r", provider: "claude-code", activity: "building" },
          { runId: "x", provider: "BAD ID" },
        ],
      },
      null,
    );
    expect(page.events.map((e) => e.seq)).toEqual([3, 7]);
    expect(page.cursor).toBe(7);
    expect(page.hasOlder).toBe(true);
    expect(page.live.map((r) => r.provider)).toEqual(["claude-code"]);
    expect(
      parseChatEvent({ chatSeq: 1, id: "x", authorKind: "agent", authorProvider: "<script>" })
        ?.authorProvider,
    ).toBeNull();
  });
});

describe("cli wiring", () => {
  it("adds the chat commands, reuses the stored credential and never prints a token", () => {
    expect(CLI).toContain('chatClientFor(ctx, "terminal")');
    expect(CLI).toContain("isChatCommand(command)");
    expect(CLI).toMatch(/threadlink new --project P --mode team/);
    // No output line mentions the token or the credential store.
    for (const line of CLI.split("\n").filter((l) =>
      /\bsay\(|stdout\.write|stderr\.write/.test(l),
    )) {
      expect(line).not.toMatch(/token|loadToken|store\.load/i);
    }
  });
});
