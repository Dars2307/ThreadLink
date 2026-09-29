import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ConversationBinding, ProviderAdapter } from "./adapters/types.ts";
import {
  ApiError,
  type LinkView,
  type ProviderProfile,
  type RuntimeView,
  type TaskEnvelope,
  type ThreadLinkApi,
} from "./api.ts";
import { DEFAULT_BACKOFF, nextDelay, type BackoffOptions } from "./backoff.ts";
import {
  acquireSessionLock,
  BACKGROUND_UNSUPPORTED_MESSAGE,
  type ExecutionResult,
  type Executor,
  type TaskInput,
} from "./executor.ts";
import { repoInfo, type RepoInfo } from "./git.ts";
import type { RuntimeIdentity } from "./platform.ts";
import {
  listWorkspaceStates,
  loadConfig,
  loadWorkspaceState,
  newLocalBindingRef,
  saveConfig,
  saveWorkspaceState,
  workspaceDisplayName,
  type AttachedConversation,
  type WorkspaceState,
} from "./state.ts";
import type { ProviderDiscovery } from "./team/discovery.ts";
import {
  HEALTH_DETAIL,
  ProviderHealthMonitor,
  type HealthRecord,
  type ProbeFn,
  type ProviderHealth,
} from "./team/health.ts";
import { capabilityFlags } from "./team/capabilities.ts";
import { TEAM_TASK_TYPE, TeamExecutor } from "./team/executor.ts";
import {
  classifyRecovery,
  JournalStore,
  ProcessRegistry,
  type ProcessEntry,
  type RecoveryReport,
} from "./team/registry.ts";
import { RUNTIME_PROTOCOL } from "./team/wire.ts";
import type { TeamProgress } from "./team/orchestrator.ts";
import {
  detectCursor,
  providerCapabilities,
  type CursorDetection,
  type ProviderCapability,
} from "./team/providers.ts";
import { CHATGPT_PLANS, CLAUDE_PLANS } from "./team/types.ts";
import { UsageGovernor } from "./team/usage.ts";
import { claimTask, runClaimedTask, type Outcome, type WorkerDeps } from "./worker.ts";
import { ChatSessionStore } from "./team/chat-sessions.ts";

/**
 * The ThreadLink Runtime engine, shared by the CLI (`threadlink run`) and the
 * desktop app. One engine per machine/config directory (enforced by a lock).
 *
 * Loop: register -> sync workspaces/conversations -> repeat {
 *   heartbeat when due (and on its own timer, so nothing can hold it up)
 *   for each attached conversation: claim what may start now, run it in the
 *   background (0.11 §3.3: work lane ≤ 1 per workspace, chat lane ≤ 3 overall,
 *   FIFO per chat)
 *   idle: one wake long-poll in flight (§3.2), else the idle back-off
 * } with offline back-off and 401 -> signed out.
 *
 * Nothing here trusts local state for authorization: every call is checked by
 * ThreadLink against the Runtime's credential; local files only remember which
 * conversations the user attached.
 */

export type EngineStatus =
  | "idle"
  | "starting"
  | "online"
  | "offline"
  | "paused"
  | "signed-out"
  | "revoked"
  | "stopped"
  /** The address does not serve ThreadLink, so retrying cannot help. */
  | "wrong-address";

export type ConversationView = {
  provider: "claude-code";
  title: string;
  mode: "resume" | "worker" | "fresh";
  nativeSessionId: string | null;
  /** Worker mode: the background conversation, once it exists. */
  workerNativeSessionId: string | null;
  sessionId: string | null;
  localBindingRef: string;
  busy: boolean;
};

export type WorkspaceView = {
  path: string;
  name: string;
  workspaceId: string | null;
  exists: boolean;
  conversations: ConversationView[];
};

export type PendingLink = {
  linkId: string;
  sessionId: string;
  from: string;
  conversation: string;
  /**
   * False when the target conversation is not attached on this computer any
   * more. The request is still real and still approvable - it just needs the
   * conversation back first, which `reattach` describes.
   */
  attached: boolean;
  /** What to attach to make this approvable, when we know it. */
  reattach: {
    workspacePath: string | null;
    workspaceName: string | null;
    nativeSessionId: string | null;
    title: string | null;
    mode: AttachedConversation["mode"];
  } | null;
};

export type EngineSnapshot = {
  status: EngineStatus;
  detail: string | null;
  identity: RuntimeIdentity;
  runtime: RuntimeView | null;
  providers: {
    id: string;
    name: string;
    available: boolean;
    version: string | null;
    /** False when this provider cannot run tasks in the background at all. */
    supportsBackgroundWorker: boolean;
    supportsExactResume: boolean;
  }[];
  workspaces: WorkspaceView[];
  pendingLinks: PendingLink[];
  lastHeartbeatAt: string | null;
  tasksCompleted: number;
  /**
   * The mirrored feed, newest first. A background worker runs in a Claude
   * conversation the user cannot see, and there is no supported way to write
   * into the one they can; this is what they follow instead.
   */
  activity: ActivityEntry[];
  /**
   * Team jobs this Runtime is running or recently ran, newest first: who is
   * doing what, the review round and how many findings are open. The detail
   * lives in ThreadLink's team log; this is what the app shows at a glance.
   */
  team: TeamProgress[];
  /**
   * What each Team Mode agent looks like on this computer: installed, signed
   * in, which plan it reports and which models it offers. Never a token, an
   * email address or an account id -- those stop at discovery.
   */
  teamProviders: TeamProviderView[];
  /**
   * Every coding agent ThreadLink knows, with what it can do and whether it is
   * usable here: Claude Code, Codex, and Cursor (detect-only, always
   * "not_supported_yet"). Empty until discovery has run.
   */
  providerCapabilities: ProviderCapability[];
  /**
   * True once the trouble has lasted long enough that the user should be
   * offered a way out (sign in again / check the address) instead of watching
   * "Reconnecting..." forever. The engine keeps retrying regardless.
   */
  needsAttention: boolean;
};

/**
 * One line in the mirror of what ThreadLink is doing for a linked conversation.
 *
 * A background worker runs in its own Claude conversation, which the user
 * cannot see, and Claude Code has no supported way to write into the
 * conversation they DO have open. So the work is mirrored here instead.
 *
 * Every field is safe to display: the task's own title, where it ran, and how.
 * The prompt, the result and any diff are deliberately absent -- this is a
 * status feed, not a second copy of the conversation.
 */
export type ActivityEntry = {
  taskId: string;
  event: "task_started" | "task_completed" | "task_failed" | "task_lost" | "task_blocked";
  /** The task's title, as the sender wrote it. */
  title: string;
  /** The linked conversation this work belongs to, by display name. */
  conversation: string;
  /** Which attached conversation it belongs to, for grouping. */
  localBindingRef: string;
  workspace: string;
  /** How it ran. "worker" is the case this whole feed exists for. */
  mode: AttachedConversation["mode"];
  at: string;
  /** A short, safe explanation for a failure. Never a result or a diff. */
  detail?: string;
  /**
   * One safe line about what came back. Built by removing code, credentials
   * and paths from the result, never by quoting it; the full result stays in
   * the task, behind the same authorization as everything else.
   */
  summary?: string;
  /** Why a task that is alive is not progressing. */
  blocked?: BlockedReason;
};

/** Why a claimed task cannot proceed. Mirrors the reasons the server accepts. */
export type BlockedReason = "plan_mode" | "approval_required" | "user_input_required";

/** What each blocked state means to the person waiting on it. */
const BLOCKED_DETAIL: Record<BlockedReason, string> = {
  plan_mode: "Claude is in Plan Mode, so it will not make changes.",
  approval_required: "Claude needs your permission to continue.",
  user_input_required: "Claude is waiting for an answer from you.",
};

/** How many mirrored lines are kept. Enough to follow along, not a log file. */
export const ACTIVITY_LIMIT = 100;

export type TeamProviderView = {
  provider: "claude-code" | "codex";
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  /** As the provider reports it, e.g. "max". Null when it does not say. */
  detectedPlan: string | null;
  models: { id: string; displayName: string }[];
  /** No CLI reports remaining usage today, so this is never a guessed number. */
  remaining: "unknown";
  detail: string | null;
  /**
   * 0.9: what a real authenticated call last showed (not status output).
   * "unknown" until checked, or when this Runtime does not probe.
   */
  health: ProviderHealth;
  /** ISO time of that check; null when never checked. */
  healthCheckedAt: string | null;
  /** A short fixed sentence for the health value. Never provider output. */
  healthDetail: string;
};

/** One provider as the desktop app's settings show it: the owner's plan and what was found here. */
export type ProviderProfileView = {
  provider: "claude-code" | "codex";
  /** The owner's declared plan (server-side truth). Null when the server did not say. */
  declaredPlan: string | null;
  usagePolicy: string | null;
  paidUsageEnabled: boolean | null;
  /** What discovery found on this computer. Null before discovery has run. */
  detected: TeamProviderView | null;
  capability: ProviderCapability | null;
};

export type ProviderProfilesView = {
  profiles: ProviderProfileView[];
  /** Every provider, including detect-only ones (Cursor). */
  capabilities: ProviderCapability[];
};

/** The plans an owner can declare, per provider. The server checks them again. */
export const DECLARABLE_PLANS: Record<"claude-code" | "codex", readonly string[]> = {
  "claude-code": CLAUDE_PLANS,
  codex: CHATGPT_PLANS,
};

export type EngineEvent =
  | { type: "snapshot"; snapshot: EngineSnapshot }
  | { type: "activity"; activity: ActivityEntry }
  /** A team job's concise state changed. Carries no prompt, code or result. */
  | { type: "team"; progress: TeamProgress }
  | {
      type: "task";
      outcome: "completed" | "failed" | "lost";
      title: string;
      conversation: string;
      reason?: string;
    }
  | { type: "link-request"; link: PendingLink }
  | { type: "restart-requested" }
  | { type: "settings"; settings: RuntimeView["settings"] };

type Api = Pick<
  ThreadLinkApi,
  | "registerRuntime"
  | "runtimeHeartbeat"
  | "upsertWorkspace"
  | "registerConversation"
  | "runtimeLinks"
  | "links"
  | "approvePairing"
  | "declinePairing"
  | "inbox"
  | "claim"
  | "start"
  | "heartbeat"
  | "progress"
  | "complete"
  | "fail"
  | "blocked"
  | "teamWrite"
  | "reportProviderDetection"
> &
  // Optional so embedded engines and older test doubles need not provide them.
  Partial<Pick<ThreadLinkApi, "providerProfiles" | "setDeclaredPlan" | "wake">>;

export type EngineOptions = {
  api: Api;
  configDir: string;
  adapters: ProviderAdapter[];
  identity: RuntimeIdentity;
  version: string;
  /** The ThreadLink address, for messages the user reads. Never a credential. */
  baseUrlLabel?: string;
  log?: (message: string) => void;
  heartbeatMs?: number;
  linkPollMs?: number;
  backoff?: BackoffOptions;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  permissionMode?: string;
  /** Background workers default to a mode that can make changes. */
  workerPermissionMode?: string;
  model?: string;
  taskHeartbeatMs?: number;
  repo?: (path: string) => Promise<RepoInfo>;
  /** Test seam: build the executor for a team job instead of the real one. */
  teamExecutor?: (workspace: string, sessionId: string) => Executor;
  /** How to find Team Mode agents on this computer. Omitted = no discovery. */
  discoverTeam?: (() => Promise<ProviderDiscovery[]>) | null;
  /** How to look for a Cursor CLI (detect-only, never run). Defaults to a PATH lookup. */
  detectCursor?: () => CursorDetection;
  /**
   * The authenticated health call (team/health.ts). With `discoverTeam`, the
   * engine checks provider health at start, every 30 minutes while idle, at
   * each team job claim and on "Check again". Omitted = no probing.
   */
  probeProvider?: ProbeFn | null;
  /** 0.11 §3.2: how long each wake long-poll may wait (seconds, ≤ 25). 0 = no long-poll. */
  wakeWaitSeconds?: number;
  /** 0.11 §3.3: Fast Chat jobs running at once, across every chat (default 3). */
  chatConcurrency?: number;
};

/** 0.11 §3.3: the two execution lanes, as the engine schedules them. */
export type TaskLane = "chat" | "work";

/**
 * Which lane a delivered task belongs to, read from the job document the
 * server built (`lane`, `chatId`) before the task is claimed. Anything that
 * is not a Team task, or cannot be read, is work: it gets the strictest limit.
 */
export function taskLane(task: Pick<TaskEnvelope, "taskType" | "content">): {
  lane: TaskLane;
  chatId: string | null;
} {
  if (task.taskType !== TEAM_TASK_TYPE || !task.content) return { lane: "work", chatId: null };
  try {
    const doc = JSON.parse(task.content) as Record<string, unknown>;
    const spec = (doc.spec && typeof doc.spec === "object" ? doc.spec : {}) as Record<
      string,
      unknown
    >;
    const lane = doc.lane ?? spec.lane;
    const chatId =
      typeof doc.chatId === "string" && /^tlcht_[0-9a-f]{32}$/.test(doc.chatId) ? doc.chatId : null;
    return { lane: lane === "chat" ? "chat" : "work", chatId };
  } catch {
    return { lane: "work", chatId: null };
  }
}

type RunningTask = {
  taskId: string;
  lane: TaskLane;
  /** Resolved, case-folded workspace path (work lane limit). */
  workspace: string;
  chatId: string | null;
  done: Promise<Outcome | "error">;
};

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });

/**
 * Stands in for a provider that cannot run the mode the user chose. It fails
 * every task with a reason the UI can act on, instead of the engine quietly
 * picking a different mode.
 */
class UnsupportedModeExecutor implements Executor {
  readonly name = "unsupported";
  readonly #mode: string;
  readonly #provider: string;
  constructor(mode: string, provider: string) {
    this.#mode = mode;
    this.#provider = provider;
  }
  async execute(): Promise<ExecutionResult> {
    if (this.#mode === "worker") {
      return {
        ok: false,
        reason: "background_mode_unsupported",
        error: BACKGROUND_UNSUPPORTED_MESSAGE,
      };
    }
    return {
      ok: false,
      reason: "native_session_unavailable",
      error: `${this.#provider} cannot resume that conversation on this computer.`,
    };
  }
}

/**
 * Why a task failed, in the user's words. A mirrored line may carry one of
 * these and nothing else: never the agent's error text, which can quote the
 * prompt or the code it was working on.
 */
const FAILURE_DETAIL: Record<string, string> = {
  session_busy: "That Claude conversation was open, so it was not touched.",
  background_mode_unsupported: "This agent cannot work in the background.",
  native_session_unavailable: "That Claude conversation could not be opened.",
  lease_exhausted: "ThreadLink stopped hearing from this computer.",
};

/**
 * Sends a Team Mode job to the team executor and every other task to the
 * conversation's own executor, unchanged. The choice is made on the server's
 * task type, never on what the task's text looks like.
 */
class DispatchingExecutor implements Executor {
  readonly name: string;
  readonly #single: Executor;
  readonly #team: () => Executor;
  constructor(single: Executor, team: () => Executor) {
    this.#single = single;
    this.#team = team;
    this.name = single.name;
  }
  execute(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult> {
    return task.taskType === TEAM_TASK_TYPE
      ? this.#team().execute(task, signal)
      : this.#single.execute(task, signal);
  }
}

/** The stored mode, defaulting safely when the server says something unknown. */
function conversationMode(mode: string | null): AttachedConversation["mode"] {
  if (mode === "resume" || mode === "worker") return mode;
  return "fresh";
}

/** What a conversation is called before the user names it. */
function defaultConversationName(mode: AttachedConversation["mode"]): string {
  if (mode === "fresh") return "New conversation per request";
  if (mode === "worker") return "Background worker";
  return "Claude conversation";
}

const AGENT_IDS = ["claude-code", "codex"] as const;

const isNetworkError = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);

export class RuntimeEngine {
  readonly #o: Required<
    Omit<
      EngineOptions,
      "model" | "log" | "teamExecutor" | "discoverTeam" | "detectCursor" | "probeProvider"
    >
  > &
    Pick<
      EngineOptions,
      "model" | "log" | "teamExecutor" | "discoverTeam" | "detectCursor" | "probeProvider"
    >;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  readonly #claimRef = `runtime-${randomUUID()}`;
  /**
   * Shared by every team job this Runtime runs, so a provider that has run out
   * stays marked out until it resets, and paid usage stays off.
   */
  readonly #governor = new UsageGovernor();
  #status: EngineStatus = "idle";
  #detail: string | null = null;
  #needsAttention = false;
  #runtime: RuntimeView | null = null;
  #providers: EngineSnapshot["providers"] = [];
  #capabilities: Record<string, string> = {};
  #workspaces: WorkspaceState[] = [];
  #busy = new Set<string>();
  /** Newest first, capped at ACTIVITY_LIMIT. */
  #activity: ActivityEntry[] = [];
  #teamProviders: TeamProviderView[] = [];
  /** The last discovery, local only (executable paths never leave this computer). */
  #found: ProviderDiscovery[] = [];
  #providerCapabilities: ProviderCapability[] = [];
  /** Provider health (team/health.ts); null when this engine does not probe. */
  readonly #health: ProviderHealthMonitor | null;
  /** Team job progress by job id, in insertion order; capped. */
  #team = new Map<string, TeamProgress>();
  /** 0.10: provider processes this Runtime started (stop_now kills only these). */
  readonly #processes: ProcessRegistry;
  /** 0.10: per-job journals for crash recovery. */
  readonly #journals: JournalStore;
  /** Team jobs running in this process now. */
  readonly #activeJobs = new Set<string>();
  /** What a previous Runtime left behind, classified at start. */
  #recovery: RecoveryReport[] = [];
  #staleProcesses: ProcessEntry[] = [];
  #recovered = false;
  /** `${taskId}:${event}` already mirrored, so a retry cannot post it twice. */
  #mirrored = new Set<string>();
  #pending: PendingLink[] = [];
  #lastHeartbeat = 0;
  #lastLinkPoll = 0;
  #tasksCompleted = 0;
  #wake: (() => void) | null = null;
  #localPause = false;
  /** 0.11 §3.3: tasks this engine claimed and is running in the background. */
  readonly #running = new Map<string, RunningTask>();
  /** A background task hit a credential/revocation error: the loop stops on it. */
  #fatal: unknown = null;
  /** One heartbeat at a time, shared by the loop and the heartbeat timer. */
  #heartbeatInFlight: Promise<RuntimeView> | null = null;
  /** 0.11 §3.2: false after the server said it has no wake endpoint (until wakeRetryAt). */
  #wakeSupported = true;
  #wakeRetryAt = 0;
  #wakeInFlight: Promise<{ pending: number }> | null = null;
  /** 0.11 §5: failover notices already sent (one per chat per exhaustion). */
  readonly #noticesSent = new Set<string>();
  /** 0.11 §3.4.6: Fast Chat native sessions, per chat, provider and workspace. */
  readonly #chatSessions: ChatSessionStore;

  constructor(options: EngineOptions) {
    this.#o = {
      heartbeatMs: 30_000,
      linkPollMs: 10_000,
      backoff: DEFAULT_BACKOFF,
      sleep: defaultSleep,
      random: Math.random,
      permissionMode: "plan",
      workerPermissionMode: "acceptEdits",
      taskHeartbeatMs: 60_000,
      repo: (path) => repoInfo(path),
      baseUrlLabel: "This address",
      wakeWaitSeconds: 25,
      chatConcurrency: 3,
      ...options,
    };
    this.#o.wakeWaitSeconds = Math.max(0, Math.min(25, this.#o.wakeWaitSeconds));
    const discover = this.#o.discoverTeam;
    const probe = this.#o.probeProvider;
    this.#health =
      discover && probe
        ? new ProviderHealthMonitor({
            discover,
            probe,
            onChange: (changed) => void this.#healthChanged(changed),
          })
        : null;
    this.#processes = new ProcessRegistry(this.#o.configDir);
    this.#journals = new JournalStore(this.#o.configDir);
    this.#chatSessions = new ChatSessionStore(this.#o.configDir);
  }

  // -------------------------------------------------------------------------
  // Crash recovery (docs/design/threadlink-0.10.md §6)
  // -------------------------------------------------------------------------

  /**
   * Classifies every team job a previous Runtime on this computer left
   * behind: completed_unsynced, resumable or interrupted (registry.ts). Runs
   * once, at start. Nothing is re-run here and no process is touched: the
   * job's carrier task is redelivered by the server once its lease expires,
   * and the team executor acts on the classification then, with a fresh claim.
   * Journals of jobs whose verdict reached the server more than a week ago
   * are removed. Never throws.
   */
  recoverTeamJobs(): RecoveryReport[] {
    if (this.#recovered) return this.#recovery;
    this.#recovered = true;
    try {
      this.#staleProcesses = this.#processes.takeStale();
      const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
      const reports: RecoveryReport[] = [];
      for (const journal of this.#journals.list()) {
        const report = classifyRecovery(journal, this.#staleProcesses);
        if (report.classification === "completed" && Date.parse(journal.updatedAt) < weekAgo) {
          this.#journals.open(journal.jobId, journal).close();
          continue;
        }
        if (report.classification !== "completed") reports.push(report);
      }
      this.#recovery = reports;
      for (const r of reports) {
        this.#o.log?.(`team job ${r.jobId} left by a previous run: ${r.classification}`);
      }
    } catch (error) {
      this.#o.log?.(`team recovery could not read its journals: ${String(error)}`);
    }
    return this.#recovery;
  }

  /** The recovery classification made at start (for the desktop app and CLI). */
  teamRecovery(): RecoveryReport[] {
    return [...this.#recovery];
  }

  /** Provider processes this Runtime started and that are running now (never others). */
  teamProcesses(): ProcessEntry[] {
    return this.#processes.list();
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------
  on(listener: (e: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: EngineEvent) {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        /* a UI listener must never break the engine */
      }
    }
  }

  #setStatus(status: EngineStatus, detail: string | null = null, needsAttention = false) {
    const changed =
      status !== this.#status || detail !== this.#detail || needsAttention !== this.#needsAttention;
    this.#status = status;
    this.#detail = detail;
    this.#needsAttention = needsAttention;
    if (changed) this.#emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  #changed() {
    this.#emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  snapshot(): EngineSnapshot {
    return {
      status: this.#status,
      detail: this.#detail,
      identity: this.#o.identity,
      runtime: this.#runtime,
      providers: this.#providers,
      workspaces: this.#workspaces.map((w) => ({
        path: w.workspace,
        name: workspaceDisplayName(w.workspace),
        workspaceId: w.workspaceId ?? null,
        exists: existsSync(w.workspace),
        conversations: w.conversations.map((c) => ({
          provider: c.provider,
          title:
            c.title ??
            (c.mode === "fresh" ? "New conversation for each request" : "Untitled conversation"),
          mode: c.mode,
          nativeSessionId: c.nativeSessionId,
          workerNativeSessionId: c.workerNativeSessionId ?? null,
          sessionId: c.sessionId ?? null,
          localBindingRef: c.localBindingRef,
          // Only an exact-conversation binding can be blocked by the user's
          // own conversation being open. A background worker is ThreadLink's
          // own conversation and runs regardless, so calling it "in use" would
          // be both wrong and alarming.
          busy:
            c.mode === "resume" && Boolean(c.nativeSessionId && this.#busy.has(c.nativeSessionId)),
        })),
      })),
      pendingLinks: this.#pending,
      lastHeartbeatAt: this.#lastHeartbeat ? new Date(this.#lastHeartbeat).toISOString() : null,
      tasksCompleted: this.#tasksCompleted,
      activity: [...this.#activity],
      team: [...this.#team.values()].reverse(),
      teamProviders: this.#teamProviders,
      providerCapabilities: this.#providerCapabilities,
      needsAttention: this.#needsAttention,
    };
  }

  /**
   * Records one mirrored line and tells the UI.
   *
   * Milestones only, and each one at most once: a task that is retried, or a
   * snapshot that arrives twice, must not turn into a second entry. Tool calls
   * and progress never reach here at all -- the feed is meant to be readable,
   * not complete.
   */
  #mirror(entry: ActivityEntry): void {
    const key = `${entry.taskId}:${entry.event}`;
    if (this.#mirrored.has(key)) return;
    this.#mirrored.add(key);
    this.#activity.unshift(entry);
    if (this.#activity.length > ACTIVITY_LIMIT) {
      const dropped = this.#activity.splice(ACTIVITY_LIMIT);
      for (const old of dropped) this.#mirrored.delete(`${old.taskId}:${old.event}`);
    }
    this.#emit({ type: "activity", activity: entry });
    this.#emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  #adapter(id: string): ProviderAdapter {
    const a = this.#o.adapters.find((x) => x.id === id);
    if (!a) throw new Error(`No adapter for ${id}`);
    return a;
  }

  // -------------------------------------------------------------------------
  // Setup operations (used by the CLI wizard and the desktop app)
  // -------------------------------------------------------------------------
  async detectProviders() {
    const caps: Record<string, string> = {
      filesystem: "local",
      platform: this.#o.identity.platform,
    };
    this.#providers = [];
    for (const a of this.#o.adapters) {
      const d = await a.detect();
      const can = a.supports();
      this.#providers.push({
        id: a.id,
        name: a.displayName,
        available: d.available,
        version: d.version,
        supportsBackgroundWorker: can.supportsBackgroundWorker,
        supportsExactResume: can.supportsExactResume,
      });
      Object.assign(caps, a.capabilities(d));
    }
    if (this.#o.identity.kind === "remote") caps.filesystem = "remote";
    this.#capabilities = caps;
    this.#changed();
    return this.#providers;
  }

  async register(): Promise<RuntimeView> {
    const config = await loadConfig(this.#o.configDir);
    const runtime = await this.#o.api.registerRuntime({
      label: config.label ?? this.#o.identity.label,
      platform: this.#o.identity.platform,
      kind: this.#o.identity.kind,
      version: this.#o.version,
      protocol: RUNTIME_PROTOCOL,
    });
    this.#runtime = runtime;
    await saveConfig(this.#o.configDir, { runtimeId: runtime.runtimeId });
    this.#changed();
    // Discovery spawns the CLIs, so it runs in the background and never
    // delays registration or fails it.
    void this.refreshTeamProviders();
    return runtime;
  }

  /** Finds out which Team Mode agents this computer has, and checks their health. Never throws. */
  async refreshTeamProviders(): Promise<TeamProviderView[]> {
    return this.#refresh(false);
  }

  /**
   * "Check again": discovery plus a real authenticated call to every provider,
   * ignoring the backoff that normally spaces checks of a provider that needs
   * sign-in. For the desktop app. Never throws.
   */
  async checkProviders(): Promise<TeamProviderView[]> {
    return this.#refresh(true);
  }

  /** Provider health as last checked, one record per provider. Empty when this engine does not probe. */
  providerHealth(): HealthRecord[] {
    return this.#health?.records() ?? [];
  }

  async #refresh(force: boolean): Promise<TeamProviderView[]> {
    // Opt-in: discovery spawns the real CLIs, so only an engine built for the
    // real app (createEngine) does it. Tests and embedded engines do not.
    const discover = this.#o.discoverTeam;
    if (!discover) return this.#teamProviders;
    try {
      const found = await discover();
      this.#found = found;
      if (this.#health) await this.#health.checkAll({ found, force });
      this.#teamProviders = this.#views();
      // Cursor is looked for on PATH only; nothing is run.
      const cursor = (this.#o.detectCursor ?? detectCursor)();
      this.#providerCapabilities = providerCapabilities(found, cursor);
      this.#changed();
      for (const p of found) await this.#report(p);
    } catch {
      /* discovery is advisory; a failure leaves the last known state */
    }
    return this.#teamProviders;
  }

  /** At most every 30 minutes while idle. Never throws. */
  async #healthTick(): Promise<void> {
    if (!this.#health) return;
    try {
      // tick() runs its own discovery when due; keep the local view in step.
      if (!(await this.#health.tick())) return;
      this.#found = AGENT_IDS.map((p) => this.#health!.discovery(p)).filter(
        (p): p is ProviderDiscovery => p !== undefined,
      );
      this.#teamProviders = this.#views();
      this.#changed();
      for (const p of this.#found) await this.#report(p);
    } catch {
      /* advisory */
    }
  }

  /** Health changed at a job claim or after a failed run: tell the app and ThreadLink now. */
  async #healthChanged(changed: ("claude-code" | "codex")[]): Promise<void> {
    if (!this.#health) return;
    for (const provider of changed) {
      const latest = this.#health.discovery(provider);
      if (latest) this.#found = [...this.#found.filter((f) => f.provider !== provider), latest];
    }
    this.#teamProviders = this.#views();
    this.#changed();
    for (const provider of changed) {
      const p = this.#found.find((f) => f.provider === provider);
      if (p) await this.#report(p);
    }
  }

  #views(): TeamProviderView[] {
    return this.#found.map((p) => {
      const h = this.#health?.get(p.provider);
      const health = h?.health ?? "unknown";
      return {
        provider: p.provider,
        installed: p.installed,
        authenticated: p.authenticated,
        version: p.version,
        detectedPlan: p.detectedPlan,
        models: p.models.map((m) => ({ id: m.id, displayName: m.displayName })),
        remaining: "unknown" as const,
        detail: p.detail ?? null,
        health,
        healthCheckedAt: h?.checkedAt ?? null,
        healthDetail: HEALTH_DETAIL[health],
      };
    });
  }

  /**
   * Reports one provider to ThreadLink with exactly the keys it accepts. The
   * local executable path and any free-text detail stay on this computer; the
   * health detail is a fixed sentence, never provider output.
   */
  async #report(p: ProviderDiscovery): Promise<void> {
    const h = this.#health?.get(p.provider);
    await this.#o.api
      .reportProviderDetection(p.provider, {
        installed: p.installed,
        authenticated: p.authenticated,
        version: p.version,
        authMethod: p.authMethod,
        detectedPlan: p.detectedPlan,
        models: p.models.map((m) => ({ id: m.id, displayName: m.displayName })),
        currentModel: p.currentModel,
        // Discovery's verified capabilities plus the adapter registry's (§10), as booleans.
        capabilities: { ...p.capabilities, ...capabilityFlags(p.provider) },
        usage: { remaining: "unknown" },
        detectedAt: new Date().toISOString(),
        ...(h ? { health: h.health, healthCheckedAt: h.checkedAt, healthDetail: h.detail } : {}),
        // 0.11 §5: only a reset time the provider itself stated; never an estimate.
        ...(h?.health === "usage_exhausted" && h.resetsAt ? { resetsAt: h.resetsAt } : {}),
      })
      .catch((error: unknown) => this.#o.log?.(`could not report ${p.provider}: ${String(error)}`));
  }

  /**
   * The owner's provider profiles from ThreadLink, joined with what discovery
   * found on this computer and what each provider can do. For the desktop
   * app's settings.
   */
  async getProviderProfiles(): Promise<ProviderProfilesView> {
    if (!this.#o.api.providerProfiles) throw new Error("Provider profiles are not available.");
    return this.#profilesView(await this.#o.api.providerProfiles());
  }

  /**
   * Sets the owner's declared plan for one provider. Only the plan: usage
   * policy and paid usage stay the owner's to change on the website. The value
   * is checked here and again by the server.
   */
  async setProviderPlan(
    provider: "claude-code" | "codex",
    declaredPlan: string,
  ): Promise<ProviderProfilesView> {
    if (provider !== "claude-code" && provider !== "codex") {
      throw new Error("That is not a provider ThreadLink supports.");
    }
    if (!DECLARABLE_PLANS[provider].includes(declaredPlan)) {
      throw new Error("That plan is not one ThreadLink knows for this provider.");
    }
    if (!this.#o.api.setDeclaredPlan) throw new Error("Provider plans cannot be changed here.");
    const { profiles } = await this.#o.api.setDeclaredPlan(provider, declaredPlan);
    return this.#profilesView(profiles);
  }

  #profilesView(profiles: ProviderProfile[]): ProviderProfilesView {
    return {
      profiles: (["claude-code", "codex"] as const).map((provider) => {
        const p = profiles.find((x) => x.provider === provider);
        return {
          provider,
          declaredPlan: p?.declaredPlan ?? null,
          usagePolicy: p?.usagePolicy ?? null,
          paidUsageEnabled: p ? p.paidUsageEnabled : null,
          detected: this.#teamProviders.find((t) => t.provider === provider) ?? null,
          capability: this.#providerCapabilities.find((c) => c.id === provider) ?? null,
        };
      }),
      capabilities: this.#providerCapabilities,
    };
  }

  async loadWorkspaces() {
    this.#workspaces = await listWorkspaceStates(this.#o.configDir);
    this.#changed();
    return this.#workspaces;
  }

  /** Registers every known workspace and attached conversation with ThreadLink. */
  async sync(): Promise<void> {
    await this.loadWorkspaces();
    for (const ws of this.#workspaces) await this.#syncWorkspace(ws);
    this.#changed();
  }

  async #syncWorkspace(ws: WorkspaceState): Promise<void> {
    const repo = await this.#o
      .repo(ws.workspace)
      .catch(() => ({ remote: null, fingerprint: null, branch: null }));
    const { workspaceId } = await this.#o.api.upsertWorkspace({
      workspaceKey: ws.workspaceKey,
      displayName: workspaceDisplayName(ws.workspace),
      path: ws.workspace,
      repoRemote: repo.remote,
      repoFingerprint: repo.fingerprint,
      branch: repo.branch,
    });
    ws.workspaceId = workspaceId;
    for (const c of ws.conversations) {
      const { sessionId } = await this.#o.api.registerConversation({
        workspaceId,
        localBindingRef: c.localBindingRef,
        displayName: (c.title ?? defaultConversationName(c.mode)).slice(0, 100),
        provider: c.provider,
        mode: c.mode,
        nativeSessionId: c.nativeSessionId,
        workerNativeSessionId: c.workerNativeSessionId ?? null,
      });
      c.sessionId = sessionId;
    }
    await saveWorkspaceState(this.#o.configDir, ws);
  }

  async addWorkspace(path: string): Promise<WorkspaceState> {
    const abs = resolve(path);
    if (!existsSync(abs)) throw new Error("That folder does not exist.");
    const ws = await loadWorkspaceState(this.#o.configDir, abs);
    await saveWorkspaceState(this.#o.configDir, ws);
    await this.loadWorkspaces();
    if (this.#runtime) await this.#syncWorkspace(this.#find(abs));
    this.#changed();
    return this.#find(abs);
  }

  #find(path: string): WorkspaceState {
    const abs = resolve(path).toLowerCase();
    const ws = this.#workspaces.find((w) => resolve(w.workspace).toLowerCase() === abs);
    if (!ws) throw new Error("Unknown workspace.");
    return ws;
  }

  /** Existing conversations in a workspace with busy/attached state (metadata only). */
  async discoverConversations(path: string, provider = "claude-code") {
    const adapter = this.#adapter(provider);
    const [list, running] = await Promise.all([
      adapter.discoverConversations(path),
      adapter.runningConversationIds().catch(() => null),
    ]);
    const attached = new Set(
      this.#workspaces
        .find((w) => resolve(w.workspace).toLowerCase() === resolve(path).toLowerCase())
        ?.conversations.map((c) => c.nativeSessionId) ?? [],
    );
    return list.map((c) => ({
      ...c,
      busy: running ? running.has(c.nativeSessionId) : null,
      attached: attached.has(c.nativeSessionId),
      runtime: this.#runtime?.label ?? this.#o.identity.label,
    }));
  }

  async discoverWorkspaces(provider = "claude-code") {
    return this.#adapter(provider).discoverWorkspaces();
  }

  /** Attach an existing conversation (nativeSessionId) or a fresh-per-request binding (null). */
  /**
   * Attaches a Claude conversation.
   *
   * `mode` defaults to "worker": delegation should not require closing Claude
   * Code, so the everyday choice is a background worker branched from this
   * conversation. "resume" is the explicit, advanced choice that writes into
   * the conversation itself and refuses while it is open.
   */
  async attach(
    path: string,
    nativeSessionId: string | null,
    title: string | null,
    mode: AttachedConversation["mode"] = nativeSessionId ? "worker" : "fresh",
  ): Promise<ConversationView> {
    const ws = await this.addWorkspace(path);
    const adapter = this.#adapter("claude-code");
    if (nativeSessionId && !(await adapter.conversationExists(ws.workspace, nativeSessionId))) {
      throw new Error("That Claude conversation does not exist in this workspace.");
    }
    if (mode !== "fresh" && !nativeSessionId) mode = "fresh";
    let conv = ws.conversations.find((c) =>
      nativeSessionId
        ? c.nativeSessionId === nativeSessionId && c.mode === mode
        : c.mode === "fresh",
    );
    if (!conv) {
      conv = {
        provider: "claude-code",
        mode,
        nativeSessionId,
        title,
        // Exact and background use of the same conversation are different
        // bindings, so each keeps its own ThreadLink session and links.
        localBindingRef:
          mode === "worker" && nativeSessionId
            ? `cc-worker:${nativeSessionId}`
            : newLocalBindingRef(nativeSessionId),
        attachedAt: new Date().toISOString(),
      } satisfies AttachedConversation;
      ws.conversations.push(conv);
    } else if (title) {
      conv.title = title;
    }
    await saveWorkspaceState(this.#o.configDir, ws);
    if (this.#runtime) await this.#syncWorkspace(ws);
    this.#changed();
    return this.snapshot()
      .workspaces.find((w) => w.path === ws.workspace)!
      .conversations.find((c) => c.localBindingRef === conv.localBindingRef)!;
  }

  /**
   * Changes how an already-attached conversation runs, keeping everything else.
   *
   * The binding keeps its local reference, so ThreadLink re-registers the SAME
   * session: the ChatGPT link, the workspace and this Runtime all survive. That
   * is the whole point -- switching from "exact conversation" to "background
   * worker" must not mean setting the device up again.
   *
   * The user's own Claude conversation is never touched: worker mode branches
   * from it, and switching back to exact mode simply resumes it again.
   */
  async setConversationMode(
    path: string,
    localBindingRef: string,
    mode: AttachedConversation["mode"],
  ): Promise<ConversationView> {
    const ws = this.#find(path);
    const conv = ws.conversations.find((c) => c.localBindingRef === localBindingRef);
    if (!conv) throw new Error("That conversation is not attached on this computer.");

    if (mode !== "fresh" && !conv.nativeSessionId) {
      throw new Error(
        "This binding starts a new Claude conversation each time, so there is no " +
          "conversation to run in the background or resume. Attach one instead.",
      );
    }
    if (mode === "fresh") {
      throw new Error("Detach this conversation instead of turning it into a new one each time.");
    }

    // Never fall back silently: a provider that cannot do this says so.
    const can = this.#adapter(conv.provider).supports();
    if (mode === "worker" && !can.supportsBackgroundWorker) {
      throw new Error(BACKGROUND_UNSUPPORTED_MESSAGE);
    }
    if (mode === "resume" && !can.supportsExactResume) {
      throw new Error(`${conv.provider} cannot resume an existing conversation on this computer.`);
    }

    if (conv.mode !== mode) {
      conv.mode = mode;
      // A worker conversation only means something in worker mode, and the
      // server rejects one otherwise. Keeping it locally would be a lie about
      // which conversation this binding writes to.
      if (mode !== "worker") conv.workerNativeSessionId = undefined;
      await saveWorkspaceState(this.#o.configDir, ws);
      // Re-registering under the same local reference updates the mode on the
      // existing session rather than creating another one.
      if (this.#runtime) await this.#syncWorkspace(ws);
      this.#changed();
    }
    return this.snapshot()
      .workspaces.find((w) => w.path === ws.workspace)!
      .conversations.find((c) => c.localBindingRef === localBindingRef)!;
  }

  /** Stop delivering to a conversation locally (links remain until unlinked in ThreadLink). */
  async detach(path: string, localBindingRef: string): Promise<void> {
    const ws = this.#find(path);
    ws.conversations = ws.conversations.filter((c) => c.localBindingRef !== localBindingRef);
    await saveWorkspaceState(this.#o.configDir, ws);
    this.#changed();
  }

  /**
   * Asks ThreadLink which of THIS Runtime's sessions have link requests.
   *
   * Discovery deliberately does not start from local files: a conversation
   * that has been detached here still has a real pending request, and hiding
   * it left the user with no way to approve or decline it.
   */
  async refreshPendingLinks(): Promise<PendingLink[]> {
    const attachedByRef = new Map<string, { ws: WorkspaceState; c: AttachedConversation }>();
    for (const ws of this.#workspaces) {
      for (const c of ws.conversations) attachedByRef.set(c.localBindingRef, { ws, c });
    }

    const found: PendingLink[] = [];
    for (const l of await this.#o.api.runtimeLinks()) {
      if (l.status !== "pending") continue;
      const local = attachedByRef.get(l.conversation.localBindingRef);
      found.push({
        linkId: l.linkId,
        sessionId: l.agentSessionId,
        from: l.controllerDisplayName ?? "A ChatGPT conversation",
        conversation:
          local?.c.title ??
          l.conversation.displayName ??
          l.conversation.workspaceName ??
          "a Claude conversation",
        attached: Boolean(local),
        reattach: local
          ? null
          : {
              workspacePath: l.conversation.workspacePath,
              workspaceName: l.conversation.workspaceName,
              nativeSessionId: l.conversation.nativeSessionId,
              title: l.conversation.displayName,
              mode: conversationMode(l.conversation.mode),
            },
      });
    }

    const known = new Set(this.#pending.map((p) => p.linkId));
    for (const p of found) if (!known.has(p.linkId)) this.#emit({ type: "link-request", link: p });
    this.#pending = found;
    this.#lastLinkPoll = Date.now();
    this.#changed();
    return found;
  }

  /**
   * The request this decision is about. The cached list can be stale - the UI
   * may have been showing it for a while - so ask the server again before
   * giving up. ThreadLink authorizes the decision itself; this only works out
   * which of our sessions to act as.
   */
  async #linkRequest(linkId: string): Promise<PendingLink | null> {
    const cached = this.#pending.find((x) => x.linkId === linkId);
    if (cached) return cached;
    const fresh = await this.refreshPendingLinks();
    return fresh.find((x) => x.linkId === linkId) ?? null;
  }

  async approveLink(linkId: string): Promise<LinkView> {
    const link = await this.#linkRequest(linkId);
    if (!link) throw new Error("That request is no longer waiting for an answer.");
    if (!link.attached) {
      // Never approve on someone's behalf a conversation they detached: which
      // Claude conversation a chat may drive is the user's choice, not ours.
      const where = link.reattach?.workspaceName;
      throw new Error(
        `Attach “${link.conversation}”${where ? ` in ${where}` : ""} again before approving, ` +
          "so ThreadLink knows which Claude conversation to use.",
      );
    }
    const approved = await this.#o.api.approvePairing(link.sessionId, linkId);
    await this.refreshPendingLinks();
    return approved;
  }

  /** Declining never needs the conversation back: the user is saying no. */
  async declineLink(linkId: string): Promise<void> {
    const link = await this.#linkRequest(linkId);
    if (!link) throw new Error("That request is no longer waiting for an answer.");
    await this.#o.api.declinePairing(link.sessionId, linkId);
    await this.refreshPendingLinks();
  }

  /**
   * Attach the conversation a pending request is waiting for. This is the one
   * click out of "detached while a request was pending"; the user still
   * approves afterwards.
   */
  async attachForLink(linkId: string): Promise<PendingLink | null> {
    const link = await this.#linkRequest(linkId);
    if (!link || link.attached) return link;
    const path = link.reattach?.workspacePath;
    if (!path) throw new Error("ThreadLink does not know which folder that conversation is in.");
    if (!existsSync(path)) {
      throw new Error(`That folder is not on this computer any more: ${path}`);
    }
    await this.attach(
      path,
      link.reattach?.nativeSessionId ?? null,
      link.reattach?.title ?? null,
      // Reattach exactly as the request expects: a different mode would be a
      // different binding, and the request would still have nowhere to land.
      link.reattach?.mode,
    );
    const refreshed = await this.refreshPendingLinks();
    return refreshed.find((x) => x.linkId === linkId) ?? null;
  }

  /** Local pause (e.g. from the tray); ThreadLink-side pause is applied via heartbeat. */
  setLocalPause(paused: boolean) {
    this.#localPause = paused;
    this.#setStatus(paused || this.#runtime?.paused ? "paused" : "online");
    this.wake();
  }

  wake() {
    this.#wake?.();
  }

  // -------------------------------------------------------------------------
  // Heartbeat and delivery
  // -------------------------------------------------------------------------
  /**
   * 0.11 §3.1: one heartbeat at a time. The loop sends one when it is due and
   * a timer of its own sends one whenever the loop has not, so a long job, a
   * slow delivery or a wake long-poll can never make the Runtime look offline.
   */
  heartbeat(): Promise<RuntimeView> {
    if (this.#heartbeatInFlight) return this.#heartbeatInFlight;
    const beat = this.#sendHeartbeat().finally(() => {
      this.#heartbeatInFlight = null;
    });
    this.#heartbeatInFlight = beat;
    return beat;
  }

  async #sendHeartbeat(): Promise<RuntimeView> {
    const running = new Set<string>();
    let busyKnown = true;
    try {
      for (const id of await this.#adapter("claude-code").runningConversationIds()) running.add(id);
    } catch {
      busyKnown = false; // unknown: report nothing busy; delivery itself still fails closed
    }
    this.#busy = running;
    const busySessionIds = busyKnown
      ? this.#workspaces.flatMap((w) =>
          w.conversations
            .filter(
              (c) =>
                c.mode === "resume" &&
                c.nativeSessionId &&
                running.has(c.nativeSessionId) &&
                c.sessionId,
            )
            .map((c) => c.sessionId!),
        )
      : [];
    const previous = this.#runtime;
    const runtime = await this.#o.api.runtimeHeartbeat({
      version: this.#o.version,
      protocol: RUNTIME_PROTOCOL,
      capabilities: this.#capabilities,
      busySessionIds,
    });
    this.#runtime = runtime;
    this.#lastHeartbeat = Date.now();
    if (JSON.stringify(previous?.settings) !== JSON.stringify(runtime.settings)) {
      this.#emit({ type: "settings", settings: runtime.settings });
    }
    const config = await loadConfig(this.#o.configDir);
    if (runtime.restartRequestedAt && runtime.restartRequestedAt !== config.lastRestartHandled) {
      await saveConfig(this.#o.configDir, { lastRestartHandled: runtime.restartRequestedAt });
      this.#emit({ type: "restart-requested" });
    }
    this.#changed();
    return runtime;
  }

  #executor(ws: WorkspaceState, c: AttachedConversation): Executor {
    return new DispatchingExecutor(this.#singleExecutor(ws, c), () => this.#teamExecutor(ws, c));
  }

  #singleExecutor(ws: WorkspaceState, c: AttachedConversation): Executor {
    const binding = this.#binding(c);
    // The user's chosen mode is never quietly swapped for another one.
    if (!binding) return new UnsupportedModeExecutor(c.mode, this.#adapter(c.provider).displayName);
    return this.#adapter(c.provider).createExecutor(ws.workspace, binding, {
      permissionMode: this.#permissionMode(c.mode),
      model: this.#o.model,
      lockDir: this.#o.configDir,
    });
  }

  /**
   * A team job runs in this conversation's workspace, authorised by this
   * conversation's ThreadLink session and this Runtime's claim.
   */
  #teamExecutor(ws: WorkspaceState, c: AttachedConversation): Executor {
    if (this.#o.teamExecutor) return this.#o.teamExecutor(ws.workspace, c.sessionId!);
    this.recoverTeamJobs();
    return new TeamExecutor({
      workspace: ws.workspace,
      sessionId: c.sessionId!,
      claimRef: this.#claimRef,
      governor: this.#governor,
      health: this.#health ?? undefined,
      write: (jobId, sessionId, claimRef, op, payload) =>
        this.#o.api.teamWrite(jobId, sessionId, claimRef, op, payload),
      journals: this.#journals,
      processes: this.#processes,
      staleProcesses: this.#staleProcesses,
      activeJobs: this.#activeJobs,
      // 0.11: Fast Chat reuses the last discovery (no CLI spawns per turn),
      // keeps native sessions per chat and sends each failover notice once.
      cachedDiscovery: () => (this.#found.length ? this.#found : null),
      chatSessions: this.#chatSessions,
      noticesSent: this.#noticesSent,
      onProgress: (progress) => {
        this.#team.delete(progress.jobId);
        this.#team.set(progress.jobId, progress);
        while (this.#team.size > 10) this.#team.delete(this.#team.keys().next().value!);
        this.#emit({ type: "team", progress });
        this.#emit({ type: "snapshot", snapshot: this.snapshot() });
      },
      log: this.#o.log,
    });
  }

  /**
   * How this conversation should be run.
   *
   * The execution mode is the user's explicit choice, so it is never quietly
   * changed. A provider that cannot work in the background says so and the
   * task fails with background_mode_unsupported; running it in the user's own
   * conversation instead would be a different, unasked-for thing.
   */
  #binding(c: AttachedConversation): ConversationBinding | null {
    const supports = this.#adapter(c.provider).supports();
    if (c.mode === "worker") {
      if (!supports.supportsBackgroundWorker) return null;
      return {
        mode: "worker",
        // Only seed from the user's conversation if the provider can fork it.
        sourceNativeSessionId: supports.supportsFork ? c.nativeSessionId : null,
        workerNativeSessionId: c.workerNativeSessionId ?? null,
      };
    }
    if (c.mode === "resume") {
      if (!c.nativeSessionId || !supports.supportsExactResume) return null;
      return { mode: "resume", nativeSessionId: c.nativeSessionId };
    }
    return { mode: "fresh" };
  }

  /**
   * A background worker exists to do the work, so it must start in a mode that
   * can actually act. Running it in Plan Mode is how a delegated task ends up
   * alive, busy and achieving nothing.
   *
   * The user's own conversation is left on the configured mode: ThreadLink
   * writes into a conversation they can see, and must not quietly hand itself
   * more permission there than they chose.
   */
  #permissionMode(mode: AttachedConversation["mode"]): string {
    if (mode === "worker") return this.#o.workerPermissionMode;
    return this.#o.permissionMode;
  }

  /**
   * Remembers the background conversation the first run created, so later tasks
   * resume it instead of forking again.
   */
  async #rememberWorker(
    ws: WorkspaceState,
    c: AttachedConversation,
    workerSessionId: string | undefined,
  ): Promise<void> {
    if (!workerSessionId || c.mode !== "worker") return;
    if (c.workerNativeSessionId === workerSessionId) return;
    c.workerNativeSessionId = workerSessionId;
    await saveWorkspaceState(this.#o.configDir, ws);
    this.#changed();
  }

  /** The worker callbacks for one attached conversation: mirror lines built only from safe fields. */
  #workerDeps(ws: WorkspaceState, c: AttachedConversation): WorkerDeps {
    const title = c.title ?? workspaceDisplayName(ws.workspace);
    const mirror = (
      event: ActivityEntry["event"],
      task: { taskId: string; title: string },
      extra: Pick<ActivityEntry, "detail" | "summary" | "blocked"> = {},
    ): void => {
      this.#mirror({
        taskId: task.taskId,
        event,
        title: task.title,
        conversation: title,
        localBindingRef: c.localBindingRef,
        workspace: workspaceDisplayName(ws.workspace),
        mode: c.mode,
        at: new Date().toISOString(),
        ...extra,
      });
    };
    return {
      api: this.#o.api,
      executor: this.#executor(ws, c),
      onWorkerSession: (id) => void this.#rememberWorker(ws, c, id),
      sessionId: c.sessionId!,
      claimRef: this.#claimRef,
      heartbeatMs: this.#o.taskHeartbeatMs,
      log: this.#o.log,
      onStarted: (e) => mirror("task_started", e),
      onBlocked: (e) =>
        mirror("task_blocked", e, {
          blocked: e.reason,
          detail: BLOCKED_DETAIL[e.reason],
        }),
      onOutcome: (e) => {
        if (e.outcome === "completed") this.#tasksCompleted++;
        this.#emit({
          type: "task",
          outcome: e.outcome,
          title: e.title,
          conversation: title,
          reason: e.reason,
        });
        mirror(
          e.outcome === "completed"
            ? "task_completed"
            : e.outcome === "failed"
              ? "task_failed"
              : "task_lost",
          e,
          {
            detail:
              e.outcome === "lost"
                ? "ThreadLink lost track of this task before it finished."
                : e.reason
                  ? FAILURE_DETAIL[e.reason]
                  : undefined,
            summary: e.summary ?? undefined,
          },
        );
      },
    };
  }

  /** Tasks this engine is running now, by lane (for the desktop app and tests). */
  runningTasks(): { taskId: string; lane: TaskLane; chatId: string | null }[] {
    return [...this.#running.values()].map((r) => ({
      taskId: r.taskId,
      lane: r.lane,
      chatId: r.chatId,
    }));
  }

  /**
   * Claims every queued task that may start now and runs each in the
   * background (0.11 §3.3). Limits: the work lane runs at most one job per
   * workspace; the chat lane at most `chatConcurrency` jobs overall, one at a
   * time per chat, oldest first. A chat task behind a queued work task that
   * must wait is still picked. Returns what was started and how many queued
   * tasks had to wait for a limit.
   */
  async #dispatch(): Promise<{ started: RunningTask[]; blocked: number }> {
    const started: RunningTask[] = [];
    let blocked = 0;
    for (const ws of this.#workspaces) {
      if (!existsSync(ws.workspace)) continue;
      const wsKey = resolve(ws.workspace).toLowerCase();
      for (const c of ws.conversations) {
        if (!c.sessionId) continue;
        if (this.#fatal) return { started, blocked };
        const inbox = await this.#o.api.inbox(c.sessionId, 20);
        /** Chats whose oldest queued task was already considered (FIFO per chat). */
        const seenChats = new Set<string>();
        for (const next of inbox) {
          if (next.status !== "queued" || this.#running.has(next.taskId)) continue;
          const { lane, chatId } = taskLane(next);
          const running = [...this.#running.values()];
          if (lane === "work") {
            if (running.some((r) => r.lane === "work" && r.workspace === wsKey)) {
              blocked++;
              continue;
            }
          } else {
            const chatKey = chatId ?? `task:${next.taskId}`;
            const first = !seenChats.has(chatKey);
            seenChats.add(chatKey);
            if (
              !first ||
              running.filter((r) => r.lane === "chat").length >= this.#o.chatConcurrency ||
              (chatId !== null && running.some((r) => r.lane === "chat" && r.chatId === chatId))
            ) {
              blocked++;
              continue;
            }
          }
          const deps = this.#workerDeps(ws, c);
          const task = await claimTask(deps, next);
          if (task === "skipped") continue;
          const entry: RunningTask = {
            taskId: task.taskId,
            lane,
            workspace: wsKey,
            chatId,
            done: Promise.resolve("error" as const),
          };
          this.#running.set(task.taskId, entry);
          entry.done = runClaimedTask(deps, task)
            .catch((error: unknown): "error" => {
              if (
                error instanceof ApiError &&
                (error.status === 401 || error.status === 403 || error.kind === "not-threadlink")
              ) {
                this.#fatal ??= error;
              } else {
                this.#o.log?.(
                  `task ${task.taskId} stopped: ${error instanceof ApiError ? `${error.status} ${error.kind}` : "unexpected error"}`,
                );
              }
              return "error";
            })
            .finally(() => {
              this.#running.delete(task.taskId);
              this.#changed();
              // A slot is free: look for the next task now.
              this.wake();
            });
          started.push(entry);
        }
      }
    }
    if (started.length) this.#changed();
    return { started, blocked };
  }

  /**
   * Starts what may start now and waits for those tasks to finish (the
   * pre-0.11 contract, kept for callers and tests that deliver by hand).
   * Returns tasks started.
   */
  async deliverOnce(): Promise<number> {
    let total = 0;
    // A task held back by a lane limit gets its turn once the slot frees:
    // bounded passes, each waiting for what it started.
    for (let pass = 0; pass < 10; pass++) {
      const { started, blocked } = await this.#dispatch();
      await Promise.all(started.map((t) => t.done));
      total += started.length;
      if (this.#fatal) {
        const fatal = this.#fatal;
        this.#fatal = null;
        throw fatal;
      }
      if (!started.length || !blocked) break;
    }
    return total;
  }

  /**
   * 0.11 §3.2: waits for work with the server's wake long-poll. One request
   * in flight at a time (an interrupted wait is picked up again, not
   * duplicated). "unsupported" when the server has no wake endpoint or it
   * failed: the caller then uses the idle back-off.
   */
  async #waitForWork(
    signal: AbortSignal,
  ): Promise<"pending" | "timeout" | "unsupported" | "woken"> {
    const wake = this.#o.api.wake;
    if (!wake || this.#o.wakeWaitSeconds <= 0) return "unsupported";
    if (!this.#wakeSupported && Date.now() < this.#wakeRetryAt) return "unsupported";
    this.#wakeSupported = true;
    if (!this.#wakeInFlight) {
      this.#wakeInFlight = wake.call(this.#o.api, this.#o.wakeWaitSeconds).finally(() => {
        this.#wakeInFlight = null;
      });
    }
    const inFlight = this.#wakeInFlight;
    let woken: () => void = () => {};
    const local = new Promise<"woken">((r) => {
      woken = () => r("woken");
      this.#wake = woken;
    });
    const onAbort = () => woken();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([
        inFlight.then(
          (r) => (r.pending > 0 ? ("pending" as const) : ("timeout" as const)),
          (error: unknown) => {
            // 404 / HTML: an older server. Other errors: try again later.
            const older =
              error instanceof ApiError &&
              (error.status === 404 || error.status === 405 || error.kind === "not-threadlink");
            this.#wakeSupported = false;
            this.#wakeRetryAt = Date.now() + (older ? 10 * 60_000 : 30_000);
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
              this.#fatal ??= error;
            }
            return "unsupported" as const;
          },
        ),
        local,
      ]);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#wake === woken) this.#wake = null;
    }
  }

  /** Runs until the signal aborts, the credential is rejected, or the runtime is revoked. */
  async run(signal: AbortSignal): Promise<EngineStatus> {
    const release = acquireSessionLock(this.#o.configDir, "runtime");
    if (!release) {
      this.#setStatus("stopped", "Another ThreadLink Runtime is already running on this machine.");
      return "stopped";
    }
    const stop = () => this.wake();
    signal.addEventListener("abort", stop, { once: true });
    let failures = 0;
    let idle = 0;
    let ready = false;
    /** The last wake said work was queued: if none is claimable, back off. */
    let expectWork = false;
    // 0.11 §3.1: the heartbeat's own timer. It only sends when the loop has
    // not (one heartbeat in flight at most); its failures are the loop's to
    // report, so they are only logged here.
    const beatEvery = this.#o.heartbeatMs > 0 ? this.#o.heartbeatMs : 1_000;
    const beatTimer = setInterval(() => {
      if (!ready || signal.aborted) return;
      if (Date.now() - this.#lastHeartbeat < this.#o.heartbeatMs) return;
      this.heartbeat().catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          this.#fatal ??= error;
          this.wake();
        }
      });
    }, beatEvery);
    beatTimer.unref?.();
    try {
      this.#setStatus("starting");
      this.recoverTeamJobs();
      while (!signal.aborted) {
        let delay: number;
        try {
          if (!ready) {
            await this.detectProviders();
            await this.register();
            await this.sync();
            await this.heartbeat();
            await this.refreshPendingLinks();
            ready = true;
          }
          if (this.#fatal) {
            const fatal = this.#fatal;
            this.#fatal = null;
            throw fatal;
          }
          if (Date.now() - this.#lastHeartbeat >= this.#o.heartbeatMs) await this.heartbeat();
          if (Date.now() - this.#lastLinkPoll >= this.#o.linkPollMs)
            await this.refreshPendingLinks();
          failures = 0;
          const paused = this.#localPause || this.#runtime?.paused;
          this.#setStatus(paused ? "paused" : "online");
          const { started, blocked } = paused
            ? { started: [], blocked: 0 }
            : await this.#dispatch();
          idle = started.length ? 0 : idle + 1;
          // Idle: keep provider health fresh (at most every 30 minutes).
          if (!started.length) void this.#healthTick();
          const expected = expectWork;
          expectWork = false;
          if (started.length) {
            delay = 250;
          } else if (!paused && !blocked && !expected) {
            // Nothing waiting here: wait for work with the long-poll (§3.2).
            const waited = await this.#waitForWork(signal);
            if (this.#fatal) continue;
            expectWork = waited === "pending";
            delay =
              waited === "unsupported"
                ? nextDelay(Math.min(idle, 4), this.#o.backoff, this.#o.random)
                : 0;
          } else if (expected && !paused && !blocked) {
            // The server said work was queued but none of it could be claimed
            // here: never spin on the long-poll; back off briefly instead.
            delay = nextDelay(Math.min(idle, 2), this.#o.backoff, this.#o.random);
          } else {
            // Paused, or queued work is waiting for a free slot: a finishing
            // task wakes the loop; otherwise the ordinary back-off.
            delay = nextDelay(Math.min(idle, 4), this.#o.backoff, this.#o.random);
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            this.#setStatus(
              "signed-out",
              "ThreadLink sign-in is no longer valid. Sign in again.",
              true,
            );
            return "signed-out";
          }
          if (error instanceof ApiError && error.status === 403) {
            this.#setStatus("revoked", "This Runtime was disconnected in ThreadLink.", true);
            return "revoked";
          }
          if (error instanceof ApiError && error.kind === "not-threadlink") {
            // Retrying cannot fix an address that serves something else.
            this.#setStatus(
              "wrong-address",
              `${this.#o.baseUrlLabel} is not answering as ThreadLink. Reconnect to continue.`,
              true,
            );
            return "wrong-address";
          }
          failures++;
          if (isNetworkError(error) || !(error instanceof ApiError)) {
            // Keep retrying, but after a while stop pretending it is momentary.
            const stuck = failures >= 6;
            this.#setStatus(
              "offline",
              stuck
                ? "Still can't reach ThreadLink. Check your connection, or reconnect."
                : "Can't reach ThreadLink. Retrying…",
              stuck,
            );
            ready = ready && failures < 3; // re-register after repeated failures (reboot/sleep)
          } else {
            this.#o.log?.(`runtime error (${error.status} ${error.kind})`);
          }
          delay = nextDelay(failures, this.#o.backoff, this.#o.random);
        }
        if (delay > 0 && !signal.aborted) {
          await Promise.race([
            this.#o.sleep(delay, signal),
            new Promise<void>((r) => {
              this.#wake = r;
            }),
          ]);
          this.#wake = null;
        }
      }
      this.#setStatus("stopped");
      return "stopped";
    } finally {
      signal.removeEventListener("abort", stop);
      // Jobs already running finish (as before 0.11, when the loop itself ran
      // them); their leases and heartbeats continue until then.
      await Promise.allSettled([...this.#running.values()].map((r) => r.done));
      clearInterval(beatTimer);
      release();
    }
  }
}
