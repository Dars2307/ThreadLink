import {
  CHOICE_KINDS,
  FINDING_STATES,
  JOB_CONTROLS,
  RUN_ACTIVITIES,
  RUN_STATUSES,
  type ChoiceKind,
  type FindingState,
  type JobControl,
  type JobMode,
  type LiveActivity,
  type MessageDelivery,
  type RunActivity,
  type RunProvenance,
  type RunStatus,
} from "@/lib/chat/types";

import { humanize, modelDisplayName, roleLabel, type Tone } from "./labels";
import { shortModelName } from "./providers-display";
import { mentionTarget, registryEntry, type Registry } from "./registry";
import { oneLine } from "./safe-text";

/**
 * The 0.10 chat timeline, pure (docs/design/threadlink-0.10.md §3–§8; brief
 * §7–§12, §26–§31, §71, §86–§88). No I/O and no React: the chat view renders
 * what this builds, and tests pin every rule here.
 *
 * Trust: every author field and every ThreadLink card payload comes from the
 * server (database triggers / security-definer RPCs). The UI only chooses how
 * to show it. Agent text (titles, bodies) is always shown attributed to the
 * agent and always as plain text.
 */

// ---------------------------------------------------------------------------
// Normalised events
// ---------------------------------------------------------------------------

export type EventRef = {
  kind: "finding" | "decision" | "node" | "artifact" | "message" | "choice" | "run";
  id: string;
};

/** One chat row as the timeline uses it. Parsed defensively from the API. */
export type TimelineEvent = {
  id: string;
  /** Per-chat cursor (`chat_seq`); falls back to `seq` from older servers. */
  chatSeq: number;
  createdAt: string;
  jobId: string | null;
  runId: string | null;
  authorKind: "controller" | "owner" | "threadlink" | "agent";
  authorProvider: string | null;
  authorLabel: string;
  authorRole: string | null;
  audience: string | null;
  eventType: string;
  messageType: string | null;
  round: number | null;
  modelRequested: string | null;
  modelObserved: string | null;
  body: string;
  visibility: "visible" | "technical";
  replyTo: string | null;
  ref: EventRef | null;
  payload: Record<string, unknown> | null;
  delivery: MessageDelivery | null;
};

const AUTHOR_KINDS = new Set(["controller", "owner", "threadlink", "agent"]);
const REF_KINDS = new Set(["finding", "decision", "node", "artifact", "message", "choice", "run"]);
const ID_RE = /^[A-Za-z0-9_:.-]{1,120}$/;

const s = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const id = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v) ? v : null);

function parseDelivery(v: unknown): MessageDelivery | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  const list = (x: unknown) =>
    Array.isArray(x) ? x.filter((y): y is string => typeof y === "string").slice(0, 8) : [];
  switch (d.state) {
    case "sent":
      return { state: "sent" };
    case "queued":
      return { state: "queued", for: list(d.for) };
    case "seen":
      return { state: "seen", by: list(d.by) };
    case "not_delivered":
      return { state: "not_delivered" };
    default:
      return null;
  }
}

/** A raw API row → TimelineEvent, or null when it is not a usable row. */
export function parseEvent(raw: unknown): TimelineEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const eid = s(e.id, 120);
  const chatSeq = n(e.chatSeq) ?? n(e.chat_seq) ?? n(e.seq);
  if (!eid || chatSeq === null || typeof e.body !== "string") return null;
  const authorKind = AUTHOR_KINDS.has(e.authorKind as string)
    ? (e.authorKind as TimelineEvent["authorKind"])
    : null;
  if (!authorKind) return null;
  const refRaw = e.ref as Record<string, unknown> | null | undefined;
  const ref =
    refRaw && typeof refRaw === "object" && REF_KINDS.has(refRaw.kind as string) && id(refRaw.id)
      ? ({ kind: refRaw.kind, id: refRaw.id } as EventRef)
      : null;
  const payload =
    e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
      ? (e.payload as Record<string, unknown>)
      : null;
  return {
    id: eid,
    chatSeq,
    createdAt: s(e.createdAt, 40) ?? new Date(0).toISOString(),
    jobId: id(e.jobId),
    runId: id(e.runId),
    authorKind,
    authorProvider: s(e.authorProviderId, 40) ?? s(e.authorProvider, 40),
    authorLabel: s(e.authorLabel, 80) ?? "",
    authorRole: s(e.authorRole, 40),
    audience: s(e.audienceId, 40) ?? s(e.audience, 40),
    eventType: s(e.eventType, 40) ?? "message",
    messageType: s(e.messageType, 40),
    round: n(e.round),
    modelRequested: s(e.modelRequested, 80),
    modelObserved: s(e.modelObserved, 80),
    body: e.body,
    visibility: e.visibility === "technical" ? "technical" : "visible",
    replyTo: id(e.replyTo) ?? id(e.replyToEventId),
    ref,
    payload,
    delivery: parseDelivery(e.delivery),
  };
}

export type TimelinePage = {
  events: TimelineEvent[];
  /** Highest chat_seq returned (or the `after` passed in). */
  cursor: number;
  /** True when older rows exist before the oldest one returned. */
  hasOlder: boolean;
  activeJob: { jobId: string; mode: JobMode; status: string; control: JobControl | null } | null;
  live: LiveActivity[] | null;
  /** The owner's read cursor (chat_seq), when the page says. */
  lastReadSeq: number | null;
};

/** {live: LiveActivity[]} from the activity route → valid rows only, or null. */
export function parseLiveList(value: unknown): LiveActivity[] | null {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>).live : null;
  return Array.isArray(v) ? v.map(parseLive).filter((l): l is LiveActivity => l !== null) : null;
}

function parseLive(v: unknown): LiveActivity | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const runId = id(r.runId);
  const provider = s(r.provider, 40);
  if (!runId || !provider) return null;
  const activity = (RUN_ACTIVITIES as readonly string[]).includes(r.activity as string)
    ? (r.activity as RunActivity)
    : null;
  return {
    runId,
    provider,
    providerName: s(r.providerName, 60) ?? "",
    role: s(r.role, 40) ?? "",
    activity,
    startedAt: s(r.startedAt, 40),
    lastActivityAt: s(r.lastActivityAt, 40),
  };
}

const MODES = new Set(["solo", "pair", "team"]);

/** Validates a page from the events route. Null = not a page (the UI keeps what it has). */
export function parsePage(value: unknown): TimelinePage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.events) || typeof v.cursor !== "number") return null;
  const events = v.events.map(parseEvent);
  if (events.some((e) => e === null)) return null;
  const job = v.activeJob as Record<string, unknown> | null | undefined;
  const control = (JOB_CONTROLS as readonly string[]).includes(job?.control as string)
    ? (job!.control as JobControl)
    : null;
  return {
    events: events as TimelineEvent[],
    cursor: v.cursor,
    hasOlder: v.hasOlder === true || v.hasMore === true,
    activeJob:
      job && typeof job === "object" && id(job.jobId) && typeof job.status === "string"
        ? {
            jobId: job.jobId as string,
            mode: (MODES.has(job.mode as string) ? job.mode : "team") as JobMode,
            status: job.status.slice(0, 40),
            control,
          }
        : null,
    live: Array.isArray(v.live)
      ? v.live.map(parseLive).filter((l): l is LiveActivity => l !== null)
      : null,
    lastReadSeq: n(v.lastReadChatSeq) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Merging and paging (per-chat cursor)
// ---------------------------------------------------------------------------

/**
 * Merges pages by chat_seq. An id seen before is kept once (the newer copy
 * wins, so a delivery-state update replaces the old row); two different ids
 * claiming one chat_seq keep the incoming one (the server is the source of
 * truth). Output is sorted ascending by chat_seq. O(n log n).
 */
export function mergeTimeline(
  existing: TimelineEvent[],
  incoming: TimelineEvent[],
): TimelineEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, TimelineEvent>();
  const seqOfId = new Map<string, number>();
  for (const e of existing) {
    bySeq.set(e.chatSeq, e);
    seqOfId.set(e.id, e.chatSeq);
  }
  for (const e of incoming) {
    const oldSeq = seqOfId.get(e.id);
    if (oldSeq !== undefined && oldSeq !== e.chatSeq) bySeq.delete(oldSeq);
    const clash = bySeq.get(e.chatSeq);
    if (clash && clash.id !== e.id) seqOfId.delete(clash.id);
    bySeq.set(e.chatSeq, e);
    seqOfId.set(e.id, e.chatSeq);
  }
  return [...bySeq.values()].sort((a, b) => a.chatSeq - b.chatSeq);
}

export function newestSeq(events: TimelineEvent[], fallback = 0): number {
  return events.length ? Math.max(fallback, events[events.length - 1]!.chatSeq) : fallback;
}

export function oldestSeq(events: TimelineEvent[]): number | null {
  return events.length ? events[0]!.chatSeq : null;
}

export const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Durations and freshness (one calculation everywhere)
// ---------------------------------------------------------------------------

/** "23 s", "4 min", "2 h", "3 d". */
export function shortDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "3m", "1h 4m": elapsed time on a live row. */
export function elapsed(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** Ready only while the last real check is at most this old (§8). */
export const HEALTH_FRESH_MS = 2 * 60 * 60_000;

export type Freshness = {
  state: "ready" | "stale" | "attention" | "unknown";
  /** Short word for chips: "Ready", "Stale", "Needs sign-in". */
  label: string;
  /** Full line: "Ready · checked 23 s ago" / "Stale · last checked 2 h ago". */
  text: string;
  tone: Tone;
  /** Screen-reader text never depends on colour. */
};

const HEALTH_WORDS: Record<string, string> = {
  needs_sign_in: "Needs sign-in",
  not_installed: "Not installed",
  api_key_auth: "Uses an API key",
  usage_exhausted: "Usage limit reached",
};

/**
 * The single freshness rule for agent health (§8): "Ready" appears only when
 * the provider was really checked within 2 h. Anything older is "Stale" —
 * never "Ready" beside stale text. Other states say when they were checked.
 */
export function healthFreshness(
  health: string | null | undefined,
  checkedAt: string | null | undefined,
  now: number,
): Freshness {
  const at = checkedAt ? Date.parse(checkedAt) : NaN;
  const age = Number.isFinite(at) ? Math.max(0, now - at) : null;
  if (health === "ready" || health === "stale") {
    if (health === "ready" && age !== null && age <= HEALTH_FRESH_MS) {
      return {
        state: "ready",
        label: "Ready",
        text: `Ready · checked ${shortDuration(age)} ago`,
        tone: "success",
      };
    }
    return {
      state: "stale",
      label: "Stale",
      text:
        age === null ? "Stale · not checked yet" : `Stale · last checked ${shortDuration(age)} ago`,
      tone: "warning",
    };
  }
  const word = health ? HEALTH_WORDS[health] : undefined;
  if (word) {
    return {
      state: "attention",
      label: word,
      text: age === null ? word : `${word} · checked ${shortDuration(age)} ago`,
      tone: "warning",
    };
  }
  return { state: "unknown", label: "Not checked yet", text: "Not checked yet", tone: "neutral" };
}

export type HostView = {
  label: string;
  state: "online" | "offline" | "working" | "unknown";
  /** "Runs on Nickron's PC · Online". */
  text: string;
  tone: Tone;
  outdated: string | null;
};

/** The execution host line for the chat header (§8). */
export function hostView(
  host: {
    label: string | null;
    online: boolean | null;
    working?: boolean;
    lastSeenAt?: string | null;
    protocolOutdated?: boolean;
  } | null,
  now: number,
): HostView | null {
  if (!host || !host.label) return null;
  const label = host.label.slice(0, 60);
  const outdated = host.protocolOutdated
    ? `ThreadLink on ${label} needs an update before Team work can start.`
    : null;
  if (host.online === null) {
    return { label, state: "unknown", text: `Runs on ${label}`, tone: "neutral", outdated };
  }
  if (!host.online) {
    const seen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : NaN;
    const ago = Number.isFinite(seen) ? ` · last seen ${shortDuration(now - seen)} ago` : "";
    return {
      label,
      state: "offline",
      text: `Runs on ${label} · Offline${ago}`,
      tone: "warning",
      outdated,
    };
  }
  if (host.working) {
    return {
      label,
      state: "working",
      text: `Runs on ${label} · Online · Working`,
      tone: "accent",
      outdated,
    };
  }
  return { label, state: "online", text: `Runs on ${label} · Online`, tone: "success", outdated };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type IdentityStyle = "owner" | "controller" | "threadlink" | "agent";

export type Identity = {
  style: IdentityStyle;
  /** "You", "ChatGPT · Controller", "ThreadLink", "Codex · Coordinator". */
  headline: string;
  /** Agent provider id (for tone/aria), null otherwise. */
  providerId: string | null;
  tone: Tone;
  /** Subtle model line: "GPT-6 Sol". Null when not reported. */
  model: string | null;
  modelMismatch: string | null;
  /** Grouping key: same speaker. */
  speaker: string;
};

/** Identities are pure in (author fields, registry): cached so 10k rows stay cheap. */
const IDENTITY_CACHE = new WeakMap<Registry, Map<string, Identity>>();
const IDENTITY_CACHE_MAX = 2000;

/** How an author is shown. Registry metadata only; never a provider switch. */
export function identityOf(e: TimelineEvent, registry: Registry): Identity {
  const key = [
    e.authorKind,
    e.authorProvider ?? "",
    e.authorRole ?? "",
    e.authorLabel,
    e.modelObserved ?? "",
    e.modelRequested ?? "",
  ].join("\u0001");
  let cache = IDENTITY_CACHE.get(registry);
  if (!cache) {
    cache = new Map();
    IDENTITY_CACHE.set(registry, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const made = computeIdentity(e, registry);
  if (cache.size >= IDENTITY_CACHE_MAX) cache.clear();
  cache.set(key, made);
  return made;
}

function computeIdentity(e: TimelineEvent, registry: Registry): Identity {
  if (e.authorKind === "owner") {
    return {
      style: "owner",
      headline: "You",
      providerId: null,
      tone: "accent",
      model: null,
      modelMismatch: null,
      speaker: "owner",
    };
  }
  if (e.authorKind === "controller") {
    const name = oneLine(e.authorLabel, 40) || "Controller";
    return {
      style: "controller",
      headline: `${name} · Controller`,
      providerId: null,
      tone: "neutral",
      model: null,
      modelMismatch: null,
      speaker: `controller|${name}`,
    };
  }
  if (e.authorKind === "threadlink") {
    return {
      style: "threadlink",
      headline: "ThreadLink",
      providerId: null,
      tone: "neutral",
      model: null,
      modelMismatch: null,
      speaker: "threadlink",
    };
  }
  const entry = registryEntry(registry, e.authorProvider, e.authorLabel || null);
  const role = e.authorRole ? roleLabel(e.authorRole) : null;
  const observed = e.modelObserved ? shortModelName(e.modelObserved) : null;
  const mismatch =
    e.modelObserved && e.modelRequested && e.modelObserved !== e.modelRequested
      ? `Requested ${modelDisplayName(e.modelRequested)}, used ${modelDisplayName(e.modelObserved)}`
      : null;
  return {
    style: "agent",
    headline: role ? `${entry.name} · ${role}` : entry.name,
    providerId: entry.id,
    tone: entry.tone,
    model: observed,
    modelMismatch: mismatch,
    speaker: `agent|${entry.id}|${e.authorRole ?? ""}`,
  };
}

// ---------------------------------------------------------------------------
// Verification (the trust badge)
// ---------------------------------------------------------------------------

export type VerificationView = {
  state: "verified" | "partial" | "unverified";
  label: string;
  notes: string[];
};

/**
 * "✓ Verified" only with full evidence (§2): the server says verified AND the
 * run completed, model and access verified, a native session exists and the
 * execution host is known. Anything missing → Partially verified, with why.
 */
export function verificationOf(
  p:
    | Pick<
        RunProvenance,
        | "verified"
        | "status"
        | "modelVerified"
        | "accessVerified"
        | "nativeSession"
        | "executionHost"
        | "verificationNotes"
      >
    | null
    | undefined,
): VerificationView {
  if (!p)
    return {
      state: "unverified",
      label: "Not verified",
      notes: ["No run record for this message."],
    };
  const notes: string[] = [];
  if (p.status !== "completed")
    notes.push(`The run is ${humanize(p.status).toLowerCase()}, not completed.`);
  if (!p.modelVerified) notes.push("The model that ran was not confirmed.");
  if (!p.accessVerified) notes.push("The file access it ran with was not confirmed.");
  if (!p.nativeSession?.available) notes.push("No native session was recorded.");
  if (!p.executionHost) notes.push("The computer it ran on is not known.");
  const serverNotes = (p.verificationNotes ?? [])
    .filter((x) => typeof x === "string")
    .map((x) => oneLine(x, 200));
  const full = p.verified === "verified" && notes.length === 0;
  if (full) return { state: "verified", label: "Verified", notes: serverNotes };
  if (p.verified === "unverified" && notes.length >= 4) {
    return { state: "unverified", label: "Not verified", notes: [...notes, ...serverNotes] };
  }
  return { state: "partial", label: "Partially verified", notes: [...notes, ...serverNotes] };
}

/** Validates a RunProvenance from the server (owner-only drawer). */
export function parseProvenance(v: unknown): RunProvenance | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const runId = id(r.runId);
  const provider = s(r.provider, 40);
  if (!runId || !provider) return null;
  const ns = (
    r.nativeSession && typeof r.nativeSession === "object" ? r.nativeSession : {}
  ) as Record<string, unknown>;
  const status = (RUN_STATUSES as readonly string[]).includes(r.status as string)
    ? (r.status as RunStatus)
    : "failed";
  const verified =
    r.verified === "verified" || r.verified === "partial" ? r.verified : "unverified";
  return {
    runId,
    provider,
    providerName: s(r.providerName, 60) ?? "",
    participantKey: s(r.participantKey, 80) ?? "",
    role: s(r.role, 40) ?? "",
    requestedModel: s(r.requestedModel, 80),
    observedModel: s(r.observedModel, 80),
    modelVerified: r.modelVerified === true,
    effort: s(r.effort, 20),
    access: r.access === "read-only" || r.access === "workspace-write" ? r.access : null,
    accessVerified: r.accessVerified === true,
    nativeSession: {
      available: ns.available === true,
      kind: s(ns.kind, 40),
      continuity: s(ns.continuity, 20),
    },
    executionHost: s(r.executionHost, 80),
    worktreeLabel: s(r.worktreeLabel, 120),
    status,
    activity: (RUN_ACTIVITIES as readonly string[]).includes(r.activity as string)
      ? (r.activity as RunActivity)
      : null,
    startedAt: s(r.startedAt, 40),
    finishedAt: s(r.finishedAt, 40),
    lastActivityAt: s(r.lastActivityAt, 40),
    verified,
    verificationNotes: Array.isArray(r.verificationNotes)
      ? r.verificationNotes.filter((x): x is string => typeof x === "string").slice(0, 10)
      : [],
  };
}

export type ProvenanceRow = { key: string; label: string; value: string };

const CONTINUITY: Record<string, string> = {
  fresh: "Fresh session",
  resumed: "Resumed",
  forked: "Forked",
};

/** The provenance drawer's rows, in words. The native session id is never here. */
export function provenanceRows(p: RunProvenance, registry: Registry): ProvenanceRow[] {
  const entry = registryEntry(registry, p.provider, p.providerName || null);
  const rows: ProvenanceRow[] = [
    { key: "provider", label: "Provider", value: entry.name },
    { key: "role", label: "Role", value: p.role ? roleLabel(p.role) : "—" },
    {
      key: "requested",
      label: "Model requested",
      value: p.requestedModel ? modelDisplayName(p.requestedModel) : "Default",
    },
    {
      key: "observed",
      label: "Model observed",
      value: p.observedModel
        ? `${modelDisplayName(p.observedModel)}${p.modelVerified ? " (confirmed)" : " (not confirmed)"}`
        : "Not reported",
    },
    {
      key: "source",
      label: "Source",
      value: "Recorded by the ThreadLink app on the execution host",
    },
    {
      key: "session",
      label: "Native session",
      value: p.nativeSession.available
        ? `Available${p.nativeSession.continuity ? ` · ${CONTINUITY[p.nativeSession.continuity] ?? humanize(p.nativeSession.continuity)}` : ""}`
        : "Persistent native session: not exposed by this provider",
    },
    { key: "host", label: "Execution host", value: p.executionHost ?? "Unknown" },
    { key: "worktree", label: "Worktree", value: p.worktreeLabel ?? "—" },
    {
      key: "access",
      label: "Access",
      value: p.access
        ? `${p.access === "read-only" ? "Read-only" : "Can edit files"}${p.accessVerified ? " (confirmed)" : " (not confirmed)"}`
        : "Unknown",
    },
    { key: "status", label: "Status", value: humanize(p.status) },
    { key: "started", label: "Started", value: p.startedAt ?? "—" },
    { key: "completed", label: "Completed", value: p.finishedAt ?? "—" },
  ];
  if (p.effort) rows.splice(4, 0, { key: "effort", label: "Effort", value: humanize(p.effort) });
  return rows;
}

// ---------------------------------------------------------------------------
// Delivery states on the owner's messages (§5)
// ---------------------------------------------------------------------------

function whoOf(keys: string[], registry: Registry): string {
  const names = [
    ...new Set(
      keys.map((k) => {
        const provider = k.split(":")[0] ?? k;
        return provider === "team" ? "the team" : registryEntry(registry, provider).shortName;
      }),
    ),
  ];
  if (names.length === 0) return "the agents";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function deliveryText(d: MessageDelivery | null, registry: Registry): string | null {
  if (!d) return null;
  switch (d.state) {
    case "sent":
      return "Sent";
    case "queued": {
      const who = whoOf(d.for, registry);
      return d.for.length > 1 ? `Queued for ${who}'s next turns` : `Queued for ${who}'s next turn`;
    }
    case "seen":
      return `Seen by ${whoOf(d.by, registry)}`;
    case "not_delivered":
      return "Not delivered — the work had already ended";
  }
}

// ---------------------------------------------------------------------------
// Live activity (§3, §6)
// ---------------------------------------------------------------------------

export const STALL_AFTER_MS = 3 * 60_000;

export type LiveRowView = {
  key: string;
  runId: string;
  who: string;
  tone: Tone;
  /** "● Reviewing · 3m · last activity 12 s ago". */
  line: string;
  stalled: string | null;
};

const ACTIVITY_WORDS: Record<RunActivity, string> = {
  queued: "Queued",
  reading: "Reading",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  testing: "Testing",
  waiting: "Waiting",
  responding: "Responding",
  integrating: "Integrating",
};

export function liveRow(a: LiveActivity, registry: Registry, now: number): LiveRowView {
  const entry = registryEntry(registry, a.provider, a.providerName || null);
  const started = a.startedAt ? Date.parse(a.startedAt) : NaN;
  const last = a.lastActivityAt ? Date.parse(a.lastActivityAt) : started;
  const parts = [a.activity ? ACTIVITY_WORDS[a.activity] : "Working"];
  if (Number.isFinite(started)) parts.push(elapsed(now - started));
  if (Number.isFinite(last)) parts.push(`last activity ${shortDuration(now - last)} ago`);
  const quiet = Number.isFinite(last) ? now - last : 0;
  return {
    key: a.runId,
    runId: a.runId,
    who: a.role ? `${entry.name} · ${roleLabel(a.role)}` : entry.name,
    tone: entry.tone,
    line: `● ${parts.join(" · ")}`,
    stalled: quiet >= STALL_AFTER_MS ? `No output for ${Math.floor(quiet / 60_000)} min` : null,
  };
}

// ---------------------------------------------------------------------------
// Job controls (§5)
// ---------------------------------------------------------------------------

export type ControlOption = {
  action: JobControl;
  label: string;
  explain: string;
  confirm: boolean;
};

export const CONTROL_TEXT: Readonly<Record<JobControl, Omit<ControlOption, "action">>> = {
  pause_after_step: {
    label: "Pause after this step",
    explain:
      "Agents finish the step they are on, then wait for you. Nothing is lost; resume any time.",
    confirm: false,
  },
  stop_after_review: {
    label: "Stop after review",
    explain: "The current review finishes, then the job stops and reports what it has.",
    confirm: false,
  },
  stop_before_integration: {
    label: "Stop before integration",
    explain: "Work continues up to integration, then stops. Nothing is merged into your branch.",
    confirm: false,
  },
  stop_now: {
    label: "Stop now",
    explain:
      "Stops the agent processes ThreadLink started, right away. Work in progress is not kept.",
    confirm: true,
  },
  cancel_queued: {
    label: "Cancel queued work",
    explain: "Steps that have not started are cancelled. Anything already running finishes.",
    confirm: false,
  },
  resume: {
    label: "Resume",
    explain: "Continue the paused job from where it stopped.",
    confirm: false,
  },
};

export const SEND_NOTE = {
  label: "Send a note",
  explain: "Your message reaches the agents at their next step. Nothing stops.",
};

const PAUSED = new Set(["paused", "needs_user_decision", "interrupted"]);

/** Which controls make sense now. Resume only when paused; never duplicate a pending control. */
export function controlOptions(
  job: { status: string; control: JobControl | null } | null,
): ControlOption[] {
  if (!job) return [];
  const paused = PAUSED.has(job.status) || job.control === "pause_after_step";
  return JOB_CONTROLS.filter((a) =>
    a === "resume" ? paused : a !== job.control || a === "stop_now",
  )
    .filter((a) => !(paused && a === "pause_after_step"))
    .map((a) => ({ action: a, ...CONTROL_TEXT[a] }));
}

export function isJobControl(v: unknown): v is JobControl {
  return typeof v === "string" && (JOB_CONTROLS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type FindingCardView = {
  kind: "finding";
  findingId: string | null;
  category: string;
  severity: string;
  severityTone: Tone;
  /** Agent text: shown attributed to `raisedBy`. */
  title: string;
  raisedBy: string;
  owner: string | null;
  status: FindingState;
  statusLabel: string;
  statusTone: Tone;
  location: string | null;
  /** Every status the finding went through, oldest first (for aria + history). */
  history: FindingState[];
};

export type DecisionCardView = {
  kind: "decision";
  title: string;
  attributedTo: string | null;
  body: string | null;
  /** Shown only inside Details. */
  technicalId: string | null;
};

export type ChoiceOptionView = { key: string; label: string };

export type ChoiceCardView = {
  kind: "choice";
  choiceId: string | null;
  choiceKind: ChoiceKind | null;
  title: string;
  options: ChoiceOptionView[];
  status: "pending" | "chosen" | "expired" | "cancelled";
  chosenLabel: string | null;
};

export type CodeChangeCardView = {
  kind: "code_change";
  by: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  moreFiles: number;
  branch: string | null;
  commit: string | null;
  tests: { command: string; ok: boolean }[];
  diffArtifactId: string | null;
};

export type JobSummaryCardView = {
  kind: "job_summary";
  verdict: string;
  verdictTone: Tone;
  counts: { key: string; label: string; value: number }[];
  tests: string | null;
  agents: string | null;
  finalVerifier: string | null;
  openItems: number;
  reportArtifactId: string | null;
  diffArtifactId: string | null;
};

export type TimeoutCardView = { kind: "timeout"; text: string; choice: ChoiceCardView | null };
export type InterruptedCardView = {
  kind: "interrupted";
  text: string;
  choice: ChoiceCardView | null;
};

export type CardView =
  | FindingCardView
  | DecisionCardView
  | ChoiceCardView
  | CodeChangeCardView
  | JobSummaryCardView
  | TimeoutCardView
  | InterruptedCardView;

const FINDING_STATUS_TEXT: Record<FindingState, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "warning" },
  accepted: { label: "Accepted", tone: "accent" },
  disputed: { label: "Disputed", tone: "danger" },
  fixed: { label: "Fixed", tone: "success" },
  resolved: { label: "Resolved", tone: "success" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

const SEVERITY_TEXT: Record<string, { label: string; tone: Tone }> = {
  blocking: { label: "Blocking", tone: "danger" },
  important: { label: "Important", tone: "warning" },
  non_blocking: { label: "Minor", tone: "neutral" },
};

/** Reads a finding status, mapping the legacy wont_fix to dismissed. */
export function findingState(v: unknown): FindingState | null {
  if (v === "wont_fix") return "dismissed";
  return (FINDING_STATES as readonly string[]).includes(v as string) ? (v as FindingState) : null;
}

function nameOf(v: unknown, registry: Registry): string | null {
  const raw = s(v, 80);
  if (!raw) return null;
  // Participant keys ("codex:coordinator") or provider ids → friendly names.
  const [provider, role] = raw.split(":");
  const entry = registry.byId.get(provider ?? "");
  if (entry) return role ? `${entry.name} · ${roleLabel(role)}` : entry.name;
  if (raw === "owner" || raw === "you") return "You";
  return oneLine(raw, 60);
}

export function findingCard(
  p: Record<string, unknown>,
  registry: Registry,
  history: FindingState[],
  fallbackBy: string,
): FindingCardView {
  const status = history.at(-1) ?? findingState(p.status) ?? "open";
  const sev = SEVERITY_TEXT[s(p.severity, 20) ?? ""] ?? {
    label: humanize(s(p.severity, 20) ?? "finding"),
    tone: "neutral" as Tone,
  };
  const file = s(p.filePath, 300) ?? s(p.file, 300);
  const line = n(p.line);
  return {
    kind: "finding",
    findingId: id(p.findingId) ?? id(p.id),
    category: humanize(s(p.category, 40) ?? "finding"),
    severity: sev.label,
    severityTone: sev.tone,
    title: oneLine(s(p.title, 400) ?? "Finding", 240),
    raisedBy: nameOf(p.raisedBy, registry) ?? fallbackBy,
    owner: nameOf(p.owner ?? p.ownerParticipant, registry),
    status,
    statusLabel: FINDING_STATUS_TEXT[status].label,
    statusTone: FINDING_STATUS_TEXT[status].tone,
    location: file
      ? `${oneLine(file, 200)}${line !== null && line > 0 ? `:${Math.floor(line)}` : ""}`
      : null,
    history: history.length ? history : [status],
  };
}

const CHOICE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export function choiceCard(p: Record<string, unknown>): ChoiceCardView {
  const options = Array.isArray(p.options)
    ? p.options
        .map((o) => {
          const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
          const key = typeof r.key === "string" && CHOICE_KEY.test(r.key) ? r.key : null;
          const label = s(r.label, 80);
          return key && label ? { key, label: oneLine(label, 80) } : null;
        })
        .filter((o): o is ChoiceOptionView => o !== null)
        .slice(0, 6)
    : [];
  const status =
    p.status === "chosen" || p.status === "expired" || p.status === "cancelled"
      ? p.status
      : "pending";
  const chosenKey = s(p.chosenKey, 40);
  const kind = (CHOICE_KINDS as readonly string[]).includes(p.kind as string)
    ? (p.kind as ChoiceKind)
    : null;
  return {
    kind: "choice",
    choiceId: id(p.choiceId) ?? id(p.id),
    choiceKind: kind,
    title: oneLine(s(p.title, 300) ?? "ThreadLink needs your decision", 240),
    options,
    status,
    chosenLabel: chosenKey
      ? (options.find((o) => o.key === chosenKey)?.label ?? humanize(chosenKey))
      : null,
  };
}

const STEP_VERBS: Record<string, string> = {
  normalise: "preparing the request",
  plan: "planning",
  plan_review: "reviewing the plan",
  build: "building",
  review: "reviewing",
  security_review: "security-reviewing",
  inspection: "inspecting",
  verify: "running the checks",
};

/** "Claude Code timed out after 30 min while reviewing auth-module." — from trusted payload. */
export function timeoutText(
  p: Record<string, unknown>,
  registry: Registry,
  fallback: string,
): string {
  const provider = s(p.provider, 40);
  const minutes =
    n(p.minutes) ?? (n(p.timeoutMs) !== null ? Math.round(n(p.timeoutMs)! / 60_000) : null);
  if (!provider || minutes === null) return oneLine(fallback, 300);
  const who = registryEntry(registry, provider).name;
  const step = s(p.step, 40);
  const verb = step ? (STEP_VERBS[step] ?? humanize(step).toLowerCase()) : null;
  const subject = s(p.subject, 80) ?? s(p.unit, 80);
  const tail = verb ? ` while ${verb}${subject ? ` ${oneLine(subject, 80)}` : ""}` : "";
  return `${who} timed out after ${minutes} min${tail}.`;
}

const VERDICT_TONES: Record<string, Tone> = {
  PASS: "success",
  NEEDS_FIX: "danger",
  BLOCKED: "danger",
};
const VERDICT_WORDS: Record<string, string> = {
  PASS: "Passed",
  NEEDS_FIX: "Needs fixes",
  BLOCKED: "Blocked",
  PARTIAL: "Partly done",
};

export function jobSummaryCard(p: Record<string, unknown>, registry: Registry): JobSummaryCardView {
  const verdict = s(p.verdict, 20) ?? "";
  const counts: JobSummaryCardView["counts"] = [];
  const f = (p.findings && typeof p.findings === "object" ? p.findings : {}) as Record<
    string,
    unknown
  >;
  const add = (key: string, label: string, v: unknown) => {
    const x = n(v);
    if (x !== null) counts.push({ key, label, value: Math.max(0, Math.floor(x)) });
  };
  // Server shape: {units:{done,total}, findings:{byState:{open,resolved,dismissed}}, tests:{run,passed}}.
  const units = (p.units && typeof p.units === "object" ? p.units : {}) as Record<string, unknown>;
  const byState = (f.byState && typeof f.byState === "object" ? f.byState : f) as Record<
    string,
    unknown
  >;
  const tests = (p.tests && typeof p.tests === "object" ? p.tests : {}) as Record<string, unknown>;
  add("units", "Units done", units.done ?? p.unitsDone);
  add("open", "Open findings", byState.open ?? p.openFindings);
  add("fixed", "Fixed", byState.fixed);
  add("resolved", "Resolved", byState.resolved);
  add("dismissed", "Dismissed", byState.dismissed);
  add("changes", "Code changes", p.changes);
  const run = n(tests.run) ?? n(p.testsRun);
  const passed = n(tests.passed) ?? n(p.testsPassed);
  const agents = Array.isArray(p.agents)
    ? p.agents
        .map((a) => nameOf(a, registry))
        .filter((a): a is string => Boolean(a))
        .slice(0, 8)
    : [];
  return {
    kind: "job_summary",
    verdict: VERDICT_WORDS[verdict] ?? (verdict ? humanize(verdict) : "Finished"),
    verdictTone: VERDICT_TONES[verdict] ?? "warning",
    counts,
    tests: run !== null ? `${passed ?? 0} of ${run} checks passed` : null,
    agents: agents.length ? agents.join(", ") : null,
    finalVerifier: nameOf(p.finalVerifier, registry),
    openItems: Math.max(0, Math.floor(n(p.openItems) ?? 0)),
    reportArtifactId: id(p.reportArtifactId),
    diffArtifactId: id(p.diffArtifactId),
  };
}

export function codeChangeCard(p: Record<string, unknown>, by: string): CodeChangeCardView {
  const files = Array.isArray(p.files)
    ? p.files.filter((f): f is string => typeof f === "string").map((f) => oneLine(f, 200))
    : [];
  const shown = files.slice(0, 12);
  const tests = Array.isArray(p.tests)
    ? p.tests
        .map((t) => {
          const r = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
          const command = s(r.command, 200);
          return command ? { command: oneLine(command, 200), ok: r.ok === true } : null;
        })
        .filter((t): t is { command: string; ok: boolean } => t !== null)
        .slice(0, 10)
    : [];
  const count = (v: unknown) => Math.max(0, Math.floor(n(v) ?? 0));
  return {
    kind: "code_change",
    by,
    filesChanged: count(p.filesChanged) || files.length,
    insertions: count(p.insertions),
    deletions: count(p.deletions),
    files: shown,
    moreFiles: Math.max(0, (count(p.filesChanged) || files.length) - shown.length),
    branch: s(p.branch, 120),
    commit: s(p.commit, 12),
    tests,
    diffArtifactId: id(p.diffArtifactId) ?? id(p.artifactId),
  };
}

// ---------------------------------------------------------------------------
// Phases (§3)
// ---------------------------------------------------------------------------

export const PHASES = ["planning", "build", "review", "integration", "final_check"] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABELS: Record<Phase, string> = {
  planning: "Planning",
  build: "Build",
  review: "Review",
  integration: "Integration",
  final_check: "Final check",
};
const STATUS_PHASE: Record<string, Phase> = {
  planning: "planning",
  plan_review: "planning",
  building: "build",
  reviewing: "review",
  integrating: "integration",
  inspecting: "final_check",
  verifying: "final_check",
};

export function phaseOf(e: TimelineEvent): Phase | null {
  const p = e.payload;
  const raw = s(p?.phase, 20) ?? (e.eventType === "job_status" ? s(p?.status, 20) : null);
  if (!raw) return null;
  if ((PHASES as readonly string[]).includes(raw)) return raw as Phase;
  return STATUS_PHASE[raw] ?? null;
}

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

export type QuoteView = { targetId: string; who: string; excerpt: string };

export type MessageItem = {
  kind: "message";
  key: string;
  eventId: string;
  chatSeq: number;
  identity: Identity;
  /** First message of a same-speaker run: shows the header. */
  showHeader: boolean;
  body: string;
  kindLabel: string | null;
  audience: string | null;
  round: string | null;
  at: string;
  runId: string | null;
  jobId: string | null;
  quote: QuoteView | null;
  delivery: string | null;
  technical: boolean;
  phase: Phase | null;
};

export type NoteItem = {
  kind: "note";
  key: string;
  eventId: string;
  chatSeq: number;
  text: string;
  tone: Tone;
  symbol: "✓" | "●" | "✕" | "·" | "!";
  callout: boolean;
  at: string;
  technical: boolean;
  phase: Phase | null;
};

export type CardItem = {
  kind: "card";
  key: string;
  eventId: string;
  chatSeq: number;
  identity: Identity;
  card: CardView;
  at: string;
  runId: string | null;
  jobId: string | null;
  quote: QuoteView | null;
  technical: boolean;
  phase: Phase | null;
};

export type PhaseItem = {
  kind: "phase";
  key: string;
  phase: Phase;
  label: string;
  chatSeq: number;
};
export type UnreadItem = { kind: "unread"; key: string; chatSeq: number; count: number };

export type TimelineItem = MessageItem | NoteItem | CardItem | PhaseItem | UnreadItem;

export type BuildOptions = {
  technical?: boolean;
  /** The owner's read cursor when the chat was opened (unread divider goes after it). */
  lastReadSeq?: number | null;
  /** Finding states from the findings list (server truth), by finding id. */
  findingStates?: ReadonlyMap<string, FindingState>;
  /** Finding rows from the findings list (title, owner, file…), by finding id. */
  findings?: ReadonlyMap<string, Record<string, unknown>>;
  /** Choice states from the choices list, by choice id. */
  choices?: ReadonlyMap<string, Record<string, unknown>>;
};

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  proposal: "Proposal",
  review: "Review",
  response: "Response",
  question: "Question",
  decision: "Decision",
  completion: "Done",
  handoff: "Handoff",
  finding: "Finding",
};

const DONE = new Set(["plan_agreed", "task_completed", "mode_changed"]);
const ACTIVE = new Set([
  "job_started",
  "job_status",
  "task_started",
  "task_progress",
  "unit_status",
  "owner_routed",
  "model_used",
]);
const STOPPED = new Set(["task_failed", "task_cancelled", "model_mismatch", "provider_blocked"]);
const NOTE_TONES: Record<string, Tone> = {
  task_failed: "danger",
  finding: "warning",
  model_mismatch: "danger",
  stop_requested: "warning",
  control_requested: "warning",
  plan_agreed: "accent",
  job_started: "accent",
  provider_blocked: "warning",
};

function verdictToneOf(body: string): Tone {
  const verdict = /^Result: ([A-Z_]+)(?:\s|$)/.exec(body)?.[1];
  if (verdict === "PASS") return "success";
  if (verdict === "NEEDS_FIX" || verdict === "BLOCKED") return "danger";
  return "warning";
}

function noteSymbol(e: TimelineEvent, tone: Tone): NoteItem["symbol"] {
  if (e.eventType === "job_verdict")
    return tone === "success" ? "✓" : tone === "danger" ? "✕" : "·";
  if (e.eventType === "control_requested" || e.eventType === "stop_requested") return "!";
  if (DONE.has(e.eventType)) return "✓";
  if (STOPPED.has(e.eventType)) return "✕";
  if (ACTIVE.has(e.eventType)) return "●";
  return "·";
}

const CARD_TYPES = new Set([
  "finding",
  "decision",
  "decision_card",
  "choice",
  "code_change",
  "job_summary",
  "timeout",
  "interrupted",
]);

/** Target of a status update: a later row that refers to a finding by ref. */
function findingKey(e: TimelineEvent): string | null {
  if (e.ref?.kind === "finding") return e.ref.id;
  if (e.eventType === "finding" && e.payload) return id(e.payload.findingId) ?? id(e.payload.id);
  return null;
}

function firstLine(body: string): string {
  return oneLine(body.split("\n")[0] ?? "", 240);
}

/** A decision card: a human title; the TL number only in Details. */
function decisionCard(e: TimelineEvent, by: string): DecisionCardView {
  const p = e.payload ?? {};
  const source = p.titleSource === "agent" ? "agent" : "threadlink";
  const num = n(p.number);
  const title = s(p.title, 300) ?? firstLine(e.body.replace(/\bTL-\d{1,8}\b\s*/g, ""));
  return {
    kind: "decision",
    title: oneLine(title, 200) || "Decision recorded",
    attributedTo: source === "agent" && e.authorKind === "agent" ? by : null,
    body: p.requiresUser === true ? "This needs your decision." : s(p.detail, 2000),
    technicalId:
      num !== null ? `TL-${String(Math.floor(num)).padStart(5, "0")}` : s(p.decisionId, 40),
  };
}

/**
 * Builds the timeline's view model in ONE linear pass (plus one pre-pass for
 * finding state history). Pure; safe to memoise on (events, options).
 */
export function buildTimeline(
  events: TimelineEvent[],
  registry: Registry,
  opts: BuildOptions = {},
): TimelineItem[] {
  const technical = opts.technical === true;

  // Pre-pass: finding status history and which rows are status-only updates.
  const history = new Map<string, FindingState[]>();
  const firstFindingRow = new Map<string, string>();
  const byId = new Map<string, TimelineEvent>();
  for (const e of events) {
    byId.set(e.id, e);
    const key = findingKey(e);
    if (!key) continue;
    const st = findingState(e.payload?.status);
    if (e.eventType === "finding" && !firstFindingRow.has(key)) firstFindingRow.set(key, e.id);
    if (st) {
      const h = history.get(key) ?? [];
      if (h.at(-1) !== st) h.push(st);
      history.set(key, h);
    }
  }
  // The findings list is the server's truth: its status is the latest state.
  const listed = new Map(opts.findingStates ?? []);
  for (const [key, row] of opts.findings ?? []) {
    const st = findingState(row.status);
    if (st) listed.set(key, st);
  }
  if (listed.size) {
    for (const [key, st] of listed) {
      const h = history.get(key) ?? [];
      if (h.at(-1) !== st) h.push(st);
      history.set(key, h);
    }
  }

  const items: TimelineItem[] = [];
  let phase: Phase | null = null;
  let lastSpeaker: string | null = null;
  let lastAt = 0;
  let unreadPlaced = opts.lastReadSeq === null || opts.lastReadSeq === undefined;
  let unreadIndex = -1;
  let unreadCount = 0;

  const quoteOf = (e: TimelineEvent): QuoteView | null => {
    if (!e.replyTo) return null;
    const target = byId.get(e.replyTo);
    if (!target)
      return { targetId: e.replyTo, who: "an earlier message", excerpt: "Not loaded yet" };
    return {
      targetId: target.id,
      who: identityOf(target, registry).headline,
      excerpt: oneLine(target.body, 90),
    };
  };

  for (const e of events) {
    if (e.visibility === "technical" && !technical) continue;

    const p = phaseOf(e);
    if (p && p !== phase) {
      phase = p;
      items.push({
        kind: "phase",
        key: `phase-${e.id}`,
        phase: p,
        label: PHASE_LABELS[p],
        chatSeq: e.chatSeq,
      });
      lastSpeaker = null;
      if (e.eventType === "phase") continue;
    } else if (e.eventType === "phase") {
      continue;
    }

    if (!unreadPlaced && e.chatSeq > (opts.lastReadSeq ?? 0) && e.authorKind !== "owner") {
      unreadPlaced = true;
      unreadIndex = items.length;
      items.push({ kind: "unread", key: "unread", chatSeq: e.chatSeq, count: 0 });
    }
    if (unreadIndex >= 0 && e.authorKind !== "owner") unreadCount++;

    const at = Date.parse(e.createdAt);
    const identity = identityOf(e, registry);

    // Cards (payload-backed rows).
    if (CARD_TYPES.has(e.eventType) && e.payload) {
      const key = findingKey(e);
      if (e.eventType === "finding" && key && firstFindingRow.get(key) !== e.id) {
        // A status update of an earlier finding: the card above changes; this row is a short note.
        const st = findingState(e.payload.status);
        items.push({
          kind: "note",
          key: e.id,
          eventId: e.id,
          chatSeq: e.chatSeq,
          text: st
            ? `Finding marked ${FINDING_STATUS_TEXT[st].label.toLowerCase()}: ${oneLine(s(e.payload.title, 200) ?? e.body, 120)}`
            : oneLine(e.body, 300),
          tone: st ? FINDING_STATUS_TEXT[st].tone : "neutral",
          symbol: "·",
          callout: false,
          at: e.createdAt,
          technical: e.visibility === "technical",
          phase,
        });
        lastSpeaker = null;
        continue;
      }
      let card: CardView;
      const by = identity.headline;
      switch (e.eventType) {
        case "finding": {
          // The finding's title is agent text: it comes from the findings list
          // (attributed to the raising agent), never from the ThreadLink row.
          const row = key ? opts.findings?.get(key) : undefined;
          const merged = row ? { ...e.payload, ...row } : e.payload;
          card = findingCard(
            { ...merged, title: s(merged.title, 400) ?? firstLine(e.body) },
            registry,
            key ? (history.get(key) ?? []) : [],
            by,
          );
          break;
        }
        case "decision":
        case "decision_card":
          card = decisionCard(e, by);
          break;
        case "choice": {
          const cid = id(e.payload.choiceId) ?? id(e.payload.id);
          const live = cid ? opts.choices?.get(cid) : undefined;
          const merged = live ? { ...e.payload, ...live } : e.payload;
          card = choiceCard({ ...merged, title: s(merged.title, 300) ?? firstLine(e.body) });
          break;
        }
        case "code_change":
          card = codeChangeCard(e.payload, by);
          break;
        case "job_summary":
          card = jobSummaryCard(e.payload, registry);
          break;
        case "timeout":
        case "interrupted": {
          const c =
            e.payload.choice && typeof e.payload.choice === "object"
              ? (e.payload.choice as Record<string, unknown>)
              : null;
          const cid = c ? (id(c.choiceId) ?? id(c.id)) : e.ref?.kind === "choice" ? e.ref.id : null;
          const live = cid ? opts.choices?.get(cid) : undefined;
          const choice =
            c || live
              ? choiceCard({ ...(c ?? {}), ...(live ?? {}), ...(cid ? { choiceId: cid } : {}) })
              : null;
          card =
            e.eventType === "timeout"
              ? {
                  kind: "timeout",
                  // A ThreadLink row's text is built by the database from trusted state.
                  text:
                    e.authorKind === "threadlink" && e.body.trim()
                      ? oneLine(e.body, 300)
                      : timeoutText(e.payload, registry, e.body),
                  choice,
                }
              : {
                  kind: "interrupted",
                  text: oneLine(s(e.payload.text, 300) ?? e.body, 300),
                  choice,
                };
          break;
        }
        default:
          continue;
      }
      items.push({
        kind: "card",
        key: e.id,
        eventId: e.id,
        chatSeq: e.chatSeq,
        identity,
        card,
        at: e.createdAt,
        runId: e.runId,
        jobId: e.jobId,
        quote: quoteOf(e),
        technical: e.visibility === "technical",
        phase,
      });
      lastSpeaker = null;
      continue;
    }

    if (e.authorKind === "threadlink") {
      if (e.eventType === "decision") {
        // A pre-0.10 decision row: "Decision TL-00001". The number is for Details only.
        const text = e.body
          .replace(/\bTL-\d{1,8}\b\s*/g, "")
          .replace(/\s+/g, " ")
          .trim();
        items.push({
          kind: "note",
          key: e.id,
          eventId: e.id,
          chatSeq: e.chatSeq,
          text: text && text !== "Decision" ? text : "Decision recorded",
          tone: /needs your decision/i.test(e.body) ? "warning" : "neutral",
          symbol: "·",
          callout: false,
          at: e.createdAt,
          technical: e.visibility === "technical",
          phase,
        });
        lastSpeaker = null;
        continue;
      }
      const tone =
        e.eventType === "job_verdict"
          ? verdictToneOf(e.body)
          : (NOTE_TONES[e.eventType] ?? "neutral");
      items.push({
        kind: "note",
        key: e.id,
        eventId: e.id,
        chatSeq: e.chatSeq,
        text: oneLine(e.body, 400),
        tone,
        symbol: noteSymbol(e, tone),
        callout: e.eventType === "provider_blocked",
        at: e.createdAt,
        technical: e.visibility === "technical",
        phase,
      });
      lastSpeaker = null;
      continue;
    }

    const showHeader =
      lastSpeaker !== identity.speaker ||
      !Number.isFinite(at) ||
      at - lastAt > 5 * 60_000 ||
      e.replyTo !== null;
    lastSpeaker = identity.speaker;
    lastAt = at;
    items.push({
      kind: "message",
      key: e.id,
      eventId: e.id,
      chatSeq: e.chatSeq,
      identity,
      showHeader,
      body: e.body,
      kindLabel: e.messageType
        ? (MESSAGE_TYPE_LABELS[e.messageType] ?? humanize(e.messageType))
        : null,
      audience:
        e.audience && e.authorKind !== "agent"
          ? e.audience === "team"
            ? "To the team"
            : `To ${registryEntry(registry, e.audience).name}`
          : null,
      round: e.round !== null && e.round > 0 ? `Round ${e.round}` : null,
      at: e.createdAt,
      runId: e.runId,
      jobId: e.jobId,
      quote: quoteOf(e),
      delivery: e.authorKind === "owner" ? deliveryText(e.delivery, registry) : null,
      technical: e.visibility === "technical",
      phase,
    });
  }

  if (unreadIndex >= 0) {
    if (unreadCount === 0) items.splice(unreadIndex, 1);
    else (items[unreadIndex] as UnreadItem).count = unreadCount;
  }
  return items;
}

/** Hides items inside collapsed phases (the separator itself stays). */
export function applyCollapsed(
  items: TimelineItem[],
  collapsed: ReadonlySet<Phase>,
): TimelineItem[] {
  if (collapsed.size === 0) return items;
  let hidden = false;
  const out: TimelineItem[] = [];
  for (const it of items) {
    if (it.kind === "phase") {
      hidden = collapsed.has(it.phase);
      out.push(it);
    } else if (!hidden || it.kind === "unread") {
      out.push(it);
    }
  }
  return out;
}

/** Event id → item key, for reply jumps. Only rows that render as items. */
export function replyTargets(items: TimelineItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const it of items) if ("eventId" in it) map.set(it.eventId, it.key);
  return map;
}

/**
 * Where a reply jump should go: the item key when the target is loaded and
 * visible, "load_older" when it is older than what is loaded, or "missing".
 */
export function resolveJump(
  targetId: string,
  targets: ReadonlyMap<string, string>,
  loaded: TimelineEvent[],
  hasOlder: boolean,
): { kind: "item"; key: string } | { kind: "load_older" } | { kind: "missing" } {
  const key = targets.get(targetId);
  if (key) return { kind: "item", key };
  if (loaded.some((e) => e.id === targetId)) return { kind: "missing" };
  return hasOlder ? { kind: "load_older" } : { kind: "missing" };
}

/** The window of items rendered: the last `size` items ending at the newest. */
export function windowItems<T>(items: T[], size: number): { items: T[]; hiddenBefore: number } {
  if (items.length <= size) return { items, hiddenBefore: 0 };
  return { items: items.slice(items.length - size), hiddenBefore: items.length - size };
}

// ---------------------------------------------------------------------------
// Polling backoff
// ---------------------------------------------------------------------------

export const POLL_VISIBLE_MS = 3_000;
export const POLL_HIDDEN_MS = 15_000;
export const POLL_MAX_BACKOFF_MS = 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;

/** Next poll delay: base by visibility, doubled per consecutive failure, capped; null when idle. */
export function nextPollDelay(state: {
  visible: boolean;
  idleMs: number;
  failures: number;
  working: boolean;
}): number | null {
  if (state.idleMs >= IDLE_AFTER_MS) return null;
  const base = state.visible
    ? state.working
      ? POLL_VISIBLE_MS
      : POLL_VISIBLE_MS * 2
    : POLL_HIDDEN_MS;
  if (state.failures <= 0) return base;
  return Math.min(POLL_MAX_BACKOFF_MS, base * 2 ** Math.min(state.failures, 6));
}

// ---------------------------------------------------------------------------
// Composer hint
// ---------------------------------------------------------------------------

/** What a send will do, above the composer. From the registry's aliases; the server decides. */
export function composerBanner(
  activeJob: { status: string } | null,
  draft: string,
  registry: Registry,
  how: string,
): { text: string; tone: Tone } {
  const target = mentionTarget(registry, draft);
  if (activeJob) {
    const who = target && target !== "team" ? registryEntry(registry, target).name : "the agents";
    return {
      text: `Sent as a note to the running work: ${who} read${who === "the agents" ? "" : "s"} it at the next step. Use Controls to pause or stop.`,
      tone: "accent",
    };
  }
  if (target === "team") return { text: "Starts new work for the whole team.", tone: "neutral" };
  if (target)
    return {
      text: `Starts new work for ${registryEntry(registry, target).name} only (from your @mention).`,
      tone: "neutral",
    };
  return { text: `Starts new work in this chat · ${how}.`, tone: "neutral" };
}
