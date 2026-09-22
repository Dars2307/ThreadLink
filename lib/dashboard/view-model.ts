import { PLATFORM_LABELS, type Connection, type ConnectionPlatform } from "@/lib/connections/model";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerSession } from "@/lib/sessions/queries";
import type { FailureReason, TASK_STATUSES } from "@/lib/tasks/model";
import type { RecentTask } from "@/lib/tasks/queries";

/**
 * Pure dashboard derivations (no I/O): setup progress, readiness, labels.
 * Technical IDs are deliberately absent from the primary view model; the
 * Advanced panel renders them separately.
 */

export const BRIDGE_ONLINE_WINDOW_MS = 3 * 60_000;

export type DashboardData = {
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  tasks: RecentTask[];
  now: number;
};

export type StepState = "done" | "current" | "waiting" | "optional" | "todo";
export type SetupStep = {
  key: "chatgpt" | "claude" | "session" | "link";
  title: string;
  state: StepState;
};

const isLive = (c: Connection) => c.status === "active" || c.status === "idle";
const isUsable = (s: OwnerSession) => s.status === "active" || s.status === "idle";

export function bridgeOnline(session: OwnerSession | undefined, now: number): boolean {
  if (!session?.lastSeenAt) return false;
  return now - new Date(session.lastSeenAt).getTime() < BRIDGE_ONLINE_WINDOW_MS;
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function deriveDashboard(data: DashboardData) {
  const live = data.connections.filter(isLive);
  const controllers = live.filter((c) => c.role === "controller");
  const agents = live.filter((c) => c.role === "agent");
  const sessions = data.sessions.filter(isUsable);
  const controllerSessions = sessions.filter((s) => s.role === "controller");
  const agentSessions = sessions.filter((s) => s.role === "agent");
  const activeLinks = data.links.filter((l) => l.status === "active");
  const pendingLinks = data.links.filter((l) => l.status === "pending");
  const sessionById = new Map(data.sessions.map((s) => [s.sessionId, s]));

  const steps: SetupStep[] = [
    { key: "chatgpt", title: "Connect ChatGPT", state: controllers.length ? "done" : "current" },
    {
      key: "claude",
      title: "Connect Claude Code",
      state: agents.length ? "done" : controllers.length ? "current" : "todo",
    },
    {
      key: "session",
      title: "Choose your Claude session",
      state: agentSessions.some((s) => s.nativeSessionMode === "resume")
        ? "done"
        : agentSessions.length
          ? "optional"
          : "todo",
    },
    {
      key: "link",
      title: "Confirm link",
      state: activeLinks.length
        ? "done"
        : pendingLinks.length
          ? "waiting"
          : controllers.length && agents.length
            ? "current"
            : "todo",
    },
  ];
  const setupComplete = steps.every((s) => s.state === "done" || s.state === "optional");

  const links = activeLinks.map((link) => {
    const controller = sessionById.get(link.controllerSessionId);
    const agent = sessionById.get(link.agentSessionId);
    const online = bridgeOnline(agent, data.now);
    return {
      linkId: link.linkId,
      controllerLabel: controller?.displayName ?? link.controllerDisplayName ?? "Conversation",
      controllerApp: PLATFORM_LABELS[controller?.platform ?? "chatgpt"],
      agentLabel: prettyAgentName(agent?.displayName ?? link.agentDisplayName),
      agentDetail:
        agent?.nativeSessionMode === "resume"
          ? "Continues your existing Claude Code session"
          : "Starts a fresh Claude Code session for each task",
      workspace: agent?.workspacePath ? folderName(agent.workspacePath) : null,
      ready: online,
      lastSeen: relativeTime(agent?.lastSeenAt ?? null, data.now),
    };
  });

  const anyBridgeOnline = agentSessions.some((s) => bridgeOnline(s, data.now));
  const headline = !setupComplete
    ? { tone: "warning" as const, text: "Finish setting up ThreadLink" }
    : links.some((l) => l.ready)
      ? { tone: "success" as const, text: "Everything is connected" }
      : { tone: "warning" as const, text: "Connected, but your Claude Code bridge is offline" };

  const appOrder: ConnectionPlatform[] = [
    "chatgpt",
    "claude-desktop",
    "claude-code",
    "generic-mcp",
  ];
  const apps = appOrder
    .filter((p) => p === "chatgpt" || p === "claude-code" || live.some((c) => c.platform === p))
    .map((platform) => {
      const mine = live.filter((c) => c.platform === platform);
      const lastUsed = mine
        .map((c) => c.lastSeenAt)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1);
      const connected = mine.length > 0;
      const detail = !connected
        ? "Not connected"
        : platform === "claude-code"
          ? anyBridgeOnline
            ? "Bridge online"
            : `Bridge offline · last seen ${relativeTime(latestSeen(agentSessions), data.now)}`
          : `Last used ${relativeTime(lastUsed ?? null, data.now)}`;
      return { platform, label: PLATFORM_LABELS[platform], connected, count: mine.length, detail };
    });

  const activity = data.tasks.slice(0, 8).map((t) => {
    const origin = sessionById.get(t.originSessionId);
    return {
      taskId: t.taskId,
      route: `${PLATFORM_LABELS[origin?.platform ?? "chatgpt"]} → Claude Code`,
      title: t.title,
      ...taskStatus(t.status, t.failureReason),
      when: relativeTime(t.finishedAt ?? t.createdAt, data.now),
    };
  });

  return {
    steps,
    setupComplete,
    headline,
    apps,
    links,
    pendingCount: pendingLinks.length,
    controllerSessions,
    agentSessions,
    activity,
  };
}

function latestSeen(sessions: OwnerSession[]): string | null {
  return (
    sessions
      .map((s) => s.lastSeenAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null
  );
}

export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

function prettyAgentName(name: string | null | undefined): string {
  if (!name) return "Claude Code";
  return name.replace(/^Claude Code · /, "") || "Claude Code";
}

const FAILURE_LABELS: Record<FailureReason, string> = {
  session_busy: "Claude session was open elsewhere",
  native_session_unavailable: "Claude session not found",
  lease_exhausted: "Bridge stopped responding",
};

export function taskStatus(
  status: (typeof TASK_STATUSES)[number],
  reason: FailureReason | null,
): { statusLabel: string; tone: "success" | "danger" | "neutral" | "accent" } {
  switch (status) {
    case "completed":
      return { statusLabel: "Completed", tone: "success" };
    case "failed":
      return { statusLabel: reason ? FAILURE_LABELS[reason] : "Failed", tone: "danger" };
    case "cancelled":
      return { statusLabel: "Cancelled", tone: "neutral" };
    case "expired":
      return { statusLabel: "Expired", tone: "neutral" };
    case "queued":
      return { statusLabel: "Waiting for Claude", tone: "accent" };
    default:
      return { statusLabel: "In progress", tone: "accent" };
  }
}
