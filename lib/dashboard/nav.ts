import type { ChatSummary } from "@/lib/chat/types";

import { MODE_BADGES, sortChats } from "./chats";

/**
 * Sidebar organisation (brief §60): Pinned · Projects (with their chats) ·
 * Groups · Recent. Pure. Keyboard shortcuts live in ./shortcuts (client-safe).
 */

export type NavChat = {
  key: string;
  name: string;
  href: string;
  modeBadge: string;
  unread: boolean;
  needsAttention: boolean;
  working: boolean;
};

export type NavFolder = {
  key: string;
  name: string;
  href: string | null;
  chats: NavChat[];
  more: number;
};

export type ChatNav = {
  pinned: NavChat[];
  projects: NavFolder[];
  groups: NavFolder[];
  recent: NavChat[];
  /** Every chat href in display order (for Alt+↑/↓). */
  order: string[];
  total: number;
};

const PER_FOLDER = 5;
const RECENT = 8;

export function chatNav(chats: ChatSummary[]): ChatNav {
  const live = sortChats(chats.filter((c) => !c.archived));
  const toNav = (c: ChatSummary, i: number, prefix: string): NavChat => ({
    key: `${prefix}${i}`,
    name: c.name.slice(0, 80),
    href: `/dashboard/chats/${encodeURIComponent(c.chatId)}`,
    modeBadge: MODE_BADGES[c.mode] ?? MODE_BADGES.team,
    unread: c.unread,
    needsAttention: c.needsAttention,
    working: c.activeJob !== null,
  });
  const pinned = live
    .filter((c) => c.pinned)
    .slice(0, 12)
    .map((c, i) => toNav(c, i, "pn"));

  const folders = (
    key: (c: ChatSummary) => string | null,
    name: (c: ChatSummary) => string,
    href: (id: string) => string | null,
    prefix: string,
  ) => {
    const map = new Map<string, { name: string; chats: ChatSummary[] }>();
    for (const c of live) {
      const k = key(c);
      if (!k) continue;
      const f = map.get(k) ?? { name: name(c), chats: [] };
      f.chats.push(c);
      map.set(k, f);
    }
    return [...map.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([id, f], i): NavFolder => ({
        key: `${prefix}${i}`,
        name: f.name.slice(0, 60),
        href: href(id),
        chats: f.chats.slice(0, PER_FOLDER).map((c, j) => toNav(c, j, `${prefix}${i}c`)),
        more: Math.max(0, f.chats.length - PER_FOLDER),
      }));
  };

  const projects = folders(
    (c) => c.roomId,
    (c) => c.projectName ?? "Project",
    (id) => `/dashboard/projects/${encodeURIComponent(id)}`,
    "pj",
  );
  const groups = folders(
    (c) => c.groupId,
    (c) => c.groupName ?? "Group",
    (id) => `/dashboard/chats?group=${encodeURIComponent(id)}`,
    "gr",
  );
  const recent = [...live]
    .filter((c) => !c.pinned)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, RECENT)
    .map((c, i) => toNav(c, i, "rc"));

  const order: string[] = [];
  const push = (h: string) => {
    if (!order.includes(h)) order.push(h);
  };
  pinned.forEach((c) => push(c.href));
  projects.forEach((f) => f.chats.forEach((c) => push(c.href)));
  groups.forEach((f) => f.chats.forEach((c) => push(c.href)));
  recent.forEach((c) => push(c.href));
  return { pinned, projects, groups, recent, order, total: live.length };
}
