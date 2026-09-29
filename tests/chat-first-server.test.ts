import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const owner = vi.hoisted(() => ({
  requireThreadLinkUser: vi.fn(async () => ({ id: "tlusr_alice" })),
  listMyChats: vi.fn(),
  listMyChatGroups: vi.fn(),
  getMyChat: vi.fn(),
  createMyChat: vi.fn(),
  updateMyChat: vi.fn(),
  setMyChatPinned: vi.fn(),
  setMyChatArchived: vi.fn(),
  deleteMyChat: vi.fn(),
  markMyChatRead: vi.fn(),
  createMyChatGroup: vi.fn(),
  renameMyChatGroup: vi.fn(),
  deleteMyChatGroup: vi.fn(),
}));
vi.mock("@/lib/auth/threadlink-user", () => ({
  requireThreadLinkUser: owner.requireThreadLinkUser,
}));
vi.mock("@/lib/chat/owner", () => owner);

import {
  GET as chatGET,
  PATCH as chatPATCH,
  DELETE as chatDELETE,
} from "@/app/api/dashboard/chats/[chatId]/route";
import { POST as readPOST } from "@/app/api/dashboard/chats/[chatId]/read/route";
import {
  PATCH as groupPATCH,
  DELETE as groupDELETE,
} from "@/app/api/dashboard/chats/groups/[groupId]/route";
import { GET as groupsGET, POST as groupsPOST } from "@/app/api/dashboard/chats/groups/route";
import { GET as chatsGET, POST as chatsPOST } from "@/app/api/dashboard/chats/route";
import type { ThreadLinkUser } from "@/lib/auth/provision";
import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import {
  ChatActionError,
  getChatFor,
  listChatsFor,
  retryJobWithRolesAs,
  updateChatAs,
} from "@/lib/chat/chats";
import { CHAT_ERROR_MESSAGES, parseChatSearchParams } from "@/lib/chat/model";
import { ChatNotFoundError, listChatFor, postChatMessageAs } from "@/lib/chat/queries";
import { PROVIDER_HEALTH } from "@/lib/chat/types";
import { ClientOperationError } from "@/lib/client-api/operations";
import { OwnershipViolationError } from "@/lib/connections/model";
import { describeError } from "@/lib/mcp/tools";
import {
  effectiveHealth,
  healthLine,
  healthMessage,
  HEALTH_DETAILS,
  healthSentence,
  parseHealthDetail,
} from "@/lib/providers/health";
import {
  ProviderUnhealthyError,
  providerDetectionSchema,
  startTeamJob,
} from "@/lib/team/client-api";
import { teamWriteOpSchema, toSqlPayload, VERDICT_REASONS } from "@/lib/team/model";

import { HEALTH_DETAIL as RUNTIME_HEALTH_DETAIL } from "../runtime/src/team/health.ts";

const USER: ThreadLinkUser = {
  id: "tlusr_alice",
  clerkUserId: "user_alice",
  displayName: null,
  primaryEmail: null,
  createdAt: "2026-09-26T00:00:00Z",
};
const hex = (c: string) => c.repeat(32);
const CHAT = `tlcht_${hex("a")}`;
const CHAT2 = `tlcht_${hex("b")}`;
const ROOM = `tlrom_${hex("c")}`;
const GROUP = `tlgrp_${hex("d")}`;
const JOB = `tljob_${hex("e")}`;
const TASK = `tltask_${hex("f")}`;
const SESSION = `tlses_${hex("2")}`;
const RUNTIME = `tlrun_${hex("3")}`;
const OTHER_RUNTIME = `tlrun_${hex("4")}`;
const SQL = readFileSync("supabase/migrations/20260927000100_chat_first.sql", "utf8");
const NOW = Date.parse("2026-09-26T12:00:00Z");
const fresh = (over: Record<string, unknown> = {}) => ({
  installed: true,
  authenticated: true,
  authMethod: "chatgpt",
  health: "ready",
  healthCheckedAt: "2026-09-26T11:30:00Z",
  ...over,
});

// ---------------------------------------------------------------------------
// A chainable fake of the Supabase query builder (records every call).
// ---------------------------------------------------------------------------
type Op = [string, unknown[]];
function fakeDb(
  tables: Record<string, { data: unknown; error?: unknown }>,
  rpcs: Record<string, { data?: unknown; error?: unknown }> = {},
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
    for (const m of ["select", "eq", "gt", "is", "in", "ilike", "order", "limit"]) {
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
  const rpc = vi.fn(async (fn: string) => ({
    data: rpcs[fn]?.data ?? null,
    error: rpcs[fn]?.error ?? null,
  }));
  return { db: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

// ===========================================================================
describe("provider health", () => {
  it("is ready only after a recent, authenticated, subscription check", () => {
    expect(effectiveHealth("codex", fresh(), "2026-09-26T11:59:00Z", NOW)).toBe("ready");
    expect(
      effectiveHealth("codex", fresh({ health: undefined }), "2026-09-26T11:59:00Z", NOW),
    ).toBe("unknown");
    expect(
      effectiveHealth("codex", fresh({ authMethod: "api_key" }), "2026-09-26T11:59:00Z", NOW),
    ).toBe("api_key_auth");
    expect(
      effectiveHealth("codex", fresh({ authenticated: false }), "2026-09-26T11:59:00Z", NOW),
    ).toBe("needs_sign_in");
    expect(effectiveHealth("codex", fresh({ installed: false }), "2026-09-26T11:59:00Z", NOW)).toBe(
      "not_installed",
    );
    expect(
      effectiveHealth("codex", fresh({ health: "usage_exhausted" }), "2026-09-26T11:59:00Z", NOW),
    ).toBe("usage_exhausted");
    expect(
      effectiveHealth(
        "codex",
        fresh({ healthCheckedAt: "2026-09-26T09:00:00Z" }),
        "2026-09-26T11:59:00Z",
        NOW,
      ),
    ).toBe("unknown");
    // The server's receipt time bounds it too (an old report of a "fresh" check).
    expect(effectiveHealth("codex", fresh(), "2026-09-26T09:00:00Z", NOW)).toBe("unknown");
    expect(effectiveHealth("codex", {}, null, NOW)).toBe("unknown");
    expect(effectiveHealth("claude-code", fresh(), "2026-09-26T11:59:00Z", NOW)).toBe(
      "api_key_auth",
    );
  });

  it("says who is not ready in fixed words", () => {
    const entries = [
      { provider: "claude-code", health: "needs_sign_in" as const },
      { provider: "codex", health: "ready" as const },
    ];
    expect(healthLine(entries)).toBe("Claude Code — Needs sign-in · Codex — Ready");
    expect(healthMessage(entries)).toBe(
      "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer.",
    );
  });

  it("parses only the database's machine-readable detail", () => {
    expect(parseHealthDetail("claude-code=needs_sign_in,codex=ready")).toEqual([
      { provider: "claude-code", health: "needs_sign_in" },
      { provider: "codex", health: "ready" },
    ]);
    for (const bad of [
      "",
      "claude-code=fine",
      "Claude Code needs sign in",
      "a=ready=b",
      "claude-code=ready,<script>=ready",
      null,
      42,
    ]) {
      expect(parseHealthDetail(bad)).toBeNull();
    }
  });

  it("the database says the same sentences and knows the same health values", () => {
    for (const h of PROVIDER_HEALTH) {
      const tail = healthSentence("codex", h).slice("Codex".length);
      expect(SQL).toContain(`'${tail.replace(/'/g, "''")}'`);
    }
    const values =
      /provider_health_values\(\) returns text\[\][\s\S]*?select array\[([^\]]*)\]/.exec(SQL)?.[1];
    expect([...(values ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      ...PROVIDER_HEALTH,
    ]);
  });
});

// ===========================================================================
describe("Runtime wire: detection health, set_final provider, verdict reasons", () => {
  const report = (detected: Record<string, unknown>) =>
    providerDetectionSchema.safeParse({ provider: "codex", detected }).success;
  const detailOf = (healthDetail: unknown) => {
    const r = providerDetectionSchema.safeParse({
      provider: "codex",
      detected: fresh({ healthDetail }),
    });
    return r.success ? r.data.detected.healthDetail : "refused";
  };

  it("accepts health and a timestamp (or null); refuses a bad health or time", () => {
    expect(report(fresh({ healthCheckedAt: null, health: "unknown" }))).toBe(true);
    expect(report(fresh({ health: "fine" }))).toBe(false);
    expect(report(fresh({ healthCheckedAt: "yesterday" }))).toBe(false);
  });

  it("keeps only the Runtime's fixed detail sentences; anything else becomes null", () => {
    expect(detailOf("Signed in and answering.")).toBe("Signed in and answering.");
    expect(detailOf('Error: "refresh" failed at C:\\Users\\x')).toBeNull();
    expect(detailOf("See https://evil.example/login")).toBeNull();
    expect(detailOf("x".repeat(500))).toBeNull();
    expect(detailOf(42)).toBeNull();
    expect(detailOf(null)).toBeNull();
  });

  it("the fixed sentences are the Runtime's and the database's", () => {
    expect([...HEALTH_DETAILS].sort()).toEqual(Object.values(RUNTIME_HEALTH_DETAIL).sort());
    const list =
      /provider_health_details\(\) returns text\[\][\s\S]*?select array\[([\s\S]*?)\] \$\$/.exec(
        SQL,
      )?.[1];
    expect([...(list ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...HEALTH_DETAILS]);
  });

  it("set_final carries the provider the reason is about", () => {
    const op = teamWriteOpSchema.parse({
      op: "set_final",
      payload: {
        verdict: "BLOCKED",
        reason: "agent_needs_sign_in",
        provider: "claude-code",
        evidence: {},
      },
    });
    expect(toSqlPayload(op)).toMatchObject({
      reason: "agent_needs_sign_in",
      provider: "claude-code",
    });
    expect(
      teamWriteOpSchema.safeParse({
        op: "set_final",
        payload: { verdict: "BLOCKED", provider: "gemini", evidence: {} },
      }).success,
    ).toBe(false);
    expect(VERDICT_REASONS.slice(-2)).toEqual(["agent_needs_sign_in", "api_key_auth"]);
  });
});

// ===========================================================================
describe("the controller path", () => {
  it("sends the chat, and a health refusal says who is not ready", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        message: "an agent this job needs is not ready",
        code: "55000",
        hint: "provider_unhealthy",
        details: "claude-code=needs_sign_in,codex=ready",
      },
    }));
    const err = await startTeamJob({ rpc }, "hash", {
      sessionId: `tlses_${hex("1")}`,
      roomId: ROOM,
      goal: "Build it",
      chatId: CHAT,
    }).catch((e: unknown) => e);
    expect(rpc).toHaveBeenCalledWith(
      "start_team_job",
      expect.objectContaining({ p_chat_id: CHAT }),
    );
    expect(err).toBeInstanceOf(ProviderUnhealthyError);
    expect(err).toBeInstanceOf(ClientOperationError);
    expect(describeError(err)).toBe(
      "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer.",
    );
  });

  it("a detail that is not the machine format is never shown", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "x", code: "55000", hint: "provider_unhealthy", details: "secret db text" },
    }));
    const err = await startTeamJob({ rpc }, "hash", {
      sessionId: `tlses_${hex("1")}`,
      roomId: ROOM,
      goal: "Build it",
    }).catch((e: unknown) => e);
    expect(describeError(err)).not.toContain("secret");
  });

  it("an invalid chat id is refused before the database", async () => {
    const rpc = vi.fn();
    await expect(
      startTeamJob({ rpc }, "hash", {
        sessionId: `tlses_${hex("1")}`,
        roomId: ROOM,
        goal: "x",
        chatId: "tlcht_nope",
      }),
    ).rejects.toBeInstanceOf(ClientOperationError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("the chat timeline by chat", () => {
  const eventRow = (seq: number, over: Record<string, unknown> = {}) => ({
    seq,
    id: `tlcev_${String(seq).padStart(32, "0")}`,
    owner_user_id: USER.id,
    created_at: "2026-09-26T00:00:00Z",
    room_id: null,
    chat_id: CHAT,
    agent_session_id: null,
    job_id: null,
    task_id: null,
    node_id: null,
    author_kind: "threadlink",
    author_provider: null,
    author_label: "ThreadLink",
    author_role: null,
    audience: null,
    event_type: "mode_changed",
    message_type: null,
    round: null,
    model_requested: null,
    model_observed: null,
    body: "Mode changed to Team.",
    visibility: "visible",
    ...over,
  });
  const chatData = { data: { id: CHAT, owner_user_id: USER.id, deleted_at: null } };

  it("reads one chat's rows, including rows with no agent session", async () => {
    const { db, calls } = fakeDb({
      chats: chatData,
      chat_events: { data: [eventRow(3)] },
      team_jobs: { data: [] },
    });
    const page = await listChatFor(db, USER, { chatId: CHAT });
    expect(page.events[0]).toMatchObject({
      chatId: CHAT,
      agentSessionId: null,
      eventType: "mode_changed",
    });
    expect(calls.find((c) => c.table === "chat_events")!.ops).toContainEqual([
      "eq",
      ["chat_id", CHAT],
    ]);
    expect(calls.find((c) => c.table === "team_jobs")!.ops).toContainEqual([
      "eq",
      ["chat_id", CHAT],
    ]);
  });

  it("a deleted, missing or foreign chat is not found; a foreign row fails closed", async () => {
    await expect(
      listChatFor(fakeDb({ chats: { data: null } }).db, USER, { chatId: CHAT }),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(
      listChatFor(
        fakeDb({
          chats: { data: { id: CHAT, owner_user_id: USER.id, deleted_at: "2026-09-26T00:00:00Z" } },
        }).db,
        USER,
        { chatId: CHAT },
      ),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(
      listChatFor(
        fakeDb({ chats: { data: { id: CHAT, owner_user_id: "tlusr_bob", deleted_at: null } } }).db,
        USER,
        {
          chatId: CHAT,
        },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);
    await expect(
      listChatFor(
        fakeDb({
          chats: chatData,
          chat_events: { data: [eventRow(1, { chat_id: CHAT2 })] },
          team_jobs: { data: [] },
        }).db,
        USER,
        { chatId: CHAT },
      ),
    ).rejects.toBeInstanceOf(OwnershipViolationError);
  });

  it("the query takes exactly one scope", () => {
    expect(parseChatSearchParams(new URLSearchParams(`chat=${CHAT}&after=5`))).toEqual({
      chatId: CHAT,
      after: 5,
      technical: false,
    });
    expect(parseChatSearchParams(new URLSearchParams(`chat=${CHAT}&room=${ROOM}`))).toBeNull();
    expect(parseChatSearchParams(new URLSearchParams("chat=tlcht_bad"))).toBeNull();
  });

  it("posts by chat with no mode hints; a health refusal is kept and explained", async () => {
    const { db, rpc } = fakeDb(
      {},
      {
        // 0.11: the lane and open choices are read first (lib/chat/compose.ts).
        chat_compose_context: {
          data: { chat_id: CHAT, mode: "team", active_work_job: false, choices: [] },
        },
        post_chat_message: {
          data: {
            routed: "provider_blocked",
            job_id: null,
            event_id: "tlcev_x",
            chat_id: CHAT,
            health: [
              { provider: "claude-code", health: "needs_sign_in" },
              { provider: "codex", health: "ready" },
            ],
          },
        },
      },
    );
    const out = await postChatMessageAs(db, {
      chatId: CHAT,
      body: "Build it",
      idempotencyKey: "k1",
    });
    expect(rpc).toHaveBeenCalledWith("chat_compose_context", { p_chat_id: CHAT });
    expect(rpc).toHaveBeenCalledWith("post_chat_message", {
      p_chat_id: CHAT,
      p_body: "Build it",
      p_idempotency_key: "k1",
      p_lane: "work",
      p_lane_reason: "edit_requested",
      p_choice_id: null,
      p_choice_key: null,
    });
    expect(out).toEqual({
      ok: false,
      reason: "provider_unhealthy",
      message:
        "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer.",
      health: [
        { provider: "claude-code", health: "needs_sign_in" },
        { provider: "codex", health: "ready" },
      ],
      stored: true,
    });
    // A chat post takes no mode or builder: the chat and a leading @mention decide.
    expect(await postChatMessageAs(db, { chatId: CHAT, body: "x", mode: "solo" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("needs_project and the other refusals are fixed sentences", async () => {
    const { db } = fakeDb(
      {},
      {
        chat_compose_context: {
          data: { chat_id: CHAT, mode: "team", active_work_job: false, choices: [] },
        },
        post_chat_message: { error: { code: "55000", hint: "needs_project", message: "db text" } },
      },
    );
    expect(await postChatMessageAs(db, { chatId: CHAT, body: "Build it" })).toEqual({
      ok: false,
      reason: "needs_project",
      message: CHAT_ERROR_MESSAGES.needs_project,
    });
  });
});

// ===========================================================================
describe("the chat list", () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    id: CHAT,
    owner_user_id: USER.id,
    name: "Rate limiter",
    room_id: ROOM,
    group_id: GROUP,
    mode: "pair",
    solo_provider: null,
    builder_provider: "codex",
    reviewer_provider: null,
    pinned_at: "2026-09-26T10:00:00Z",
    archived_at: null,
    deleted_at: null,
    last_activity_at: "2026-09-26T11:00:00Z",
    last_read_seq: 4,
    is_room_default: false,
    created_at: "2026-09-26T09:00:00Z",
    ...over,
  });
  const tables = (over: Record<string, { data: unknown }> = {}) => ({
    chats: { data: [chat()] },
    rooms: {
      data: [
        {
          id: ROOM,
          owner_user_id: USER.id,
          name: "Prism",
          status: "active",
          agent_session_id: SESSION,
        },
      ],
    },
    session_bindings: { data: [{ id: SESSION, owner_user_id: USER.id, runtime_id: RUNTIME }] },
    room_agents: {
      data: [
        { owner_user_id: USER.id, room_id: ROOM, provider: "codex", enabled: true },
        { owner_user_id: USER.id, room_id: ROOM, provider: "claude-code", enabled: true },
      ],
    },
    chat_groups: { data: [{ id: GROUP, owner_user_id: USER.id, name: "Clients", sort: 0 }] },
    // Health of THIS project's computer only; another computer says Claude Code is ready.
    runtime_provider_health: {
      data: [
        {
          owner_user_id: USER.id,
          runtime_id: RUNTIME,
          provider: "codex",
          detected: fresh({ healthCheckedAt: new Date().toISOString() }),
          received_at: new Date().toISOString(),
        },
        {
          owner_user_id: USER.id,
          runtime_id: OTHER_RUNTIME,
          provider: "claude-code",
          detected: fresh({ authMethod: "claude.ai", healthCheckedAt: new Date().toISOString() }),
          received_at: new Date().toISOString(),
        },
      ],
    },
    team_jobs: {
      data: [
        {
          id: JOB,
          owner_user_id: USER.id,
          chat_id: CHAT,
          task_id: TASK,
          mode: "pair",
          status: "blocked",
          plan_hash: null,
          retried_from_job_id: null,
          created_at: "2026-09-26T10:30:00Z",
          finished_at: "2026-09-26T10:31:00Z",
        },
      ],
    },
    team_decisions: { data: [] },
    tasks: {
      data: {
        owner_user_id: USER.id,
        content: JSON.stringify({ agents: [{ provider: "codex" }, { provider: "claude-code" }] }),
      },
    },
    ...over,
  });
  const extras = {
    chat_list_extras: {
      data: [
        {
          chat_id: CHAT,
          last_seq: 9,
          last_body: "Result: BLOCKED",
          last_at: "2026-09-26T10:31:00Z",
          controller_labels: ["ChatGPT"],
        },
      ],
    },
  };

  it("builds summaries: project, group, participants with health, unread, attention", async () => {
    const { db, calls } = fakeDb(tables(), extras);
    const [s] = await listChatsFor(db, USER, { search: "50%_off", includeArchived: false });
    expect(s).toMatchObject({
      chatId: CHAT,
      name: "Rate limiter",
      mode: "pair",
      projectName: "Prism",
      groupName: "Clients",
      pinned: true,
      archived: false,
      lastMessage: "Result: BLOCKED",
      unread: true,
      needsAttention: true,
      activeJob: null,
      isRoomDefault: false,
    });
    expect(s.participants).toEqual([
      {
        kind: "agent",
        provider: "claude-code",
        name: "Claude Code",
        shortName: "Claude",
        health: "unknown",
      },
      { kind: "agent", provider: "codex", name: "Codex", shortName: "Codex", health: "ready" },
      { kind: "controller", provider: null, name: "ChatGPT", shortName: "ChatGPT", health: null },
      { kind: "owner", provider: null, name: "You", shortName: "You", health: null },
    ]);
    const ops = calls.find((c) => c.table === "chats")!.ops;
    expect(ops).toContainEqual(["is", ["deleted_at", null]]);
    expect(ops).toContainEqual(["is", ["archived_at", null]]);
    // A search is a plain substring: LIKE wildcards are escaped.
    expect(ops).toContainEqual(["ilike", ["name", "%50\\%\\_off%"]]);
    expect(ops).toContainEqual(["order", ["pinned_at", { ascending: false, nullsFirst: false }]]);
  });

  it("a deleted project shows as no project; a foreign row fails closed", async () => {
    const deleted = fakeDb(
      tables({
        rooms: {
          data: [
            {
              id: ROOM,
              owner_user_id: USER.id,
              name: "Prism",
              status: "deleted",
              agent_session_id: null,
            },
          ],
        },
      }),
      extras,
    );
    const [s] = await listChatsFor(deleted.db, USER);
    expect(s).toMatchObject({ roomId: null, projectName: null });
    expect(s.participants.filter((p) => p.kind === "agent")).toEqual([]);
    const foreign = fakeDb(
      tables({ chats: { data: [chat({ owner_user_id: "tlusr_bob" })] } }),
      extras,
    );
    await expect(listChatsFor(foreign.db, USER)).rejects.toBeInstanceOf(OwnershipViolationError);
  });

  it("one chat: settings, groups and an explicit retry for a job blocked before its plan", async () => {
    const { db } = fakeDb(tables({ chats: { data: chat() } }), extras);
    const detail = await getChatFor(db, USER, CHAT);
    expect(detail).toMatchObject({
      chatId: CHAT,
      settings: {
        mode: "pair",
        soloProvider: null,
        builderProvider: "codex",
        reviewerProvider: null,
      },
      lastReadSeq: 4,
      retry: {
        jobId: JOB,
        coordinators: [
          { provider: "codex", name: "Codex", health: "ready" },
          { provider: "claude-code", name: "Claude Code", health: "unknown" },
        ],
      },
    });
    expect(await getChatFor(db, USER, "tlcht_bad")).toBeNull();
    const gone = fakeDb(
      tables({ chats: { data: chat({ deleted_at: "2026-09-26T11:00:00Z" }) } }),
      extras,
    );
    expect(await getChatFor(gone.db, USER, CHAT)).toBeNull();
  });
});

// ===========================================================================
describe("chat changes", () => {
  const record = {
    chat_id: CHAT,
    name: "n",
    mode: "solo",
    room_id: null,
    project_name: null,
    group_id: null,
    group_name: null,
    solo_provider: null,
    builder_provider: null,
    reviewer_provider: null,
    pinned: false,
    archived: false,
    is_room_default: false,
    last_activity_at: "2026-09-26T00:00:00Z",
    last_read_seq: 0,
  };

  it("null clears (no project / no group / chosen automatically); undefined leaves", async () => {
    const { db, rpc } = fakeDb({}, { update_chat: { data: record } });
    await updateChatAs(db, CHAT, { roomId: null, groupId: null, soloProvider: null, mode: "solo" });
    expect(rpc).toHaveBeenCalledWith("update_chat", {
      p_chat_id: CHAT,
      p_name: null,
      p_room_id: null,
      p_clear_room: true,
      p_group_id: null,
      p_clear_group: true,
      p_mode: "solo",
      p_solo_provider: "auto",
      p_builder_provider: null,
      p_reviewer_provider: null,
      p_pinned: null,
      p_archived: null,
    });
  });

  it("bad input never reaches the database", async () => {
    const { db, rpc } = fakeDb({});
    for (const patch of [
      { mode: "swarm" },
      { soloProvider: "gemini" },
      { roomId: "x" },
      { extra: 1 },
    ]) {
      await expect(updateChatAs(db, CHAT, patch)).rejects.toMatchObject({ reason: "invalid" });
    }
    await expect(updateChatAs(db, "tlcht_x", {})).rejects.toMatchObject({ reason: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refusals become fixed sentences; a retry refused for health says who", async () => {
    const taken = fakeDb(
      {},
      { update_chat: { error: { code: "P0002", hint: "chat_not_found", message: "db" } } },
    );
    const e1 = await updateChatAs(taken.db, CHAT, { name: "x" }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ChatActionError);
    expect((e1 as ChatActionError).message).toBe(CHAT_ERROR_MESSAGES.chat_not_found);
    const sick = fakeDb(
      {},
      {
        retry_job_with_roles: {
          error: {
            code: "55000",
            hint: "provider_unhealthy",
            details: "codex=usage_exhausted",
            message: "db",
          },
        },
      },
    );
    const e2 = (await retryJobWithRolesAs(sick.db, JOB, "codex").catch(
      (e: unknown) => e,
    )) as ChatActionError;
    expect(e2.reason).toBe("provider_unhealthy");
    expect(e2.message).toBe("Codex — Usage limit reached. Codex has reached its usage limit.");
    expect(e2.message).not.toContain("db");
  });
});

// ===========================================================================
describe("owner chat routes", () => {
  const SAME = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
  const req = (method: string, body?: unknown, headers: Record<string, string> = SAME) =>
    new Request("http://x/api/dashboard/chats", {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    owner.requireThreadLinkUser.mockImplementation(async () => ({ id: "tlusr_alice" }));
  });

  it("fail closed before reading anything when signed out", async () => {
    owner.requireThreadLinkUser.mockRejectedValue(new AuthenticationRequiredError());
    for (const res of [
      await chatsGET(req("GET")),
      await chatsPOST(req("POST", { name: "x" })),
      await chatGET(req("GET"), ctx({ chatId: CHAT })),
      await chatPATCH(req("PATCH", { name: "x" }), ctx({ chatId: CHAT })),
      await chatDELETE(req("DELETE"), ctx({ chatId: CHAT })),
      await readPOST(req("POST", { seq: 1 }), ctx({ chatId: CHAT })),
      await groupsGET(),
      await groupsPOST(req("POST", { name: "g" })),
      await groupPATCH(req("PATCH", { name: "g" }), ctx({ groupId: GROUP })),
      await groupDELETE(req("DELETE"), ctx({ groupId: GROUP })),
    ]) {
      expect(res.status).toBe(401);
    }
    for (const fn of [
      owner.createMyChat,
      owner.updateMyChat,
      owner.deleteMyChat,
      owner.markMyChatRead,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("mutations are same-origin only", async () => {
    const cross = { "content-type": "application/json", "sec-fetch-site": "cross-site" };
    expect((await chatsPOST(req("POST", { name: "x" }, cross))).status).toBe(400);
    expect(
      (await chatPATCH(req("PATCH", { name: "x" }, cross), ctx({ chatId: CHAT }))).status,
    ).toBe(400);
    expect(
      (
        await chatDELETE(
          req("DELETE", undefined, { "sec-fetch-site": "cross-site" }),
          ctx({ chatId: CHAT }),
        )
      ).status,
    ).toBe(400);
    expect((await chatDELETE(req("DELETE", undefined, {}), ctx({ chatId: CHAT }))).status).toBe(
      400,
    );
    expect(
      (
        await readPOST(
          req(
            "POST",
            { seq: 1 },
            { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
          ),
          ctx({ chatId: CHAT }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await groupDELETE(
          req("DELETE", undefined, { origin: "http://evil" }),
          ctx({ groupId: GROUP }),
        )
      ).status,
    ).toBe(400);
    expect(owner.createMyChat).not.toHaveBeenCalled();
    expect(owner.deleteMyChat).not.toHaveBeenCalled();
    expect(owner.deleteMyChatGroup).not.toHaveBeenCalled();
  });

  it("GET /chats lists chats and groups; bad filters are 400", async () => {
    owner.listMyChats.mockResolvedValue([]);
    owner.listMyChatGroups.mockResolvedValue([]);
    const ok = await chatsGET(
      new Request(`http://x/api/dashboard/chats?group=${GROUP}&mode=team&archived=1&search=rate`),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(owner.listMyChats).toHaveBeenCalledWith({
      search: "rate",
      groupId: GROUP,
      mode: "team",
      includeArchived: true,
    });
    for (const q of [
      "group=x",
      "room=tlrom_1",
      "mode=swarm",
      "archived=maybe",
      `search=${"s".repeat(101)}`,
    ]) {
      expect((await chatsGET(new Request(`http://x/api/dashboard/chats?${q}`))).status).toBe(400);
    }
  });

  it("a chat that is not yours or missing is a plain 404; bad ids never reach the server", async () => {
    owner.getMyChat.mockResolvedValue(null);
    const res = await chatGET(req("GET"), ctx({ chatId: CHAT }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "chat_not_found",
      message: CHAT_ERROR_MESSAGES.chat_not_found,
    });
    expect((await chatGET(req("GET"), ctx({ chatId: "../etc" }))).status).toBe(404);
    expect(owner.getMyChat).toHaveBeenCalledTimes(1);
  });

  it("PATCH applies fields, pin and archive in ONE change, then returns the chat", async () => {
    owner.updateMyChat.mockResolvedValue({});
    owner.getMyChat.mockResolvedValue({ chatId: CHAT });
    const res = await chatPATCH(
      req("PATCH", { name: "New", roomId: null, pinned: true }),
      ctx({ chatId: CHAT }),
    );
    expect(res.status).toBe(200);
    expect(owner.updateMyChat).toHaveBeenCalledTimes(1);
    expect(owner.updateMyChat).toHaveBeenCalledWith(CHAT, {
      name: "New",
      roomId: null,
      pinned: true,
    });
    expect(owner.setMyChatPinned).not.toHaveBeenCalled();
    expect(owner.setMyChatArchived).not.toHaveBeenCalled();
    expect((await chatPATCH(req("PATCH", {}), ctx({ chatId: CHAT }))).status).toBe(400);
    owner.updateMyChat.mockRejectedValueOnce(new ChatActionError("invalid"));
    expect((await chatPATCH(req("PATCH", { pinned: "yes" }), ctx({ chatId: CHAT }))).status).toBe(
      400,
    );
  });

  it("refusals map to status codes with fixed sentences, never database text", async () => {
    owner.deleteMyChat.mockRejectedValue(new ChatActionError("job_active"));
    const busy = await chatDELETE(req("DELETE"), ctx({ chatId: CHAT }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      ok: false,
      reason: "job_active",
      message: CHAT_ERROR_MESSAGES.job_active,
    });
    owner.createMyChatGroup.mockRejectedValue(new ChatActionError("name_taken"));
    expect((await groupsPOST(req("POST", { name: "Clients" }))).status).toBe(409);
    owner.createMyChat.mockRejectedValue(
      new Error("duplicate key value violates unique constraint"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await chatsPOST(req("POST", { name: "x" }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("duplicate");
    spy.mockRestore();
  });

  it("POST /read takes only {seq}", async () => {
    owner.markMyChatRead.mockResolvedValue({ lastReadSeq: 7 });
    const ok = await readPOST(req("POST", { seq: 7 }), ctx({ chatId: CHAT }));
    expect(await ok.json()).toEqual({ ok: true, lastReadSeq: 7 });
    for (const body of [{ seq: -1 }, { seq: 1.5 }, { seq: 1, extra: true }, "nope"]) {
      expect((await readPOST(req("POST", body), ctx({ chatId: CHAT }))).status).toBe(400);
    }
    expect((await readPOST(req("POST", "x".repeat(300)), ctx({ chatId: CHAT }))).status).toBe(400);
  });
});
