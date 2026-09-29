/**
 * Native session continuity for Fast Chat (docs/design/threadlink-0.11.md §3.4.6).
 *
 * One provider-native session (Claude `session_id`, Codex `thread_id`) per
 * (ThreadLink chat, provider, workspace), remembered in the Runtime's own
 * config directory so the next turn of the same chat resumes it instead of
 * starting cold. The rules:
 *
 *   - The key is the chat id, the provider and the workspace. A lookup must
 *     match all three, and the stored entry repeats them, so a session is never
 *     handed to another chat or another project -- even if the file is edited.
 *   - A session is rotated (a fresh one starts) after 30 turns, after 24 hours,
 *     or when resuming it failed. The reason is reported with the run
 *     (`sessionReason`).
 *   - Only ids, counters and times are stored: never prompts or answers.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AgentProvider } from "./types.ts";
import type { SessionReason } from "./wire.ts";

export const CHAT_SESSIONS_FILE = "fast-chat-sessions.json";
export const SESSION_MAX_TURNS = 30;
export const SESSION_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 500;

const CHAT_ID = /^tlcht_[0-9a-f]{32}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type ChatSessionEntry = {
  chatId: string;
  provider: AgentProvider;
  /** A hash of the workspace path: which project this session belongs to. */
  workspace: string;
  sessionId: string;
  turns: number;
  createdAt: number;
  lastUsedAt: number;
  /** The run key of the run that last used it (server continuity, same job only). */
  lastRunKey: string | null;
};

/** What the next turn should do with its native session. */
export type SessionPlan =
  | { resume: string; reason: "resumed"; entry: ChatSessionEntry }
  | { resume: null; reason: Exclude<SessionReason, "resumed" | "fresh_resume_failed"> };

/** Workspaces are compared by resolved, case-folded (Windows) path, stored hashed. */
export function workspaceKey(path: string): string {
  let p = resolve(path);
  if (process.platform === "win32") p = p.toLowerCase();
  return createHash("sha256").update(p).digest("hex").slice(0, 32);
}

export class ChatSessionStore {
  readonly #file: string | null;
  readonly #now: () => number;
  #entries: Map<string, ChatSessionEntry> | null = null;

  /** `configDir` null: memory only (tests, embedded engines). */
  constructor(configDir: string | null, options: { now?: () => number } = {}) {
    this.#file = configDir ? join(configDir, CHAT_SESSIONS_FILE) : null;
    this.#now = options.now ?? Date.now;
  }

  static key(chatId: string, provider: AgentProvider, workspace: string): string {
    return `${chatId}|${provider}|${workspaceKey(workspace)}`;
  }

  /**
   * The session to resume for this chat, provider and workspace, or why a
   * fresh one starts. Never returns another chat's or workspace's session.
   */
  plan(chatId: string | null, provider: AgentProvider, workspace: string): SessionPlan {
    if (!chatId || !CHAT_ID.test(chatId)) return { resume: null, reason: "fresh_first_turn" };
    const entry = this.#load().get(ChatSessionStore.key(chatId, provider, workspace));
    if (
      !entry ||
      entry.chatId !== chatId ||
      entry.provider !== provider ||
      entry.workspace !== workspaceKey(workspace)
    ) {
      return { resume: null, reason: "fresh_first_turn" };
    }
    const now = this.#now();
    if (entry.turns >= SESSION_MAX_TURNS || now - entry.createdAt >= SESSION_MAX_AGE_MS) {
      return { resume: null, reason: "fresh_rotated" };
    }
    return { resume: entry.sessionId, reason: "resumed", entry };
  }

  /** A turn finished on `sessionId`: a new session starts its count, a resumed one adds a turn. */
  record(
    chatId: string | null,
    provider: AgentProvider,
    workspace: string,
    sessionId: string,
    resumed: boolean,
    runKey: string | null = null,
  ): void {
    if (!chatId || !CHAT_ID.test(chatId) || !SESSION_ID.test(sessionId)) return;
    const entries = this.#load();
    const key = ChatSessionStore.key(chatId, provider, workspace);
    const now = this.#now();
    const previous = entries.get(key);
    const continuing = resumed && previous?.sessionId === sessionId;
    entries.delete(key);
    entries.set(key, {
      chatId,
      provider,
      workspace: workspaceKey(workspace),
      sessionId,
      turns: continuing ? previous!.turns + 1 : 1,
      createdAt: continuing ? previous!.createdAt : now,
      lastUsedAt: now,
      lastRunKey: runKey,
    });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    this.#save();
  }

  /** Resuming failed: the stored session is dropped, so the retry and later turns start fresh. */
  forget(chatId: string | null, provider: AgentProvider, workspace: string): void {
    if (!chatId) return;
    if (this.#load().delete(ChatSessionStore.key(chatId, provider, workspace))) this.#save();
  }

  /** Every entry (tests, diagnostics). Ids only. */
  list(): ChatSessionEntry[] {
    return [...this.#load().values()].map((e) => ({ ...e }));
  }

  #load(): Map<string, ChatSessionEntry> {
    if (this.#entries) return this.#entries;
    const entries = new Map<string, ChatSessionEntry>();
    if (this.#file) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, "utf8")) as { entries?: unknown };
        if (Array.isArray(raw.entries)) {
          for (const e of raw.entries) {
            const parsed = parseEntry(e);
            if (parsed) {
              entries.set(`${parsed.chatId}|${parsed.provider}|${parsed.workspace}`, parsed);
            }
          }
        }
      } catch {
        /* no file yet, or unreadable: every chat starts fresh */
      }
    }
    // Keys are rebuilt from the entry's own fields: a hand-edited key cannot
    // point one chat at another chat's session.
    const rekeyed = new Map<string, ChatSessionEntry>();
    for (const e of entries.values()) rekeyed.set(`${e.chatId}|${e.provider}|${e.workspace}`, e);
    this.#entries = rekeyed;
    return rekeyed;
  }

  #save(): void {
    if (!this.#file || !this.#entries) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, entries: [...this.#entries.values()] }, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(tmp, this.#file);
    } catch {
      /* continuity is a speed-up; failing to remember only means a fresh session next time */
    }
  }
}

function parseEntry(value: unknown): ChatSessionEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (typeof e.chatId !== "string" || !CHAT_ID.test(e.chatId)) return null;
  if (e.provider !== "claude-code" && e.provider !== "codex") return null;
  if (typeof e.workspace !== "string" || !/^[0-9a-f]{32}$/.test(e.workspace)) return null;
  if (typeof e.sessionId !== "string" || !SESSION_ID.test(e.sessionId)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const turns = num(e.turns);
  const createdAt = num(e.createdAt);
  const lastUsedAt = num(e.lastUsedAt);
  if (turns === null || createdAt === null || lastUsedAt === null) return null;
  return {
    chatId: e.chatId,
    provider: e.provider,
    workspace: e.workspace,
    sessionId: e.sessionId,
    turns,
    createdAt,
    lastUsedAt,
    lastRunKey: typeof e.lastRunKey === "string" ? e.lastRunKey.slice(0, 128) : null,
  };
}
