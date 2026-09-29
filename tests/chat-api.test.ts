import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

// The credential and the database are the only things mocked: every route
// runs its real handler, parser and error mapping.
const identity = vi.hoisted(() => ({
  value: {
    connectionId: "tlcon_00112233445566778899aabbccddeeff",
    ownerUserId: "tlusr_00112233445566778899aabbccddeeff",
    platform: "claude-code",
    role: "agent" as "agent" | "controller",
    status: "active",
  },
  fail: false,
}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/connections/require-connection", () => ({
  requireConnectionContext: vi.fn(async () => {
    if (identity.fail) throw new Error("no");
    return { identity: identity.value, credentialHash: "ab".repeat(32) };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAnonymousSupabaseClient: () => ({ rpc }),
}));

import * as eventsRoute from "@/app/api/runtime/chats/[chatId]/events/route";
import * as messagesRoute from "@/app/api/runtime/chats/[chatId]/messages/route";
import * as readRoute from "@/app/api/runtime/chats/[chatId]/read/route";
import * as chatRoute from "@/app/api/runtime/chats/[chatId]/route";
import * as chatsRoute from "@/app/api/runtime/chats/route";
import {
  ChatApiError,
  chatApiErrorFrom,
  parseEventsQuery,
  postControllerChatMessage,
} from "@/lib/client-api/chats";
import type { ClientDatabase } from "@/lib/client-api/operations";
import {
  describeError,
  getChatTool,
  sendMessageTool,
  toolInputs,
  type McpContext,
} from "@/lib/mcp/tools";

const CHAT = "tlcht_00112233445566778899aabbccddeeff";
const OTHER = "tlcht_ffeeddccbbaa99887766554433221100";
const ROOM = "tlrom_00112233445566778899aabbccddeeff";
const JOB = "tljob_00112233445566778899aabbccddeeff";
const EV = "tlcev_00112233445566778899aabbccddeeff";
const S = "tlses_00112233445566778899aabbccddeeff";

const summary = (over: Record<string, unknown> = {}) => ({
  chat_id: CHAT,
  name: "Prism auth",
  mode: "team",
  settings: { mode: "team", solo_provider: null, builder_provider: null, reviewer_provider: null },
  project: {
    project_id: ROOM,
    name: "Prism",
    status: "active",
    runs_on: "Nickron's PC",
    runtime_online: true,
    this_computer: true,
  },
  group_name: null,
  pinned: false,
  archived: false,
  is_room_default: true,
  last_activity_at: "2026-09-26T00:00:00Z",
  last_message: "hello",
  unread: true,
  last_read_cursor: 3,
  needs_attention: false,
  active_job: { job_id: JOB, mode: "team", status: "building" },
  participants: [
    {
      kind: "agent",
      provider: "claude-code",
      name: "Claude Code",
      short_name: "Claude",
      health: "ready",
    },
    { kind: "controller", provider: null, name: "ChatGPT", short_name: "ChatGPT", health: null },
    { kind: "owner", provider: null, name: "You", short_name: "You", health: null },
  ],
  ...over,
});
const event = (cursor: number, over: Record<string, unknown> = {}) => ({
  id: EV,
  cursor,
  created_at: "2026-09-26T00:00:00Z",
  author_kind: "owner",
  author_label: "You",
  author_provider: null,
  author_role: null,
  audience: "team",
  event_type: "message",
  message_type: null,
  round: null,
  model_requested: null,
  model_observed: null,
  body: "Make it faster",
  visibility: "visible",
  job_id: JOB,
  client: "desktop",
  ...over,
});

const ok = (data: unknown) => ({ data, error: null });
/** 0.11: a post first reads the chat's compose context (lane + open choices), then posts. */
const CONTEXT = {
  chat_id: "tlcht_" + "0".repeat(32),
  mode: "team",
  active_work_job: false,
  choices: [],
};
const withContext = (post: unknown) =>
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(fn === "runtime_chat_compose_context" ? ok(CONTEXT) : post),
  );
const err = (code: string, hint?: string, details?: string) => ({
  data: null,
  error: { message: "database text that must never be shown", code, hint, details },
});

const req = (url: string, init: RequestInit = {}) =>
  new Request(`http://localhost${url}`, {
    ...init,
    headers: { authorization: "Bearer x", ...(init.headers ?? {}) },
  });
const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

beforeEach(() => {
  rpc.mockReset();
  identity.fail = false;
  identity.value.role = "agent";
});

describe("runtime chat routes: who may call", () => {
  it("no or bad credential -> 401 with a fixed sentence, nothing called", async () => {
    identity.fail = true;
    const res = await chatsRoute.GET(req("/api/runtime/chats"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a controller credential is refused before the body is read", async () => {
    identity.value.role = "controller";
    const request = req(
      `/api/runtime/chats/${CHAT}/messages`,
      post({ body: "x" }, { "x-threadlink-client": "desktop" }),
    );
    const res = await messagesRoute.POST(request, params(CHAT));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "forbidden" });
    expect(request.bodyUsed).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a paused Runtime -> 403 runtime_paused (the database decides)", async () => {
    rpc.mockResolvedValue(err("42501", "runtime_paused"));
    const res = await chatsRoute.GET(req("/api/runtime/chats"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("runtime_paused");
    expect(JSON.stringify(body)).not.toContain("database text");
  });

  it("a revoked Runtime -> 401 (credential no longer authenticates in the database)", async () => {
    rpc.mockResolvedValue(err("28000"));
    const res = await chatRoute.GET(req(`/api/runtime/chats/${CHAT}`), params(CHAT));
    expect(res.status).toBe(401);
  });
});

describe("runtime chat routes: shapes", () => {
  it("GET /api/runtime/chats -> friendly summaries and projects", async () => {
    rpc.mockResolvedValue(
      ok({
        chats: [summary()],
        projects: [{ project_id: ROOM, name: "Prism", runs_on: "PC", this_computer: true }],
        runtime: {
          label: "Nickron's PC",
          online: true,
          version: "0.9.3",
          protocol: 9,
          min_protocol: 10,
          current_protocol: 10,
          update_required: true,
        },
      }),
    );
    const res = await chatsRoute.GET(req("/api/runtime/chats?archived=1&search=pri"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(rpc).toHaveBeenCalledWith("runtime_list_chats", {
      p_token_hash: "ab".repeat(32),
      p_include_archived: true,
      p_search: "pri",
    });
    expect(body.chats[0]).toMatchObject({
      chatId: CHAT,
      name: "Prism auth",
      roomId: ROOM,
      projectName: "Prism",
      runtimeLabel: "Nickron's PC",
      runtimeOnline: true,
      thisComputer: true,
      lastReadCursor: 3,
      activeJob: { jobId: JOB, mode: "team", status: "building" },
    });
    expect(body.chats[0].participants[1]).toEqual({
      kind: "controller",
      provider: null,
      name: "ChatGPT",
      shortName: "ChatGPT",
      health: null,
    });
    expect(body.projects).toEqual([
      { roomId: ROOM, name: "Prism", runtimeLabel: "PC", thisComputer: true },
    ]);
    expect(body.runtime).toEqual({
      label: "Nickron's PC",
      online: true,
      version: "0.9.3",
      protocol: 9,
      minProtocol: 10,
      currentProtocol: 10,
      updateRequired: true,
      presence: null,
      lastSeenAt: null,
    });
  });

  it("GET list with a malformed flag or an oversized search -> 400/413, nothing called", async () => {
    expect((await chatsRoute.GET(req("/api/runtime/chats?archived=maybe"))).status).toBe(400);
    expect((await chatsRoute.GET(req(`/api/runtime/chats?search=${"x".repeat(101)}`))).status).toBe(
      400,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("another account's chat -> 404 chat_not_found (like a missing one)", async () => {
    rpc.mockResolvedValue(err("P0002", "chat_not_found"));
    const res = await chatRoute.GET(req(`/api/runtime/chats/${OTHER}`), params(OTHER));
    // (the success shape is covered below)
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "chat_not_found",
      message: "This chat wasn't found.",
    });
  });

  it("GET one chat -> the summary plus live activity", async () => {
    rpc.mockResolvedValue(ok({ ...summary(), activity: [] }));
    const res = await chatRoute.GET(req(`/api/runtime/chats/${CHAT}`), params(CHAT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chatId: CHAT, unreadCount: 1, activity: [] });
  });

  it("a malformed chat id reads like a missing chat, without a database call", async () => {
    const res = await chatRoute.GET(req("/api/runtime/chats/nope"), params("nope"));
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("events: per-chat cursor out, never the global seq", async () => {
    rpc.mockResolvedValue(
      ok({
        chat_id: CHAT,
        events: [
          event(4),
          event(5, {
            author_kind: "agent",
            author_label: "Codex",
            author_provider: "codex",
            client: null,
          }),
        ],
        cursor: 5,
        oldest_cursor: 4,
        has_more: false,
        active_job: null,
        activity: [
          {
            run_id: "tlarn_00112233445566778899aabbccddeeff",
            provider: "codex",
            provider_name: "Codex",
            role: "reviewer",
            activity: "reviewing",
            started_at: "2026-09-26T00:00:00Z",
            last_activity_at: "2026-09-26T00:01:00Z",
          },
        ],
        deliveries: [{ cursor: 4, delivery: { state: "queued", for: ["codex"] } }],
      }),
    );
    const res = await eventsRoute.GET(
      req(`/api/runtime/chats/${CHAT}/events?after=3&limit=50`),
      params(CHAT),
    );
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("runtime_chat_events", {
      p_token_hash: "ab".repeat(32),
      p_chat_id: CHAT,
      p_after: 3,
      p_before: null,
      p_limit: 50,
      p_technical: false,
    });
    const body = await res.json();
    expect(body).toMatchObject({
      chatId: CHAT,
      cursor: 5,
      oldestCursor: 4,
      hasMore: false,
      activeJob: null,
    });
    expect(body.events.map((e: { cursor: number }) => e.cursor)).toEqual([4, 5]);
    expect(body.events[1]).toMatchObject({ authorProvider: "codex", client: null });
    expect(body.activity).toEqual([
      {
        runId: "tlarn_00112233445566778899aabbccddeeff",
        provider: "codex",
        providerName: "Codex",
        role: "reviewer",
        activity: "reviewing",
        startedAt: "2026-09-26T00:00:00Z",
        lastActivityAt: "2026-09-26T00:01:00Z",
      },
    ]);
    expect(body.deliveries).toEqual([{ cursor: 4, delivery: { state: "queued", for: ["codex"] } }]);
    expect(JSON.stringify(body)).not.toMatch(/"seq"|agent_session|idempotency/);
  });

  it("events: after+before, bad numbers or a page over 200 are refused", async () => {
    for (const q of [
      "after=1&before=2",
      "after=-1",
      "after=abc",
      "limit=201",
      "limit=0",
      "technical=yes",
    ]) {
      const res = await eventsRoute.GET(
        req(`/api/runtime/chats/${CHAT}/events?${q}`),
        params(CHAT),
      );
      expect(res.status, q).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("POST /api/runtime/chats creates a chat", async () => {
    rpc.mockResolvedValue(ok(summary({ active_job: null })));
    const res = await chatsRoute.POST(
      req("/api/runtime/chats", post({ name: "New", roomId: ROOM, mode: "pair" })),
    );
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("runtime_create_chat", {
      p_token_hash: "ab".repeat(32),
      p_name: "New",
      p_room_id: ROOM,
      p_mode: "pair",
    });
    expect((await res.json()).chat.chatId).toBe(CHAT);
  });

  it("POST create: unknown fields or a bad body are refused", async () => {
    expect(
      (await chatsRoute.POST(req("/api/runtime/chats", post({ name: "x", owner: "someone" }))))
        .status,
    ).toBe(400);
    expect((await chatsRoute.POST(req("/api/runtime/chats", post("not json")))).status).toBe(400);
    expect((await chatsRoute.POST(req("/api/runtime/chats", post([1, 2])))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("runtime chat routes: posting as the owner", () => {
  it("records the client from the header; the author is the database's", async () => {
    withContext(ok({ routed: "new_job", job_id: JOB, event_id: EV, chat_id: CHAT }));
    const res = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        post({ body: "Build it", idempotencyKey: "k-1" }, { "x-threadlink-client": "terminal" }),
      ),
      params(CHAT),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      routed: "new_job",
      jobId: JOB,
      eventId: EV,
      replayed: false,
    });
    expect(rpc).toHaveBeenCalledWith("runtime_chat_compose_context", {
      p_token_hash: "ab".repeat(32),
      p_chat_id: CHAT,
    });
    expect(rpc).toHaveBeenCalledWith("runtime_post_chat_message", {
      p_token_hash: "ab".repeat(32),
      p_chat_id: CHAT,
      p_body: "Build it",
      p_idempotency_key: "k-1",
      p_client: "terminal",
      // 0.11: classified server-side (lib/chat/intent.ts); no open choice to answer.
      p_lane: "work",
      p_lane_reason: "edit_requested",
      p_choice_id: null,
      p_choice_key: null,
    });
  });

  it("the client may come from the body instead; both must agree; one is required", async () => {
    withContext(ok({ routed: "note_to_active_job", job_id: JOB, event_id: EV, replayed: true }));
    const viaBody = await messagesRoute.POST(
      req(`/api/runtime/chats/${CHAT}/messages`, post({ body: "x", client: "desktop" })),
      params(CHAT),
    );
    expect(await viaBody.json()).toMatchObject({ ok: true, replayed: true });
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_client: "desktop" });
    rpc.mockClear();
    for (const [body, headers] of [
      [{ body: "x" }, {}],
      [{ body: "x", client: "web" }, {}],
      [{ body: "x" }, { "x-threadlink-client": "chatgpt" }],
      [{ body: "x", client: "desktop" }, { "x-threadlink-client": "terminal" }],
    ] as const) {
      const res = await messagesRoute.POST(
        req(`/api/runtime/chats/${CHAT}/messages`, post(body, headers)),
        params(CHAT),
      );
      expect(res.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("oversized bodies -> 413 before the database; a too-long message -> 400 too_long", async () => {
    const huge = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        post({ body: "x".repeat(25_000) }, { "x-threadlink-client": "desktop" }),
      ),
      params(CHAT),
    );
    expect(huge.status).toBe(413);
    const declared = await messagesRoute.POST(
      req(`/api/runtime/chats/${CHAT}/messages`, {
        ...post({ body: "x" }, { "x-threadlink-client": "desktop" }),
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
          "x-threadlink-client": "desktop",
        },
      }),
      params(CHAT),
    );
    expect(declared.status).toBe(413);
    const long = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        post({ body: "x".repeat(4001) }, { "x-threadlink-client": "desktop" }),
      ),
      params(CHAT),
    );
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ reason: "too_long" });
    const empty = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        post({ body: "   " }, { "x-threadlink-client": "desktop" }),
      ),
      params(CHAT),
    );
    expect(await empty.json()).toMatchObject({ reason: "empty" });
    const read = await readRoute.POST(
      req(`/api/runtime/chats/${CHAT}/read`, post({ cursor: 1, pad: "x".repeat(300) })),
      params(CHAT),
    );
    expect(read.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the health gate: 409 provider_unhealthy with who is not ready, stored:true", async () => {
    withContext(
      ok({
        routed: "provider_blocked",
        job_id: null,
        event_id: EV,
        health: [
          { provider: "claude-code", health: "ready" },
          { provider: "codex", health: "needs_sign_in" },
        ],
      }),
    );
    const res = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        post({ body: "Build" }, { "x-threadlink-client": "desktop" }),
      ),
      params(CHAT),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      reason: "provider_unhealthy",
      stored: true,
      eventId: EV,
    });
    expect(body.message).toContain("Codex needs you to sign in again");
    expect(body.health).toHaveLength(2);
  });

  it("needs_project, rate limits and idempotency conflicts keep their own reasons", async () => {
    const cases: [ReturnType<typeof err>, number, string][] = [
      [err("55000", "needs_project"), 409, "needs_project"],
      [err("54000", "rate_limited"), 429, "rate_limited"],
      [err("55000", "idempotency_conflict"), 409, "idempotency_conflict"],
      [err("XX000"), 503, "unavailable"],
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [e, status, reason] of cases) {
      rpc.mockResolvedValueOnce(e);
      const res = await messagesRoute.POST(
        req(
          `/api/runtime/chats/${CHAT}/messages`,
          post({ body: "x" }, { "x-threadlink-client": "desktop" }),
        ),
        params(CHAT),
      );
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.reason).toBe(reason);
      expect(JSON.stringify(body)).not.toContain("database text");
    }
    spy.mockRestore();
  });

  it("POST read {cursor} -> lastReadCursor; {seq} is not accepted", async () => {
    rpc.mockResolvedValue(ok({ chat_id: CHAT, last_read_cursor: 7 }));
    const res = await readRoute.POST(
      req(`/api/runtime/chats/${CHAT}/read`, post({ cursor: 9 })),
      params(CHAT),
    );
    expect(await res.json()).toEqual({ ok: true, lastReadCursor: 7 });
    expect(rpc).toHaveBeenCalledWith("runtime_mark_chat_read", {
      p_token_hash: "ab".repeat(32),
      p_chat_id: CHAT,
      p_cursor: 9,
    });
    rpc.mockClear();
    expect(
      (await readRoute.POST(req(`/api/runtime/chats/${CHAT}/read`, post({ seq: 9 })), params(CHAT)))
        .status,
    ).toBe(400);
    expect(
      (
        await readRoute.POST(
          req(`/api/runtime/chats/${CHAT}/read`, post({ cursor: -1 })),
          params(CHAT),
        )
      ).status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("the hint wins over the code; unknown hints fall back to the code", () => {
    expect(chatApiErrorFrom({ code: "42501", hint: "runtime_paused" }).reason).toBe(
      "runtime_paused",
    );
    expect(chatApiErrorFrom({ code: "42501", hint: "review_required" }).reason).toBe(
      "review_required",
    );
    expect(chatApiErrorFrom({ code: "42501", hint: "whatever" }).reason).toBe("forbidden");
    expect(chatApiErrorFrom({ code: "P0002", hint: "project_not_found" }).reason).toBe(
      "project_not_found",
    );
    expect(chatApiErrorFrom({ code: "22023", hint: "invalid_mode" }).reason).toBe("invalid");
    expect(chatApiErrorFrom({ code: "99999" }).reason).toBe("unavailable");
  });
  it("a health refusal parses the machine-readable detail only", () => {
    const e = chatApiErrorFrom({
      code: "55000",
      hint: "provider_unhealthy",
      details: "claude-code=needs_sign_in,codex=ready",
    });
    expect(e.health).toEqual([
      { provider: "claude-code", health: "needs_sign_in" },
      { provider: "codex", health: "ready" },
    ]);
    expect(e.userMessage).toContain("Claude Code needs you to sign in again");
  });
  it("parseEventsQuery", () => {
    expect(parseEventsQuery(new URLSearchParams("before=10&limit=5&technical=1"))).toEqual({
      before: 10,
      limit: 5,
      technical: true,
    });
    expect(parseEventsQuery(new URLSearchParams("after=1&before=2"))).toBeNull();
  });
});

describe("MCP chat tools", () => {
  const ctxWith = (impl: (fn: string) => { data: unknown; error: unknown }) => {
    const call = vi.fn(async (fn: string) => impl(fn));
    const ctx: McpContext = {
      db: { rpc: call } as unknown as ClientDatabase,
      credentialHash: "cd".repeat(32),
      identity: {
        ...identity.value,
        role: "controller",
        platform: "chatgpt",
      } as McpContext["identity"],
    };
    return { ctx, call };
  };

  it("inputs: opaque handles only, bounded message", () => {
    const send = z.object(toolInputs.send_message);
    expect(send.safeParse({ sessionId: S, chatId: CHAT, message: "hi" }).success).toBe(true);
    expect(send.safeParse({ sessionId: S, chatId: "Prism", message: "hi" }).success).toBe(false);
    expect(send.safeParse({ sessionId: S, chatId: CHAT, message: "x".repeat(4001) }).success).toBe(
      false,
    );
    expect(
      z.object(toolInputs.create_chat).safeParse({ sessionId: S, projectId: ROOM, name: "x" })
        .success,
    ).toBe(true);
  });

  it("get_chat returns names and messages, no internal ids besides the chat/job handles", async () => {
    const { ctx, call } = ctxWith(() =>
      ok({
        chat: summary(),
        messages: {
          events: [event(1, { author_kind: "controller", author_label: "ChatGPT", client: null })],
          cursor: 1,
          oldest_cursor: 1,
          has_more: false,
        },
      }),
    );
    const out = await getChatTool(ctx, { sessionId: S, chatId: CHAT });
    expect(call).toHaveBeenCalledWith("controller_get_chat", {
      p_token_hash: "cd".repeat(32),
      p_session_id: S,
      p_chat_id: CHAT,
      p_after: null,
      p_limit: null,
    });
    expect(out.chat).toMatchObject({
      name: "Prism auth",
      project: "Prism",
      runsOn: "Nickron's PC",
    });
    expect(out.messages).toEqual([
      {
        cursor: 1,
        at: "2026-09-26T00:00:00Z",
        from: "ChatGPT",
        kind: "message",
        text: "Make it faster",
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/tlrom_|tlcev_|tlses_/);
  });

  it("send_message: a running chat is refused with a fixed sentence", async () => {
    const { ctx } = ctxWith(() => err("55000", "job_active"));
    await expect(
      sendMessageTool(ctx, { sessionId: S, chatId: CHAT, message: "more" }),
    ).rejects.toBeInstanceOf(ChatApiError);
    try {
      await postControllerChatMessage(ctx.db, ctx.credentialHash, {
        sessionId: S,
        chatId: CHAT,
        body: "more",
      });
    } catch (e) {
      expect(describeError(e)).toBe(
        "Work is still running in this chat. Stop it first, then try again.",
      );
    }
  });

  it("send_message: another account's or an unlinked chat reads as not found", async () => {
    const { ctx } = ctxWith(() => err("P0002", "chat_not_found"));
    const e = await sendMessageTool(ctx, { sessionId: S, chatId: OTHER, message: "x" }).catch(
      (x) => x,
    );
    expect(describeError(e)).toBe("This chat wasn't found.");
  });
});
