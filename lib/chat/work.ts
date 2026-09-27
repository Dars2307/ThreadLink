import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import { healthStateLabel, type HealthState } from "@/lib/providers/health";
import {
  ARTIFACT_MIMES,
  artifactIdSchema,
  choiceIdSchema,
  decisionLabel,
  jobIdSchema,
  JOB_CONTROL_VALUES,
  runIdSchema,
} from "@/lib/team/model";

import { ChatActionError } from "./chats";
import {
  CHAT_EVENT_COLUMNS_V10,
  chatErrorReason,
  chatEventRowSchema,
  chatIdSchema,
  deliveryOf,
  toChatEvent,
} from "./model";
import { ChatNotFoundError } from "./queries";
import {
  ARTIFACT_KINDS,
  CHOICE_KINDS,
  FINDING_STATES,
  JOB_CONTROLS,
  JOB_MODES,
  PROVIDER_HEALTH,
  RUN_ACTIVITIES,
  RUN_STATUSES,
  type ArtifactView,
  type ChatHostStatus,
  type ChatSearchResult,
  type ChatTimelinePage,
  type ChoiceView,
  type DecisionView,
  type FindingState,
  type FindingView,
  type JobControl,
  type LiveActivity,
  type RunProvenance,
} from "./types";

/**
 * 0.10 owner reads and actions for one chat (docs/design/threadlink-0.10.md
 * sections 2-8): the timeline by the per-chat cursor, run provenance, live
 * activity, findings / decisions / choices / artifacts, deciding a choice,
 * controlling a job, text attachments, search and host status.
 *
 * USER-SCOPED client: RLS limits every read to the caller's own rows, and
 * every row is re-checked against the signed-in user here as well. Writes go
 * through owner RPCs that re-derive the owner from the verified JWT. The
 * global chat_events.seq is never returned by these functions. The native
 * session id is never read here except through the audited reveal RPC.
 */

function assertOwned(user: ThreadLinkUser, rows: { owner_user_id: string }[]) {
  if (rows.some((r) => r.owner_user_id !== user.id)) throw new OwnershipViolationError();
}

function fail(): never {
  throw new Error("Failed to load the chat");
}

type RpcError = { code?: string; hint?: string | null };

/** An owner RPC. A refusal is a ChatActionError (reason code + fixed sentence). */
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
  if (result.error) throw new ChatActionError(chatErrorReason(result.error));
  return result.data;
}

function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ChatActionError("invalid");
  return parsed.data;
}

const chatRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  deleted_at: z.string().nullable(),
  room_id: z.string().nullable(),
  last_read_chat_seq: z.coerce.number().int().min(0),
});

/** The caller's live chat, or ChatNotFoundError (another account's reads the same). */
async function ownChat(db: SupabaseClient, user: ThreadLinkUser, rawChatId: unknown) {
  const chatId = chatIdSchema.safeParse(rawChatId);
  if (!chatId.success) throw new ChatNotFoundError();
  const { data, error } = await db
    .from("chats")
    .select("id, owner_user_id, deleted_at, room_id, last_read_chat_seq")
    .eq("id", chatId.data)
    .maybeSingle();
  if (error) fail();
  if (!data) throw new ChatNotFoundError();
  const c = chatRow.parse(data);
  assertOwned(user, [c]);
  if (c.deleted_at !== null) throw new ChatNotFoundError();
  return c;
}

// ---------------------------------------------------------------------------
// The timeline, by the per-chat cursor
// ---------------------------------------------------------------------------
export const TIMELINE_PAGE_DEFAULT = 100;
export const TIMELINE_PAGE_MAX = 200;

export const timelineQuerySchema = z
  .object({
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(TIMELINE_PAGE_MAX).optional(),
    technical: z.boolean().default(false),
  })
  .strict()
  .refine((q) => q.after === undefined || q.before === undefined, "after or before, not both");
export type TimelineQuery = z.input<typeof timelineQuerySchema>;

/** ?after=&before=&limit=&technical= -> a TimelineQuery, or null if malformed. */
export function parseTimelineParams(params: URLSearchParams): TimelineQuery | null {
  const num = (k: string) => {
    const v = params.get(k);
    if (v === null) return undefined;
    return /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  };
  const technical = params.get("technical");
  if (technical !== null && !["0", "1", "true", "false"].includes(technical)) return null;
  const q = { after: num("after"), before: num("before"), limit: num("limit") };
  if (Object.values(q).some((v) => Number.isNaN(v))) return null;
  const parsed = timelineQuerySchema.safeParse({
    ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)),
    technical: technical === "1" || technical === "true",
  });
  return parsed.success ? parsed.data : null;
}

const activeJobRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  mode: z.enum(JOB_MODES),
  status: z.string(),
  control: z.enum(JOB_CONTROLS).nullable().optional(),
  control_requested_at: z.string().nullable().optional(),
});
const jobStateRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  finished_at: z.string().nullable(),
});
const runProviderRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  provider: z.string(),
});

/**
 * One page of a chat, oldest first. Without a cursor: the latest page. With
 * `after`: rows after that chat_seq. With `before`: the page just older than
 * it. Every event's `seq` IS its chat_seq here.
 */
export async function listTimelineFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawQuery: TimelineQuery,
): Promise<ChatTimelinePage> {
  const query = timelineQuerySchema.parse(rawQuery);
  const chat = await ownChat(db, user, rawChatId);
  const limit = query.limit ?? TIMELINE_PAGE_DEFAULT;

  let events = db.from("chat_events").select(CHAT_EVENT_COLUMNS_V10).eq("chat_id", chat.id);
  if (!query.technical) events = events.eq("visibility", "visible");
  const forward = query.after !== undefined;
  const page = await (forward
    ? events.gt("chat_seq", query.after!).order("chat_seq", { ascending: true }).limit(limit)
    : (query.before !== undefined
        ? events.lt("chat_seq", query.before)
        : events.not("chat_seq", "is", null)
      )
        .order("chat_seq", { ascending: false })
        .limit(limit + 1));
  if (page.error) fail();
  const rows = z.array(chatEventRowSchema).parse(page.data);
  assertOwned(user, rows);
  if (rows.some((r) => r.chat_id !== chat.id)) throw new OwnershipViolationError();
  const hasMore = !forward && rows.length > limit;
  const kept = (hasMore ? rows.slice(0, limit) : rows).filter(
    (r) => r.chat_seq !== null && r.chat_seq !== undefined,
  );
  const ordered = forward ? kept : [...kept].reverse();

  // Delivery context: the jobs' state and the providers of consuming runs.
  const noteRows = ordered.filter((r) => r.author_kind === "owner" && r.job_id);
  const jobIds = [...new Set(noteRows.map((r) => r.job_id!))];
  const runIds = [
    ...new Set(noteRows.flatMap((r) => (r.consumed_by_run_id ? [r.consumed_by_run_id] : []))),
  ];
  const [jobs, runs, active] = await Promise.all([
    jobIds.length
      ? db.from("team_jobs").select("id, owner_user_id, finished_at").in("id", jobIds)
      : Promise.resolve({ data: [], error: null }),
    runIds.length
      ? db.from("agent_runs").select("id, owner_user_id, provider").in("id", runIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("team_jobs")
      .select("id, owner_user_id, mode, status, control, control_requested_at")
      .eq("chat_id", chat.id)
      .is("finished_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (jobs.error || runs.error || active.error) fail();
  const jRows = z.array(jobStateRow).parse(jobs.data);
  const rRows = z.array(runProviderRow).parse(runs.data);
  const aRows = z.array(activeJobRow).parse(active.data);
  assertOwned(user, [...jRows, ...rRows, ...aRows]);
  const finished = new Map(jRows.map((j) => [j.id, j.finished_at !== null]));
  const providerOf = new Map(rRows.map((r) => [r.id, r.provider]));

  const out = ordered.map((r) => {
    const e = toChatEvent(r);
    const delivery = deliveryOf(r, {
      jobFinished: r.job_id ? (finished.get(r.job_id) ?? null) : null,
      consumedByProvider: r.consumed_by_run_id
        ? (providerOf.get(r.consumed_by_run_id) ?? null)
        : null,
    });
    // Never the global sequence on this route: the cursor is the chat's own.
    return { ...e, seq: r.chat_seq!, chatSeq: r.chat_seq!, delivery };
  });
  const a = aRows[0];
  return {
    events: out,
    cursor: out.reduce((max, e) => Math.max(max, e.seq), query.after ?? 0),
    oldestChatSeq: out.length ? out[0]!.seq : null,
    hasMore,
    activeJob: a
      ? {
          jobId: a.id,
          mode: a.mode,
          status: a.status,
          control: a.control ?? null,
          controlRequestedAt: a.control_requested_at ?? null,
        }
      : null,
    lastReadChatSeq: chat.last_read_chat_seq,
  };
}

// ---------------------------------------------------------------------------
// Runs: provenance and live activity
// ---------------------------------------------------------------------------
const RUN_COLUMNS =
  "id, owner_user_id, chat_id, job_id, runtime_id, provider, participant_key, role, requested_model, " +
  "observed_model, model_verified, effort, access, access_verified, native_session_kind, " +
  "native_session_continuity, worktree_label, status, activity, last_activity_at, started_at, finished_at, " +
  "failure, verification";
const runRow = z.object({
  id: runIdSchema,
  owner_user_id: z.string(),
  chat_id: z.string().nullable(),
  job_id: z.string(),
  runtime_id: z.string().nullable(),
  provider: z.string(),
  participant_key: z.string(),
  role: z.string(),
  requested_model: z.string().nullable(),
  observed_model: z.string().nullable(),
  model_verified: z.boolean(),
  effort: z.string().nullable(),
  access: z.enum(["read-only", "workspace-write"]).nullable(),
  access_verified: z.boolean(),
  native_session_kind: z.string().nullable(),
  native_session_continuity: z.string().nullable(),
  worktree_label: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  activity: z.enum(RUN_ACTIVITIES).nullable(),
  last_activity_at: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  failure: z.string().nullable(),
  verification: z.record(z.string(), z.unknown()).nullable(),
});
type RunRow = z.infer<typeof runRow>;

/** Provider display names from the registry (fixed fallback: the id itself). */
async function providerNames(db: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await db.rpc("agent_providers_list");
  if (error) return new Map();
  const rows = z
    .array(z.object({ id: z.string(), display_name: z.string() }).passthrough())
    .safeParse(data);
  return new Map(rows.success ? rows.data.map((r) => [r.id, r.display_name]) : []);
}

/**
 * Verified = completed, model and access verified, a native session, on the
 * project's own Runtime (the same rule as SQL run_is_verified). Anything
 * missing is "partial", with the reasons in fixed words.
 */
export function runVerification(
  r: Pick<
    RunRow,
    | "status"
    | "model_verified"
    | "access_verified"
    | "runtime_id"
    | "verification"
    | "native_session_kind"
  >,
  projectRuntimeId: string | null,
): { verified: RunProvenance["verified"]; notes: string[] } {
  const notes: string[] = [];
  if (r.status !== "completed") notes.push("The run did not complete.");
  if (!r.model_verified) notes.push("The model it ran on was not confirmed.");
  if (!r.access_verified) notes.push("Its access (read-only or write) was not confirmed.");
  if (r.verification?.nativeSession !== true) {
    notes.push("Persistent native session: not exposed by this provider.");
  }
  if (!r.runtime_id || !projectRuntimeId || r.runtime_id !== projectRuntimeId) {
    notes.push("It did not run on this project's own computer.");
  }
  return { verified: notes.length === 0 ? "verified" : "partial", notes };
}

/** One run's provenance, for the Details / Provenance drawer. Null when not the caller's (or not this chat's). */
export async function getRunProvenanceFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawRunId: unknown,
): Promise<RunProvenance | null> {
  const chat = await ownChat(db, user, rawChatId);
  const runId = runIdSchema.safeParse(rawRunId);
  if (!runId.success) return null;
  const { data, error } = await db
    .from("agent_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId.data)
    .maybeSingle();
  if (error) fail();
  if (!data) return null;
  const r = runRow.parse(data);
  assertOwned(user, [r]);
  if (r.chat_id !== chat.id) return null;

  // The project's own Runtime: the room's agent session's runtime.
  const job = await db
    .from("team_jobs")
    .select("id, owner_user_id, room_id")
    .eq("id", r.job_id)
    .maybeSingle();
  if (job.error || !job.data) fail();
  const j = z
    .object({ id: z.string(), owner_user_id: z.string(), room_id: z.string() })
    .parse(job.data);
  const room = await db
    .from("rooms")
    .select("id, owner_user_id, agent_session_id")
    .eq("id", j.room_id)
    .maybeSingle();
  if (room.error) fail();
  const rm = room.data
    ? z
        .object({
          id: z.string(),
          owner_user_id: z.string(),
          agent_session_id: z.string().nullable(),
        })
        .parse(room.data)
    : null;
  let projectRuntime: string | null = null;
  if (rm?.agent_session_id) {
    const s = await db
      .from("session_bindings")
      .select("id, owner_user_id, runtime_id")
      .eq("id", rm.agent_session_id)
      .maybeSingle();
    if (s.error) fail();
    if (s.data) {
      const sb = z
        .object({ id: z.string(), owner_user_id: z.string(), runtime_id: z.string().nullable() })
        .parse(s.data);
      assertOwned(user, [sb]);
      projectRuntime = sb.runtime_id;
    }
  }
  let host: string | null = null;
  if (r.runtime_id) {
    const rt = await db
      .from("runtimes")
      .select("id, owner_user_id, label")
      .eq("id", r.runtime_id)
      .maybeSingle();
    if (rt.error) fail();
    if (rt.data) {
      const x = z
        .object({ id: z.string(), owner_user_id: z.string(), label: z.string() })
        .parse(rt.data);
      assertOwned(user, [x]);
      host = x.label;
    }
  }
  assertOwned(user, [j, ...(rm ? [rm] : [])]);
  const names = await providerNames(db);
  const v = runVerification(r, projectRuntime);
  return {
    runId: r.id,
    provider: r.provider,
    providerName: names.get(r.provider) ?? r.provider,
    participantKey: r.participant_key,
    role: r.role,
    requestedModel: r.requested_model,
    observedModel: r.observed_model,
    modelVerified: r.model_verified,
    effort: r.effort,
    access: r.access,
    accessVerified: r.access_verified,
    nativeSession: {
      available: r.verification?.nativeSession === true,
      kind: r.native_session_kind,
      continuity: r.native_session_continuity,
    },
    executionHost: host,
    worktreeLabel: r.worktree_label,
    status: r.status,
    activity: r.activity,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    lastActivityAt: r.last_activity_at,
    verified: v.verified,
    verificationNotes: v.notes,
  };
}

/** The project's own Runtime for a chat (its room's agent session's runtime), or null. */
async function chatProjectRuntime(
  db: SupabaseClient,
  user: ThreadLinkUser,
  roomId: string | null,
): Promise<string | null> {
  if (!roomId) return null;
  const room = await db
    .from("rooms")
    .select("id, owner_user_id, agent_session_id")
    .eq("id", roomId)
    .maybeSingle();
  if (room.error) fail();
  if (!room.data) return null;
  const rm = z
    .object({ id: z.string(), owner_user_id: z.string(), agent_session_id: z.string().nullable() })
    .parse(room.data);
  assertOwned(user, [rm]);
  if (!rm.agent_session_id) return null;
  const s = await db
    .from("session_bindings")
    .select("id, owner_user_id, runtime_id")
    .eq("id", rm.agent_session_id)
    .maybeSingle();
  if (s.error) fail();
  if (!s.data) return null;
  const sb = z
    .object({ id: z.string(), owner_user_id: z.string(), runtime_id: z.string().nullable() })
    .parse(s.data);
  assertOwned(user, [sb]);
  return sb.runtime_id;
}

/**
 * Every recorded run of the chat, newest first (at most 200), as provenance
 * rows for Details. Verification is judged against the chat's CURRENT
 * project computer; the per-run drawer (getRunProvenanceFor) judges against
 * the run's own job's project.
 */
export async function listRunsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<RunProvenance[]> {
  const chat = await ownChat(db, user, rawChatId);
  const { data, error } = await db
    .from("agent_runs")
    .select(RUN_COLUMNS)
    .eq("chat_id", chat.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) fail();
  const rows = z.array(runRow).parse(data);
  assertOwned(user, rows);
  if (rows.length === 0) return [];
  const [projectRuntime, names] = await Promise.all([
    chatProjectRuntime(db, user, chat.room_id),
    providerNames(db),
  ]);
  const runtimeIds = [...new Set(rows.flatMap((r) => (r.runtime_id ? [r.runtime_id] : [])))];
  const rts = runtimeIds.length
    ? await db.from("runtimes").select("id, owner_user_id, label").in("id", runtimeIds)
    : { data: [], error: null };
  if (rts.error) fail();
  const rtRows = z
    .array(z.object({ id: z.string(), owner_user_id: z.string(), label: z.string() }))
    .parse(rts.data);
  assertOwned(user, rtRows);
  const labelOf = new Map(rtRows.map((r) => [r.id, r.label]));
  return rows.map((r) => {
    const v = runVerification(r, projectRuntime);
    return {
      runId: r.id,
      provider: r.provider,
      providerName: names.get(r.provider) ?? r.provider,
      participantKey: r.participant_key,
      role: r.role,
      requestedModel: r.requested_model,
      observedModel: r.observed_model,
      modelVerified: r.model_verified,
      effort: r.effort,
      access: r.access,
      accessVerified: r.access_verified,
      nativeSession: {
        available: r.verification?.nativeSession === true,
        kind: r.native_session_kind,
        continuity: r.native_session_continuity,
      },
      executionHost: r.runtime_id ? (labelOf.get(r.runtime_id) ?? null) : null,
      worktreeLabel: r.worktree_label,
      status: r.status,
      activity: r.activity,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      lastActivityAt: r.last_activity_at,
      verified: v.verified,
      verificationNotes: v.notes,
    };
  });
}

/** Runs working in the chat right now that the UI shows as live activity rows. */
export async function listLiveActivityFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<LiveActivity[]> {
  const chat = await ownChat(db, user, rawChatId);
  const { data, error } = await db
    .from("agent_runs")
    .select(RUN_COLUMNS)
    .eq("chat_id", chat.id)
    .in("status", ["queued", "running"])
    .order("started_at", { ascending: true })
    .limit(20);
  if (error) fail();
  const rows = z.array(runRow).parse(data);
  assertOwned(user, rows);
  if (rows.length === 0) return [];
  const jobs = await db
    .from("team_jobs")
    .select("id, owner_user_id, finished_at")
    .in("id", [...new Set(rows.map((r) => r.job_id))]);
  if (jobs.error) fail();
  const jRows = z.array(jobStateRow).parse(jobs.data);
  assertOwned(user, jRows);
  const running = new Set(jRows.filter((j) => j.finished_at === null).map((j) => j.id));
  const names = await providerNames(db);
  return rows
    .filter((r) => running.has(r.job_id))
    .map((r) => ({
      runId: r.id,
      provider: r.provider,
      providerName: names.get(r.provider) ?? r.provider,
      role: r.role,
      activity: r.activity,
      startedAt: r.started_at,
      lastActivityAt: r.last_activity_at,
    }));
}

/** "Copy" in Details only: the audited reveal of a run's native session id. */
export async function revealRunNativeSessionAs(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawRunId: unknown,
): Promise<{
  available: boolean;
  nativeSessionId: string | null;
  kind: string | null;
  resumeCommand: string | null;
}> {
  const chat = await ownChat(db, user, rawChatId);
  const runId = valid(runIdSchema, rawRunId);
  // The run must be this chat's (checked BEFORE the audited reveal).
  const { data, error } = await db
    .from("agent_runs")
    .select("id, owner_user_id, chat_id")
    .eq("id", runId)
    .maybeSingle();
  if (error) fail();
  const r = data
    ? z
        .object({ id: z.string(), owner_user_id: z.string(), chat_id: z.string().nullable() })
        .parse(data)
    : null;
  if (!r || r.chat_id !== chat.id) throw new ChatActionError("run_not_found");
  assertOwned(user, [r]);
  const out = z
    .object({
      available: z.boolean(),
      native_session_id: z.string().nullable(),
      native_session_kind: z.string().nullable(),
      resume_command: z.string().nullable(),
    })
    .safeParse(await rpc(db, "reveal_run_native_session", { p_run_id: runId }));
  if (!out.success) throw new ChatActionError("unavailable");
  return {
    available: out.data.available,
    nativeSessionId: out.data.native_session_id,
    kind: out.data.native_session_kind,
    resumeCommand: out.data.resume_command,
  };
}

// ---------------------------------------------------------------------------
// Findings, decisions, choices, artifacts
// ---------------------------------------------------------------------------
/** The chat's jobs (newest 50): the scope of its findings and decisions. */
async function chatJobIds(
  db: SupabaseClient,
  user: ThreadLinkUser,
  chatId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("team_jobs")
    .select("id, owner_user_id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) fail();
  const rows = z.array(z.object({ id: z.string(), owner_user_id: z.string() })).parse(data);
  assertOwned(user, rows);
  return rows.map((r) => r.id);
}

const findingRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  job_id: z.string(),
  node_id: z.string().nullable(),
  severity: z.enum(["blocking", "important", "non_blocking"]),
  category: z.string(),
  title: z.string(),
  status: z.enum(["open", "resolved", "wont_fix", "accepted", "disputed", "fixed", "dismissed"]),
  raised_by: z.string(),
  raised_run_id: z.string().nullable(),
  resolved_run_id: z.string().nullable(),
  owner_participant: z.string().nullable(),
  file_path: z.string().nullable(),
  line: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** A pre-0.10 wont_fix reads as dismissed. */
export function findingState(status: z.infer<typeof findingRow>["status"]): FindingState {
  return status === "wont_fix" ? "dismissed" : (status as FindingState);
}

export async function listFindingsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<FindingView[]> {
  const chat = await ownChat(db, user, rawChatId);
  const jobIds = await chatJobIds(db, user, chat.id);
  if (jobIds.length === 0) return [];
  const { data, error } = await db
    .from("team_findings")
    .select(
      "id, owner_user_id, job_id, node_id, severity, category, title, status, raised_by, raised_run_id, " +
        "resolved_run_id, owner_participant, file_path, line, created_at, updated_at",
    )
    .in("job_id", jobIds)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) fail();
  const rows = z.array(findingRow).parse(data);
  assertOwned(user, rows);
  const nodeIds = [...new Set(rows.flatMap((r) => (r.node_id ? [r.node_id] : [])))];
  const nodes = nodeIds.length
    ? await db.from("team_nodes").select("id, owner_user_id, node_key").in("id", nodeIds)
    : { data: [], error: null };
  if (nodes.error) fail();
  const nRows = z
    .array(z.object({ id: z.string(), owner_user_id: z.string(), node_key: z.string() }))
    .parse(nodes.data);
  assertOwned(user, nRows);
  const keyOf = new Map(nRows.map((n) => [n.id, n.node_key]));
  return rows.map((r) => ({
    findingId: r.id,
    jobId: r.job_id,
    severity: r.severity,
    category: r.category,
    title: r.title,
    status: findingState(r.status),
    raisedBy: r.raised_by,
    raisedRunId: r.raised_run_id,
    ownerParticipant: r.owner_participant,
    filePath: r.file_path,
    line: r.line,
    nodeKey: r.node_id ? (keyOf.get(r.node_id) ?? null) : null,
    resolvedRunId: r.resolved_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

const decisionRow = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  job_id: z.string(),
  number: z.number().int(),
  title: z.string(),
  title_source: z.enum(["threadlink", "agent"]).nullable(),
  author_run_id: z.string().nullable(),
  requires_user: z.boolean(),
  resolution: z.string().nullable(),
  created_at: z.string(),
});

export async function listDecisionsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<DecisionView[]> {
  const chat = await ownChat(db, user, rawChatId);
  const jobIds = await chatJobIds(db, user, chat.id);
  if (jobIds.length === 0) return [];
  const { data, error } = await db
    .from("team_decisions")
    .select(
      "id, owner_user_id, job_id, number, title, title_source, author_run_id, requires_user, resolution, created_at",
    )
    .in("job_id", jobIds)
    .order("number", { ascending: true })
    .limit(500);
  if (error) fail();
  const rows = z.array(decisionRow).parse(data);
  assertOwned(user, rows);
  return rows.map((r) => ({
    decisionId: r.id,
    jobId: r.job_id,
    label: decisionLabel(r.number),
    title: r.title,
    titleSource: r.title_source,
    authorRunId: r.author_run_id,
    requiresUser: r.requires_user,
    resolved: r.resolution !== null,
    createdAt: r.created_at,
  }));
}

const choiceRow = z.object({
  id: choiceIdSchema,
  owner_user_id: z.string(),
  job_id: z.string().nullable(),
  kind: z.enum(CHOICE_KINDS),
  title: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string() })),
  status: z.enum(["pending", "chosen", "expired", "cancelled"]),
  chosen_key: z.string().nullable(),
  decided_at: z.string().nullable(),
  expires_at: z.string(),
  created_at: z.string(),
});
const toChoice = (r: z.infer<typeof choiceRow>, now: number): ChoiceView => ({
  choiceId: r.id,
  jobId: r.job_id,
  kind: r.kind,
  title: r.title,
  options: r.options,
  // A pending choice past its expiry reads as expired (the database marks it on the next read).
  status: r.status === "pending" && Date.parse(r.expires_at) < now ? "expired" : r.status,
  chosenKey: r.chosen_key,
  decidedAt: r.decided_at,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export async function listChoicesFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  now: number = Date.now(),
): Promise<ChoiceView[]> {
  const chat = await ownChat(db, user, rawChatId);
  const { data, error } = await db
    .from("user_choices")
    .select(
      "id, owner_user_id, job_id, kind, title, options, status, chosen_key, decided_at, expires_at, created_at",
    )
    .eq("chat_id", chat.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) fail();
  const rows = z.array(choiceRow).parse(data);
  assertOwned(user, rows);
  return rows.map((r) => toChoice(r, now));
}

export const decideChoiceSchema = z.object({ key: z.string().regex(/^[a-z_]{1,40}$/) }).strict();

/** The owner answers a question. Only a pending choice of this chat, only one of its options. */
export async function decideChoiceAs(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawChoiceId: unknown,
  rawBody: unknown,
): Promise<ChoiceView> {
  const chat = await ownChat(db, user, rawChatId);
  const choiceId = choiceIdSchema.safeParse(rawChoiceId);
  if (!choiceId.success) throw new ChatActionError("choice_not_found");
  const body = decideChoiceSchema.safeParse(rawBody);
  if (!body.success) throw new ChatActionError("invalid_choice");
  const own = await db
    .from("user_choices")
    .select("id, owner_user_id, chat_id")
    .eq("id", choiceId.data)
    .maybeSingle();
  if (own.error) fail();
  const c = own.data
    ? z
        .object({ id: z.string(), owner_user_id: z.string(), chat_id: z.string().nullable() })
        .parse(own.data)
    : null;
  if (!c || c.chat_id !== chat.id) throw new ChatActionError("choice_not_found");
  assertOwned(user, [c]);
  const data = await rpc(db, "decide_choice", { p_choice_id: choiceId.data, p_key: body.data.key });
  const r = z
    .object({
      choice_id: choiceIdSchema,
      job_id: z.string().nullable(),
      kind: z.enum(CHOICE_KINDS),
      title: z.string(),
      options: z.array(z.object({ key: z.string(), label: z.string() })),
      status: z.enum(["pending", "chosen", "expired", "cancelled"]),
      chosen_key: z.string().nullable(),
      decided_at: z.string().nullable(),
      expires_at: z.string(),
      created_at: z.string(),
    })
    .safeParse(data);
  if (!r.success) throw new ChatActionError("unavailable");
  return toChoice({ ...r.data, id: r.data.choice_id, owner_user_id: user.id }, Date.now());
}

export const controlJobSchema = z
  .object({ jobId: jobIdSchema, action: z.enum(JOB_CONTROL_VALUES) })
  .strict();

/** Pause / stop / resume a job of this chat (section 5). */
export async function controlJobAs(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawBody: unknown,
): Promise<{
  jobId: string;
  control: JobControl | null;
  controlRequestedAt: string | null;
  status: string;
}> {
  const chat = await ownChat(db, user, rawChatId);
  const parsed = controlJobSchema.safeParse(rawBody);
  if (!parsed.success) throw new ChatActionError("invalid_control");
  const own = await db
    .from("team_jobs")
    .select("id, owner_user_id, chat_id")
    .eq("id", parsed.data.jobId)
    .maybeSingle();
  if (own.error) fail();
  const j = own.data
    ? z
        .object({ id: z.string(), owner_user_id: z.string(), chat_id: z.string().nullable() })
        .parse(own.data)
    : null;
  if (!j || j.chat_id !== chat.id) throw new ChatActionError("job_not_found");
  assertOwned(user, [j]);
  const r = z
    .object({
      job_id: jobIdSchema,
      control: z.enum(JOB_CONTROLS).nullable(),
      control_requested_at: z.string().nullable(),
      status: z.string(),
    })
    .safeParse(await rpc(db, "control_job", { p_job_id: j.id, p_action: parsed.data.action }));
  if (!r.success) throw new ChatActionError("unavailable");
  return {
    jobId: r.data.job_id,
    control: r.data.control,
    controlRequestedAt: r.data.control_requested_at,
    status: r.data.status,
  };
}

const artifactRow = z.object({
  id: artifactIdSchema,
  owner_user_id: z.string(),
  chat_id: z.string(),
  job_id: z.string().nullable(),
  run_id: z.string().nullable(),
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string(),
  mime: z.enum(ARTIFACT_MIMES),
  bytes: z.number().int(),
  created_by: z.enum(["runtime", "owner"]),
  created_at: z.string(),
});
const ARTIFACT_COLUMNS =
  "id, owner_user_id, chat_id, job_id, run_id, kind, title, mime, bytes, created_by, created_at";
const toArtifact = (r: z.infer<typeof artifactRow>): ArtifactView => ({
  artifactId: r.id,
  jobId: r.job_id,
  runId: r.run_id,
  kind: r.kind,
  title: r.title,
  mime: r.mime,
  bytes: r.bytes,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export async function listArtifactsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
): Promise<ArtifactView[]> {
  const chat = await ownChat(db, user, rawChatId);
  const { data, error } = await db
    .from("chat_artifacts")
    .select(ARTIFACT_COLUMNS)
    .eq("chat_id", chat.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) fail();
  const rows = z.array(artifactRow).parse(data);
  assertOwned(user, rows);
  if (rows.some((r) => r.chat_id !== chat.id)) throw new OwnershipViolationError();
  return rows.map(toArtifact);
}

/** Owner text attachments: 64 KiB of text or markdown, redacted by the database. */
export const ATTACHMENT_MAX_BYTES = 64 * 1024;
/** HTTP body cap for an attachment post (content JSON-escaped + envelope). */
export const ATTACHMENT_POST_MAX_BYTES = 400 * 1024;
export const attachmentInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z
      .string()
      .min(1)
      .refine((v) => new TextEncoder().encode(v).length <= ATTACHMENT_MAX_BYTES, "too large"),
    mime: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
  })
  .strict();

export async function addAttachmentAs(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawInput: unknown,
): Promise<ArtifactView> {
  const chat = await ownChat(db, user, rawChatId);
  const parsed = attachmentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some(
      (i) => i.path[0] === "content" && i.message === "too large",
    );
    throw new ChatActionError(tooLarge ? "too_long" : "invalid");
  }
  const r = z
    .object({
      artifact_id: artifactIdSchema,
      chat_id: z.string(),
      job_id: z.string().nullable(),
      run_id: z.string().nullable(),
      kind: z.enum(ARTIFACT_KINDS),
      title: z.string(),
      mime: z.enum(ARTIFACT_MIMES),
      bytes: z.number().int(),
      created_by: z.enum(["runtime", "owner"]),
      created_at: z.string(),
    })
    .safeParse(
      await rpc(db, "add_chat_attachment", {
        p_chat_id: chat.id,
        p_title: parsed.data.title,
        p_content: parsed.data.content,
        p_mime: parsed.data.mime,
      }),
    );
  if (!r.success) throw new ChatActionError("unavailable");
  return toArtifact({ ...r.data, id: r.data.artifact_id, owner_user_id: user.id });
}

export async function deleteArtifactAs(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawArtifactId: unknown,
): Promise<void> {
  const chat = await ownChat(db, user, rawChatId);
  const id = artifactIdSchema.safeParse(rawArtifactId);
  if (!id.success) throw new ChatActionError("artifact_not_found");
  const { data, error } = await db
    .from("chat_artifacts")
    .select("id, owner_user_id, chat_id")
    .eq("id", id.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) fail();
  const a = data
    ? z.object({ id: z.string(), owner_user_id: z.string(), chat_id: z.string() }).parse(data)
    : null;
  if (!a || a.chat_id !== chat.id) throw new ChatActionError("artifact_not_found");
  assertOwned(user, [a]);
  await rpc(db, "delete_chat_artifact", { p_artifact_id: a.id });
}

/** A download-safe file name: letters, digits, dot, dash, underscore and spaces only. */
export function artifactFilename(title: string, mime: string): string {
  const base =
    title
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9 ._-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .trim()
      .slice(0, 80) || "artifact";
  const ext =
    mime === "text/markdown"
      ? ".md"
      : mime === "text/x-diff"
        ? ".diff"
        : mime === "application/json"
          ? ".json"
          : ".txt";
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

/** The artifact's (already redacted) text, for a download. Null when not this chat's. */
export async function readArtifactFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawChatId: unknown,
  rawArtifactId: unknown,
): Promise<{ filename: string; mime: string; content: string } | null> {
  const chat = await ownChat(db, user, rawChatId);
  const id = artifactIdSchema.safeParse(rawArtifactId);
  if (!id.success) return null;
  const { data, error } = await db
    .from("chat_artifacts")
    .select("id, owner_user_id, chat_id, title, mime, content")
    .eq("id", id.data)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) fail();
  if (!data) return null;
  const a = z
    .object({
      id: z.string(),
      owner_user_id: z.string(),
      chat_id: z.string(),
      title: z.string(),
      mime: z.enum(ARTIFACT_MIMES),
      content: z.string(),
    })
    .parse(data);
  assertOwned(user, [a]);
  if (a.chat_id !== chat.id) return null;
  return { filename: artifactFilename(a.title, a.mime), mime: a.mime, content: a.content };
}

// ---------------------------------------------------------------------------
// Search, read cursor, host status
// ---------------------------------------------------------------------------
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(100),
    limit: z.number().int().min(1).max(50).default(20),
    // Optional filters (applied by the database to the newest hits).
    projectId: z
      .string()
      .regex(/^tlrom_[0-9a-f]{32}$/)
      .optional(),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,39}$/)
      .optional(),
    mode: z.enum(JOB_MODES).optional(),
    /** running = a job is running in the chat; idle = none. */
    status: z.enum(["running", "idle"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const searchRow = z.object({
  kind: z.enum(["chat", "project", "message", "finding", "decision", "artifact"]),
  chat_id: z.string(),
  chat_name: z.string(),
  ref_id: z.string(),
  snippet: z.string().nullable(),
  chat_seq: z.coerce.number().int().nullable(),
  at: z.string(),
});

export async function searchChatsAs(
  db: SupabaseClient,
  rawQuery: unknown,
): Promise<ChatSearchResult[]> {
  const q = valid(searchQuerySchema, rawQuery);
  const filters = Object.fromEntries(
    (["projectId", "provider", "mode", "status", "from", "to"] as const)
      .filter((k) => q[k] !== undefined)
      .map((k) => [k, q[k]]),
  );
  const data = await rpc(
    db,
    "search_my_chats",
    Object.keys(filters).length > 0
      ? { p_query: q.q, p_limit: q.limit, p_filters: filters }
      : { p_query: q.q, p_limit: q.limit },
  );
  const rows = z.array(searchRow).safeParse(data);
  if (!rows.success) throw new ChatActionError("unavailable");
  return rows.data.map((r) => ({
    kind: r.kind,
    chatId: r.chat_id,
    chatName: r.chat_name,
    refId: r.ref_id,
    snippet: r.snippet ?? "",
    chatSeq: r.chat_seq,
    at: r.at,
  }));
}

/** 0.10 read cursor: up to a chat_seq (never past the newest row, never back). */
export async function markChatReadSeqAs(
  db: SupabaseClient,
  rawChatId: unknown,
  rawChatSeq: unknown,
): Promise<{ lastReadChatSeq: number; lastReadSeq: number }> {
  const data = await rpc(db, "mark_chat_read_seq", {
    p_chat_id: valid(chatIdSchema, rawChatId),
    p_chat_seq: valid(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), rawChatSeq),
  });
  const r = z
    .object({ last_read_chat_seq: z.coerce.number(), last_read_seq: z.coerce.number() })
    .safeParse(data);
  if (!r.success) throw new ChatActionError("unavailable");
  return { lastReadChatSeq: r.data.last_read_chat_seq, lastReadSeq: r.data.last_read_seq };
}

const hostRow = z.object({
  now: z.string(),
  runtime: z
    .object({
      label: z.string(),
      presence: z.enum(["online", "offline", "working"]),
      last_seen_at: z.string().nullable(),
      protocol: z.number().int(),
      needs_update: z.boolean(),
    })
    .passthrough()
    .nullable(),
  agents: z.array(
    z.object({
      provider: z.string(),
      name: z.string(),
      short_name: z.string(),
      health: z.enum(PROVIDER_HEALTH),
      state: z.union([z.enum(PROVIDER_HEALTH), z.literal("stale")]),
      checked_at: z.string().nullable(),
    }),
  ),
});

/** "Runs on <label>" + presence + each agent's health with the time of the check. */
export async function getHostStatusAs(
  db: SupabaseClient,
  rawChatId: unknown,
): Promise<ChatHostStatus> {
  const data = await rpc(db, "chat_host_status", { p_chat_id: valid(chatIdSchema, rawChatId) });
  const h = hostRow.safeParse(data);
  if (!h.success) throw new ChatActionError("unavailable");
  const now = Date.parse(h.data.now);
  return {
    now: h.data.now,
    runtime: h.data.runtime
      ? {
          label: h.data.runtime.label,
          presence: h.data.runtime.presence,
          lastSeenAt: h.data.runtime.last_seen_at,
          protocol: h.data.runtime.protocol,
          needsUpdate: h.data.runtime.needs_update,
        }
      : null,
    agents: h.data.agents.map((a) => ({
      provider: a.provider,
      name: a.name,
      shortName: a.short_name,
      health: a.health,
      state: a.state as HealthState,
      checkedAt: a.checked_at,
      label: healthStateLabel(
        a.state as HealthState,
        a.checked_at,
        Number.isFinite(now) ? now : Date.now(),
      ),
    })),
  };
}

export { FINDING_STATES };

// ---------------------------------------------------------------------------
// Project hub (owner): verification commands, repository, execution host
// ---------------------------------------------------------------------------
export type ProjectHub = {
  roomId: string;
  name: string;
  verificationCommands: string[];
  /** Tooling the Runtime reported for the workspace; none is reported in 0.10 ([]). */
  detectedTooling: string[];
  repository: { remote: string | null; branch: string | null } | null;
  executionHost: {
    label: string;
    online: boolean;
    version: string | null;
    protocol: number | null;
  } | null;
};

const ONLINE_MS = 2 * 60 * 1000;

/** One project's hub facts, owner-scoped (RLS + re-check). Null when not the caller's. */
export async function getProjectHubFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawRoomId: unknown,
  now: number = Date.now(),
): Promise<ProjectHub | null> {
  const roomId = z
    .string()
    .regex(/^tlrom_[0-9a-f]{32}$/)
    .safeParse(rawRoomId);
  if (!roomId.success) return null;
  const room = await db
    .from("rooms")
    .select("id, owner_user_id, name, status, workspace_id, agent_session_id, verify_commands")
    .eq("id", roomId.data)
    .maybeSingle();
  if (room.error) fail();
  if (!room.data) return null;
  const r = z
    .object({
      id: z.string(),
      owner_user_id: z.string(),
      name: z.string(),
      status: z.string(),
      workspace_id: z.string(),
      agent_session_id: z.string().nullable(),
      verify_commands: z.array(z.string()),
    })
    .parse(room.data);
  assertOwned(user, [r]);
  if (r.status === "deleted") return null;

  const ws = await db
    .from("runtime_workspaces")
    .select("id, owner_user_id, runtime_id, repo_remote, branch")
    .eq("id", r.workspace_id)
    .maybeSingle();
  if (ws.error) fail();
  const w = ws.data
    ? z
        .object({
          id: z.string(),
          owner_user_id: z.string(),
          runtime_id: z.string(),
          repo_remote: z.string().nullable(),
          branch: z.string().nullable(),
        })
        .parse(ws.data)
    : null;
  let host: ProjectHub["executionHost"] = null;
  if (w) {
    assertOwned(user, [w]);
    const rt = await db
      .from("runtimes")
      .select("id, owner_user_id, label, status, last_seen_at, version, protocol")
      .eq("id", w.runtime_id)
      .maybeSingle();
    if (rt.error) fail();
    if (rt.data) {
      const x = z
        .object({
          id: z.string(),
          owner_user_id: z.string(),
          label: z.string(),
          status: z.string(),
          last_seen_at: z.string().nullable(),
          version: z.string().nullable(),
          protocol: z.number().int().nullable().optional(),
        })
        .parse(rt.data);
      assertOwned(user, [x]);
      const seen = x.last_seen_at ? Date.parse(x.last_seen_at) : NaN;
      host = {
        label: x.label,
        online: x.status === "active" && Number.isFinite(seen) && now - seen <= ONLINE_MS,
        version: x.version,
        protocol: x.protocol ?? null,
      };
    }
  }
  return {
    roomId: r.id,
    name: r.name,
    verificationCommands: r.verify_commands,
    detectedTooling: [],
    repository:
      w && (w.repo_remote || w.branch) ? { remote: w.repo_remote, branch: w.branch } : null,
    executionHost: host,
  };
}
