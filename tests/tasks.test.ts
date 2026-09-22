import { describe, expect, it, vi } from "vitest";

import type { ClientDatabase } from "@/lib/client-api/operations";
import {
  claimTask,
  completeTask,
  createTask,
  getTaskResult,
  listInbox,
} from "@/lib/client-api/tasks";
import { completeInputSchema, createTaskInputSchema, TASK_LIMITS } from "@/lib/tasks/model";

const HASH = "cd".repeat(32);
const S_C = "tlses_00112233445566778899aabbccddeeff";
const S_G = "tlses_ffeeddccbbaa99887766554433221100";
const L = "tllnk_00112233445566778899aabbccddeeff";
const T = "tltask_00112233445566778899aabbccddeeff";

const envelope = {
  task_id: T,
  message_id: "tlmsg_00112233445566778899aabbccddeeff",
  thread_link_id: L,
  origin_session_id: S_C,
  target_session_id: S_G,
  type: "task",
  task_type: "general",
  priority: "A1",
  title: "Fix",
  content: "do it",
  status: "queued",
  cancel_reason: null,
  created_at: "2026-09-22T00:00:00Z",
  claimed_at: null,
  started_at: null,
  completed_at: null,
  failed_at: null,
  cancelled_at: null,
  expired_at: null,
  expires_at: "2026-09-23T00:00:00Z",
};

function fakeDb(response: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn<ClientDatabase["rpc"]>(async () => response);
  return { db: { rpc } satisfies ClientDatabase, rpc };
}

const base = { originSessionId: S_C, threadLinkId: L, title: "Fix", content: "do it" };

describe("createTaskInputSchema", () => {
  it("accepts a minimal task", () => {
    expect(createTaskInputSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    "targetSessionId",
    "target_session_id",
    "targetConnectionId",
    "ownerUserId",
    "owner_user_id",
    "targetUserId",
    "status",
  ])("rejects caller-supplied %s (the link decides routing)", (key) => {
    expect(createTaskInputSchema.safeParse({ ...base, [key]: S_G }).success).toBe(false);
  });

  it.each(["A", "A1", "A2", "A3", "B", "C", "D", "E"])("accepts priority %s", (priority) => {
    expect(createTaskInputSchema.safeParse({ ...base, priority }).success).toBe(true);
  });

  it.each(["A4", "F", "a1", "", "AA"])("rejects priority %j", (priority) => {
    expect(createTaskInputSchema.safeParse({ ...base, priority }).success).toBe(false);
  });

  it("enforces content bytes, not characters (multi-byte text)", () => {
    const emoji = "😀".repeat(TASK_LIMITS.contentBytes / 4 + 1); // just over 64 KB in UTF-8
    expect(createTaskInputSchema.safeParse({ ...base, content: emoji }).success).toBe(false);
    expect(
      createTaskInputSchema.safeParse({ ...base, content: "x".repeat(TASK_LIMITS.contentBytes) })
        .success,
    ).toBe(true);
  });

  it("limits title length and expiry range", () => {
    expect(createTaskInputSchema.safeParse({ ...base, title: "x".repeat(256) }).success).toBe(
      false,
    );
    expect(createTaskInputSchema.safeParse({ ...base, expiresInSeconds: 30 }).success).toBe(false);
    expect(createTaskInputSchema.safeParse({ ...base, expiresInSeconds: 3600 }).success).toBe(true);
  });
});

describe("completeInputSchema", () => {
  const ok = { sessionId: S_G, claimRef: "worker-1", result: "done" };

  it("accepts bounded artifact references", () => {
    expect(
      completeInputSchema.safeParse({
        ...ok,
        artifacts: [{ type: "git_commit", reference: "abc123", metadata: { branch: "main" } }],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown artifact types, blobs and too many artifacts", () => {
    expect(
      completeInputSchema.safeParse({ ...ok, artifacts: [{ type: "binary", reference: "x" }] })
        .success,
    ).toBe(false);
    expect(
      completeInputSchema.safeParse({
        ...ok,
        artifacts: [{ type: "other", reference: "x", metadata: { blob: "x".repeat(5000) } }],
      }).success,
    ).toBe(false);
    expect(
      completeInputSchema.safeParse({
        ...ok,
        artifacts: Array.from({ length: 21 }, () => ({ type: "url", reference: "https://x" })),
      }).success,
    ).toBe(false);
  });

  it("allows results up to 256 KB but not more", () => {
    expect(
      completeInputSchema.safeParse({ ...ok, result: "x".repeat(TASK_LIMITS.resultBytes) }).success,
    ).toBe(true);
    expect(
      completeInputSchema.safeParse({ ...ok, result: "x".repeat(TASK_LIMITS.resultBytes + 1) })
        .success,
    ).toBe(false);
  });
});

describe("task operations", () => {
  it("createTask sends only the origin session and link; never a target", async () => {
    const { db, rpc } = fakeDb({ data: { ...envelope, created: true }, error: null });
    const result = await createTask(db, HASH, { ...base, priority: "A1", idempotencyKey: "k1" });
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("create_task");
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_token_hash",
        "p_origin_session_id",
        "p_thread_link_id",
        "p_title",
        "p_content",
        "p_priority",
        "p_task_type",
        "p_idempotency_key",
        "p_expires_in_seconds",
      ].sort(),
    );
    expect(JSON.stringify(args)).not.toContain(S_G);
    expect(result).toMatchObject({ created: true, task: { taskId: T, targetSessionId: S_G } });
  });

  it("oversized payloads are rejected as too_large before the database", async () => {
    const { db, rpc } = fakeDb({ data: envelope, error: null });
    const error = await createTask(db, HASH, {
      ...base,
      content: "x".repeat(TASK_LIMITS.contentBytes + 1),
    }).catch((e) => e);
    expect(error.kind).toBe("too_large");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("claim requires a well-formed task ID, session and claim ref", async () => {
    const { db, rpc } = fakeDb({ data: envelope, error: null });
    await expect(
      claimTask(db, HASH, "tltask_nope", { sessionId: S_G, claimRef: "w" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(claimTask(db, HASH, T, { sessionId: S_G })).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      claimTask(db, HASH, T, { sessionId: S_G, claimRef: "bad ref" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a lost claim race to conflict", async () => {
    const { db } = fakeDb({
      data: null,
      error: { message: "task is not claimable", code: "55000" },
    });
    await expect(claimTask(db, HASH, T, { sessionId: S_G, claimRef: "w2" })).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("complete forwards artifacts with default metadata", async () => {
    const { db, rpc } = fakeDb({ data: { ...envelope, status: "completed" }, error: null });
    await completeTask(db, HASH, T, {
      sessionId: S_G,
      claimRef: "w1",
      result: "done",
      artifacts: [{ type: "pull_request", reference: "42" }],
    });
    expect(rpc.mock.calls[0][1].p_artifacts).toEqual([
      { type: "pull_request", reference: "42", metadata: {} },
    ]);
  });

  it("inbox limit is bounded", async () => {
    const { db, rpc } = fakeDb({ data: [], error: null });
    await expect(listInbox(db, HASH, S_G, "500")).rejects.toMatchObject({ kind: "invalid" });
    await listInbox(db, HASH, S_G, null);
    expect(rpc.mock.calls[0][1].p_limit).toBe(20);
  });

  it("result view is parsed strictly (fails closed on malformed rows)", async () => {
    const { db } = fakeDb({
      data: { ...envelope, result: "ok", error: null, progress: [], artifacts: [{ bad: true }] },
      error: null,
    });
    await expect(getTaskResult(db, HASH, T, S_C)).rejects.toMatchObject({ kind: "unavailable" });
  });
});
