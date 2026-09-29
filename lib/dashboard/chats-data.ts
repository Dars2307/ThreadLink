import "server-only";

import * as chatOwner from "@/lib/chat/owner";
import {
  PROVIDER_HEALTH,
  type ChatGroup,
  type ChatPage,
  type ChatSettings,
  type ChatSummary,
  type JobMode,
  type ParticipantView,
} from "@/lib/chat/types";
import * as teamOwner from "@/lib/team/owner";
import type { OwnerJobSummary } from "@/lib/team/queries";

import type { JobDetail } from "./pages";
import { parseHostStatus, type HostStatus } from "./presence";

/**
 * Every call the chat-first pages make to the server's owner functions, in
 * ONE place (docs/design/chat-first.md §5). Pages and actions import from
 * here only, so a renamed server function is fixed in this file alone.
 *
 * The owner functions resolve the signed-in user and read/write through the
 * user-scoped client (RLS), so nothing here decides ownership. A function the
 * server does not provide yet reads as "could not load" (null) or a plain
 * failure; nothing is invented on this side.
 *
 * Server functions used (lib/chat/owner unless noted):
 *   listMyChats() → ChatSummary[] (optionally with isRoomDefault)
 *   listMyChatGroups() → ChatGroup[]
 *   getMyChat(chatId) → ChatSummary & ({ settings: ChatSettings } | ChatSettings fields) | null
 *   listMyChatJobs(chatId) → OwnerJobSummary[]
 *   listMyChat({ chatId }) → ChatPage (first page of events)
 *   createMyChat({ name, roomId?, groupId?, mode? }) → { chatId }
 *   updateMyChat(chatId, { name?, roomId?|null, groupId?|null, mode?, soloProvider?, builderProvider?, reviewerProvider? })
 *   setMyChatPinned(chatId, pinned) · setMyChatArchived(chatId, archived) · deleteMyChat(chatId)
 *   createMyChatGroup(name) · renameMyChatGroup(groupId, name) · deleteMyChatGroup(groupId)
 *   retryMyJobWithRoles(jobId, coordinator)
 *   lib/team/owner: getMyJobDetail(jobId), listMyRoomJobs(roomId)
 *
 * 0.10 (docs/design/threadlink-0.10.md), each looked up by NAME in
 * lib/chat/owner, then lib/team/owner; a missing one reads as "not available"
 * (reads → null, mutations → ChatServerUnavailableError). Nothing is invented:
 *   listMyAgentProviders() → ProviderInfo[]
 *   listMyChatTimeline(chatId, {limit}) → ChatTimelinePage (first page, per-chat cursor)
 *   getMyHostStatus(chatId) → ChatHostStatus (runtime presence, agents' health + checkedAt)
 *   listMyFindings(chatId) · listMyDecisions(chatId) · listMyChoices(chatId) · listMyArtifacts(chatId)
 *   getMyRunProvenance(chatId, runId) · revealMyRunNativeSession(chatId, runId)   (owner only)
 *   decideMyChoice(chatId, choiceId, {key}) · controlMyJob(chatId, {jobId, action})
 *   addMyAttachment(chatId, {title, content, mime})
 *   searchMyChats({q, limit})
 *   NOT provided by the server yet (read as null): listMyChatRuns(chatId), getMyProjectHub(roomId)
 */

type AnyFn = (...args: unknown[]) => Promise<unknown>;

/** Thrown by a mutation whose server function is not available. */
export class ChatServerUnavailableError extends Error {
  constructor() {
    super("Chat server function unavailable");
    this.name = "ChatServerUnavailableError";
  }
}

function lookup(mod: object, name: string): AnyFn | null {
  const fn = (mod as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as AnyFn) : null;
}

const chatFn = (name: string) => lookup(chatOwner, name);

async function call(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = chatFn(name);
  if (!fn) throw new ChatServerUnavailableError();
  return fn(...args);
}

// ---------------------------------------------------------------------------
// Shape checks: the UI trusts only what it can check.
// ---------------------------------------------------------------------------

const MODES: readonly string[] = ["solo", "pair", "team"];
const isStr = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function toParticipant(v: unknown): ParticipantView | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  const kind = p.kind === "owner" || p.kind === "controller" || p.kind === "agent" ? p.kind : null;
  if (!kind || !isStr(p.name)) return null;
  const health =
    isStr(p.health) && (PROVIDER_HEALTH as readonly string[]).includes(p.health)
      ? (p.health as ParticipantView["health"])
      : null;
  return {
    kind,
    provider: strOrNull(p.provider),
    name: p.name,
    shortName: isStr(p.shortName) ? p.shortName : p.name,
    health,
  };
}

export type LoadedChat = ChatSummary & { isRoomDefault?: boolean };

export function toChatSummary(v: unknown): LoadedChat | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (!isStr(c.chatId) || !isStr(c.name)) return null;
  const job = c.activeJob as Record<string, unknown> | null | undefined;
  return {
    chatId: c.chatId,
    name: c.name,
    mode: (isStr(c.mode) && MODES.includes(c.mode) ? c.mode : "team") as JobMode,
    roomId: strOrNull(c.roomId),
    projectName: strOrNull(c.projectName),
    groupId: strOrNull(c.groupId),
    groupName: strOrNull(c.groupName),
    pinned: c.pinned === true,
    archived: c.archived === true,
    participants: Array.isArray(c.participants)
      ? c.participants.map(toParticipant).filter((p): p is ParticipantView => p !== null)
      : [],
    lastMessage: isStr(c.lastMessage) ? c.lastMessage : null,
    lastActivityAt: isStr(c.lastActivityAt) ? c.lastActivityAt : new Date(0).toISOString(),
    unread: c.unread === true,
    needsAttention: c.needsAttention === true,
    activeJob:
      job && typeof job === "object" && isStr(job.jobId) && isStr(job.status)
        ? {
            jobId: job.jobId,
            mode: (isStr(job.mode) && MODES.includes(job.mode) ? job.mode : "team") as JobMode,
            status: job.status,
          }
        : null,
    ...(typeof c.isRoomDefault === "boolean" ? { isRoomDefault: c.isRoomDefault } : {}),
  };
}

function toSettings(v: unknown, fallbackMode: JobMode): ChatSettings {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    mode: (isStr(s.mode) && MODES.includes(s.mode) ? s.mode : fallbackMode) as JobMode,
    soloProvider: strOrNull(s.soloProvider),
    builderProvider: strOrNull(s.builderProvider),
    reviewerProvider: strOrNull(s.reviewerProvider),
  };
}

// ---------------------------------------------------------------------------
// Reads (null = could not load; pages say so)
// ---------------------------------------------------------------------------

export async function loadChats(): Promise<LoadedChat[] | null> {
  try {
    const rows = await call("listMyChats");
    if (!Array.isArray(rows)) return null;
    return rows.map(toChatSummary).filter((c): c is LoadedChat => c !== null);
  } catch {
    return null;
  }
}

export async function loadChatGroups(): Promise<ChatGroup[] | null> {
  try {
    const rows = await call("listMyChatGroups");
    if (!Array.isArray(rows)) return null;
    return rows.filter(
      (g): g is ChatGroup =>
        Boolean(g) && isStr((g as ChatGroup).groupId) && isStr((g as ChatGroup).name),
    );
  } catch {
    return null;
  }
}

export type ChatPageData = {
  chat: LoadedChat;
  settings: ChatSettings;
  jobs: OwnerJobSummary[];
  /** Detail of the job the Progress/Details tabs show. */
  detail: JobDetail | null;
  selectedJobId: string | null;
  jobNotFound: boolean;
};

const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One chat for its page, or null (not found / not yours / failure — all read alike). */
export async function loadChat(
  chatId: string,
  askedJob: string | null,
): Promise<ChatPageData | null> {
  if (!CHAT_ID.test(chatId)) return null;
  try {
    const raw = await call("getMyChat", chatId);
    const chat = toChatSummary(raw);
    if (!chat) return null;
    const r = raw as Record<string, unknown>;
    const settings = toSettings(r.settings ?? r, chat.mode);

    let jobs: OwnerJobSummary[] = [];
    const listJobs = chatFn("listMyChatJobs");
    if (listJobs) {
      const rows = await listJobs(chatId);
      jobs = Array.isArray(rows) ? (rows as OwnerJobSummary[]) : [];
    } else if (chat.roomId && chat.isRoomDefault === true) {
      // Older server: the project's default chat holds the project's work.
      jobs = await teamOwner.listMyRoomJobs(chat.roomId);
    }

    const asked = askedJob ? jobs.find((j) => j.jobId === askedJob) : undefined;
    const selected = asked ?? jobs.find((j) => !j.finished) ?? jobs[0] ?? null;
    const detail = selected
      ? ((await teamOwner.getMyJobDetail(selected.jobId)) as JobDetail | null)
      : null;
    return {
      chat,
      settings,
      jobs,
      detail,
      selectedJobId: selected?.jobId ?? null,
      jobNotFound: Boolean(askedJob) && !asked,
    };
  } catch {
    return null;
  }
}

/** The first page of a chat's events, or null (the browser then loads it). */
export async function loadChatEvents(chatId: string): Promise<ChatPage | null> {
  try {
    const page = await chatOwner.listMyChat({ chatId } as unknown as Parameters<
      typeof chatOwner.listMyChat
    >[0]);
    return page;
  } catch {
    return null;
  }
}

/** Where an old job address should go: its chat (from the job) and its project. */
export async function locateJob(
  jobId: string,
): Promise<{ chatId: string | null; roomId: string | null } | null> {
  try {
    const detail = (await teamOwner.getMyJobDetail(jobId)) as
      (JobDetail & { roomId?: string }) | null;
    if (!detail) return null;
    return { chatId: strOrNull(detail.chatId), roomId: strOrNull(detail.roomId) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations (the owner function validates every value; the database again)
// ---------------------------------------------------------------------------

export type ChatPatch = {
  name?: unknown;
  roomId?: unknown;
  groupId?: unknown;
  mode?: unknown;
  soloProvider?: unknown;
  builderProvider?: unknown;
  reviewerProvider?: unknown;
};

export async function createChat(input: {
  name: unknown;
  roomId?: unknown;
  groupId?: unknown;
  mode?: unknown;
}): Promise<string | null> {
  const r = (await call("createMyChat", input)) as { chatId?: unknown } | null;
  return r && isStr(r.chatId) ? r.chatId : null;
}

export const updateChat = (chatId: unknown, patch: ChatPatch) =>
  call("updateMyChat", chatId, patch);
export const setChatPinned = (chatId: unknown, pinned: boolean) =>
  call("setMyChatPinned", chatId, pinned);
export const setChatArchived = (chatId: unknown, archived: boolean) =>
  call("setMyChatArchived", chatId, archived);
export const deleteChat = (chatId: unknown) => call("deleteMyChat", chatId);
export const createChatGroup = (name: unknown) => call("createMyChatGroup", name);
export const renameChatGroup = (groupId: unknown, name: unknown) =>
  call("renameMyChatGroup", groupId, name);
export const deleteChatGroup = (groupId: unknown) => call("deleteMyChatGroup", groupId);
export const retryJobWithRoles = (jobId: unknown, coordinator: unknown) =>
  call("retryMyJobWithRoles", jobId, coordinator);

// ---------------------------------------------------------------------------
// 0.10 — the real ThreadLink experience (see the header for every name used)
// ---------------------------------------------------------------------------

/** 0.10 lookups: lib/chat/owner first, then lib/team/owner. */
const anyFn = (name: string) => chatFn(name) ?? lookup(teamOwner, name);

async function call10(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = anyFn(name);
  if (!fn) throw new ChatServerUnavailableError();
  return fn(...args);
}

/** A read that says null when the function is missing or fails. */
async function read10(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = anyFn(name);
  if (!fn) return null;
  try {
    return await fn(...args);
  } catch {
    return null;
  }
}

const rows = (v: unknown): Record<string, unknown>[] | null =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    : null;

/** Registry rows (agent_providers), or null → the UI uses its local fallback. */
export async function loadProviderRegistryRows(): Promise<unknown[] | null> {
  return rows(await read10("listMyAgentProviders"));
}

/** The first (latest) page by the per-chat cursor; the 0.9 page only as a fallback. */
export async function loadChatTimeline(chatId: string): Promise<unknown> {
  if (!CHAT_ID.test(chatId)) return null;
  const fn = anyFn("listMyChatTimeline");
  if (fn) {
    try {
      return await fn(chatId, { limit: 100 });
    } catch {
      return null;
    }
  }
  return loadChatEvents(chatId);
}

export type { ChatHost, HostStatus } from "./presence";

/** "Runs on <host>", presence and each agent's health with its check time, or null. */
export async function loadHostStatus(chatId: string): Promise<HostStatus | null> {
  if (!CHAT_ID.test(chatId)) return null;
  return parseHostStatus(await read10("getMyHostStatus", chatId));
}

export const loadChatFindings = async (chatId: string) =>
  rows(await read10("listMyFindings", chatId));
export const loadChatDecisions = async (chatId: string) =>
  rows(await read10("listMyDecisions", chatId));
export const loadChatChoices = async (chatId: string) =>
  rows(await read10("listMyChoices", chatId));
/** Not provided by the server in 0.10 (null → Details says where run details are). */
export const loadChatRuns = async (chatId: string) => rows(await read10("listMyChatRuns", chatId));

export type ArtifactRow = {
  artifactId: string;
  kind: string;
  title: string;
  mime: string;
  bytes: number | null;
  createdAt: string | null;
  createdBy: string | null;
};

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,80}$/;

function toArtifact(r: Record<string, unknown>): ArtifactRow | null {
  const artifactId = isStr(r.artifactId) ? r.artifactId : isStr(r.id) ? r.id : null;
  if (!artifactId || !ARTIFACT_ID.test(artifactId)) return null;
  return {
    artifactId,
    kind: isStr(r.kind) ? r.kind.slice(0, 30) : "notes",
    title: isStr(r.title) ? r.title.slice(0, 200) : "Untitled",
    mime: isStr(r.mime) ? r.mime.slice(0, 80) : "text/plain",
    bytes: typeof r.bytes === "number" ? r.bytes : null,
    createdAt: strOrNull(r.createdAt),
    createdBy: strOrNull(r.createdBy),
  };
}

export async function loadChatArtifacts(chatId: string): Promise<ArtifactRow[] | null> {
  const list = rows(await read10("listMyArtifacts", chatId));
  return list ? list.map(toArtifact).filter((a): a is ArtifactRow => a !== null) : null;
}

export const loadRunProvenance = (chatId: string, runId: string) =>
  read10("getMyRunProvenance", chatId, runId);
export const revealNativeSession = (chatId: unknown, runId: unknown) =>
  call10("revealMyRunNativeSession", chatId, runId);
export const decideChoice = (chatId: unknown, choiceId: unknown, key: unknown) =>
  call10("decideMyChoice", chatId, choiceId, { key });
export const controlJob = (chatId: unknown, jobId: unknown, action: unknown) =>
  call10("controlMyJob", chatId, { jobId, action });
export const addChatAttachment = (
  chatId: unknown,
  file: { title: string; mime: "text/plain" | "text/markdown"; content: string },
) => call10("addMyAttachment", chatId, file);

/** Server search (owner-scoped; the query only). null = unavailable; [] = no results. */
export async function searchChats(query: string): Promise<Record<string, unknown>[] | null> {
  const fn = anyFn("searchMyChats");
  if (!fn) return null;
  try {
    return rows(await fn({ q: query, limit: 50 })) ?? [];
  } catch {
    return null;
  }
}

/** Not provided by the server in 0.10: null → the hub says nothing is configured. */
export async function loadProjectHub(roomId: string): Promise<Record<string, unknown> | null> {
  const raw = await read10("getMyProjectHub", roomId);
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}
