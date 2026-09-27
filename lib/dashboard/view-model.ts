import { PLATFORM_LABELS, type Connection, type ConnectionPlatform } from "@/lib/connections/model";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { runtimeOnline, type OwnerRuntime, type OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import type { FailureReason, TASK_STATUSES } from "@/lib/tasks/model";
import type { RecentTask } from "@/lib/tasks/queries";

/**
 * Pure dashboard derivations (no I/O): setup progress, readiness, plain-language
 * labels. Technical identifiers are deliberately absent; the Advanced page
 * renders those separately.
 */

export const BRIDGE_ONLINE_WINDOW_MS = 3 * 60_000;

export type DashboardData = {
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  tasks: RecentTask[];
  runtimes?: OwnerRuntime[];
  workspaces?: OwnerWorkspace[];
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

export type ExecutionMode = "worker" | "resume" | "fresh";

/**
 * How empty states refer to the app that sends work, without assuming it is
 * ChatGPT: any MCP client (ChatGPT, Claude, …) can be the controller.
 */
export const CONTROLLER_HINT = "your controller (for example ChatGPT)";

/**
 * The connected controller's name when there is exactly one kind connected
 * ("ChatGPT", "Claude"), otherwise the generic hint.
 */
export function controllerName(
  connections: Pick<Connection, "platform" | "role" | "status">[],
): string {
  const platforms = new Set(
    connections
      .filter((c) => c.role === "controller" && (c.status === "active" || c.status === "idle"))
      .map((c) => c.platform),
  );
  if (platforms.size !== 1) return CONTROLLER_HINT;
  const [only] = platforms;
  return only === "generic-mcp" ? "your controller" : PLATFORM_LABELS[only!];
}

export function executionMode(session: OwnerSession | undefined): ExecutionMode {
  if (session?.nativeSessionMode === "worker") return "worker";
  if (session?.nativeSessionMode === "resume") return "resume";
  return "fresh";
}

/** The short name for a mode: what a card shows under the conversation title. */
export function executionModeLabel(session: OwnerSession | undefined): string {
  const mode = executionMode(session);
  if (mode === "worker") return "Background worker";
  if (mode === "resume") return "Exact conversation";
  return "New headless session (doesn't open a window)";
}

/** One line explaining what that mode actually does. */
export function conversationMode(session: OwnerSession | undefined): string {
  const mode = executionMode(session);
  if (mode === "worker") return "Works while Claude Code is open";
  if (mode === "resume") return "Resumes this exact conversation, which must not be open";
  return "Starts a new Claude Code session in the background for each request; no window opens";
}

export function conversationName(
  session: OwnerSession | undefined,
  fallback: string | null,
): string {
  const name = session?.displayName ?? fallback;
  if (!name) return "Claude conversation";
  return name.replace(/^Claude Code · /, "") || "Claude conversation";
}

export type LinkCard = {
  linkId: string;
  chat: string;
  chatApp: string;
  controllerSessionId: string;
  conversation: string;
  conversationDetail: string;
  mode: ExecutionMode;
  modeLabel: string;
  agentSessionId: string;
  workspace: string | null;
  runtime: string | null;
  runtimeOnline: boolean;
  busy: boolean;
  paused: boolean;
  status: "ready" | "busy" | "paused" | "offline";
  statusLabel: string;
};

/** One task in an activity list. Metadata only: never prompt or result content. */
export type ActivityItem = {
  taskId: string;
  title: string;
  statusLabel: string;
  tone: "success" | "danger" | "neutral" | "accent";
  when: string;
  linkId: string | null;
};

/**
 * Recent tasks grouped under the link (chat ↔ Claude conversation) they ran
 * against, so a background worker's work is still attributed to the Claude
 * conversation and workspace the user can actually see.
 */
export type LinkActivity = {
  linkId: string;
  chat: string;
  chatApp: string;
  conversation: string;
  conversationDetail: string;
  workspace: string | null;
  runtime: string | null;
  mode: ExecutionMode;
  modeLabel: string;
  /** One line naming the mode and the visible Claude conversation it belongs to. */
  attribution: string;
  status: LinkCard["status"];
  statusLabel: string;
  tasks: ActivityItem[];
  taskCount: number;
  lastRun: string | null;
  emptyHint: string;
};

const EMPTY_ACTIVITY: Record<ExecutionMode, string> = {
  worker: "Nothing has run in this background worker yet.",
  resume: "Nothing has run in this Claude conversation yet.",
  fresh: "Nothing has been sent to this link yet.",
};

function attributionLine(card: LinkCard): string {
  const where = card.workspace ? `${card.conversation} · ${card.workspace}` : card.conversation;
  if (card.mode === "worker") return `Background worker for ${where}`;
  if (card.mode === "resume") return `Runs in ${where}`;
  return `New headless session each time, alongside ${where}`;
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
  const runtimes = data.runtimes ?? [];
  const workspaces = data.workspaces ?? [];
  const runtimeById = new Map(runtimes.map((r) => [r.runtimeId, r]));
  const workspaceById = new Map(workspaces.map((w) => [w.workspaceId, w]));
  const activeRuntimes = runtimes.filter((r) => r.status === "active");

  const steps: SetupStep[] = [
    { key: "chatgpt", title: "Connect ChatGPT", state: controllers.length ? "done" : "current" },
    {
      key: "claude",
      title: "Install the ThreadLink app",
      state: agents.length ? "done" : controllers.length ? "current" : "todo",
    },
    {
      key: "session",
      title: "Choose your Claude conversation",
      state: agentSessions.some((s) => s.nativeSessionMode === "resume")
        ? "done"
        : agentSessions.length
          ? "optional"
          : "todo",
    },
    {
      key: "link",
      title: "Confirm the link",
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

  const links: LinkCard[] = activeLinks.map((link) => {
    const controller = sessionById.get(link.controllerSessionId);
    const agent = sessionById.get(link.agentSessionId);
    const runtime = agent?.runtimeId ? runtimeById.get(agent.runtimeId) : undefined;
    const online = runtime ? runtimeOnline(runtime, data.now) : bridgeOnline(agent, data.now);
    // Only an exact-conversation link can be blocked by the user's own Claude
    // conversation being open. A background worker runs alongside it.
    const busy = Boolean(agent?.busy) && executionMode(agent) === "resume";
    const paused = Boolean(link.paused) || Boolean(runtime?.paused);
    const status = paused ? "paused" : !online ? "offline" : busy ? "busy" : "ready";
    return {
      linkId: link.linkId,
      chat: controller?.displayName ?? link.controllerDisplayName ?? "Conversation",
      chatApp: PLATFORM_LABELS[controller?.platform ?? "chatgpt"],
      controllerSessionId: link.controllerSessionId,
      conversation: conversationName(agent, link.agentDisplayName),
      conversationDetail: conversationMode(agent),
      mode: executionMode(agent),
      modeLabel: executionModeLabel(agent),
      agentSessionId: link.agentSessionId,
      workspace: agent?.workspaceId ? (workspaceById.get(agent.workspaceId)?.name ?? null) : null,
      runtime: runtime?.label ?? null,
      runtimeOnline: online,
      busy,
      paused,
      status,
      statusLabel:
        status === "ready"
          ? "Ready"
          : status === "busy"
            ? "Claude is currently open"
            : status === "paused"
              ? "Paused"
              : "Runtime offline",
    };
  });

  const onlineRuntimes = activeRuntimes.filter((r) => runtimeOnline(r, data.now));
  const anyRuntimeOnline = onlineRuntimes.length > 0;
  const headline = !setupComplete
    ? { tone: "warning" as const, text: "Finish setting up ThreadLink" }
    : // A busy exact conversation is that link's own status (Agents → Claude Code),
      // never a global "Claude is open" headline (brief §64).
      links.some((l) => l.status === "ready" || l.status === "busy")
      ? { tone: "success" as const, text: "Everything is connected" }
      : { tone: "warning" as const, text: "Connected, but no Runtime is online" };

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
          ? anyRuntimeOnline
            ? `${onlineRuntimes.length} of ${activeRuntimes.length} Runtime${activeRuntimes.length === 1 ? "" : "s"} online`
            : "No Runtime online"
          : `Last used ${relativeTime(lastUsed ?? null, data.now)}`;
      return {
        platform,
        label: platform === "claude-code" ? "ThreadLink app (Runtime)" : PLATFORM_LABELS[platform],
        connected,
        count: mine.length,
        detail,
      };
    });

  // A task belongs to a link only when BOTH ends match: the chat it came from
  // and the Claude conversation it ran against. Matching the agent session
  // alone would let another chat's (or another link's) work show up here.
  const linkIdByRoute = new Map<string, string>();
  for (const l of activeLinks) {
    linkIdByRoute.set(`${l.controllerSessionId}\u0000${l.agentSessionId}`, l.linkId);
  }
  const linkIdForTask = (t: RecentTask): string | null =>
    linkIdByRoute.get(`${t.originSessionId}\u0000${t.targetSessionId}`) ?? null;

  const taskTime = (t: RecentTask) => new Date(t.finishedAt ?? t.createdAt).getTime();

  const activity = data.tasks.map((t) => {
    const origin = sessionById.get(t.originSessionId);
    const target = sessionById.get(t.targetSessionId);
    return {
      taskId: t.taskId,
      route: `${PLATFORM_LABELS[origin?.platform ?? "chatgpt"]} → ${conversationName(target, null)}`,
      title: t.title,
      ...taskStatus(t.status, t.failureReason),
      when: relativeTime(t.finishedAt ?? t.createdAt, data.now),
      linkId: linkIdForTask(t),
    };
  });

  /** Recent tasks grouped under the link / Claude conversation they ran against. */
  const linkActivity: LinkActivity[] = links.map((card) => {
    const mine = data.tasks
      .filter((t) => linkIdForTask(t) === card.linkId)
      .slice()
      .sort((a, b) => taskTime(b) - taskTime(a));
    const tasks: ActivityItem[] = mine.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      ...taskStatus(t.status, t.failureReason),
      when: relativeTime(t.finishedAt ?? t.createdAt, data.now),
      linkId: card.linkId,
    }));
    return {
      linkId: card.linkId,
      chat: card.chat,
      chatApp: card.chatApp,
      conversation: card.conversation,
      conversationDetail: card.conversationDetail,
      workspace: card.workspace,
      runtime: card.runtime,
      mode: card.mode,
      modeLabel: card.modeLabel,
      attribution: attributionLine(card),
      status: card.status,
      statusLabel: card.statusLabel,
      tasks,
      taskCount: tasks.length,
      lastRun: mine[0] ? relativeTime(mine[0].finishedAt ?? mine[0].createdAt, data.now) : null,
      emptyHint: EMPTY_ACTIVITY[card.mode],
    };
  });

  /** Runtimes with their workspaces and conversations, for the Runtimes page. */
  const runtimeTree = activeRuntimes.map((runtime) => ({
    ...runtime,
    online: runtimeOnline(runtime, data.now),
    lastSeen: relativeTime(runtime.lastSeenAt, data.now),
    claudeAvailable: runtime.capabilities["claude-code"] === "available",
    workspaces: workspaces
      .filter((w) => w.runtimeId === runtime.runtimeId)
      .map((w) => ({
        ...w,
        conversations: agentSessions
          .filter((s) => s.workspaceId === w.workspaceId)
          .map((s) => ({
            sessionId: s.sessionId,
            name: conversationName(s, null),
            detail: conversationMode(s),
            busy: s.busy,
            linked: activeLinks.some((l) => l.agentSessionId === s.sessionId),
          })),
      })),
  }));

  return {
    steps,
    setupComplete,
    headline,
    apps,
    links,
    pendingLinks,
    pendingCount: pendingLinks.length,
    controllerSessions,
    agentSessions,
    activity,
    linkActivity,
    runtimeTree,
    anyRuntimeOnline,
  };
}

export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

const FAILURE_LABELS: Record<FailureReason, string> = {
  session_busy: "Claude conversation was in use",
  native_session_unavailable: "Claude conversation not found",
  background_mode_unsupported: "This agent cannot work in the background",
  lease_exhausted: "Runtime stopped responding",
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
