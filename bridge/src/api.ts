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
  fail(taskId: string, sessionId: string, claimRef: string, error: string) {
    return this.#step(taskId, "fail", { sessionId, claimRef, error });
  }
}
