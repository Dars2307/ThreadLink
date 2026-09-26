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
