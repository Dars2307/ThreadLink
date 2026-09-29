/**
 * The runtime-credential chat API client (0.10, docs/design/threadlink-0.10.md §9).
 *
 * The desktop app and the terminal (`threadlink chats|chat|new`) are clients of
 * the SAME server timeline as the web. They authenticate with this computer's
 * stored Runtime credential (the one `threadlink setup` / desktop sign-in
 * stored) -- never a pasted secret. The token only ever goes into the
 * Authorization header; it is never logged, printed or put in an error.
 *
 * Every path and field name of the contract lives in this file, so the lead
 * can reconcile it with the server in one place (wire shapes: docs/chat-api.md):
 *
 *   GET  /api/runtime/chats                 -> { chats: ChatApiSummary[], projects: [...] }
 *   POST /api/runtime/chats {name, roomId?, mode?}          -> { ok, chat: ChatApiSummary }
 *   GET  /api/runtime/chats/<id>            -> ChatApiSummary (or { chat } tolerated)
 *   GET  /api/runtime/chats/<id>/events?after=|before=&limit=
 *        -> { events: ChatApiEvent[] (each with its per-chat `cursor`), cursor,
 *             oldestCursor, hasMore, activeJob, live? }
 *   POST /api/runtime/chats/<id>/messages {body, idempotencyKey, client, lane?}
 *        (+ header X-ThreadLink-Client) -> { ok, routed, jobId, chosenLabel? }
 *        | 409 { ok:false, reason, message, stored }
 *        (0.11: `lane` is "chat" | "work" and only sent when the owner picked one;
 *         Auto sends nothing. `routed: "choice_resolved"` carries the chosen label.)
 *   POST /api/runtime/chats/<id>/read     {cursor}   -> { ok, lastReadCursor }
 *
 * Responses are parsed tolerantly: an unknown field is ignored, a malformed row
 * is dropped, and nothing the server sends is trusted as markup.
 */

import { loadToken, type CredentialStore } from "./credentials.ts";
import { canonicalizeBaseUrl } from "./endpoints.ts";
import { validateBaseUrl } from "./api.ts";
import { loadConfig } from "./state.ts";

/** The contract, in one place (see the header). */
export const CHAT_API = {
  list: "/api/runtime/chats",
  create: "/api/runtime/chats",
  detail: (id: string) => `/api/runtime/chats/${encodeURIComponent(id)}`,
  events: (id: string) => `/api/runtime/chats/${encodeURIComponent(id)}/events`,
  messages: (id: string) => `/api/runtime/chats/${encodeURIComponent(id)}/messages`,
  read: (id: string) => `/api/runtime/chats/${encodeURIComponent(id)}/read`,
  /** 0.11: answer one choice card of this chat: POST {key}. */
  choice: (id: string, choiceId: string) =>
    `/api/runtime/chats/${encodeURIComponent(id)}/choices/${encodeURIComponent(choiceId)}`,
  /** 0.11: the owner's failover preference: GET / PUT {failoverPolicy}. */
  failover: "/api/runtime/settings/failover",
} as const;

export const CHAT_ID = /^tlcht_[0-9a-f]{32}$/;
export const ROOM_ID = /^tlrom_[0-9a-f]{32}$/;
/** A choice card id (tlchc_…) and an option key, as the choices route accepts them. */
export const CHOICE_ID = /^tlchc_[0-9a-f]{32}$/;
export const CHOICE_KEY = /^[a-z_]{1,40}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;
export const CHAT_MODES = ["solo", "pair", "team"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
/** Which client wrote a message; the server records it (§9). */
export type ChatClientKind = "desktop" | "terminal";
/** A message body, as the composer may send it (the server's cap, docs/chat-api.md). */
export const MESSAGE_MAX_CHARS = 4000;
/**
 * 0.11 execution lanes (docs/design/threadlink-0.11.md §2): Auto (default,
 * the server classifies), Chat only (Fast Chat) or Run work (Engineering Work).
 */
export const CHAT_LANES = ["auto", "chat", "work"] as const;
export type ChatLane = (typeof CHAT_LANES)[number];
/** Execution-host presence (§4). */
export const HOST_PRESENCE = ["online", "working", "reconnecting", "offline"] as const;
export type HostPresence = (typeof HOST_PRESENCE)[number];
/** The owner's failover preference (§5). */
export const FAILOVER_POLICIES = ["auto", "ask", "wait"] as const;
export type FailoverPolicy = (typeof FAILOVER_POLICIES)[number];

export class ChatApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message?: string) {
    super(message ?? `ThreadLink request failed (${status} ${reason})`);
    this.name = "ChatApiError";
    this.status = status;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Shapes (what this client hands to its callers)
// ---------------------------------------------------------------------------

export type ChatParticipant = {
  kind: "owner" | "controller" | "agent";
  provider: string | null;
  name: string;
  shortName: string;
  health: string | null;
  healthCheckedAt: string | null;
};

export type ChatActiveJob = { jobId: string; mode: string; status: string };

export type ChatListItem = {
  chatId: string;
  name: string;
  mode: ChatMode;
  roomId: string | null;
  projectName: string | null;
  pinned: boolean;
  archived: boolean;
  participants: ChatParticipant[];
  lastMessage: string | null;
  lastActivityAt: string | null;
  unread: boolean;
  needsAttention: boolean;
  activeJob: ChatActiveJob | null;
  /** Execution host label and whether it is online, when the server says. */
  runtimeLabel: string | null;
  runtimeOnline: boolean | null;
  /** 0.11: the project runs on the calling computer (the server says so; never guessed). */
  thisComputer?: boolean | null;
  /** 0.11 presence of the execution host, when the server sends it. */
  hostPresence?: HostPresence | null;
  hostLastSeenAt?: string | null;
  /** Unread rows under the 0.10 rules (0 when the server does not count). */
  unreadCount?: number;
};

export type ChatDetailView = ChatListItem & { lastReadSeq: number };

/** A project the owner can start a chat in (from the list's `projects`). */
export type ChatProject = {
  roomId: string;
  name: string;
  runtimeLabel: string | null;
  /** The project runs on the calling computer (server-computed; null when not said). */
  thisComputer?: boolean | null;
};

/** The server's view of the computer this client runs on. */
export type RuntimeInfo = {
  label: string | null;
  online: boolean;
  /** 0.11 presence of this computer as the execution host, when the server says. */
  presence: HostPresence | null;
  lastSeenAt: string | null;
  version: string | null;
  protocol: number | null;
  minProtocol: number | null;
  updateRequired: boolean;
};

export type ChatDelivery =
  | { state: "sent" }
  | { state: "queued"; for: string[] }
  | { state: "seen"; by: string[] }
  | { state: "not_delivered" };

export type ChatTimelineEvent = {
  /** The per-chat cursor (chat_seq). */
  seq: number;
  id: string;
  createdAt: string;
  authorKind: "controller" | "owner" | "threadlink" | "agent";
  authorProvider: string | null;
  authorLabel: string;
  authorRole: string | null;
  audience: string | null;
  eventType: string;
  messageType: string | null;
  body: string;
  visibility: "visible" | "technical";
  delivery: ChatDelivery | null;
  client: string | null;
  /** 0.11: structured card data (choices, findings, results). Plain JSON, size-capped; never markup. */
  payload?: Record<string, unknown> | null;
  jobId?: string | null;
  runId?: string | null;
  replyToEventId?: string | null;
  ref?: { kind: string; id: string } | null;
};

export type ChatLiveRun = {
  runId: string;
  provider: string;
  providerName: string | null;
  role: string | null;
  activity: string | null;
  /** 0.11: fixed step words from the server ("Reviewing", "Investigating"). */
  subject?: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
};

/** 0.11: the answer to a choice decided through the choices route. */
export type ChoiceDecision =
  | {
      ok: true;
      choiceId: string;
      kind: string | null;
      status: "pending" | "chosen" | "expired" | "cancelled";
      chosenKey: string | null;
      chosenLabel: string | null;
      replayed: boolean;
      startedJobId: string | null;
    }
  | { ok: false; reason: string; message: string };

export type ChatEventsPage = {
  events: ChatTimelineEvent[];
  cursor: number;
  /** True when there are older rows before the first one returned. */
  hasOlder: boolean;
  /** An after= poll that did not reach the newest row: poll again at once. */
  hasNewer: boolean;
  oldestCursor: number | null;
  activeJob: ChatActiveJob | null;
  live: ChatLiveRun[];
  /** Delivery changes for rows already fetched (0.10 `deliveries`). */
  deliveries?: { seq: number; delivery: ChatDelivery }[];
  /** 0.11 execution-host presence, when the page carries it. */
  hostPresence?: HostPresence | null;
};

/** One answer of the chat list route (see ChatClient.overview). */
export type ChatOverview = {
  chats: ChatListItem[];
  projects: ChatProject[];
  runtime: RuntimeInfo | null;
  failoverPolicy: FailoverPolicy | null;
};

export type ChatPostResult =
  | {
      ok: true;
      routed: string | null;
      jobId: string | null;
      /** routed "choice_resolved": the label of the option the message chose. */
      chosenLabel?: string | null;
      /** The lane the server used ("chat" | "work"), when it says. */
      lane?: "chat" | "work" | null;
    }
  | { ok: false; reason: string; message: string; stored: boolean };

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const obj = (v: unknown): Row | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;
const bool = (v: unknown): boolean => v === true;
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const seqOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : typeof v === "string" && /^\d{1,15}$/.test(v)
      ? Number(v)
      : null;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
const presenceOf = (v: unknown): HostPresence | null =>
  (HOST_PRESENCE as readonly string[]).includes(v as string) ? (v as HostPresence) : null;

/** Structured payloads are small by contract; a larger or non-JSON one is dropped. */
export const PAYLOAD_MAX_CHARS = 16 * 1024;
function parsePayload(v: unknown): Record<string, unknown> | null {
  const p = obj(v);
  if (!p) return null;
  try {
    const text = JSON.stringify(p);
    if (text.length > PAYLOAD_MAX_CHARS) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseParticipant(v: unknown): ChatParticipant | null {
  const p = obj(v);
  if (!p) return null;
  const kind = p.kind === "owner" || p.kind === "controller" || p.kind === "agent" ? p.kind : null;
  if (!kind) return null;
  const provider =
    typeof p.provider === "string" && PROVIDER_ID.test(p.provider) ? p.provider : null;
  const name = str(p.name ?? p.displayName, 60) ?? provider ?? kind;
  const health = obj(p.health);
  return {
    kind,
    provider,
    name,
    shortName: str(p.shortName ?? p.short_name, 40) ?? name,
    health: str(health ? health.status : p.health, 40),
    healthCheckedAt: iso(p.healthCheckedAt ?? p.checkedAt ?? health?.checkedAt),
  };
}

function parseActiveJob(v: unknown): ChatActiveJob | null {
  const j = obj(v);
  const jobId = str(j?.jobId, 80);
  if (!j || !jobId) return null;
  return { jobId, mode: str(j.mode, 20) ?? "team", status: str(j.status, 40) ?? "running" };
}

export function parseChatItem(v: unknown): ChatListItem | null {
  const c = obj(v);
  if (!c) return null;
  const chatId = typeof c.chatId === "string" && CHAT_ID.test(c.chatId) ? c.chatId : null;
  const name = str(c.name, 100);
  if (!chatId || !name) return null;
  const mode = (CHAT_MODES as readonly string[]).includes(String(c.mode))
    ? (c.mode as ChatMode)
    : "solo";
  const runtime = obj(c.runtime) ?? obj(c.executionHost);
  // 0.11 chat reads carry `host {label, presence, lastSeenAt}`.
  const host = obj(c.host);
  return {
    chatId,
    name,
    mode,
    roomId: typeof c.roomId === "string" && ROOM_ID.test(c.roomId) ? c.roomId : null,
    projectName: str(c.projectName, 100),
    pinned: bool(c.pinned),
    archived: bool(c.archived),
    participants: (Array.isArray(c.participants) ? c.participants : [])
      .map(parseParticipant)
      .filter((p): p is ChatParticipant => p !== null)
      .slice(0, 12),
    lastMessage: str(c.lastMessage, 300),
    lastActivityAt: iso(c.lastActivityAt),
    unread: bool(c.unread),
    needsAttention: bool(c.needsAttention),
    activeJob: parseActiveJob(c.activeJob),
    runtimeLabel: str(runtime?.label ?? c.runtimeLabel, 100),
    runtimeOnline:
      typeof runtime?.online === "boolean"
        ? runtime.online
        : typeof c.runtimeOnline === "boolean"
          ? c.runtimeOnline
          : null,
    thisComputer:
      typeof c.thisComputer === "boolean"
        ? c.thisComputer
        : typeof runtime?.thisComputer === "boolean"
          ? runtime.thisComputer
          : null,
    hostPresence: presenceOf(
      host?.presence ?? c.hostPresence ?? c.runtimePresence ?? c.presence ?? runtime?.presence,
    ),
    hostLastSeenAt: iso(
      host?.lastSeenAt ?? c.hostLastSeenAt ?? c.runtimeLastSeenAt ?? runtime?.lastSeenAt,
    ),
    unreadCount:
      typeof c.unreadCount === "number" && Number.isSafeInteger(c.unreadCount) && c.unreadCount >= 0
        ? Math.min(c.unreadCount, 999)
        : c.unread === true
          ? 1
          : 0,
  };
}

function names(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .map((x) => str(x, 60))
    .filter((x): x is string => Boolean(x))
    .slice(0, 8);
}

function parseDelivery(v: unknown): ChatDelivery | null {
  const d = obj(v);
  if (!d) return typeof v === "string" && v === "sent" ? { state: "sent" } : null;
  if (d.state === "sent") return { state: "sent" };
  if (d.state === "queued") return { state: "queued", for: names(d.for) };
  if (d.state === "seen") return { state: "seen", by: names(d.by) };
  if (d.state === "not_delivered") return { state: "not_delivered" };
  return null;
}

const AUTHOR_KINDS = ["controller", "owner", "threadlink", "agent"] as const;

export function parseChatEvent(v: unknown): ChatTimelineEvent | null {
  const e = obj(v);
  if (!e) return null;
  // 0.10 exposes the per-chat cursor; older servers only the global seq.
  // 0.10 names the per-chat position `cursor`; older/other shapes are tolerated.
  const seq = seqOf(e.cursor ?? e.chatSeq ?? e.chat_seq ?? e.seq);
  const id = str(e.id, 80);
  const authorKind = (AUTHOR_KINDS as readonly string[]).includes(String(e.authorKind))
    ? (e.authorKind as ChatTimelineEvent["authorKind"])
    : null;
  if (seq === null || !id || !authorKind) return null;
  return {
    seq,
    id,
    createdAt: iso(e.createdAt) ?? new Date(0).toISOString(),
    authorKind,
    authorProvider:
      typeof e.authorProvider === "string" && PROVIDER_ID.test(e.authorProvider)
        ? e.authorProvider
        : null,
    authorLabel: str(e.authorLabel, 60) ?? "",
    authorRole: str(e.authorRole, 40),
    audience: str(e.audience, 40),
    eventType: str(e.eventType, 40) ?? "message",
    messageType: str(e.messageType, 40),
    // Bodies can be long; the display layer collapses them. Cap what we hold.
    body: typeof e.body === "string" ? e.body.slice(0, 256 * 1024) : "",
    visibility: e.visibility === "technical" ? "technical" : "visible",
    delivery: parseDelivery(e.delivery),
    client: str(e.client, 20),
    payload: parsePayload(e.payload),
    jobId: str(e.jobId, 80),
    runId: str(e.runId, 80),
    replyToEventId: str(e.replyToEventId, 80),
    ref: (() => {
      const r = obj(e.ref);
      const kind = str(r?.kind, 20);
      const id = str(r?.id, 80);
      return kind && id ? { kind, id } : null;
    })(),
  };
}

function parseLive(v: unknown): ChatLiveRun | null {
  const r = obj(v);
  const runId = str(r?.runId, 80);
  const provider =
    typeof r?.provider === "string" && PROVIDER_ID.test(r.provider) ? r.provider : null;
  if (!r || !runId || !provider) return null;
  return {
    runId,
    provider,
    providerName: str(r.providerName, 60),
    role: str(r.role, 40),
    activity: str(r.activity, 40),
    subject: str(r.subject, 40),
    startedAt: iso(r.startedAt),
    lastActivityAt: iso(r.lastActivityAt),
  };
}

export function parseEventsPage(v: unknown, after: number | null): ChatEventsPage {
  const p = obj(v) ?? {};
  const events = (Array.isArray(p.events) ? p.events : [])
    .map(parseChatEvent)
    .filter((e): e is ChatTimelineEvent => e !== null)
    .sort((a, b) => a.seq - b.seq);
  const highest = events.length ? events[events.length - 1]!.seq : null;
  const cursor = seqOf(p.cursor) ?? highest ?? after ?? 0;
  // The runtime events route names them `activity` (lib/client-api/chats.ts).
  const liveSource = p.live ?? p.liveActivity ?? p.activity ?? p.runs;
  const host = obj(p.host) ?? obj(p.executionHost);
  return {
    events,
    cursor: Math.max(cursor, highest ?? 0),
    // `hasMore` is "more rows in the direction of travel": older rows for the
    // latest page and for before=, newer rows for an after= poll.
    hasOlder: after === null ? bool(p.hasOlder ?? p.hasMore) : false,
    hasNewer: after !== null && bool(p.hasMore),
    oldestCursor: seqOf(p.oldestCursor) ?? events[0]?.seq ?? null,
    activeJob: parseActiveJob(p.activeJob),
    live: (Array.isArray(liveSource) ? liveSource : [])
      .map(parseLive)
      .filter((r): r is ChatLiveRun => r !== null)
      .slice(0, 12),
    deliveries: (Array.isArray(p.deliveries) ? p.deliveries : [])
      .map((d) => {
        const r = obj(d);
        const seq = seqOf(r?.cursor ?? r?.seq);
        const delivery = parseDelivery(r?.delivery);
        return seq !== null && delivery ? { seq, delivery } : null;
      })
      .filter((d): d is { seq: number; delivery: ChatDelivery } => d !== null)
      .slice(0, 200),
    hostPresence: presenceOf(host?.presence ?? p.hostPresence ?? p.presence),
  };
}

export function parseProjects(v: unknown): ChatProject[] {
  const out: ChatProject[] = [];
  for (const item of Array.isArray(v) ? v : []) {
    const p = obj(item);
    const roomId = typeof p?.roomId === "string" && ROOM_ID.test(p.roomId) ? p.roomId : null;
    const name = str(p?.name, 100);
    if (roomId && name)
      out.push({
        roomId,
        name,
        runtimeLabel: str(p?.runtimeLabel, 100),
        thisComputer: typeof p?.thisComputer === "boolean" ? p.thisComputer : null,
      });
    if (out.length >= 200) break;
  }
  return out;
}

export function parseRuntimeInfo(v: unknown): RuntimeInfo | null {
  const r = obj(v);
  if (!r) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    label: str(r.label, 100) ?? null,
    online: r.online === true,
    presence: presenceOf(r.presence),
    lastSeenAt: iso(r.lastSeenAt),
    version: str(r.version, 40) ?? null,
    protocol: num(r.protocol),
    minProtocol: num(r.minProtocol),
    updateRequired: r.updateRequired === true,
  };
}

/** A server error message is a fixed sentence by contract; still keep it printable and short. */
function safeMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;

  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return clean ? clean.slice(0, 300) : null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type ChatClientOptions = {
  baseUrl: string;
  token: string;
  client: ChatClientKind;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** What the desktop app and the terminal need from the chat API. Fakes implement this in tests. */
export type ChatApi = {
  listChats(): Promise<ChatListItem[]>;
  getChat(chatId: string): Promise<ChatDetailView>;
  events(
    chatId: string,
    page?: { after?: number; before?: number; limit?: number },
  ): Promise<ChatEventsPage>;
  post(
    chatId: string,
    body: string,
    idempotencyKey: string,
    options?: { lane?: ChatLane },
  ): Promise<ChatPostResult>;
  markRead(chatId: string, seq: number): Promise<void>;
  /** Projects to start a chat in (optional: fakes may leave it out). */
  listProjects?(): Promise<ChatProject[]>;
  /** Chats + projects + this computer + failover preference in one request (optional for fakes). */
  overview?(): Promise<ChatOverview>;
  /** 0.11: decide one choice card by option key (optional for fakes). */
  decideChoice?(chatId: string, choiceId: string, key: string): Promise<ChoiceDecision>;
  /** 0.11: set the owner's failover preference; answers what is now stored. */
  setFailoverPolicy?(policy: FailoverPolicy): Promise<FailoverPolicy>;
  createChat(input: {
    name: string;
    roomId?: string | null;
    mode?: ChatMode;
  }): Promise<ChatListItem>;
};

export class ChatClient implements ChatApi {
  #baseUrl: string;
  #token: string;
  #client: ChatClientKind;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(options: ChatClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#token = options.token;
    this.#client = options.client;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** The generic request helper api.ts keeps private: same token, same rules. */
  async #request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/json",
          "X-ThreadLink-Client": this.#client,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new ChatApiError(0, "network", "Could not reach ThreadLink.");
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (json === null && text.trim() !== "") {
      throw new ChatApiError(response.status, "not-threadlink", "That address is not ThreadLink.");
    }
    const row = obj(json);
    if (!response.ok) {
      // A refused post (e.g. provider_unhealthy) is an answer, not an error.
      if (row && row.ok === false && response.status === 409) return row;
      throw new ChatApiError(
        response.status,
        str(row?.reason ?? row?.error, 60) ?? "error",
        safeMessage(row?.message) ?? undefined,
      );
    }
    return json;
  }

  static assertChatId(chatId: string): string {
    if (!CHAT_ID.test(chatId)) throw new ChatApiError(400, "invalid", "That is not a chat.");
    return chatId;
  }

  async listChats(): Promise<ChatListItem[]> {
    const res = obj(await this.#request("GET", CHAT_API.list));
    return (Array.isArray(res?.chats) ? res.chats : [])
      .map(parseChatItem)
      .filter((c): c is ChatListItem => c !== null && !c.archived);
  }

  /**
   * This computer as the server sees it (label, presence, version, protocol,
   * whether an update is needed). Read-only: nothing is registered or changed.
   */
  async runtimeInfo(): Promise<RuntimeInfo | null> {
    const body = obj(await this.#request("GET", CHAT_API.list));
    return parseRuntimeInfo(body?.runtime);
  }

  /**
   * Everything the chat list request answers, in ONE request: the chats, the
   * projects, this computer as the server sees it, and (0.11, when the server
   * sends it) the owner's failover preference. Read-only.
   */
  async overview(): Promise<ChatOverview> {
    const res = obj(await this.#request("GET", CHAT_API.list));
    const settings = obj(res?.settings);
    const policy = settings?.failoverPolicy ?? res?.failoverPolicy;
    return {
      chats: (Array.isArray(res?.chats) ? res.chats : [])
        .map(parseChatItem)
        .filter((c): c is ChatListItem => c !== null && !c.archived),
      projects: parseProjects(res?.projects),
      runtime: parseRuntimeInfo(res?.runtime),
      failoverPolicy: (FAILOVER_POLICIES as readonly string[]).includes(policy as string)
        ? (policy as FailoverPolicy)
        : null,
    };
  }

  async listProjects(): Promise<ChatProject[]> {
    const res = obj(await this.#request("GET", CHAT_API.list));
    return parseProjects(res?.projects);
  }

  async getChat(chatId: string): Promise<ChatDetailView> {
    const res = obj(await this.#request("GET", CHAT_API.detail(ChatClient.assertChatId(chatId))));
    const raw = obj(res?.chat) ?? res;
    const chat = parseChatItem(raw);
    if (!chat) throw new ChatApiError(404, "chat_not_found", "That chat was not found.");
    return { ...chat, lastReadSeq: seqOf(raw?.lastReadCursor ?? raw?.lastReadSeq) ?? 0 };
  }

  async events(
    chatId: string,
    page: { after?: number; before?: number; limit?: number } = {},
  ): Promise<ChatEventsPage> {
    const q = new URLSearchParams();
    if (page.after !== undefined) q.set("after", String(Math.max(0, Math.floor(page.after))));
    if (page.before !== undefined) q.set("before", String(Math.max(0, Math.floor(page.before))));
    if (page.limit !== undefined) q.set("limit", String(Math.min(200, Math.max(1, page.limit))));
    const qs = q.toString();
    const res = await this.#request(
      "GET",
      `${CHAT_API.events(ChatClient.assertChatId(chatId))}${qs ? `?${qs}` : ""}`,
    );
    return parseEventsPage(res, page.after ?? null);
  }

  async post(
    chatId: string,
    body: string,
    idempotencyKey: string,
    options: { lane?: ChatLane } = {},
  ): Promise<ChatPostResult> {
    ChatClient.assertChatId(chatId);
    const lane = options.lane ?? "auto";
    if (!(CHAT_LANES as readonly string[]).includes(lane))
      throw new ChatApiError(400, "invalid", "Invalid lane.");
    if (!IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new ChatApiError(400, "invalid", "Invalid idempotency key.");
    const text = body.trim();
    if (!text || text.length > MESSAGE_MAX_CHARS)
      throw new ChatApiError(
        400,
        "invalid",
        `A message must be 1-${MESSAGE_MAX_CHARS} characters.`,
      );
    const res = obj(
      await this.#request("POST", CHAT_API.messages(chatId), {
        body: text,
        idempotencyKey,
        client: this.#client,
        // Auto is the server's default: nothing is sent, so an older server
        // (whose body schema is strict) keeps accepting the message.
        ...(lane === "auto" ? {} : { lane }),
      }),
    );
    if (res?.ok === false) {
      return {
        ok: false,
        reason: str(res.reason, 60) ?? "error",
        message: safeMessage(res.message) ?? "ThreadLink did not accept that message.",
        stored: res.stored === true,
      };
    }
    const choice = obj(res?.choice);
    const usedLane = obj(res?.lane) ? null : res?.lane;
    const chosenLabel =
      safeMessage(res?.chosenLabel ?? choice?.label ?? choice?.chosenLabel)?.slice(0, 80) ?? null;
    return {
      ok: true,
      routed: str(res?.routed, 40),
      jobId: str(res?.jobId, 80),
      ...(chosenLabel ? { chosenLabel } : {}),
      ...(usedLane === "chat" || usedLane === "work" ? { lane: usedLane } : {}),
    };
  }

  /**
   * Decides a choice card by its option key (0.11). A refusal the server
   * answers with a fixed sentence (409, e.g. other_computer, choice_closed) is
   * an answer, not an error.
   */
  async decideChoice(chatId: string, choiceId: string, key: string): Promise<ChoiceDecision> {
    ChatClient.assertChatId(chatId);
    if (!CHOICE_ID.test(choiceId)) throw new ChatApiError(400, "invalid", "That is not a choice.");
    if (!CHOICE_KEY.test(key)) throw new ChatApiError(400, "invalid", "That is not an option.");
    const res = obj(await this.#request("POST", CHAT_API.choice(chatId, choiceId), { key }));
    if (res?.ok === false)
      return {
        ok: false,
        reason: str(res.reason, 60) ?? "error",
        message: safeMessage(res.message) ?? "ThreadLink did not accept that answer.",
      };
    const status = res?.status;
    return {
      ok: true,
      choiceId: str(res?.choiceId, 80) ?? choiceId,
      kind: str(res?.kind, 40),
      status:
        status === "pending" || status === "expired" || status === "cancelled" ? status : "chosen",
      chosenKey: str(res?.chosenKey, 40),
      chosenLabel: safeMessage(res?.chosenLabel)?.slice(0, 80) ?? null,
      replayed: res?.replayed === true,
      startedJobId: str(res?.startedJobId, 80),
    };
  }

  /** The owner's failover preference (0.11 §5). */
  async getFailoverPolicy(): Promise<FailoverPolicy | null> {
    const res = obj(await this.#request("GET", CHAT_API.failover));
    const v = res?.failoverPolicy;
    return (FAILOVER_POLICIES as readonly string[]).includes(v as string)
      ? (v as FailoverPolicy)
      : null;
  }

  async setFailoverPolicy(policy: FailoverPolicy): Promise<FailoverPolicy> {
    if (!(FAILOVER_POLICIES as readonly string[]).includes(policy))
      throw new ChatApiError(400, "invalid", "That is not a failover choice.");
    const res = obj(await this.#request("PUT", CHAT_API.failover, { failoverPolicy: policy }));
    if (res?.ok === false)
      throw new ChatApiError(
        409,
        str(res.reason, 60) ?? "conflict",
        safeMessage(res.message) ?? "ThreadLink did not save that.",
      );
    const v = res?.failoverPolicy;
    if (!(FAILOVER_POLICIES as readonly string[]).includes(v as string))
      throw new ChatApiError(502, "unavailable", "ThreadLink did not return the setting.");
    return v as FailoverPolicy;
  }

  async markRead(chatId: string, seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    await this.#request("POST", CHAT_API.read(ChatClient.assertChatId(chatId)), { cursor: seq });
  }

  async createChat(input: {
    name: string;
    roomId?: string | null;
    mode?: ChatMode;
  }): Promise<ChatListItem> {
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw new ChatApiError(400, "invalid", "A chat name must be 1-100 characters.");
    if (input.roomId && !ROOM_ID.test(input.roomId))
      throw new ChatApiError(400, "invalid", "That is not a project.");
    const res = obj(
      await this.#request("POST", CHAT_API.create, {
        name,
        roomId: input.roomId ?? null,
        ...(input.mode ? { mode: input.mode } : {}),
      }),
    );
    if (res?.ok === false)
      throw new ChatApiError(
        409,
        str(res.reason, 60) ?? "conflict",
        safeMessage(res.message) ?? "ThreadLink did not create that chat.",
      );
    const chat = parseChatItem(obj(res?.chat) ?? res);
    if (!chat)
      throw new ChatApiError(502, "unavailable", "ThreadLink did not return the new chat.");
    return chat;
  }
}

/**
 * A chat client for this computer's stored Runtime credential, or null when
 * this computer is not signed in. Reads the same config and credential store
 * as the Runtime (so it never asks the user for a secret).
 */
export async function chatClientFor(
  ctx: { configDir: string; store: CredentialStore },
  client: ChatClientKind,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ChatClient | null> {
  const env = options.env ?? process.env;
  const raw = env.THREADLINK_URL ?? (await loadConfig(ctx.configDir)).baseUrl;
  if (!raw) return null;
  const baseUrl = validateBaseUrl(canonicalizeBaseUrl(raw).url);
  const loaded = await loadToken(ctx.store, env).catch(() => null);
  if (!loaded) return null;
  return new ChatClient({ baseUrl, token: loaded.token, client, fetchImpl: options.fetchImpl });
}
