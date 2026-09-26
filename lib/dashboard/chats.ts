import type {
  ChatGroup,
  ChatSettings,
  ChatSummary,
  JobMode,
  ParticipantView,
  ProviderHealth,
} from "@/lib/chat/types";

import { plural, type Tone } from "./labels";
import type { Handles, JobDetail, PageModel } from "./pages";
import {
  healthCallout,
  participantLines,
  participantsText,
  providerDisplay,
  unhealthyAgents,
  type ParticipantLine,
} from "./providers-display";
import { relativeTime } from "./view-model";

/**
 * Chat-first page models (docs/design/chat-first.md §5, §7). Pure: no I/O.
 *
 * Like every page model, `view` never carries a raw ThreadLink identifier;
 * ids live in `handles` and only reach hidden inputs and hrefs.
 */

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export const MODE_LABELS: Readonly<Record<JobMode, string>> = {
  solo: "Solo",
  pair: "Builder + Reviewer",
  team: "Team",
};

export const MODE_BADGES: Readonly<Record<JobMode, string>> = {
  solo: "SOLO",
  pair: "BUILDER + REVIEWER",
  team: "TEAM",
};

export const MODE_DESCRIPTIONS: Readonly<Record<JobMode, string>> = {
  solo: "One agent builds and checks its own work.",
  pair: "One agent builds, another reviews before it passes.",
  team: "Every agent in the chat plans, builds and reviews each other's work.",
};

const MODES: readonly JobMode[] = ["solo", "pair", "team"];

export function parseMode(v: unknown): JobMode | null {
  return typeof v === "string" && (MODES as readonly string[]).includes(v) ? (v as JobMode) : null;
}

export type ModeControlView = {
  mode: JobMode;
  badge: string;
  summary: string;
  options: { value: JobMode; label: string; description: string; available: boolean }[];
  /** Agent choices for Solo / Builder / Reviewer. "" means Auto. */
  providers: { value: string; label: string }[];
  solo: string;
  builder: string;
  reviewer: string;
  /** Team participants in words. */
  team: string;
  note: string;
};

/**
 * The mode control: Solo (choose provider), Builder + Reviewer (choose each or
 * Auto), Team (shows participants). Choices come from the chat's agents, so an
 * unknown provider appears with its generic name.
 */
export function modeControl(
  settings: ChatSettings,
  participants: ParticipantView[],
): ModeControlView {
  const agents = participants.filter((p) => p.kind === "agent" && p.provider);
  const seen = new Set<string>();
  const providers = [{ value: "", label: "Auto" }];
  for (const a of agents) {
    const d = providerDisplay(a.provider, a.name);
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    providers.push({ value: d.id, label: d.name });
  }
  const pick = (v: string | null) =>
    v && seen.has(providerDisplay(v).id) ? providerDisplay(v).id : "";
  const name = (v: string) => (v ? providerDisplay(v).name : "Auto");
  const solo = pick(settings.soloProvider);
  const builder = pick(settings.builderProvider);
  const reviewer = pick(settings.reviewerProvider);
  const team = participantsText(participants);
  const summary =
    settings.mode === "solo"
      ? `Solo · ${name(solo)}`
      : settings.mode === "pair"
        ? `Builder: ${name(builder)} · Reviewer: ${name(reviewer)}`
        : `Team · ${team}`;
  return {
    mode: settings.mode,
    badge: MODE_BADGES[settings.mode],
    summary,
    options: MODES.map((m) => ({
      value: m,
      label: MODE_LABELS[m],
      description: MODE_DESCRIPTIONS[m],
      available: m === "solo" ? seen.size >= 1 : seen.size >= 2,
    })),
    providers,
    solo,
    builder,
    reviewer,
    team,
    note: "Changing the mode affects future work only. Nothing already said or done changes.",
  };
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

export const CHAT_SHOW = ["all", "attention", "unread", "archived"] as const;
export type ChatShow = (typeof CHAT_SHOW)[number];
export const CHAT_GROUP_BY = ["none", "group", "project"] as const;
export type ChatGroupBy = (typeof CHAT_GROUP_BY)[number];

export type ChatListQuery = {
  q: string;
  mode: JobMode | null;
  /** A group id, or "none" for chats in no group. */
  group: string | null;
  /** A project (room) id, or "none" for chats without a project. */
  project: string | null;
  show: ChatShow;
  by: ChatGroupBy;
};

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const OPAQUE = /^[A-Za-z0-9_-]{1,80}$/;

export function parseChatListQuery(search: Search): ChatListQuery {
  const q = (first(search.q) ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const show = first(search.show);
  const by = first(search.by);
  const group = first(search.group);
  const project = first(search.project);
  return {
    q,
    mode: parseMode(first(search.mode)),
    group: group && OPAQUE.test(group) ? group : null,
    project: project && OPAQUE.test(project) ? project : null,
    show: (CHAT_SHOW as readonly string[]).includes(show ?? "") ? (show as ChatShow) : "all",
    by: (CHAT_GROUP_BY as readonly string[]).includes(by ?? "") ? (by as ChatGroupBy) : "none",
  };
}

/** The chat list URL for a query; defaults are left out. */
export function chatListHref(query: Partial<ChatListQuery>): string {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.mode) p.set("mode", query.mode);
  if (query.group) p.set("group", query.group);
  if (query.project) p.set("project", query.project);
  if (query.show && query.show !== "all") p.set("show", query.show);
  if (query.by && query.by !== "none") p.set("by", query.by);
  const s = p.toString();
  return `/dashboard/chats${s ? `?${s}` : ""}`;
}

export const PREVIEW_MAX = 120;

/** One line of plain text for a list row. Never HTML; markup stays as characters. */
export function previewText(text: string | null | undefined, max = PREVIEW_MAX): string {
  if (!text) return "No messages yet";
  // Control characters (other than whitespace) are dropped; whitespace collapses.
  const t = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "No messages yet";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export type ChatRow = {
  key: string;
  name: string;
  participants: string;
  modeBadge: string;
  mode: JobMode;
  preview: string;
  when: string;
  project: string | null;
  group: string | null;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  needsAttention: boolean;
  working: boolean;
};

export type ChatSection = { key: string; title: string; rows: ChatRow[] };

export type ChatListView = {
  sections: ChatSection[];
  total: number;
  shown: number;
  query: ChatListQuery;
  counts: { attention: number; unread: number; archived: number };
  groups: { key: string; name: string; count: number; active: boolean }[];
  projects: { key: string; name: string; count: number; active: boolean }[];
  /** Choices for the "move to project" and "new chat" pickers. */
  projectChoices: { key: string; name: string }[];
  groupChoices: { key: string; name: string }[];
  emptyText: string;
  filtered: boolean;
};

function matches(c: ChatSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    c.name,
    c.projectName ?? "",
    c.groupName ?? "",
    c.lastMessage ?? "",
    participantsText(c.participants),
  ]
    .join("\n")
    .toLowerCase();
  return needle.split(" ").every((w) => hay.includes(w));
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Pinned first, then most recent activity; the name breaks ties so order is stable. */
export function sortChats<T extends Pick<ChatSummary, "pinned" | "lastActivityAt" | "name">>(
  chats: T[],
): T[] {
  return chats
    .slice()
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        time(b.lastActivityAt) - time(a.lastActivityAt) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The chat list: search, filters (mode, group, project, attention / unread /
 * archived), pinned first, then recent; optional sections by group or project.
 */
export function deriveChatList(
  chats: ChatSummary[],
  groups: ChatGroup[],
  projects: { roomId: string; name: string }[],
  query: ChatListQuery,
  now: number,
): PageModel<ChatListView> {
  const handles: Handles = {};
  const groupKey = new Map<string, string>();
  const projectKey = new Map<string, string>();
  groups.forEach((g, i) => {
    const key = `g${i}`;
    handles[key] = { groupId: g.groupId };
    groupKey.set(g.groupId, key);
  });
  projects.forEach((p, i) => {
    const key = `p${i}`;
    handles[key] = { roomId: p.roomId };
    projectKey.set(p.roomId, key);
  });

  const live = chats.filter((c) => !c.archived);
  const pool = query.show === "archived" ? chats.filter((c) => c.archived) : live;
  const filtered = pool.filter(
    (c) =>
      matches(c, query.q) &&
      (!query.mode || c.mode === query.mode) &&
      (!query.group || (query.group === "none" ? !c.groupId : c.groupId === query.group)) &&
      (!query.project || (query.project === "none" ? !c.roomId : c.roomId === query.project)) &&
      (query.show !== "attention" || c.needsAttention) &&
      (query.show !== "unread" || c.unread),
  );

  const rows = sortChats(filtered).map(
    (c, i): ChatRow & { groupId: string | null; roomId: string | null } => {
      const key = `c${i}`;
      handles[key] = {
        chatId: c.chatId,
        ...(c.roomId ? { roomId: c.roomId } : {}),
        ...(c.groupId ? { groupId: c.groupId } : {}),
      };
      return {
        key,
        name: c.name,
        participants: participantsText(c.participants),
        modeBadge: MODE_BADGES[c.mode] ?? MODE_BADGES.team,
        mode: c.mode,
        preview: previewText(c.lastMessage),
        when: relativeTime(c.lastActivityAt, now),
        project: c.projectName,
        group: c.groupName,
        pinned: c.pinned,
        archived: c.archived,
        unread: c.unread,
        needsAttention: c.needsAttention,
        working: c.activeJob !== null,
        groupId: c.groupId,
        roomId: c.roomId,
      };
    },
  );
  const strip = ({ groupId, roomId, ...row }: (typeof rows)[number]): ChatRow => {
    void groupId;
    void roomId;
    return row;
  };

  const sections: ChatSection[] = [];
  const pinned = rows.filter((r) => r.pinned);
  const rest = query.by === "none" ? rows.filter((r) => !r.pinned) : rows;
  if (query.by === "none") {
    if (pinned.length) sections.push({ key: "pinned", title: "Pinned", rows: pinned.map(strip) });
    if (rest.length) {
      sections.push({
        key: "recent",
        title: pinned.length ? "Recent" : "Chats",
        rows: rest.map(strip),
      });
    }
  } else {
    const buckets = new Map<string, { title: string; rows: ChatRow[] }>();
    const order =
      query.by === "group"
        ? groups.map((g) => [g.groupId, g.name] as const)
        : projects.map((p) => [p.roomId, p.name] as const);
    for (const [id, title] of order) buckets.set(id, { title, rows: [] });
    const none = { title: query.by === "group" ? "No group" : "No project", rows: [] as ChatRow[] };
    for (const r of rest) {
      const id = query.by === "group" ? r.groupId : r.roomId;
      (id && buckets.get(id) ? buckets.get(id)! : none).rows.push(strip(r));
    }
    let i = 0;
    for (const b of [...buckets.values(), none]) {
      if (b.rows.length) sections.push({ key: `s${i++}`, title: b.title, rows: b.rows });
    }
  }

  const isFiltered =
    Boolean(query.q || query.mode || query.group || query.project) || query.show !== "all";
  return {
    view: {
      sections,
      total: live.length,
      shown: rows.length,
      query,
      counts: {
        attention: live.filter((c) => c.needsAttention).length,
        unread: live.filter((c) => c.unread).length,
        archived: chats.length - live.length,
      },
      groups: groups.map((g) => ({
        key: groupKey.get(g.groupId)!,
        name: g.name,
        count: live.filter((c) => c.groupId === g.groupId).length,
        active: query.group === g.groupId,
      })),
      projects: projects.map((p) => ({
        key: projectKey.get(p.roomId)!,
        name: p.name,
        count: live.filter((c) => c.roomId === p.roomId).length,
        active: query.project === p.roomId,
      })),
      projectChoices: projects.map((p) => ({ key: projectKey.get(p.roomId)!, name: p.name })),
      groupChoices: groups.map((g) => ({ key: groupKey.get(g.groupId)!, name: g.name })),
      emptyText: isFiltered
        ? "No chats match. Clear the filters to see every chat."
        : query.show === "archived"
          ? "No archived chats."
          : "No chats yet. Start one with New chat: talk to one agent, two, or the whole team.",
      filtered: isFiltered,
    },
    handles,
  };
}

// ---------------------------------------------------------------------------
// One chat: header, health, retry
// ---------------------------------------------------------------------------

export const CHAT_TABS = ["chat", "progress", "details"] as const;
export type ChatTab = (typeof CHAT_TABS)[number];
export const CHAT_TAB_LABELS: Readonly<Record<ChatTab, string>> = {
  chat: "Chat",
  progress: "Progress",
  details: "Details",
};

export function parseChatTab(v: string | string[] | undefined): ChatTab {
  const t = first(v);
  return (CHAT_TABS as readonly string[]).includes(t ?? "") ? (t as ChatTab) : "chat";
}

export function chatHref(
  chatId: string,
  opts: { tab?: ChatTab; job?: string | null; extra?: Search } = {},
): string {
  const q = new URLSearchParams();
  if (opts.tab && opts.tab !== "chat") q.set("tab", opts.tab);
  if (opts.job) q.set("job", opts.job);
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  return `/dashboard/chats/${encodeURIComponent(chatId)}${s ? `?${s}` : ""}`;
}

export const NO_PROJECT_TEXT = "No project — choose one so agents know which folder to use";

export type ChatHeaderView = {
  name: string;
  modeBadge: string;
  project: string | null;
  projectText: string;
  participants: ParticipantLine[];
  /** Fixed-text instructions for agents that need the user. */
  callouts: { key: string; text: string }[];
  archived: boolean;
};

export function chatHeader(chat: ChatSummary): ChatHeaderView {
  return {
    name: chat.name,
    modeBadge: MODE_BADGES[chat.mode] ?? MODE_BADGES.team,
    project: chat.projectName,
    projectText: chat.projectName ? `Project: ${chat.projectName}` : NO_PROJECT_TEXT,
    participants: participantLines(chat.participants),
    callouts: unhealthyAgents(chat.participants)
      .filter((a) => a.callout)
      .map((a, i) => ({ key: `h${i}`, text: a.callout! })),
    archived: chat.archived,
  };
}

/** Verdict reasons that mean a provider could not be used (§2). */
const PROVIDER_REASONS: Readonly<Record<string, ProviderHealth>> = {
  agent_needs_sign_in: "needs_sign_in",
  api_key_auth: "api_key_auth",
  usage_exhausted: "usage_exhausted",
};

type BlockedJob = Pick<JobDetail, "status" | "verdict" | "nodes" | "finished"> &
  Pick<JobDetail, "verdictReason" | "verdictProvider" | "planPersisted" | "planApproved">;

/**
 * The provider a blocked job names. The server's `verdictProvider` wins; else
 * the one participant whose health matches the reason. Never a guess between two.
 */
function blockedProvider(job: BlockedJob, participants: ParticipantView[]): string | null {
  if (job.verdictProvider) return providerDisplay(job.verdictProvider).id;
  const health = job.verdictReason ? PROVIDER_REASONS[job.verdictReason] : undefined;
  const match = participants.filter((p) => p.kind === "agent" && p.health === health && p.provider);
  return match.length === 1 ? providerDisplay(match[0]!.provider).id : null;
}

const isBlocked = (job: BlockedJob) => job.status === "blocked" || job.verdict === "BLOCKED";

/**
 * The callout for a job blocked on a provider's sign-in / usage / API key, in
 * fixed words. Null for any other job.
 */
export function blockedCallout(job: BlockedJob, participants: ParticipantView[]): string | null {
  if (!isBlocked(job) || !job.verdictReason) return null;
  const health = PROVIDER_REASONS[job.verdictReason];
  if (!health) return null;
  const provider = blockedProvider(job, participants);
  if (provider) return healthCallout(provider, health);
  return health === "needs_sign_in"
    ? "An agent needs you to sign in again on this computer. Sign in to it again, then press Check again on the ThreadLink app."
    : null;
}

export type RetryOption = { provider: string; label: string; confirm: string };

/**
 * "Retry with Codex as coordinator": only for a BLOCKED job that stopped
 * before any plan was persisted, and only with another participant that is
 * Ready right now. An explicit owner action; never automatic.
 */
export function retryOption(job: BlockedJob, participants: ParticipantView[]): RetryOption | null {
  if (!isBlocked(job) || !job.finished) return null;
  // Real work happened once a plan exists (or units were made from one).
  if (job.planPersisted === true || job.nodes.length > 0) return null;
  const blocked = blockedProvider(job, participants);
  if (!blocked || !job.verdictReason || !PROVIDER_REASONS[job.verdictReason]) return null;
  const ready = participants.find(
    (p) =>
      p.kind === "agent" &&
      p.provider &&
      p.health === "ready" &&
      providerDisplay(p.provider).id !== blocked &&
      providerDisplay(p.provider).supported,
  );
  if (!ready) return null;
  const d = providerDisplay(ready.provider, ready.name);
  return {
    provider: d.id,
    label: `Retry with ${d.name} as coordinator`,
    confirm: `This starts the same request again as new work in this chat, with ${d.name} coordinating. ${providerDisplay(blocked).name} is not used for coordinating it. Nothing from the blocked attempt is lost.`,
  };
}

// ---------------------------------------------------------------------------
// Redirects for old addresses (§7). Pure so they can be tested.
// ---------------------------------------------------------------------------

export const TEAM_REDIRECT = "/dashboard/chats?mode=team";
export const CONVERSATIONS_REDIRECT = "/dashboard/agents";

/**
 * A project's default chat: the one the server marks as the room's default;
 * otherwise (older server) the chat in that project named like it, else its
 * most recent chat. Null when the project has none.
 */
export function defaultChatFor(
  roomId: string,
  roomName: string | null,
  chats: (Pick<ChatSummary, "chatId" | "roomId" | "name" | "lastActivityAt" | "archived"> & {
    isRoomDefault?: boolean;
  })[],
): string | null {
  const mine = chats.filter((c) => c.roomId === roomId);
  const marked = mine.find((c) => c.isRoomDefault === true);
  if (marked) return marked.chatId;
  const named = roomName ? mine.find((c) => c.name === roomName && !c.archived) : undefined;
  if (named) return named.chatId;
  const recent = mine
    .filter((c) => !c.archived)
    .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))[0];
  return recent?.chatId ?? null;
}

const KEEP_PAGES = ["f", "d", "m"] as const;

/** Page numbers from the old log address, kept only when they are small numbers. */
export function keepLogPages(search: Search): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const k of KEEP_PAGES) {
    const v = first(search[k]);
    if (typeof v === "string" && /^\d{1,4}$/.test(v)) keep[k] = v;
  }
  return keep;
}

/** /dashboard/team/[jobId] → the job's chat, Progress tab; else its project; else null (404). */
export function jobRedirect(
  jobId: string,
  where: { chatId: string | null; roomId: string | null },
  search: Search = {},
): string | null {
  if (where.chatId) {
    return chatHref(where.chatId, { tab: "progress", job: jobId, extra: keepLogPages(search) });
  }
  if (where.roomId) return `/dashboard/projects/${encodeURIComponent(where.roomId)}`;
  return null;
}

/**
 * /dashboard/projects/[roomId]?tab=… (0.8 tabs) → the project's default chat,
 * same tab and job. Null when there is no tab to honour or no chat to go to.
 */
export function projectTabRedirect(search: Search, defaultChatId: string | null): string | null {
  const tab = first(search.tab);
  if (!tab || !(CHAT_TABS as readonly string[]).includes(tab) || !defaultChatId) return null;
  const job = first(search.job);
  return chatHref(defaultChatId, {
    tab: tab as ChatTab,
    job: job && OPAQUE.test(job) ? job : null,
    extra: keepLogPages(search),
  });
}

// ---------------------------------------------------------------------------
// Home and projects
// ---------------------------------------------------------------------------

export type HomeChatsView = {
  recent: ChatRow[];
  attention: ChatRow[];
  total: number;
};

/** Pinned and recent chats plus those that need the user, for Home. */
export function homeChats(chats: ChatSummary[], now: number): PageModel<HomeChatsView> {
  const { view, handles } = deriveChatList(chats, [], [], parseChatListQuery({}), now);
  const rows = view.sections.flatMap((s) => s.rows);
  return {
    view: {
      recent: rows.slice(0, 6),
      attention: rows.filter((r) => r.needsAttention).slice(0, 5),
      total: view.total,
    },
    handles,
  };
}

/** "3 chats" per project, counting only chats that are not archived. */
export function chatCounts(chats: Pick<ChatSummary, "roomId" | "archived">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of chats) {
    if (c.archived || !c.roomId) continue;
    counts.set(c.roomId, (counts.get(c.roomId) ?? 0) + 1);
  }
  return counts;
}

export function chatCountText(n: number | undefined): string {
  return n ? plural(n, "chat") : "No chats yet";
}

export const MODE_TONE: Readonly<Record<JobMode, Tone>> = {
  solo: "neutral",
  pair: "accent",
  team: "accent",
};

// ---------------------------------------------------------------------------
// Details tab (the one place in a chat that shows technical identifiers)
// ---------------------------------------------------------------------------

export type ChatTechnical = {
  ids: { key: string; label: string; value: string }[];
  timings: { key: string; label: string; value: string }[];
  models: {
    key: string;
    who: string;
    model: string;
    effort: string | null;
    outcome: string;
    why: string;
  }[];
  routing: { key: string; label: string; text: string }[];
};

export function chatTechnical(
  chat: Pick<ChatSummary, "chatId" | "roomId">,
  jobs: { jobId: string; goal: string; startedAt: string; finishedAt: string | null }[],
  detail: (JobDetail & { worktrees?: unknown }) | null,
  labels: {
    model: (id: string | null) => string;
    effort: (e: string | null | undefined) => string | null;
    role: (r: string) => string;
    provider: (p: string) => string;
    outcome: (o: string) => string;
  },
): ChatTechnical {
  const ids = [{ key: "chat", label: "Chat", value: chat.chatId }];
  if (chat.roomId) ids.push({ key: "room", label: "Project (room)", value: chat.roomId });
  jobs
    .slice(0, 20)
    .forEach((j, i) =>
      ids.push({ key: `j${i}`, label: `Job · ${j.goal.slice(0, 60)}`, value: j.jobId }),
    );
  for (const [i, n] of (detail?.nodes ?? []).entries()) {
    ids.push({ key: `u${i}`, label: `Unit · ${n.title}`, value: n.key });
  }
  const timings = detail
    ? [
        { key: "start", label: "Started", value: detail.startedAt },
        { key: "end", label: "Finished", value: detail.finishedAt ?? "Still running" },
        ...(detail.lastPhase
          ? [{ key: "phase", label: "Last stage reached", value: detail.lastPhase }]
          : []),
        ...(detail.verdictReason
          ? [{ key: "reason", label: "Reason", value: detail.verdictReason }]
          : []),
      ]
    : [];
  const models = (detail?.modelRuns ?? []).map((r, i) => ({
    key: `m${i}`,
    who: `${labels.role(r.role)} · ${labels.provider(r.provider)}`,
    model: r.observed
      ? r.observed === r.requested
        ? labels.model(r.observed)
        : `Asked for ${labels.model(r.requested)}, ${labels.model(r.observed)} ran`
      : `${labels.model(r.requested)} (requested)`,
    effort: labels.effort(r.effort),
    outcome: labels.outcome(r.outcome),
    why: r.reason,
  }));
  const routing = [
    ...(detail?.decisions ?? []).map((d, i) => ({
      key: `d${i}`,
      label: d.label,
      text: `${d.title}${d.resolution ? ` — ${d.resolution}` : d.needsYou ? " — waiting for you" : ""}`,
    })),
  ];
  return { ids, timings, models, routing };
}
