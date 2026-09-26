import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import {
  effectiveHealth,
  healthEntriesSchema,
  healthMessage,
  parseHealthDetail,
  PROVIDER_META,
} from "@/lib/providers/health";
import { AGENT_PROVIDERS, jobIdSchema, JOB_STATUSES } from "@/lib/team/model";

import {
  CHAT_ERROR_MESSAGES,
  chatErrorReason,
  chatIdSchema,
  groupIdSchema,
  roomIdSchema,
  type ChatErrorReason,
} from "./model";
import {
  JOB_MODES,
  type ChatDetail,
  type ChatGroup,
  type ChatRetryOption,
  type ChatSettings,
  type ChatSummary,
  type JobMode,
  type ParticipantView,
  type ProviderHealth,
  type ProviderHealthEntry,
} from "./types";

/**
 * Chats (docs/design/chat-first.md section 5): the owner's list, one chat,
 * and every change. USER-SCOPED client: RLS limits reads to the caller's own
 * rows and every row is re-checked here too. Writes go through the owner RPCs,
 * which re-derive the owner from the verified JWT (auth.uid()).
 *
 * Failures are ChatActionError with a reason code and a sentence chosen HERE;
 * database text is never passed through.
 */

export class ChatActionError extends Error {
  readonly reason: ChatErrorReason;
  /** provider_unhealthy only: each participant's health. */
  readonly health: ProviderHealthEntry[] | undefined;
  constructor(reason: ChatErrorReason, health?: ProviderHealthEntry[]) {
    super(
      reason === "provider_unhealthy" && health && health.length > 0
        ? healthMessage(health)
        : CHAT_ERROR_MESSAGES[reason],
    );
    this.name = "ChatActionError";
    this.reason = reason;
    this.health = health;
  }
}

const PROVIDERS = AGENT_PROVIDERS;
const providerOrNull = z.enum(PROVIDERS).nullable();

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
const chatRow = z.object({
  id: chatIdSchema,
  owner_user_id: z.string(),
  name: z.string(),
  room_id: z.string().nullable(),
  group_id: z.string().nullable(),
  mode: z.enum(JOB_MODES),
  solo_provider: providerOrNull,
  builder_provider: providerOrNull,
  reviewer_provider: providerOrNull,
  pinned_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  last_activity_at: z.string(),
  last_read_seq: z.coerce.number().int().min(0),
  is_room_default: z.boolean(),
  created_at: z.string(),
});
type ChatRow = z.infer<typeof chatRow>;
const CHAT_COLUMNS =
  "id, owner_user_id, name, room_id, group_id, mode, solo_provider, builder_provider, " +
  "reviewer_provider, pinned_at, archived_at, deleted_at, last_activity_at, last_read_seq, " +
  "is_room_default, created_at";

const groupRow = z.object({
  id: groupIdSchema,
  owner_user_id: z.string(),
  name: z.string(),
  sort: z.number().int(),
});
const roomRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  name: z.string(),
  status: z.string(),
  agent_session_id: z.string().nullable(),
});
const sessionRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  runtime_id: z.string().nullable(),
});
const agentRow = z.object({
  owner_user_id: z.string(),
  room_id: z.string(),
  provider: z.enum(PROVIDERS),
  enabled: z.boolean(),
});
/** Health as one Runtime (computer) last reported it. */
const runtimeHealthRow = z.object({
  owner_user_id: z.string(),
  runtime_id: z.string(),
  provider: z.enum(PROVIDERS),
  detected: z.record(z.string(), z.unknown()),
  received_at: z.string(),
});
const jobRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  chat_id: z.string().nullable(),
  task_id: z.string(),
  mode: z.enum(JOB_MODES),
  status: z.enum(JOB_STATUSES),
  plan_hash: z.string().nullable(),
  retried_from_job_id: z.string().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
const decisionRow = z.object({ owner_user_id: z.string(), job_id: z.string() });
const extrasRow = z.object({
  chat_id: z.string(),
  last_seq: z.coerce.number().int().nullable(),
  last_body: z.string().nullable(),
  last_at: z.string().nullable(),
  controller_labels: z.array(z.string()).nullable(),
});

function assertOwned(user: ThreadLinkUser, rows: { owner_user_id: string }[]) {
  if (rows.some((r) => r.owner_user_id !== user.id)) throw new OwnershipViolationError();
}

/** A read failure. The database's error is never passed on (it can carry data). */
function fail(): never {
  throw new Error("Failed to load chats");
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
export const listChatsOptionsSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    groupId: groupIdSchema.optional(),
    roomId: roomIdSchema.optional(),
    mode: z.enum(JOB_MODES).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type ListChatsOptions = z.input<typeof listChatsOptionsSchema>;

/** Escapes LIKE wildcards so a search is always a plain substring match. */
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

const ATTENTION = new Set(["blocked", "needs_user_decision"]);

async function buildSummaries(
  db: SupabaseClient,
  user: ThreadLinkUser,
  chats: ChatRow[],
): Promise<{
  summaries: (ChatSummary & { isRoomDefault: boolean })[];
  jobs: z.infer<typeof jobRow>[];
}> {
  if (chats.length === 0) return { summaries: [], jobs: [] };
  const chatIds = chats.map((c) => c.id);
  const roomIds = [...new Set(chats.flatMap((c) => (c.room_id ? [c.room_id] : [])))];
  const groupIds = [...new Set(chats.flatMap((c) => (c.group_id ? [c.group_id] : [])))];

  const [rooms, agents, groups, jobs, extras] = await Promise.all([
    roomIds.length
      ? db
          .from("rooms")
          .select("id, owner_user_id, name, status, agent_session_id")
          .in("id", roomIds)
      : Promise.resolve({ data: [], error: null }),
    roomIds.length
      ? db
          .from("room_agents")
          .select("owner_user_id, room_id, provider, enabled")
          .in("room_id", roomIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? db.from("chat_groups").select("id, owner_user_id, name, sort").in("id", groupIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("team_jobs")
      .select(
        "id, owner_user_id, chat_id, task_id, mode, status, plan_hash, retried_from_job_id, created_at, finished_at",
      )
      .in("chat_id", chatIds)
      .order("created_at", { ascending: false })
      .limit(1000),
    db.rpc("chat_list_extras", { p_chat_ids: chatIds }),
  ]);
  if (rooms.error || agents.error || groups.error || jobs.error || extras.error) fail();
  const rRows = z.array(roomRow).parse(rooms.data);
  const aRows = z.array(agentRow).parse(agents.data);
  const gRows = z.array(groupRow).parse(groups.data);
  const jRows = z.array(jobRow).parse(jobs.data);
  const xRows = z.array(extrasRow).parse(extras.data);
  assertOwned(user, [...rRows, ...aRows, ...gRows, ...jRows]);

  // Health is per computer: each project's agents are judged by the Runtime
  // that owns the project's agent session, never by another computer.
  const sessionIds = [
    ...new Set(rRows.flatMap((r) => (r.agent_session_id ? [r.agent_session_id] : []))),
  ];
  const sessions = sessionIds.length
    ? await db.from("session_bindings").select("id, owner_user_id, runtime_id").in("id", sessionIds)
    : { data: [], error: null };
  if (sessions.error) fail();
  const sRows = z.array(sessionRow).parse(sessions.data);
  const runtimeIds = [...new Set(sRows.flatMap((r) => (r.runtime_id ? [r.runtime_id] : [])))];
  const healthRows = runtimeIds.length
    ? await db
        .from("runtime_provider_health")
        .select("owner_user_id, runtime_id, provider, detected, received_at")
        .in("runtime_id", runtimeIds)
    : { data: [], error: null };
  if (healthRows.error) fail();
  const hRows = z.array(runtimeHealthRow).parse(healthRows.data);
  assertOwned(user, [...sRows, ...hRows]);

  // Decisions waiting for the owner, on running jobs.
  const running = jRows.filter((j) => j.finished_at === null);
  let waiting = new Set<string>();
  if (running.length) {
    const d = await db
      .from("team_decisions")
      .select("owner_user_id, job_id")
      .in(
        "job_id",
        running.map((j) => j.id),
      )
      .eq("requires_user", true)
      .is("resolution", null)
      .limit(1000);
    if (d.error) fail();
    const dRows = z.array(decisionRow).parse(d.data);
    assertOwned(user, dRows);
    waiting = new Set(dRows.map((r) => r.job_id));
  }

  const now = Date.now();
  const runtimeOfSession = new Map(sRows.map((r) => [r.id, r.runtime_id]));
  const healthIn = (room: z.infer<typeof roomRow>, provider: string): ProviderHealth => {
    const runtime = room.agent_session_id ? runtimeOfSession.get(room.agent_session_id) : null;
    const row = runtime
      ? hRows.find((h) => h.runtime_id === runtime && h.provider === provider)
      : undefined;
    return effectiveHealth(provider, row?.detected ?? null, row?.received_at ?? null, now);
  };
  const roomById = new Map(rRows.map((r) => [r.id, r]));
  const groupById = new Map(gRows.map((g) => [g.id, g]));
  const extrasById = new Map(xRows.map((x) => [x.chat_id, x]));

  const summaries = chats.map((c) => {
    const room = c.room_id ? roomById.get(c.room_id) : undefined;
    const live = room && room.status !== "deleted" ? room : undefined;
    const x = extrasById.get(c.id);
    const mine = jRows.filter((j) => j.chat_id === c.id);
    const active = mine.find((j) => j.finished_at === null) ?? null;
    const latest = mine[0];
    const agents: ParticipantView[] = live
      ? aRows
          .filter((a) => a.room_id === live.id && a.enabled)
          .sort((a, b) => a.provider.localeCompare(b.provider))
          .map((a) => ({
            kind: "agent",
            provider: a.provider,
            name: PROVIDER_META[a.provider]?.name ?? a.provider,
            shortName: PROVIDER_META[a.provider]?.shortName ?? a.provider,
            health: healthIn(live, a.provider),
          }))
      : [];
    const controllers: ParticipantView[] = [...new Set(x?.controller_labels ?? [])]
      .sort()
      .map((label) => ({
        kind: "controller",
        provider: null,
        name: label,
        shortName: label,
        health: null,
      }));
    const lastSeq = x?.last_seq ?? null;
    return {
      chatId: c.id,
      name: c.name,
      mode: c.mode,
      roomId: live ? live.id : null,
      projectName: live ? live.name : null,
      groupId: c.group_id,
      groupName: c.group_id ? (groupById.get(c.group_id)?.name ?? null) : null,
      pinned: c.pinned_at !== null,
      archived: c.archived_at !== null,
      participants: [
        ...agents,
        ...controllers,
        { kind: "owner", provider: null, name: "You", shortName: "You", health: null },
      ] satisfies ParticipantView[],
      lastMessage: x?.last_body ?? null,
      lastActivityAt: c.last_activity_at,
      unread: lastSeq !== null && lastSeq > c.last_read_seq,
      needsAttention:
        (latest !== undefined && ATTENTION.has(latest.status)) ||
        (active !== null && waiting.has(active.id)),
      activeJob: active ? { jobId: active.id, mode: active.mode, status: active.status } : null,
      isRoomDefault: c.is_room_default,
    };
  });
  return { summaries, jobs: jRows };
}

/**
 * The owner's chats: pinned first (most recently pinned first), then by last
 * activity. Deleted chats never appear; archived ones only when asked for.
 */
export async function listChatsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawOptions: ListChatsOptions = {},
): Promise<(ChatSummary & { isRoomDefault: boolean })[]> {
  const o = listChatsOptionsSchema.parse(rawOptions);
  let q = db.from("chats").select(CHAT_COLUMNS).is("deleted_at", null);
  if (!o.includeArchived) q = q.is("archived_at", null);
  if (o.groupId) q = q.eq("group_id", o.groupId);
  if (o.roomId) q = q.eq("room_id", o.roomId);
  if (o.mode) q = q.eq("mode", o.mode);
  if (o.search) q = q.ilike("name", `%${likeEscape(o.search)}%`);
  const { data, error } = await q
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("last_activity_at", { ascending: false })
    .limit(200);
  if (error) fail();
  const rows = z.array(chatRow).parse(data);
  assertOwned(user, rows);
  return (await buildSummaries(db, user, rows)).summaries;
}

export async function listChatGroupsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<ChatGroup[]> {
  const { data, error } = await db
    .from("chat_groups")
    .select("id, owner_user_id, name, sort")
    .order("sort", { ascending: true })
    .order("name", { ascending: true })
    .limit(100);
  if (error) fail();
  const rows = z.array(groupRow).parse(data);
  assertOwned(user, rows);
  return rows.map((g) => ({ groupId: g.id, name: g.name }));
}

const carrierSchema = z
  .object({
    participants: z.array(z.string()).optional(),
    agents: z.array(z.object({ provider: z.string() }).passthrough()).optional(),
  })
  .passthrough();

/** One chat (summary, settings, groups, retry option), or null when not the caller's. */
export async function getChatFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<ChatDetail | null> {
  const parsedId = chatIdSchema.safeParse(rawChatId);
  if (!parsedId.success) return null;
  const { data, error } = await db
    .from("chats")
    .select(CHAT_COLUMNS)
    .eq("id", parsedId.data)
    .maybeSingle();
  if (error) fail();
  if (!data) return null;
  const row = chatRow.parse(data);
  assertOwned(user, [row]);
  if (row.deleted_at !== null) return null;

  const [{ summaries, jobs }, groups] = await Promise.all([
    buildSummaries(db, user, [row]),
    listChatGroupsFor(db, user),
  ]);
  const summary = summaries[0]!;
  const settings: ChatSettings = {
    mode: row.mode,
    soloProvider: row.solo_provider,
    builderProvider: row.builder_provider,
    reviewerProvider: row.reviewer_provider,
  };

  // Retry: the chat's latest job, blocked before it had a plan, not yet retried.
  let retry: ChatRetryOption | null = null;
  const latest = jobs[0];
  if (
    latest &&
    latest.status === "blocked" &&
    latest.plan_hash === null &&
    !jobs.some((j) => j.retried_from_job_id === latest.id)
  ) {
    const task = await db
      .from("tasks")
      .select("owner_user_id, content")
      .eq("id", latest.task_id)
      .maybeSingle();
    if (task.error) fail();
    if (task.data) {
      const t = z
        .object({ owner_user_id: z.string(), content: z.string().nullable() })
        .parse(task.data);
      assertOwned(user, [t]);
      let carrier: z.infer<typeof carrierSchema> | null = null;
      try {
        const parsed = carrierSchema.safeParse(JSON.parse(t.content ?? "null"));
        carrier = parsed.success ? parsed.data : null;
      } catch {
        carrier = null;
      }
      const ids = (carrier?.agents ?? []).map((a) => a.provider);
      const healthOf = new Map(
        summary.participants
          .filter((p) => p.kind === "agent" && p.provider)
          .map((p) => [p.provider as string, p.health ?? "unknown"]),
      );
      const coordinators = [...new Set(ids)]
        .filter((p) => (PROVIDERS as readonly string[]).includes(p))
        .map((p) => ({
          provider: p,
          name: PROVIDER_META[p]?.name ?? p,
          health: (healthOf.get(p) ?? "unknown") as ProviderHealth,
        }));
      if (coordinators.length > 0) retry = { jobId: latest.id, coordinators };
    }
  }

  return { ...summary, settings, groups, retry, lastReadSeq: row.last_read_seq };
}

// ---------------------------------------------------------------------------
// Changes (owner RPCs). Each returns the chat as the database now has it.
// ---------------------------------------------------------------------------
type RpcError = { code?: string; hint?: string | null; details?: string | null };

async function rpc(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await db.rpc(fn, args);
  } catch {
    throw new ChatActionError("unavailable");
  }
  if (result.error) {
    const reason = chatErrorReason(result.error);
    throw new ChatActionError(
      reason,
      reason === "provider_unhealthy"
        ? (parseHealthDetail(result.error.details) ?? undefined)
        : undefined,
    );
  }
  return result.data;
}

/** Input values are validated here first (a clear "invalid"), then by the database again. */
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ChatActionError("invalid");
  return parsed.data;
}

const chatJsonSchema = z.object({
  chat_id: chatIdSchema,
  name: z.string(),
  mode: z.enum(JOB_MODES),
  room_id: z.string().nullable(),
  project_name: z.string().nullable(),
  group_id: z.string().nullable(),
  group_name: z.string().nullable(),
  solo_provider: providerOrNull,
  builder_provider: providerOrNull,
  reviewer_provider: providerOrNull,
  pinned: z.boolean(),
  archived: z.boolean(),
  is_room_default: z.boolean(),
  last_activity_at: z.string(),
  last_read_seq: z.coerce.number(),
});

/** What every chat change returns: the chat's own fields as stored now. */
export type ChatRecord = {
  chatId: string;
  name: string;
  mode: JobMode;
  roomId: string | null;
  projectName: string | null;
  groupId: string | null;
  groupName: string | null;
  settings: ChatSettings;
  pinned: boolean;
  archived: boolean;
  isRoomDefault: boolean;
  lastActivityAt: string;
  lastReadSeq: number;
};

function toRecord(data: unknown): ChatRecord {
  const parsed = chatJsonSchema.safeParse(data);
  if (!parsed.success) throw new ChatActionError("unavailable");
  const c = parsed.data;
  return {
    chatId: c.chat_id,
    name: c.name,
    mode: c.mode,
    roomId: c.project_name === null ? null : c.room_id,
    projectName: c.project_name,
    groupId: c.group_id,
    groupName: c.group_name,
    settings: {
      mode: c.mode,
      soloProvider: c.solo_provider,
      builderProvider: c.builder_provider,
      reviewerProvider: c.reviewer_provider,
    },
    pinned: c.pinned,
    archived: c.archived,
    isRoomDefault: c.is_room_default,
    lastActivityAt: c.last_activity_at,
    lastReadSeq: c.last_read_seq,
  };
}

const nameSchema = z.string().trim().min(1).max(100);
const groupNameSchema = z.string().trim().min(1).max(60);

export const createChatInputSchema = z
  .object({
    name: nameSchema,
    roomId: roomIdSchema.nullish(),
    groupId: groupIdSchema.nullish(),
    mode: z.enum(JOB_MODES).nullish(),
  })
  .strict();

export async function createChatAs(db: SupabaseClient, rawInput: unknown): Promise<ChatRecord> {
  const input = valid(createChatInputSchema, rawInput);
  return toRecord(
    await rpc(db, "create_chat", {
      p_name: input.name,
      p_room_id: input.roomId ?? null,
      p_group_id: input.groupId ?? null,
      p_mode: input.mode ?? null,
    }),
  );
}

/**
 * A change to a chat, applied atomically (one RPC). `undefined` leaves a field
 * as it is; `null` clears it (no project, no group, or "chosen automatically"
 * for a provider). `pinned` / `archived` are part of the same change.
 */
export const updateChatInputSchema = z
  .object({
    name: nameSchema.optional(),
    roomId: roomIdSchema.nullable().optional(),
    groupId: groupIdSchema.nullable().optional(),
    mode: z.enum(JOB_MODES).optional(),
    soloProvider: providerOrNull.optional(),
    builderProvider: providerOrNull.optional(),
    reviewerProvider: providerOrNull.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateChatInput = z.input<typeof updateChatInputSchema>;

const auto = (v: string | null | undefined) => (v === undefined ? null : v === null ? "auto" : v);

export async function updateChatAs(
  db: SupabaseClient,
  rawChatId: unknown,
  rawPatch: unknown,
): Promise<ChatRecord> {
  const chatId = valid(chatIdSchema, rawChatId);
  const p = valid(updateChatInputSchema, rawPatch);
  return toRecord(
    await rpc(db, "update_chat", {
      p_chat_id: chatId,
      p_name: p.name ?? null,
      p_room_id: p.roomId ?? null,
      p_clear_room: p.roomId === null,
      p_group_id: p.groupId ?? null,
      p_clear_group: p.groupId === null,
      p_mode: p.mode ?? null,
      p_solo_provider: auto(p.soloProvider),
      p_builder_provider: auto(p.builderProvider),
      p_reviewer_provider: auto(p.reviewerProvider),
      // In the same call, so a refusal applies nothing.
      p_pinned: p.pinned ?? null,
      p_archived: p.archived ?? null,
    }),
  );
}

export async function setChatPinnedAs(
  db: SupabaseClient,
  rawChatId: unknown,
  pinned: unknown,
): Promise<ChatRecord> {
  return toRecord(
    await rpc(db, "set_chat_pinned", {
      p_chat_id: valid(chatIdSchema, rawChatId),
      p_pinned: valid(z.boolean(), pinned),
    }),
  );
}

export async function setChatArchivedAs(
  db: SupabaseClient,
  rawChatId: unknown,
  archived: unknown,
): Promise<ChatRecord> {
  return toRecord(
    await rpc(db, "set_chat_archived", {
      p_chat_id: valid(chatIdSchema, rawChatId),
      p_archived: valid(z.boolean(), archived),
    }),
  );
}

/** "Delete from ThreadLink": hides the chat for good. Refused while work runs in it. */
export async function deleteChatAs(db: SupabaseClient, rawChatId: unknown): Promise<void> {
  await rpc(db, "delete_chat", { p_chat_id: valid(chatIdSchema, rawChatId) });
}

export async function markChatReadAs(
  db: SupabaseClient,
  rawChatId: unknown,
  rawSeq: unknown,
): Promise<{ lastReadSeq: number }> {
  const data = await rpc(db, "mark_chat_read", {
    p_chat_id: valid(chatIdSchema, rawChatId),
    p_seq: valid(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), rawSeq),
  });
  const parsed = z.object({ last_read_seq: z.coerce.number() }).safeParse(data);
  if (!parsed.success) throw new ChatActionError("unavailable");
  return { lastReadSeq: parsed.data.last_read_seq };
}

const groupJsonSchema = z.object({ group_id: groupIdSchema, name: z.string() });

export async function createChatGroupAs(db: SupabaseClient, rawName: unknown): Promise<ChatGroup> {
  const g = groupJsonSchema.safeParse(
    await rpc(db, "create_chat_group", { p_name: valid(groupNameSchema, rawName) }),
  );
  if (!g.success) throw new ChatActionError("unavailable");
  return { groupId: g.data.group_id, name: g.data.name };
}

export async function renameChatGroupAs(
  db: SupabaseClient,
  rawGroupId: unknown,
  rawName: unknown,
): Promise<ChatGroup> {
  const g = groupJsonSchema.safeParse(
    await rpc(db, "rename_chat_group", {
      p_group_id: valid(groupIdSchema, rawGroupId),
      p_name: valid(groupNameSchema, rawName),
    }),
  );
  if (!g.success) throw new ChatActionError("unavailable");
  return { groupId: g.data.group_id, name: g.data.name };
}

/** The group goes; its chats stay, ungrouped. */
export async function deleteChatGroupAs(db: SupabaseClient, rawGroupId: unknown): Promise<void> {
  await rpc(db, "delete_chat_group", { p_group_id: valid(groupIdSchema, rawGroupId) });
}

/**
 * "Retry with <provider> as coordinator" (explicit; never automatic). A new job
 * in the same chat. Refused unless the job was blocked before it had a plan and
 * every participant is ready (ChatActionError provider_unhealthy with health).
 */
export async function retryJobWithRolesAs(
  db: SupabaseClient,
  rawJobId: unknown,
  rawCoordinator: unknown,
): Promise<{ jobId: string; chatId: string; replayed: boolean }> {
  const data = await rpc(db, "retry_job_with_roles", {
    p_job_id: valid(jobIdSchema, rawJobId),
    p_coordinator: valid(z.enum(PROVIDERS), rawCoordinator),
  });
  const r = z
    .object({ job_id: jobIdSchema, chat_id: chatIdSchema, replayed: z.boolean().optional() })
    .safeParse(data);
  if (!r.success) throw new ChatActionError("unavailable");
  return { jobId: r.data.job_id, chatId: r.data.chat_id, replayed: r.data.replayed === true };
}

export { healthEntriesSchema };
