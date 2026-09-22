import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  describeError,
  ensureSession,
  getTaskResultTool,
  getTaskStatus,
  listLinks,
  listRecentTasks,
  sendToAgent,
  threadlinkStatus,
  toolInputs,
  type McpContext,
} from "./tools";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function run(fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    // Generic, non-enumerating message; details never leave the server.
    return { content: [{ type: "text", text: describeError(error) }], isError: true };
  }
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** One MCP server per request (stateless transport), bound to the authenticated connection. */
export function buildThreadLinkMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "threadlink", version: "0.1.0" });

  server.registerTool(
    "threadlink_status",
    {
      title: "ThreadLink status",
      description: "Show this ThreadLink connection and how to start. Safe to call any time.",
      annotations: READ_ONLY,
    },
    () => run(() => threadlinkStatus(ctx)),
  );

  server.registerTool(
    "ensure_session",
    {
      title: "Ensure ThreadLink session",
      description:
        "Call once at the start of each conversation before other ThreadLink tools. Returns a " +
        "sessionId and sessionRef for THIS conversation. Reuse them for the rest of the conversation; " +
        "never reuse them in a different conversation.",
      inputSchema: toolInputs.ensure_session,
      annotations: { openWorldHint: false, idempotentHint: true },
    },
    (input) => run(() => ensureSession(ctx, input)),
  );

  server.registerTool(
    "list_links",
    {
      title: "List linked agents",
      description: "List the Claude Code agents linked to this conversation's ThreadLink session.",
      inputSchema: toolInputs.list_links,
      annotations: READ_ONLY,
    },
    (input) => run(() => listLinks(ctx, input)),
  );

  server.registerTool(
    "send_to_agent",
    {
      title: "Send to agent",
      description:
        "Send a task to the Claude Code agent linked to this conversation. If exactly one agent is " +
        "linked it is used automatically; with several, you must pass linkId. Returns a taskId " +
        "immediately; the agent works asynchronously.",
      inputSchema: toolInputs.send_to_agent,
      annotations: { openWorldHint: false, destructiveHint: false },
    },
    (input) => run(() => sendToAgent(ctx, input)),
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Task status",
      description: "Status and timestamps of a task sent from this conversation's session.",
      inputSchema: toolInputs.get_task_status,
      annotations: READ_ONLY,
    },
    (input) => run(() => getTaskStatus(ctx, input)),
  );

  server.registerTool(
    "get_task_result",
    {
      title: "Task result",
      description:
        "Result, error, progress and artifact references of a task sent from this conversation's session.",
      inputSchema: toolInputs.get_task_result,
      annotations: READ_ONLY,
    },
    (input) => run(() => getTaskResultTool(ctx, input)),
  );

  server.registerTool(
    "list_recent_tasks",
    {
      title: "Recent tasks",
      description: "Recent tasks sent from this conversation's session (newest first).",
      inputSchema: toolInputs.list_recent_tasks,
      annotations: READ_ONLY,
    },
    (input) => run(() => listRecentTasks(ctx, input)),
  );

  return server;
}
