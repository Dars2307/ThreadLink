import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ChatApiError,
  controllerChatStatus,
  controllerJobResult,
  createControllerChat,
  getControllerChat,
  listControllerChats,
  postControllerChatMessage,
  type ChatApiEvent,
  type ChatApiSummary,
} from "@/lib/client-api/chats";
import { listAgentSessions } from "@/lib/client-api/native";
import {
  ClientOperationError,
  listSessionLinks,
  registerSession,
  requestPairing,
  type ClientDatabase,
} from "@/lib/client-api/operations";
import {
  acknowledgeTaskResult,
  createTask,
  getTask,
  getTaskResult,
  listOriginTasks,
} from "@/lib/client-api/tasks";
import type { ConnectionIdentity } from "@/lib/connections/authenticate";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { LOCAL_BINDING_REF_PATTERN } from "@/lib/sessions/model";
import { PRIORITY_PATTERN } from "@/lib/tasks/model";
import {
  createChatTask,
  createRoom,
  getRoom,
  getTeamLog,
  getTeamStatus,
  listRooms,
  ProviderUnhealthyError,
  startTeamJob,
} from "@/lib/team/client-api";
import {
  AGENT_PROVIDERS,
  controllerSpecSchema,
  JOB_MODES,
  TEAM_LIMITS,
  TEAM_SIZE_LIMITS,
  type RoomView,
  type TeamStatus,
} from "@/lib/team/model";

/**
 * ThreadLink MCP tools. Each tool is one narrow operation on the existing
 * connection-authenticated client API; there is no generic passthrough.
 *
 * Session binding: ChatGPT exposes no verified per-conversation ID to MCP, so
 * `ensure_session` issues a random `sessionRef` (a local binding ref) and a
 * `tlses_` ID that the model carries within its conversation. Every other tool
 * REQUIRES `sessionId`; the database verifies it belongs to this connection.
 * There is no silent default session shared across conversations.
 */

export type McpContext = {
  db: ClientDatabase;
  credentialHash: string;
  identity: ConnectionIdentity;
};

export const sessionIdInput = z
  .string()
  .regex(/^tlses_[0-9a-f]{32}$/)
  .describe("The tlses_ sessionId returned by ensure_session earlier in THIS conversation.");

const roomIdInput = z
  .string()
  .regex(/^tlrom_[0-9a-f]{32}$/)
  .describe("A roomId returned by list_rooms or create_room.");
const jobIdInput = z
  .string()
  .regex(/^tljob_[0-9a-f]{32}$/)
  .describe("A jobId returned by start_team_job.");
const chatIdInput = z
  .string()
  .regex(/^tlcht_[0-9a-f]{32}$/)
  .describe(
    "Optional: the ThreadLink chat this work belongs to (the user can copy it from the chat's " +
      "Details tab). Omit to use the project's default chat.",
  );

const chatHandle = z
  .string()
  .regex(/^tlcht_[0-9a-f]{32}$/)
  .describe("A chatId returned by list_chats or create_chat.");

export const toolInputs = {
  ensure_session: {
    sessionRef: z
      .string()
      .regex(LOCAL_BINDING_REF_PATTERN)
      .optional()
      .describe(
        "The sessionRef returned by a previous ensure_session call in THIS conversation. Omit on first use.",
      ),
    label: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Optional short label for this conversation (cosmetic only)."),
  },
  list_links: { sessionId: sessionIdInput },
  link_to_claude: {
    sessionId: sessionIdInput,
    agentSessionId: z
      .string()
      .regex(/^tlses_[0-9a-f]{32}$/)
      .optional()
      .describe(
        "The Claude Code session the user chose from a previous link_to_claude call. Omit to list the options.",
      ),
  },
  send_to_agent: {
    sessionId: sessionIdInput,
    content: z.string().min(1).max(60_000).describe("The task for the linked agent (Claude Code)."),
    title: z.string().trim().min(1).max(255).optional(),
    priority: z.string().regex(PRIORITY_PATTERN).optional().describe("A1 (highest) .. E"),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional()
      .describe("Reuse the same key when retrying the same request to avoid duplicates."),
    linkId: z
      .string()
      .regex(/^tllnk_[0-9a-f]{32}$/)
      .optional()
      .describe("Only needed when list_links shows more than one active link."),
    chatId: chatIdInput.optional(),
  },
  get_task_status: {
    sessionId: sessionIdInput,
    taskId: z.string().regex(/^tltask_[0-9a-f]{32}$/),
  },
  get_task_result: {
    sessionId: sessionIdInput,
    taskId: z.string().regex(/^tltask_[0-9a-f]{32}$/),
  },
  acknowledge_result: {
    sessionId: sessionIdInput,
    taskId: z.string().regex(/^tltask_[0-9a-f]{32}$/),
  },
  list_recent_tasks: {
    sessionId: sessionIdInput,
    limit: z.number().int().min(1).max(50).optional(),
  },
  // Team Mode ---------------------------------------------------------------
  list_rooms: { sessionId: sessionIdInput },
  create_room: {
    sessionId: sessionIdInput,
    name: z.string().trim().min(1).max(100).describe("A short project name, e.g. 'Prism'."),
    linkId: z
      .string()
      .regex(/^tllnk_[0-9a-f]{32}$/)
      .optional()
      .describe("Only needed when more than one Claude Code session is linked."),
  },
  get_room: { sessionId: sessionIdInput, roomId: roomIdInput },
  start_team_job: {
    sessionId: sessionIdInput,
    roomId: roomIdInput,
    goal: z
      .string()
      .min(1)
      .max(TEAM_SIZE_LIMITS.goalBytes)
      .describe("What the team should achieve, in the user's words."),
    spec: controllerSpecSchema
      .optional()
      .describe(
        "Optional structured detail: requirements, constraints, architectureConstraints, " +
          "securityConstraints, filesAndSystems, testsRequired, doNotChange, deploymentRules, " +
          "definitionOfDone (each a list of short strings).",
      ),
    maxPlanningRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.planningRounds.min)
      .max(TEAM_LIMITS.planningRounds.max)
      .optional(),
    maxReviewRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.reviewRounds.min)
      .max(TEAM_LIMITS.reviewRounds.max)
      .optional(),
    parallelAgents: z
      .number()
      .int()
      .min(TEAM_LIMITS.parallelAgents.min)
      .max(TEAM_LIMITS.parallelAgents.max)
      .optional(),
    mode: z
      .enum(JOB_MODES)
      .optional()
      .describe(
        "How to run it. 'team' (default): Claude Code and Codex plan, build and cross-review. " +
          "'pair': one builds, the other reviews. 'solo': one agent builds alone, no reviewer. " +
          "Solo and pair need the ThreadLink app 0.8 or later on the user's computer.",
      ),
    builder: z
      .enum(AGENT_PROVIDERS)
      .optional()
      .describe("For solo or pair: who builds ('claude-code' or 'codex'). Ignored for team."),
    chatId: chatIdInput.optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional()
      .describe("Reuse the same key when retrying the same request to avoid duplicates."),
  },
  get_team_status: {
    sessionId: sessionIdInput,
    jobId: jobIdInput,
    roomId: roomIdInput.optional(),
  },
  get_team_log: {
    sessionId: sessionIdInput,
    jobId: jobIdInput,
    roomId: roomIdInput.optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  // Chat-first (0.10) --------------------------------------------------------
  list_chats: { sessionId: sessionIdInput },
  get_chat: {
    sessionId: sessionIdInput,
    chatId: chatHandle,
    after: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Only messages after this cursor (from a previous get_chat). Omit for the latest."),
    limit: z.number().int().min(1).max(50).optional().describe("How many messages (default 20)."),
  },
  create_chat: {
    sessionId: sessionIdInput,
    projectId: z
      .string()
      .regex(/^tlrom_[0-9a-f]{32}$/)
      .describe("A projectId from list_chats (projects)."),
    name: z.string().trim().min(1).max(100).describe("A short name for the chat."),
    mode: z
      .enum(JOB_MODES)
      .optional()
      .describe(
        "How work in this chat runs: 'team' (default), 'pair' (one builds, the other reviews) or 'solo'.",
      ),
  },
  send_message: {
    sessionId: sessionIdInput,
    chatId: chatHandle,
    message: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "What the agents should do, in the user's words. Start with '@claude' or '@codex' to have " +
          "that agent work alone, or '@team' for the whole team; otherwise the chat's mode decides.",
      ),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional()
      .describe("Reuse the same key when retrying the same request to avoid duplicates."),
    lane: z
      .enum(["auto", "chat", "work"])
      .optional()
      .describe(
        "How to run it. 'chat': a quick conversational answer from the agents (they read, " +
          "nothing is changed). 'work': repository work (plan, build, review, test). 'auto' " +
          "(default): ThreadLink decides from the message.",
      ),
  },
  get_chat_status: { sessionId: sessionIdInput, chatId: chatHandle },
  get_job_result: {
    sessionId: sessionIdInput,
    jobId: z
      .string()
      .regex(/^tljob_[0-9a-f]{32}$/)
      .describe("A jobId returned by send_message or get_chat_status."),
  },
} as const;

type Input<K extends keyof typeof toolInputs> = z.infer<z.ZodObject<(typeof toolInputs)[K]>>;

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "ThreadLink authorization is no longer valid. Reconnect ThreadLink.",
  forbidden: "This connection is not allowed to do that.",
  not_found: "Not found, or not accessible from this ThreadLink session.",
  conflict: "The session, link or task is no longer active.",
  invalid: "Invalid input.",
  too_large: "The request is too large.",
  limit: "A ThreadLink limit was reached. Try again later.",
  unavailable: "ThreadLink is temporarily unavailable.",
};

export class ToolError extends Error {}

export function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  // Chat refusals carry a fixed sentence chosen by the server (never database text).
  if (error instanceof ChatApiError) return error.userMessage;
  // Health refusals say who is not ready, in fixed words built from provider ids.
  if (error instanceof ProviderUnhealthyError) return error.userMessage;
  if (error instanceof ClientOperationError) return ERROR_MESSAGES[error.kind] ?? "Request failed.";
  return ERROR_MESSAGES.unavailable;
}

export async function threadlinkStatus(ctx: McpContext) {
  return {
    connection: {
      connectionId: ctx.identity.connectionId,
      platform: ctx.identity.platform,
      role: ctx.identity.role,
      status: ctx.identity.status,
    },
    next:
      "Call ensure_session once per conversation and keep the returned sessionId and sessionRef " +
      "for later ThreadLink calls in this conversation.",
  };
}

export async function ensureSession(ctx: McpContext, input: Input<"ensure_session">) {
  const sessionRef = input.sessionRef ?? `chat-${randomUUID()}`;
  const { session, created } = await registerSession(ctx.db, ctx.credentialHash, {
    localBindingRef: sessionRef,
    displayName: input.label,
  });
  return {
    sessionId: session.sessionId,
    sessionRef,
    displayName: session.displayName,
    created,
    note:
      "Use this sessionId for all ThreadLink tools in THIS conversation only. " +
      "If you ever need to re-establish it, call ensure_session with this sessionRef.",
  };
}

async function activeLinksFor(ctx: McpContext, sessionId: string): Promise<ThreadLinkView[]> {
  const links = await listSessionLinks(ctx.db, ctx.credentialHash, sessionId);
  return links.filter((l) => l.controllerSessionId === sessionId);
}

/**
 * Link this conversation to one of the owner's Claude Code sessions. Listing is
 * read-only; requesting creates a PENDING link that the Claude Code side must
 * approve on the user's machine. Nothing is ever auto-paired.
 */
export async function linkToClaude(ctx: McpContext, input: Input<"link_to_claude">) {
  const options = await listAgentSessions(ctx.db, ctx.credentialHash, input.sessionId);
  if (!input.agentSessionId) {
    if (options.length === 0) {
      return {
        status: "setup_required",
        message:
          "No Claude Code session is connected yet. On the computer with Claude Code, run the " +
          "ThreadLink bridge setup (see the ThreadLink dashboard), then try again.",
      };
    }
    return {
      status: "choose_session",
      message:
        "Ask the user which Claude Code session to link (even if there is only one), then call " +
        "link_to_claude again with its agentSessionId.",
      options: options.map((o) => ({
        agentSessionId: o.sessionId,
        name: o.displayName ?? "Claude conversation",
        workspace: o.workspaceName,
        runtime: o.runtimeLabel,
        runtimeOnline: o.runtimeOnline,
        busy: o.busy,
        resumesExistingClaudeSession: o.attachedToExistingSession,
        linkStatus: o.linkStatus,
      })),
    };
  }
  if (!options.some((o) => o.sessionId === input.agentSessionId)) {
    throw new ToolError("That Claude Code session is not available to this account.");
  }
  const link = await requestPairing(ctx.db, ctx.credentialHash, {
    controllerSessionId: input.sessionId,
    agentSessionId: input.agentSessionId,
  });
  return {
    status: link.status === "active" ? "linked" : "awaiting_approval",
    linkId: link.linkId,
    message:
      link.status === "active"
        ? "This conversation is linked. Use send_to_agent to send work to Claude."
        : "Link requested. The user must approve it on their computer in the ThreadLink bridge " +
          "(the setup screen shows the request). Then send_to_agent will work.",
  };
}

export async function listLinks(ctx: McpContext, input: Input<"list_links">) {
  const links = await activeLinksFor(ctx, input.sessionId);
  return {
    links: links
      .filter((l) => l.status !== "revoked")
      .map((l) => ({
        linkId: l.linkId,
        status: l.status,
        agent: l.agentDisplayName ?? "Claude Code session",
      })),
  };
}

export type LinkResolution =
  | { kind: "ok"; link: ThreadLinkView }
  | { kind: "setup_required" }
  | { kind: "choose"; options: { linkId: string; agent: string }[] };

/** 0 active links -> setup; 1 -> use it; >1 -> the caller must choose. Never guesses. */
export function resolveLink(links: ThreadLinkView[], linkId?: string): LinkResolution {
  const active = links.filter((l) => l.status === "active");
  if (linkId) {
    const chosen = active.find((l) => l.linkId === linkId);
    if (!chosen) throw new ToolError("That link is not an active link of this session.");
    return { kind: "ok", link: chosen };
  }
  if (active.length === 0) return { kind: "setup_required" };
  if (active.length === 1) return { kind: "ok", link: active[0] };
  return {
    kind: "choose",
    options: active.map((l) => ({
      linkId: l.linkId,
      agent: l.agentDisplayName ?? "Claude Code session",
    })),
  };
}

export async function sendToAgent(ctx: McpContext, input: Input<"send_to_agent">) {
  const resolution = resolveLink(await activeLinksFor(ctx, input.sessionId), input.linkId);
  if (resolution.kind === "setup_required") {
    return {
      status: "setup_required",
      message:
        "This conversation has no active ThreadLink to a Claude Code session. In the ThreadLink " +
        "dashboard, pair this session with your Claude Code bridge, then approve it from the bridge.",
      sessionId: input.sessionId,
    };
  }
  if (resolution.kind === "choose") {
    return {
      status: "choose_link",
      message: "More than one agent is linked. Ask the user which one, then retry with linkId.",
      options: resolution.options,
    };
  }
  const taskInput = {
    originSessionId: input.sessionId,
    threadLinkId: resolution.link.linkId,
    title: input.title ?? input.content.slice(0, 80),
    content: input.content,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
  };
  // With a chat: the same task, shown in that chat (validated by the database).
  const { task, created } = input.chatId
    ? await createChatTask(ctx.db, ctx.credentialHash, { ...taskInput, chatId: input.chatId })
    : await createTask(ctx.db, ctx.credentialHash, taskInput);
  return {
    status: task.status,
    taskId: task.taskId,
    created,
    target: {
      agent: resolution.link.agentDisplayName ?? "Claude Code session",
      linkId: resolution.link.linkId,
    },
    next: "The agent works asynchronously. Check back with get_task_status / get_task_result.",
  };
}

export async function getTaskStatus(ctx: McpContext, input: Input<"get_task_status">) {
  const task = await getTask(ctx.db, ctx.credentialHash, input.taskId, input.sessionId);
  if (task.originSessionId !== input.sessionId) throw new ToolError(ERROR_MESSAGES.not_found);
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    attemptCount: task.attemptCount,
    cancelReason: task.cancelReason,
    failureReason: task.failureReason,
    createdAt: task.createdAt,
    claimedAt: task.claimedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    failedAt: task.failedAt,
    cancelledAt: task.cancelledAt,
  };
}

export async function getTaskResultTool(ctx: McpContext, input: Input<"get_task_result">) {
  const r = await getTaskResult(ctx.db, ctx.credentialHash, input.taskId, input.sessionId);
  return {
    taskId: r.taskId,
    status: r.status,
    result: r.result,
    error: r.error,
    progress: r.progress.map((p) => ({ content: p.content, at: p.createdAt })),
    artifacts: r.artifacts.map((a) => ({
      type: a.type,
      reference: a.reference,
      metadata: a.metadata,
    })),
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    failedAt: r.failedAt,
    cancelledAt: r.cancelledAt,
  };
}

/**
 * Call this once the result has actually been read and shown. It is what stops
 * ThreadLink chasing the user about a result they already have. It changes
 * nothing about the task's outcome and is never seen by the agent.
 */
export async function acknowledgeResultTool(ctx: McpContext, input: Input<"acknowledge_result">) {
  const task = await acknowledgeTaskResult(
    ctx.db,
    ctx.credentialHash,
    input.taskId,
    input.sessionId,
  );
  return {
    taskId: task.taskId,
    status: task.status,
    acknowledged: true,
  };
}

export async function listRecentTasks(ctx: McpContext, input: Input<"list_recent_tasks">) {
  const tasks = await listOriginTasks(
    ctx.db,
    ctx.credentialHash,
    input.sessionId,
    input.limit ?? 10,
  );
  return {
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Team Mode: rooms and team jobs
// ---------------------------------------------------------------------------

const roomSummary = (r: RoomView) => ({
  roomId: r.roomId,
  name: r.name,
  status: r.status,
  workspace: r.workspace,
  agent: r.agent,
  openJobs: r.openJobs,
});

/**
 * Deliberately small: what a controller needs to decide its next step. The
 * full structured log stays behind get_team_log.
 */
export function conciseTeamStatus(s: TeamStatus) {
  const nodes = s.nodes.slice(0, 20).map((n) => `${n.key}: ${n.status} (${n.owner})`);
  return {
    jobId: s.jobId,
    room: s.roomName,
    mode: s.mode,
    status: s.status,
    verdict: s.verdict,
    line: s.line,
    summary: s.summary,
    planning: `${s.rounds.planning.n}/${s.rounds.planning.max}`,
    review: `${s.rounds.review.n}/${s.rounds.review.max}`,
    nodes,
    moreNodes: Math.max(0, s.nodesTotal - nodes.length),
    openFindings: s.openFindings,
    decisionsNeedingUser: s.decisionsNeedingUser,
    finished: s.finishedAt !== null,
  };
}

export async function listRoomsTool(ctx: McpContext, input: Input<"list_rooms">) {
  const rooms = await listRooms(ctx.db, ctx.credentialHash, input.sessionId);
  return {
    rooms: rooms.map(roomSummary),
    next:
      rooms.length === 0
        ? "No rooms yet. Use create_room to make one for the linked Claude Code workspace."
        : "Use start_team_job with a roomId to give the team a goal.",
  };
}

export async function createRoomTool(ctx: McpContext, input: Input<"create_room">) {
  // Same rule as send_to_agent: 0 links -> setup; several -> the user chooses.
  const resolution = resolveLink(await activeLinksFor(ctx, input.sessionId), input.linkId);
  if (resolution.kind === "setup_required") {
    return {
      status: "setup_required",
      message:
        "A room needs a linked Claude Code session on the user's computer. Use link_to_claude first.",
    };
  }
  if (resolution.kind === "choose") {
    return {
      status: "choose_link",
      message: "More than one agent is linked. Ask the user which one, then retry with linkId.",
      options: resolution.options,
    };
  }
  const { room, created } = await createRoom(ctx.db, ctx.credentialHash, {
    sessionId: input.sessionId,
    name: input.name,
    threadLinkId: resolution.link.linkId,
  });
  return { status: created ? "created" : "existing", room: roomSummary(room) };
}

export async function getRoomTool(ctx: McpContext, input: Input<"get_room">) {
  const room = await getRoom(ctx.db, ctx.credentialHash, input.sessionId, input.roomId);
  return {
    room: roomSummary(room),
    policy: room.policy,
    agents: room.agents.map((a) => ({ provider: a.provider, name: a.name, roles: a.roles })),
    recentJobs: room.recentJobs,
  };
}

export async function startTeamJobTool(ctx: McpContext, input: Input<"start_team_job">) {
  const { job, created } = await startTeamJob(ctx.db, ctx.credentialHash, {
    sessionId: input.sessionId,
    roomId: input.roomId,
    goal: input.goal,
    spec: input.spec,
    maxPlanningRounds: input.maxPlanningRounds,
    maxReviewRounds: input.maxReviewRounds,
    parallelAgents: input.parallelAgents,
    mode: input.mode,
    builder: input.builder,
    chatId: input.chatId,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    jobId: job.jobId,
    taskId: job.taskId,
    created,
    status: job.status,
    mode: job.mode,
    builder: job.builder,
    chatId: job.chatId ?? null,
    budgets: {
      planningRounds: job.rounds.planning.max,
      reviewRounds: job.rounds.review.max,
      parallelAgents: job.parallelAgents,
    },
    next:
      "The team works on the user's computer, asynchronously. Check get_team_status now and then; " +
      "use get_team_log only when the user wants the detail. When it finishes, acknowledge_result " +
      "with the taskId stops reminders.",
  };
}

export async function getTeamStatusTool(ctx: McpContext, input: Input<"get_team_status">) {
  return conciseTeamStatus(
    await getTeamStatus(ctx.db, ctx.credentialHash, input.sessionId, input.jobId, input.roomId),
  );
}

export async function getTeamLogTool(ctx: McpContext, input: Input<"get_team_log">) {
  const log = await getTeamLog(ctx.db, ctx.credentialHash, input.sessionId, input.jobId, {
    roomId: input.roomId,
    offset: input.offset,
    limit: input.limit,
  });
  return {
    status: conciseTeamStatus(log),
    spec: log.spec ?? log.specInput,
    plan: log.offset === 0 ? log.plan : undefined,
    evidence: log.evidence,
    nodes: log.nodesDetail,
    entries: log.entries,
    total: log.total,
    nextOffset: log.nextOffset,
  };
}

// ---------------------------------------------------------------------------
// Chat-first (0.10): the chats this conversation reaches through its links
// ---------------------------------------------------------------------------

/** A chat for a controller: names, not internals. The chatId is an opaque handle. */
const chatView = (c: ChatApiSummary) => ({
  chatId: c.chatId,
  name: c.name,
  project: c.projectName,
  mode: c.mode,
  runsOn: c.runtimeLabel,
  computerOnline: c.runtimeOnline,
  agents: c.participants
    .filter((p) => p.kind === "agent")
    .map((p) => ({ name: p.name, health: p.health })),
  working: c.activeJob ? { jobId: c.activeJob.jobId, status: c.activeJob.status } : null,
  needsAttention: c.needsAttention,
  lastActivityAt: c.lastActivityAt,
});

const messageView = (e: ChatApiEvent) => ({
  cursor: e.cursor,
  at: e.createdAt,
  from: e.authorLabel,
  ...(e.authorRole ? { role: e.authorRole } : {}),
  kind: e.eventType,
  text: e.body,
});

export async function listChatsTool(ctx: McpContext, input: Input<"list_chats">) {
  const { chats, projects } = await listControllerChats(
    ctx.db,
    ctx.credentialHash,
    input.sessionId,
  );
  return {
    chats: chats.map((c) => ({
      chatId: c.chatId,
      name: c.name,
      project: c.projectName,
      mode: c.mode,
      working: c.activeJob ? { jobId: c.activeJob.jobId, status: c.activeJob.status } : null,
      lastActivityAt: c.lastActivityAt,
    })),
    projects: projects.map((p) => ({ projectId: p.roomId, name: p.name })),
    next:
      projects.length === 0
        ? "No project is linked to this conversation yet. Use link_to_claude and create_room first."
        : "Use send_message with a chatId to give the agents work, or create_chat for a new chat.",
  };
}

export async function getChatTool(ctx: McpContext, input: Input<"get_chat">) {
  const { chat, messages } = await getControllerChat(ctx.db, ctx.credentialHash, input);
  return {
    chat: chatView(chat),
    messages: messages.events.map(messageView),
    cursor: messages.cursor,
    more: messages.hasMore,
  };
}

export async function createChatTool(ctx: McpContext, input: Input<"create_chat">) {
  const chat = await createControllerChat(ctx.db, ctx.credentialHash, {
    sessionId: input.sessionId,
    roomId: input.projectId,
    name: input.name,
    mode: input.mode,
  });
  return {
    chat: chatView(chat),
    next: "Use send_message with this chatId to give the agents work.",
  };
}

export async function sendMessageTool(ctx: McpContext, input: Input<"send_message">) {
  const { job, created, lane } = await postControllerChatMessage(ctx.db, ctx.credentialHash, {
    sessionId: input.sessionId,
    chatId: input.chatId,
    body: input.message,
    idempotencyKey: input.idempotencyKey,
    lane: input.lane,
  });
  return {
    jobId: job.jobId,
    created,
    status: job.status,
    mode: job.mode,
    lane,
    project: job.roomName,
    next:
      lane === "chat"
        ? "The agents answer in the chat shortly (read-only). Read the reply with get_chat."
        : "The agents work on the user's computer, asynchronously. Check get_chat_status now and " +
          "then, and get_job_result when it has finished. The user can follow along in the chat.",
  };
}

export async function getChatStatusTool(ctx: McpContext, input: Input<"get_chat_status">) {
  const { chat, job } = await controllerChatStatus(ctx.db, ctx.credentialHash, input);
  return { chat: chatView(chat), job: job ? conciseTeamStatus(job) : null };
}

export async function getJobResultTool(ctx: McpContext, input: Input<"get_job_result">) {
  const { job, chatName } = await controllerJobResult(ctx.db, ctx.credentialHash, input);
  return {
    ...conciseTeamStatus(job),
    chat: chatName,
    goal: job.goal,
    verdictReason: job.verdictReason ?? null,
  };
}
