import { humanize } from "./labels";
import { oneLine } from "./safe-text";

/**
 * Search (brief §60, contract §7): the query and filters as the page reads
 * them, and results as it shows them. The server does the owner-scoped search;
 * this only validates inputs and shapes output. Pure.
 */

export const SEARCH_STATUSES = ["working", "needs_you", "finished"] as const;
export const SEARCH_MODES = ["solo", "pair", "team"] as const;

export type SearchQuery = {
  q: string;
  projectId: string | null;
  agent: string | null;
  mode: (typeof SEARCH_MODES)[number] | null;
  status: (typeof SEARCH_STATUSES)[number] | null;
  from: string | null;
  to: string | null;
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSearchQuery(search: Search): SearchQuery {
  const q = oneLine(one(search.q), 100);
  const project = one(search.project);
  const agent = one(search.agent).toLowerCase();
  const mode = one(search.mode);
  const status = one(search.status);
  const from = one(search.from);
  const to = one(search.to);
  return {
    q,
    projectId: /^[A-Za-z0-9_-]{1,80}$/.test(project) ? project : null,
    agent: /^[a-z][a-z0-9-]{1,39}$/.test(agent) ? agent : null,
    mode: (SEARCH_MODES as readonly string[]).includes(mode) ? (mode as SearchQuery["mode"]) : null,
    status: (SEARCH_STATUSES as readonly string[]).includes(status)
      ? (status as SearchQuery["status"])
      : null,
    from: DATE.test(from) ? from : null,
    to: DATE.test(to) ? to : null,
  };
}

/** The chat facts filters need (from the owner's chat list). */
export type SearchChatFacts = {
  chatId: string;
  roomId: string | null;
  projectName: string | null;
  mode: string;
  agents: string[];
  working: boolean;
  needsAttention: boolean;
};

export type SearchResult = {
  key: string;
  href: string;
  chat: string;
  project: string | null;
  kind: string;
  excerpt: string;
  at: string | null;
};

const KIND_LABELS: Record<string, string> = {
  chat: "Chat",
  project: "Project",
  message: "Message",
  finding: "Finding",
  decision: "Decision",
  artifact: "Artifact",
};

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Server rows (ChatSearchResult) → results, with the filters applied here: the
 * server searches text only, the chat list knows each chat's project, agents,
 * mode and status. Rows without a valid chat id, or for a chat not in the
 * owner's list, are dropped. Text is plain.
 */
export function searchResults(
  rows: Record<string, unknown>[],
  query: SearchQuery,
  chats: ReadonlyMap<string, SearchChatFacts> | null,
): SearchResult[] {
  const out: SearchResult[] = [];
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`) : null;
  const to = query.to ? Date.parse(`${query.to}T23:59:59Z`) : null;
  for (const r of rows.slice(0, 100)) {
    const chatId = typeof r.chatId === "string" && ID.test(r.chatId) ? r.chatId : null;
    if (!chatId) continue;
    const facts = chats?.get(chatId) ?? null;
    if (chats && !facts) continue;
    if (query.projectId && facts?.roomId !== query.projectId) continue;
    if (query.agent && !facts?.agents.includes(query.agent)) continue;
    if (query.mode && facts?.mode !== query.mode) continue;
    if (query.status === "working" && !facts?.working) continue;
    if (query.status === "needs_you" && !facts?.needsAttention) continue;
    if (query.status === "finished" && (facts?.working ?? true)) continue;
    const at =
      typeof r.at === "string" ? r.at : typeof r.createdAt === "string" ? r.createdAt : null;
    const t = at ? Date.parse(at) : NaN;
    if ((from !== null || to !== null) && !Number.isFinite(t)) continue;
    if (from !== null && t < from) continue;
    if (to !== null && t > to) continue;
    const kind = typeof r.kind === "string" ? r.kind : "message";
    out.push({
      key: `r${out.length}`,
      href: `/dashboard/chats/${encodeURIComponent(chatId)}`,
      chat: oneLine(r.chatName ?? "Chat", 80),
      project: facts?.projectName ? oneLine(facts.projectName, 60) : null,
      kind: KIND_LABELS[kind] ?? humanize(kind),
      excerpt: oneLine(r.snippet ?? r.excerpt ?? "", 200),
      at,
    });
  }
  return out;
}
