/**
 * The one place the Runtime reads what `team_job_write` answers beyond the
 * ids it creates: owner notes, the owner's stop request, and the rule for the
 * model name the Runtime reports. If the server's field names change, this
 * file changes and nothing else does.
 *
 * Everything here is network input. It is parsed field by field; anything
 * malformed is dropped (a note) or ignored (a stop flag that is not a string),
 * never guessed at.
 */

import { createHash } from "node:crypto";

import { AGENT_PROVIDERS, type AgentProvider } from "./types.ts";

/** Who an owner note is addressed to. `team` (or no audience) means every agent. */
export type NoteAudience = AgentProvider | "team";

export type OwnerNote = {
  id: string;
  audience: NoteAudience;
  body: string;
  createdAt: string | null;
};

/** The op the orchestrator sends to collect undelivered owner notes. */
export const READ_OWNER_NOTES_OP = "read_owner_notes";

const NOTE_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 4_000;

/** `modelObserved` as the server accepts it (collaboration-chat.md §3). */
export const MODEL_OBSERVED_PATTERN = /^[A-Za-z0-9._:[\]/-]{1,100}$/;

/** The model to report on a message, or undefined when it is unknown or unreportable. */
export function modelObserved(value: string | null | undefined): string | undefined {
  return typeof value === "string" && MODEL_OBSERVED_PATTERN.test(value) ? value : undefined;
}

/**
 * Notes from a `read_owner_notes` answer: `{ ownerNotes: [{ id, seq, audience,
 * body, createdAt }] }` (lib/team/client-api.ts; `notes` is accepted as the
 * same list). A note with a missing id or body, or an audience that is not a
 * known agent, `team` or null, is dropped.
 */
export function parseOwnerNotes(answer: unknown): OwnerNote[] {
  if (!answer || typeof answer !== "object") return [];
  const a = answer as Record<string, unknown>;
  const raw = a.ownerNotes ?? a.notes;
  if (!Array.isArray(raw)) return [];
  const notes: OwnerNote[] = [];
  for (const item of raw.slice(0, MAX_NOTES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || !NOTE_ID.test(n.id)) continue;
    if (typeof n.body !== "string" || !n.body.trim()) continue;
    let audience: NoteAudience;
    if (n.audience === null || n.audience === undefined || n.audience === "team") audience = "team";
    else if (isProvider(n.audience)) audience = n.audience;
    else continue;
    notes.push({
      id: n.id,
      audience,
      body: n.body.slice(0, MAX_NOTE_CHARS),
      createdAt: typeof n.createdAt === "string" ? n.createdAt.slice(0, 40) : null,
    });
  }
  return notes;
}

/**
 * True when a job state answer says the owner asked the job to stop. The
 * server sends `stopRequestedAt` as an ISO timestamp or null.
 */
export function stopRequested(answer: unknown): boolean {
  if (!answer || typeof answer !== "object") return false;
  const value = (answer as Record<string, unknown>).stopRequestedAt;
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// 0.9 carrier fields (docs/design/chat-first.md §2, §4, §5)
// ---------------------------------------------------------------------------

/** The roles a carrier may pin to a provider (`roleOverrides`). */
export const OVERRIDABLE_ROLES = [
  "coordinator",
  "planner",
  "builder",
  "reviewer",
  "integrator",
] as const;
export type OverridableRole = (typeof OVERRIDABLE_ROLES)[number];

/**
 * Thrown for a carrier field that is present but malformed. The job parser
 * turns it into a refusal of the whole job: a role override or participant
 * list that cannot be read is never guessed at.
 */
export class WireFieldError extends Error {}

const CHAT_ID = /^tlcht_[0-9a-f]{32}$/;
const PROVIDERS: readonly AgentProvider[] = AGENT_PROVIDERS;
const isProvider = (v: unknown): v is AgentProvider =>
  typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);

/** `roleOverrides`: absent/null → none. Unknown role keys or providers fail. */
export function parseRoleOverrides(
  value: unknown,
): Partial<Record<OverridableRole, AgentProvider>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WireFieldError("roleOverrides must be an object.");
  }
  const out: Partial<Record<OverridableRole, AgentProvider>> = {};
  for (const [key, provider] of Object.entries(value as Record<string, unknown>)) {
    if (!(OVERRIDABLE_ROLES as readonly string[]).includes(key)) {
      throw new WireFieldError(
        `roleOverrides.${key.slice(0, 40)} is not a role that can be chosen.`,
      );
    }
    if (provider === null || provider === undefined) continue;
    if (!isProvider(provider)) {
      throw new WireFieldError(`roleOverrides.${key} is not a supported provider.`);
    }
    out[key as OverridableRole] = provider;
  }
  return out;
}

/** `participants`: provider ids. Absent/null → null (use the room's agents). */
export function parseParticipants(value: unknown): AgentProvider[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new WireFieldError("participants must be a short, non-empty list.");
  }
  const out: AgentProvider[] = [];
  for (const p of value) {
    if (!isProvider(p)) throw new WireFieldError("participants names an unsupported provider.");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `chatId`: absent/null → null; otherwise a ThreadLink chat id. */
export function parseChatId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CHAT_ID.test(value)) {
    throw new WireFieldError("chatId is malformed.");
  }
  return value;
}

/**
 * The `set_final` payload. `provider` (0.9, optional) names the agent a
 * verdict is about -- who needs to sign in, who is out of usage -- so the
 * chat can name it from trusted state.
 */
export function setFinalPayload(input: {
  verdict: string;
  summary: string;
  reason?: string;
  provider?: AgentProvider | null;
  evidence: unknown;
}): Record<string, unknown> {
  return {
    verdict: input.verdict,
    summary: input.summary,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    evidence: input.evidence,
  };
}

// ---------------------------------------------------------------------------
// 0.10 (docs/design/threadlink-0.10.md §2-§6)
//
// Every op the Runtime sends that is new in 0.10 is built here, and every
// field it reads back is parsed here, so the server's exact names can be
// reconciled in this file alone. Answers are parsed tolerantly (a field the
// server does not send is null) and fail closed (a malformed id is null,
// never guessed; an unknown control or choice status is ignored).
// ---------------------------------------------------------------------------

/**
 * docs/design/threadlink-0.10.md §8. Sent in register and heartbeat. 11 =
 * ThreadLink 0.11 (Fast Chat lane, wake long-poll, failover, timings); the
 * server keeps accepting 10.
 */
export const RUNTIME_PROTOCOL = 11;

export const OPS_0_10 = {
  runStarted: "run_started",
  runActivity: "run_activity",
  runFinished: "run_finished",
  requestChoice: "request_choice",
  readChoices: "read_choices",
  addChange: "add_change",
  addArtifact: "add_artifact",
  ackControl: "ack_control",
} as const;

// lib/team/model.ts (runIdSchema, choiceIdSchema, run_finished.nativeSessionId).
const RUN_ID = /^tlarn_[0-9a-f]{32}$/;
const EVENT_ID = /^[A-Za-z0-9_:-]{1,64}$/;
const CHOICE_ID = /^tlchc_[0-9a-f]{32}$/;
const NATIVE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const NOTE_EVENT_ID = /^tlcev_[0-9a-f]{32}$/;
const FINDING_ID = /^[A-Za-z0-9_:-]{1,80}$/;

function pick(answer: unknown, ...keys: string[]): unknown {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const a = answer as Record<string, unknown>;
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) return a[k];
  return undefined;
}

/** Access modes, as agent_runs.access accepts them. */
export type WireAccess = "read-only" | "workspace-write";
export type RunContinuity = "fresh" | "resumed" | "forked";
export type RunEndStatus = "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
/** agent_runs.failure: a fixed category, never provider text. */
export type RunFailureCategory =
  | "not_authenticated"
  | "quota_exhausted"
  | "timeout"
  | "model_mismatch"
  | "access_mismatch"
  | "cancelled"
  | "crashed"
  | "provider_error";

/** run_started. `runKey` makes it idempotent: the same key returns the same run. */
export function runStartedPayload(input: {
  runKey: string;
  provider: string;
  participantKey: string;
  role: string;
  requestedModel: string;
  effort: string | null;
  access: WireAccess;
  nodeKey: string | null;
  worktreeLabel: string | null;
  timeoutMs: number;
  continuity: RunContinuity;
  resumedFromRunKey: string | null;
  /** The run's phase activity at start (the server's first last_activity_at). */
  activity: string | null;
  /** 0.11 (§3.4.6): why this run's native session is fresh or resumed. */
  sessionReason?: SessionReason | null;
}): Record<string, unknown> {
  return {
    runKey: wireKey(input.runKey),
    provider: input.provider,
    participantKey: input.participantKey,
    role: input.role,
    requestedModel: input.requestedModel,
    effort: input.effort,
    access: input.access,
    ...(input.nodeKey ? { nodeKey: input.nodeKey } : {}),
    ...(input.worktreeLabel ? { worktreeLabel: input.worktreeLabel } : {}),
    timeoutMs: input.timeoutMs,
    continuity: input.continuity,
    ...(input.resumedFromRunKey ? { resumedFromRunKey: wireKey(input.resumedFromRunKey) } : {}),
    ...(input.activity ? { activity: input.activity } : {}),
    ...(input.sessionReason ? { sessionReason: input.sessionReason } : {}),
  };
}

/** The run id from a run_started answer (`runId`), or null. */
export function parseRunId(answer: unknown): string | null {
  const v = pick(answer, "runId", "run_id");
  return typeof v === "string" && RUN_ID.test(v) ? v : null;
}

export function runActivityPayload(runId: string, activity: string): Record<string, unknown> {
  return { runId, activity };
}

export function runFinishedPayload(input: {
  runId: string;
  status: RunEndStatus;
  observedModel: string | null;
  modelVerified: boolean;
  accessVerified: boolean;
  nativeSessionId: string | null;
  nativeSessionKind: string | null;
  failure: RunFailureCategory | null;
  /** The provider process exited cleanly (verification.exitClean). */
  exitClean: boolean;
  /** 0.11 (§3.6): per-run timings. Only the known, non-negative integer ones are sent. */
  timings?: Partial<RunTimings> | null;
}): Record<string, unknown> {
  const sessionId =
    input.nativeSessionId && NATIVE_SESSION_ID.test(input.nativeSessionId)
      ? input.nativeSessionId
      : null;
  return {
    runId: input.runId,
    status: input.status,
    observedModel: modelObserved(input.observedModel) ?? null,
    // The server verifies a model only against an observed model it stores.
    modelVerified: input.modelVerified && modelObserved(input.observedModel) !== undefined,
    accessVerified: input.accessVerified,
    nativeSessionId: sessionId,
    nativeSessionKind: sessionId ? input.nativeSessionKind : null,
    ...(input.failure ? { failure: input.failure } : {}),
    exitClean: input.exitClean,
    ...timingsField(input.timings),
  };
}

// ---------------------------------------------------------------------------
// 0.11 (docs/design/threadlink-0.11.md §2-§5)
// ---------------------------------------------------------------------------

export const OPS_0_11 = {
  readChatContext: "read_chat_context",
  failoverNotice: "failover_notice",
} as const;

/** run_started.sessionReason (§3.4.6). */
export const SESSION_REASONS = [
  "resumed",
  "fresh_first_turn",
  "fresh_rotated",
  "fresh_resume_failed",
] as const;
export type SessionReason = (typeof SESSION_REASONS)[number];

export const RUN_TIMING_KEYS = [
  "queueMs",
  "spawnMs",
  "contextMs",
  "firstEventMs",
  "providerMs",
  "persistMs",
] as const;
export type RunTimings = Record<(typeof RUN_TIMING_KEYS)[number], number>;

/** `{ timings }` with only non-negative integers (capped at a day), or nothing. */
function timingsField(timings: Partial<RunTimings> | null | undefined): Record<string, unknown> {
  if (!timings) return {};
  const out: Record<string, number> = {};
  for (const key of RUN_TIMING_KEYS) {
    const v = timings[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = Math.min(Math.round(v), 86_400_000);
    }
  }
  return Object.keys(out).length ? { timings: out } : {};
}

/** A job's lane (§2): chat (Fast Chat) or work (Engineering Work). */
export type JobLane = "chat" | "work";
/** The owner's failover preference, snapshotted on the job (§5). */
export type FailoverPolicy = "auto" | "ask" | "wait";

export type ChatContextMessage = {
  id: string;
  chatSeq: number | null;
  authorKind: string;
  authorProviderId: AgentProvider | null;
  authorLabel: string | null;
  replyTo: string | null;
  body: string;
  createdAt: string | null;
};

const CONTEXT_MAX_MESSAGES = 40;
const CONTEXT_MAX_BODY = 4_000;

/** read_chat_context `{limit}` (≤ 40). */
export function readChatContextPayload(limit: number): Record<string, unknown> {
  return { limit: Math.max(1, Math.min(CONTEXT_MAX_MESSAGES, Math.floor(limit))) };
}

/**
 * read_chat_context: `{ chatContext: [{id, chatSeq, authorKind, authorProviderId,
 * authorLabel, replyTo, body, createdAt}] }`, newest last. Malformed entries are
 * dropped; bodies are bounded. Newest-last order is kept (re-sorted by chatSeq
 * when every entry has one).
 */
export function parseChatContext(answer: unknown): ChatContextMessage[] {
  // The server answers `chatContext` (lib/team/client-api.ts); `messages` is accepted too.
  const raw = pick(answer, "chatContext", "messages");
  if (!Array.isArray(raw)) return [];
  const out: ChatContextMessage[] = [];
  for (const item of raw.slice(-CONTEXT_MAX_MESSAGES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== "string" || !EVENT_ID.test(id)) continue;
    if (typeof m.body !== "string" || !m.body.trim()) continue;
    const kind = typeof m.authorKind === "string" ? m.authorKind.slice(0, 20) : "unknown";
    const provider = isProvider(m.authorProviderId) ? m.authorProviderId : null;
    const seq = m.chatSeq;
    out.push({
      id,
      chatSeq: typeof seq === "number" && Number.isInteger(seq) ? seq : null,
      authorKind: kind,
      authorProviderId: provider,
      authorLabel: typeof m.authorLabel === "string" ? m.authorLabel.slice(0, 80) : null,
      replyTo: typeof m.replyTo === "string" && EVENT_ID.test(m.replyTo) ? m.replyTo : null,
      body: m.body.slice(0, CONTEXT_MAX_BODY),
      createdAt: typeof m.createdAt === "string" ? m.createdAt.slice(0, 40) : null,
    });
  }
  if (out.every((m) => m.chatSeq !== null)) out.sort((a, b) => a.chatSeq! - b.chatSeq!);
  return out;
}

/** failover_notice `{from, to|null, reviewPending, resetsAt|null}` (§5). */
export function failoverNoticePayload(input: {
  from: AgentProvider;
  to: AgentProvider | null;
  reviewPending: boolean;
  resetsAt: string | null;
}): Record<string, unknown> {
  const reset =
    input.resetsAt && Number.isFinite(Date.parse(input.resetsAt))
      ? new Date(Date.parse(input.resetsAt)).toISOString()
      : null;
  return {
    from: input.from,
    to: input.to,
    reviewPending: input.reviewPending,
    resetsAt: reset,
  };
}

/** A reference a chat row can reply to (§3). */
export type WireRef = {
  kind: "finding" | "decision" | "node" | "artifact" | "message";
  id: string;
};

/** add_message, 0.10: tied to its run, optionally a reply. */
export function messagePayload(input: {
  sender: string;
  senderRole: string | null;
  receiver: string | null;
  node: string | null;
  type: string;
  round: number;
  body: string;
  modelObserved: string | null;
  runId: string | null;
  replyTo: WireRef | null;
  refs: WireRef[];
}): Record<string, unknown> {
  const model = modelObserved(input.modelObserved);
  return {
    sender: input.sender,
    ...(input.senderRole ? { senderRole: input.senderRole } : {}),
    receiver: input.receiver,
    ...(input.node ? { node: input.node } : {}),
    type: input.type,
    round: input.round,
    body: input.body,
    ...(model ? { modelObserved: model } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.refs.length > 1 ? { refs: input.refs.slice(0, 20) } : {}),
  };
}

/**
 * The id a reply can point at: the team message (`messageId`, tlamg_) or its
 * chat row (`eventId`, tlcev_); the server accepts either as a message ref.
 */
export function parseMessageId(answer: unknown): string | null {
  const v = pick(answer, "messageId", "eventId", "chatEventId");
  return typeof v === "string" && EVENT_ID.test(v) ? v : null;
}

/** add_finding, 0.10 additions: raising run and the unit owner's participant key. */
export function findingPayload(
  base: Record<string, unknown>,
  extra: { runId: string | null; ownerParticipant: string | null },
): Record<string, unknown> {
  return {
    ...base,
    ...(extra.runId ? { runId: extra.runId } : {}),
    ...(extra.ownerParticipant ? { ownerParticipant: extra.ownerParticipant } : {}),
  };
}

export function parseFindingId(answer: unknown): string | null {
  const v = pick(answer, "findingId");
  return typeof v === "string" && FINDING_ID.test(v) ? v : null;
}

export const FINDING_LIFECYCLE = [
  "open",
  "accepted",
  "disputed",
  "fixed",
  "resolved",
  "dismissed",
] as const;
export type FindingLifecycle = (typeof FINDING_LIFECYCLE)[number];

export function findingStatusPayload(input: {
  findingId: string;
  status: FindingLifecycle;
  runId: string | null;
  round: number;
  /** Dismissing a blocking/important finding needs the decision that settled it. */
  decisionNumber?: number | null;
}): Record<string, unknown> {
  return {
    findingId: input.findingId,
    status: input.status,
    round: input.round,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.decisionNumber ? { decisionNumber: input.decisionNumber } : {}),
  };
}

/** The decision number the server gave an add_decision, when it gave one. */
export function parseDecisionNumber(answer: unknown): number | null {
  const v = pick(answer, "decisionNumber", "number");
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * The only titles a ThreadLink-titled decision may have: the server's
 * `threadlink_private.decision_fixed_titles()` (migration
 * 20260927000200_threadlink_0_10.sql), exactly.
 */
export const THREADLINK_DECISION_TITLES = [
  "Roles chosen",
  "Plan agreed",
  "Plan changed",
  "Work split into units",
  "Unit owner changed",
  "Reviewer chosen",
  "Finding dismissed",
  "Finding disputed",
  "Disagreement settled",
  "Integration order chosen",
  "Merge conflict resolved",
  "Model chosen",
  "Timeout extended",
  "Retry chosen",
  "Agent replaced",
  "Stopped by you",
  "Resumed after interruption",
  "Plan not agreed",
  "Agents disagree",
  "Out-of-scope changes undone",
  "Unit cannot start",
  "Merge conflict",
  "No model available",
] as const;

/**
 * The Runtime's decision topics mapped to the server's fixed titles. A topic
 * with no honest fixed title maps to null and is not sent as a decision
 * (the orchestrator keeps it in evidence). Listed in §12 for the server.
 */
const DECISION_TITLE_FOR: Record<string, (typeof THREADLINK_DECISION_TITLES)[number] | null> = {
  Roles: "Roles chosen",
  "Plan recorded": "Plan agreed",
  "Plan agreed": "Plan agreed",
  "Unit reassigned": "Unit owner changed",
  "Units run one after the other": "Integration order chosen",
  "Ownership committed": "Work split into units",
  "Plan not agreed": "Plan not agreed",
  "Agents disagree": "Agents disagree",
  "Out-of-scope changes undone": "Out-of-scope changes undone",
  "Unit cannot start from its dependency": "Unit cannot start",
  "Merge conflict": "Merge conflict",
  "Finding dismissed": "Finding dismissed",
  "No model to use": "No model available",
  "Disagreement settled": "Disagreement settled",
};

export function threadlinkDecisionTitle(topic: string): string | null {
  return Object.prototype.hasOwnProperty.call(DECISION_TITLE_FOR, topic)
    ? DECISION_TITLE_FOR[topic]!
    : null;
}

/** add_decision, 0.10: where its title came from (§4). */
export function decisionPayload(
  base: Record<string, unknown>,
  source: { titleSource: "threadlink" } | { titleSource: "agent"; runId: string },
): Record<string, unknown> {
  return { ...base, ...source };
}

export const CHOICE_KIND_OPTIONS = {
  provider_failure: ["retry", "use_other", "stop"],
  timeout: ["retry", "retry_other", "increase_timeout", "stop"],
  plan_disagreement: ["extra_round", "stop"],
  interrupted: ["resume", "stop"],
  // 0.11 (§5, §2.5)
  usage_exhausted: ["continue_other", "check_again", "wait", "stop"],
  start_work: ["run_work", "keep_chatting"],
} as const;
export type RuntimeChoiceKind = keyof typeof CHOICE_KIND_OPTIONS;
export type ChoiceOptionKey<K extends RuntimeChoiceKind> = (typeof CHOICE_KIND_OPTIONS)[K][number];

/**
 * request_choice. `params` are trusted runtime state only (provider ids,
 * step kinds, unit keys, durations); the server builds the title and labels
 * from its per-kind allow-list. `options` is a subset of that allow-list.
 */
export function requestChoicePayload<K extends RuntimeChoiceKind>(
  kind: K,
  params: Record<string, string | number | null>,
  options: readonly ChoiceOptionKey<K>[],
  idempotencyKey: string,
  runId: string | null = null,
): Record<string, unknown> {
  const allowed = CHOICE_KIND_OPTIONS[kind] as readonly string[];
  return {
    kind,
    params,
    options: options.filter((o) => allowed.includes(o)).map((key) => ({ key })),
    idempotencyKey: wireKey(idempotencyKey),
    ...(runId ? { runId } : {}),
  };
}

export function parseChoiceId(answer: unknown): string | null {
  const v = pick(answer, "choiceId");
  return typeof v === "string" && CHOICE_ID.test(v) ? v : null;
}

export type ChoiceState = {
  id: string;
  status: "pending" | "chosen" | "expired" | "cancelled";
  chosenKey: string | null;
};

/** read_choices: `{ choices: [{ id, status, chosenKey }] }`. Malformed entries are dropped. */
export function parseChoices(answer: unknown): ChoiceState[] {
  const raw = pick(answer, "choices");
  if (!Array.isArray(raw)) return [];
  const out: ChoiceState[] = [];
  for (const item of raw.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const id = c.id ?? c.choiceId;
    if (typeof id !== "string" || !CHOICE_ID.test(id)) continue;
    const status = c.status;
    if (
      status !== "pending" &&
      status !== "chosen" &&
      status !== "expired" &&
      status !== "cancelled"
    )
      continue;
    const chosen = c.chosenKey ?? c.chosen_key;
    out.push({
      id,
      status,
      chosenKey: typeof chosen === "string" && /^[a-z_]{1,40}$/.test(chosen) ? chosen : null,
    });
  }
  return out;
}

export function readChoicesPayload(choiceIds: string[]): Record<string, unknown> {
  return { choiceIds: choiceIds.slice(0, 20) };
}

/**
 * add_change (§4): a unit's real diffstat from its worktree, tied to the
 * builder's run (required by the server), with the diff itself, which the
 * server stores as the change's diff artifact.
 */
export function changePayload(input: {
  nodeKey: string;
  runId: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  branch: string;
  commit: string;
  tests: { command: string; ok: boolean }[];
  diff: string | null;
}): Record<string, unknown> {
  return {
    nodeKey: input.nodeKey,
    runId: input.runId,
    filesChanged: input.filesChanged,
    insertions: input.insertions,
    deletions: input.deletions,
    files: input.files.filter((f) => f.length > 0 && f.length <= 512).slice(0, 200),
    branch: input.branch,
    commit: input.commit,
    tests: input.tests.slice(0, 20),
    ...(input.diff && input.diff.trim() ? { diff: cutBytes(input.diff) } : {}),
  };
}

function cutBytes(text: string): string {
  if (Buffer.byteLength(text) <= ARTIFACT_MAX_BYTES) return text;
  const note = "\n\n[cut to 512 KiB by ThreadLink]\n";
  return (
    Buffer.from(text)
      .subarray(0, ARTIFACT_MAX_BYTES - Buffer.byteLength(note))
      .toString("utf8")
      .replace(/\uFFFD$/, "") + note
  );
}

export const ARTIFACT_MAX_BYTES = 512 * 1024;
export type ArtifactKind = "report" | "plan" | "diff" | "test_report" | "notes" | "export";
export type ArtifactMime = "text/plain" | "text/markdown" | "text/x-diff" | "application/json";

/** add_artifact. Content is already redacted and is cut to 512 KiB here. */
export function artifactPayload(input: {
  kind: ArtifactKind;
  title: string;
  mime: ArtifactMime;
  content: string;
  runId: string | null;
  /** Idempotency: the same key stores the artifact once. */
  requestKey?: string | null;
  nodeKey?: string | null;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    title: input.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Artifact",
    mime: input.mime,
    content: cutBytes(input.content),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.requestKey ? { requestKey: wireKey(input.requestKey) } : {}),
    ...(input.nodeKey ? { nodeKey: input.nodeKey } : {}),
  };
}

/**
 * read_owner_notes, 0.10: records which run consumed which notes (§5
 * delivery). Null when no note id is one the server can record.
 */
export function notesConsumedPayload(
  runId: string,
  noteIds: string[],
): Record<string, unknown> | null {
  const ids = noteIds.filter((id) => NOTE_EVENT_ID.test(id)).slice(0, 20);
  return ids.length ? { consumedByRunId: runId, noteIds: ids } : null;
}

/** ack_control: the control was honoured at its boundary. */
export function ackControlPayload(control: string): Record<string, unknown> {
  return { control };
}

export const JOB_CONTROLS = [
  "pause_after_step",
  "stop_after_review",
  "stop_before_integration",
  "stop_now",
  "cancel_queued",
  "resume",
] as const;
export type JobControl = (typeof JOB_CONTROLS)[number];

/**
 * The owner's control on a job, from any team_job_write answer: `control`
 * (one of JOB_CONTROLS, or null) with `controlRequestedAt`. The 0.9 stop flag
 * (`stopRequestedAt`) is read as `cancel_queued`: the current round finishes
 * and nothing new starts, exactly what it meant then. Anything else: null.
 */
export function parseControl(
  answer: unknown,
): { control: JobControl; requestedAt: string | null } | null {
  const raw = pick(answer, "control");
  if (typeof raw === "string" && (JOB_CONTROLS as readonly string[]).includes(raw)) {
    const at = pick(answer, "controlRequestedAt");
    return {
      control: raw as JobControl,
      requestedAt: typeof at === "string" ? at.slice(0, 40) : null,
    };
  }
  if (stopRequested(answer)) {
    const at = pick(answer, "stopRequestedAt");
    return {
      control: "cancel_queued",
      requestedAt: typeof at === "string" ? at.slice(0, 40) : null,
    };
  }
  return null;
}

/**
 * True when a team_job_write error is the server refusing a write-role
 * run_started because the job was interrupted and the owner has not answered
 * `resume` yet (§6). Read from the error's `kind` (ApiError: the server's
 * `error` field) or message. Reconcile the exact code here.
 */
export function isInterruptedRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { kind?: unknown; message?: unknown; hint?: unknown; reason?: unknown };
  // The server's code for this refusal is `interrupted_needs_owner`, passed
  // through as ApiError.reason; the other words are kept for older servers.
  if (e.reason === "interrupted_needs_owner") return true;
  const text = [e.kind, e.hint, e.reason, e.message].filter((v) => typeof v === "string").join(" ");
  return /(interrupted|resume_required|awaiting_resume|needs_resume)/i.test(text);
}

const WIRE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * An idempotency key (runKey, request keys) the server stores unchanged: a
 * key already in [A-Za-z0-9._:-]{1,128} is itself; anything else becomes
 * "k:" + the first 32 hex characters of its SHA-256 (the same rule as
 * lib/team/model.ts wireKeyToSql, so both sides agree on the stored key).
 */
export function wireKey(key: string): string {
  if (WIRE_KEY.test(key)) return key;
  return `k:${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}
