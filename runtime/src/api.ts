/**
 * Minimal ThreadLink client for the bridge. The bearer token is the bridge's
 * connection credential; it is only ever sent in the Authorization header and
 * never logged or included in errors.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  /** A fixed reason code the server passed through (e.g. interrupted_needs_owner). */
  readonly reason: string | null;
  constructor(status: number, kind: string, reason: string | null = null) {
    super(`ThreadLink request failed (${status} ${kind}${reason ? `: ${reason}` : ""})`);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.reason = reason;
  }
}

export type Artifact = { type: string; reference: string; metadata?: Record<string, unknown> };

export type TaskEnvelope = {
  taskId: string;
  /** Set by the server when the task is created; "team" means a Team Mode job. */
  taskType?: string;
  title: string;
  content: string | null;
  priority: string;
  status: string;
  claimRef?: string | null;
  attemptCount?: number;
  claimedUntil?: string | null;
  /** 0.11 (§3.6): server timestamps, for queue-time telemetry only. */
  createdAt?: string | null;
  claimedAt?: string | null;
};

/** The longest wake long-poll the Runtime asks for (§3.2: ≤ 25 s). */
export const WAKE_MAX_WAIT_SECONDS = 25;

/**
 * A link request as the Runtime sees it: scoped to this Runtime's own
 * sessions, with enough about the conversation to find it locally - or to
 * offer attaching it again. Never carries the controller's session id.
 */
export type RuntimeLinkView = {
  linkId: string;
  status: "pending" | "active";
  paused: boolean;
  agentSessionId: string;
  controllerDisplayName: string | null;
  requestedAt: string;
  approvedAt: string | null;
  conversation: {
    displayName: string | null;
    localBindingRef: string;
    provider: string | null;
    mode: string | null;
    nativeSessionId: string | null;
    workspaceId: string | null;
    workspaceName: string | null;
    workspacePath: string | null;
  };
};

export type LinkView = {
  linkId: string;
  controllerSessionId: string;
  agentSessionId: string;
  controllerDisplayName: string | null;
  status: string;
  paused?: boolean;
};

export type RuntimeView = {
  runtimeId: string;
  label: string;
  platform: string;
  kind: string;
  paused: boolean;
  restartRequestedAt: string | null;
  settings: { autoStart?: boolean; autoReconnect?: boolean; notifications?: boolean };
  status: string;
};

/** One provider profile as the server returns it (GET/PATCH /api/team/providers). */
export type ProviderProfile = {
  provider: "claude-code" | "codex";
  declaredPlan: string;
  usagePolicy: string | null;
  paidUsageEnabled: boolean;
  detected: Record<string, unknown>;
  detectedAt: string | null;
};

const PLAN_VALUE = /^[a-z0-9_]{1,40}$/;

/** `{ profiles: [...] }` to typed profiles; anything malformed is dropped. */
export function parseProviderProfiles(res: unknown): ProviderProfile[] {
  if (!res || typeof res !== "object") return [];
  const list = (res as Record<string, unknown>).profiles;
  if (!Array.isArray(list)) return [];
  const out: ProviderProfile[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    if (p.provider !== "claude-code" && p.provider !== "codex") continue;
    if (typeof p.declaredPlan !== "string" || !PLAN_VALUE.test(p.declaredPlan)) continue;
    if (out.some((o) => o.provider === p.provider)) continue;
    out.push({
      provider: p.provider,
      declaredPlan: p.declaredPlan,
      usagePolicy: typeof p.usagePolicy === "string" ? p.usagePolicy.slice(0, 40) : null,
      paidUsageEnabled: p.paidUsageEnabled === true,
      detected:
        p.detected && typeof p.detected === "object" && !Array.isArray(p.detected)
          ? (p.detected as Record<string, unknown>)
          : {},
      detectedAt: typeof p.detectedAt === "string" ? p.detectedAt.slice(0, 40) : null,
    });
  }
  return out;
}

export type ApiOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function validateBaseUrl(raw: string): string {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("ThreadLink URL must use https (http is allowed only for localhost)");
  }
  return url.origin;
}

export class ThreadLinkApi {
  #baseUrl: string;
  #token: string;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(options: ApiOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    let response: Response;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        redirect: "error",
      });
    } catch {
      throw new ApiError(0, "network");
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // A ThreadLink API always answers with JSON. HTML here means the address
    // points at something else - typically an old deployment that predates this
    // endpoint, and serves its not-found page instead. Say so plainly rather
    // than handing the caller an empty object.
    if (json === null && text.trim() !== "") {
      throw new ApiError(response.status, "not-threadlink");
    }
    if (!response.ok) {
      const kind =
        json && typeof json === "object" && "error" in json ? String(json.error) : "error";
      const raw = json && typeof json === "object" && "reason" in json ? json.reason : null;
      const reason = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : null;
      throw new ApiError(response.status, kind, reason);
    }
    return json as T;
  }

  whoami() {
    return this.#request<{ connectionId: string; platform: string; role: string; status: string }>(
      "GET",
      "/api/connection/whoami",
    );
  }

  registerSession(input: { localBindingRef: string; displayName?: string }) {
    return this.#request<{
      created: boolean;
      session: { sessionId: string; displayName: string | null };
    }>("POST", "/api/session/register", input);
  }

  async links(sessionId: string): Promise<LinkView[]> {
    const res = await this.#request<{ links: LinkView[] }>(
      "GET",
      `/api/pairing?sessionId=${encodeURIComponent(sessionId)}`,
    );
    return res.links;
  }

  approvePairing(sessionId: string, linkId: string) {
    return this.#request<LinkView>("POST", "/api/pairing/approve", { sessionId, linkId });
  }

  /**
   * 0.11 (§3.2) wake long-poll: answers as soon as a task for one of this
   * Runtime's sessions is queued, or with `{pending: 0}` after `waitSeconds`.
   * A server without it answers 404, and the caller falls back to polling.
   */
  async wake(waitSeconds: number, signal?: AbortSignal): Promise<{ pending: number }> {
    const wait = Math.max(0, Math.min(WAKE_MAX_WAIT_SECONDS, Math.floor(waitSeconds)));
    const res = await this.#request<{ pending?: unknown }>(
      "GET",
      `/api/runtime/wake?wait=${wait}`,
      undefined,
      // The request itself may take the whole wait; allow for the network too.
      { timeoutMs: (wait + 15) * 1000, signal },
    );
    const pending = res && typeof res === "object" ? res.pending : null;
    return {
      pending: typeof pending === "number" && Number.isFinite(pending) && pending > 0 ? pending : 0,
    };
  }

  async inbox(sessionId: string, limit = 10): Promise<TaskEnvelope[]> {
    const res = await this.#request<{ tasks: TaskEnvelope[] }>(
      "GET",
      `/api/tasks/inbox?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
    );
    return res.tasks;
  }

  /**
   * Tells ThreadLink what a Team Mode agent looks like on this computer. Only
   * a Team-capable Runtime sends this, which is what lets the server refuse to
   * hand a team job to an older one. Never carries a token, email or account id.
   */
  reportProviderDetection(provider: "claude-code" | "codex", detected: Record<string, unknown>) {
    return this.#request<Record<string, unknown>>("POST", "/api/team/providers", {
      provider,
      detected,
    });
  }

  /**
   * The owner's provider profiles (declared plan, usage policy, paid usage) and
   * the last detection this account reported. Parsed tolerantly: an entry that
   * is not a well-formed profile is dropped, never guessed at.
   */
  async providerProfiles(): Promise<ProviderProfile[]> {
    const res = await this.#request<unknown>("GET", "/api/team/providers");
    return parseProviderProfiles(res);
  }

  /**
   * Sets the owner's declared plan for one provider -- and nothing else: a
   * Runtime cannot change usage policy or paid usage. The server validates the
   * plan against the provider's list and audits the change. Returns the updated
   * profiles.
   */
  async setDeclaredPlan(
    provider: "claude-code" | "codex",
    declaredPlan: string,
  ): Promise<{ profiles: ProviderProfile[] }> {
    const res = await this.#request<unknown>("PATCH", "/api/team/providers", {
      provider,
      declaredPlan,
    });
    // The server answers with the one updated profile; the caller wants them all.
    if (res && typeof res === "object" && Array.isArray((res as { profiles?: unknown }).profiles)) {
      return { profiles: parseProviderProfiles(res) };
    }
    return { profiles: await this.providerProfiles() };
  }

  /**
   * Writes one piece of a team job's state. Authorised by the carrier task's
   * claim: only the session holding `claimRef` for that job's task may write.
   */
  teamWrite(jobId: string, sessionId: string, claimRef: string, op: string, payload: unknown) {
    return this.#request<Record<string, unknown>>(
      "POST",
      `/api/team/jobs/${encodeURIComponent(jobId)}/state`,
      { sessionId, claimRef, op, payload },
    );
  }

  #step(taskId: string, step: string, body: Record<string, unknown>) {
    return this.#request<TaskEnvelope>(
      "POST",
      `/api/tasks/${encodeURIComponent(taskId)}/${step}`,
      body,
    );
  }

  claim(taskId: string, sessionId: string, claimRef: string) {
    return this.#step(taskId, "claim", { sessionId, claimRef });
  }
  start(taskId: string, sessionId: string, claimRef: string) {
    return this.#step(taskId, "start", { sessionId, claimRef });
  }
  heartbeat(taskId: string, sessionId: string, claimRef: string) {
    return this.#step(taskId, "heartbeat", { sessionId, claimRef });
  }
  progress(taskId: string, sessionId: string, claimRef: string, content: string) {
    return this.#step(taskId, "progress", { sessionId, claimRef, content });
  }
  /**
   * "Alive, but not progressing": Plan Mode, or waiting on a person. The task
   * keeps its claim and its lease; this only stops it claiming to be working.
   */
  blocked(
    taskId: string,
    sessionId: string,
    claimRef: string,
    reason: "plan_mode" | "approval_required" | "user_input_required",
  ) {
    return this.#step(taskId, "blocked", { sessionId, claimRef, reason });
  }
  complete(
    taskId: string,
    sessionId: string,
    claimRef: string,
    result: string,
    artifacts: Artifact[],
  ) {
    return this.#step(taskId, "complete", { sessionId, claimRef, result, artifacts });
  }
  fail(
    taskId: string,
    sessionId: string,
    claimRef: string,
    error: string,
    failureReason?: "session_busy" | "native_session_unavailable" | "background_mode_unsupported",
  ) {
    return this.#step(taskId, "fail", {
      sessionId,
      claimRef,
      error,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  /** Decline (revoke) a pending link request for one of this runtime's conversations. */
  declinePairing(sessionId: string, linkId: string) {
    return this.#request<LinkView>("POST", "/api/pairing/revoke", { sessionId, linkId });
  }

  // ---------------------------------------------------------------------------
  // Runtime
  // ---------------------------------------------------------------------------
  async runtimeLinks(): Promise<RuntimeLinkView[]> {
    const res = await this.#request<{ links: RuntimeLinkView[] }>("GET", "/api/runtime/links");
    return res.links;
  }

  /** `protocol`: RUNTIME_PROTOCOL (team/wire.ts), so the server can gate features (§8). */
  registerRuntime(input: {
    label: string;
    platform: string;
    kind: string;
    version: string;
    protocol: number;
  }) {
    return this.#request<RuntimeView>("POST", "/api/runtime/register", input);
  }

  runtimeHeartbeat(input: {
    version: string;
    protocol: number;
    capabilities: Record<string, string>;
    busySessionIds: string[];
  }) {
    return this.#request<RuntimeView>("POST", "/api/runtime/heartbeat", input);
  }

  upsertWorkspace(input: {
    workspaceKey: string;
    displayName: string;
    path: string;
    repoRemote: string | null;
    repoFingerprint: string | null;
    branch: string | null;
  }) {
    return this.#request<{ workspaceId: string }>("POST", "/api/runtime/workspaces", input);
  }

  registerConversation(input: {
    workspaceId: string;
    localBindingRef: string;
    displayName: string;
    provider: "claude-code";
    mode: "resume" | "worker" | "fresh";
    nativeSessionId: string | null;
    workerNativeSessionId?: string | null;
  }) {
    return this.#request<{ sessionId: string; created: boolean }>(
      "POST",
      "/api/runtime/sessions",
      input,
    );
  }

  /** Rotates this runtime's own credential; returns the new token exactly once. */
  rotateCredential() {
    return this.#request<{ token: string }>("POST", "/api/runtime/rotate-credential", {});
  }

  /** Record which native Claude Code session this tlses_ resumes (metadata only). */
  setNativeSession(input: {
    sessionId: string;
    mode: "fresh" | "resume" | "continue";
    nativeSessionId?: string | null;
    workspacePath?: string;
  }) {
    return this.#request<{ sessionId: string; nativeSessionMode: string }>(
      "POST",
      "/api/session/native",
      input,
    );
  }
}

/**
 * Device sign-in (no credential copying): the bridge gets a user code, the human
 * approves it in the browser, and the bridge polls until ThreadLink returns a new
 * Claude Code agent credential exactly once.
 */
export type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch {
    throw new ApiError(0, "network");
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    json: (json ?? {}) as Record<string, unknown>,
  };
}

export async function startDeviceLogin(
  baseUrl: string,
  displayName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceStart> {
  const res = await postJson(fetchImpl, `${validateBaseUrl(baseUrl)}/device/code`, { displayName });
  if (!res.ok) throw new ApiError(res.status, String(res.json.error ?? "error"));
  return res.json as unknown as DeviceStart;
}

export type DeviceToken = {
  access_token: string;
  connection_id: string;
  account_hint: string | null;
};

export async function pollDeviceToken(
  baseUrl: string,
  start: DeviceStart,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<DeviceToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let interval = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new ApiError(0, "aborted");
    await sleep(interval);
    const res = await postJson(fetchImpl, `${validateBaseUrl(baseUrl)}/device/token`, {
      device_code: start.device_code,
    });
    if (res.ok) return res.json as unknown as DeviceToken;
    const error = String(res.json.error ?? "error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new ApiError(res.status, error);
  }
  throw new ApiError(400, "expired_token");
}
