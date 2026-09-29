/**
 * `threadlink chat "<name>"`: an interactive, readline-based view of one chat.
 *
 * - Prints the header and the latest page of the SAME server timeline the web
 *   shows, then polls the per-chat cursor for new rows (with backoff).
 * - A line typed at `> ` is posted as the owner (client "terminal") with a
 *   fresh idempotency key; a retry of the same message reuses its key.
 * - `/quit` only leaves this terminal view. Nothing is cancelled: work keeps
 *   running in ThreadLink. `/status` shows where the chat stands.
 * - 0.11: only rows that belong in the conversation are printed (the shared
 *   placement rules, §7); `--all` also prints the routine Activity rows.
 *   `/chat …` and `/work …` are sent as typed (the server strips the prefix
 *   and picks the lane); an answer to an open choice is resolved on the
 *   server and reported as "Answered: …".
 * - Every piece of server text is made terminal-safe before printing.
 *
 * All I/O is injected, so the whole thing runs against a fake client in tests.
 */

import { randomUUID } from "node:crypto";

import {
  ChatApiError,
  MESSAGE_MAX_CHARS,
  type ChatApi,
  type ChatListItem,
  type ChatLiveRun,
  type ChatTimelineEvent,
  type HostPresence,
} from "../chat-client.ts";
import {
  chatState,
  formatEvent,
  formatHeader,
  formatLive,
  hostLine,
  participantsLine,
  placementOf,
  youLine,
} from "./format.ts";
import { safeLine } from "./text.ts";

export const POLL_MIN_MS = 2_000;
export const POLL_IDLE_MAX_MS = 15_000;
export const POLL_ERROR_MAX_MS = 60_000;
export const READ_MARK_EVERY_MS = 10_000;

/** The next poll delay: quick while things happen, slower when idle, slowest on errors. */
export function nextPollDelay(previous: number, outcome: "new" | "idle" | "error"): number {
  if (outcome === "new") return POLL_MIN_MS;
  if (outcome === "idle")
    return Math.min(POLL_IDLE_MAX_MS, Math.max(POLL_MIN_MS, Math.round(previous * 1.5)));
  return Math.min(POLL_ERROR_MAX_MS, Math.max(5_000, previous * 2));
}

export type SessionOutput = {
  /** Prints lines above the prompt (the caller keeps what the user is typing). */
  print(lines: string[]): void;
};

type Pending = { body: string; key: string };

export class ChatSession {
  readonly chat: ChatListItem;
  #api: ChatApi;
  #out: SessionOutput;
  #now: () => number;
  #newKey: () => string;
  #seen = new Set<number>();
  #cursor = 0;
  #oldest: number | null = null;
  #hasOlder = false;
  #live: ChatLiveRun[] = [];
  #liveShown = "";
  #lastRead = 0;
  #readAt = Number.NEGATIVE_INFINITY;
  #pending: Pending | null = null;
  #closed = false;
  /** Print Activity rows too (`threadlink chat --all`). */
  #all: boolean;
  /** This terminal's own connection: its last request to ThreadLink succeeded. */
  #connected: boolean | null = null;
  #hostPresence: HostPresence | null = null;

  constructor(
    chat: ChatListItem,
    api: ChatApi,
    out: SessionOutput,
    options: { now?: () => number; newKey?: () => string; all?: boolean } = {},
  ) {
    this.chat = chat;
    this.#api = api;
    this.#out = out;
    this.#now = options.now ?? Date.now;
    this.#newKey = options.newKey ?? (() => randomUUID());
    this.#all = options.all === true;
  }

  get cursor(): number {
    return this.#cursor;
  }
  get closed(): boolean {
    return this.#closed;
  }

  #visible(events: ChatTimelineEvent[]): ChatTimelineEvent[] {
    return events.filter(
      (e) => e.visibility === "visible" && (this.#all || placementOf(e) === "chat"),
    );
  }

  #take(events: ChatTimelineEvent[]): ChatTimelineEvent[] {
    const fresh = events.filter((e) => !this.#seen.has(e.seq));
    for (const e of fresh) this.#seen.add(e.seq);
    return fresh;
  }

  #printEvents(events: ChatTimelineEvent[]) {
    const lines = this.#visible(events).map((e) => formatEvent(e, this.chat.participants));
    if (lines.length) this.#out.print(lines);
  }

  #printLive(live: ChatLiveRun[]) {
    this.#live = live;
    const text = live.map((r) => formatLive(r, this.chat.participants, this.#now())).join("\n");
    // Only say it again when it changed, so an idle chat stays quiet.
    const key = live.map((r) => `${r.runId}:${r.activity}`).join("|");
    if (key !== this.#liveShown) {
      this.#liveShown = key;
      if (text) this.#out.print([text]);
    }
  }

  /** Header plus the latest page. */
  async start(): Promise<void> {
    const page = await this.#api.events(this.chat.chatId);
    this.#connected = true;
    this.#hostPresence = page.hostPresence ?? null;
    this.#out.print([
      ...formatHeader(this.chat, { connected: true, host: this.#hostPresence }),
      "",
    ]);
    const fresh = this.#take(page.events);
    this.#cursor = page.cursor;
    this.#oldest = page.events[0]?.seq ?? null;
    this.#hasOlder = page.hasOlder;
    if (this.#hasOlder) this.#out.print(["(earlier messages: /older)"]);
    if (!fresh.length) this.#out.print(["No messages yet. Say what you want done."]);
    this.#printEvents(fresh);
    this.#printLive(page.live);
    await this.#markRead(true);
  }

  /** One poll of the per-chat cursor. Returns what happened, for the backoff. */
  async poll(): Promise<"new" | "idle" | "error"> {
    if (this.#closed) return "idle";
    try {
      const page = await this.#api.events(this.chat.chatId, { after: this.#cursor });
      if (this.#connected === false) this.#out.print([youLine(true)]);
      this.#connected = true;
      this.#noteHost(page.hostPresence ?? null);
      const fresh = this.#take(page.events);
      this.#cursor = Math.max(this.#cursor, page.cursor);
      if (this.#oldest === null) this.#oldest = page.events[0]?.seq ?? null;
      this.#printEvents(fresh);
      this.#printLive(page.live);
      if (fresh.length) await this.#markRead(false);
      return fresh.length ? "new" : "idle";
    } catch {
      if (this.#connected !== false) this.#out.print([youLine(false)]);
      this.#connected = false;
      return "error";
    }
  }

  /** Says so when the execution host's presence changes (never for this terminal). */
  #noteHost(presence: HostPresence | null) {
    if (!presence || presence === this.#hostPresence) return;
    const was = this.#hostPresence;
    this.#hostPresence = presence;
    if (was === null) return;
    const host = hostLine(this.chat, presence);
    if (!host) return;
    const lines = [host.text];
    if (presence === "offline")
      lines.push(
        "You're connected. Repository work and agent replies will resume when it reconnects.",
      );
    this.#out.print(lines);
  }

  async #markRead(force: boolean) {
    const t = this.#now();
    if (this.#cursor <= this.#lastRead) return;
    if (!force && t - this.#readAt < READ_MARK_EVERY_MS) return;
    this.#readAt = t;
    try {
      await this.#api.markRead(this.chat.chatId, this.#cursor);
      this.#lastRead = this.#cursor;
    } catch {
      /* advisory */
    }
  }

  async #send(pending: Pending): Promise<boolean> {
    try {
      const result = await this.#api.post(this.chat.chatId, pending.body, pending.key);
      this.#connected = true;
      if (result.ok) {
        this.#pending = null;
        // The message answered the open question (§6): the server resolved it.
        if (result.routed === "choice_resolved")
          this.#out.print([
            `ThreadLink: Answered${result.chosenLabel ? ` — ${safeLine(result.chosenLabel, 80)}` : ""}.`,
          ]);
        return true;
      }
      // Refused (e.g. an agent is not ready). If the server stored it anyway,
      // it is in the timeline; either way the reason is a fixed sentence.
      this.#pending = null;
      this.#out.print([
        `ThreadLink: ${safeLine(result.message, 300)}${result.stored ? " (your message is in the chat)" : ""}`,
      ]);
      return false;
    } catch (error) {
      const network = error instanceof ChatApiError && (error.status === 0 || error.status >= 500);
      if (network) {
        this.#pending = pending;
        this.#out.print([
          "Not sent: ThreadLink could not be reached. Type /retry to send it again.",
        ]);
      } else {
        this.#pending = null;
        const msg = error instanceof ChatApiError ? error.message : "That message was not sent.";
        this.#out.print([`Not sent: ${safeLine(msg, 200)}`]);
      }
      return false;
    }
  }

  /** Handles one typed line. Returns "quit" when the user left. */
  async handleLine(raw: string): Promise<"continue" | "quit"> {
    const line = raw.trim();
    if (!line) return "continue";
    // `/chat …` (Fast Chat) and `/work …` (Engineering Work) are messages: the
    // server strips the prefix and runs it in that lane (0.11 §2.4).
    const lanePrefix = /^\/(chat|work)(\s|$)/i.test(line);
    if (line.startsWith("/") && !lanePrefix) {
      const cmd = line.split(/\s+/)[0]!.toLowerCase();
      if (cmd === "/quit" || cmd === "/exit" || cmd === "/q") {
        this.close();
        this.#out.print(["Left the chat. Anything running keeps going in ThreadLink."]);
        return "quit";
      }
      if (cmd === "/status") return this.#status().then(() => "continue");
      if (cmd === "/older") return this.#older().then(() => "continue");
      if (cmd === "/retry") {
        if (!this.#pending) this.#out.print(["Nothing to retry."]);
        else if (await this.#send(this.#pending)) await this.poll();
        return "continue";
      }
      if (cmd === "/help") {
        this.#out.print([
          "Type a message and press Enter. Start with @codex or @claude to address one agent.",
          "/chat <message>  just talk (no repository work)   /work <message>  run it as work",
          "Answer an open question by typing it (e.g. continue with Claude, wait, stop).",
          "/status  where this chat stands     /older  earlier messages",
          "/retry   resend a message that failed  /quit   leave (work keeps running)",
        ]);
        return "continue";
      }
      this.#out.print([`Unknown command ${safeLine(cmd, 20)}. Type /help.`]);
      return "continue";
    }
    if (line.length > MESSAGE_MAX_CHARS) {
      this.#out.print([`That message is too long (max ${MESSAGE_MAX_CHARS} characters).`]);
      return "continue";
    }
    // One key per message: a retry of THIS message reuses it, a new one never does.
    if (await this.#send({ body: line, key: this.#newKey() })) await this.poll();
    return "continue";
  }

  async #status() {
    let chat: ChatListItem = this.chat;
    try {
      chat = await this.#api.getChat(this.chat.chatId);
    } catch {
      this.#out.print(["Couldn't refresh this chat right now; showing what is known."]);
    }
    const lines = [
      `${safeLine(chat.name, 80)} · ${chatState(chat)} · ${participantsLine(chat.participants)}`,
    ];
    if (chat.activeJob) lines.push(`Current work: ${safeLine(chat.activeJob.status, 40)}`);
    const host = hostLine(chat, this.#hostPresence);
    lines.push(`${youLine(this.#connected ?? true)}   ${host ? host.text : "No project yet"}`);
    for (const r of this.#live) lines.push(formatLive(r, chat.participants, this.#now()));
    this.#out.print(lines);
  }

  async #older() {
    if (!this.#hasOlder || this.#oldest === null) {
      this.#out.print(["No earlier messages."]);
      return;
    }
    try {
      const page = await this.#api.events(this.chat.chatId, { before: this.#oldest });
      const fresh = this.#take(page.events);
      this.#hasOlder = page.hasOlder;
      if (page.events[0]) this.#oldest = Math.min(this.#oldest, page.events[0].seq);
      this.#out.print(["— earlier messages —"]);
      this.#printEvents(fresh);
      this.#out.print(["— end of earlier messages —"]);
    } catch {
      this.#out.print(["Couldn't load earlier messages right now."]);
    }
  }

  close() {
    this.#closed = true;
  }
}

/** The bit of readline the loop needs; node's Interface satisfies it. */
export type LineReader = {
  on(event: "line", cb: (line: string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  prompt(preserveCursor?: boolean): void;
  close(): void;
};

/**
 * Runs a session until /quit or end of input (Ctrl+D / Ctrl+C closes readline).
 * Polling is a self-rescheduling timer, never overlapping itself.
 */
export async function runChatSession(
  session: ChatSession,
  reader: LineReader,
  timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  } = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never) },
): Promise<void> {
  await session.start();
  let delay = POLL_MIN_MS;
  let timer: unknown = null;
  let busy = Promise.resolve();
  const schedule = () => {
    if (session.closed) return;
    timer = timers.setTimeout(() => {
      busy = busy.then(async () => {
        const outcome = await session.poll();
        delay = nextPollDelay(delay, outcome);
        schedule();
      });
    }, delay);
  };
  schedule();
  reader.prompt();
  await new Promise<void>((resolve) => {
    const finish = () => {
      session.close();
      if (timer !== null) timers.clearTimeout(timer);
      resolve();
    };
    reader.on("line", (line) => {
      busy = busy.then(async () => {
        const result = await session.handleLine(line);
        if (result === "quit") {
          finish();
          reader.close();
          return;
        }
        delay = POLL_MIN_MS;
        reader.prompt();
      });
    });
    reader.on("close", finish);
  });
}
