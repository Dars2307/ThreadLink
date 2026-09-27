import type { ChatSummary } from "@/lib/chat/types";

import { MODE_BADGES, NO_PROJECT_TEXT } from "./chats";
import { healthCallout } from "./providers-display";
import { registryEntry, type Registry } from "./registry";
import { healthFreshness, hostView, type Freshness, type HostView } from "./timeline";

/**
 * The 0.10 chat header (brief §7): name, mode, project, "Runs on <host> ·
 * Online/Offline", and each agent with ONE freshness calculation — an agent
 * is never shown "Ready" beside a stale check. Pure; no ids in the view.
 */

export type HeaderAgent = { key: string; name: string; tone: string; freshness: Freshness };

export type ChatHeader10 = {
  name: string;
  modeBadge: string;
  project: string | null;
  projectText: string;
  host: HostView | null;
  agents: HeaderAgent[];
  callouts: { key: string; text: string }[];
  archived: boolean;
  /** "Nickron's PC is offline. Work continues when it reconnects." */
  offlineNote: string | null;
};

export function chatHeader10(
  chat: ChatSummary,
  opts: {
    registry: Registry;
    checkedAt: Record<string, string | null>;
    host: {
      label: string | null;
      online: boolean | null;
      lastSeenAt: string | null;
      working: boolean;
      protocolOutdated: boolean;
    } | null;
    now: number;
  },
): ChatHeader10 {
  const seen = new Set<string>();
  const agents: HeaderAgent[] = [];
  const callouts: { key: string; text: string }[] = [];
  for (const p of chat.participants) {
    if (p.kind !== "agent" || !p.provider) continue;
    const entry = registryEntry(opts.registry, p.provider, p.name);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const freshness = healthFreshness(p.health, opts.checkedAt[p.provider] ?? null, opts.now);
    agents.push({ key: `a${agents.length}`, name: entry.name, tone: entry.tone, freshness });
    const callout = freshness.state === "attention" ? healthCallout(entry.id, p.health) : null;
    if (callout) callouts.push({ key: `c${callouts.length}`, text: callout });
  }
  const host = hostView(opts.host, opts.now);
  if (host?.outdated) callouts.push({ key: "outdated", text: host.outdated });
  return {
    name: chat.name,
    modeBadge: MODE_BADGES[chat.mode] ?? MODE_BADGES.team,
    project: chat.projectName,
    projectText: chat.projectName ? `Project: ${chat.projectName}` : NO_PROJECT_TEXT,
    host,
    agents,
    callouts,
    archived: chat.archived,
    offlineNote:
      host && host.state === "offline"
        ? `${host.label} is offline. Work continues when it reconnects.`
        : null,
  };
}
