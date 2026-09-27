/**
 * Pure formatting for the terminal client (`threadlink chats | chat | agents |
 * status`). No I/O here, so every line is unit-tested. Server text always goes
 * through safeLine/safeBody first.
 */

import type {
  ChatDelivery,
  ChatListItem,
  ChatLiveRun,
  ChatParticipant,
  ChatTimelineEvent,
} from "../chat-client.ts";
import { safeBody, safeLine } from "./text.ts";

export const MODE_LABEL: Record<string, string> = { solo: "Solo", pair: "Pair", team: "Team" };
export const modeLabel = (mode: string) => MODE_LABEL[mode] ?? "Solo";

/** "23 s ago", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ---------------------------------------------------------------------------
// Health freshness: ONE calculation (design §8). Never "Ready" with stale text.
// ---------------------------------------------------------------------------

/** A Ready check older than this is Stale. */
export const HEALTH_FRESH_MS = 2 * 60 * 60 * 1000;

const HEALTH_WORDS: Record<string, string> = {
  ready: "Ready",
  needs_sign_in: "Needs sign-in",
  not_installed: "Not installed",
  api_key_auth: "Uses an API key — sign in with your subscription",
  usage_exhausted: "Usage limit reached",
  unknown: "Not checked yet",
};

export type Freshness = {
  state: "ready" | "stale" | "problem" | "unknown";
  text: string;
};

export function freshness(
  health: string | null,
  checkedAt: string | null,
  now = Date.now(),
): Freshness {
  const h = health && HEALTH_WORDS[health] ? health : "unknown";
  const t = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const known = Number.isFinite(t);
  if (h === "ready") {
    if (known && now - t <= HEALTH_FRESH_MS) {
      return { state: "ready", text: `Ready · checked ${ago(checkedAt, now)}` };
    }
    return {
      state: "stale",
      text: known ? `Stale · last checked ${ago(checkedAt, now)}` : "Stale · not checked recently",
    };
  }
  if (h === "unknown") return { state: "unknown", text: HEALTH_WORDS.unknown! };
  return {
    state: "problem",
    text: known ? `${HEALTH_WORDS[h]} · checked ${ago(checkedAt, now)}` : HEALTH_WORDS[h]!,
  };
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/** "Claude Code + Codex", from provider metadata (never a per-provider switch). */
export function participantsLine(participants: ChatParticipant[]): string {
  const agents = participants.filter((p) => p.kind === "agent");
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of agents) {
    const name = safeLine(p.name, 40);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length ? names.join(" + ") : "No agents yet";
}

const DONE = /^(completed|done|passed|failed|cancelled|blocked|needs_fix|pass)$/i;

/** Working / Needs you / Ready, the same three words as the desktop app. */
export function chatState(chat: Pick<ChatListItem, "needsAttention" | "activeJob">): string {
  if (chat.needsAttention) return "Needs you";
  if (chat.activeJob && !DONE.test(chat.activeJob.status)) return "Working";
  return "Ready";
}

/** Pinned first, then most recent activity. */
export function sortChats(chats: ChatListItem[]): ChatListItem[] {
  return [...chats].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0);
  });
}

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}… ` : s.padEnd(n + 1));

/** The `threadlink chats` table. Never prints ids. */
export function formatChatList(chats: ChatListItem[]): string[] {
  if (!chats.length)
    return ["No chats yet. Start one with: threadlink new --project <P> --mode team"];
  const lines = [`   ${pad("NAME", 28)}${pad("PROJECT", 18)}${pad("MODE", 5)}STATE`];
  for (const c of sortChats(chats)) {
    lines.push(
      `${c.pinned ? " *" : "  "} ${pad(safeLine(c.name, 60), 28)}${pad(safeLine(c.projectName ?? "—", 40), 18)}${pad(modeLabel(c.mode), 5)}${chatState(c)}${c.unread ? " · new" : ""}`,
    );
  }
  return lines;
}

/** "ThreadLink — Prism Review" / "Prism · Team · Claude Code + Codex". */
export function formatHeader(chat: ChatListItem): string[] {
  const sub = [
    chat.projectName ? safeLine(chat.projectName, 60) : null,
    modeLabel(chat.mode),
    participantsLine(chat.participants),
  ].filter(Boolean);
  const lines = [`ThreadLink — ${safeLine(chat.name, 80)}`, sub.join(" · ")];
  if (chat.runtimeLabel) {
    lines.push(
      `Runs on ${safeLine(chat.runtimeLabel, 60)}${chat.runtimeOnline === false ? " · offline" : chat.runtimeOnline ? " · online" : ""}`,
    );
  }
  return lines;
}

/** Who wrote a row: You / the controller / ThreadLink / the agent by provider metadata. */
export function identityOf(
  event: Pick<ChatTimelineEvent, "authorKind" | "authorProvider" | "authorLabel" | "authorRole">,
  participants: ChatParticipant[] = [],
): string {
  if (event.authorKind === "owner") return "You";
  if (event.authorKind === "threadlink") return "ThreadLink";
  if (event.authorKind === "controller") return safeLine(event.authorLabel, 40) || "Controller";
  const meta = participants.find((p) => p.kind === "agent" && p.provider === event.authorProvider);
  const name =
    (meta && safeLine(meta.name, 40)) ||
    safeLine(event.authorLabel, 40) ||
    (event.authorProvider ? `Agent (${event.authorProvider})` : "Agent");
  const role = event.authorRole ? safeLine(event.authorRole, 30) : "";
  return role ? `${name} · ${role}` : name;
}

export function deliveryText(d: ChatDelivery | null): string | null {
  if (!d) return null;
  if (d.state === "sent") return "sent";
  if (d.state === "not_delivered") return "not delivered";
  const who = (d.state === "queued" ? d.for : d.by).map((n) => safeLine(n, 30)).filter(Boolean);
  if (d.state === "queued") return who.length ? `queued for ${who.join(", ")}` : "queued";
  return who.length ? `seen by ${who.join(", ")}` : "seen";
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One timeline row: "[14:02] Codex · reviewer" then the indented body. */
export function formatEvent(
  event: ChatTimelineEvent,
  participants: ChatParticipant[] = [],
): string {
  const who = identityOf(event, participants);
  const delivery = event.authorKind === "owner" ? deliveryText(event.delivery) : null;
  const head = `[${clock(event.createdAt)}] ${who}${delivery ? `  (${delivery})` : ""}`;
  const body = safeBody(event.body);
  return body.trim() ? `${head}\n${body}` : head;
}

/** "… Claude Code · reviewer · reviewing · 3 min" for a run that has not spoken yet. */
export function formatLive(
  run: ChatLiveRun,
  participants: ChatParticipant[] = [],
  now = Date.now(),
): string {
  const meta = participants.find((p) => p.kind === "agent" && p.provider === run.provider);
  const name =
    (meta && safeLine(meta.name, 40)) ||
    (run.providerName && safeLine(run.providerName, 40)) ||
    `Agent (${run.provider})`;
  const parts = [name];
  if (run.role) parts.push(safeLine(run.role, 30));
  parts.push(run.activity ? safeLine(run.activity, 30) : "working");
  if (run.startedAt) parts.push(ago(run.startedAt, now).replace(" ago", ""));
  return `  … ${parts.join(" · ")}`;
}
