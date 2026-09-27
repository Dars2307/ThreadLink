/**
 * Argument parsing and chat resolution for the terminal chat commands. Pure:
 * cli.ts hands in what node:util parseArgs produced.
 */

import { CHAT_ID, CHAT_MODES, type ChatListItem, type ChatMode } from "../chat-client.ts";
import { safeLine } from "./text.ts";

export const CHAT_COMMANDS = ["chats", "chat", "new", "agents"] as const;
export type ChatCommandName = (typeof CHAT_COMMANDS)[number];

export type ChatCommand =
  | { command: "chats" }
  | { command: "chat"; query: string }
  | { command: "new"; project: string | null; mode: ChatMode | undefined; name: string }
  | { command: "agents"; check: boolean };

export type ParseResult = { ok: true; value: ChatCommand } | { ok: false; error: string };

export const CHAT_USAGE = `Chats (the same chats as ThreadLink on the web):
  threadlink chats                       list your chats (pinned first)
  threadlink chat "<name>"               open a chat: read, follow and send messages
  threadlink new --project P --mode team [--name N]
                                         start a chat (mode: solo, pair or team)
  threadlink agents [--check]            agents on this computer and their health
  threadlink status                      this Runtime, its host and its agents

In a chat: type a message and press Enter (start with @codex / @claude to
address one agent). /status shows the chat's state, /older loads earlier
messages, /quit leaves (work keeps running).`;

export function isChatCommand(v: unknown): v is ChatCommandName {
  return typeof v === "string" && (CHAT_COMMANDS as readonly string[]).includes(v);
}

export function parseChatCommand(
  command: string,
  positionals: string[],
  values: { project?: string; mode?: string; name?: string; check?: boolean },
): ParseResult {
  if (command === "chats") {
    if (positionals.length > 1) return { ok: false, error: "Usage: threadlink chats" };
    return { ok: true, value: { command: "chats" } };
  }
  if (command === "chat") {
    const query = positionals.slice(1).join(" ").trim();
    if (!query) return { ok: false, error: 'Usage: threadlink chat "<chat name>"' };
    if (query.length > 120) return { ok: false, error: "That chat name is too long." };
    return { ok: true, value: { command: "chat", query } };
  }
  if (command === "new") {
    if (positionals.length > 1)
      return { ok: false, error: "Usage: threadlink new --project P --mode team [--name N]" };
    let mode: ChatMode | undefined;
    if (values.mode !== undefined) {
      const m = values.mode.trim().toLowerCase();
      if (!(CHAT_MODES as readonly string[]).includes(m))
        return { ok: false, error: "--mode must be solo, pair or team." };
      mode = m as ChatMode;
    }
    const project = values.project?.trim() || null;
    if (project && project.length > 100)
      return { ok: false, error: "That project name is too long." };
    const name = (values.name?.trim() || (project ? `${project} chat` : "New chat")).slice(0, 100);
    return { ok: true, value: { command: "new", project, mode, name } };
  }
  if (command === "agents")
    return { ok: true, value: { command: "agents", check: values.check === true } };
  return { ok: false, error: `Unknown command: ${safeLine(command, 40)}` };
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A chat by id, exact name, case-insensitive name, or a unique name prefix.
 * Ambiguity is an error that lists the candidates (names only, never ids).
 */
export function resolveChat(chats: ChatListItem[], query: string): Resolved<ChatListItem> {
  const q = query.trim();
  if (CHAT_ID.test(q)) {
    const byId = chats.find((c) => c.chatId === q);
    return byId ? { ok: true, value: byId } : { ok: false, error: "No chat with that id." };
  }
  const lower = q.toLowerCase();
  const tiers = [
    chats.filter((c) => c.name === q),
    chats.filter((c) => c.name.toLowerCase() === lower),
    chats.filter((c) => c.name.toLowerCase().startsWith(lower)),
    chats.filter((c) => c.name.toLowerCase().includes(lower)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { ok: true, value: tier[0]! };
    if (tier.length > 1) {
      const list = tier
        .slice(0, 8)
        .map(
          (c) =>
            `  - ${safeLine(c.name, 60)}${c.projectName ? ` (${safeLine(c.projectName, 40)})` : ""}`,
        )
        .join("\n");
      return { ok: false, error: `More than one chat matches "${safeLine(q, 60)}":\n${list}` };
    }
  }
  return {
    ok: false,
    error: `No chat matches "${safeLine(q, 60)}". Run \`threadlink chats\` to see them.`,
  };
}

/** A project name to its room id, from the projects the chat list shows. */
export function resolveProject(
  chats: ChatListItem[],
  project: string,
  projects: { roomId: string; name: string }[] = [],
): Resolved<string> {
  const lower = project.trim().toLowerCase();
  const rooms = new Map<string, string>();
  for (const p of projects) rooms.set(p.roomId, p.name);
  for (const c of chats)
    if (c.roomId && c.projectName && !rooms.has(c.roomId)) rooms.set(c.roomId, c.projectName);
  const matches = [...rooms].filter(([, name]) => name.toLowerCase() === lower);
  if (matches.length === 1) return { ok: true, value: matches[0]![0] };
  const known = [...new Set(rooms.values())].map((n) => safeLine(n, 40));
  if (matches.length > 1)
    return { ok: false, error: `More than one project is called "${safeLine(project, 40)}".` };
  return {
    ok: false,
    error: known.length
      ? `No project called "${safeLine(project, 40)}". Projects: ${known.join(", ")}`
      : `No project called "${safeLine(project, 40)}". Create projects in ThreadLink on the web.`,
  };
}
