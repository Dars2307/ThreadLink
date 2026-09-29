import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";

import {
  CHAT_ERROR_MESSAGES,
  CHAT_EVENT_COLUMNS,
  CHAT_PAGE_SIZE,
  chatErrorReason,
  chatEventRowSchema,
  chatQuerySchema,
  postChatByChatSchema,
  postChatMessageRowSchema,
  postChatMessageSchema,
  toChatEvent,
  type ChatErrorReason,
  type ChatQuery,
} from "./model";
import { healthEntriesSchema, healthMessage } from "@/lib/providers/health";
import { composeContextRowSchema, planPost } from "./compose";

import { JOB_MODES, type ChatPage, type PostChatMessageResult } from "./types";

/**
 * Owner (dashboard) reads and writes of the project chat. USER-SCOPED client:
 * RLS limits every read to the caller's own rows, and every row is re-checked
 * against the signed-in user here as well (the same two layers as the other
 * owner queries). Posts go through post_chat_message, which re-derives the
 * owner from the verified JWT and decides routing itself.
 */

export class ChatRoomNotFoundError extends Error {
  constructor() {
    super("Project not found");
    this.name = "ChatRoomNotFoundError";
  }
}

/** 0.9: a chat that is not the caller's, deleted, or missing (all alike). */
export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

const roomRow = z.object({ id: z.string(), owner_user_id: z.string(), status: z.string() });
const chatScopeRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  deleted_at: z.string().nullable(),
});
const activeJobRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  mode: z.enum(JOB_MODES),
  status: z.string(),
});

function assertOwned(user: ThreadLinkUser, rows: { owner_user_id: string }[]) {
  if (rows.some((r) => r.owner_user_id !== user.id)) throw new OwnershipViolationError();
}

/**
 * One page of a room's timeline. Without `after`: the latest page (up to 200
 * events, oldest first). With `after`: the events after that cursor, oldest
 * first, up to 200 -- poll again with the returned cursor for more.
 * `technical` events are included only when asked for.
 */
export async function listChatFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawQuery: ChatQuery,
): Promise<ChatPage> {
  const query = chatQuerySchema.parse(rawQuery);
  // Exactly one scope: a chat (0.9) or a project's whole timeline (0.8).
  const scope = query.chatId
    ? ({ column: "chat_id", id: query.chatId } as const)
    : ({ column: "room_id", id: query.roomId! } as const);

  if (scope.column === "chat_id") {
    const chat = await db
      .from("chats")
      .select("id, owner_user_id, deleted_at")
      .eq("id", scope.id)
      .maybeSingle();
    if (chat.error) throw new Error("Failed to load the chat");
    if (!chat.data) throw new ChatNotFoundError();
    const c = chatScopeRow.parse(chat.data);
    assertOwned(user, [c]);
    if (c.deleted_at !== null) throw new ChatNotFoundError();
  } else {
    const room = await db
      .from("rooms")
      .select("id, owner_user_id, status")
      .eq("id", scope.id)
      .maybeSingle();
    if (room.error) throw new Error("Failed to load the project");
    if (!room.data) throw new ChatRoomNotFoundError();
    const r = roomRow.parse(room.data);
    assertOwned(user, [r]);
    if (r.status === "deleted") throw new ChatRoomNotFoundError();
  }

  let events = db.from("chat_events").select(CHAT_EVENT_COLUMNS).eq(scope.column, scope.id);
  if (!query.technical) events = events.eq("visibility", "visible");
  const latest = query.after === undefined;
  const page = await (latest
    ? events.order("seq", { ascending: false }).limit(CHAT_PAGE_SIZE)
    : events.gt("seq", query.after).order("seq", { ascending: true }).limit(CHAT_PAGE_SIZE));

  const job = await db
    .from("team_jobs")
    .select("id, owner_user_id, mode, status")
    .eq(scope.column, scope.id)
    .is("finished_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (page.error || job.error) throw new Error("Failed to load the chat");

  const rows = z.array(chatEventRowSchema).parse(page.data);
  const jobs = z.array(activeJobRow).parse(job.data);
  assertOwned(user, [...rows, ...jobs]);
  // A row from another scope can only be a bug; never show it.
  const outside =
    scope.column === "chat_id"
      ? rows.some((row) => row.chat_id !== scope.id)
      : rows.some((row) => row.room_id !== scope.id);
  if (outside) throw new OwnershipViolationError();

  const ordered = latest ? [...rows].reverse() : rows;
  const chatEvents = ordered.map(toChatEvent);
  const cursor = chatEvents.reduce((max, e) => Math.max(max, e.seq), query.after ?? 0);
  const active = jobs[0];
  return {
    events: chatEvents,
    cursor,
    activeJob: active ? { jobId: active.id, mode: active.mode, status: active.status } : null,
  };
}

/** A failed post also says WHY (for the HTTP status); the message is always human-safe. */
export type PostChatMessageOutcome =
  | Extract<PostChatMessageResult, { ok: true }>
  | (Extract<PostChatMessageResult, { ok: false }> & { reason: ChatErrorReason });

const failure = (reason: ChatErrorReason): PostChatMessageOutcome => ({
  ok: false,
  message: CHAT_ERROR_MESSAGES[reason],
  reason,
});

/**
 * The owner types into the project chat. Never throws for an expected refusal:
 * returns `{ok:false, message}` with a sentence chosen here (never database
 * text). Throws only on a programming error in the response shape.
 */
export async function postChatMessageAs(
  db: SupabaseClient,
  rawInput: unknown,
): Promise<PostChatMessageOutcome> {
  const byChat =
    rawInput !== null && typeof rawInput === "object" && Object.hasOwn(rawInput, "chatId");
  const parsed = byChat
    ? postChatByChatSchema.safeParse(rawInput)
    : postChatMessageSchema.safeParse(rawInput);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((i) => i.path[0] === "body" && i.code === "too_big");
    return failure(tooLong ? "too_long" : "invalid");
  }
  const input = parsed.data;
  if (input.body.trim() === "") return failure("empty");

  let result: {
    data: unknown;
    error: { code?: string; hint?: string | null; details?: string | null } | null;
  };
  try {
    if ("chatId" in input) {
      // 0.11: classify the lane and match a natural answer to an open choice
      // (section 2.4, 6). The database re-checks the choice and the lane.
      const ctx = (await db.rpc("chat_compose_context", { p_chat_id: input.chatId })) as {
        data: unknown;
        error: { code?: string; hint?: string | null } | null;
      };
      if (ctx.error) return failure(chatErrorReason(ctx.error));
      const context = composeContextRowSchema.safeParse(ctx.data);
      if (!context.success) return failure("unavailable");
      const plan = planPost({
        body: input.body,
        lane: input.lane ?? null,
        context: context.data,
        allowChoiceAnswers: true,
      });
      if (plan.body.trim() === "") return failure("empty");
      result = await db.rpc("post_chat_message", {
        p_chat_id: input.chatId,
        p_body: plan.body,
        p_idempotency_key: input.idempotencyKey ?? null,
        p_lane: plan.lane,
        p_lane_reason: plan.laneReason,
        p_choice_id: plan.choice?.choiceId ?? null,
        p_choice_key: plan.choice?.key ?? null,
      });
    } else
      result = await db.rpc("post_chat_message", {
        p_room_id: input.roomId,
        p_body: input.body,
        p_mode: input.mode ?? null,
        p_builder: input.builder ?? null,
        p_idempotency_key: input.idempotencyKey ?? null,
      });
  } catch {
    return failure("unavailable");
  }
  if (result.error) return failure(chatErrorReason(result.error));
  const row = postChatMessageRowSchema.safeParse(result.data);
  if (!row.success) return failure("unavailable");
  if (row.data.routed === "provider_blocked") {
    // The message and a ThreadLink row naming who is not ready are in the chat;
    // no work started. The sentence is built here from ids and fixed words.
    const health = healthEntriesSchema.safeParse(row.data.health);
    const entries = health.success ? health.data : [];
    return {
      ok: false,
      reason: "provider_unhealthy",
      message: entries.length > 0 ? healthMessage(entries) : CHAT_ERROR_MESSAGES.provider_unhealthy,
      ...(entries.length > 0 ? { health: entries } : {}),
      stored: true,
    };
  }
  const r = row.data;
  return {
    ok: true,
    routed: r.routed as Exclude<typeof r.routed, "provider_blocked">,
    jobId: r.job_id,
    ...(r.lane ? { lane: r.lane, laneReason: r.lane_reason ?? null } : {}),
    ...(r.routed === "choice_resolved" && r.choice_id
      ? { choiceId: r.choice_id, chosenKey: r.chosen_key, chosenLabel: r.chosen_label ?? undefined }
      : {}),
  };
}
