import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  acknowledgeResultTool,
  createChatTool,
  createRoomTool,
  describeError,
  ensureSession,
  getChatStatusTool,
  getChatTool,
  getJobResultTool,
  getRoomTool,
  getTaskResultTool,
  getTaskStatus,
  getTeamLogTool,
  getTeamStatusTool,
  linkToClaude,
  listChatsTool,
  listLinks,
  listRecentTasks,
  listRoomsTool,
  sendMessageTool,
  sendToAgent,
  startTeamJobTool,
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
    "link_to_claude",
    {
      title: "Link to Claude Code",
      description:
        "Connect this conversation to one of the user's Claude Code sessions (one-time setup). " +
        "Call without agentSessionId to list sessions, ask the user to pick one, then call again " +
        "with agentSessionId. The user approves the link on their computer; nothing is auto-linked.",
      inputSchema: toolInputs.link_to_claude,
      annotations: { openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) => run(() => linkToClaude(ctx, input)),
  );

  server.registerTool(
    "send_to_agent",
    {
      title: "Send to agent",
      description:
        "Send this to Claude: queue a task for the Claude Code session linked to this conversation " +
        "(use when the user says e.g. 'send this to Claude'). If exactly one Claude session is linked " +
        "it is used automatically; with several, pass linkId; with none, use link_to_claude first. " +
        "Returns a taskId immediately; Claude works asynchronously, so check get_task_status / " +
        "get_task_result for the answer.",
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
    "acknowledge_result",
    {
      title: "Acknowledge a result",
      description:
        "Confirm you have read a task's result. Call this after get_task_result has been read " +
        "and shown to the user: it stops ThreadLink sending a reminder about it. Safe to call " +
        "more than once. It does not reach Claude Code.",
      inputSchema: toolInputs.acknowledge_result,
    },
    (input) => run(() => acknowledgeResultTool(ctx, input)),
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

  // Team Mode ---------------------------------------------------------------
  server.registerTool(
    "list_rooms",
    {
      title: "List team rooms",
      description:
        "List the user's Team Mode rooms (projects). A room is a workspace on the user's computer " +
        "where Claude Code and Codex work together on a goal.",
      inputSchema: toolInputs.list_rooms,
      annotations: READ_ONLY,
    },
    (input) => run(() => listRoomsTool(ctx, input)),
  );

  server.registerTool(
    "create_room",
    {
      title: "Create a team room",
      description:
        "Create a Team Mode room for the workspace of the linked Claude Code session. Calling it " +
        "again with the same name returns the existing room.",
      inputSchema: toolInputs.create_room,
      annotations: { openWorldHint: false, destructiveHint: false, idempotentHint: true },
    },
    (input) => run(() => createRoomTool(ctx, input)),
  );

  server.registerTool(
    "get_room",
    {
      title: "Team room",
      description: "A room's agents, policy and recent jobs.",
      inputSchema: toolInputs.get_room,
      annotations: READ_ONLY,
    },
    (input) => run(() => getRoomTool(ctx, input)),
  );

  server.registerTool(
    "start_team_job",
    {
      title: "Start a team job",
      description:
        "Give a room's agents (Claude Code and Codex, on the user's computer) a goal. By default " +
        "(mode 'team') they plan, build, cross-review and test it within bounded rounds; mode " +
        "'pair' has one build and the other review; mode 'solo' has one agent build alone with " +
        "no reviewer. Returns a jobId immediately; the work is asynchronous, so check " +
        "get_team_status. The user can follow and add notes in the project chat on the dashboard.",
      inputSchema: toolInputs.start_team_job,
      annotations: { openWorldHint: false, destructiveHint: false },
    },
    (input) => run(() => startTeamJobTool(ctx, input)),
  );

  server.registerTool(
    "get_team_status",
    {
      title: "Team job status",
      description:
        "Concise status of a team job started from this conversation: phase, rounds used, each " +
        "work item's status and open findings. Use this for polling.",
      inputSchema: toolInputs.get_team_status,
      annotations: READ_ONLY,
    },
    (input) => run(() => getTeamStatusTool(ctx, input)),
  );

  server.registerTool(
    "get_team_log",
    {
      title: "Team job log",
      description:
        "The full structured log of a team job (messages, findings, decisions, model runs), " +
        "paginated. Only when the user asks for detail; get_team_status is enough for polling.",
      inputSchema: toolInputs.get_team_log,
      annotations: READ_ONLY,
    },
    (input) => run(() => getTeamLogTool(ctx, input)),
  );

  // Chat-first (0.10) --------------------------------------------------------
  server.registerTool(
    "list_chats",
    {
      title: "List chats",
      description:
        "List the user's ThreadLink chats this conversation can reach (in projects linked to it), " +
        "and those projects. A chat is where the user's agents (Claude Code, Codex) work together.",
      inputSchema: toolInputs.list_chats,
      annotations: READ_ONLY,
    },
    (input) => run(() => listChatsTool(ctx, input)),
  );

  server.registerTool(
    "get_chat",
    {
      title: "Read a chat",
      description:
        "A chat's agents and their readiness, what is running, and its recent messages. Pass " +
        "`after` with the returned cursor to read only new messages.",
      inputSchema: toolInputs.get_chat,
      annotations: READ_ONLY,
    },
    (input) => run(() => getChatTool(ctx, input)),
  );

  server.registerTool(
    "create_chat",
    {
      title: "Create a chat",
      description: "Create a new chat in one of the linked projects (projectId from list_chats).",
      inputSchema: toolInputs.create_chat,
      annotations: { openWorldHint: false, destructiveHint: false },
    },
    (input) => run(() => createChatTool(ctx, input)),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to a chat",
      description:
        "Give the agents in a chat work, as this conversation (the user sees it in the chat, " +
        "labelled as coming from here). Routed by the chat's mode, or a leading @claude / @codex " +
        "/ @team. lane 'chat' (or a question / discussion, with lane 'auto') gets a quick " +
        "read-only answer and is allowed while work runs; repository work is refused while work " +
        "is already running in that chat. Returns a jobId immediately; check get_chat_status, " +
        "then get_job_result.",
      inputSchema: toolInputs.send_message,
      annotations: { openWorldHint: false, destructiveHint: false },
    },
    (input) => run(() => sendMessageTool(ctx, input)),
  );

  server.registerTool(
    "get_chat_status",
    {
      title: "Chat status",
      description:
        "What is happening in a chat now: the running job (or the latest one) with its phase, " +
        "rounds and open findings. Use this for polling.",
      inputSchema: toolInputs.get_chat_status,
      annotations: READ_ONLY,
    },
    (input) => run(() => getChatStatusTool(ctx, input)),
  );

  server.registerTool(
    "get_job_result",
    {
      title: "Job result",
      description: "The outcome of a job: verdict, summary and open findings.",
      inputSchema: toolInputs.get_job_result,
      annotations: READ_ONLY,
    },
    (input) => run(() => getJobResultTool(ctx, input)),
  );

  return server;
}
