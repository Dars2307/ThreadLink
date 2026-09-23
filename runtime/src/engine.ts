import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ConversationBinding, ProviderAdapter } from "./adapters/types.ts";
import { ApiError, type LinkView, type RuntimeView, type ThreadLinkApi } from "./api.ts";
import { DEFAULT_BACKOFF, nextDelay, type BackoffOptions } from "./backoff.ts";
import {
  acquireSessionLock,
  BACKGROUND_UNSUPPORTED_MESSAGE,
  type ExecutionResult,
  type Executor,
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
import { processNextTask } from "./worker.ts";

/**
 * The ThreadLink Runtime engine, shared by the CLI (`threadlink run`) and the
 * desktop app. One engine per machine/config directory (enforced by a lock).
 *
 * Loop: register -> sync workspaces/conversations -> repeat {
 *   heartbeat (capabilities, busy conversations; receives pause/restart/settings)
 *   for each attached conversation: deliver at most one task
 * } with idle back-off, offline back-off and 401 -> signed out.
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
  providers: { id: string; name: string; available: boolean; version: string | null }[];
  workspaces: WorkspaceView[];
  pendingLinks: PendingLink[];
  lastHeartbeatAt: string | null;
  tasksCompleted: number;
  /**
   * True once the trouble has lasted long enough that the user should be
   * offered a way out (sign in again / check the address) instead of watching
   * "Reconnecting..." forever. The engine keeps retrying regardless.
   */
  needsAttention: boolean;
};

export type EngineEvent =
  | { type: "snapshot"; snapshot: EngineSnapshot }
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
>;

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

const isNetworkError = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);

export class RuntimeEngine {
  readonly #o: Required<Omit<EngineOptions, "model" | "log">> &
    Pick<EngineOptions, "model" | "log">;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  readonly #claimRef = `runtime-${randomUUID()}`;
  #status: EngineStatus = "idle";
  #detail: string | null = null;
  #needsAttention = false;
  #runtime: RuntimeView | null = null;
  #providers: EngineSnapshot["providers"] = [];
  #capabilities: Record<string, string> = {};
  #workspaces: WorkspaceState[] = [];
  #busy = new Set<string>();
  #pending: PendingLink[] = [];
  #lastHeartbeat = 0;
  #lastLinkPoll = 0;
  #tasksCompleted = 0;
  #wake: (() => void) | null = null;
  #localPause = false;

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
      ...options,
    };
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
          busy: Boolean(c.nativeSessionId && this.#busy.has(c.nativeSessionId)),
        })),
      })),
      pendingLinks: this.#pending,
      lastHeartbeatAt: this.#lastHeartbeat ? new Date(this.#lastHeartbeat).toISOString() : null,
      tasksCompleted: this.#tasksCompleted,
      needsAttention: this.#needsAttention,
    };
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
      this.#providers.push({
        id: a.id,
        name: a.displayName,
        available: d.available,
        version: d.version,
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
    });
    this.#runtime = runtime;
    await saveConfig(this.#o.configDir, { runtimeId: runtime.runtimeId });
    this.#changed();
    return runtime;
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
  async heartbeat(): Promise<RuntimeView> {
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
            .filter((c) => c.nativeSessionId && running.has(c.nativeSessionId) && c.sessionId)
            .map((c) => c.sessionId!),
        )
      : [];
    const previous = this.#runtime;
    const runtime = await this.#o.api.runtimeHeartbeat({
      version: this.#o.version,
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

  /** Delivers at most one task per attached conversation. Returns tasks processed. */
  async deliverOnce(): Promise<number> {
    let processed = 0;
    for (const ws of this.#workspaces) {
      if (!existsSync(ws.workspace)) continue;
      for (const c of ws.conversations) {
        if (!c.sessionId) continue;
        const title = c.title ?? workspaceDisplayName(ws.workspace);
        const outcome = await processNextTask({
          api: this.#o.api,
          executor: this.#executor(ws, c),
          onWorkerSession: (id) => void this.#rememberWorker(ws, c, id),
          sessionId: c.sessionId,
          claimRef: this.#claimRef,
          heartbeatMs: this.#o.taskHeartbeatMs,
          log: this.#o.log,
          onOutcome: (e) => {
            if (e.outcome === "completed") this.#tasksCompleted++;
            this.#emit({
              type: "task",
              outcome: e.outcome,
              title: e.title,
              conversation: title,
              reason: e.reason,
            });
          },
        });
        if (outcome !== "none" && outcome !== "skipped") processed++;
      }
    }
    if (processed) this.#changed();
    return processed;
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
    try {
      this.#setStatus("starting");
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
          if (Date.now() - this.#lastHeartbeat >= this.#o.heartbeatMs) await this.heartbeat();
          if (Date.now() - this.#lastLinkPoll >= this.#o.linkPollMs)
            await this.refreshPendingLinks();
          failures = 0;
          const paused = this.#localPause || this.#runtime?.paused;
          this.#setStatus(paused ? "paused" : "online");
          const processed = paused ? 0 : await this.deliverOnce();
          idle = processed ? 0 : idle + 1;
          delay = processed ? 250 : nextDelay(Math.min(idle, 4), this.#o.backoff, this.#o.random);
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
        await Promise.race([
          this.#o.sleep(delay, signal),
          new Promise<void>((r) => {
            this.#wake = r;
          }),
        ]);
        this.#wake = null;
      }
      this.#setStatus("stopped");
      return "stopped";
    } finally {
      signal.removeEventListener("abort", stop);
      release();
    }
  }
}
