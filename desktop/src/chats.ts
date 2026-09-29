/**
 * Chats in the desktop app (0.10, docs/design/threadlink-0.10.md §9): the same
 * server timeline as the web, read and written through the runtime-credential
 * chat API. Pure and Electron-free, so it is unit-tested directly.
 *
 * - Views: chat list rows, sections, identities, message bodies and live rows.
 *   Everything here is plain text for textContent; bodies are stripped of ANSI
 *   and control characters, fenced code is kept as preformatted blocks, and
 *   huge bodies are collapsed.
 * - IPC: every argument from the (untrusted) renderer is validated against an
 *   allow-list shape, and each operation is rate-limited in main.
 * - Errors come back as fixed codes; server text never reaches the renderer
 *   except the refusal sentence the API defines, sanitised.
 */

import type {
  ChatApi,
  ChatDelivery,
  ChatEventsPage,
  ChatLane,
  ChatListItem,
  ChatLiveRun,
  ChatMode,
  ChatParticipant,
  ChatProject,
  ChatTimelineEvent,
  FailoverPolicy,
  HostPresence,
} from "threadlink";

// ---------------------------------------------------------------------------
// Shared presentation (0.11 §7)
// ---------------------------------------------------------------------------

/**
 * Where a timeline row belongs: the main chat, or the drawer's Activity.
 * The shared module (runtime/src/chat-presentation.ts, used by web + desktop
 * + terminal) is injected by main when the embedded Runtime exports it; the
 * fallback below follows the same contract so the desktop never shows
 * ThreadLink's routine narration in the chat.
 */
export type Placement = "chat" | "activity";

export type Presentation = {
  chatPlacement?: (event: never) => unknown;
  agentShortName?: (provider: never) => unknown;
  humanSystemText?: (event: never) => unknown;
};

/** ThreadLink rows that belong in the conversation itself (§7). */
const CHAT_SYSTEM_TYPES = new Set([
  "provider_blocked",
  "usage_exhausted",
  "provider_usage",
  "usage_notice",
  "failover",
  "failover_notice",
  "provider_available",
  "choice",
  "approval",
  "approval_required",
  "timeout",
  "interrupted",
  "job_summary",
  "job_verdict",
  "plan_agreed",
  "code_change",
  "mode_changed",
  "error",
  "job_failed",
  "work_stopped",
]);

const IMPORTANT_SEVERITY = new Set(["blocking", "important"]);

export function fallbackPlacement(
  e: Pick<ChatTimelineEvent, "authorKind" | "eventType" | "visibility"> & {
    payload?: Record<string, unknown> | null;
  },
): Placement {
  if (e.visibility === "technical") return "activity";
  if (e.authorKind !== "threadlink") return "chat";
  if (e.eventType === "finding") {
    const p = e.payload ?? {};
    const status = typeof p.status === "string" ? p.status : "open";
    return IMPORTANT_SEVERITY.has(String(p.severity)) && status === "open" ? "chat" : "activity";
  }
  return CHAT_SYSTEM_TYPES.has(e.eventType) ? "chat" : "activity";
}

export function placementOf(e: ChatTimelineEvent, present: Presentation = {}): Placement {
  if (typeof present.chatPlacement === "function") {
    try {
      const p = present.chatPlacement(e as never);
      if (p === "chat" || p === "activity") return p;
    } catch {
      /* fall back */
    }
  }
  return fallbackPlacement(e);
}

/** "Claude" / "Codex" (short names in chats; full names only on Agents and provenance). */
export const SHORT_NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex" };

export function shortNameOf(
  provider: string | null,
  participants: ChatParticipant[],
  present: Presentation = {},
): string | null {
  if (!provider) return null;
  const meta = participants.find((p) => p.kind === "agent" && p.provider === provider);
  if (meta?.shortName && cleanLine(meta.shortName, 30)) return cleanLine(meta.shortName, 30);
  if (typeof present.agentShortName === "function") {
    try {
      const n = present.agentShortName(provider as never);
      if (typeof n === "string" && cleanLine(n, 30)) return cleanLine(n, 30);
    } catch {
      /* fall back */
    }
  }
  return SHORT_NAMES[provider] ?? (meta ? cleanLine(meta.name, 30) : null);
}

/** ThreadLink-owned ids never appear in chat text (§3.5): drop any that slipped in. */
const THREADLINK_ID = /\btl[a-z]{2,4}_[0-9a-f]{6,}\b/g;
const REASON_CODE = /\(\s*[a-z]+(?:_[a-z]+)+\s*\)/g;

export function systemText(e: ChatTimelineEvent, present: Presentation = {}): string {
  let text = cleanText(e.body).replace(REASON_CODE, "");
  if (typeof present.humanSystemText === "function") {
    try {
      const t = present.humanSystemText(e as never);
      if (typeof t === "string" && t.trim()) text = cleanText(t);
    } catch {
      /* fall back */
    }
  }
  // ThreadLink-owned ids (tljob_…, tlrun_…) never reach the screen, whoever wrote the words.
  return text
    .replace(THREADLINK_ID, "")
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1");
}

// ---------------------------------------------------------------------------
// Safe text
// ---------------------------------------------------------------------------

const ANSI = new RegExp(
  [
    "\\u001b\\[[0-?]*[ -\\/]*[@-~]",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?",
    "\\u001b[P^_][^\\u001b]*(?:\\u001b\\\\)?",
    "\\u001b[@-Z\\\\-_]",
    "\\u009b[0-?]*[ -\\/]*[@-~]",
  ].join("|"),
  "g",
);
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
const BIDI = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c]", "g");

/** Printable text: no ANSI, no control characters (except \n and \t), no bidi overrides. */
export function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "").replace(BIDI, "");
}

/** One short line of untrusted text. */
export function cleanLine(input: unknown, max = 120): string {
  const flat = cleanText(input)
    .replace(/[\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type BodyBlock = { t: "text"; v: string } | { t: "code"; v: string };
export type BodyView = {
  /** What is shown first. */
  preview: BodyBlock[];
  /** Only for a collapsed body: the rest, up to FULL_MAX_CHARS. Null when nothing more. */
  full: BodyBlock[] | null;
  collapsed: boolean;
  /** True when even `full` was cut (the web has the complete text). */
  truncated: boolean;
};

export const PREVIEW_MAX_CHARS = 1500;
export const PREVIEW_MAX_LINES = 24;
export const FULL_MAX_CHARS = 64 * 1024;

/** Text and ``` fenced code blocks, in order. An unclosed fence runs to the end. */
export function splitBlocks(text: string): BodyBlock[] {
  const out: BodyBlock[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let code = false;
  const flush = () => {
    const v = buf.join("\n");
    if (code) out.push({ t: "code", v });
    else if (v.trim()) out.push({ t: "text", v: v.replace(/^\n+|\n+$/g, "") });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush();
      code = !code;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function bodyView(body: unknown): BodyView {
  const text = cleanText(body).replace(/\s+$/, "");
  const lines = text.split("\n");
  const long = text.length > PREVIEW_MAX_CHARS || lines.length > PREVIEW_MAX_LINES;
  if (!long) return { preview: splitBlocks(text), full: null, collapsed: false, truncated: false };
  let preview = lines.slice(0, PREVIEW_MAX_LINES).join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) preview = preview.slice(0, PREVIEW_MAX_CHARS);
  const truncated = text.length > FULL_MAX_CHARS;
  return {
    preview: splitBlocks(`${preview}…`),
    full: splitBlocks(truncated ? text.slice(0, FULL_MAX_CHARS) : text),
    collapsed: true,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

export const MODE_BADGE: Record<string, string> = { solo: "SOLO", pair: "PAIR", team: "TEAM" };

export type ChatState = "Working" | "Ready" | "Needs you";

const FINISHED = /^(completed|done|passed|pass|failed|cancelled|blocked|needs_fix)$/i;

export function chatState(c: Pick<ChatListItem, "needsAttention" | "activeJob">): ChatState {
  if (c.needsAttention) return "Needs you";
  if (c.activeJob && !FINISHED.test(c.activeJob.status)) return "Working";
  return "Ready";
}

/** "Claude + Codex", from provider metadata (short names); never a per-provider switch. */
export function participantsText(participants: ChatParticipant[]): string {
  const names = agentNames(participants);
  return names.length ? names.join(" + ") : "No agents yet";
}

/** The agents of a chat by short name ("Claude", "Codex"), in order, once each. */
export function agentNames(participants: ChatParticipant[]): string[] {
  const names: string[] = [];
  for (const p of participants) {
    if (p.kind !== "agent") continue;
    const name = shortNameOf(p.provider, participants) ?? cleanLine(p.name, 40);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export type ChatRowView = {
  chatId: string;
  name: string;
  project: string | null;
  mode: string;
  modeBadge: string;
  participants: string;
  state: ChatState;
  stateTone: "run" | "ready" | "wait";
  unread: boolean;
  unreadCount: number;
  pinned: boolean;
  lastActivityAt: string | null;
  /** The project runs on this computer (server-computed). */
  thisComputer: boolean;
};

export function chatRow(c: ChatListItem): ChatRowView {
  const state = chatState(c);
  return {
    chatId: c.chatId,
    name: cleanLine(c.name, 100) || "Untitled chat",
    project: c.projectName ? cleanLine(c.projectName, 100) : null,
    mode: c.mode,
    modeBadge: MODE_BADGE[c.mode] ?? "SOLO",
    participants: participantsText(c.participants),
    state,
    stateTone: state === "Working" ? "run" : state === "Needs you" ? "wait" : "ready",
    unread: c.unread,
    unreadCount: c.unread ? Math.max(1, c.unreadCount ?? 1) : 0,
    pinned: c.pinned,
    lastActivityAt: c.lastActivityAt,
    thisComputer: c.thisComputer === true,
  };
}

export type ProjectView = {
  roomId: string;
  name: string;
  /** "This computer" / the host's name / null when the project has no host yet. */
  runsOn: string | null;
  thisComputer: boolean;
  chats: ChatRowView[];
};

/** Projects with their chats (most recent first), for the Projects page. */
export function projectViews(projects: ChatProject[], chats: ChatListItem[]): ProjectView[] {
  const live = chats.filter((c) => !c.archived).sort(byRecent);
  const out: ProjectView[] = [];
  const seen = new Set<string>();
  for (const p of projects) {
    if (seen.has(p.roomId)) continue;
    seen.add(p.roomId);
    out.push({
      roomId: p.roomId,
      name: cleanLine(p.name, 100) || "Project",
      runsOn:
        p.thisComputer === true
          ? "This computer"
          : p.runtimeLabel
            ? cleanLine(p.runtimeLabel, 60)
            : null,
      thisComputer: p.thisComputer === true,
      chats: live
        .filter((c) => c.roomId === p.roomId)
        .slice(0, SECTION_LIMIT)
        .map(chatRow),
    });
  }
  // Projects only known from their chats (an older server lists no projects).
  for (const c of live) {
    if (!c.roomId || seen.has(c.roomId) || !c.projectName) continue;
    seen.add(c.roomId);
    out.push({
      roomId: c.roomId,
      name: cleanLine(c.projectName, 100),
      runsOn: c.thisComputer
        ? "This computer"
        : c.runtimeLabel
          ? cleanLine(c.runtimeLabel, 60)
          : null,
      thisComputer: c.thisComputer === true,
      chats: live
        .filter((x) => x.roomId === c.roomId)
        .slice(0, SECTION_LIMIT)
        .map(chatRow),
    });
  }
  return out.slice(0, 100);
}

export type ChatSection = { title: string; rows: ChatRowView[] };

/** At most this many rows per section: the list stays bounded. */
export const SECTION_LIMIT = 50;

const byRecent = (a: ChatListItem, b: ChatListItem) =>
  (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0);

/** Pinned, then Recent — or Pinned, then one section per project. */
export function chatSections(chats: ChatListItem[], groupBy: "recent" | "project"): ChatSection[] {
  const live = chats.filter((c) => !c.archived).sort(byRecent);
  const sections: ChatSection[] = [];
  const pinned = live.filter((c) => c.pinned);
  if (pinned.length)
    sections.push({ title: "Pinned", rows: pinned.slice(0, SECTION_LIMIT).map(chatRow) });
  const rest = live.filter((c) => !c.pinned);
  if (groupBy === "recent") {
    if (rest.length)
      sections.push({ title: "Recent", rows: rest.slice(0, SECTION_LIMIT).map(chatRow) });
    return sections;
  }
  const groups = new Map<string, ChatListItem[]>();
  for (const c of rest) {
    const key = c.projectName ? cleanLine(c.projectName, 100) : "";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const [project, list] of groups) {
    if (!project) continue;
    sections.push({ title: project, rows: list.slice(0, SECTION_LIMIT).map(chatRow) });
  }
  const none = groups.get("");
  if (none?.length)
    sections.push({ title: "No project", rows: none.slice(0, SECTION_LIMIT).map(chatRow) });
  return sections;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type IdentityView = {
  kind: "you" | "controller" | "threadlink" | "agent";
  /** "Codex · reviewer" (short name + role). */
  label: string;
  /** "Codex" / "Claude" / "You" / "ThreadLink" / "ChatGPT". */
  short: string;
  /** Full provider name for the provenance drawer ("Claude Code"). */
  full: string;
  role: string | null;
  /** One letter for the avatar. */
  initial: string;
  /** The agent's provider id (styles its avatar colours), or null. */
  provider?: string | null;
  /** A stable colour slot (0-5) for an agent, derived from its provider id. */
  hue: number | null;
};

/** A provider id to a stable colour slot, so a new provider is styled without code changes. */
export function hueOf(provider: string): number {
  let h = 0;
  for (const ch of provider) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

const initialOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
/** The canvas's avatar letters: C for Claude, X for Codex (C would be ambiguous). */
const AVATAR_LETTERS: Record<string, string> = { "claude-code": "C", codex: "X" };

export function identityOf(
  e: Pick<ChatTimelineEvent, "authorKind" | "authorProvider" | "authorLabel" | "authorRole">,
  participants: ChatParticipant[],
  present: Presentation = {},
): IdentityView {
  if (e.authorKind === "owner")
    return {
      kind: "you",
      label: "You",
      short: "You",
      full: "You",
      role: null,
      initial: "Y",
      hue: null,
    };
  if (e.authorKind === "threadlink")
    return {
      kind: "threadlink",
      label: "ThreadLink",
      short: "ThreadLink",
      full: "ThreadLink",
      role: null,
      initial: "T",
      hue: null,
    };
  if (e.authorKind === "controller") {
    const name = cleanLine(e.authorLabel, 40) || "Controller";
    return {
      kind: "controller",
      label: name,
      short: name,
      full: name,
      role: null,
      initial: initialOf(name),
      hue: null,
    };
  }
  const meta = participants.find((p) => p.kind === "agent" && p.provider === e.authorProvider);
  const full =
    (meta && cleanLine(meta.name, 40)) ||
    cleanLine(e.authorLabel, 40) ||
    (e.authorProvider ? `Agent (${e.authorProvider})` : "Agent");
  const short =
    shortNameOf(e.authorProvider, participants, present) || cleanLine(e.authorLabel, 40) || full;
  const role = e.authorRole ? cleanLine(e.authorRole, 30) : null;
  return {
    kind: "agent",
    label: role ? `${short} · ${role}` : short,
    short,
    full,
    role,
    initial: (e.authorProvider && AVATAR_LETTERS[e.authorProvider]) || initialOf(short),
    provider: e.authorProvider,
    hue: e.authorProvider ? hueOf(e.authorProvider) : null,
  };
}

export function deliveryText(d: ChatDelivery | null): string | null {
  if (!d) return null;
  if (d.state === "sent") return "Sent";
  if (d.state === "not_delivered") return "Not delivered";
  const who = (d.state === "queued" ? d.for : d.by).map((n) => cleanLine(n, 30)).filter(Boolean);
  if (d.state === "queued") return who.length ? `Queued for ${who.join(", ")}` : "Queued";
  return who.length ? `Seen by ${who.join(", ")}` : "Seen";
}

// ---------------------------------------------------------------------------
// Choice cards (§5, §6)
// ---------------------------------------------------------------------------

/**
 * Approval kinds are never answered from natural language (§6), so the
 * desktop never answers them with a message either: they are decided on the
 * web card.
 */
export const APPROVAL_KINDS = new Set([
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
]);

/**
 * The message an option's button posts. The server resolves the open choice
 * from it (§6, `routed: 'choice_resolved'`). Fixed words only; the renderer
 * names an option by key and never supplies the text.
 */
export const CHOICE_ANSWERS: Record<string, string> = {
  check_again: "try again",
  wait: "wait",
  stop: "stop",
  retry: "retry",
  resume: "resume",
  run_work: "run it",
  keep_chatting: "keep chatting",
};
/** Options that name the other agent: their answer is "continue with <agent>". */
const OTHER_AGENT_KEYS = new Set(["continue_other", "use_other", "retry_other"]);

const CHOICE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CHOICE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type ChoiceOptionView = { key: string; label: string; answerable: boolean };

export type ChoiceCardView = {
  choiceId: string;
  kind: string | null;
  title: string;
  options: ChoiceOptionView[];
  status: "pending" | "chosen" | "expired" | "cancelled";
  chosenLabel: string | null;
  /** An approval: decided on the web card only. */
  approval: boolean;
  /** Short agent name the "continue" option names, for its answer. */
  otherAgent: string | null;
};

type Row = Record<string, unknown>;
const rowOf = (v: unknown): Row | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;

/** The agent a "Continue with Claude" option names, from fixed short names only. */
function agentInLabel(label: string): string | null {
  for (const name of Object.values(SHORT_NAMES)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(label)) return name;
  }
  return null;
}

export function choiceCardOf(e: ChatTimelineEvent): ChoiceCardView | null {
  const payload = e.payload ?? null;
  const source =
    e.eventType === "choice"
      ? payload
      : e.eventType === "timeout" || e.eventType === "interrupted"
        ? rowOf(payload?.choice)
        : null;
  if (!source) return null;
  const rawId = source.choiceId ?? source.id ?? (e.ref?.kind === "choice" ? e.ref.id : null);
  const choiceId = typeof rawId === "string" && CHOICE_ID.test(rawId) ? rawId : null;
  if (!choiceId) return null;
  const kind = typeof source.kind === "string" && CHOICE_KEY.test(source.kind) ? source.kind : null;
  let otherAgent: string | null = null;
  const options: ChoiceOptionView[] = [];
  for (const o of Array.isArray(source.options) ? source.options : []) {
    const r = rowOf(o);
    const key = typeof r?.key === "string" && CHOICE_KEY.test(r.key) ? r.key : null;
    const label = cleanLine(r?.label, 60);
    if (!key || !label) continue;
    // A provider whose usage ran out is never offered "Retry" (§5).
    if (kind === "usage_exhausted" && (key === "retry" || /^\s*retry\b/i.test(label))) continue;
    const agent = OTHER_AGENT_KEYS.has(key) ? agentInLabel(label) : null;
    if (agent) otherAgent = agent;
    options.push({
      key,
      label,
      // Any option of a non-approval card: main decides it by key through the
      // choices route (older servers: by the fixed phrase, when there is one).
      answerable: !APPROVAL_KINDS.has(kind ?? ""),
    });
    if (options.length >= 6) break;
  }
  const status =
    source.status === "chosen" || source.status === "expired" || source.status === "cancelled"
      ? source.status
      : "pending";
  const chosenKey = typeof source.chosenKey === "string" ? source.chosenKey : null;
  return {
    choiceId,
    kind,
    title:
      cleanLine(source.title, 200) ||
      cleanLine(systemText(e).split("\n")[0], 200) ||
      "ThreadLink needs your decision",
    options,
    status,
    chosenLabel: chosenKey ? (options.find((o) => o.key === chosenKey)?.label ?? null) : null,
    approval: APPROVAL_KINDS.has(kind ?? ""),
    otherAgent,
  };
}

/** The fixed message an option's button posts, or null when it cannot be answered here. */
export function choiceAnswer(card: ChoiceCardView, key: string): string | null {
  if (card.approval || card.status !== "pending") return null;
  const option = card.options.find((o) => o.key === key);
  if (!option?.answerable) return null;
  if (OTHER_AGENT_KEYS.has(key)) {
    const agent = agentInLabel(option.label);
    return agent ? `continue with ${agent}` : null;
  }
  return CHOICE_ANSWERS[key] ?? null;
}

/** A row that says a choice was decided: `{choiceId, label}` (label may be null). */
export function resolvedChoiceOf(
  e: ChatTimelineEvent,
): { choiceId: string; label: string | null } | null {
  const p = e.payload ?? null;
  if (!p) return null;
  const nested = rowOf(p.choice);
  const rawId =
    p.choiceId ?? nested?.choiceId ?? nested?.id ?? (e.ref?.kind === "choice" ? e.ref.id : null);
  const choiceId = typeof rawId === "string" && CHOICE_ID.test(rawId) ? rawId : null;
  if (!choiceId) return null;
  const decisionRow = /^choice_(resolved|decided|chosen|expired|cancelled)$/.test(e.eventType);
  const done = (v: unknown) => v === "chosen" || v === "expired" || v === "cancelled";
  if (!decisionRow && !done(p.status) && !done(nested?.status)) return null;
  const label = cleanLine(p.chosenLabel ?? p.label ?? nested?.chosenLabel, 60) || null;
  return { choiceId, label };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type FindingView = { title: string; severity: string; status: string; open: boolean };

const SEVERITY_WORDS: Record<string, string> = {
  blocking: "Blocking",
  important: "Important",
  non_blocking: "Minor",
  minor: "Minor",
};

export function findingOf(e: ChatTimelineEvent): FindingView | null {
  if (e.eventType !== "finding") return null;
  const p = e.payload ?? {};
  const status = typeof p.status === "string" ? p.status : "open";
  return {
    title: cleanLine(p.title, 200) || cleanLine(e.body, 200) || "Finding",
    severity: SEVERITY_WORDS[String(p.severity)] ?? "Finding",
    status: status === "wont_fix" ? "dismissed" : cleanLine(status, 20),
    open: status === "open",
  };
}

export type EventView = {
  seq: number;
  id: string;
  at: string;
  identity: IdentityView;
  body: BodyView;
  delivery: string | null;
  /** ThreadLink rows that are notes rather than messages render smaller. */
  note: boolean;
  /** 0.11: the main chat or the drawer's Activity. */
  placement: Placement;
  /** Owner right, everyone else left, ThreadLink centred and quiet. */
  side: "right" | "left" | "center";
  card: ChoiceCardView | null;
  finding: FindingView | null;
  /** Provenance for the drawer: the model the provider reported, when known. */
  model: string | null;
  /** The row this one answers (its id), for the "Replying to …" quote. */
  replyTo: string | null;
  /** A ThreadLink row that warns (usage, failover, blocked, errors): the notice card. */
  notice: boolean;
};

/** ThreadLink chat rows shown as the warm notice card. */
const NOTICE_TYPES = new Set([
  "provider_blocked",
  "usage_exhausted",
  "provider_usage",
  "usage_notice",
  "failover",
  "failover_notice",
  "error",
  "job_failed",
  "work_stopped",
  "timeout",
  "interrupted",
]);

const NOTE_TYPES = new Set([
  "job_started",
  "job_status",
  "unit_status",
  "task_started",
  "task_progress",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "owner_routed",
  "stop_requested",
  "mode_changed",
]);

export function eventView(
  e: ChatTimelineEvent,
  participants: ChatParticipant[],
  present: Presentation = {},
): EventView {
  const identity = identityOf(e, participants, present);
  const system = e.authorKind === "threadlink";
  const raw = (e as { modelObserved?: unknown }).modelObserved ?? e.payload?.modelObserved;
  return {
    seq: e.seq,
    id: cleanLine(e.id, 80),
    at: e.createdAt,
    identity,
    // ThreadLink rows are shown in human words, never with ids or reason codes.
    body: bodyView(system ? systemText(e, present) : e.body),
    delivery: e.authorKind === "owner" ? deliveryText(e.delivery) : null,
    note: system && NOTE_TYPES.has(e.eventType),
    placement: placementOf(e, present),
    side: e.authorKind === "owner" ? "right" : system ? "center" : "left",
    card: choiceCardOf(e),
    finding: findingOf(e),
    model: typeof raw === "string" ? cleanLine(raw, 60) || null : null,
    replyTo: e.replyToEventId ? cleanLine(e.replyToEventId, 80) || null : null,
    notice: system && NOTICE_TYPES.has(e.eventType),
  };
}

export type LiveView = {
  runId: string;
  label: string;
  activity: string;
  startedAt: string | null;
  /** The agent's provider id (colours its live dot). */
  provider?: string;
};

export function liveView(
  r: ChatLiveRun,
  participants: ChatParticipant[],
  present: Presentation = {},
): LiveView {
  const name =
    shortNameOf(r.provider, participants, present) ||
    (r.providerName && cleanLine(r.providerName, 40)) ||
    `Agent (${r.provider})`;
  return {
    runId: cleanLine(r.runId, 80),
    provider: r.provider,
    label: r.role ? `${name} · ${cleanLine(r.role, 30)}` : name,
    // 0.11 `subject`: the server's fixed step words ("Reviewing").
    activity: r.subject
      ? cleanLine(r.subject, 30)
      : r.activity
        ? cleanLine(r.activity, 30)
        : "working",
    startedAt: r.startedAt,
  };
}

// ---------------------------------------------------------------------------
// Presence (§4) and the chat header (§8)
// ---------------------------------------------------------------------------

const PRESENCE_WORDS: Record<HostPresence, string> = {
  online: "Online",
  working: "Working",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export type HostPresenceView = {
  /** "This computer" when the server says the project runs here; else its name. */
  name: string;
  thisComputer: boolean;
  presence: HostPresence | null;
  /** "Nickron PC · Online". */
  text: string;
  tone: "ready" | "run" | "warn" | "off";
  /** The offline sentence (§4), only while the host is offline. */
  offlineNote: string | null;
};

/**
 * The execution host of a chat. Presence comes from the server (0.11
 * `presence`); an older server's online flag is read as Online/Offline.
 * "This computer" only when the server says so — never from a display name.
 */
export function hostPresenceView(
  c: Pick<ChatListItem, "runtimeLabel" | "runtimeOnline" | "thisComputer" | "hostPresence">,
  override: HostPresence | null = null,
): HostPresenceView | null {
  const label = c.runtimeLabel ? cleanLine(c.runtimeLabel, 60) : null;
  if (!label && c.thisComputer !== true) return null;
  const thisComputer = c.thisComputer === true;
  const name = thisComputer ? "This computer" : (label ?? "The execution host");
  const presence: HostPresence | null =
    override ??
    c.hostPresence ??
    (c.runtimeOnline === true ? "online" : c.runtimeOnline === false ? "offline" : null);
  const tone =
    presence === "working"
      ? "run"
      : presence === "online"
        ? "ready"
        : presence === "reconnecting"
          ? "warn"
          : "off";
  return {
    name,
    thisComputer,
    presence,
    text: presence ? `${name} · ${PRESENCE_WORDS[presence]}` : name,
    tone,
    offlineNote:
      presence === "offline"
        ? `You're connected. ${thisComputer ? "This computer's ThreadLink" : name} is offline — repository work and agent replies will resume when it reconnects.`
        : null,
  };
}

export type ParticipantView = {
  short: string;
  full: string;
  /** What to type after @ ("claude", "codex"). */
  handle: string;
};

export type ChatHeaderView = {
  chatId: string;
  name: string;
  mode: ChatMode;
  modeBadge: string;
  /** "Prism · Claude · Codex". */
  sub: string;
  state: ChatState;
  /** The status dot line: "Working", "Nickron PC offline", "Needs you", "Ready". */
  status: { text: string; tone: "ready" | "run" | "wait" | "warn" | "off" };
  host: HostPresenceView | null;
  participants: ParticipantView[];
  hasProject: boolean;
  working: boolean;
};

export function participantViews(participants: ChatParticipant[]): ParticipantView[] {
  const out: ParticipantView[] = [];
  for (const p of participants) {
    if (p.kind !== "agent" || !p.provider) continue;
    const short = shortNameOf(p.provider, participants) ?? cleanLine(p.name, 30);
    const handle = short.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!handle || out.some((x) => x.handle === handle)) continue;
    out.push({ short, full: cleanLine(p.name, 40) || short, handle });
  }
  return out.slice(0, 8);
}

export function chatStatus(
  c: Pick<ChatListItem, "needsAttention" | "activeJob">,
  host: HostPresenceView | null,
): ChatHeaderView["status"] {
  const state = chatState(c);
  if (state === "Needs you") return { text: "Needs you", tone: "wait" };
  if (host?.presence === "offline") return { text: `${host.name} offline`, tone: "off" };
  if (state === "Working") return { text: "Working", tone: "run" };
  if (host?.presence === "reconnecting") return { text: `${host.name} reconnecting`, tone: "warn" };
  return { text: "Ready", tone: "ready" };
}

export function chatHeader(c: ChatListItem, override: HostPresence | null = null): ChatHeaderView {
  const host = hostPresenceView(c, override);
  const sub = [
    c.projectName ? cleanLine(c.projectName, 60) : "No project",
    ...agentNames(c.participants),
  ];
  return {
    chatId: c.chatId,
    name: cleanLine(c.name, 100) || "Untitled chat",
    mode: c.mode,
    modeBadge: MODE_BADGE[c.mode] ?? "SOLO",
    sub: sub.join(" · "),
    state: chatState(c),
    status: chatStatus(c, host),
    host,
    participants: participantViews(c.participants),
    hasProject: Boolean(c.roomId),
    working: chatState(c) === "Working",
  };
}

export type PageView = {
  events: EventView[];
  cursor: number;
  hasOlder: boolean;
  live: LiveView[];
  working: boolean;
  /** Choices this page says were decided (cards already on screen update). */
  resolved: { choiceId: string; label: string | null }[];
  /** Delivery changes for the owner's rows already on screen. */
  deliveries: { seq: number; text: string }[];
  hostPresence: HostPresence | null;
};

/** At most this many rows in one answer to the renderer. */
export const PAGE_LIMIT = 200;

export function pageView(
  page: ChatEventsPage,
  participants: ChatParticipant[],
  present: Presentation = {},
): PageView {
  const resolved: PageView["resolved"] = [];
  for (const e of page.events) {
    const r = resolvedChoiceOf(e);
    if (r) resolved.push(r);
  }
  return {
    events: page.events
      .filter((e) => e.visibility === "visible")
      .slice(-PAGE_LIMIT)
      .map((e) => eventView(e, participants, present)),
    cursor: page.cursor,
    hasOlder: page.hasOlder,
    live: page.live.map((r) => liveView(r, participants, present)),
    working: Boolean(page.activeJob && !FINISHED.test(page.activeJob.status)),
    resolved: resolved.slice(-50),
    deliveries: (page.deliveries ?? [])
      .map((d) => ({ seq: d.seq, text: deliveryText(d.delivery) ?? "" }))
      .filter((d) => d.text)
      .slice(-200),
    hostPresence: page.hostPresence ?? null,
  };
}

// ---------------------------------------------------------------------------
// IPC validation and rate limits
// ---------------------------------------------------------------------------

export const CHAT_ID = /^tlcht_[0-9a-f]{32}$/;
export const ROOM_ID = /^tlrom_[0-9a-f]{32}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;
/** The server caps a message at 4000 characters (docs/chat-api.md). */
export const MESSAGE_MAX_CHARS = 4000;

export const validChatId = (v: unknown): string | null =>
  typeof v === "string" && CHAT_ID.test(v) ? v : null;
export const validSeq = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export const validKey = (v: unknown): string | null =>
  typeof v === "string" && IDEMPOTENCY_KEY.test(v) ? v : null;
export function validBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.trim();
  return text.length >= 1 && text.length <= MESSAGE_MAX_CHARS ? text : null;
}
/** Auto when the renderer says nothing; only the three lanes otherwise. */
export function validLane(v: unknown): ChatLane | null {
  if (v === undefined || v === null) return "auto";
  return v === "auto" || v === "chat" || v === "work" ? v : null;
}
export const validChoiceId = (v: unknown): string | null =>
  typeof v === "string" && CHOICE_ID.test(v) ? v : null;
export const validOptionKey = (v: unknown): string | null =>
  typeof v === "string" && CHOICE_KEY.test(v) ? v : null;

/** `{name, roomId?, mode?}` and nothing else. */
export function validCreate(
  v: unknown,
): { name: string; roomId: string | null; mode: ChatMode | undefined } | null {
  const r = rowOf(v);
  if (!r) return null;
  if (Object.keys(r).some((k) => k !== "name" && k !== "roomId" && k !== "mode")) return null;
  if (typeof r.name !== "string") return null;
  const name = r.name.trim();
  if (!name || name.length > 100 || /[\n\r]/.test(name)) return null;
  const roomId =
    r.roomId === undefined || r.roomId === null
      ? null
      : typeof r.roomId === "string" && ROOM_ID.test(r.roomId)
        ? r.roomId
        : undefined;
  if (roomId === undefined) return null;
  const mode =
    r.mode === undefined || r.mode === null
      ? undefined
      : r.mode === "solo" || r.mode === "pair" || r.mode === "team"
        ? r.mode
        : null;
  if (mode === null) return null;
  return { name, roomId, mode };
}

/** `{}` (latest page), `{after: n}` or `{before: n}` — nothing else. */
export function validPage(v: unknown): { after?: number; before?: number } | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > 1 || keys.some((k) => k !== "after" && k !== "before")) return null;
  const r = v as Record<string, unknown>;
  if ("after" in r) {
    const n = validSeq(r.after);
    return n === null ? null : { after: n };
  }
  if ("before" in r) {
    const n = validSeq(r.before);
    return n === null ? null : { before: n };
  }
  return {};
}

/** A sliding-window limit per key. */
export class RateLimiter {
  #hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(key = ""): boolean {
    const t = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    return true;
  }
}

/** Per operation: polls are cheap but bounded; sends are deliberately slow. */
export const LIMITS = {
  list: [6, 10_000],
  open: [6, 10_000],
  events: [8, 5_000],
  send: [5, 10_000],
  read: [6, 10_000],
  answer: [5, 10_000],
  create: [3, 60_000],
  settings: [3, 10_000],
} as const;

export type ChatError =
  "invalid" | "rate_limited" | "unavailable" | "not_found" | "signed_out" | "failed";

export type ChatResult<T> = ({ ok: true } & T) | { ok: false; error: ChatError; message?: string };

function failure(error: unknown): { ok: false; error: ChatError } {
  const e = error as { name?: string; status?: number };
  if (e?.name === "ChatApiError" && typeof e.status === "number") {
    if (e.status === 401) return { ok: false, error: "signed_out" };
    if (e.status === 404) return { ok: false, error: "not_found" };
    if (e.status === 400) return { ok: false, error: "invalid" };
    if (e.status === 429) return { ok: false, error: "rate_limited" };
  }
  return { ok: false, error: "failed" };
}

export type SendOutcome = {
  routed: string | null;
  /** routed "choice_resolved": the chosen option's label (plain text). */
  chosenLabel?: string;
};

export type FailoverView = {
  policy: FailoverPolicy | null;
  /** The three options in the words of §5; `chosen` only when the server said. */
  options: { value: FailoverPolicy; label: string; chosen: boolean }[];
  /** No runtime-credential route changes it: the web settings page does. */
  /** True when this computer can change it (0.11 runtime settings route). */
  editable: boolean;
};

export const FAILOVER_LABELS: Record<FailoverPolicy, string> = {
  auto: "Continue with another included agent (default)",
  ask: "Ask me first",
  wait: "Wait for the same agent",
};

export const validFailover = (v: unknown): FailoverPolicy | null =>
  v === "auto" || v === "ask" || v === "wait" ? v : null;

export function failoverView(policy: FailoverPolicy | null, editable = false): FailoverView {
  return {
    policy,
    options: (["auto", "ask", "wait"] as const).map((value) => ({
      value,
      label: FAILOVER_LABELS[value],
      chosen: policy === value,
    })),
    editable,
  };
}

export type OverviewView = {
  sections: ChatSection[];
  projects: ProjectView[];
  /** Projects a new chat can be started in: name and id (an opaque handle). */
  projectChoices: { roomId: string; name: string }[];
  total: number;
  unread: number;
  needsYou: ChatRowView[];
  failover: FailoverView;
  /** This computer as the server sees it (§4), when the server says. */
  computer: HostPresenceView | null;
};

/** Per chat, at most this many choices are remembered for answering. */
const CHOICES_PER_CHAT = 50;

/**
 * The chat operations main exposes over IPC, without Electron. `getApi`
 * returns the chat client for this computer's stored credential, or null
 * when signed out (fail closed).
 */
export class ChatService {
  #getApi: () => Promise<ChatApi | null>;
  #limits: Record<keyof typeof LIMITS, RateLimiter>;
  /** Participants per chat, so identities can be resolved for event pages. */
  #participants = new Map<string, ChatParticipant[]>();
  /** Choice cards seen per chat: an answer must name one of these, by key. */
  #choices = new Map<string, Map<string, ChoiceCardView>>();
  #present: Presentation;

  constructor(
    getApi: () => Promise<ChatApi | null>,
    now: () => number = Date.now,
    present: Presentation = {},
  ) {
    this.#getApi = getApi;
    this.#present = present;
    this.#limits = {
      list: new RateLimiter(...LIMITS.list, now),
      open: new RateLimiter(...LIMITS.open, now),
      events: new RateLimiter(...LIMITS.events, now),
      send: new RateLimiter(...LIMITS.send, now),
      read: new RateLimiter(...LIMITS.read, now),
      answer: new RateLimiter(...LIMITS.answer, now),
      create: new RateLimiter(...LIMITS.create, now),
      settings: new RateLimiter(...LIMITS.settings, now),
    };
  }

  /** Main swaps in the shared presentation module once the Runtime exports it. */
  setPresentation(present: Presentation) {
    this.#present = present;
  }

  async #with<T>(
    op: keyof typeof LIMITS,
    key: string,
    fn: (api: ChatApi) => Promise<ChatResult<T>>,
  ): Promise<ChatResult<T>> {
    if (!this.#limits[op].take(key)) return { ok: false, error: "rate_limited" };
    const api = await this.#getApi().catch(() => null);
    if (!api) return { ok: false, error: "unavailable" };
    try {
      return await fn(api);
    } catch (error) {
      return failure(error);
    }
  }

  #remember(chatId: string, page: PageView) {
    let known = this.#choices.get(chatId);
    if (!known) {
      known = new Map();
      this.#choices.set(chatId, known);
    }
    for (const e of page.events) if (e.card) known.set(e.card.choiceId, e.card);
    for (const r of page.resolved) {
      const card = known.get(r.choiceId);
      if (card) known.set(r.choiceId, { ...card, status: "chosen", chosenLabel: r.label });
    }
    while (known.size > CHOICES_PER_CHAT) known.delete(known.keys().next().value!);
  }

  #page(chatId: string, page: ChatEventsPage): PageView {
    const view = pageView(page, this.#participants.get(chatId) ?? [], this.#present);
    this.#remember(chatId, view);
    return view;
  }

  list(): Promise<ChatResult<{ chats: ChatListItem[] }>> {
    return this.#with("list", "", async (api) => {
      const chats = await api.listChats();
      for (const c of chats) this.#participants.set(c.chatId, c.participants);
      // Main hands the renderer views, never raw rows.
      return { ok: true, chats };
    });
  }

  /** The list as sections of rows, for the renderer. */
  async sections(
    rawGroupBy: unknown,
  ): Promise<ChatResult<{ sections: ChatSection[]; total: number }>> {
    const groupBy = rawGroupBy === "project" ? "project" : "recent";
    const res = await this.list();
    if (!res.ok) return res;
    return { ok: true, sections: chatSections(res.chats, groupBy), total: res.chats.length };
  }

  /**
   * One request for everything the chat list, Projects, Notifications and the
   * failover setting show (the list route answers all of it).
   */
  overview(rawGroupBy: unknown): Promise<ChatResult<OverviewView>> {
    const groupBy = rawGroupBy === "project" ? "project" : "recent";
    return this.#with("list", "", async (api) => {
      const all = api.overview
        ? await api.overview()
        : {
            chats: await api.listChats(),
            projects: api.listProjects ? await api.listProjects().catch(() => []) : [],
            runtime: null,
            failoverPolicy: null,
          };
      for (const c of all.chats) this.#participants.set(c.chatId, c.participants);
      const live = all.chats.filter((c) => !c.archived);
      const projects = projectViews(all.projects, live);
      return {
        ok: true,
        sections: chatSections(live, groupBy),
        projects,
        projectChoices: projects.map((p) => ({ roomId: p.roomId, name: p.name })),
        total: live.length,
        unread: live.filter((c) => c.unread).length,
        needsYou: live
          .filter((c) => c.needsAttention)
          .sort(byRecent)
          .slice(0, SECTION_LIMIT)
          .map(chatRow),
        failover: failoverView(all.failoverPolicy, typeof api.setFailoverPolicy === "function"),
        computer: all.runtime
          ? hostPresenceView({
              runtimeLabel: all.runtime.label,
              runtimeOnline: all.runtime.online,
              thisComputer: true,
              hostPresence: all.runtime.presence,
            })
          : null,
      };
    });
  }

  open(rawId: unknown): Promise<ChatResult<{ chat: ChatHeaderView; page: PageView }>> {
    const chatId = validChatId(rawId);
    if (!chatId) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("open", chatId, async (api) => {
      const chat = await api.getChat(chatId);
      this.#participants.set(chatId, chat.participants);
      const page = this.#page(chatId, await api.events(chatId));
      return { ok: true, chat: chatHeader(chat, page.hostPresence), page };
    });
  }

  events(rawId: unknown, rawPage: unknown): Promise<ChatResult<{ page: PageView }>> {
    const chatId = validChatId(rawId);
    const page = validPage(rawPage);
    if (!chatId || !page) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("events", chatId, async (api) => {
      const res = await api.events(chatId, page);
      return { ok: true, page: this.#page(chatId, res) };
    });
  }

  async #post(
    api: ChatApi,
    chatId: string,
    body: string,
    key: string,
    lane: ChatLane,
  ): Promise<ChatResult<SendOutcome>> {
    // Auto is not sent: the server classifies (and an older server accepts it).
    const res =
      lane === "auto"
        ? await api.post(chatId, body, key)
        : await api.post(chatId, body, key, { lane });
    if (res.ok) {
      const label = res.chosenLabel ? cleanLine(res.chosenLabel, 60) : "";
      return { ok: true, routed: res.routed, ...(label ? { chosenLabel: label } : {}) };
    }
    // The one server sentence allowed through: the API's fixed refusal text.
    return {
      ok: false,
      error: "failed",
      message: `${cleanLine(res.message, 300)}${res.stored ? " Your message is in the chat." : ""}`,
    };
  }

  send(
    rawId: unknown,
    rawBody: unknown,
    rawKey: unknown,
    rawLane?: unknown,
  ): Promise<ChatResult<SendOutcome>> {
    const chatId = validChatId(rawId);
    const body = validBody(rawBody);
    const key = validKey(rawKey);
    const lane = validLane(rawLane);
    if (!chatId || !body || !key || !lane) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("send", chatId, (api) => this.#post(api, chatId, body, key, lane));
  }

  /**
   * A choice card's button. The renderer names the choice and the option by
   * id and key, only for a pending, non-approval choice this chat actually
   * showed. 0.11 servers decide it exactly through the choices route; an
   * older server gets main's own fixed words (CHOICE_ANSWERS) as a message.
   */
  answer(
    rawId: unknown,
    rawChoice: unknown,
    rawOption: unknown,
    rawKey: unknown,
  ): Promise<ChatResult<SendOutcome>> {
    const chatId = validChatId(rawId);
    const choiceId = validChoiceId(rawChoice);
    const option = validOptionKey(rawOption);
    const key = validKey(rawKey);
    if (!chatId || !choiceId || !option || !key)
      return Promise.resolve({ ok: false, error: "invalid" });
    const card = this.#choices.get(chatId)?.get(choiceId);
    const offered = card?.options.find((o) => o.key === option);
    if (!card || card.approval || card.status !== "pending" || !offered?.answerable)
      return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("answer", chatId, async (api) => {
      let res: ChatResult<SendOutcome>;
      if (typeof api.decideChoice === "function") {
        const d = await api.decideChoice(chatId, choiceId, option);
        res = d.ok
          ? {
              ok: true,
              routed: "choice_resolved",
              ...(d.chosenLabel ? { chosenLabel: cleanLine(d.chosenLabel, 60) } : {}),
            }
          : { ok: false, error: "failed", message: cleanLine(d.message, 300) };
      } else {
        const body = choiceAnswer(card, option);
        if (!body) return { ok: false, error: "invalid" };
        res = await this.#post(api, chatId, body, key, "auto");
      }
      if (res.ok) {
        const label = card.options.find((o) => o.key === option)?.label ?? null;
        this.#choices
          .get(chatId)
          ?.set(choiceId, { ...card, status: "chosen", chosenLabel: res.chosenLabel ?? label });
      }
      return res;
    });
  }

  /** 0.11: the failover preference, changed from Settings; answers what is stored. */
  setFailover(rawPolicy: unknown): Promise<ChatResult<{ failover: FailoverView }>> {
    const policy = validFailover(rawPolicy);
    if (!policy) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with<{ failover: FailoverView }>("settings", "", async (api) => {
      if (typeof api.setFailoverPolicy !== "function") return { ok: false, error: "unavailable" };
      const stored = await api.setFailoverPolicy(policy);
      return { ok: true, failover: failoverView(stored, true) };
    });
  }

  create(rawInput: unknown): Promise<ChatResult<{ chat: ChatRowView }>> {
    const input = validCreate(rawInput);
    if (!input) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("create", "", async (api) => {
      const chat = await api.createChat({
        name: input.name,
        roomId: input.roomId,
        ...(input.mode ? { mode: input.mode } : {}),
      });
      this.#participants.set(chat.chatId, chat.participants);
      return { ok: true, chat: chatRow(chat) };
    });
  }

  read(rawId: unknown, rawSeq: unknown): Promise<ChatResult<object>> {
    const chatId = validChatId(rawId);
    const seq = validSeq(rawSeq);
    if (!chatId || seq === null) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("read", chatId, async (api) => {
      await api.markRead(chatId, seq);
      return { ok: true };
    });
  }
}
