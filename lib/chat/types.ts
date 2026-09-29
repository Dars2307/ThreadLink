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
  // 0.10 cards (payload-carrying). code_change is agent-authored (tied to the
  // builder's run); decision_card is agent- or ThreadLink-authored; the rest
  // are ThreadLink's. A finding card reuses "finding" with a payload.
  "code_change",
  "decision_card",
  "choice",
  "job_summary",
  "phase",
  "timeout",
  "interrupted",
  "control_requested",
  // 0.11: a visible ThreadLink row "Codex usage is exhausted. Continuing with Claude."
  "failover",
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
  // --- 0.10 (optional so 0.9 rows and pages still type-check) ---------------
  /** The row's position in its chat (the 0.10 cursor). Null only outside any chat. */
  chatSeq?: number | null;
  /** The agent run that wrote an agent row (or that a ThreadLink row is about). */
  runId?: string | null;
  /** Agent rows: "run" = tied to a recorded run; "legacy" = recorded before 0.10 (unverified). */
  provenance?: "run" | "legacy" | null;
  /** The chat row this one replies to. */
  replyTo?: string | null;
  /** What this row refers to. */
  ref?: { kind: RefKind; id: string } | null;
  /** Structured card data (see CHAT_PAYLOAD docs in lib/chat/model.ts). Data, never HTML. */
  payload?: Record<string, unknown> | null;
  /** Any registry provider id on agent rows (authorProvider stays the 0.9 union, null for others). */
  authorProviderId?: string | null;
  /** The audience as stored: a registry provider id or "team". */
  audienceId?: string | null;
  /** Owner notes to a job: where the message is now (section 5). */
  delivery?: MessageDelivery | null;
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
  | {
      ok: true;
      /** 0.11 adds "chat_job" (a Fast Chat reply was started) and "choice_resolved". */
      routed: PostRouted;
      jobId: string | null;
      /** 0.11: the lane the message was routed to, and why. */
      lane?: ExecutionLane;
      laneReason?: LaneReason | null;
      /** 0.11, routed "choice_resolved": the choice and the chosen option's label. */
      choiceId?: string;
      chosenKey?: string;
      chosenLabel?: string;
    }
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
  /** 0.11: the composer's execution setting (default auto). A leading /chat or /work also works. */
  lane?: LaneChoice;
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
  /** 0.10: how many rows are unread under the 0.10 rules (at most 100). */
  unreadCount?: number;
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

// ---------------------------------------------------------------------------
// 0.10 — the real ThreadLink experience. See docs/design/threadlink-0.10.md.
// ---------------------------------------------------------------------------

/** A provider id from the registry (public.agent_providers), e.g. "claude-code". */
export type ProviderId = string;
/** A provider id or "team". Validated against the registry, not a fixed union. */
export type AudienceId = ProviderId | "team";

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ACTIVITIES = [
  "queued",
  "reading",
  "planning",
  "building",
  "reviewing",
  "testing",
  "waiting",
  "responding",
  "integrating",
] as const;
export type RunActivity = (typeof RUN_ACTIVITIES)[number];

/** What the owner may see about one agent run (Details / Provenance drawer). */
export type RunProvenance = {
  runId: string;
  provider: ProviderId;
  providerName: string;
  participantKey: string;
  role: string;
  requestedModel: string | null;
  observedModel: string | null;
  modelVerified: boolean;
  effort: string | null;
  access: "read-only" | "workspace-write" | null;
  accessVerified: boolean;
  nativeSession: {
    available: boolean;
    kind: string | null;
    continuity: string | null;
    /** 0.11: why it was resumed or started fresh (null before 0.11). */
    reason?: SessionReason | null;
  };
  /** 0.11: the run's timings in ms, when the Runtime reported them. */
  timings?: RunTimings | null;
  executionHost: string | null;
  worktreeLabel: string | null;
  status: RunStatus;
  activity: RunActivity | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  verified: "verified" | "partial" | "unverified";
  verificationNotes: string[];
};

/** A live row for a run that is working but has not produced its message yet. */
export type LiveActivity = {
  runId: string;
  provider: ProviderId;
  providerName: string;
  role: string;
  activity: RunActivity | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** 0.11: what it is doing, in fixed words ("Reviewing"); never agent text. */
  subject?: string | null;
};

export const FINDING_STATES = [
  "open",
  "accepted",
  "disputed",
  "fixed",
  "resolved",
  "dismissed",
] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const CHOICE_KINDS = [
  "provider_failure",
  "timeout",
  "plan_disagreement",
  "interrupted",
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
  // 0.11
  "start_work",
  "usage_exhausted",
] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

export const JOB_CONTROLS = [
  "pause_after_step",
  "stop_after_review",
  "stop_before_integration",
  "stop_now",
  "cancel_queued",
  "resume",
] as const;
export type JobControl = (typeof JOB_CONTROLS)[number];

export type MessageDelivery =
  | { state: "sent" }
  | { state: "queued"; for: string[] }
  | { state: "seen"; by: string[] }
  | { state: "not_delivered" };

export const REF_KINDS = ["finding", "decision", "node", "artifact", "message", "choice"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/**
 * 0.10 timeline page (GET /api/dashboard/chats/<id>/events). Paged by the
 * per-chat cursor: every event's `seq` here EQUALS its `chatSeq` (the global
 * sequence is never exposed on this route).
 */
export type ChatTimelinePage = {
  events: ChatEvent[];
  /** The highest chatSeq returned, or the `after` passed in when nothing is new. */
  cursor: number;
  /** The lowest chatSeq returned (page older rows with before=<this>), or null. */
  oldestChatSeq: number | null;
  /** True when rows older than oldestChatSeq exist. */
  hasMore: boolean;
  activeJob: {
    jobId: string;
    mode: JobMode;
    status: string;
    control: JobControl | null;
    controlRequestedAt: string | null;
  } | null;
  /** The newest chatSeq the owner has read. */
  lastReadChatSeq: number;
};

export type ProviderInfo = {
  id: ProviderId;
  displayName: string;
  shortName: string;
  mentionAliases: string[];
  supported: boolean;
};

export type FindingView = {
  findingId: string;
  jobId: string;
  severity: "blocking" | "important" | "non_blocking";
  category: string;
  /** Agent text, attributed to the raising agent (raisedBy / raisedRunId). Never HTML. */
  title: string;
  /** open | accepted | disputed | fixed | resolved | dismissed (a pre-0.10 wont_fix reads as dismissed). */
  status: FindingState;
  raisedBy: string;
  raisedRunId: string | null;
  ownerParticipant: string | null;
  filePath: string | null;
  line: number | null;
  nodeKey: string | null;
  resolvedRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DecisionView = {
  decisionId: string;
  jobId: string;
  /** "TL-00042": shown in Details only. */
  label: string;
  /** A fixed ThreadLink title, or the agent's own words (authorRunId). */
  title: string;
  titleSource: "threadlink" | "agent" | null;
  authorRunId: string | null;
  requiresUser: boolean;
  resolved: boolean;
  createdAt: string;
};

export type ChoiceView = {
  choiceId: string;
  jobId: string | null;
  kind: ChoiceKind;
  title: string;
  options: { key: string; label: string }[];
  status: "pending" | "chosen" | "expired" | "cancelled";
  chosenKey: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export const ARTIFACT_KINDS = [
  "report",
  "plan",
  "diff",
  "test_report",
  "notes",
  "export",
  "user_attachment",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactView = {
  artifactId: string;
  jobId: string | null;
  runId: string | null;
  kind: ArtifactKind;
  title: string;
  mime: string;
  bytes: number;
  createdBy: "runtime" | "owner";
  createdAt: string;
};

/** "Runs on <label>", presence, and each agent's health with the time of the check. */
export type ChatHostStatus = {
  now: string;
  /** 0.11: the server's clock (age `lastSeenAt` against this, not the client clock). */
  serverNow?: string;
  runtime: {
    label: string;
    /** 0.11 presence v2 (section 4): working > online (<75 s) > reconnecting (<3 min) > offline. */
    presence: HostPresence;
    lastSeenAt: string | null;
    protocol: number;
    /** Below the minimum protocol (10): work cannot start until it updates. */
    needsUpdate: boolean;
    /** 0.11: a newer protocol exists (a 0.10 Runtime gets no Fast Chat). */
    updateAvailable?: boolean;
    /** 0.11: this computer runs Fast Chat (protocol >= 11). */
    fastChat?: boolean;
  } | null;
  agents: {
    provider: ProviderId;
    name: string;
    shortName: string;
    health: ProviderHealth;
    /** ready | stale (a ready check older than 2 h) | the failing health. */
    state: ProviderHealth | "stale";
    checkedAt: string | null;
    /** "Ready · checked 23 s ago" / "Stale · last checked 2 h ago" / "Needs sign-in". */
    label: string;
    /** 0.11: when the provider said its usage resets (only if it said so; never invented). */
    resetsAt?: string | null;
  }[];
};

export type ChatSearchResult = {
  kind: "chat" | "project" | "message" | "finding" | "decision" | "artifact";
  chatId: string;
  chatName: string;
  /** The matching row's id (a chat, project, chat row, finding, decision or artifact). */
  refId: string;
  /** Plain text around the match (never HTML). */
  snippet: string;
  /** For messages: where to scroll to. */
  chatSeq: number | null;
  at: string;
};

// ---------------------------------------------------------------------------
// 0.11 — execution lanes, Fast Chat, presence v2, quota failover, natural
// choice answers. See docs/design/threadlink-0.11.md. Server: migration
// 20260929000100_threadlink_0_11.sql, lib/chat/intent.ts, lib/chat/choice-intent.ts.
// ---------------------------------------------------------------------------

/** How a job runs: `chat` = Fast Chat (conversational, read-only), `work` = Engineering Work. */
export const EXECUTION_LANES = ["chat", "work"] as const;
export type ExecutionLane = (typeof EXECUTION_LANES)[number];

/** The owner's per-message execution setting (composer): Auto (default), Chat only, Run work. */
export const LANE_CHOICES = ["auto", "chat", "work"] as const;
export type LaneChoice = (typeof LANE_CHOICES)[number];

/** Why a message went to its lane (recorded on the owner row's payload; Details only). */
export const LANE_REASONS = [
  "explicit_chat",
  "explicit_work",
  "small_talk",
  "negated",
  "edit_requested",
  "tests_requested",
  "repo_action",
  "repo_review",
  "question",
  "discussion",
  "status",
  "continuation",
  "default_chat",
  // Server-side: a chat message downgraded because the project's Runtime is older than protocol 11.
  "runtime_outdated",
  // Server-side: the message answered an open choice.
  "choice_answer",
] as const;
export type LaneReason = (typeof LANE_REASONS)[number];

/** The result of lib/chat/intent.ts classifyIntent. */
export type IntentResult = {
  lane: ExecutionLane;
  reason: LaneReason;
  /** Greeting / thanks / acknowledgement only (the Runtime skips the follow-up round). */
  smallTalk: boolean;
  /** The body to store: a leading "/chat" or "/work" is removed. */
  body: string;
};

/** What `routed` says after an owner post. */
export type PostRouted =
  "note_to_active_job" | "stop_requested" | "new_job" | "chat_job" | "choice_resolved";

/** Execution-host presence (section 4). */
export const HOST_PRESENCES = ["online", "working", "reconnecting", "offline"] as const;
export type HostPresence = (typeof HOST_PRESENCES)[number];

/** When an agent's included usage runs out (section 5). Default auto. */
export const FAILOVER_POLICIES = ["auto", "ask", "wait"] as const;
export type FailoverPolicy = (typeof FAILOVER_POLICIES)[number];

export type OwnerSettings = { failoverPolicy: FailoverPolicy; updatedAt: string | null };

/** Why a run's native session was resumed or started fresh (run provenance). */
export const SESSION_REASONS = [
  "resumed",
  "fresh_first_turn",
  "fresh_rotated",
  "fresh_resume_failed",
] as const;
export type SessionReason = (typeof SESSION_REASONS)[number];

/** Per-run timings in milliseconds (section 3.6). Every field optional. */
export type RunTimings = {
  queueMs?: number | null;
  spawnMs?: number | null;
  contextMs?: number | null;
  firstEventMs?: number | null;
  providerMs?: number | null;
  persistMs?: number | null;
};

/** Payload of a `failover` chat row. */
export type FailoverPayload = {
  from: ProviderId;
  to: ProviderId | null;
  reviewPending: boolean;
  /** ISO time the provider said its usage resets, or null. Clients localise it. */
  resetsAt: string | null;
};

/** An open choice as the natural-answer matcher sees it (lib/chat/choice-intent.ts). */
export type ChoiceForMatch = {
  choiceId: string;
  kind: ChoiceKind;
  options: { key: string; label: string }[];
  /** The provider the choice is about (e.g. the one that failed), and the alternative. */
  provider?: ProviderId | null;
  otherProvider?: ProviderId | null;
  /** That provider's current health on the project's computer. */
  providerHealth?: ProviderHealth | null;
};

/** The approval kinds: never answered by typing, only on their card. */
export const APPROVAL_CHOICE_KINDS = [
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
] as const satisfies readonly ChoiceKind[];
