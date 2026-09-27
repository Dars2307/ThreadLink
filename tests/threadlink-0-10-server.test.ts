import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const owner = vi.hoisted(() => ({
  requireThreadLinkUser: vi.fn(async () => ({ id: "tlusr_alice" })),
  listMyChatTimeline: vi.fn(),
  getMyRunProvenance: vi.fn(),
  revealMyRunNativeSession: vi.fn(),
  listMyLiveActivity: vi.fn(),
  getMyHostStatus: vi.fn(),
  listMyFindings: vi.fn(),
  listMyDecisions: vi.fn(),
  listMyChoices: vi.fn(),
  decideMyChoice: vi.fn(),
  controlMyJob: vi.fn(),
  listMyArtifacts: vi.fn(),
  addMyAttachment: vi.fn(),
  deleteMyArtifact: vi.fn(),
  readMyArtifact: vi.fn(),
  searchMyChats: vi.fn(),
  markMyChatRead: vi.fn(),
  markMyChatReadSeq: vi.fn(),
  listMyAgentProviders: vi.fn(),
}));
vi.mock("@/lib/auth/threadlink-user", () => ({
  requireThreadLinkUser: owner.requireThreadLinkUser,
}));
vi.mock("@/lib/chat/owner", () => owner);

import { GET as activityGET } from "@/app/api/dashboard/chats/[chatId]/activity/route";
import {
  DELETE as artifactDELETE,
  GET as artifactGET,
} from "@/app/api/dashboard/chats/[chatId]/artifacts/[artifactId]/route";
import {
  GET as artifactsGET,
  POST as artifactsPOST,
} from "@/app/api/dashboard/chats/[chatId]/artifacts/route";
import { POST as choicePOST } from "@/app/api/dashboard/chats/[chatId]/choices/[choiceId]/route";
import { GET as choicesGET } from "@/app/api/dashboard/chats/[chatId]/choices/route";
import { POST as controlPOST } from "@/app/api/dashboard/chats/[chatId]/control/route";
import { GET as eventsGET } from "@/app/api/dashboard/chats/[chatId]/events/route";
import { GET as findingsGET } from "@/app/api/dashboard/chats/[chatId]/findings/route";
import { POST as readPOST } from "@/app/api/dashboard/chats/[chatId]/read/route";
import { POST as revealPOST } from "@/app/api/dashboard/chats/[chatId]/runs/[runId]/reveal/route";
import { GET as runGET } from "@/app/api/dashboard/chats/[chatId]/runs/[runId]/route";
import { GET as providersGET } from "@/app/api/dashboard/providers/route";
import { GET as searchGET } from "@/app/api/dashboard/search/route";
import type { ThreadLinkUser } from "@/lib/auth/provision";
import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { ChatActionError } from "@/lib/chat/chats";
import {
  chatErrorReason,
  chatEventRowSchema,
  CHAT_ERROR_MESSAGES,
  CHAT_ERROR_REASONS,
  CHAT_ERROR_STATUS,
  deliveryOf,
  toChatEvent,
} from "@/lib/chat/model";
import * as chatTypes from "@/lib/chat/types";
import {
  artifactFilename,
  findingState,
  listTimelineFor,
  parseTimelineParams,
  runVerification,
} from "@/lib/chat/work";
import { chatApiErrorFrom } from "@/lib/client-api/chats";
import { redactExportText } from "@/lib/export/chat-export";
import { readCappedText } from "@/lib/http/body";
import { agoText, healthStateLabel, presenceLabel } from "@/lib/providers/health";
import * as model from "@/lib/team/model";

const USER: ThreadLinkUser = {
  id: "tlusr_alice",
  clerkUserId: "user_alice",
  displayName: null,
  primaryEmail: null,
  createdAt: "2026-09-26T00:00:00Z",
};
const hex = (c: string) => c.repeat(32);
const CHAT = `tlcht_${hex("a")}`;
const JOB = `tljob_${hex("b")}`;
const RUN = `tlarn_${hex("c")}`;
const CHOICE = `tlchc_${hex("d")}`;
const ART = `tlart_${hex("e")}`;
const SESSION = `tlses_${hex("f")}`;
const SQL10 = readFileSync("supabase/migrations/20260927000200_threadlink_0_10.sql", "utf8");

/** The last `select array[...]` list a function of the 0.10 migration returns. */
const sqlList = (fn: string) => {
  const m = new RegExp(
    `function threadlink_private\\.${fn}\\(\\) returns text\\[\\][\\s\\S]*?select array\\[([\\s\\S]*?)\\]`,
  ).exec(SQL10);
  if (!m) throw new Error(`no ${fn}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

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
    for (const m of ["select", "eq", "gt", "lt", "is", "in", "not", "ilike", "order", "limit"]) {
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

const row = (chatSeq: number, over: Record<string, unknown> = {}) => ({
  seq: 1000 + chatSeq,
  id: `tlcev_${String(chatSeq).padStart(32, "0")}`,
  owner_user_id: USER.id,
  created_at: "2026-09-26T10:00:00Z",
  room_id: null,
  chat_id: CHAT,
  agent_session_id: SESSION,
  job_id: JOB,
  task_id: null,
  node_id: null,
  author_kind: "agent",
  author_provider: "codex",
  author_label: "Codex",
  author_role: "reviewer",
  audience: "team",
  event_type: "agent_message",
  message_type: "review",
  round: 1,
  model_requested: null,
  model_observed: "gpt-5",
  body: "Looks right.",
  visibility: "visible",
  chat_seq: chatSeq,
  run_id: RUN,
  reply_to_event_id: null,
  ref_kind: null,
  ref_id: null,
  payload: null,
  queued_for: null,
  consumed_by_run_id: null,
  delivered_at: null,
  ...over,
});

const chatRow = {
  id: CHAT,
  owner_user_id: USER.id,
  deleted_at: null,
  room_id: null,
  last_read_chat_seq: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  owner.requireThreadLinkUser.mockResolvedValue({ id: "tlusr_alice" });
});

// ===========================================================================
describe("vocabularies: the shared types equal the 0.10 migration", () => {
  it("chat event types", () => {
    expect(sqlList("chat_event_types")).toEqual([...chatTypes.CHAT_EVENT_TYPES]);
    const check =
      /constraint chat_events_event_type_check check \(event_type in \(([^)]*)\)\)/.exec(
        SQL10,
      )?.[1];
    expect([...(check ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      ...chatTypes.CHAT_EVENT_TYPES,
    ]);
  });
  it.each([
    ["run_statuses", chatTypes.RUN_STATUSES],
    ["run_activities", chatTypes.RUN_ACTIVITIES],
    ["choice_kinds", chatTypes.CHOICE_KINDS],
    ["job_controls", chatTypes.JOB_CONTROLS],
    ["artifact_kinds", chatTypes.ARTIFACT_KINDS],
    ["ref_kinds", chatTypes.REF_KINDS],
    ["finding_open_states", model.FINDING_OPEN_STATES],
    ["team_finding_statuses", model.FINDING_STATUSES],
    ["team_job_statuses", model.JOB_STATUSES],
    ["run_failures", model.RUN_FAILURES],
    ["artifact_mimes", model.ARTIFACT_MIMES],
  ] as const)("%s", (fn, list) => {
    expect(sqlList(fn)).toEqual([...list]);
  });
  it("the server's copies agree with the shared types", () => {
    expect([...model.RUN_STATUS_VALUES]).toEqual([...chatTypes.RUN_STATUSES]);
    expect([...model.RUN_ACTIVITY_VALUES]).toEqual([...chatTypes.RUN_ACTIVITIES]);
    expect([...model.CHOICE_KIND_VALUES]).toEqual([...chatTypes.CHOICE_KINDS]);
    expect([...model.JOB_CONTROL_VALUES]).toEqual([...chatTypes.JOB_CONTROLS]);
    expect([...model.REF_KINDS]).toEqual([...chatTypes.REF_KINDS]);
    expect([...model.ARTIFACT_KINDS]).toEqual([...chatTypes.ARTIFACT_KINDS]);
  });
  it("every error reason has a sentence, a status and no database text", () => {
    for (const r of CHAT_ERROR_REASONS) {
      expect(CHAT_ERROR_MESSAGES[r]).toMatch(/^[A-Z].*\.$/);
      expect(CHAT_ERROR_STATUS[r]).toBeGreaterThanOrEqual(400);
    }
    expect(chatErrorReason({ code: "P0002", hint: "choice_not_found" })).toBe("choice_not_found");
    expect(chatErrorReason({ code: "22023", hint: "invalid_choice" })).toBe("invalid_choice");
    expect(chatErrorReason({ code: "55000", hint: "choice_expired" })).toBe("choice_expired");
    expect(chatErrorReason({ code: "55000", hint: "runtime_outdated" })).toBe("runtime_outdated");
  });
});

// ===========================================================================
describe("Runtime write ops (0.10 shapes)", () => {
  const ok = (op: unknown) => model.teamWriteOpSchema.safeParse(op).success;
  const sql = (op: unknown) => model.toSqlPayload(model.teamWriteOpSchema.parse(op));

  it("run_started / run_activity / run_finished", () => {
    const started = {
      op: "run_started",
      payload: {
        runKey: "job:plan:1",
        provider: "claude-code",
        participantKey: "claude-code:planner",
        role: "planner",
        requestedModel: "claude-opus-4-1",
        effort: null,
        access: "read-only",
        timeoutMs: 900_000,
        continuity: "fresh",
      },
    };
    expect(ok(started)).toBe(true);
    expect(sql(started)).toEqual({
      run_key: "job:plan:1",
      provider: "claude-code",
      participant_key: "claude-code:planner",
      role: "planner",
      requested_model: "claude-opus-4-1",
      access: "read-only",
      timeout_ms: 900_000,
      continuity: "fresh",
    });
    expect(
      ok({ ...started, payload: { ...started.payload, participantKey: "Claude:planner" } }),
    ).toBe(false);
    expect(ok({ ...started, payload: { ...started.payload, timeoutMs: 99_999_999 } })).toBe(false);
    expect(ok({ op: "run_activity", payload: { runId: RUN, activity: "reviewing" } })).toBe(true);
    expect(ok({ op: "run_activity", payload: { runId: RUN, activity: "hacking" } })).toBe(false);
    const finished = {
      op: "run_finished",
      payload: {
        runId: RUN,
        status: "completed",
        observedModel: "claude-opus-4-1",
        modelVerified: true,
        accessVerified: true,
        nativeSessionId: "5f2c-abc",
        nativeSessionKind: "claude_session",
      },
    };
    expect(sql(finished)).toEqual({
      run_id: RUN,
      status: "completed",
      observed_model: "claude-opus-4-1",
      model_verified: true,
      access_verified: true,
      native_session_id: "5f2c-abc",
      native_session_kind: "claude_session",
    });
    expect(
      sql({ ...finished, payload: { ...finished.payload, nativeSessionId: null } }),
    ).not.toHaveProperty("native_session_kind");
    expect(ok({ ...finished, payload: { ...finished.payload, nativeSessionId: "a b" } })).toBe(
      false,
    );
  });

  it("a long or wide idempotency key is stored as a stable short key", () => {
    const long = `tljob_${hex("1")}:review:unit/with spaces:r2:codex:reviewer:c1:`.repeat(3);
    const k = model.wireKeyToSql(long);
    // "k:" + the first 32 hex of SHA-256: the Runtime's wireKey computes the same.
    expect(k).toBe(`k:${createHash("sha256").update(long, "utf8").digest("hex").slice(0, 32)}`);
    expect(model.wireKeyToSql(long + "x")).not.toBe(k);
    expect(model.wireKeyToSql("plan:1")).toBe("plan:1");
    expect(model.wireKeyToSql("ünïcode key")).toBe(
      `k:${createHash("sha256").update("ünïcode key", "utf8").digest("hex").slice(0, 32)}`,
    );
    for (const n of [0, 55, 56, 63, 64, 119, 200]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
      expect(model.sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("the export redaction catches credentials assigned by name (mirrors redact_text)", () => {
    expect(redactExportText("DB_PASS=hunter2")).toBe("DB_PASS=[redacted]");
    expect(redactExportText("export MY_CREDS=abc123")).toBe("export MY_CREDS=[redacted]");
    expect(redactExportText('{"db_pass": "s3cret"}')).toBe('{"db_pass": [redacted]');
    expect(redactExportText("credentials = abc")).toBe("credentials = [redacted]");
    expect(redactExportText("The keyboard: nice\npassing: 3")).toBe(
      "The keyboard: nice\npassing: 3",
    );
  });

  it("request bodies are read with a byte cap, streaming", async () => {
    const small = new Request("https://x.test", { method: "POST", body: '{"a":1}' });
    expect(await readCappedText(small, 100)).toBe('{"a":1}');
    const big = new Request("https://x.test", { method: "POST", body: "x".repeat(5000) });
    expect(await readCappedText(big, 100)).toEqual({ tooLarge: true });
    const lying = new Request("https://x.test", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: "{}",
    });
    expect(await readCappedText(lying, 100)).toEqual({ tooLarge: true });
  });

  it("a post from another computer names the computer it runs on", () => {
    const e = chatApiErrorFrom({ code: "42501", hint: "other_computer", details: "Nickron PC" });
    expect(e.reason).toBe("other_computer");
    expect(e.userMessage).toBe(
      "This chat runs on Nickron PC. Send from that computer or from the web.",
    );
    expect(
      chatApiErrorFrom({ code: "42501", hint: "other_computer", details: "" }).userMessage,
    ).toBe("This chat runs on another computer. Send from that computer or from the web.");
  });

  it("add_message: a message reply, or a card reference", () => {
    const base = { sender: "codex", type: "response", body: "Fixed.", runId: RUN };
    expect(
      sql({ op: "add_message", payload: { ...base, replyTo: { kind: "message", id: "tlamg_x" } } }),
    ).toMatchObject({ run_id: RUN, reply_to: "tlamg_x" });
    const toFinding = sql({
      op: "add_message",
      payload: { ...base, replyTo: { kind: "finding", id: "tlfnd_y" } },
    });
    expect(toFinding).toMatchObject({ ref_kind: "finding", ref_id: "tlfnd_y" });
    expect(toFinding).not.toHaveProperty("reply_to");
    expect(
      sql({
        op: "add_message",
        payload: {
          ...base,
          refs: [
            { kind: "decision", id: "tldec_z" },
            { kind: "node", id: "api" },
          ],
        },
      }),
    ).toMatchObject({ ref_kind: "decision", ref_id: "tldec_z" });
    expect(ok({ op: "add_message", payload: { ...base, runId: "tlarn_nothex" } })).toBe(false);
  });

  it("add_finding carries the run, the owner and file:line", () => {
    expect(
      sql({
        op: "add_finding",
        payload: {
          severity: "blocking",
          category: "security",
          summary: "IP only",
          raisedBy: "codex",
          file: "app/api/limit.ts",
          line: 42,
          runId: RUN,
          ownerParticipant: "claude-code:builder",
        },
      }),
    ).toMatchObject({
      run_id: RUN,
      owner_participant: "claude-code:builder",
      file_path: "app/api/limit.ts",
      line: 42,
      location: "app/api/limit.ts:42",
    });
    expect(
      ok({
        op: "set_finding_status",
        payload: { findingId: `tlfnd_${hex("1")}`, status: "disputed", runId: RUN },
      }),
    ).toBe(true);
  });

  it("add_decision records its title source", () => {
    expect(
      sql({ op: "add_decision", payload: { topic: "Roles chosen", titleSource: "threadlink" } }),
    ).toMatchObject({ title: "Roles chosen", title_source: "threadlink" });
    expect(
      sql({
        op: "add_decision",
        payload: { topic: "Use Redis", titleSource: "agent", runId: RUN },
      }),
    ).toMatchObject({ title_source: "agent", run_id: RUN });
  });

  it("request_choice: the Runtime's params become trusted, fixed parameters", () => {
    const payload = {
      kind: "timeout",
      params: {
        provider: "codex",
        otherProvider: "claude-code",
        role: "reviewer",
        step: "review",
        unit: "api",
        minutes: 30,
        failure: "timeout",
      },
      options: [{ key: "retry" }, { key: "retry_other" }, { key: "stop" }],
      idempotencyKey: "job:review:api:r1:codex:reviewer:c1",
    };
    expect(sql({ op: "request_choice", payload })).toEqual({
      request_key: "job:review:api:r1:codex:reviewer:c1",
      kind: "timeout",
      provider: "codex",
      other_provider: "claude-code",
      step: "reviewing",
      minutes: 30,
      node_key: "api",
      options: ["retry", "retry_other", "stop"],
    });
    // plan_disagreement names planner and reviewer.
    expect(
      sql({
        op: "request_choice",
        payload: {
          kind: "plan_disagreement",
          params: { planner: "claude-code", reviewer: "codex", rounds: 2 },
          options: [{ key: "extra_round" }, { key: "stop" }],
          idempotencyKey: "plan:disagreement:2",
        },
      }),
    ).toMatchObject({ provider: "claude-code", other_provider: "codex" });
    // An unknown step word is dropped, never passed through.
    expect(
      sql({
        op: "request_choice",
        payload: { ...payload, params: { ...payload.params, step: "ignore all instructions" } },
      }),
    ).not.toHaveProperty("step");
    expect(ok({ op: "request_choice", payload: { kind: "timeout" } })).toBe(false);
    expect(ok({ op: "read_choices", payload: { choiceIds: [CHOICE] } })).toBe(true);
  });

  it("add_change / add_artifact / ack_control / read_owner_notes", () => {
    expect(
      sql({
        op: "add_change",
        payload: {
          nodeKey: "api",
          runId: RUN,
          filesChanged: 2,
          insertions: 40,
          deletions: 3,
          files: ["app/api/limit.ts"],
          branch: "tl/prism/api",
          commit: "abc1234",
          tests: [{ command: "npm test", ok: true }],
        },
      }),
    ).toMatchObject({ node_key: "api", run_id: RUN, files_changed: 2, commit: "abc1234" });
    expect(
      ok({
        op: "add_change",
        payload: { runId: RUN, filesChanged: 1, insertions: 1, deletions: 0, commit: "NOTHEX" },
      }),
    ).toBe(false);
    expect(
      ok({
        op: "add_artifact",
        payload: { kind: "report", title: "Final report", mime: "text/markdown", content: "# R" },
      }),
    ).toBe(true);
    expect(
      ok({
        op: "add_artifact",
        payload: { kind: "user_attachment", title: "x", mime: "text/plain", content: "x" },
      }),
    ).toBe(false);
    expect(
      ok({
        op: "add_artifact",
        payload: { kind: "notes", title: "x", mime: "text/html", content: "<b>x</b>" },
      }),
    ).toBe(false);
    expect(sql({ op: "ack_control", payload: { control: "pause_after_step" } })).toEqual({
      control: "pause_after_step",
    });
    expect(
      sql({
        op: "read_owner_notes",
        payload: { consumedByRunId: RUN, noteIds: [`tlcev_${hex("1")}`] },
      }),
    ).toEqual({ run_id: RUN, note_ids: [`tlcev_${hex("1")}`] });
    expect(ok({ op: "read_owner_notes", payload: { noteIds: [`tlcev_${hex("1")}`] } })).toBe(false);
  });

  it("the status row carries the owner's control", () => {
    const row = model.teamStatusRowSchema.partial().parse({
      control: "stop_after_review",
      control_requested_at: "2026-09-26T10:00:00Z",
      pending_choices: 1,
    });
    expect(row.control).toBe("stop_after_review");
    expect(model.JOB_STATUSES).toContain("interrupted");
    expect(model.JOB_STATUSES).toContain("paused");
  });
});

// ===========================================================================
describe("chat rows (0.10 mapping)", () => {
  it("maps provenance, replies, refs, payload and the per-chat cursor", () => {
    const e = toChatEvent(
      chatEventRowSchema.parse(
        row(7, {
          reply_to_event_id: `tlcev_${hex("9")}`,
          ref_kind: "finding",
          ref_id: `tlfnd_${hex("8")}`,
        }),
      ),
    );
    expect(e).toMatchObject({
      chatSeq: 7,
      runId: RUN,
      provenance: "run",
      replyTo: `tlcev_${hex("9")}`,
      ref: { kind: "finding", id: `tlfnd_${hex("8")}` },
      authorProvider: "codex",
      authorProviderId: "codex",
      audienceId: "team",
    });
  });
  it("an agent row without a run is legacy (recorded before 0.10)", () => {
    expect(toChatEvent(chatEventRowSchema.parse(row(1, { run_id: null }))).provenance).toBe(
      "legacy",
    );
  });
  it("a registry provider outside the 0.9 union is kept only in authorProviderId", () => {
    const e = toChatEvent(
      chatEventRowSchema.parse(row(1, { author_provider: "gemini-cli", audience: "gemini-cli" })),
    );
    expect(e.authorProvider).toBeNull();
    expect(e.authorProviderId).toBe("gemini-cli");
    expect(e.audience).toBeNull();
    expect(e.audienceId).toBe("gemini-cli");
  });
  it("never shows a provider on a ThreadLink row", () => {
    const e = toChatEvent(
      chatEventRowSchema.parse(
        row(1, { author_kind: "threadlink", author_label: "ThreadLink", event_type: "phase" }),
      ),
    );
    expect(e.authorProvider).toBeNull();
    expect(e.authorProviderId).toBeNull();
    expect(e.provenance).toBeNull();
  });
  it("delivery states", () => {
    const note = {
      author_kind: "owner" as const,
      event_type: "message" as const,
      job_id: JOB,
      audience: "codex",
    };
    expect(
      deliveryOf(
        { ...note, queued_for: ["codex"] },
        { jobFinished: false, consumedByProvider: null },
      ),
    ).toEqual({
      state: "queued",
      for: ["codex"],
    });
    expect(
      deliveryOf(
        { ...note, queued_for: ["codex"] },
        { jobFinished: true, consumedByProvider: null },
      ),
    ).toEqual({
      state: "not_delivered",
    });
    expect(
      deliveryOf(
        { ...note, queued_for: ["codex"], delivered_at: "t", consumed_by_run_id: RUN },
        { jobFinished: false, consumedByProvider: "codex" },
      ),
    ).toEqual({ state: "seen", by: ["codex"] });
    expect(
      deliveryOf({ ...note, delivered_at: "t" }, { jobFinished: false, consumedByProvider: null }),
    ).toEqual({ state: "sent" });
    expect(
      deliveryOf(
        { ...note, event_type: "request", job_id: null },
        { jobFinished: null, consumedByProvider: null },
      ),
    ).toEqual({ state: "sent" });
    expect(
      deliveryOf(
        { ...note, author_kind: "agent" },
        { jobFinished: null, consumedByProvider: null },
      ),
    ).toBeNull();
  });
});

// ===========================================================================
describe("the timeline by chat_seq", () => {
  it("the latest page: oldest first, seq IS chat_seq, hasMore from an extra row", async () => {
    const { db, calls } = fakeDb({
      chats: { data: chatRow },
      chat_events: { data: [row(5), row(4), row(3)] },
      team_jobs: { data: [] },
      agent_runs: { data: [] },
    });
    const page = await listTimelineFor(db, USER, CHAT, { limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(page.events.every((e) => e.seq === e.chatSeq)).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.oldestChatSeq).toBe(4);
    expect(page.cursor).toBe(5);
    expect(page.lastReadChatSeq).toBe(3);
    const ev = calls.find((c) => c.table === "chat_events")!;
    expect(ev.ops).toContainEqual(["eq", ["chat_id", CHAT]]);
    expect(ev.ops).toContainEqual(["eq", ["visibility", "visible"]]);
    expect(ev.ops).toContainEqual(["limit", [3]]);
  });
  it("before= pages older rows; after= polls newer rows", async () => {
    const older = fakeDb({
      chats: { data: chatRow },
      chat_events: { data: [row(2), row(1)] },
      team_jobs: { data: [] },
    });
    const p1 = await listTimelineFor(older.db, USER, CHAT, { before: 3 });
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.hasMore).toBe(false);
    expect(older.calls.find((c) => c.table === "chat_events")!.ops).toContainEqual([
      "lt",
      ["chat_seq", 3],
    ]);
    const newer = fakeDb({
      chats: { data: chatRow },
      chat_events: { data: [row(6)] },
      team_jobs: { data: [] },
    });
    const p2 = await listTimelineFor(newer.db, USER, CHAT, { after: 5 });
    expect(p2.events.map((e) => e.seq)).toEqual([6]);
    expect(newer.calls.find((c) => c.table === "chat_events")!.ops).toContainEqual([
      "gt",
      ["chat_seq", 5],
    ]);
  });
  it("owner notes carry their delivery state", async () => {
    const note = row(4, {
      author_kind: "owner",
      author_provider: null,
      author_label: "You",
      author_role: null,
      event_type: "message",
      audience: "codex",
      run_id: null,
      queued_for: ["codex"],
      consumed_by_run_id: RUN,
      delivered_at: "2026-09-26T10:01:00Z",
    });
    const { db } = fakeDb({
      chats: { data: chatRow },
      chat_events: { data: [note] },
      team_jobs: {
        data: [
          { id: JOB, owner_user_id: USER.id, finished_at: null, mode: "team", status: "building" },
        ],
      },
      agent_runs: { data: [{ id: RUN, owner_user_id: USER.id, provider: "codex" }] },
    });
    const page = await listTimelineFor(db, USER, CHAT, {});
    expect(page.events[0]!.delivery).toEqual({ state: "seen", by: ["codex"] });
  });
  it("another account's chat, or a row outside the chat, is refused", async () => {
    const other = fakeDb({ chats: { data: { ...chatRow, owner_user_id: "tlusr_bob" } } });
    await expect(listTimelineFor(other.db, USER, CHAT, {})).rejects.toThrow();
    const leak = fakeDb({
      chats: { data: chatRow },
      chat_events: { data: [row(1, { chat_id: `tlcht_${hex("0")}` })] },
      team_jobs: { data: [] },
    });
    await expect(listTimelineFor(leak.db, USER, CHAT, {})).rejects.toThrow();
  });
  it("parses ?after / ?before / ?limit strictly", () => {
    const p = (s: string) => parseTimelineParams(new URLSearchParams(s));
    expect(p("after=5")).toEqual({ after: 5, technical: false });
    expect(p("before=9&limit=50&technical=1")).toEqual({ before: 9, limit: 50, technical: true });
    expect(p("after=1&before=2")).toBeNull();
    expect(p("limit=500")).toBeNull();
    expect(p("after=-1")).toBeNull();
    expect(p("technical=maybe")).toBeNull();
  });
});

// ===========================================================================
describe("provenance, health and small helpers", () => {
  const run = {
    status: "completed" as const,
    model_verified: true,
    access_verified: true,
    runtime_id: "tlrun_1",
    verification: { nativeSession: true },
    native_session_kind: "claude_session",
  };
  it("verified only with complete evidence on the project's own computer", () => {
    expect(runVerification(run, "tlrun_1")).toEqual({ verified: "verified", notes: [] });
    expect(runVerification({ ...run, model_verified: false }, "tlrun_1").verified).toBe("partial");
    expect(runVerification(run, "tlrun_2").notes).toContain(
      "It did not run on this project's own computer.",
    );
    expect(runVerification({ ...run, verification: {} }, "tlrun_1").notes).toContain(
      "Persistent native session: not exposed by this provider.",
    );
    expect(runVerification({ ...run, status: "running" }, "tlrun_1").verified).toBe("partial");
  });
  it("one freshness label: never Ready with stale text", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(healthStateLabel("ready", "2026-09-26T11:59:37Z", now)).toBe("Ready · checked 23 s ago");
    expect(healthStateLabel("stale", "2026-09-26T10:00:00Z", now)).toBe(
      "Stale · last checked 2 h ago",
    );
    expect(healthStateLabel("needs_sign_in", "2026-09-26T11:00:00Z", now)).toBe("Needs sign-in");
    expect(agoText("nonsense", now)).toBeNull();
    expect(presenceLabel("offline", "2026-09-26T11:55:00Z", now)).toBe(
      "Offline · last seen 5 min ago",
    );
    expect(presenceLabel("working", null, now)).toBe("Working");
  });
  it("a pre-0.10 wont_fix reads as dismissed", () => {
    expect(findingState("wont_fix")).toBe("dismissed");
    expect(findingState("disputed")).toBe("disputed");
  });
  it("download file names are safe", () => {
    expect(artifactFilename('Final "report"\r\n<x>', "text/markdown")).toBe("Final report x.md");
    expect(artifactFilename("../../etc/passwd", "text/plain")).toBe("etc passwd.txt");
    expect(artifactFilename("", "text/x-diff")).toBe("artifact.diff");
  });
});

// ===========================================================================
describe("owner routes (0.10)", () => {
  const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: "https://app.test",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const base = `https://app.test/api/dashboard/chats/${CHAT}`;

  it("fail closed when signed out, before reading the request", async () => {
    owner.requireThreadLinkUser.mockRejectedValueOnce(new AuthenticationRequiredError());
    const res = await eventsGET(new Request(`${base}/events`), ctx({ chatId: CHAT }));
    expect(res.status).toBe(401);
    expect(owner.listMyChatTimeline).not.toHaveBeenCalled();
  });

  it("events: a malformed chat id is 404, a malformed cursor 400", async () => {
    expect((await eventsGET(new Request(`${base}/events`), ctx({ chatId: "x" }))).status).toBe(404);
    expect(
      (await eventsGET(new Request(`${base}/events?after=abc`), ctx({ chatId: CHAT }))).status,
    ).toBe(400);
    owner.listMyChatTimeline.mockResolvedValueOnce({ events: [], cursor: 0 });
    const res = await eventsGET(
      new Request(`${base}/events?before=10&limit=50`),
      ctx({ chatId: CHAT }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(owner.listMyChatTimeline).toHaveBeenCalledWith(CHAT, {
      before: 10,
      limit: 50,
      technical: false,
    });
  });

  it("a refusal is a fixed sentence with its reason, never database text", async () => {
    owner.decideMyChoice.mockRejectedValueOnce(new ChatActionError("choice_closed"));
    const res = await choicePOST(
      post(`${base}/choices/${CHOICE}`, { key: "stop" }),
      ctx({ chatId: CHAT, choiceId: CHOICE }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "choice_closed",
      message: CHAT_ERROR_MESSAGES.choice_closed,
    });
  });

  it("owner mutations are same-origin JSON only", async () => {
    const cross = post(
      `${base}/control`,
      { jobId: JOB, action: "stop_now" },
      { "sec-fetch-site": "cross-site" },
    );
    expect((await controlPOST(cross, ctx({ chatId: CHAT }))).status).toBe(400);
    expect(owner.controlMyJob).not.toHaveBeenCalled();
    const form = new Request(`${base}/choices/${CHOICE}`, {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
      body: '{"key":"stop"}',
    });
    expect((await choicePOST(form, ctx({ chatId: CHAT, choiceId: CHOICE }))).status).toBe(400);
    const reveal = new Request(`${base}/runs/${RUN}/reveal`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect((await revealPOST(reveal, ctx({ chatId: CHAT, runId: RUN }))).status).toBe(400);
    expect(owner.revealMyRunNativeSession).not.toHaveBeenCalled();
    const del = new Request(`${base}/artifacts/${ART}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect((await artifactDELETE(del, ctx({ chatId: CHAT, artifactId: ART }))).status).toBe(400);
  });

  it("control, choices, reveal and runs pass through the owner functions", async () => {
    owner.controlMyJob.mockResolvedValueOnce({
      jobId: JOB,
      control: "stop_now",
      controlRequestedAt: "t",
      status: "building",
    });
    const c = await controlPOST(
      post(`${base}/control`, { jobId: JOB, action: "stop_now" }),
      ctx({ chatId: CHAT }),
    );
    expect(c.status).toBe(200);
    expect(owner.controlMyJob).toHaveBeenCalledWith(CHAT, { jobId: JOB, action: "stop_now" });
    owner.revealMyRunNativeSession.mockResolvedValueOnce({
      available: true,
      nativeSessionId: "s",
      kind: "claude_session",
      resumeCommand: "claude --resume s",
    });
    const r = await revealPOST(
      new Request(`${base}/runs/${RUN}/reveal`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      ctx({ chatId: CHAT, runId: RUN }),
    );
    expect(await r.json()).toMatchObject({ ok: true, resumeCommand: "claude --resume s" });
    owner.getMyRunProvenance.mockResolvedValueOnce(null);
    expect(
      (await runGET(new Request(`${base}/runs/${RUN}`), ctx({ chatId: CHAT, runId: RUN }))).status,
    ).toBe(404);
    owner.listMyChoices.mockResolvedValueOnce([]);
    expect(
      await (await choicesGET(new Request(`${base}/choices`), ctx({ chatId: CHAT }))).json(),
    ).toEqual({ choices: [] });
    owner.listMyFindings.mockResolvedValueOnce([]);
    expect(
      await (await findingsGET(new Request(`${base}/findings`), ctx({ chatId: CHAT }))).json(),
    ).toEqual({ findings: [] });
    owner.listMyLiveActivity.mockResolvedValueOnce([]);
    owner.getMyHostStatus.mockResolvedValueOnce({ now: "t", runtime: null, agents: [] });
    expect(
      await (await activityGET(new Request(`${base}/activity`), ctx({ chatId: CHAT }))).json(),
    ).toEqual({
      live: [],
      host: { now: "t", runtime: null, agents: [] },
    });
  });

  it("artifacts: list, attach (size-capped), download as a file", async () => {
    owner.listMyArtifacts.mockResolvedValueOnce([]);
    expect(
      (await artifactsGET(new Request(`${base}/artifacts`), ctx({ chatId: CHAT }))).status,
    ).toBe(200);
    owner.addMyAttachment.mockResolvedValueOnce({ artifactId: ART });
    const up = await artifactsPOST(
      post(`${base}/artifacts`, { title: "Notes", content: "hi" }),
      ctx({ chatId: CHAT }),
    );
    expect(up.status).toBe(200);
    const huge = post(`${base}/artifacts`, { title: "Big", content: "x".repeat(500 * 1024) });
    expect((await artifactsPOST(huge, ctx({ chatId: CHAT }))).status).toBe(400);
    owner.readMyArtifact.mockResolvedValueOnce({
      filename: "report.md",
      mime: "text/markdown",
      content: "# R",
    });
    const dl = await artifactGET(
      new Request(`${base}/artifacts/${ART}`),
      ctx({ chatId: CHAT, artifactId: ART }),
    );
    expect(dl.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="report.md"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await dl.text()).toBe("# R");
    owner.readMyArtifact.mockResolvedValueOnce({
      filename: "d.diff",
      mime: "text/x-diff",
      content: "+x",
    });
    const diff = await artifactGET(
      new Request(`${base}/artifacts/${ART}`),
      ctx({ chatId: CHAT, artifactId: ART }),
    );
    expect(diff.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    owner.readMyArtifact.mockResolvedValueOnce(null);
    expect(
      (
        await artifactGET(
          new Request(`${base}/artifacts/${ART}`),
          ctx({ chatId: CHAT, artifactId: ART }),
        )
      ).status,
    ).toBe(404);
  });

  it("read: chatSeq (0.10) or seq (0.9, deprecated)", async () => {
    owner.markMyChatReadSeq.mockResolvedValueOnce({ lastReadChatSeq: 7, lastReadSeq: 1007 });
    const a = await readPOST(post(`${base}/read`, { chatSeq: 7 }), ctx({ chatId: CHAT }));
    expect(await a.json()).toEqual({ ok: true, lastReadChatSeq: 7, lastReadSeq: 1007 });
    owner.markMyChatRead.mockResolvedValueOnce({ lastReadSeq: 1007 });
    const b = await readPOST(post(`${base}/read`, { seq: 1007 }), ctx({ chatId: CHAT }));
    expect(await b.json()).toEqual({ ok: true, lastReadSeq: 1007 });
    expect(
      (await readPOST(post(`${base}/read`, { seq: 1, chatSeq: 1 }), ctx({ chatId: CHAT }))).status,
    ).toBe(400);
  });

  it("search and the provider registry", async () => {
    owner.searchMyChats.mockResolvedValueOnce([]);
    const s = await searchGET(
      new Request("https://app.test/api/dashboard/search?q=burst&limit=10"),
    );
    expect(s.status).toBe(200);
    expect(owner.searchMyChats).toHaveBeenCalledWith({ q: "burst", limit: 10 });
    expect(
      (await searchGET(new Request("https://app.test/api/dashboard/search?q=x&limit=abc"))).status,
    ).toBe(400);
    owner.listMyAgentProviders.mockResolvedValueOnce([{ id: "codex" }]);
    expect(await (await providersGET()).json()).toEqual({ providers: [{ id: "codex" }] });
  });
});
