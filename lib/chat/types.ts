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
  // 0.9 chat-first (threadlink, visible)
  "mode_changed",
  "provider_blocked",
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
  /** 0.9: the chat this row belongs to (null only for rows outside any project). */
  chatId?: string | null;
  /** 0.9: null for rows in a chat with no project (the owner's words, ThreadLink notes). */
  agentSessionId: string | null;
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
  | {
      ok: false;
      message: string;
      /** 0.9: the stable reason code (e.g. "provider_unhealthy", "needs_project"). */
      reason?: string;
      /** 0.9, provider_unhealthy only: each participant's health. */
      health?: ProviderHealthEntry[];
      /**
       * 0.9, provider_unhealthy only: the message WAS stored in the chat (with a
       * ThreadLink row saying who is not ready), so the composer can be cleared.
       */
      stored?: boolean;
    };

/** 0.9: what the chat composer sends. Routing comes from the chat's mode and a leading @mention. */
export type ChatPostInput = {
  chatId: string;
  body: string;
  idempotencyKey?: string;
};

// ---------------------------------------------------------------------------
// 0.9 — chat-first. See docs/design/chat-first.md.
// ---------------------------------------------------------------------------

/** Provider health as the Runtime last observed it (a real authenticated call, not status output). */
export const PROVIDER_HEALTH = [
  "ready",
  "needs_sign_in",
  "not_installed",
  "api_key_auth",
  "usage_exhausted",
  "unknown",
] as const;
export type ProviderHealth = (typeof PROVIDER_HEALTH)[number];

/** One provider's health as the server judged it now (fresh, authenticated, subscription). */
export type ProviderHealthEntry = { provider: string; health: ProviderHealth };

/** Display metadata for any provider; UI renders this instead of per-provider switches. */
export type ParticipantView = {
  kind: "owner" | "controller" | "agent";
  /** Provider id for agents ("claude-code", "codex", future ids). */
  provider: string | null;
  name: string;
  shortName: string;
  health: ProviderHealth | null;
};

export type ChatSummary = {
  chatId: string;
  name: string;
  mode: JobMode;
  roomId: string | null;
  projectName: string | null;
  groupId: string | null;
  groupName: string | null;
  pinned: boolean;
  archived: boolean;
  participants: ParticipantView[];
  lastMessage: string | null;
  lastActivityAt: string;
  unread: boolean;
  needsAttention: boolean;
  activeJob: { jobId: string; mode: JobMode; status: string } | null;
  /** The project's default chat (where controller work lands when no chat is named). */
  isRoomDefault?: boolean;
};

export type ChatSettings = {
  mode: JobMode;
  soloProvider: string | null;
  builderProvider: string | null;
  reviewerProvider: string | null;
};

export type ChatGroup = { groupId: string; name: string };

/** "Retry with <provider> as coordinator": offered for a job blocked before it had a plan. */
export type ChatRetryOption = {
  jobId: string;
  /** The job's participants, each with its health now. Only a ready one can be chosen. */
  coordinators: { provider: string; name: string; health: ProviderHealth }[];
};

/** One chat for its page. */
export type ChatDetail = ChatSummary & {
  settings: ChatSettings;
  groups: ChatGroup[];
  /** Null unless the chat's latest job is eligible for an explicit retry. */
  retry: ChatRetryOption | null;
  /** The newest seq the owner has read. */
  lastReadSeq: number;
};
