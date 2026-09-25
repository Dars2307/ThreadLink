import type { ChatEvent, ChatPage, JobMode, PostChatMessageResult } from "@/lib/chat/types";

import { humanize, modelDisplayName, providerProductName, roleLabel, type Tone } from "./labels";

/**
 * Pure helpers for the project chat (no I/O, no React). The chat is
 * ThreadLink's own record: every author field was set by the server, so the UI
 * only chooses how to show it. Bodies are plain text and are never turned into
 * HTML here or anywhere else.
 */

export const COMPOSER_MAX = 4000;
/** Bodies longer than this (or with more lines) start collapsed behind "Show more". */
export const COLLAPSE_CHARS = 700;
export const COLLAPSE_LINES = 12;
/** Consecutive messages from the same author within this window share one header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export const POLL_VISIBLE_MS = 3_000;
export const POLL_HIDDEN_MS = 15_000;
export const IDLE_AFTER_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Merging pages
// ---------------------------------------------------------------------------

/** Append new events by seq; an id seen before is never shown twice. */
export function mergeEvents(existing: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** The cursor to poll from next: never goes backwards. */
export function nextCursor(current: number, page: Pick<ChatPage, "cursor" | "events">): number {
  const top = page.events.reduce((m, e) => Math.max(m, e.seq), page.cursor);
  return Math.max(current, Number.isFinite(top) ? top : current);
}

/** Validates a response body from the chat route before the UI trusts its shape. */
export function isChatPage(value: unknown): value is ChatPage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.events) &&
    typeof v.cursor === "number" &&
    (v.activeJob === null || typeof v.activeJob === "object") &&
    v.events.every(
      (e) =>
        e &&
        typeof e === "object" &&
        typeof (e as ChatEvent).id === "string" &&
        typeof (e as ChatEvent).seq === "number" &&
        typeof (e as ChatEvent).body === "string" &&
        typeof (e as ChatEvent).authorLabel === "string",
    )
  );
}

// ---------------------------------------------------------------------------
// One event → what the timeline shows
// ---------------------------------------------------------------------------

export type ChatSide = "left" | "right";

export type ChatBubbleView = {
  kind: "bubble";
  key: string;
  seq: number;
  author: "controller" | "owner" | "agent";
  side: ChatSide;
  label: string;
  /** "Claude Code" / "Codex" for agents; the controller's app name otherwise. */
  badge: string | null;
  badgeTone: Tone;
  role: string | null;
  /** "Claude Sonnet 5", or "Requested Claude Opus 5.5, used Claude Sonnet 5". */
  model: string | null;
  modelMismatch: boolean;
  round: string | null;
  audience: string | null;
  kindLabel: string | null;
  /** Plain text, rendered as a text node only. */
  body: string;
  collapsible: boolean;
  preview: string;
  at: string;
  technical: boolean;
};

export type ChatMilestoneView = {
  kind: "milestone";
  key: string;
  seq: number;
  text: string;
  tone: Tone;
  at: string;
  technical: boolean;
};

export type ChatItemView = ChatBubbleView | ChatMilestoneView;

const PROVIDER_TONE: Record<string, Tone> = { "claude-code": "accent", codex: "success" };

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

const AUDIENCE_LABELS: Record<string, string> = {
  "claude-code": "To Claude Code",
  codex: "To Codex",
  team: "To the team",
};

const MILESTONE_TONES: Partial<Record<ChatEvent["eventType"], Tone>> = {
  task_failed: "danger",
  task_cancelled: "neutral",
  finding: "warning",
  model_mismatch: "danger",
  stop_requested: "warning",
  plan_agreed: "accent",
  job_started: "accent",
};

/**
 * A verdict's colour comes from the verdict word the server put first, never
 * from anything later in the line: only "Result: PASS" is green.
 */
export function verdictTone(body: string): Tone {
  const verdict = /^Result: ([A-Z_]+)(?:\s|$)/.exec(body)?.[1];
  if (verdict === "PASS") return "success";
  if (verdict === "NEEDS_FIX" || verdict === "BLOCKED") return "danger";
  return "warning";
}

/** The model an agent used, in words; says so when it differs from what was asked. */
export function modelLine(
  requested: string | null,
  observed: string | null,
): { text: string | null; mismatch: boolean } {
  if (!requested && !observed) return { text: null, mismatch: false };
  if (observed && requested && observed !== requested) {
    return {
      text: `Requested ${modelDisplayName(requested)}, used ${modelDisplayName(observed)}`,
      mismatch: true,
    };
  }
  if (observed) return { text: modelDisplayName(observed), mismatch: false };
  return { text: `${modelDisplayName(requested)} (requested)`, mismatch: false };
}

export function shouldCollapse(body: string): boolean {
  return body.length > COLLAPSE_CHARS || body.split("\n").length > COLLAPSE_LINES;
}

/** The first part of a long body, cut at a line or word boundary. */
export function previewOf(body: string): string {
  if (!shouldCollapse(body)) return body;
  const lines = body.split("\n").slice(0, COLLAPSE_LINES).join("\n");
  const cut = lines.length > COLLAPSE_CHARS ? lines.slice(0, COLLAPSE_CHARS) : lines;
  const space = cut.lastIndexOf(" ");
  return `${(space > COLLAPSE_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Milestone text is one line; the server wrote it from trusted state. */
function milestoneText(e: ChatEvent): string {
  return e.body.replace(/\s+/g, " ").trim();
}

export function chatItemView(e: ChatEvent): ChatItemView {
  const technical = e.visibility === "technical";
  if (e.authorKind === "threadlink") {
    return {
      kind: "milestone",
      key: e.id,
      seq: e.seq,
      text: milestoneText(e),
      tone:
        e.eventType === "job_verdict"
          ? verdictTone(e.body)
          : (MILESTONE_TONES[e.eventType] ?? "neutral"),
      at: e.createdAt,
      technical,
    };
  }
  const author = e.authorKind;
  const model =
    author === "agent"
      ? modelLine(e.modelRequested, e.modelObserved)
      : { text: null, mismatch: false };
  const agentBadge = e.authorProvider ? providerProductName(e.authorProvider) : null;
  return {
    kind: "bubble",
    key: e.id,
    seq: e.seq,
    author,
    side: author === "owner" ? "right" : "left",
    label:
      e.authorLabel ||
      (author === "owner" ? "You" : author === "controller" ? "Controller" : "Agent"),
    badge: author === "agent" ? agentBadge : author === "controller" ? "Controller" : null,
    badgeTone:
      author === "agent" && e.authorProvider ? PROVIDER_TONE[e.authorProvider]! : "neutral",
    role: author === "agent" && e.authorRole ? roleLabel(e.authorRole) : null,
    model: model.text,
    modelMismatch: model.mismatch,
    round: e.round !== null && e.round !== undefined && e.round > 0 ? `Round ${e.round}` : null,
    audience: e.audience && author !== "agent" ? (AUDIENCE_LABELS[e.audience] ?? null) : null,
    kindLabel: e.messageType
      ? (MESSAGE_TYPE_LABELS[e.messageType] ?? humanize(e.messageType))
      : null,
    body: e.body,
    collapsible: shouldCollapse(e.body),
    preview: previewOf(e.body),
    at: e.createdAt,
    technical,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type ChatGroup =
  | { kind: "milestone"; key: string; item: ChatMilestoneView }
  | { kind: "bubbles"; key: string; items: ChatBubbleView[] };

/** Who said it, for grouping: same kind, provider, label and role. */
function speaker(b: ChatBubbleView): string {
  return [b.author, b.badge, b.label, b.role].join("|");
}

/**
 * Consecutive messages by the same speaker, close together, share one header.
 * Milestones always stand alone and break a group.
 */
export function groupChat(events: ChatEvent[], opts: { technical?: boolean } = {}): ChatGroup[] {
  const groups: ChatGroup[] = [];
  for (const e of events) {
    const item = chatItemView(e);
    if (item.technical && !opts.technical) continue;
    if (item.kind === "milestone") {
      groups.push({ kind: "milestone", key: item.key, item });
      continue;
    }
    const last = groups.at(-1);
    const prev = last?.kind === "bubbles" ? last.items.at(-1) : undefined;
    if (
      last?.kind === "bubbles" &&
      prev &&
      speaker(prev) === speaker(item) &&
      Date.parse(item.at) - Date.parse(prev.at) <= GROUP_WINDOW_MS
    ) {
      last.items.push(item);
    } else {
      groups.push({ kind: "bubbles", key: item.key, items: [item] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export const MENTION_HINTS = [
  { insert: "@Claude ", label: "@Claude", description: "Ask Claude Code" },
  { insert: "@Codex ", label: "@Codex", description: "Ask Codex" },
  { insert: "@team ", label: "@team", description: "Ask both agents" },
  {
    insert: "@team stop after this review round",
    label: "@team stop after this review round",
    description: "Finish the current round, then stop",
  },
] as const;

export const MODE_OPTIONS: { value: JobMode; label: string; description: string }[] = [
  { value: "solo", label: "Solo", description: "One agent builds and verifies." },
  {
    value: "pair",
    label: "Builder + Reviewer",
    description: "One builds, the other reviews before it passes.",
  },
  { value: "team", label: "Team", description: "Both plan, build and review each other." },
];

export type Builder = "claude-code" | "codex";

/** A leading @mention, read only to hint where a message goes. The server decides. */
export function mentionOf(body: string): "claude-code" | "codex" | "team" | "stop" | null {
  const m = /^\s*@(claude|codex|team)\b/i.exec(body);
  if (!m) return null;
  const who = m[1]!.toLowerCase();
  if (who === "team" && /^\s*@team\s+stop\b/i.test(body)) return "stop";
  return who === "claude" ? "claude-code" : (who as "codex" | "team");
}

export type DraftCheck = { ok: true; body: string } | { ok: false; message: string };

export function checkDraft(body: string): DraftCheck {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, message: "Write a message first." };
  if (body.length > COMPOSER_MAX) {
    return {
      ok: false,
      message: `Keep it under ${COMPOSER_MAX.toLocaleString("en-GB")} characters.`,
    };
  }
  return { ok: true, body: trimmed };
}

/** What a send will do, shown above the composer. */
export function routeBanner(
  activeJob: ChatPage["activeJob"],
  draft: string,
): { text: string; tone: Tone } {
  const mention = mentionOf(draft);
  if (activeJob) {
    if (mention === "stop") {
      return {
        text: "The running job finishes its current round, then stops and asks you.",
        tone: "warning",
      };
    }
    return {
      text: "Your message goes to the running job. The agents read it before their next step.",
      tone: "accent",
    };
  }
  if (mention === "stop")
    return { text: "Nothing is running, so there is nothing to stop.", tone: "neutral" };
  return { text: "Starts a new job in this project.", tone: "neutral" };
}

/** The mode and builder a new job asks for, from the picker and any leading @mention. */
export function jobRequest(
  draft: string,
  picked: { mode: JobMode; builder: Builder },
): { mode: JobMode; builder?: Builder } {
  const mention = mentionOf(draft);
  if (mention === "claude-code" || mention === "codex") {
    return picked.mode === "pair"
      ? { mode: "pair", builder: mention }
      : { mode: "solo", builder: mention };
  }
  if (mention === "team") return { mode: "team" };
  return picked.mode === "team" ? { mode: "team" } : { mode: picked.mode, builder: picked.builder };
}

/** What happened after sending, in words. */
export function sendOutcome(result: PostChatMessageResult): { ok: boolean; message: string } {
  if (!result.ok) return { ok: false, message: safeServerMessage(result.message) };
  if (result.routed === "note_to_active_job") {
    return { ok: true, message: "Sent to the running job. The agents will read it next." };
  }
  if (result.routed === "stop_requested") {
    return { ok: true, message: "Stop requested. The job stops after the current round." };
  }
  return { ok: true, message: "Started a new job." };
}

export const SEND_FAILED = "Could not send your message. Check your connection and try again.";

/**
 * The server's failure text is written for people, but the UI still caps it
 * and falls back to a fixed sentence if it looks like anything else.
 */
export function safeServerMessage(message: unknown): string {
  if (typeof message !== "string") return SEND_FAILED;
  const m = message.trim();
  if (!m || m.length > 240 || /[<>{}]|\b(sql|postgres|pgrst|stack|exception)\b/i.test(m)) {
    return SEND_FAILED;
  }
  return m;
}

export function isPostResult(value: unknown): value is PostChatMessageResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok === false) return typeof v.message === "string";
  return (
    v.ok === true &&
    (v.routed === "note_to_active_job" || v.routed === "stop_requested" || v.routed === "new_job")
  );
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** How long to wait before the next poll, or null to pause until the person is back. */
export function pollDelay(state: { visible: boolean; idleMs: number }): number | null {
  if (state.idleMs >= IDLE_AFTER_MS) return null;
  return state.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
}

/** "3 new messages" for the live region; milestones count as updates. */
export function announcement(added: ChatEvent[], technical: boolean): string | null {
  const shown = added.filter((e) => technical || e.visibility === "visible");
  if (shown.length === 0) return null;
  const messages = shown.filter((e) => e.authorKind !== "threadlink");
  if (messages.length === 1) {
    return `New message from ${messages[0]!.authorLabel}.`;
  }
  if (messages.length > 1) return `${messages.length} new messages.`;
  return shown.length === 1 ? `Update: ${milestoneText(shown[0]!)}` : `${shown.length} updates.`;
}
