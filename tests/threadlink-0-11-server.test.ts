import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The credential and the database are the only things mocked: routes run their
// real handler, parser and error mapping.
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
  connectionUnauthorizedResponse: () =>
    Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    ),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAnonymousSupabaseClient: () => ({ rpc }),
}));

import * as wakeRoute from "@/app/api/runtime/wake/route";
import * as choiceRoute from "@/app/api/runtime/chats/[chatId]/choices/[choiceId]/route";
import * as settingsRoute from "@/app/api/runtime/settings/failover/route";
import * as messagesRoute from "@/app/api/runtime/chats/[chatId]/messages/route";
import { composeContextRowSchema, planPost } from "@/lib/chat/compose";
import { runSubject } from "@/lib/chat/work";
import { setFailoverPolicyAs } from "@/lib/chat/settings";
import { ChatActionError } from "@/lib/chat/chats";
import { getHostStatusAs } from "@/lib/chat/work";
import { ClientOperationError, type ClientDatabase } from "@/lib/client-api/operations";
import { parseWakeWait, waitForWork } from "@/lib/client-api/runtime";
import { providerDetectionSchema, writeTeamState } from "@/lib/team/client-api";
import { redactExportText } from "@/lib/export/chat-export";
import * as model from "@/lib/team/model";

const hex = (c: string) => c.repeat(32);
const CHAT = `tlcht_${hex("a")}`;
const JOB = `tljob_${hex("b")}`;
const CHOICE = `tlchc_${hex("c")}`;
const RUN = `tlarn_${hex("d")}`;
const EV = `tlcev_${hex("e")}`;
const SESSION = `tlses_${hex("f")}`;

const ok = (data: unknown) => ({ data, error: null });
const err = (code: string, hint?: string) => ({
  data: null,
  error: { message: "database text that must never be shown", code, hint },
});
const req = (url: string, init: RequestInit = {}) =>
  new Request(`http://localhost${url}`, {
    ...init,
    headers: { authorization: "Bearer x", ...(init.headers ?? {}) },
  });
const send = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

beforeEach(() => {
  rpc.mockReset();
  identity.fail = false;
  identity.value.role = "agent";
});

// ===========================================================================
describe("team_job_write 0.11 wire (docs/design/threadlink-0.11.md section 12)", () => {
  const sql = (op: unknown) => model.toSqlPayload(model.teamWriteOpSchema.parse(op));
  const valid = (op: unknown) => model.teamWriteOpSchema.safeParse(op).success;

  it("read_chat_context: limit 1..40", () => {
    expect(sql({ op: "read_chat_context", payload: { limit: 20 } })).toEqual({ limit: 20 });
    expect(sql({ op: "read_chat_context", payload: {} })).toEqual({});
    expect(sql({ op: "read_chat_context" })).toEqual({});
    expect(valid({ op: "read_chat_context", payload: { limit: 41 } })).toBe(false);
    expect(valid({ op: "read_chat_context", payload: { limit: 0 } })).toBe(false);
  });

  it("failover_notice: {from, to|null, reviewPending, resetsAt?}", () => {
    expect(
      sql({
        op: "failover_notice",
        payload: {
          from: "codex",
          to: "claude-code",
          reviewPending: true,
          resetsAt: "2026-09-29T15:00:00Z",
        },
      }),
    ).toEqual({
      from: "codex",
      to: "claude-code",
      review_pending: true,
      resets_at: "2026-09-29T15:00:00Z",
    });
    expect(
      sql({ op: "failover_notice", payload: { from: "codex", to: null, reviewPending: false } }),
    ).toEqual({
      from: "codex",
      to: null,
      review_pending: false,
    });
    expect(
      valid({
        op: "failover_notice",
        payload: { from: "codex", to: "codex", reviewPending: false },
      }),
    ).toBe(false);
    expect(
      valid({
        op: "failover_notice",
        payload: { from: "codex", to: null, reviewPending: false, resetsAt: "soon" },
      }),
    ).toBe(false);
    expect(valid({ op: "failover_notice", payload: { from: "codex", reviewPending: false } })).toBe(
      false,
    );
  });

  it("run_started carries sessionReason; run_finished carries bounded timings", () => {
    expect(
      sql({
        op: "run_started",
        payload: {
          runKey: "fc:1",
          provider: "claude-code",
          participantKey: "claude-code:investigator",
          role: "investigator",
          continuity: "resumed",
          sessionReason: "resumed",
        },
      }),
    ).toMatchObject({ continuity: "resumed", session_reason: "resumed" });
    expect(
      sql({
        op: "run_finished",
        payload: { runId: RUN, status: "completed", timings: { queueMs: 5, providerMs: 900 } },
      }),
    ).toMatchObject({ timings: { queueMs: 5, providerMs: 900 } });
    for (const timings of [
      { queueMs: -1 },
      { queueMs: 86_400_001 },
      { queueMs: 1.5 },
      { promptText: 1 },
    ]) {
      expect(
        valid({ op: "run_finished", payload: { runId: RUN, status: "completed", timings } }),
      ).toBe(false);
    }
    expect(
      valid({
        op: "run_started",
        payload: {
          runKey: "x",
          provider: "codex",
          participantKey: "codex:investigator",
          role: "investigator",
          sessionReason: "why",
        },
      }),
    ).toBe(false);
  });

  it("request_choice start_work / usage_exhausted pass their params", () => {
    expect(
      sql({
        op: "request_choice",
        payload: { kind: "start_work", requestKey: "fc:w", params: { sourceEventId: EV } },
      }),
    ).toMatchObject({ kind: "start_work", source_event_id: EV });
    expect(
      sql({
        op: "request_choice",
        payload: {
          kind: "usage_exhausted",
          requestKey: "ue",
          params: {
            provider: "codex",
            otherProvider: "claude-code",
            resetsAt: "2026-09-29T15:00:00Z",
          },
        },
      }),
    ).toMatchObject({
      provider: "codex",
      other_provider: "claude-code",
      resets_at: "2026-09-29T15:00:00Z",
    });
  });

  it("set_status completed/failed pass the wire (the database allows them only for Fast Chat)", () => {
    expect(sql({ op: "set_status", payload: { status: "completed" } })).toEqual({
      status: "completed",
    });
    expect(valid({ op: "set_status", payload: { status: "review_pending" } })).toBe(false);
    expect(valid({ op: "set_final", payload: { verdict: "REVIEW_PENDING", evidence: {} } })).toBe(
      true,
    );
  });

  it("read_chat_context answers map to chatContext; the status carries lane and failover policy", async () => {
    const status = {
      job_id: JOB,
      room_id: `tlrom_${hex("1")}`,
      room_name: "Prism",
      task_id: "tltsk_x",
      task_status: "working",
      status: "queued",
      verdict: null,
      line: null,
      summary: null,
      goal: "hi",
      lane: "chat",
      failover_policy: "auto",
      rounds: { planning: { n: 0, max: 2 }, review: { n: 0, max: 3 } },
      parallel_agents: 2,
      plan_hash: null,
      plan_approved: false,
      nodes_total: 0,
      nodes: [],
      open_findings: { blocking: 0, important: 0, non_blocking: 0 },
      decisions_needing_user: 0,
      created_at: "2026-09-29T10:00:00Z",
      updated_at: "2026-09-29T10:00:00Z",
      finished_at: null,
    };
    const db = {
      rpc: vi.fn(async () =>
        ok({
          ...status,
          op: "read_chat_context",
          result: {
            messages: [
              {
                id: EV,
                chat_seq: 4,
                author_kind: "owner",
                author_provider_id: null,
                author_label: "You",
                reply_to: null,
                body: "hi team",
                created_at: "2026-09-29T10:00:00Z",
              },
            ],
          },
        }),
      ),
    } as unknown as ClientDatabase;
    const out = await writeTeamState(db, "ab".repeat(32), JOB, {
      sessionId: SESSION,
      claimRef: "c1",
      op: "read_chat_context",
      payload: { limit: 20 },
    });
    expect(out.lane).toBe("chat");
    expect(out.failoverPolicy).toBe("auto");
    expect(out.chatContext).toEqual([
      {
        id: EV,
        chatSeq: 4,
        authorKind: "owner",
        authorProviderId: null,
        authorLabel: "You",
        replyTo: null,
        body: "hi team",
        createdAt: "2026-09-29T10:00:00Z",
      },
    ]);
  });

  it("provider detection accepts resetsAt as an ISO time only", () => {
    const base = { provider: "codex", detected: { health: "usage_exhausted" } };
    expect(
      providerDetectionSchema.safeParse({
        ...base,
        detected: { ...base.detected, resetsAt: "2026-09-29T15:00:00Z" },
      }).success,
    ).toBe(true);
    expect(
      providerDetectionSchema.safeParse({ ...base, detected: { ...base.detected, resetsAt: null } })
        .success,
    ).toBe(true);
    expect(
      providerDetectionSchema.safeParse({
        ...base,
        detected: { ...base.detected, resetsAt: "in 2 hours" },
      }).success,
    ).toBe(false);
  });
});

// ===========================================================================
describe("wake long-poll (section 3.2)", () => {
  it("?wait is whole seconds 0..25, default 20", () => {
    expect(parseWakeWait(null)).toBe(20);
    expect(parseWakeWait("")).toBe(20);
    expect(parseWakeWait("0")).toBe(0);
    expect(parseWakeWait("25")).toBe(25);
    for (const bad of ["26", "-1", "1.5", "abc", "9999"]) {
      expect(() => parseWakeWait(bad)).toThrow(ClientOperationError);
    }
  });

  it("answers at once when work is pending (the first check is rate-limited)", async () => {
    const db = {
      rpc: vi.fn(async () => ok({ pending: 2, paused: false })),
    } as unknown as ClientDatabase;
    expect(await waitForWork(db, "h", "20")).toEqual({ pending: 2 });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("runtime_pending_count", {
      p_token_hash: "h",
      p_begin: true,
    });
  });

  it("polls until something is pending", async () => {
    const answers = [0, 0, 1];
    const db = {
      rpc: vi.fn(async () => ok({ pending: answers.shift() ?? 0, paused: false })),
    } as unknown as ClientDatabase;
    expect(await waitForWork(db, "h", "5", undefined, { pollMs: 1 })).toEqual({ pending: 1 });
    expect(db.rpc).toHaveBeenCalledTimes(3);
    expect(vi.mocked(db.rpc).mock.calls[1]![1]).toEqual({ p_token_hash: "h", p_begin: false });
  });

  it("gives up at the deadline with pending 0, and when the client goes away", async () => {
    let t = 0;
    const db = {
      rpc: vi.fn(async () => ok({ pending: 0, paused: false })),
    } as unknown as ClientDatabase;
    expect(
      await waitForWork(db, "h", "1", undefined, { pollMs: 1, now: () => (t += 300) }),
    ).toEqual({ pending: 0 });
    const ac = new AbortController();
    ac.abort();
    const calls = vi.mocked(db.rpc).mock.calls.length;
    expect(await waitForWork(db, "h", "25", ac.signal)).toEqual({ pending: 0 });
    expect(vi.mocked(db.rpc).mock.calls.length).toBe(calls + 1);
  });

  it("a paused Runtime is told at once", async () => {
    const db = {
      rpc: vi.fn(async () => ok({ pending: 0, paused: true })),
    } as unknown as ClientDatabase;
    expect(await waitForWork(db, "h", "25")).toEqual({ pending: 0, paused: true });
  });

  it("route: 401 without a credential, 429 when rate-limited, 400 for a bad wait", async () => {
    identity.fail = true;
    expect((await wakeRoute.GET(req("/api/runtime/wake?wait=1"))).status).toBe(401);
    identity.fail = false;
    rpc.mockResolvedValue(err("54000", "rate_limited"));
    const limited = await wakeRoute.GET(req("/api/runtime/wake?wait=1"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "limit", reason: "rate_limited" });
    expect((await wakeRoute.GET(req("/api/runtime/wake?wait=99"))).status).toBe(400);
    rpc.mockResolvedValue(ok({ pending: 1, paused: false }));
    const res = await wakeRoute.GET(req("/api/runtime/wake?wait=0"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 1 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(wakeRoute.maxDuration).toBeGreaterThanOrEqual(26);
  });
});

// ===========================================================================
describe("post planning: lane + natural choice answers", () => {
  const context = composeContextRowSchema.parse({
    chat_id: CHAT,
    mode: "team",
    active_work_job: true,
    choices: [
      {
        choice_id: CHOICE,
        kind: "usage_exhausted",
        options: [
          { key: "continue_other", label: "Continue with Claude" },
          { key: "check_again", label: "Check Codex again" },
          { key: "wait", label: "Wait for Codex" },
          { key: "stop", label: "Stop" },
        ],
        provider: "codex",
        other_provider: "claude-code",
        provider_health: "usage_exhausted",
      },
    ],
  });

  it("answers an open choice (owner paths) and never for a controller", () => {
    expect(planPost({ body: "@Claude continue", context, allowChoiceAnswers: true })).toMatchObject(
      {
        lane: "chat",
        laneReason: "continuation",
        choice: { choiceId: CHOICE, key: "continue_other", label: "Continue with Claude" },
      },
    );
    expect(
      planPost({ body: "@Claude continue", context, allowChoiceAnswers: false }).choice,
    ).toBeNull();
  });

  it("classifies the lane and strips /chat /work", () => {
    expect(planPost({ body: "/work hi", context, allowChoiceAnswers: true })).toMatchObject({
      body: "hi",
      lane: "work",
      laneReason: "explicit_work",
      choice: null,
    });
    expect(
      planPost({ body: "fix the login bug", lane: "chat", context, allowChoiceAnswers: true }),
    ).toMatchObject({
      lane: "chat",
      laneReason: "explicit_chat",
    });
  });

  it("desktop/terminal post: the matched choice goes to the database, which re-checks it", async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "runtime_chat_compose_context"
          ? ok(context)
          : ok({
              routed: "choice_resolved",
              job_id: JOB,
              event_id: EV,
              lane: "chat",
              lane_reason: "choice_answer",
              choice_id: CHOICE,
              chosen_key: "wait",
              chosen_label: "Wait for Codex",
            }),
      ),
    );
    const res = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        send("POST", { body: "wait for Codex" }, { "x-threadlink-client": "desktop" }),
      ),
      { params: Promise.resolve({ chatId: CHAT }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      routed: "choice_resolved",
      choiceId: CHOICE,
      chosenLabel: "Wait for Codex",
      lane: "chat",
      laneReason: "choice_answer",
    });
    expect(rpc).toHaveBeenCalledWith(
      "runtime_post_chat_message",
      expect.objectContaining({ p_choice_id: CHOICE, p_choice_key: "wait", p_lane: "chat" }),
    );
  });

  it("an unknown lane in the body is refused before the database", async () => {
    const res = await messagesRoute.POST(
      req(
        `/api/runtime/chats/${CHAT}/messages`,
        send("POST", { body: "x", lane: "fast" }, { "x-threadlink-client": "desktop" }),
      ),
      { params: Promise.resolve({ chatId: CHAT }) },
    );
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("desktop settings and choice cards", () => {
  it("PUT /api/runtime/settings/failover validates and maps", async () => {
    rpc.mockResolvedValue(ok({ failover_policy: "ask", updated_at: "2026-09-29T10:00:00Z" }));
    const res = await settingsRoute.PUT(
      req("/api/runtime/settings/failover", send("PUT", { failoverPolicy: "ask" })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ failoverPolicy: "ask", updatedAt: "2026-09-29T10:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("runtime_set_failover_policy", {
      p_token_hash: "ab".repeat(32),
      p_policy: "ask",
    });
    rpc.mockClear();
    const bad = await settingsRoute.PUT(
      req("/api/runtime/settings/failover", send("PUT", { failoverPolicy: "never" })),
    );
    expect(bad.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    identity.value.role = "controller";
    expect((await settingsRoute.GET(req("/api/runtime/settings/failover"))).status).toBe(403);
  });

  it("POST /api/runtime/chats/<chat>/choices/<choice> decides on the card", async () => {
    rpc.mockResolvedValue(
      ok({
        choice_id: CHOICE,
        kind: "start_work",
        status: "chosen",
        chosen_key: "run_work",
        decided_at: "2026-09-29T10:00:00Z",
        chosen_label: "Run this as work",
        started: { routed: "new_job", job_id: JOB },
      }),
    );
    const params = { params: Promise.resolve({ chatId: CHAT, choiceId: CHOICE }) };
    const res = await choiceRoute.POST(
      req(`/api/runtime/chats/${CHAT}/choices/${CHOICE}`, send("POST", { key: "run_work" })),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      choiceId: CHOICE,
      kind: "start_work",
      status: "chosen",
      chosenKey: "run_work",
      chosenLabel: "Run this as work",
      decidedAt: "2026-09-29T10:00:00Z",
      replayed: false,
      startedJobId: JOB,
    });
    rpc.mockResolvedValue(err("P0002", "choice_not_found"));
    const missing = await choiceRoute.POST(
      req(`/api/runtime/chats/${CHAT}/choices/${CHOICE}`, send("POST", { key: "run_work" })),
      params,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, reason: "choice_not_found" });
    rpc.mockClear();
    const badKey = await choiceRoute.POST(
      req(`/api/runtime/chats/${CHAT}/choices/${CHOICE}`, send("POST", { key: "Run It" })),
      params,
    );
    expect(badKey.status).toBe(400);
    const badId = await choiceRoute.POST(
      req(`/api/runtime/chats/${CHAT}/choices/nope`, send("POST", { key: "wait" })),
      {
        params: Promise.resolve({ chatId: CHAT, choiceId: "nope" }),
      },
    );
    expect(badId.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("owner: settings, host presence v2, live subjects", () => {
  it("set_failover_policy validates before the database", async () => {
    const db = { rpc: vi.fn(async () => ok({ failover_policy: "wait", updated_at: null })) };
    await expect(setFailoverPolicyAs(db as never, { failoverPolicy: "wait" })).resolves.toEqual({
      failoverPolicy: "wait",
      updatedAt: null,
    });
    await expect(
      setFailoverPolicyAs(db as never, { failoverPolicy: "sometimes" }),
    ).rejects.toBeInstanceOf(ChatActionError);
    await expect(
      setFailoverPolicyAs(db as never, { failoverPolicy: "auto", owner: "x" }),
    ).rejects.toBeInstanceOf(ChatActionError);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("chat_host_status: reconnecting, server time, reset times", async () => {
    const db = {
      rpc: vi.fn(async () =>
        ok({
          chat_id: CHAT,
          room_id: null,
          now: "2026-09-29T10:00:00Z",
          server_now: "2026-09-29T10:00:00Z",
          runtime: {
            runtime_id: "tlrun_x",
            label: "Nickron PC",
            presence: "reconnecting",
            last_seen_at: "2026-09-29T09:58:30Z",
            protocol: 10,
            needs_update: false,
            update_available: true,
            fast_chat: false,
          },
          agents: [
            {
              provider: "codex",
              name: "Codex",
              short_name: "Codex",
              health: "usage_exhausted",
              state: "usage_exhausted",
              checked_at: "2026-09-29T09:59:00Z",
              resets_at: "2026-09-29T15:00:00Z",
            },
          ],
        }),
      ),
    };
    const h = await getHostStatusAs(db as never, CHAT);
    expect(h.serverNow).toBe("2026-09-29T10:00:00Z");
    expect(h.runtime).toMatchObject({
      presence: "reconnecting",
      updateAvailable: true,
      fastChat: false,
      needsUpdate: false,
    });
    expect(h.agents[0]).toMatchObject({ resetsAt: "2026-09-29T15:00:00Z" });
  });

  it("live subjects are fixed words", () => {
    expect(runSubject("reviewing", "reviewer")).toBe("Reviewing");
    expect(runSubject("queued", "investigator")).toBe("Investigating");
    expect(runSubject(null, "security_reviewer")).toBe("Reviewing security");
    expect(runSubject(null, "something else")).toBeNull();
  });
});

// ===========================================================================
describe("redaction mirror (export): prose about secrets stays readable", () => {
  it("only a secret-looking value after 'is/was' is redacted", () => {
    expect(redactExportText("an expired token is still accepted after refresh")).toBe(
      "an expired token is still accepted after refresh",
    );
    expect(redactExportText("the password is hunter2")).toBe("the password is [redacted]");
    expect(redactExportText("the api key was abcdefghijklmnopqrstuv")).toBe(
      "the api key was [redacted]",
    );
    expect(redactExportText("token: still here")).toBe("token: [redacted]");
  });
});
