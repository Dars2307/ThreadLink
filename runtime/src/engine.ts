import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ProviderAdapter } from "./adapters/types.ts";
import { ApiError, type LinkView, type RuntimeView, type ThreadLinkApi } from "./api.ts";
import { DEFAULT_BACKOFF, nextDelay, type BackoffOptions } from "./backoff.ts";
import { acquireSessionLock, type Executor } from "./executor.ts";
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
  mode: "resume" | "fresh";
  nativeSessionId: string | null;
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
        displayName: (
          c.title ?? (c.mode === "fresh" ? "New conversation per request" : "Claude conversation")
        ).slice(0, 100),
        provider: c.provider,
        mode: c.mode,
        nativeSessionId: c.nativeSessionId,
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
  async attach(
    path: string,
    nativeSessionId: string | null,
    title: string | null,
  ): Promise<ConversationView> {
    const ws = await this.addWorkspace(path);
    const adapter = this.#adapter("claude-code");
    if (nativeSessionId && !(await adapter.conversationExists(ws.workspace, nativeSessionId))) {
      throw new Error("That Claude conversation does not exist in this workspace.");
    }
    let conv = ws.conversations.find((c) =>
      nativeSessionId ? c.nativeSessionId === nativeSessionId : c.mode === "fresh",
    );
    if (!conv) {
      conv = {
        provider: "claude-code",
        mode: nativeSessionId ? "resume" : "fresh",
        nativeSessionId,
        title,
        localBindingRef: newLocalBindingRef(nativeSessionId),
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

  async refreshPendingLinks(): Promise<PendingLink[]> {
    const found: PendingLink[] = [];
    for (const ws of this.#workspaces) {
      for (const c of ws.conversations) {
        if (!c.sessionId) continue;
        for (const l of await this.#o.api.links(c.sessionId)) {
          if (l.status === "pending") {
            found.push({
              linkId: l.linkId,
              sessionId: c.sessionId,
              from: l.controllerDisplayName ?? "A ChatGPT conversation",
              conversation: c.title ?? workspaceDisplayName(ws.workspace),
            });
          }
        }
      }
    }
    const known = new Set(this.#pending.map((p) => p.linkId));
    for (const p of found) if (!known.has(p.linkId)) this.#emit({ type: "link-request", link: p });
    this.#pending = found;
    this.#lastLinkPoll = Date.now();
    this.#changed();
    return found;
  }

  /**
   * Which of our conversations this link is for. The cached list can be stale -
   * the UI may have been showing the request for a while - so ask the server
   * again before giving up. ThreadLink authorizes the approval itself; this
   * only works out which session to approve it as.
   */
  async #linkSession(linkId: string): Promise<string | null> {
    const cached = this.#pending.find((x) => x.linkId === linkId);
    if (cached) return cached.sessionId;
    const fresh = await this.refreshPendingLinks();
    return fresh.find((x) => x.linkId === linkId)?.sessionId ?? null;
  }

  async approveLink(linkId: string): Promise<LinkView> {
    const sessionId = await this.#linkSession(linkId);
    if (!sessionId) {
      throw new Error(
        "This request is for a Claude conversation that is not attached on this computer any more. Attach it again, then approve.",
      );
    }
    const link = await this.#o.api.approvePairing(sessionId, linkId);
    await this.refreshPendingLinks();
    return link;
  }

  async declineLink(linkId: string): Promise<void> {
    const sessionId = await this.#linkSession(linkId);
    if (!sessionId) {
      throw new Error(
        "This request is for a Claude conversation that is not attached on this computer any more.",
      );
    }
    await this.#o.api.declinePairing(sessionId, linkId);
    await this.refreshPendingLinks();
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
    return this.#adapter(c.provider).createExecutor(
      ws.workspace,
      c.mode === "resume" && c.nativeSessionId
        ? { mode: "resume", nativeSessionId: c.nativeSessionId }
        : { mode: "fresh" },
      { permissionMode: this.#o.permissionMode, model: this.#o.model, lockDir: this.#o.configDir },
    );
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
