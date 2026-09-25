import { z } from "zod";

import {
  CHAT_AUDIENCES,
  CHAT_AUTHOR_KINDS,
  CHAT_EVENT_TYPES,
  CHAT_VISIBILITY,
  JOB_MODES,
  type ChatEvent,
} from "./types";

/**
 * Collaboration chat: wire schemas and the row -> ChatEvent mapping (pure).
 * See docs/design/collaboration-chat.md. Every author field comes from the
 * database, where triggers derive it from trusted state; nothing here lets a
 * caller choose one.
 */

export const roomIdSchema = z.string().regex(/^tlrom_[0-9a-f]{32}$/);

/** Max events per page (contract section 7). */
export const CHAT_PAGE_SIZE = 200;
/** Owner posts: characters per message (the database checks it again). */
export const CHAT_MESSAGE_MAX_CHARS = 4000;
/** HTTP body cap for POST /api/dashboard/chat: 4000 chars of up to 4 bytes + envelope. */
export const CHAT_POST_MAX_BYTES = 20 * 1024;

const PROVIDERS = ["claude-code", "codex"] as const;

export const chatEventRowSchema = z.object({
  seq: z.coerce.number().int().min(1),
  id: z.string().regex(/^tlcev_[0-9a-f]{32}$/),
  owner_user_id: z.string(),
  created_at: z.string(),
  room_id: z.string().nullable(),
  agent_session_id: z.string(),
  job_id: z.string().nullable(),
  task_id: z.string().nullable(),
  node_id: z.string().nullable(),
  author_kind: z.enum(CHAT_AUTHOR_KINDS),
  author_provider: z.enum(PROVIDERS).nullable(),
  author_label: z.string().min(1).max(60),
  author_role: z.string().nullable(),
  audience: z.enum(CHAT_AUDIENCES).nullable(),
  event_type: z.enum(CHAT_EVENT_TYPES),
  message_type: z.string().nullable(),
  round: z.number().int().nullable(),
  model_requested: z.string().nullable(),
  model_observed: z.string().nullable(),
  body: z.string(),
  visibility: z.enum(CHAT_VISIBILITY),
});
export type ChatEventRow = z.infer<typeof chatEventRowSchema>;

/** Exactly the columns a ChatEvent needs (plus the owner, for the re-check). */
export const CHAT_EVENT_COLUMNS =
  "seq, id, owner_user_id, created_at, room_id, agent_session_id, job_id, task_id, node_id, " +
  "author_kind, author_provider, author_label, author_role, audience, event_type, message_type, " +
  "round, model_requested, model_observed, body, visibility";

export function toChatEvent(r: ChatEventRow): ChatEvent {
  return {
    seq: r.seq,
    id: r.id,
    createdAt: r.created_at,
    roomId: r.room_id,
    agentSessionId: r.agent_session_id,
    jobId: r.job_id,
    taskId: r.task_id,
    nodeId: r.node_id,
    authorKind: r.author_kind,
    // Defence in depth: a provider is only ever shown on an agent row.
    authorProvider: r.author_kind === "agent" ? r.author_provider : null,
    authorLabel: r.author_label,
    authorRole: r.author_role,
    audience: r.audience,
    eventType: r.event_type,
    messageType: r.message_type,
    round: r.round,
    modelRequested: r.model_requested,
    modelObserved: r.model_observed,
    body: r.body,
    visibility: r.visibility,
  };
}

/** GET /api/dashboard/chat?room=&after=&technical= */
export const chatQuerySchema = z
  .object({
    roomId: roomIdSchema,
    /** Omitted: the latest page. Given: everything after this seq (oldest first). */
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    technical: z.boolean().default(false),
  })
  .strict();
export type ChatQuery = z.input<typeof chatQuerySchema>;

/** Parses URL search params into a ChatQuery (strings -> typed), or null if malformed. */
export function parseChatSearchParams(params: URLSearchParams): ChatQuery | null {
  const after = params.get("after");
  const technical = params.get("technical");
  if (after !== null && !/^\d{1,15}$/.test(after)) return null;
  if (technical !== null && !["0", "1", "true", "false"].includes(technical)) return null;
  const parsed = chatQuerySchema.safeParse({
    roomId: params.get("room") ?? "",
    after: after === null ? undefined : Number(after),
    technical: technical === "1" || technical === "true",
  });
  return parsed.success ? parsed.data : null;
}

export const postChatMessageSchema = z
  .object({
    roomId: roomIdSchema,
    body: z.string().max(CHAT_MESSAGE_MAX_CHARS),
    // Hints only: the server parses the leading @mention and decides.
    mode: z.enum(JOB_MODES).optional(),
    builder: z.enum(PROVIDERS).optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
  })
  .strict();

export const postChatMessageRowSchema = z.object({
  routed: z.enum(["note_to_active_job", "stop_requested", "new_job"]),
  job_id: z.string().nullable(),
  event_id: z.string().optional(),
  replayed: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Human-safe failures. The database raises a stable reason code in the HINT;
// the message shown is chosen HERE. Database text is never passed through.
// ---------------------------------------------------------------------------
export const CHAT_ERROR_REASONS = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "room_inactive",
  "empty",
  "too_long",
  "invalid",
  "rate_limited",
  "idempotency_conflict",
  "nothing_to_stop",
  "agent_not_in_project",
  "route_missing",
  "link_paused",
  "runtime_outdated",
  "agents_unavailable",
  "conflict",
  "unavailable",
] as const;
export type ChatErrorReason = (typeof CHAT_ERROR_REASONS)[number];

export const CHAT_ERROR_MESSAGES: Record<ChatErrorReason, string> = {
  unauthenticated: "Sign in again to send messages.",
  forbidden: "You can't do that in this project.",
  not_found: "This project wasn't found.",
  room_inactive: "This project is archived. Restore it to send messages.",
  empty: "Type a message first.",
  too_long: `Messages can be at most ${CHAT_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters.`,
  invalid: "That message couldn't be sent. Check it and try again.",
  rate_limited: "You're sending messages quickly. Wait a moment and try again.",
  idempotency_conflict: "That message was already sent.",
  nothing_to_stop: "Nothing is running in this project, so there's nothing to stop.",
  agent_not_in_project: "That agent isn't part of this project.",
  route_missing:
    "This project's conversation isn't linked any more. Ask your controller to reconnect it.",
  link_paused: "This project's link is paused. Resume it to start new work.",
  runtime_outdated:
    "Update the ThreadLink app on the computer this project runs on to use this mode.",
  agents_unavailable:
    "Open the ThreadLink app and sign in to every agent this job needs, then try again.",
  conflict: "That can't be done right now.",
  unavailable: "ThreadLink couldn't send that message right now. Try again.",
};

export const CHAT_ERROR_STATUS: Record<ChatErrorReason, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  room_inactive: 409,
  empty: 400,
  too_long: 400,
  invalid: 400,
  rate_limited: 429,
  idempotency_conflict: 409,
  nothing_to_stop: 409,
  agent_not_in_project: 409,
  route_missing: 409,
  link_paused: 409,
  runtime_outdated: 409,
  agents_unavailable: 409,
  conflict: 409,
  unavailable: 503,
};

const HINT_REASONS: Record<string, ChatErrorReason> = {
  unauthenticated: "unauthenticated",
  room_inactive: "room_inactive",
  empty: "empty",
  too_long: "too_long",
  invalid: "invalid",
  invalid_mode: "invalid",
  invalid_builder: "invalid",
  invalid_goal: "invalid",
  rate_limited: "rate_limited",
  idempotency_conflict: "idempotency_conflict",
  nothing_to_stop: "nothing_to_stop",
  agent_not_in_project: "agent_not_in_project",
  route_missing: "route_missing",
  link_paused: "link_paused",
  runtime_outdated: "runtime_outdated",
  agents_unavailable: "agents_unavailable",
};

const CODE_REASONS: Record<string, ChatErrorReason> = {
  "28000": "unauthenticated",
  "42501": "forbidden",
  P0002: "not_found",
  "22023": "invalid",
  "23514": "invalid",
  "54000": "rate_limited",
  "55000": "conflict",
  "23505": "idempotency_conflict",
};

/** Maps a database error to a reason. Only the code and the hint are read. */
export function chatErrorReason(error: { code?: string; hint?: string | null }): ChatErrorReason {
  if (error.hint && Object.hasOwn(HINT_REASONS, error.hint)) return HINT_REASONS[error.hint];
  const code = error.code ?? "";
  return Object.hasOwn(CODE_REASONS, code) ? CODE_REASONS[code] : "unavailable";
}
