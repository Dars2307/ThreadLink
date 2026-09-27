import { z } from "zod";

import {
  CHAT_AUDIENCES,
  CHAT_AUTHOR_KINDS,
  CHAT_EVENT_TYPES,
  CHAT_VISIBILITY,
  JOB_MODES,
  REF_KINDS,
  type ChatAudience,
  type ChatEvent,
  type MessageDelivery,
} from "./types";

/**
 * Collaboration chat: wire schemas and the row -> ChatEvent mapping (pure).
 * See docs/design/collaboration-chat.md. Every author field comes from the
 * database, where triggers derive it from trusted state; nothing here lets a
 * caller choose one.
 */

export const roomIdSchema = z.string().regex(/^tlrom_[0-9a-f]{32}$/);
export const chatIdSchema = z.string().regex(/^tlcht_[0-9a-f]{32}$/);
export const groupIdSchema = z.string().regex(/^tlgrp_[0-9a-f]{32}$/);

/** Max events per page (contract section 7). */
export const CHAT_PAGE_SIZE = 200;
/** Owner posts: characters per message (the database checks it again). */
export const CHAT_MESSAGE_MAX_CHARS = 4000;
/** HTTP body cap for POST /api/dashboard/chat: 4000 chars of up to 4 bytes + envelope. */
export const CHAT_POST_MAX_BYTES = 20 * 1024;

const PROVIDERS = ["claude-code", "codex"] as const;
/** A registry provider id (public.agent_providers.id). */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export const chatEventRowSchema = z.object({
  seq: z.coerce.number().int().min(1),
  id: z.string().regex(/^tlcev_[0-9a-f]{32}$/),
  owner_user_id: z.string(),
  created_at: z.string(),
  room_id: z.string().nullable(),
  // Optional so a row from before chat-first still parses.
  chat_id: z.string().nullable().optional(),
  agent_session_id: z.string().nullable(),
  job_id: z.string().nullable(),
  task_id: z.string().nullable(),
  node_id: z.string().nullable(),
  author_kind: z.enum(CHAT_AUTHOR_KINDS),
  // 0.10: any registry provider (the database checks it against the registry).
  author_provider: z.string().regex(PROVIDER_ID_PATTERN).nullable(),
  author_label: z.string().min(1).max(60),
  author_role: z.string().nullable(),
  audience: z
    .string()
    .regex(/^(team|[a-z][a-z0-9-]{1,39})$/)
    .nullable(),
  event_type: z.enum(CHAT_EVENT_TYPES),
  message_type: z.string().nullable(),
  round: z.number().int().nullable(),
  model_requested: z.string().nullable(),
  model_observed: z.string().nullable(),
  body: z.string(),
  visibility: z.enum(CHAT_VISIBILITY),
  // 0.10 (optional so a row selected without them still parses).
  chat_seq: z.coerce.number().int().min(1).nullable().optional(),
  run_id: z.string().nullable().optional(),
  reply_to_event_id: z.string().nullable().optional(),
  ref_kind: z.enum(REF_KINDS).nullable().optional(),
  ref_id: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  queued_for: z.array(z.string()).nullable().optional(),
  consumed_by_run_id: z.string().nullable().optional(),
  delivered_at: z.string().nullable().optional(),
});
export type ChatEventRow = z.infer<typeof chatEventRowSchema>;

/** Exactly the columns a ChatEvent needs (plus the owner, for the re-check). */
export const CHAT_EVENT_COLUMNS =
  "seq, id, owner_user_id, created_at, room_id, chat_id, agent_session_id, job_id, task_id, node_id, " +
  "author_kind, author_provider, author_label, author_role, audience, event_type, message_type, " +
  "round, model_requested, model_observed, body, visibility";

/** 0.10: the same plus the cursor, provenance, replies, card payload and delivery. */
export const CHAT_EVENT_COLUMNS_V10 =
  CHAT_EVENT_COLUMNS +
  ", chat_seq, run_id, reply_to_event_id, ref_kind, ref_id, payload, queued_for, consumed_by_run_id, delivered_at";

const isLegacyProvider = (p: string | null): p is (typeof PROVIDERS)[number] =>
  p !== null && (PROVIDERS as readonly string[]).includes(p);
const isLegacyAudience = (a: string | null): a is ChatAudience =>
  a !== null && (CHAT_AUDIENCES as readonly string[]).includes(a);

/**
 * Where an owner note is (section 5), from the row and trusted context:
 * the job's state and the provider of the run that consumed it.
 *   sent          a request, a stop, or a note that needs no delivery
 *   queued        waiting for the addressed participants (job still running)
 *   seen          read by a run (by its provider), or delivered before 0.10
 *   not_delivered the job ended before anyone read it
 */
export function deliveryOf(
  r: Pick<ChatEventRow, "author_kind" | "event_type" | "job_id" | "audience"> & {
    queued_for?: string[] | null;
    consumed_by_run_id?: string | null;
    delivered_at?: string | null;
  },
  ctx: { jobFinished: boolean | null; consumedByProvider: string | null },
): MessageDelivery | null {
  if (r.author_kind !== "owner") return null;
  if (r.event_type !== "message" || r.job_id === null) return { state: "sent" };
  const queued = r.queued_for ?? null;
  if (!r.delivered_at) {
    if (ctx.jobFinished) return { state: "not_delivered" };
    return { state: "queued", for: queued ?? (r.audience ? [r.audience] : []) };
  }
  if (r.consumed_by_run_id) {
    return {
      state: "seen",
      by: ctx.consumedByProvider ? [ctx.consumedByProvider] : (queued ?? []),
    };
  }
  // Delivered without a queue: a stop request (never delivered as a note).
  return queued ? { state: "seen", by: queued } : { state: "sent" };
}

export function toChatEvent(r: ChatEventRow): ChatEvent {
  return {
    seq: r.seq,
    id: r.id,
    createdAt: r.created_at,
    roomId: r.room_id,
    chatId: r.chat_id ?? null,
    agentSessionId: r.agent_session_id,
    jobId: r.job_id,
    taskId: r.task_id,
    nodeId: r.node_id,
    authorKind: r.author_kind,
    // Defence in depth: a provider is only ever shown on an agent row. The
    // 0.9 field keeps its union; any other registry id is in authorProviderId.
    authorProvider:
      r.author_kind === "agent" && isLegacyProvider(r.author_provider) ? r.author_provider : null,
    authorLabel: r.author_label,
    authorRole: r.author_role,
    audience: isLegacyAudience(r.audience) ? r.audience : null,
    eventType: r.event_type,
    messageType: r.message_type,
    round: r.round,
    modelRequested: r.model_requested,
    modelObserved: r.model_observed,
    body: r.body,
    visibility: r.visibility,
    // 0.10 fields, only when the row was selected with them.
    ...(r.chat_seq !== undefined ? { chatSeq: r.chat_seq } : {}),
    ...(r.run_id !== undefined
      ? {
          runId: r.run_id,
          provenance: r.author_kind === "agent" ? (r.run_id ? "run" : "legacy") : null,
        }
      : {}),
    ...(r.reply_to_event_id !== undefined ? { replyTo: r.reply_to_event_id } : {}),
    ...(r.ref_kind !== undefined
      ? { ref: r.ref_kind && r.ref_id ? { kind: r.ref_kind, id: r.ref_id } : null }
      : {}),
    ...(r.payload !== undefined ? { payload: r.payload } : {}),
    ...(r.chat_seq !== undefined
      ? {
          authorProviderId: r.author_kind === "agent" ? r.author_provider : null,
          audienceId: r.audience,
        }
      : {}),
  };
}

/**
 * GET /api/dashboard/chat?room=&after=&technical=  (0.8, a project's timeline)
 * GET /api/dashboard/chat?chat=&after=&technical=  (0.9, one chat's timeline)
 * Exactly one of roomId / chatId.
 */
export const chatQuerySchema = z
  .object({
    roomId: roomIdSchema.optional(),
    chatId: chatIdSchema.optional(),
    /** Omitted: the latest page. Given: everything after this seq (oldest first). */
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    technical: z.boolean().default(false),
  })
  .strict()
  .refine((q) => (q.roomId === undefined) !== (q.chatId === undefined), "exactly one scope");
export type ChatQuery = z.input<typeof chatQuerySchema>;

/** Parses URL search params into a ChatQuery (strings -> typed), or null if malformed. */
export function parseChatSearchParams(params: URLSearchParams): ChatQuery | null {
  const after = params.get("after");
  const technical = params.get("technical");
  if (after !== null && !/^\d{1,15}$/.test(after)) return null;
  if (technical !== null && !["0", "1", "true", "false"].includes(technical)) return null;
  const room = params.get("room");
  const chat = params.get("chat");
  const parsed = chatQuerySchema.safeParse({
    ...(chat === null ? { roomId: room ?? "" } : { chatId: chat }),
    ...(room !== null && chat !== null ? { roomId: room } : {}),
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

/** 0.9: a post keyed by chat. No mode/builder: the chat's mode and a leading @mention decide. */
export const postChatByChatSchema = z
  .object({
    chatId: chatIdSchema,
    body: z.string().max(CHAT_MESSAGE_MAX_CHARS),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
  })
  .strict();

export const postChatMessageRowSchema = z.object({
  routed: z.enum(["note_to_active_job", "stop_requested", "new_job", "provider_blocked"]),
  job_id: z.string().nullable(),
  event_id: z.string().optional(),
  chat_id: z.string().optional(),
  replayed: z.boolean().optional(),
  health: z.unknown().optional(),
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
  // 0.9 chat-first
  "needs_project",
  "provider_unhealthy",
  "job_active",
  "name_taken",
  "limit_reached",
  "not_retryable",
  "invalid_name",
  "invalid_pair",
  "invalid_roles",
  "chat_not_found",
  "group_not_found",
  "project_not_found",
  "job_not_found",
  "project_changed",
  // 0.10
  "choice_not_found",
  "choice_closed",
  "choice_expired",
  "invalid_choice",
  "invalid_control",
  "job_finished",
  "nothing_to_resume",
  "run_not_found",
  "artifact_not_found",
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
  needs_project: "Choose a project for this chat so the agents know which folder to work in.",
  provider_unhealthy:
    "An agent this work needs isn't ready. Open the ThreadLink app on this computer to check.",
  job_active: "Work is still running in this chat. Stop it first, then try again.",
  name_taken: "A group with this name already exists.",
  limit_reached:
    "You've reached the limit for this. Delete some you no longer need, then try again.",
  not_retryable: "Only work that was blocked before it had a plan can be retried this way.",
  invalid_name: "Use a shorter name on one line.",
  invalid_pair: "An agent can't review its own work. Choose two different agents.",
  invalid_roles: "That agent can't take that role for this work.",
  chat_not_found: "This chat wasn't found.",
  group_not_found: "This group wasn't found.",
  project_not_found: "This project wasn't found.",
  job_not_found: "This work wasn't found.",
  project_changed: "This chat now belongs to another project; start a new request instead.",
  choice_not_found: "This question wasn't found.",
  choice_closed: "This question has already been answered or closed.",
  choice_expired: "This question expired: nobody answered it within 24 hours.",
  invalid_choice: "That isn't one of the options.",
  invalid_control: "That isn't a control ThreadLink knows.",
  job_finished: "This work has already finished.",
  nothing_to_resume: "Nothing is paused or interrupted here, so there's nothing to resume.",
  run_not_found: "This agent run wasn't found.",
  artifact_not_found: "This file wasn't found.",
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
  needs_project: 409,
  provider_unhealthy: 409,
  job_active: 409,
  name_taken: 409,
  limit_reached: 409,
  not_retryable: 409,
  invalid_name: 400,
  invalid_pair: 400,
  invalid_roles: 400,
  chat_not_found: 404,
  group_not_found: 404,
  project_not_found: 404,
  job_not_found: 404,
  project_changed: 409,
  choice_not_found: 404,
  choice_closed: 409,
  choice_expired: 409,
  invalid_choice: 400,
  invalid_control: 400,
  job_finished: 409,
  nothing_to_resume: 409,
  run_not_found: 404,
  artifact_not_found: 404,
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
  conflict: "conflict",
  needs_project: "needs_project",
  provider_unhealthy: "provider_unhealthy",
  job_active: "job_active",
  name_taken: "name_taken",
  limit_reached: "limit_reached",
  not_retryable: "not_retryable",
  invalid_name: "invalid_name",
  invalid_pair: "invalid_pair",
  invalid_roles: "invalid_roles",
  chat_not_found: "chat_not_found",
  group_not_found: "group_not_found",
  project_not_found: "project_not_found",
  job_not_found: "job_not_found",
  project_changed: "project_changed",
  // 0.10
  choice_not_found: "choice_not_found",
  choice_closed: "choice_closed",
  choice_expired: "choice_expired",
  invalid_choice: "invalid_choice",
  invalid_control: "invalid_control",
  job_finished: "job_finished",
  nothing_to_resume: "nothing_to_resume",
  run_not_found: "run_not_found",
  artifact_not_found: "artifact_not_found",
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
