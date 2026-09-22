import { randomUUID } from "node:crypto";

import { z } from "zod";

import { listAgentSessions } from "@/lib/client-api/native";
import {
  ClientOperationError,
  listSessionLinks,
  registerSession,
  requestPairing,
  type ClientDatabase,
} from "@/lib/client-api/operations";
import { createTask, getTask, getTaskResult, listOriginTasks } from "@/lib/client-api/tasks";
import type { ConnectionIdentity } from "@/lib/connections/authenticate";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { LOCAL_BINDING_REF_PATTERN } from "@/lib/sessions/model";
import { PRIORITY_PATTERN } from "@/lib/tasks/model";

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
  },
  get_task_status: {
    sessionId: sessionIdInput,
    taskId: z.string().regex(/^tltask_[0-9a-f]{32}$/),
  },
  get_task_result: {
    sessionId: sessionIdInput,
    taskId: z.string().regex(/^tltask_[0-9a-f]{32}$/),
  },
  list_recent_tasks: {
    sessionId: sessionIdInput,
    limit: z.number().int().min(1).max(50).optional(),
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
        name: o.displayName ?? "Claude Code session",
        workspace: o.workspaceName,
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
  const { task, created } = await createTask(ctx.db, ctx.credentialHash, {
    originSessionId: input.sessionId,
    threadLinkId: resolution.link.linkId,
    title: input.title ?? input.content.slice(0, 80),
    content: input.content,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
  });
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
