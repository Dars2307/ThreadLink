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
  postChatMessageRowSchema,
  postChatMessageSchema,
  toChatEvent,
  type ChatErrorReason,
  type ChatQuery,
} from "./model";
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

const roomRow = z.object({ id: z.string(), owner_user_id: z.string(), status: z.string() });
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

  const room = await db
    .from("rooms")
    .select("id, owner_user_id, status")
    .eq("id", query.roomId)
    .maybeSingle();
  if (room.error) throw new Error("Failed to load the project");
  if (!room.data) throw new ChatRoomNotFoundError();
  const r = roomRow.parse(room.data);
  assertOwned(user, [r]);
  if (r.status === "deleted") throw new ChatRoomNotFoundError();

  let events = db.from("chat_events").select(CHAT_EVENT_COLUMNS).eq("room_id", query.roomId);
  if (!query.technical) events = events.eq("visibility", "visible");
  const latest = query.after === undefined;
  const page = await (latest
    ? events.order("seq", { ascending: false }).limit(CHAT_PAGE_SIZE)
    : events.gt("seq", query.after).order("seq", { ascending: true }).limit(CHAT_PAGE_SIZE));

  const job = await db
    .from("team_jobs")
    .select("id, owner_user_id, mode, status")
    .eq("room_id", query.roomId)
    .is("finished_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (page.error || job.error) throw new Error("Failed to load the project chat");

  const rows = z.array(chatEventRowSchema).parse(page.data);
  const jobs = z.array(activeJobRow).parse(job.data);
  assertOwned(user, [...rows, ...jobs]);
  // A row from another room can only be a bug; never show it.
  if (rows.some((row) => row.room_id !== query.roomId)) throw new OwnershipViolationError();

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
  const parsed = postChatMessageSchema.safeParse(rawInput);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((i) => i.path[0] === "body" && i.code === "too_big");
    return failure(tooLong ? "too_long" : "invalid");
  }
  const input = parsed.data;
  if (input.body.trim() === "") return failure("empty");

  let result: { data: unknown; error: { code?: string; hint?: string | null } | null };
  try {
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
  return { ok: true, routed: row.data.routed, jobId: row.data.job_id };
}
