/**
 * Minimal ThreadLink client for the bridge. The bearer token is the bridge's
 * connection credential; it is only ever sent in the Authorization header and
 * never logged or included in errors.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  constructor(status: number, kind: string) {
    super(`ThreadLink request failed (${status} ${kind})`);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

export type Artifact = { type: string; reference: string; metadata?: Record<string, unknown> };

export type TaskEnvelope = {
  taskId: string;
  title: string;
  content: string | null;
  priority: string;
  status: string;
  claimRef?: string | null;
  attemptCount?: number;
  claimedUntil?: string | null;
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

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
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
      throw new ApiError(response.status, kind);
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

  async inbox(sessionId: string, limit = 10): Promise<TaskEnvelope[]> {
    const res = await this.#request<{ tasks: TaskEnvelope[] }>(
      "GET",
      `/api/tasks/inbox?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
    );
    return res.tasks;
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
    failureReason?: "session_busy" | "native_session_unavailable",
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
  registerRuntime(input: { label: string; platform: string; kind: string; version: string }) {
    return this.#request<RuntimeView>("POST", "/api/runtime/register", input);
  }

  runtimeHeartbeat(input: {
    version: string;
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
    mode: "resume" | "fresh";
    nativeSessionId: string | null;
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
