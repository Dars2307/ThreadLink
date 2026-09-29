/**
 * The non-interactive terminal chat commands, with I/O injected so they are
 * tested against a fake chat client. cli.ts wires them to the real client
 * (built from the stored Runtime credential) and to stdout.
 */

import type { ChatApi, HostPresence } from "../chat-client.ts";
import { resolveProject } from "./args.ts";
import {
  ago,
  formatChatList,
  freshness,
  modeLabel,
  participantsLine,
  type Freshness,
} from "./format.ts";
import { safeLine } from "./text.ts";

export type Print = (line?: string) => void;

export async function runChats(api: ChatApi, say: Print): Promise<number> {
  const chats = await api.listChats();
  for (const line of formatChatList(chats)) say(line);
  return 0;
}

export async function runNew(
  api: ChatApi,
  input: { project: string | null; mode: "solo" | "pair" | "team" | undefined; name: string },
  say: Print,
): Promise<number> {
  let roomId: string | null = null;
  if (input.project) {
    const projects = api.listProjects ? await api.listProjects().catch(() => []) : [];
    const found = resolveProject(await api.listChats(), input.project, projects);
    if (!found.ok) {
      say(found.error);
      return 1;
    }
    roomId = found.value;
  }
  const chat = await api.createChat({
    name: input.name,
    roomId,
    ...(input.mode ? { mode: input.mode } : {}),
  });
  say(
    `Created “${safeLine(chat.name, 80)}”${chat.projectName ? ` in ${safeLine(chat.projectName, 60)}` : ""} · ${modeLabel(chat.mode)} · ${participantsLine(chat.participants)}`,
  );
  say(`Open it with: threadlink chat "${safeLine(chat.name, 80).replace(/"/g, "'")}"`);
  return 0;
}

// ---------------------------------------------------------------------------
// Agents and status
// ---------------------------------------------------------------------------

/** Display names for the providers this Runtime can report; anything else is named neutrally. */
export const PROVIDER_DISPLAY: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};
export const providerDisplay = (id: string) =>
  PROVIDER_DISPLAY[id] ?? `Agent (${safeLine(id, 40)})`;

export type AgentRow = {
  provider: string;
  installed: boolean | null;
  version: string | null;
  health: string | null;
  checkedAt: string | null;
};

type Row = Record<string, unknown>;
const obj = (v: unknown): Row | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;

/** From the server's provider profiles (what this account's Runtime last reported). */
export function agentRowsFromProfiles(
  profiles: { provider: string; detected: Record<string, unknown>; detectedAt: string | null }[],
): AgentRow[] {
  return profiles.map((p) => {
    const d = obj(p.detected) ?? {};
    return {
      provider: p.provider,
      installed: typeof d.installed === "boolean" ? d.installed : null,
      version: typeof d.version === "string" ? d.version : null,
      health: typeof d.health === "string" ? d.health : null,
      checkedAt: typeof d.healthCheckedAt === "string" ? d.healthCheckedAt : null,
    };
  });
}

/** From a local check (engine.checkProviders()). */
export function agentRowsFromLocal(
  views: {
    provider: string;
    installed: boolean;
    version: string | null;
    health: string;
    healthCheckedAt: string | null;
  }[],
): AgentRow[] {
  return views.map((v) => ({
    provider: v.provider,
    installed: v.installed,
    version: v.version,
    health: v.health,
    checkedAt: v.healthCheckedAt,
  }));
}

export function agentHealth(row: AgentRow, now = Date.now()): Freshness {
  if (row.installed === false && (!row.health || row.health === "unknown"))
    return freshness("not_installed", row.checkedAt, now);
  return freshness(row.health, row.checkedAt, now);
}

/** "Claude Code   Ready · checked 23 s ago   (2.1.266)". */
export function formatAgents(rows: AgentRow[], now = Date.now()): string[] {
  if (!rows.length)
    return ["No agents reported yet. Run `threadlink agents --check` on this computer."];
  return rows.map((r) => {
    const name = providerDisplay(r.provider);
    const version = r.version ? `  (${safeLine(r.version, 40)})` : "";
    return `${name.padEnd(12)} ${agentHealth(r, now).text}${version}`;
  });
}

/** "2 agents ready" / "1 agent working" / "Execution host online" — never "Claude is open". */
export function agentsSummary(rows: AgentRow[], working: number, now = Date.now()): string {
  if (working > 0) return `${working} agent${working === 1 ? "" : "s"} working`;
  const ready = rows.filter((r) => agentHealth(r, now).state === "ready").length;
  if (ready > 0) return `${ready} agent${ready === 1 ? "" : "s"} ready`;
  return "Execution host online";
}

export type StatusInput = {
  runtimeLabel: string;
  platform: string;
  kind: string;
  paused: boolean;
  online: boolean;
  lastHeartbeatAt: string | null;
  version: string;
  protocol: number | null;
  updateRequired: boolean;
  agents: AgentRow[];
  working: number;
  /** 0.11 presence of this computer as the server sees it (§4), when it says. */
  presence?: HostPresence | null;
  /** This terminal's own connection (its request to ThreadLink succeeded). */
  connected?: boolean | null;
};

const PRESENCE_WORD: Record<HostPresence, string> = {
  online: "Online",
  working: "Working",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function formatStatus(s: StatusInput, now = Date.now()): string[] {
  const word = s.presence ? PRESENCE_WORD[s.presence] : s.online ? "Online" : "Offline";
  const lines = [
    `You:            ${s.connected === false ? "Not connected to ThreadLink" : "Connected"}`,
    `Execution host: ${safeLine(s.runtimeLabel, 80)} (${safeLine(s.platform, 20)}, ${safeLine(s.kind, 20)}) · ${word}${
      s.lastHeartbeatAt ? ` · last check-in ${ago(s.lastHeartbeatAt, now)}` : ""
    }${s.paused ? " · paused in ThreadLink" : ""}`,
    `Runtime:        ${safeLine(s.version, 20)}${s.protocol !== null ? ` · protocol ${s.protocol}` : ""}`,
  ];
  if (s.updateRequired)
    lines.push(
      `Update needed:  ThreadLink on ${safeLine(s.runtimeLabel, 60)} needs an update before Team work can start.`,
    );
  lines.push(`Agents:         ${agentsSummary(s.agents, s.working, now)}`);
  for (const l of formatAgents(s.agents, now)) lines.push(`  ${l}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Read-only guard (0.11 §4)
// ---------------------------------------------------------------------------

/**
 * Terminal commands that only read (or, for `new`, create a chat through the
 * chat API). None of them may register this computer as an execution Runtime
 * or send its heartbeat: the desktop app (or `threadlink run`) is the
 * execution host, and a terminal must never re-label or impersonate it.
 */
export const READ_ONLY_COMMANDS = [
  "chats",
  "chat",
  "new",
  "agents",
  "status",
  "sessions",
  "links",
  "approve",
  "decline",
] as const;

export const READ_ONLY_REFUSAL =
  "This command never registers or heartbeats this computer. Use `threadlink run` (or the desktop app) for that.";

/** The engine methods that make this process the execution Runtime. */
export const RUNTIME_ONLY_METHODS = ["register", "heartbeat", "run", "deliverOnce"] as const;

/**
 * Wraps an engine so registering, heartbeating or delivering throws instead
 * of reaching ThreadLink. Every other method (loading workspaces, listing
 * conversations, answering link requests, checking providers) still works.
 */
export function readOnlyEngine<T extends object>(engine: T): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if ((RUNTIME_ONLY_METHODS as readonly (string | symbol)[]).includes(prop)) {
        return () => Promise.reject(new Error(READ_ONLY_REFUSAL));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
