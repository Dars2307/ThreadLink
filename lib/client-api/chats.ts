import { z } from "zod";

import { CHAT_ERROR_MESSAGES, type ChatErrorReason } from "@/lib/chat/model";
import type { MessageDelivery } from "@/lib/chat/types";
import {
  healthMessage,
  parseHealthDetail,
  PROVIDER_HEALTH,
  type ProviderHealthEntry,
} from "@/lib/providers/health";
import { teamStatusRowSchema, toTeamStatus, type TeamStatus } from "@/lib/team/model";

import { ClientOperationError, type ClientDatabase, type ClientErrorKind } from "./operations";

/**
 * The credential-authenticated chat API (docs/design/threadlink-0.10.md §9).
 *
 * Runtime (agent credential): the desktop app and the terminal read the
 * owner's chats and post AS THE OWNER (client desktop|terminal recorded).
 * Controller (MCP): the chats reachable through the calling session's own
 * active links; a post is the controller's request.
 *
 * The database resolves the owner from the credential and re-applies every
 * owner rule; these functions only bound input shapes and map rows to the
 * friendly wire shapes. Cursors are PER CHAT; the global seq never leaves the
 * database. Failures become ChatApiError with a stable reason and a fixed,
 * human-safe sentence chosen here (database text is never passed through).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CHAT_API_REASONS = [
  "unauthenticated",
  "forbidden",
  "runtime_paused",
  "runtime_required",
  "review_required",
  "chat_not_found",
  "project_not_found",
  "job_not_found",
  "needs_project",
  "provider_unhealthy",
  "job_active",
  "nothing_to_stop",
  "agent_not_in_project",
  "route_missing",
  "link_paused",
  "runtime_outdated",
  "room_inactive",
  "idempotency_conflict",
  "empty",
  "too_long",
  "too_large",
  "invalid",
  "invalid_name",
  "rate_limited",
  "limit_reached",
  "conflict",
  "unavailable",
  // 0.10 security review I1: posting or starting work from another computer.
  "other_computer",
] as const;
export type ChatApiReason = (typeof CHAT_API_REASONS)[number];

const OWN_MESSAGES: Partial<Record<ChatApiReason, string>> = {
  unauthenticated:
    "This device isn't signed in to ThreadLink any more. Reconnect it in the ThreadLink app.",
  forbidden: "This ThreadLink connection can't do that.",
  runtime_paused:
    "ThreadLink is paused on this computer. Resume it in the ThreadLink app to use chats.",
  runtime_required:
    "This computer isn't set up as a ThreadLink computer yet. Open the ThreadLink app to finish setup.",
  review_required:
    "This project requires review, so a single agent can't work alone here. Use Builder + Reviewer or Team.",
  too_large: "That request is too large.",
  invalid: "That request isn't valid. Check it and try again.",
  unavailable: "ThreadLink couldn't do that right now. Try again.",
  other_computer: "This chat runs on another computer. Send from that computer or from the web.",
};

export function chatApiMessage(reason: ChatApiReason): string {
  return (
    OWN_MESSAGES[reason] ??
    CHAT_ERROR_MESSAGES[reason as ChatErrorReason] ??
    CHAT_ERROR_MESSAGES.unavailable
  );
}

export const CHAT_API_STATUS: Record<ChatApiReason, number> = {
  unauthenticated: 401,
  forbidden: 403,
  runtime_paused: 403,
  runtime_required: 403,
  review_required: 403,
  chat_not_found: 404,
  project_not_found: 404,
  job_not_found: 404,
  needs_project: 409,
  provider_unhealthy: 409,
  job_active: 409,
  nothing_to_stop: 409,
  agent_not_in_project: 409,
  route_missing: 409,
  link_paused: 409,
  runtime_outdated: 409,
  room_inactive: 409,
  idempotency_conflict: 409,
  empty: 400,
  too_long: 400,
  too_large: 413,
  invalid: 400,
  invalid_name: 400,
  rate_limited: 429,
  limit_reached: 409,
  conflict: 409,
  unavailable: 503,
  other_computer: 409,
};

const KIND_OF: Record<number, ClientErrorKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  400: "invalid",
  413: "too_large",
  429: "limit",
  503: "unavailable",
};

/** A refusal: a stable reason, its fixed sentence, and (health gate) who is not ready. */
export class ChatApiError extends ClientOperationError {
  readonly reason: ChatApiReason;
  readonly health: ProviderHealthEntry[] | undefined;
  readonly userMessage: string;
  constructor(reason: ChatApiReason, health?: ProviderHealthEntry[], hostLabel?: string) {
    super(KIND_OF[CHAT_API_STATUS[reason]] ?? "unavailable");
    this.name = "ChatApiError";
    this.reason = reason;
    this.health = health && health.length > 0 ? health : undefined;
    this.userMessage =
      reason === "provider_unhealthy" && this.health
        ? healthMessage(this.health)
        : reason === "other_computer" && hostLabel
          ? `This chat runs on ${hostLabel}. Send from that computer or from the web.`
          : chatApiMessage(reason);
  }
}

const HINTS: Record<string, ChatApiReason> = {
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  runtime_paused: "runtime_paused",
  runtime_required: "runtime_required",
  review_required: "review_required",
  chat_not_found: "chat_not_found",
  project_not_found: "project_not_found",
  job_not_found: "job_not_found",
  needs_project: "needs_project",
  provider_unhealthy: "provider_unhealthy",
  job_active: "job_active",
  nothing_to_stop: "nothing_to_stop",
  agent_not_in_project: "agent_not_in_project",
  route_missing: "route_missing",
  link_paused: "link_paused",
  runtime_outdated: "runtime_outdated",
  room_inactive: "room_inactive",
  idempotency_conflict: "idempotency_conflict",
  empty: "empty",
  too_long: "too_long",
  invalid: "invalid",
  invalid_mode: "invalid",
  invalid_builder: "invalid",
  invalid_goal: "invalid",
  invalid_roles: "invalid",
  invalid_name: "invalid_name",
  rate_limited: "rate_limited",
  limit_reached: "limit_reached",
  conflict: "conflict",
  other_computer: "other_computer",
};

const CODES: Record<string, ChatApiReason> = {
  "28000": "unauthenticated",
  "42501": "forbidden",
  P0002: "chat_not_found",
  "22023": "invalid",
  "23514": "invalid",
  "23502": "invalid",
  "54000": "rate_limited",
  "55000": "conflict",
  "23505": "idempotency_conflict",
};

type RpcError = { message?: string; code?: string; hint?: string | null; details?: string | null };

/** other_computer: the other computer's label (the owner's own text), plain and bounded. */
function hostLabelOf(detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  const v = detail
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  return v.length > 0 && v.length <= 100 ? v : undefined;
}

/** Only the code, the hint and (health gate / other computer) the detail are read. */
export function chatApiErrorFrom(error: RpcError): ChatApiError {
  const reason =
    (error.hint && Object.hasOwn(HINTS, error.hint) ? HINTS[error.hint] : undefined) ??
    (Object.hasOwn(CODES, error.code ?? "") ? CODES[error.code ?? ""] : "unavailable");
  return new ChatApiError(
    reason,
    reason === "provider_unhealthy" ? (parseHealthDetail(error.details) ?? undefined) : undefined,
    reason === "other_computer" ? hostLabelOf(error.details) : undefined,
  );
}

async function rpc<T>(
  db: ClientDatabase,
  fn: string,
  args: Record<string, unknown>,
  parse: z.ZodType<T>,
): Promise<T> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = (await db.rpc(fn, args)) as { data: unknown; error: RpcError | null };
  } catch {
    throw new ChatApiError("unavailable");
  }
  if (result.error) throw chatApiErrorFrom(result.error);
  const parsed = parse.safeParse(result.data);
  if (!parsed.success) throw new ChatApiError("unavailable");
  return parsed.data;
}

function valid<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some(
      (i) => i.code === "too_big" && "origin" in i && i.origin === "string" && i.path[0] === "body",
    );
    throw new ChatApiError(tooLong ? "too_long" : "invalid");
  }
  return parsed.data;
}

/** A malformed chat / job id reads exactly like a missing one. */
function validId(schema: z.ZodTypeAny, value: unknown, reason: ChatApiReason): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ChatApiError(reason);
  return parsed.data as string;
}

// ---------------------------------------------------------------------------
// Input bounds
// ---------------------------------------------------------------------------
export const chatIdSchema = z.string().regex(/^tlcht_[0-9a-f]{32}$/);
export const roomIdSchema = z.string().regex(/^tlrom_[0-9a-f]{32}$/);
export const jobIdSchema = z.string().regex(/^tljob_[0-9a-f]{32}$/);
const sessionIdSchema = z.string().regex(/^tlses_[0-9a-f]{32}$/);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const modeSchema = z.enum(["solo", "pair", "team"]);
const cursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Characters per message (the database checks it again). */
export const CHAT_API_MESSAGE_MAX_CHARS = 4000;
/** HTTP body caps. A message: 4000 chars of up to 4 bytes + the envelope. */
export const CHAT_API_POST_MAX_BYTES = 20 * 1024;
export const CHAT_API_ACTION_MAX_BYTES = 4 * 1024;
export const CHAT_API_READ_MAX_BYTES = 256;
export const CHAT_API_PAGE_MAX = 200;
export const CHAT_CLIENTS = ["desktop", "terminal"] as const;
export type ChatClient = (typeof CHAT_CLIENTS)[number];

// ---------------------------------------------------------------------------
// Rows -> friendly wire shapes
// ---------------------------------------------------------------------------
const healthSchema = z.enum(PROVIDER_HEALTH);
const participantRow = z.object({
  kind: z.enum(["owner", "controller", "agent"]),
  provider: z.string().nullable(),
  name: z.string(),
  short_name: z.string(),
  health: healthSchema.nullable(),
});
const activeJobRow = z
  .object({ job_id: jobIdSchema, mode: modeSchema, status: z.string() })
  .nullable();
const summaryRow = z.object({
  chat_id: chatIdSchema,
  name: z.string(),
  mode: modeSchema,
  settings: z.object({
    mode: modeSchema,
    solo_provider: z.string().nullable(),
    builder_provider: z.string().nullable(),
    reviewer_provider: z.string().nullable(),
  }),
  project: z
    .object({
      project_id: roomIdSchema,
      name: z.string(),
      status: z.string(),
      runs_on: z.string().nullable(),
      runtime_online: z.boolean(),
      this_computer: z.boolean(),
    })
    .nullable(),
  group_name: z.string().nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  is_room_default: z.boolean(),
  last_activity_at: z.string(),
  last_message: z.string().nullable(),
  unread: z.boolean(),
  unread_count: z.coerce.number().int().min(0).optional(),
  last_read_cursor: z.coerce.number().int().min(0),
  needs_attention: z.boolean(),
  active_job: activeJobRow,
  participants: z.array(participantRow),
});

export type ChatApiParticipant = {
  kind: "owner" | "controller" | "agent";
  provider: string | null;
  name: string;
  shortName: string;
  health: z.infer<typeof healthSchema> | null;
};
export type ChatApiActiveJob = { jobId: string; mode: "solo" | "pair" | "team"; status: string };

/** One chat, as the desktop app / terminal / controller sees it. Ids are opaque handles. */
export type ChatApiSummary = {
  chatId: string;
  name: string;
  mode: "solo" | "pair" | "team";
  settings: {
    mode: "solo" | "pair" | "team";
    soloProvider: string | null;
    builderProvider: string | null;
    reviewerProvider: string | null;
  };
  /** The project (execution route); null when the chat has none yet. */
  roomId: string | null;
  projectName: string | null;
  /** The computer the project runs on ("Runs on <label>"), and whether it is online. */
  runtimeLabel: string | null;
  runtimeOnline: boolean | null;
  /** Runtime API only: the project runs on the calling computer. */
  thisComputer: boolean | null;
  groupName: string | null;
  pinned: boolean;
  archived: boolean;
  isRoomDefault: boolean;
  lastActivityAt: string;
  lastMessage: string | null;
  unread: boolean;
  /** Unread rows under the 0.10 rules (agents, controllers, important ThreadLink rows), at most 100. */
  unreadCount: number;
  /** The per-chat cursor the owner has read up to. */
  lastReadCursor: number;
  needsAttention: boolean;
  activeJob: ChatApiActiveJob | null;
  participants: ChatApiParticipant[];
};

const toActiveJob = (j: z.infer<typeof activeJobRow>): ChatApiActiveJob | null =>
  j ? { jobId: j.job_id, mode: j.mode, status: j.status } : null;

function toSummary(r: z.infer<typeof summaryRow>): ChatApiSummary {
  return {
    chatId: r.chat_id,
    name: r.name,
    mode: r.mode,
    settings: {
      mode: r.settings.mode,
      soloProvider: r.settings.solo_provider,
      builderProvider: r.settings.builder_provider,
      reviewerProvider: r.settings.reviewer_provider,
    },
    roomId: r.project?.project_id ?? null,
    projectName: r.project?.name ?? null,
    runtimeLabel: r.project?.runs_on ?? null,
    runtimeOnline: r.project ? r.project.runtime_online : null,
    thisComputer: r.project ? r.project.this_computer : null,
    groupName: r.group_name,
    pinned: r.pinned,
    archived: r.archived,
    isRoomDefault: r.is_room_default,
    lastActivityAt: r.last_activity_at,
    lastMessage: r.last_message,
    unread: r.unread,
    unreadCount: r.unread_count ?? (r.unread ? 1 : 0),
    lastReadCursor: r.last_read_cursor,
    needsAttention: r.needs_attention,
    activeJob: toActiveJob(r.active_job),
    participants: r.participants.map((p) => ({
      kind: p.kind,
      provider: p.kind === "agent" ? p.provider : null,
      name: p.name,
      shortName: p.short_name,
      health: p.health,
    })),
  };
}

const deliverySchema = z.union([
  z.object({ state: z.literal("sent") }),
  z.object({ state: z.literal("queued"), for: z.array(z.string()) }),
  z.object({ state: z.literal("seen"), by: z.array(z.string()) }),
  z.object({ state: z.literal("not_delivered") }),
]);

const eventRow = z.object({
  id: z.string().regex(/^tlcev_[0-9a-f]{32}$/),
  cursor: z.coerce.number().int().min(1),
  created_at: z.string(),
  author_kind: z.enum(["controller", "owner", "threadlink", "agent"]),
  author_label: z.string(),
  author_provider: z.string().nullable(),
  author_role: z.string().nullable(),
  audience: z.string().nullable(),
  event_type: z.string(),
  message_type: z.string().nullable(),
  round: z.number().int().nullable(),
  model_requested: z.string().nullable(),
  model_observed: z.string().nullable(),
  body: z.string(),
  visibility: z.enum(["visible", "technical"]),
  job_id: z.string().nullable(),
  run_id: z.string().nullable().optional(),
  reply_to_event_id: z.string().nullable().optional(),
  ref_kind: z.string().nullable().optional(),
  ref_id: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  delivery: deliverySchema.nullable().optional(),
  client: z.enum(["web", "desktop", "terminal"]).nullable(),
});

/** One timeline row. `cursor` is this chat's own sequence (1, 2, 3...), never the global one. */
export type ChatApiEvent = {
  id: string;
  cursor: number;
  createdAt: string;
  authorKind: "controller" | "owner" | "threadlink" | "agent";
  authorLabel: string;
  /** Agent rows only. */
  authorProvider: string | null;
  authorRole: string | null;
  audience: string | null;
  eventType: string;
  messageType: string | null;
  round: number | null;
  modelRequested: string | null;
  modelObserved: string | null;
  /** Plain text, redacted before storage. Never render as HTML. */
  body: string;
  visibility: "visible" | "technical";
  jobId: string | null;
  /** The agent run this row is tied to (Details / provenance), or null. */
  runId: string | null;
  /** The row this one answers, and what it refers to (finding, decision, node, artifact, message, choice). */
  replyToEventId: string | null;
  ref: { kind: string; id: string } | null;
  /** Structured card data for code_change, finding, decision_card, choice, job_summary, ... */
  payload: Record<string, unknown> | null;
  /** Owner notes to a running job: sent -> queued (for) -> seen (by) | not_delivered. */
  delivery: MessageDelivery | null;
  /** Owner posts only: which client sent it (null = the web, or before 0.10). */
  client: "web" | "desktop" | "terminal" | null;
};

function toEvent(r: z.infer<typeof eventRow>): ChatApiEvent {
  return {
    id: r.id,
    cursor: r.cursor,
    createdAt: r.created_at,
    authorKind: r.author_kind,
    authorLabel: r.author_label,
    authorProvider: r.author_kind === "agent" ? r.author_provider : null,
    authorRole: r.author_role,
    audience: r.audience,
    eventType: r.event_type,
    messageType: r.message_type,
    round: r.round,
    modelRequested: r.model_requested,
    modelObserved: r.model_observed,
    body: r.body,
    visibility: r.visibility,
    jobId: r.job_id,
    runId: r.run_id ?? null,
    replyToEventId: r.reply_to_event_id ?? null,
    ref: r.ref_kind && r.ref_id ? { kind: r.ref_kind, id: r.ref_id } : null,
    payload: r.payload ?? null,
    delivery: r.author_kind === "owner" ? (r.delivery ?? null) : null,
    client: r.author_kind === "owner" ? r.client : null,
  };
}

const pageRow = z.object({
  events: z.array(eventRow),
  cursor: z.coerce.number().int().min(0),
  oldest_cursor: z.coerce.number().int().min(1).nullable(),
  has_more: z.boolean(),
});

export type ChatApiPage = {
  events: ChatApiEvent[];
  /** Poll with after=<cursor>. */
  cursor: number;
  /** Scroll back with before=<oldestCursor>. Null on an empty page. */
  oldestCursor: number | null;
  /** More rows in the direction of travel (older for the latest page / before; newer for after). */
  hasMore: boolean;
};

const toPage = (p: z.infer<typeof pageRow>): ChatApiPage => ({
  events: p.events.map(toEvent),
  cursor: p.cursor,
  oldestCursor: p.oldest_cursor,
  hasMore: p.has_more,
});

const projectRow = z.object({
  project_id: roomIdSchema,
  name: z.string(),
  runs_on: z.string().nullable().optional(),
  this_computer: z.boolean().optional(),
});
export type ChatApiProject = {
  roomId: string;
  name: string;
  runtimeLabel: string | null;
  thisComputer: boolean | null;
};
const toProject = (p: z.infer<typeof projectRow>): ChatApiProject => ({
  roomId: p.project_id,
  name: p.name,
  runtimeLabel: p.runs_on ?? null,
  thisComputer: p.this_computer ?? null,
});

const postRow = z.object({
  routed: z.enum(["note_to_active_job", "stop_requested", "new_job", "provider_blocked"]),
  job_id: z.string().nullable(),
  event_id: z
    .string()
    .regex(/^tlcev_[0-9a-f]{32}$/)
    .optional(),
  chat_id: z.string().optional(),
  replayed: z.boolean().optional(),
  health: z.unknown().optional(),
});

export type ChatApiPostResult =
  | {
      ok: true;
      routed: "note_to_active_job" | "stop_requested" | "new_job";
      jobId: string | null;
      eventId: string | null;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: "provider_unhealthy";
      message: string;
      health: ProviderHealthEntry[];
      /** The message and a ThreadLink row naming who is not ready ARE in the chat; no work started. */
      stored: true;
      eventId: string | null;
    };

// ---------------------------------------------------------------------------
// Runtime (agent credential): the owner's chats from the desktop / terminal
// ---------------------------------------------------------------------------
const listOptions = z
  .object({
    includeArchived: z.boolean().optional(),
    search: z.string().max(100).optional(),
  })
  .strict();

const liveRow = z.object({
  run_id: z.string(),
  provider: z.string(),
  provider_name: z.string(),
  role: z.string(),
  activity: z.string().nullable(),
  started_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
});
/** A run that is working but has not produced its message yet (lib/chat/types LiveActivity). */
export type ChatApiLiveActivity = {
  runId: string;
  provider: string;
  providerName: string;
  role: string;
  activity: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
};
const toLive = (r: z.infer<typeof liveRow>): ChatApiLiveActivity => ({
  runId: r.run_id,
  provider: r.provider,
  providerName: r.provider_name,
  role: r.role,
  activity: r.activity,
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
});

const runtimeRow = z.object({
  label: z.string(),
  online: z.boolean(),
  version: z.string().nullable(),
  protocol: z.coerce.number().int(),
  min_protocol: z.coerce.number().int(),
  current_protocol: z.coerce.number().int(),
  update_required: z.boolean(),
});
/** The calling computer: presence, version, and whether it must update for 0.10 features. */
export type ChatApiRuntime = {
  label: string;
  online: boolean;
  version: string | null;
  protocol: number;
  minProtocol: number;
  currentProtocol: number;
  updateRequired: boolean;
};

export async function listRuntimeChats(
  db: ClientDatabase,
  hash: string,
  rawOptions: unknown = {},
): Promise<{ chats: ChatApiSummary[]; projects: ChatApiProject[]; runtime: ChatApiRuntime }> {
  const o = valid(listOptions, rawOptions);
  const r = await rpc(
    db,
    "runtime_list_chats",
    {
      p_token_hash: hash,
      p_include_archived: o.includeArchived ?? false,
      p_search: o.search?.trim() ? o.search.trim() : null,
    },
    z.object({ chats: z.array(summaryRow), projects: z.array(projectRow), runtime: runtimeRow }),
  );
  return {
    chats: r.chats.map(toSummary),
    projects: r.projects.map(toProject),
    runtime: {
      label: r.runtime.label,
      online: r.runtime.online,
      version: r.runtime.version,
      protocol: r.runtime.protocol,
      minProtocol: r.runtime.min_protocol,
      currentProtocol: r.runtime.current_protocol,
      updateRequired: r.runtime.update_required,
    },
  };
}

export async function getRuntimeChat(
  db: ClientDatabase,
  hash: string,
  rawChatId: unknown,
): Promise<ChatApiSummary & { activity: ChatApiLiveActivity[] }> {
  const chatId = validId(chatIdSchema, rawChatId, "chat_not_found");
  const r = await rpc(
    db,
    "runtime_get_chat",
    { p_token_hash: hash, p_chat_id: chatId },
    summaryRow.extend({ activity: z.array(liveRow) }),
  );
  return { ...toSummary(r), activity: r.activity.map(toLive) };
}

export const eventsQuerySchema = z
  .object({
    after: cursorSchema.optional(),
    before: cursorSchema.optional(),
    limit: z.number().int().min(1).max(CHAT_API_PAGE_MAX).optional(),
    technical: z.boolean().optional(),
  })
  .strict()
  .refine((q) => q.after === undefined || q.before === undefined, "after or before");

/** Parses ?after=&before=&limit=&technical= (strings), or null when malformed. */
export function parseEventsQuery(
  params: URLSearchParams,
): z.infer<typeof eventsQuerySchema> | null {
  const num = (k: string): number | undefined | null => {
    const v = params.get(k);
    if (v === null) return undefined;
    return /^\d{1,15}$/.test(v) ? Number(v) : null;
  };
  const after = num("after");
  const before = num("before");
  const limit = num("limit");
  const technical = params.get("technical");
  if (after === null || before === null || limit === null) return null;
  if (technical !== null && !["0", "1", "true", "false"].includes(technical)) return null;
  const parsed = eventsQuerySchema.safeParse({
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    technical: technical === "1" || technical === "true",
  });
  return parsed.success ? parsed.data : null;
}

export async function runtimeChatEvents(
  db: ClientDatabase,
  hash: string,
  rawChatId: unknown,
  rawQuery: unknown,
): Promise<
  ChatApiPage & {
    chatId: string;
    activeJob: ChatApiActiveJob | null;
    activity: ChatApiLiveActivity[];
    deliveries: { cursor: number; delivery: MessageDelivery }[];
  }
> {
  const chatId = validId(chatIdSchema, rawChatId, "chat_not_found");
  const q = valid(eventsQuerySchema, rawQuery);
  const r = await rpc(
    db,
    "runtime_chat_events",
    {
      p_token_hash: hash,
      p_chat_id: chatId,
      p_after: q.after ?? null,
      p_before: q.before ?? null,
      p_limit: q.limit ?? null,
      p_technical: q.technical ?? false,
    },
    pageRow.extend({
      chat_id: chatIdSchema,
      active_job: activeJobRow,
      activity: z.array(liveRow),
      deliveries: z.array(
        z.object({ cursor: z.coerce.number().int().min(1), delivery: deliverySchema }),
      ),
    }),
  );
  return {
    chatId: r.chat_id,
    ...toPage(r),
    activeJob: toActiveJob(r.active_job),
    activity: r.activity.map(toLive),
    deliveries: r.deliveries,
  };
}

export const createChatInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    roomId: roomIdSchema.nullish(),
    mode: modeSchema.nullish(),
  })
  .strict();

export async function createRuntimeChat(
  db: ClientDatabase,
  hash: string,
  rawInput: unknown,
): Promise<ChatApiSummary> {
  const i = valid(createChatInputSchema, rawInput);
  return toSummary(
    await rpc(
      db,
      "runtime_create_chat",
      { p_token_hash: hash, p_name: i.name, p_room_id: i.roomId ?? null, p_mode: i.mode ?? null },
      summaryRow,
    ),
  );
}

export const postMessageInputSchema = z
  .object({
    body: z.string().max(CHAT_API_MESSAGE_MAX_CHARS),
    idempotencyKey: idempotencyKeySchema.optional(),
    client: z.enum(CHAT_CLIENTS).optional(),
  })
  .strict();

/**
 * The owner's composer from this computer. `client` comes from the request
 * (header or body, validated to desktop|terminal); author, routing, limits and
 * the health gate are the database's.
 */
export async function postRuntimeChatMessage(
  db: ClientDatabase,
  hash: string,
  rawChatId: unknown,
  rawInput: unknown,
  client: ChatClient,
): Promise<ChatApiPostResult> {
  const chatId = validId(chatIdSchema, rawChatId, "chat_not_found");
  const i = valid(postMessageInputSchema, rawInput);
  if (!(CHAT_CLIENTS as readonly string[]).includes(client)) throw new ChatApiError("invalid");
  if (i.body.trim() === "") throw new ChatApiError("empty");
  const r = await rpc(
    db,
    "runtime_post_chat_message",
    {
      p_token_hash: hash,
      p_chat_id: chatId,
      p_body: i.body,
      p_idempotency_key: i.idempotencyKey ?? null,
      p_client: client,
    },
    postRow,
  );
  if (r.routed === "provider_blocked") {
    const health = z
      .array(z.object({ provider: z.string(), health: healthSchema }))
      .safeParse(r.health);
    const entries = health.success ? health.data : [];
    return {
      ok: false,
      reason: "provider_unhealthy",
      message: new ChatApiError("provider_unhealthy", entries).userMessage,
      health: entries,
      stored: true,
      eventId: r.event_id ?? null,
    };
  }
  return {
    ok: true,
    routed: r.routed,
    jobId: r.job_id,
    eventId: r.event_id ?? null,
    replayed: r.replayed === true,
  };
}

export const markReadInputSchema = z.object({ cursor: cursorSchema }).strict();

export async function markRuntimeChatRead(
  db: ClientDatabase,
  hash: string,
  rawChatId: unknown,
  rawInput: unknown,
): Promise<{ lastReadCursor: number }> {
  const chatId = validId(chatIdSchema, rawChatId, "chat_not_found");
  const i = valid(markReadInputSchema, rawInput);
  const r = await rpc(
    db,
    "runtime_mark_chat_read",
    { p_token_hash: hash, p_chat_id: chatId, p_cursor: i.cursor },
    z.object({ last_read_cursor: z.coerce.number().int().min(0) }),
  );
  return { lastReadCursor: r.last_read_cursor };
}

// ---------------------------------------------------------------------------
// Controller (MCP): chats reachable through the session's own active links
// ---------------------------------------------------------------------------
const controllerListRow = z.object({
  chats: z.array(
    z.object({
      chat_id: chatIdSchema,
      name: z.string(),
      mode: modeSchema,
      project_name: z.string(),
      is_room_default: z.boolean(),
      last_activity_at: z.string(),
      active_job: activeJobRow,
    }),
  ),
  projects: z.array(projectRow),
});

export type ControllerChatListItem = {
  chatId: string;
  name: string;
  mode: "solo" | "pair" | "team";
  projectName: string;
  isRoomDefault: boolean;
  lastActivityAt: string;
  activeJob: ChatApiActiveJob | null;
};

export async function listControllerChats(
  db: ClientDatabase,
  hash: string,
  rawSessionId: unknown,
): Promise<{ chats: ControllerChatListItem[]; projects: ChatApiProject[] }> {
  const sessionId = valid(sessionIdSchema, rawSessionId);
  const r = await rpc(
    db,
    "controller_list_chats",
    { p_token_hash: hash, p_session_id: sessionId },
    controllerListRow,
  );
  return {
    chats: r.chats.map((c) => ({
      chatId: c.chat_id,
      name: c.name,
      mode: c.mode,
      projectName: c.project_name,
      isRoomDefault: c.is_room_default,
      lastActivityAt: c.last_activity_at,
      activeJob: toActiveJob(c.active_job),
    })),
    projects: r.projects.map(toProject),
  };
}

export async function getControllerChat(
  db: ClientDatabase,
  hash: string,
  input: { sessionId: unknown; chatId: unknown; after?: unknown; limit?: unknown },
): Promise<{ chat: ChatApiSummary; messages: ChatApiPage }> {
  const sessionId = valid(sessionIdSchema, input.sessionId);
  const chatId = validId(chatIdSchema, input.chatId, "chat_not_found");
  const after = input.after === undefined ? null : valid(cursorSchema, input.after);
  const limit =
    input.limit === undefined ? null : valid(z.number().int().min(1).max(50), input.limit);
  const r = await rpc(
    db,
    "controller_get_chat",
    {
      p_token_hash: hash,
      p_session_id: sessionId,
      p_chat_id: chatId,
      p_after: after,
      p_limit: limit,
    },
    z.object({ chat: summaryRow, messages: pageRow }),
  );
  return { chat: toSummary(r.chat), messages: toPage(r.messages) };
}

export async function createControllerChat(
  db: ClientDatabase,
  hash: string,
  input: { sessionId: unknown; roomId: unknown; name: unknown; mode?: unknown },
): Promise<ChatApiSummary> {
  const sessionId = valid(sessionIdSchema, input.sessionId);
  const roomId = valid(roomIdSchema, input.roomId);
  const name = valid(z.string().trim().min(1).max(100), input.name);
  const mode =
    input.mode === undefined || input.mode === null ? null : valid(modeSchema, input.mode);
  return toSummary(
    await rpc(
      db,
      "controller_create_chat",
      {
        p_token_hash: hash,
        p_session_id: sessionId,
        p_room_id: roomId,
        p_name: name,
        p_mode: mode,
      },
      summaryRow,
    ),
  );
}

/**
 * A controller's message in a chat: its request, routed by the chat's mode or
 * a leading @mention. Refused (job_active) while work runs in the chat; the
 * health gate refuses with ChatApiError provider_unhealthy (nothing stored).
 */
export async function postControllerChatMessage(
  db: ClientDatabase,
  hash: string,
  input: { sessionId: unknown; chatId: unknown; body: unknown; idempotencyKey?: unknown },
): Promise<{ job: TeamStatus; created: boolean }> {
  const sessionId = valid(sessionIdSchema, input.sessionId);
  const chatId = validId(chatIdSchema, input.chatId, "chat_not_found");
  const { body } = valid(z.object({ body: z.string().max(CHAT_API_MESSAGE_MAX_CHARS) }), {
    body: input.body,
  });
  if (body.trim() === "") throw new ChatApiError("empty");
  const key =
    input.idempotencyKey === undefined ? null : valid(idempotencyKeySchema, input.idempotencyKey);
  const row = await rpc(
    db,
    "controller_post_chat_message",
    {
      p_token_hash: hash,
      p_session_id: sessionId,
      p_chat_id: chatId,
      p_body: body,
      p_idempotency_key: key,
    },
    teamStatusRowSchema,
  );
  return { job: toTeamStatus(row), created: row.created === true };
}

export async function controllerChatStatus(
  db: ClientDatabase,
  hash: string,
  input: { sessionId: unknown; chatId: unknown },
): Promise<{ chat: ChatApiSummary; job: TeamStatus | null }> {
  const sessionId = valid(sessionIdSchema, input.sessionId);
  const chatId = validId(chatIdSchema, input.chatId, "chat_not_found");
  const r = await rpc(
    db,
    "controller_chat_status",
    { p_token_hash: hash, p_session_id: sessionId, p_chat_id: chatId },
    z.object({ chat: summaryRow, job: teamStatusRowSchema.nullable() }),
  );
  return { chat: toSummary(r.chat), job: r.job ? toTeamStatus(r.job) : null };
}

export async function controllerJobResult(
  db: ClientDatabase,
  hash: string,
  input: { sessionId: unknown; jobId: unknown },
): Promise<{ job: TeamStatus; chatName: string | null }> {
  const sessionId = valid(sessionIdSchema, input.sessionId);
  const jobId = validId(jobIdSchema, input.jobId, "job_not_found");
  const r = await rpc(
    db,
    "controller_job_result",
    { p_token_hash: hash, p_session_id: sessionId, p_job_id: jobId },
    teamStatusRowSchema.extend({ chat_name: z.string().nullable() }),
  );
  return { job: toTeamStatus(r), chatName: r.chat_name };
}
