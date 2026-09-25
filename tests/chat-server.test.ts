import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireThreadLinkUser, listMyChat, postMyChatMessage, ChatRoomNotFoundError } = vi.hoisted(
  () => {
    class ChatRoomNotFoundError extends Error {}
    return {
      requireThreadLinkUser: vi.fn(async () => ({ id: "tlusr_alice" })),
      listMyChat: vi.fn(),
      postMyChatMessage: vi.fn(),
      ChatRoomNotFoundError,
    };
  },
);
vi.mock("@/lib/auth/threadlink-user", () => ({ requireThreadLinkUser }));
vi.mock("@/lib/chat/owner", () => ({ listMyChat, postMyChatMessage, ChatRoomNotFoundError }));

import { GET, POST } from "@/app/api/dashboard/chat/route";
import type { ThreadLinkUser } from "@/lib/auth/provision";
import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import {
  CHAT_ERROR_MESSAGES,
  chatErrorReason,
  parseChatSearchParams,
  toChatEvent,
  type ChatEventRow,
} from "@/lib/chat/model";
import { listChatFor, postChatMessageAs } from "@/lib/chat/queries";
import * as chatTypes from "@/lib/chat/types";
import { OwnershipViolationError } from "@/lib/connections/model";

const ROOM = "tlrom_00112233445566778899aabbccddeeff";
const OTHER_ROOM = "tlrom_ffeeddccbbaa99887766554433221100";
const JOB = "tljob_00112233445566778899aabbccddeeff";
const USER: ThreadLinkUser = {
  id: "tlusr_alice",
  clerkUserId: "user_alice",
  displayName: null,
  primaryEmail: null,
  createdAt: "2026-09-25T00:00:00Z",
};

const row = (seq: number, over: Partial<ChatEventRow> = {}): ChatEventRow => ({
  seq,
  id: `tlcev_${String(seq).padStart(32, "0")}`,
  owner_user_id: USER.id,
  created_at: "2026-09-25T00:00:00Z",
  room_id: ROOM,
  agent_session_id: "tlses_00112233445566778899aabbccddeeff",
  job_id: JOB,
  task_id: null,
  node_id: null,
  author_kind: "agent",
  author_provider: "codex",
  author_label: "Codex",
  author_role: "builder",
  audience: "team",
  event_type: "agent_message",
  message_type: "proposal",
  round: 1,
  model_requested: null,
  model_observed: "gpt-5.1-codex",
  body: "Plan: add a limiter",
  visibility: "visible",
  ...over,
});

type Op = [string, unknown[]];
/** A chainable fake of the Supabase query builder: records every call per table. */
function fakeDb(
  tables: Record<string, { data: unknown; error?: unknown }>,
  rpcResult: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const calls: { table: string; ops: Op[] }[] = [];
  const from = (table: string) => {
    const rec = { table, ops: [] as Op[] };
    calls.push(rec);
    const result = () => ({
      data: tables[table]?.data ?? null,
      error: tables[table]?.error ?? null,
    });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gt", "is", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        rec.ops.push([m, args]);
        return builder;
      };
    }
    builder.maybeSingle = async () => result();
    builder.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(ok, err);
    return builder;
  };
  const rpc = vi.fn(async () => rpcResult);
  return { db: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

const roomData = { data: { id: ROOM, owner_user_id: USER.id, status: "active" } };

describe("chat event mapping", () => {
  it("maps a row to the shared ChatEvent shape", () => {
    const e = toChatEvent(row(7));
    expect(e).toMatchObject({
      seq: 7,
      roomId: ROOM,
      authorKind: "agent",
      authorProvider: "codex",
      authorLabel: "Codex",
      modelObserved: "gpt-5.1-codex",
      eventType: "agent_message",
    });
    expect(Object.keys(e)).not.toContain("owner_user_id");
  });

  it("never shows a provider on a non-agent row", () => {
    const e = toChatEvent(
      row(1, { author_kind: "threadlink", author_label: "ThreadLink", author_provider: "codex" }),
    );
    expect(e.authorProvider).toBeNull();
  });

  it("the migration's vocabularies equal the shared types", () => {
    const sql = readFileSync("supabase/migrations/20260926000100_collaboration_chat.sql", "utf8");
    const check =
      /constraint chat_events_event_type_check check \(event_type in \(([^)]*)\)\)/.exec(sql)?.[1];
    const inSql = [...(check ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inSql).toEqual([...chatTypes.CHAT_EVENT_TYPES]);
    expect(sql).toContain("check (author_kind in ('controller', 'owner', 'threadlink', 'agent'))");
    expect(sql).toContain("check (audience in ('claude-code', 'codex', 'team'))");
    expect(sql).toContain("check (mode in ('solo', 'pair', 'team'))");
  });
});

describe("listChatFor", () => {
  it("returns the latest page oldest-first with the cursor and the active job", async () => {
    const { db, calls } = fakeDb({
      rooms: roomData,
      chat_events: { data: [row(9), row(8)] },
      team_jobs: {
        data: [{ id: JOB, owner_user_id: USER.id, mode: "pair", status: "building" }],
      },
    });
    const page = await listChatFor(db, USER, { roomId: ROOM });
    expect(page.events.map((e) => e.seq)).toEqual([8, 9]);
    expect(page.cursor).toBe(9);
    expect(page.activeJob).toEqual({ jobId: JOB, mode: "pair", status: "building" });
    const events = calls.find((c) => c.table === "chat_events")!;
    expect(events.ops).toContainEqual(["eq", ["visibility", "visible"]]);
    expect(events.ops).toContainEqual(["order", ["seq", { ascending: false }]]);
    expect(events.ops).toContainEqual(["limit", [200]]);
  });

  it("polls after a cursor, oldest first, and includes technical events only on request", async () => {
    const { db, calls } = fakeDb({
      rooms: roomData,
      chat_events: { data: [row(11), row(12, { visibility: "technical" })] },
      team_jobs: { data: [] },
    });
    const page = await listChatFor(db, USER, { roomId: ROOM, after: 10, technical: true });
    expect(page.cursor).toBe(12);
    expect(page.activeJob).toBeNull();
    const events = calls.find((c) => c.table === "chat_events")!;
    expect(events.ops).toContainEqual(["gt", ["seq", 10]]);
    expect(events.ops).not.toContainEqual(["eq", ["visibility", "visible"]]);
  });

  it("keeps the cursor when nothing is new", async () => {
    const { db } = fakeDb({ rooms: roomData, chat_events: { data: [] }, team_jobs: { data: [] } });
    expect((await listChatFor(db, USER, { roomId: ROOM, after: 42 })).cursor).toBe(42);
  });

  it("fails closed on another owner's room or row", async () => {
    const foreignRoom = fakeDb({
      rooms: { data: { id: ROOM, owner_user_id: "tlusr_bob", status: "active" } },
    });
    await expect(listChatFor(foreignRoom.db, USER, { roomId: ROOM })).rejects.toBeInstanceOf(
      OwnershipViolationError,
    );
    const foreignRow = fakeDb({
      rooms: roomData,
      chat_events: { data: [row(1, { owner_user_id: "tlusr_bob" })] },
      team_jobs: { data: [] },
    });
    await expect(listChatFor(foreignRow.db, USER, { roomId: ROOM })).rejects.toBeInstanceOf(
      OwnershipViolationError,
    );
    const otherRoomRow = fakeDb({
      rooms: roomData,
      chat_events: { data: [row(1, { room_id: OTHER_ROOM })] },
      team_jobs: { data: [] },
    });
    await expect(listChatFor(otherRoomRow.db, USER, { roomId: ROOM })).rejects.toBeInstanceOf(
      OwnershipViolationError,
    );
  });

  it("a missing or deleted room is not found; a malformed id never reaches the database", async () => {
    const missing = fakeDb({ rooms: { data: null } });
    await expect(listChatFor(missing.db, USER, { roomId: ROOM })).rejects.toThrow(
      "Project not found",
    );
    const deleted = fakeDb({
      rooms: { data: { id: ROOM, owner_user_id: USER.id, status: "deleted" } },
    });
    await expect(listChatFor(deleted.db, USER, { roomId: ROOM })).rejects.toThrow(
      "Project not found",
    );
    const none = fakeDb({});
    await expect(listChatFor(none.db, USER, { roomId: "rooms; drop" })).rejects.toThrow();
    expect(none.calls).toHaveLength(0);
  });
});

describe("postChatMessageAs", () => {
  it("passes the composer's fields and returns where the message went", async () => {
    const { db, rpc } = fakeDb(
      {},
      { data: { routed: "new_job", job_id: JOB, event_id: "tlcev_x" }, error: null },
    );
    const out = await postChatMessageAs(db, {
      roomId: ROOM,
      body: "@codex add a README",
      mode: "solo",
      idempotencyKey: "k-1",
    });
    expect(out).toEqual({ ok: true, routed: "new_job", jobId: JOB });
    expect(rpc).toHaveBeenCalledWith("post_chat_message", {
      p_room_id: ROOM,
      p_body: "@codex add a README",
      p_mode: "solo",
      p_builder: null,
      p_idempotency_key: "k-1",
    });
  });

  it("maps database refusals to fixed sentences, never database text", async () => {
    const { db } = fakeDb(
      {},
      {
        data: null,
        error: {
          code: "55000",
          hint: "route_missing",
          message: "this project is not linked any more (internal detail tllnk_123)",
        },
      },
    );
    const out = await postChatMessageAs(db, { roomId: ROOM, body: "hi" });
    expect(out).toEqual({
      ok: false,
      reason: "route_missing",
      message:
        "This project's conversation isn't linked any more. Ask your controller to reconnect it.",
    });
    expect(JSON.stringify(out)).not.toContain("tllnk_");
  });

  it("refuses bad input before the database", async () => {
    const { db, rpc } = fakeDb({});
    expect(await postChatMessageAs(db, { roomId: ROOM, body: "x".repeat(4001) })).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    expect(await postChatMessageAs(db, { roomId: ROOM, body: "   " })).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(
      await postChatMessageAs(db, { roomId: ROOM, body: "hi", authorKind: "threadlink" }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(await postChatMessageAs(db, { roomId: ROOM, body: "hi", mode: "swarm" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps codes and hints", () => {
    expect(chatErrorReason({ code: "P0002" })).toBe("not_found");
    expect(chatErrorReason({ code: "54000", hint: "rate_limited" })).toBe("rate_limited");
    expect(chatErrorReason({ code: "55000", hint: "runtime_outdated" })).toBe("runtime_outdated");
    expect(chatErrorReason({ code: "22023", hint: "invalid_mode" })).toBe("invalid");
    expect(chatErrorReason({ code: "55000", hint: "constructor" })).toBe("conflict");
    expect(chatErrorReason({ code: "XX000" })).toBe("unavailable");
  });
});

describe("parseChatSearchParams", () => {
  it("accepts the documented query and nothing else", () => {
    expect(parseChatSearchParams(new URLSearchParams(`room=${ROOM}&after=5&technical=1`))).toEqual({
      roomId: ROOM,
      after: 5,
      technical: true,
    });
    expect(parseChatSearchParams(new URLSearchParams(`room=${ROOM}`))).toEqual({
      roomId: ROOM,
      technical: false,
    });
    expect(parseChatSearchParams(new URLSearchParams(`room=${ROOM}&after=-1`))).toBeNull();
    expect(parseChatSearchParams(new URLSearchParams(`room=${ROOM}&after=1e3`))).toBeNull();
    expect(parseChatSearchParams(new URLSearchParams(`room=x`))).toBeNull();
    expect(parseChatSearchParams(new URLSearchParams(`room=${ROOM}&technical=yes`))).toBeNull();
  });
});

/** What the app's own fetch sends. */
const SAME_ORIGIN = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

describe("GET/POST /api/dashboard/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireThreadLinkUser.mockImplementation(async () => ({ id: "tlusr_alice" }));
  });

  it("an unauthenticated caller gets 401 and nothing is read", async () => {
    requireThreadLinkUser.mockImplementation(async () => {
      throw new AuthenticationRequiredError();
    });
    const text = vi.fn();
    const res = await POST({
      headers: new Headers(SAME_ORIGIN),
      url: "http://x/api/dashboard/chat",
      text,
    } as unknown as Request);
    expect(res.status).toBe(401);
    expect(text).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: false, message: CHAT_ERROR_MESSAGES.unauthenticated });
    expect((await GET(new Request(`http://x/api/dashboard/chat?room=${ROOM}`))).status).toBe(401);
    expect(listMyChat).not.toHaveBeenCalled();
  });

  it("GET returns the page; a malformed query is 400; another owner's room is 404", async () => {
    listMyChat.mockResolvedValueOnce({ events: [], cursor: 0, activeJob: null });
    const ok = await GET(new Request(`http://x/api/dashboard/chat?room=${ROOM}&after=0`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(listMyChat).toHaveBeenCalledWith({ roomId: ROOM, after: 0, technical: false });

    expect((await GET(new Request("http://x/api/dashboard/chat?room=bad"))).status).toBe(400);

    listMyChat.mockRejectedValueOnce(new OwnershipViolationError());
    const foreign = await GET(new Request(`http://x/api/dashboard/chat?room=${ROOM}`));
    expect(foreign.status).toBe(404);
    listMyChat.mockRejectedValueOnce(new ChatRoomNotFoundError());
    expect((await GET(new Request(`http://x/api/dashboard/chat?room=${ROOM}`))).status).toBe(404);
  });

  it("POST caps the body size before parsing and maps refusals to status codes", async () => {
    const big = await POST(
      new Request("http://x/api/dashboard/chat", {
        headers: SAME_ORIGIN,
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, body: "x".repeat(30_000) }),
      }),
    );
    expect(big.status).toBe(400);
    expect(postMyChatMessage).not.toHaveBeenCalled();

    const bad = await POST(
      new Request("http://x/api/dashboard/chat", {
        headers: SAME_ORIGIN,
        method: "POST",
        body: "{",
      }),
    );
    expect(bad.status).toBe(400);

    postMyChatMessage.mockResolvedValueOnce({
      ok: false,
      reason: "rate_limited",
      message: CHAT_ERROR_MESSAGES.rate_limited,
    });
    const limited = await POST(
      new Request("http://x/api/dashboard/chat", {
        headers: SAME_ORIGIN,
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, body: "hi" }),
      }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, message: CHAT_ERROR_MESSAGES.rate_limited });

    postMyChatMessage.mockResolvedValueOnce({ ok: true, routed: "note_to_active_job", jobId: JOB });
    const ok = await POST(
      new Request("http://x/api/dashboard/chat", {
        headers: SAME_ORIGIN,
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, body: "hi" }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, routed: "note_to_active_job", jobId: JOB });
  });

  it("an unexpected failure is a generic 503 without details", async () => {
    postMyChatMessage.mockRejectedValueOnce(new Error("connection refused at 10.0.0.1"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(
      new Request("http://x/api/dashboard/chat", {
        headers: SAME_ORIGIN,
        method: "POST",
        body: JSON.stringify({ roomId: ROOM, body: "hi" }),
      }),
    );
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.1");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("10.0.0.1");
    spy.mockRestore();
  });
});

describe("chat posts are same-origin JSON only", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://threadlink-one.vercel.app/api/dashboard/chat", {
      method: "POST",
      headers,
    });
  it("accepts the app's own fetch and refuses cross-site forms", async () => {
    const { sameOriginJson } = await import("@/lib/chat/same-origin");
    const json = { "content-type": "application/json" };
    expect(sameOriginJson(req({ ...json, "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOriginJson(req({ ...json, origin: "https://threadlink-one.vercel.app" }))).toBe(
      true,
    );
    expect(
      sameOriginJson(req({ "content-type": "text/plain", "sec-fetch-site": "same-origin" })),
    ).toBe(false);
    expect(sameOriginJson(req({ ...json, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOriginJson(req({ ...json, origin: "https://evil.example" }))).toBe(false);
    expect(sameOriginJson(req(json))).toBe(false);
  });
});
