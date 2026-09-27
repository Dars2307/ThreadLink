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
  ChatListItem,
  ChatLiveRun,
  ChatParticipant,
  ChatTimelineEvent,
} from "threadlink";

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

/** "Claude Code + Codex", from provider metadata; never a per-provider switch. */
export function participantsText(participants: ChatParticipant[]): string {
  const names: string[] = [];
  for (const p of participants) {
    if (p.kind !== "agent") continue;
    const name = cleanLine(p.name, 40);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(" + ") : "No agents yet";
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
  pinned: boolean;
  lastActivityAt: string | null;
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
    pinned: c.pinned,
    lastActivityAt: c.lastActivityAt,
  };
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
  label: string;
  /** A stable colour slot (0-5) for an agent, derived from its provider id. */
  hue: number | null;
};

/** A provider id to a stable colour slot, so a new provider is styled without code changes. */
export function hueOf(provider: string): number {
  let h = 0;
  for (const ch of provider) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

export function identityOf(
  e: Pick<ChatTimelineEvent, "authorKind" | "authorProvider" | "authorLabel" | "authorRole">,
  participants: ChatParticipant[],
): IdentityView {
  if (e.authorKind === "owner") return { kind: "you", label: "You", hue: null };
  if (e.authorKind === "threadlink") return { kind: "threadlink", label: "ThreadLink", hue: null };
  if (e.authorKind === "controller")
    return { kind: "controller", label: cleanLine(e.authorLabel, 40) || "Controller", hue: null };
  const meta = participants.find((p) => p.kind === "agent" && p.provider === e.authorProvider);
  const name =
    (meta && cleanLine(meta.name, 40)) ||
    cleanLine(e.authorLabel, 40) ||
    (e.authorProvider ? `Agent (${e.authorProvider})` : "Agent");
  const role = e.authorRole ? cleanLine(e.authorRole, 30) : "";
  return {
    kind: "agent",
    label: role ? `${name} · ${role}` : name,
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

export type EventView = {
  seq: number;
  id: string;
  at: string;
  identity: IdentityView;
  body: BodyView;
  delivery: string | null;
  /** ThreadLink rows that are notes rather than messages render smaller. */
  note: boolean;
};

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

export function eventView(e: ChatTimelineEvent, participants: ChatParticipant[]): EventView {
  return {
    seq: e.seq,
    id: cleanLine(e.id, 80),
    at: e.createdAt,
    identity: identityOf(e, participants),
    body: bodyView(e.body),
    delivery: e.authorKind === "owner" ? deliveryText(e.delivery) : null,
    note: e.authorKind === "threadlink" && NOTE_TYPES.has(e.eventType),
  };
}

export type LiveView = { runId: string; label: string; activity: string; startedAt: string | null };

export function liveView(r: ChatLiveRun, participants: ChatParticipant[]): LiveView {
  const meta = participants.find((p) => p.kind === "agent" && p.provider === r.provider);
  const name =
    (meta && cleanLine(meta.name, 40)) ||
    (r.providerName && cleanLine(r.providerName, 40)) ||
    `Agent (${r.provider})`;
  return {
    runId: cleanLine(r.runId, 80),
    label: r.role ? `${name} · ${cleanLine(r.role, 30)}` : name,
    activity: r.activity ? cleanLine(r.activity, 30) : "working",
    startedAt: r.startedAt,
  };
}

export type ChatHeaderView = {
  chatId: string;
  name: string;
  sub: string;
  state: ChatState;
  host: string | null;
};

export function chatHeader(c: ChatListItem): ChatHeaderView {
  const sub = [
    c.projectName ? cleanLine(c.projectName, 60) : null,
    MODE_BADGE[c.mode] ? `${c.mode[0]!.toUpperCase()}${c.mode.slice(1)}` : "Solo",
    participantsText(c.participants),
  ].filter(Boolean);
  return {
    chatId: c.chatId,
    name: cleanLine(c.name, 100) || "Untitled chat",
    sub: sub.join(" · "),
    state: chatState(c),
    host: c.runtimeLabel
      ? `Runs on ${cleanLine(c.runtimeLabel, 60)}${c.runtimeOnline === false ? " · offline" : c.runtimeOnline ? " · online" : ""}`
      : null,
  };
}

export type PageView = {
  events: EventView[];
  cursor: number;
  hasOlder: boolean;
  live: LiveView[];
  working: boolean;
};

/** At most this many rows in one answer to the renderer. */
export const PAGE_LIMIT = 200;

export function pageView(page: ChatEventsPage, participants: ChatParticipant[]): PageView {
  return {
    events: page.events
      .filter((e) => e.visibility === "visible")
      .slice(-PAGE_LIMIT)
      .map((e) => eventView(e, participants)),
    cursor: page.cursor,
    hasOlder: page.hasOlder,
    live: page.live.map((r) => liveView(r, participants)),
    working: Boolean(page.activeJob && !FINISHED.test(page.activeJob.status)),
  };
}

// ---------------------------------------------------------------------------
// IPC validation and rate limits
// ---------------------------------------------------------------------------

export const CHAT_ID = /^tlcht_[0-9a-f]{32}$/;
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

  constructor(getApi: () => Promise<ChatApi | null>, now: () => number = Date.now) {
    this.#getApi = getApi;
    this.#limits = {
      list: new RateLimiter(...LIMITS.list, now),
      open: new RateLimiter(...LIMITS.open, now),
      events: new RateLimiter(...LIMITS.events, now),
      send: new RateLimiter(...LIMITS.send, now),
      read: new RateLimiter(...LIMITS.read, now),
    };
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

  open(rawId: unknown): Promise<ChatResult<{ chat: ChatHeaderView; page: PageView }>> {
    const chatId = validChatId(rawId);
    if (!chatId) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("open", chatId, async (api) => {
      const chat = await api.getChat(chatId);
      this.#participants.set(chatId, chat.participants);
      const page = await api.events(chatId);
      return { ok: true, chat: chatHeader(chat), page: pageView(page, chat.participants) };
    });
  }

  events(rawId: unknown, rawPage: unknown): Promise<ChatResult<{ page: PageView }>> {
    const chatId = validChatId(rawId);
    const page = validPage(rawPage);
    if (!chatId || !page) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("events", chatId, async (api) => {
      const res = await api.events(chatId, page);
      return { ok: true, page: pageView(res, this.#participants.get(chatId) ?? []) };
    });
  }

  send(
    rawId: unknown,
    rawBody: unknown,
    rawKey: unknown,
  ): Promise<ChatResult<{ routed: string | null }>> {
    const chatId = validChatId(rawId);
    const body = validBody(rawBody);
    const key = validKey(rawKey);
    if (!chatId || !body || !key) return Promise.resolve({ ok: false, error: "invalid" });
    return this.#with("send", chatId, async (api) => {
      const res = await api.post(chatId, body, key);
      if (res.ok) return { ok: true, routed: res.routed };
      // The one server sentence allowed through: the API's fixed refusal text.
      return {
        ok: false,
        error: "failed",
        message: `${cleanLine(res.message, 300)}${res.stored ? " Your message is in the chat." : ""}`,
      };
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
