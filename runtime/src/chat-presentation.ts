/**
 * Quiet ThreadLink (docs/design/threadlink-0.11.md §4, §5, §7): how any client
 * (web, desktop, terminal) presents a chat row, an agent's name, ThreadLink's
 * own text and presence. Pure: no I/O, no imports, no clock reads (callers pass
 * `now`), so every client shows the same thing and tests pin every rule here.
 *
 * Input shapes are structural and permissive on purpose: the web timeline
 * event, the runtime chat client's event (no payload) and raw API rows all fit.
 */

// ---------------------------------------------------------------------------
// Placement: chat vs activity (§7)
// ---------------------------------------------------------------------------

export type ChatPlacement = "chat" | "activity";

/** The fields placement reads. Everything but authorKind/eventType is optional. */
export type PresentationEvent = {
  authorKind: string;
  eventType: string;
  visibility?: string | null;
  body?: string | null;
  payload?: Record<string, unknown> | null;
  authorProvider?: string | null;
  authorLabel?: string | null;
};

export type PlacementContext = {
  /** The finding's latest status (from the findings list), when the caller knows it. */
  findingStatus?: string | null;
  /**
   * False when this finding row only updates an earlier finding (a status change):
   * the earlier card already shows it. Defaults to true.
   */
  firstFindingRow?: boolean;
};

/** ThreadLink rows that always belong in the conversation. */
export const CHAT_THREADLINK_TYPES: readonly string[] = [
  "provider_blocked",
  "choice",
  "timeout",
  "interrupted",
  "job_summary",
  "job_verdict",
  "plan_agreed",
  "code_change",
  "mode_changed",
  "failover",
  // Tolerated 0.11 spellings for usage / availability notices.
  "usage_exhausted",
  "usage_notice",
  "provider_available",
  "approval_required",
];

/** ThreadLink rows that only ever go to the Activity drawer. */
export const ACTIVITY_THREADLINK_TYPES: readonly string[] = [
  "job_started",
  "phase",
  "unit_status",
  "task_started",
  "task_progress",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "run_started",
  "run_finished",
  "model_used",
  "model_mismatch",
  "owner_routed",
  "stop_requested",
  "control_requested",
  "round",
  "roles",
];

const CHAT_SET = new Set(CHAT_THREADLINK_TYPES);
const ACTIVITY_SET = new Set(ACTIVITY_THREADLINK_TYPES);
const PEOPLE = new Set(["owner", "controller"]);
/** Agent rows that are conversation (anything an agent says or hands over). */
const AGENT_CHAT_TYPES = new Set(["agent_message", "agent_result", "message", "code_change"]);
/** Approval kinds: always shown, never resolved from natural language (§6). */
const APPROVAL_KINDS = new Set([
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
]);

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function findingSeverity(e: PresentationEvent): string | null {
  const sev = str(e.payload?.severity);
  if (sev) return sev;
  const m = /^(Blocking|Important|Minor) finding\b/.exec(e.body ?? "");
  if (!m) return null;
  return m[1] === "Blocking" ? "blocking" : m[1] === "Important" ? "important" : "non_blocking";
}

/** job_status rows that say the work stopped (0.10: "The job failed." / "The job was cancelled."). */
function stopsWork(e: PresentationEvent): boolean {
  const status = str(e.payload?.status);
  if (status === "failed" || status === "cancelled") return true;
  return /^The job (failed|was cancelled)\b/.test(e.body ?? "");
}

/**
 * Where a row belongs: the conversation ("chat") or the Activity drawer
 * ("activity"). Works for 0.10 heavy-job rows and 0.11 rows alike; unknown
 * ThreadLink rows are quiet by default.
 */
export function chatPlacement(e: PresentationEvent, ctx: PlacementContext = {}): ChatPlacement {
  if (e.visibility === "technical") return "activity";
  const type = e.eventType;

  if (PEOPLE.has(e.authorKind)) return "chat";

  if (e.authorKind === "agent") {
    if (type === "decision_card") return decisionMatters(e) ? "chat" : "activity";
    if (type === "finding") return findingPlacement(e, ctx);
    if (AGENT_CHAT_TYPES.has(type)) return "chat";
    return ACTIVITY_SET.has(type) ? "activity" : "chat";
  }

  if (e.authorKind !== "threadlink") return "activity";

  if (type === "finding") return findingPlacement(e, ctx);
  if (type === "decision" || type === "decision_card")
    return decisionMatters(e) ? "chat" : "activity";
  if (type === "job_status") return stopsWork(e) ? "chat" : "activity";
  if (CHAT_SET.has(type)) return "chat";
  return "activity";
}

function findingPlacement(e: PresentationEvent, ctx: PlacementContext): ChatPlacement {
  if (ctx.firstFindingRow === false) return "activity";
  const sev = findingSeverity(e);
  if (sev !== "blocking" && sev !== "important") return "activity";
  const status = ctx.findingStatus ?? str(e.payload?.status) ?? "open";
  // Open, accepted and disputed still need attention; fixed/resolved/dismissed do not.
  return status === "open" || status === "accepted" || status === "disputed" ? "chat" : "activity";
}

function decisionMatters(e: PresentationEvent): boolean {
  if (e.payload?.requiresUser === true) return true;
  return /needs your decision/i.test(e.body ?? "");
}

/** True for approval kinds (migration, deploy, …): the card is the only way to answer. */
export function isApprovalKind(kind: string | null | undefined): boolean {
  return typeof kind === "string" && APPROVAL_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Agent names (§7)
// ---------------------------------------------------------------------------

const SHORT_NAMES: Record<string, string> = {
  "claude-code": "Claude",
  claude: "Claude",
  "claude-chat": "Claude",
  codex: "Codex",
  "openai-codex": "Codex",
  "codex-cli": "Codex",
  nova: "Nova",
  gemini: "Gemini",
  "gemini-cli": "Gemini",
};

const FULL_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  "openai-codex": "Codex",
  "codex-cli": "Codex",
};

function titleWord(w: string): string {
  return w ? w[0]!.toUpperCase() + w.slice(1) : w;
}

/**
 * "Claude" / "Codex" / the registry's short name / a tidy fallback from the id.
 * Used everywhere in the chat; full names only on the Agents page and provenance.
 */
export function agentShortName(
  providerId: string | null | undefined,
  registryShortName?: string | null,
): string {
  const id = (providerId ?? "").trim().toLowerCase();
  const known = SHORT_NAMES[id];
  if (known) return known;
  const reg = typeof registryShortName === "string" ? registryShortName.trim() : "";
  if (reg) return reg.slice(0, 40);
  if (!id) return "Agent";
  const first = id.split(/[-_:\s]+/).find(Boolean) ?? id;
  return titleWord(first.replace(/[^a-z0-9]/g, "")).slice(0, 40) || "Agent";
}

/** Avatar kinds with their own colours in the design (others use a neutral avatar). */
export type AgentAvatarKind = "claude" | "codex" | "other";

/** The avatar's letter and colour family: Claude "C", Codex "X", others their first letter. */
export function agentAvatar(
  providerId: string | null | undefined,
  registryShortName?: string | null,
): { initial: string; kind: AgentAvatarKind } {
  const short = agentShortName(providerId, registryShortName);
  if (short === "Claude") return { initial: "C", kind: "claude" };
  if (short === "Codex") return { initial: "X", kind: "codex" };
  return { initial: (short[0] ?? "A").toUpperCase(), kind: "other" };
}

/** "Claude Code" / "Codex" / the registry's name: for the Agents page and provenance only. */
export function agentFullName(
  providerId: string | null | undefined,
  registryName?: string | null,
): string {
  const id = (providerId ?? "").trim().toLowerCase();
  const reg = typeof registryName === "string" ? registryName.trim() : "";
  if (reg) return reg.slice(0, 60);
  return FULL_NAMES[id] ?? agentShortName(providerId);
}

// ---------------------------------------------------------------------------
// ThreadLink's own text (§3.5, §7): never ids or reason codes
// ---------------------------------------------------------------------------

/** Reason / status codes that may leak into a body, in words. */
const CODE_WORDS: Record<string, string> = {
  usage_exhausted: "usage limit reached",
  needs_sign_in: "needs sign-in",
  not_installed: "not installed",
  api_key_auth: "uses an API key",
  runtime_outdated: "ThreadLink needs an update on the computer",
  provider_failure: "provider problem",
  review_pending: "review pending",
  needs_fix: "needs fixes",
  needs_user_decision: "waiting for you",
  plan_review: "plan review",
  final_check: "final check",
  non_blocking: "minor",
  explicit_chat: "chat only",
  explicit_work: "run as work",
  default_chat: "chat",
  edit_requested: "edit requested",
  tests_requested: "tests requested",
  repo_action: "repository work",
  repo_review: "repository review",
  continue_other: "continue with another agent",
  check_again: "check again",
  run_work: "run as work",
  keep_chatting: "keep chatting",
};

const STATUS_WORDS: Record<string, string> = {
  queued: "Queued",
  normalising: "Preparing",
  planning: "Planning",
  plan_review: "Reviewing the plan",
  building: "Building",
  reviewing: "Reviewing",
  integrating: "Integrating",
  inspecting: "Final check",
  verifying: "Running checks",
  paused: "Paused",
  needs_user_decision: "Waiting for you",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TL_RE = /\bTL-\d{1,8}\b\s*/g;
/** Prefixed opaque ids (job_…, run_…, chat_…) and long hex/base62 tokens. */
const OPAQUE_RE =
  /\b(?:tl[a-z]{2,8}|job|run|chat|task|node|choice|finding|decision|evt|rt|art)_[A-Za-z0-9]{6,}\b/g;
const SNAKE_RE = /\b[a-z]+(?:_[a-z]+)+\b/g;

/** Strips ids and reason codes from ThreadLink-written text. */
export function scrubSystemText(text: string): string {
  return text
    .replace(UUID_RE, "")
    .replace(TL_RE, "")
    .replace(OPAQUE_RE, "")
    .replace(SNAKE_RE, (code) => CODE_WORDS[code] ?? code.replace(/_/g, " "))
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\(\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Codex usage is exhausted. Continuing with Claude. Independent review will wait for Codex." */
export function failoverText(p: {
  from?: string | null;
  to?: string | null;
  fromName?: string | null;
  toName?: string | null;
  reviewWaits?: boolean;
  reason?: string | null;
}): string {
  const from = agentShortName(p.from ?? null, p.fromName ?? null);
  const to = p.to || p.toName ? agentShortName(p.to ?? null, p.toName ?? null) : null;
  const why =
    p.reason && p.reason !== "usage_exhausted"
      ? `${from} is unavailable.`
      : `${from} usage is exhausted.`;
  const next = to ? ` Continuing with ${to}.` : "";
  const review = p.reviewWaits ? ` Independent review will wait for ${from}.` : "";
  return `${why}${next}${review}`;
}

/**
 * The text a ThreadLink row shows, in plain words. Agent/owner text is
 * returned unchanged (it is theirs); ThreadLink rows lose ids and codes.
 */
export function humanSystemText(e: PresentationEvent): string {
  const body = typeof e.body === "string" ? e.body : "";
  if (e.authorKind !== "threadlink") return body;
  const p = e.payload ?? null;
  switch (e.eventType) {
    case "failover": {
      const from = str(p?.from) ?? str(p?.fromProvider);
      if (from) {
        return failoverText({
          from,
          to: str(p?.to) ?? str(p?.toProvider),
          fromName: str(p?.fromName),
          toName: str(p?.toName),
          reviewWaits: p?.reviewWaits === true || p?.reviewPending === true,
          reason: str(p?.reason),
        });
      }
      break;
    }
    case "job_status": {
      const m = /^Status:\s*([a-z_]+)\s*$/i.exec(body.trim());
      const code = m?.[1] ?? str(p?.status);
      if (m && code) return STATUS_WORDS[code.toLowerCase()] ?? scrubSystemText(code);
      break;
    }
    case "decision": {
      const text = scrubSystemText(body.replace(/^Decision\b/, "").trim());
      const needs = /needs your decision/i.test(body);
      if (!text || /^this needs your decision\.?$/i.test(text)) {
        return needs ? "A decision needs you." : "Decision recorded.";
      }
      return text;
    }
    case "phase": {
      const ph = str(p?.phase) ?? str(p?.status);
      if (ph) return STATUS_WORDS[ph] ?? titleWord(scrubSystemText(ph));
      break;
    }
    default:
      break;
  }
  const out = scrubSystemText(body);
  return out || "Update";
}

// ---------------------------------------------------------------------------
// Choices (§5, §2.5)
// ---------------------------------------------------------------------------

export type ChoiceOption = { key: string; label: string };

/**
 * The options a choice card may show. `usage_exhausted` never offers a plain
 * retry of the exhausted agent (Check again is the only path), and a
 * provider_failure for an agent whose usage is exhausted never offers retry.
 */
export function visibleChoiceOptions(
  kind: string | null | undefined,
  options: readonly ChoiceOption[],
  ctx: { providerExhausted?: boolean } = {},
): ChoiceOption[] {
  const noRetry =
    kind === "usage_exhausted" || (kind === "provider_failure" && ctx.providerExhausted);
  return options.filter((o) => !(noRetry && (o.key === "retry" || /^\s*retry\b/i.test(o.label))));
}

/** Reads `resetsAt` from a choice/provider payload (top level or params). Never invented. */
export function resetsAtOf(
  ...sources: (Record<string, unknown> | null | undefined)[]
): string | null {
  for (const s of sources) {
    if (!s) continue;
    const direct = str(s.resetsAt) ?? str(s.resets_at);
    const params = obj(s.params);
    const nested = params ? (str(params.resetsAt) ?? str(params.resets_at)) : null;
    const v = direct ?? nested;
    if (v && Number.isFinite(Date.parse(v))) return v;
  }
  return null;
}

/**
 * "Resets around 14:52" in the viewer's local time (a weekday is added when
 * it is not within the next day), or "Reset time not reported." when absent.
 */
export function resetTimeText(
  resetsAt: string | null | undefined,
  opts: { now?: number; locale?: string; timeZone?: string } = {},
): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at)) return "Reset time not reported.";
  const fmt: Record<string, unknown> = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (opts.timeZone) fmt.timeZone = opts.timeZone;
  const far = opts.now !== undefined && at - opts.now > 20 * 3_600_000;
  if (far) fmt.weekday = "short";
  const text = new Date(at).toLocaleString(
    opts.locale ?? "en-GB",
    fmt as Intl.DateTimeFormatOptions,
  );
  return `Resets around ${text.replace(",", "")}`;
}

// ---------------------------------------------------------------------------
// Durations and run timings (§3.6)
// ---------------------------------------------------------------------------

/** "0.8 s", "34 s", "2 min 5 s", "1 h 4 min". */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min} min ${sec % 60} s` : `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export type RunTimings = {
  queueMs?: number | null;
  spawnMs?: number | null;
  contextMs?: number | null;
  firstEventMs?: number | null;
  providerMs?: number | null;
  persistMs?: number | null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Validates a timings object from the server; null when nothing usable is there. */
export function parseRunTimings(v: unknown): RunTimings | null {
  const o = obj(v);
  if (!o) return null;
  const t: RunTimings = {
    queueMs: num(o.queueMs),
    spawnMs: num(o.spawnMs),
    contextMs: num(o.contextMs),
    firstEventMs: num(o.firstEventMs),
    providerMs: num(o.providerMs),
    persistMs: num(o.persistMs),
  };
  return Object.values(t).some((x) => x !== null) ? t : null;
}

/**
 * "Pickup 1.2 s · Startup 0.8 s · Provider 34 s · Persist 0.2 s".
 * Startup = spawn + context; parts that were not measured are left out.
 */
export function runTimingsText(t: RunTimings | null | undefined): string | null {
  if (!t) return null;
  const parts: string[] = [];
  const q = num(t.queueMs);
  if (q !== null) parts.push(`Pickup ${durationText(q)}`);
  const spawn = num(t.spawnMs);
  const ctx = num(t.contextMs);
  if (spawn !== null || ctx !== null)
    parts.push(`Startup ${durationText((spawn ?? 0) + (ctx ?? 0))}`);
  const first = num(t.firstEventMs);
  if (first !== null) parts.push(`First output ${durationText(first)}`);
  const prov = num(t.providerMs);
  if (prov !== null) parts.push(`Provider ${durationText(prov)}`);
  const persist = num(t.persistMs);
  if (persist !== null) parts.push(`Persist ${durationText(persist)}`);
  return parts.length ? parts.join(" · ") : null;
}

export type TimingPart = {
  key: "queue" | "startup" | "provider" | "persist";
  label: string;
  ms: number;
  /** Share of the measured total, 0..100 (rounded; parts under 1 % show as 1). */
  percent: number;
};

/**
 * "Where the time went" (design canvas): Waiting for the computer, Startup,
 * <Agent> working, Saving — only the parts that were measured, with their
 * share of the total for a segmented bar. Empty when nothing was measured.
 */
export function timingBreakdown(t: RunTimings | null | undefined, agentName: string): TimingPart[] {
  if (!t) return [];
  const spawn = num(t.spawnMs);
  const ctx = num(t.contextMs);
  const raw: { key: TimingPart["key"]; label: string; ms: number | null }[] = [
    { key: "queue", label: "Waiting for the computer", ms: num(t.queueMs) },
    {
      key: "startup",
      label: "Startup",
      ms: spawn !== null || ctx !== null ? (spawn ?? 0) + (ctx ?? 0) : null,
    },
    { key: "provider", label: `${agentName || "Agent"} working`, ms: num(t.providerMs) },
    { key: "persist", label: "Saving", ms: num(t.persistMs) },
  ];
  const parts = raw.filter(
    (p): p is { key: TimingPart["key"]; label: string; ms: number } => p.ms !== null,
  );
  const total = parts.reduce((a, p) => a + p.ms, 0);
  return parts.map((p) => ({
    ...p,
    percent: total > 0 ? Math.max(p.ms > 0 ? 1 : 0, Math.round((p.ms / total) * 100)) : 0,
  }));
}

// ---------------------------------------------------------------------------
// Presence (§4)
// ---------------------------------------------------------------------------

export type Presence = "online" | "working" | "reconnecting" | "offline";
export type PresenceTone = "success" | "accent" | "warning" | "neutral";

/** online: last seen < 75 s; reconnecting: < 3 min; offline: ≥ 3 min. */
export const PRESENCE_ONLINE_MS = 75_000;
export const PRESENCE_OFFLINE_MS = 3 * 60_000;
/** Work newer than this is proof of life: never "offline" beside it. */
export const PRESENCE_WORK_FRESH_MS = 3 * 60_000;

const PRESENCES = new Set<Presence>(["online", "working", "reconnecting", "offline"]);

export function parsePresence(v: unknown): Presence | null {
  return typeof v === "string" && PRESENCES.has(v as Presence) ? (v as Presence) : null;
}

const PRESENCE_WORDS: Record<Presence, string> = {
  online: "Online",
  working: "Working",
  reconnecting: "Reconnecting",
  offline: "Offline",
};
const PRESENCE_TONES: Record<Presence, PresenceTone> = {
  online: "success",
  working: "accent",
  reconnecting: "warning",
  offline: "neutral",
};

/**
 * The execution host's presence. The server's presence wins, except that
 * fresh work (live activity < 3 min, or the server saying working) is never
 * shown as offline or reconnecting. Without a server presence (an older
 * server) it is aged from lastSeenAt against the server clock.
 */
export function hostPresence(input: {
  presence?: unknown;
  lastSeenAt?: string | null;
  /** The server's clock at the time of the reading (ISO), for aging lastSeenAt. */
  serverNow?: string | null;
  /** This client's clock. */
  now: number;
  /** Newest live-activity time seen for this chat (ISO), if any. */
  lastActivityAt?: string | null;
  /** Anything is visibly running in the chat right now. */
  working?: boolean;
  revoked?: boolean;
}): Presence {
  if (input.revoked) return "offline";
  const activity = input.lastActivityAt ? Date.parse(input.lastActivityAt) : NaN;
  const freshWork =
    input.working === true ||
    (Number.isFinite(activity) && input.now - activity < PRESENCE_WORK_FRESH_MS);
  const server = parsePresence(input.presence);
  if (server === "working" || freshWork) return "working";
  if (server) return server;
  const seen = input.lastSeenAt ? Date.parse(input.lastSeenAt) : NaN;
  if (!Number.isFinite(seen)) return "offline";
  const ref = input.serverNow ? Date.parse(input.serverNow) : NaN;
  const age = (Number.isFinite(ref) ? ref : input.now) - seen;
  if (age < PRESENCE_ONLINE_MS) return "online";
  if (age < PRESENCE_OFFLINE_MS) return "reconnecting";
  return "offline";
}

export type PresenceView = {
  presence: Presence;
  /** "Online" / "Working" / "Reconnecting" / "Offline". */
  word: string;
  /** "Nickron PC · Working". */
  text: string;
  tone: PresenceTone;
};

export function hostPresenceLabel(
  label: string | null | undefined,
  presence: Presence,
): PresenceView {
  const name = (label ?? "").trim().slice(0, 60) || "Your computer";
  return {
    presence,
    word: PRESENCE_WORDS[presence],
    text: `${name} · ${PRESENCE_WORDS[presence]}`,
    tone: PRESENCE_TONES[presence],
  };
}

/**
 * What to say when the host is offline (§4). The viewer is connected; only
 * the host is away. Null when the host is not offline.
 */
export function hostOfflineNote(
  label: string | null | undefined,
  presence: Presence,
): string | null {
  if (presence !== "offline") return null;
  const name = (label ?? "").trim().slice(0, 60) || "Your computer";
  return `You're connected. ${name} is offline — repository work and agent replies will resume when it reconnects.`;
}

export type ClientConnection = "connected" | "reconnecting" | "offline";

/**
 * This client's own connection to ThreadLink, from its own request results
 * only — never from the Runtime. `browserOnline: false` → offline.
 */
export function youPresence(input: {
  consecutiveFailures: number;
  browserOnline?: boolean;
}): ClientConnection {
  if (input.browserOnline === false) return "offline";
  return input.consecutiveFailures > 0 ? "reconnecting" : "connected";
}

export function youPresenceLabel(state: ClientConnection): { text: string; tone: PresenceTone } {
  switch (state) {
    case "connected":
      return { text: "You · Connected", tone: "success" };
    case "reconnecting":
      return { text: "You · Reconnecting", tone: "warning" };
    case "offline":
      return { text: "You · Offline (no network)", tone: "neutral" };
  }
}

/** The ThreadLink service: reachable when this client's last request succeeded. */
export function serviceLabel(input: { consecutiveFailures: number; browserOnline?: boolean }): {
  text: string;
  tone: PresenceTone;
} {
  if (input.browserOnline === false)
    return { text: "ThreadLink service · Unknown (you're offline)", tone: "neutral" };
  return input.consecutiveFailures > 0
    ? { text: "ThreadLink service · Reconnecting", tone: "warning" }
    : { text: "ThreadLink service · Reachable", tone: "success" };
}
