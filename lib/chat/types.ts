/**
 * Collaboration chat: the shared contract between the database, the web UI,
 * the desktop app and the Runtime. See docs/design/collaboration-chat.md.
 *
 * Every field that says who wrote something (author*) is set by the server or
 * by a database trigger from trusted state. No client, controller or agent can
 * choose its own author, provider, role or model label.
 */

export const CHAT_AUTHOR_KINDS = ["controller", "owner", "threadlink", "agent"] as const;
export type ChatAuthorKind = (typeof CHAT_AUTHOR_KINDS)[number];

/** Who a message is addressed to. `team` means every agent in the room. */
export const CHAT_AUDIENCES = ["claude-code", "codex", "team"] as const;
export type ChatAudience = (typeof CHAT_AUDIENCES)[number];

/** How a job is run. `team` is the existing Team Mode; the others are simpler. */
export const JOB_MODES = ["solo", "pair", "team"] as const;
export type JobMode = (typeof JOB_MODES)[number];

export const CHAT_EVENT_TYPES = [
  // controller
  "request",
  // owner
  "message",
  // agent
  "agent_message",
  "agent_result",
  // threadlink (written only by database triggers / security-definer RPCs)
  "job_started",
  "job_status",
  "plan_agreed",
  "unit_status",
  "finding",
  "decision",
  "job_verdict",
  "task_started",
  "task_progress",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "owner_routed",
  "stop_requested",
  "model_used",
  "model_mismatch",
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

/** `technical` events are hidden unless the viewer asks for technical details. */
export const CHAT_VISIBILITY = ["visible", "technical"] as const;
export type ChatVisibility = (typeof CHAT_VISIBILITY)[number];

/** One row of the chat timeline, as the owner's browser receives it. */
export type ChatEvent = {
  /** Monotonic cursor. Poll with `after=<seq>`. */
  seq: number;
  id: string;
  createdAt: string;
  roomId: string | null;
  agentSessionId: string;
  jobId: string | null;
  taskId: string | null;
  nodeId: string | null;
  authorKind: ChatAuthorKind;
  /** Set only when authorKind is `agent`. */
  authorProvider: "claude-code" | "codex" | null;
  /** Server-derived display name: "ChatGPT", "You", "ThreadLink", "Claude Code"… */
  authorLabel: string;
  authorRole: string | null;
  audience: ChatAudience | null;
  eventType: ChatEventType;
  /** Team message type (proposal, review, finding…) when mirrored from team_messages. */
  messageType: string | null;
  round: number | null;
  modelRequested: string | null;
  modelObserved: string | null;
  /** Plain text. Redacted before storage. Never rendered as HTML. */
  body: string;
  visibility: ChatVisibility;
};

export type ChatPage = {
  events: ChatEvent[];
  /** The highest seq returned, or the `after` passed in when nothing is new. */
  cursor: number;
  /** The active job in this room, if any: what a new message will be routed into. */
  activeJob: { jobId: string; mode: JobMode; status: string } | null;
};

/** What the owner's composer sends. */
export type PostChatMessageInput = {
  /** Exactly one scope. */
  roomId: string;
  body: string;
  /** Parsed from a leading @mention by the server, never trusted from the client. */
  mode?: JobMode;
  /** For solo/pair: who builds. Defaults from the @mention. */
  builder?: "claude-code" | "codex";
};

export type PostChatMessageResult =
  | { ok: true; routed: "note_to_active_job" | "stop_requested" | "new_job"; jobId: string | null }
  | { ok: false; message: string };
