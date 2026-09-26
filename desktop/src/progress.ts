/**
 * Honest job progress for the desktop app: pure, Electron-free, unit-tested.
 *
 * Stages, in order: Understanding request · Plan · Build · Review · Integration
 * (solo: no Review). A stage is only ✓ when there is evidence it finished. In
 * particular Plan is never ✓ for a job that stopped before a plan was agreed:
 * a job that ended BLOCKED during normalisation shows "Understanding request ✕"
 * and every later stage "–" (docs/design/chat-first.md §3).
 *
 * When the Runtime sends `stages` (0.9) they are shown as sent. Older Runtimes
 * send only a coarse status, so the stages are derived conservatively here, with
 * the help of the last non-terminal status main saw for the job.
 */

import { providerName, SIGN_IN_INSTRUCTION } from "./health.js";

export const STAGE_KEYS = ["understand", "plan", "build", "review", "integrate"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageState = "done" | "active" | "failed" | "waiting" | "skipped";

export const STAGE_LABELS: Record<StageKey, string> = {
  understand: "Understanding request",
  plan: "Plan",
  build: "Build",
  review: "Review",
  integrate: "Integration",
};

export const STAGE_SYMBOLS: Record<StageState, string> = {
  done: "✓",
  active: "●",
  failed: "✕",
  waiting: "○",
  skipped: "–",
};

export type Stage = { key: StageKey; label: string; state: StageState };

type Row = Record<string, unknown>;
const obj = (v: unknown): Row | null => (v && typeof v === "object" ? (v as Row) : null);
const text = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null;

/** Where each coarse job status sits in the stage list; -1 is "not started". */
const PHASE_INDEX: Record<string, number> = {
  queued: -1,
  claimed: -1,
  starting: -1,
  normalising: 0,
  normalizing: 0,
  planning: 1,
  building: 2,
  reviewing: 3,
  integrating: 4,
  inspecting: 4,
};

export const FINISHED_STATUSES = new Set([
  "completed",
  "needs_fix",
  "blocked",
  "needs_user_decision",
  "failed",
  "cancelled",
]);

const phaseIndex = (s: unknown): number | null =>
  typeof s === "string" && s in PHASE_INDEX ? PHASE_INDEX[s]! : null;

export function isRunning(job: { verdict?: unknown; status?: unknown }): boolean {
  return !job.verdict && !(typeof job.status === "string" && FINISHED_STATUSES.has(job.status));
}

// ---------------------------------------------------------------------------
// Stages the Runtime sent
// ---------------------------------------------------------------------------

function stageKeyOf(raw: unknown): StageKey | null {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!s) return null;
  if ((STAGE_KEYS as readonly string[]).includes(s)) return s as StageKey;
  if (/understand|normali[sz]|spec/.test(s)) return "understand";
  if (/plan/.test(s)) return "plan";
  if (/build/.test(s)) return "build";
  if (/review/.test(s) && !/final/.test(s)) return "review";
  if (/integrat|inspect|final/.test(s)) return "integrate";
  return null;
}

function stageStateOf(raw: unknown): StageState {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (["done", "complete", "completed", "passed", "ok"].includes(s)) return "done";
  if (["active", "running", "in_progress", "current"].includes(s)) return "active";
  if (["failed", "error", "stopped"].includes(s)) return "failed";
  if (["skipped", "not_reached"].includes(s)) return "skipped";
  // Unknown words never claim progress.
  return "waiting";
}

/**
 * The Runtime's `stages`, normalised: each entry `{ key|id|name|label,
 * state|status }`. Null when there is nothing recognisable, so the caller
 * derives instead.
 */
export function normaliseStages(raw: unknown): Stage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Stage[] = [];
  for (const item of raw) {
    const row = obj(item);
    if (!row) continue;
    const key =
      stageKeyOf(row.key) ?? stageKeyOf(row.id) ?? stageKeyOf(row.name) ?? stageKeyOf(row.label);
    if (!key || out.some((s) => s.key === key)) continue;
    out.push({ key, label: STAGE_LABELS[key], state: stageStateOf(row.state ?? row.status) });
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Stages derived from an older Runtime's coarse progress
// ---------------------------------------------------------------------------

export type ProgressUnit = {
  title?: unknown;
  owner?: unknown;
  reviewer?: unknown;
  status?: unknown;
};

export type ProgressLike = {
  status?: unknown;
  verdict?: unknown;
  units?: unknown;
  mode?: unknown;
  planApproved?: unknown;
  plan_approved?: unknown;
  plan?: unknown;
  lastPhase?: unknown;
  last_phase?: unknown;
  stages?: unknown;
};

const NOT_STARTED = new Set(["pending", "ready"]);
const BUILT = new Set(["in_review", "approved", "integrated", "skipped"]);
const REVIEWED = new Set(["approved", "integrated", "skipped"]);

function unitsOf(job: ProgressLike): ProgressUnit[] {
  return Array.isArray(job.units) ? (job.units.filter((u) => obj(u)) as ProgressUnit[]) : [];
}

/** True, false, or undefined when the progress does not say. */
function planApprovedOf(job: ProgressLike): boolean | undefined {
  const plan = obj(job.plan);
  const v = job.planApproved ?? job.plan_approved ?? plan?.approved ?? plan?.planApproved;
  return typeof v === "boolean" ? v : undefined;
}

/** A solo job has no Review stage. */
export function isSolo(job: ProgressLike): boolean {
  if (job.mode === "solo") return true;
  if (job.mode === "pair" || job.mode === "team") return false;
  const units = unitsOf(job);
  return units.length > 0 && units.every((u) => u.reviewer === null);
}

/**
 * Conservative stages from status, verdict, units and the last non-terminal
 * status reached. A stage is done only with evidence; a finished job stopped at
 * the first stage without that evidence (✕), and everything after it is "–".
 */
export function deriveStages(job: ProgressLike, lastPhase?: string | null): Stage[] {
  const keys = STAGE_KEYS.filter((k) => k !== "review" || !isSolo(job));
  const units = unitsOf(job);
  const status = typeof job.status === "string" ? job.status : "";
  const running = isRunning(job);
  const pass = job.verdict === "PASS";
  const approved = planApprovedOf(job);
  const started = units.some((u) => typeof u.status === "string" && !NOT_STARTED.has(u.status));
  const reached = Math.max(
    phaseIndex(status) ?? -1,
    phaseIndex(job.lastPhase ?? job.last_phase) ?? -1,
    phaseIndex(lastPhase) ?? -1,
  );

  const planDone =
    pass ||
    approved === true ||
    (approved === undefined &&
      (started || (running && units.length > 0 && (phaseIndex(status) ?? -1) >= 2)));
  const every = (set: Set<string>) =>
    units.length > 0 && units.every((u) => typeof u.status === "string" && set.has(u.status));

  const done: Record<StageKey, boolean> = {
    understand: pass || planDone || reached >= 1,
    plan: planDone,
    build: pass || (planDone && every(BUILT)),
    review: pass || (planDone && every(REVIEWED)),
    integrate: pass,
  };

  const out: Stage[] = [];
  let hit = false;
  for (const key of keys) {
    let state: StageState;
    if (!hit && done[key]) state = "done";
    else if (!hit) {
      hit = true;
      state = running ? "active" : "failed";
    } else state = running ? "waiting" : "skipped";
    out.push({ key, label: STAGE_LABELS[key], state });
  }
  return out;
}

/** The Runtime's stages when it sent them, otherwise the conservative derivation. */
export function stagesFor(job: ProgressLike, lastPhase?: string | null): Stage[] {
  const sent = normaliseStages(job.stages);
  if (!sent) return deriveStages(job, lastPhase);
  // A solo job sent with a Review stage still shows none.
  return isSolo(job) ? sent.filter((s) => s.key !== "review") : sent;
}

// ---------------------------------------------------------------------------
// Why a finished job stopped
// ---------------------------------------------------------------------------

export type StopReason = { text: string; needsSignIn: boolean; instruction: string | null };

const REASON_TEXT: Record<string, (name: string | null) => string> = {
  agent_needs_sign_in: (n) =>
    n
      ? `${n} needs you to sign in again on this computer.`
      : "An agent needs you to sign in again on this computer.",
  api_key_auth: (n) =>
    `${n ?? "An agent"} is signed in with an API key, which would bill per use; ThreadLink did not use it.`,
  usage_exhausted: (n) => `${n ?? "An agent"} has reached its usage limit.`,
  agent_unavailable: (n) => `${n ?? "An agent"} is not available on this computer.`,
};

/**
 * A plain sentence for a job that ended without passing, from the verdict
 * reason (a fixed code) and the provider it names. Only fixed text is built
 * here; the Runtime's summary is used only when it is itself the sign-in line.
 */
export function stopReason(job: Row): StopReason | null {
  if (!job.verdict || job.verdict === "PASS") return null;
  const reason = text(job.reason ?? job.verdictReason ?? job.verdict_reason, 64);
  const who = job.verdictProvider ?? job.verdict_provider ?? job.blockedProvider;
  const name = who === "claude-code" || who === "codex" ? providerName(who) : null;
  const summary = text(job.summary ?? job.verdictSummary ?? job.verdict_summary, 300);
  const signInSummary = !reason && summary !== null && /\bsign in again\b/i.test(summary);
  if (reason === "agent_needs_sign_in" || signInSummary) {
    const guessed =
      name ??
      (summary?.startsWith("Claude Code")
        ? "Claude Code"
        : summary?.startsWith("Codex")
          ? "Codex"
          : null);
    return {
      text: REASON_TEXT.agent_needs_sign_in!(guessed),
      needsSignIn: true,
      instruction: SIGN_IN_INSTRUCTION,
    };
  }
  if (reason && REASON_TEXT[reason]) {
    return { text: REASON_TEXT[reason]!(name), needsSignIn: false, instruction: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running and recent work, grouped by chat
// ---------------------------------------------------------------------------

/**
 * The last non-terminal status main saw for each job, so a job that ended
 * BLOCKED still shows where it stopped with a Runtime that does not send
 * `stages` or `lastPhase`. Memory only, bounded.
 */
export class PhaseMemory {
  #seen = new Map<string, string>();
  constructor(private readonly max = 200) {}

  observe(jobs: unknown): void {
    if (!Array.isArray(jobs)) return;
    for (const item of jobs) {
      const job = obj(item);
      const id = typeof job?.jobId === "string" ? job.jobId : null;
      if (!id || phaseIndex(job!.status) === null) continue;
      this.#seen.delete(id);
      this.#seen.set(id, job!.status as string);
      if (this.#seen.size > this.max) this.#seen.delete(this.#seen.keys().next().value!);
    }
  }

  get(jobId: unknown): string | null {
    return typeof jobId === "string" ? (this.#seen.get(jobId) ?? null) : null;
  }
}

export type JobView = Row & {
  jobId: string;
  running: boolean;
  stages: Stage[];
  stop: StopReason | null;
};

export type ChatGroupView = {
  key: string;
  /** The chat's name, or the room's when the progress carries no chat. */
  name: string;
  byChat: boolean;
  running: number;
  jobs: JobView[];
};

/**
 * Jobs (newest first, as the Runtime sends them) grouped by chat: by chat id
 * when the progress carries one, else by chat name, else by room. Groups with
 * running work come first; order is otherwise kept.
 */
export function workView(team: unknown, memory: PhaseMemory | null = null): ChatGroupView[] {
  const groups = new Map<string, ChatGroupView>();
  for (const item of Array.isArray(team) ? team : []) {
    const job = obj(item);
    if (!job || typeof job.jobId !== "string") continue;
    const chat = obj(job.chat);
    const chatId = text(job.chatId ?? job.chat_id ?? chat?.id ?? chat?.chatId, 64);
    const chatName = text(job.chatName ?? job.chat_name ?? chat?.name, 100);
    const room = text(job.room ?? job.roomName, 100);
    const key = chatId
      ? `chat:${chatId}`
      : chatName
        ? `chat-name:${chatName}`
        : `room:${room ?? ""}`;
    const name = chatName ?? room ?? "Chat";
    const running = isRunning(job);
    const view: JobView = {
      ...job,
      jobId: job.jobId,
      running,
      stages: stagesFor(job as ProgressLike, memory?.get(job.jobId) ?? null),
      stop: stopReason(job),
    };
    const group =
      groups.get(key) ??
      ({ key, name, byChat: Boolean(chatId || chatName), running: 0, jobs: [] } as ChatGroupView);
    group.jobs.push(view);
    if (running) group.running++;
    groups.set(key, group);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.running > 0), ...all.filter((g) => g.running === 0)];
}
