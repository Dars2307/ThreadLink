/**
 * The notification router.
 *
 * Notification logic does not belong inside the code that runs Claude. An
 * event goes in, the router decides whether it is worth telling someone about,
 * and each registered channel is offered a payload it may deliver.
 *
 * Two rules the rest of the app depends on:
 *
 *   - Only meaningful states notify. Completion, failure, and the two states
 *     that need a human (approval, input). Progress, polling and tool chatter
 *     never do, however chatty the agent is.
 *   - Payloads carry safe metadata only. A notification can appear on a lock
 *     screen, so it names the task and where it ran, and never carries the
 *     prompt, the result body, a diff, a token or a key.
 */

export const NOTIFIABLE_EVENTS = [
  "task_completed",
  "task_failed",
  "approval_required",
  "user_input_required",
] as const;
export type NotifiableEvent = (typeof NOTIFIABLE_EVENTS)[number];

/** What a channel is given. Every field here is safe to show on a lock screen. */
export type NotificationPayload = {
  event: NotifiableEvent;
  /** Stable identity of the underlying thing, used for dedupe. */
  key: string;
  title: string;
  body: string;
  /** Groups a burst of related events into one message. */
  coalesceKey: string;
  /** Where to send the user when they click, if the channel supports it. */
  openPath?: string;
};

export type NotificationChannel = {
  readonly id: string;
  /** False when the channel exists but cannot deliver (e.g. no key configured). */
  available(): boolean;
  deliver(payload: NotificationPayload): void;
};

export type NotificationPreferences = {
  onCompleted: boolean;
  onFailed: boolean;
  onApprovalRequired: boolean;
  onInputRequired: boolean;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  onCompleted: true,
  onFailed: true,
  onApprovalRequired: true,
  onInputRequired: true,
};

/** An engine event, reduced to the few things a notification may mention. */
export type RouterInput = {
  type: string;
  outcome?: string;
  reason?: string;
  title?: string;
  conversation?: string;
  link?: { from: string };
};

/**
 * Turns an engine event into a payload, or null when it is not worth a
 * notification. This is the single place that decides "is this meaningful?".
 */
export function toPayload(event: RouterInput): NotificationPayload | null {
  if (event.type === "task" && event.outcome === "completed") {
    return {
      event: "task_completed",
      key: `task_completed:${event.title ?? ""}:${event.conversation ?? ""}`,
      title: "Claude finished",
      body: safeLine(event.title, event.conversation),
      coalesceKey: "task_completed",
      openPath: "/dashboard/activity",
    };
  }
  if (event.type === "task" && event.outcome === "failed") {
    // "In use" is its own story: the user can fix it by closing a conversation.
    const busy = event.reason === "session_busy";
    const unsupported = event.reason === "background_mode_unsupported";
    return {
      event: "task_failed",
      key: `task_failed:${event.title ?? ""}:${event.conversation ?? ""}`,
      title: busy
        ? "Claude conversation is in use"
        : unsupported
          ? "That agent cannot work in the background"
          : "Request failed",
      body: safeLine(event.title, event.conversation),
      coalesceKey: "task_failed",
      openPath: "/dashboard/activity",
    };
  }
  if (event.type === "link-request") {
    return {
      event: "approval_required",
      key: `approval_required:${event.link?.from ?? ""}`,
      title: "ThreadLink needs your approval",
      body: `“${event.link?.from ?? "A chat"}” wants to use Claude Code.`,
      coalesceKey: "approval_required",
      openPath: "/dashboard/links",
    };
  }
  // Everything else - progress, snapshots, settings, restarts - is noise.
  return null;
}

/**
 * Safe body text: the task's own title and where it ran, nothing from the
 * conversation itself. Titles are user-authored, so they are trimmed and
 * length-capped rather than trusted.
 */
function safeLine(title: string | undefined, conversation: string | undefined): string {
  const name = clean(title) || "Task";
  const where = clean(conversation);
  return where ? `${name} · ${where}` : name;
}

function clean(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80);
}

export type RouterOptions = {
  preferences?: NotificationPreferences;
  /** How long two identical notifications are treated as one. */
  dedupeMs?: number;
  now?: () => number;
};

export class NotificationRouter {
  readonly #channels: NotificationChannel[] = [];
  readonly #recent = new Map<string, number>();
  #preferences: NotificationPreferences;
  readonly #dedupeMs: number;
  readonly #now: () => number;

  constructor(options: RouterOptions = {}) {
    this.#preferences = options.preferences ?? { ...DEFAULT_PREFERENCES };
    this.#dedupeMs = options.dedupeMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  register(channel: NotificationChannel): void {
    this.#channels.push(channel);
  }

  setPreferences(preferences: Partial<NotificationPreferences>): void {
    this.#preferences = { ...this.#preferences, ...preferences };
  }

  /** The channels that exist, and whether each can currently deliver. */
  channels(): { id: string; available: boolean }[] {
    return this.#channels.map((c) => ({ id: c.id, available: c.available() }));
  }

  #wanted(event: NotifiableEvent): boolean {
    if (event === "task_completed") return this.#preferences.onCompleted;
    if (event === "task_failed") return this.#preferences.onFailed;
    if (event === "approval_required") return this.#preferences.onApprovalRequired;
    return this.#preferences.onInputRequired;
  }

  /**
   * Routes one event. Returns the payload that was delivered, or null when
   * nothing was: not meaningful, not wanted, or a repeat.
   */
  handle(event: RouterInput): NotificationPayload | null {
    const payload = toPayload(event);
    if (!payload || !this.#wanted(payload.event)) return null;

    // The same state arriving twice - a retry, two snapshots, a reconnect -
    // must not reach the user twice.
    const now = this.#now();
    const last = this.#recent.get(payload.key);
    if (last !== undefined && now - last < this.#dedupeMs) return null;
    this.#recent.set(payload.key, now);
    for (const [key, at] of this.#recent) {
      if (now - at >= this.#dedupeMs) this.#recent.delete(key);
    }

    for (const channel of this.#channels) {
      if (!channel.available()) continue;
      try {
        channel.deliver(payload);
      } catch {
        /* a broken channel must never break the engine */
      }
    }
    return payload;
  }
}
