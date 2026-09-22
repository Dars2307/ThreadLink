import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, validateBaseUrl, type TaskEnvelope } from "../../bridge/src/api.ts";
import { DEFAULT_BACKOFF, nextDelay } from "../../bridge/src/backoff.ts";
import {
  ENV_TOKEN,
  linuxSecretToolStore,
  loadToken,
  macKeychainStore,
  windowsDpapiStore,
  type CredentialStore,
} from "../../bridge/src/credentials.ts";
import {
  buildPrompt,
  ClaudeCodeExecutor,
  EchoExecutor,
  type Executor,
} from "../../bridge/src/executor.ts";
import { loadWorkspaceState, saveWorkspaceState, workspaceKey } from "../../bridge/src/state.ts";
import {
  processNextTask,
  runLoop,
  truncateBytes,
  type WorkerDeps,
} from "../../bridge/src/worker.ts";

const TOKEN = "tlc_" + "A".repeat(43);
const SESSION = "tlses_00112233445566778899aabbccddeeff";
const TASK: TaskEnvelope = {
  taskId: "tltask_00112233445566778899aabbccddeeff",
  title: "Run tests",
  content: "npm test",
  priority: "A1",
  status: "queued",
};

function fakeApi(overrides: Partial<Record<keyof WorkerDeps["api"], unknown>> = {}) {
  const api = {
    inbox: vi.fn(async () => [TASK]),
    claim: vi.fn(async () => ({ ...TASK, status: "claimed", attemptCount: 1 })),
    start: vi.fn(async () => ({ ...TASK, status: "working" })),
    heartbeat: vi.fn(async () => ({ ...TASK, status: "working" })),
    progress: vi.fn(async () => ({ ...TASK })),
    complete: vi.fn(async () => ({ ...TASK, status: "completed" })),
    fail: vi.fn(async () => ({ ...TASK, status: "failed" })),
    ...overrides,
  };
  return api as unknown as WorkerDeps["api"] & Record<string, ReturnType<typeof vi.fn>>;
}

afterEach(() => vi.useRealTimers());

describe("backoff", () => {
  it("grows exponentially to a cap, with bounded jitter", () => {
    const mid = () => 0.5;
    expect(nextDelay(0, DEFAULT_BACKOFF, mid)).toBe(2_000);
    expect(nextDelay(1, DEFAULT_BACKOFF, mid)).toBe(4_000);
    expect(nextDelay(10, DEFAULT_BACKOFF, mid)).toBe(60_000);
    expect(nextDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(1_600);
    expect(nextDelay(10, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThanOrEqual(72_000);
  });
});

describe("api client", () => {
  it("requires https except for localhost", () => {
    expect(validateBaseUrl("https://threadlink.example/x")).toBe("https://threadlink.example");
    expect(validateBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => validateBaseUrl("http://threadlink.example")).toThrow();
  });

  it("errors never contain the token", () => {
    const error = new ApiError(401, "unauthorized");
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("worker", () => {
  const deps = (api: WorkerDeps["api"], executor: Executor = new EchoExecutor()): WorkerDeps => ({
    api,
    executor,
    sessionId: SESSION,
    claimRef: "bridge-test",
    heartbeatMs: 5,
  });

  it("claims, starts, reports progress and completes with the result", async () => {
    const api = fakeApi();
    expect(await processNextTask(deps(api))).toBe("completed");
    expect(api.claim).toHaveBeenCalledWith(TASK.taskId, SESSION, "bridge-test");
    expect(api.complete).toHaveBeenCalledWith(
      TASK.taskId,
      SESSION,
      "bridge-test",
      "Echo: npm test",
      [],
    );
    expect(api.fail).not.toHaveBeenCalled();
  });

  it("does nothing when the inbox is empty", async () => {
    const api = fakeApi({ inbox: vi.fn(async () => []) });
    expect(await processNextTask(deps(api))).toBe("none");
    expect(api.claim).not.toHaveBeenCalled();
  });

  it("skips a task another worker claimed first", async () => {
    const api = fakeApi({
      claim: vi.fn(async () => Promise.reject(new ApiError(409, "conflict"))),
    });
    expect(await processNextTask(deps(api))).toBe("skipped");
    expect(api.start).not.toHaveBeenCalled();
  });

  it("reports executor failures with fail()", async () => {
    const failing: Executor = { name: "x", execute: async () => ({ ok: false, error: "boom" }) };
    const api = fakeApi();
    expect(await processNextTask(deps(api, failing))).toBe("failed");
    expect(api.fail).toHaveBeenCalledWith(TASK.taskId, SESSION, "bridge-test", "boom");
  });

  it("aborts and never completes when the heartbeat reports a lost lease", async () => {
    const api = fakeApi({
      heartbeat: vi.fn(async () => Promise.reject(new ApiError(409, "conflict"))),
    });
    const slow: Executor = {
      name: "slow",
      execute: (_task, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" })),
        ),
    };
    expect(await processNextTask(deps(api, slow))).toBe("lost");
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.fail).not.toHaveBeenCalled();
  });

  it("treats a rejected completion (lease lost at the end) as lost", async () => {
    const api = fakeApi({
      complete: vi.fn(async () => Promise.reject(new ApiError(409, "conflict"))),
    });
    expect(await processNextTask(deps(api))).toBe("lost");
  });

  it("run loop backs off when idle and stops on a revoked credential", async () => {
    const delays: number[] = [];
    let calls = 0;
    const api = fakeApi({
      inbox: vi.fn(async () => {
        calls++;
        if (calls > 3) throw new ApiError(401, "unauthorized");
        return [];
      }),
    });
    const stop = new AbortController();
    const result = await runLoop({
      ...deps(api),
      signal: stop.signal,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result).toBe("unauthorized");
    expect(delays).toEqual([2_000, 4_000, 8_000]);
  });

  it("truncates oversized results by bytes", () => {
    const text = "é".repeat(200);
    const out = truncateBytes(text, 100);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(100);
    expect(out).toContain("[truncated");
  });
});

describe("workspace state", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps one stable localBindingRef per workspace, independent of names", async () => {
    dir = await mkdtemp(join(tmpdir(), "tl-bridge-"));
    const first = await loadWorkspaceState(dir, "C:/work/repo-a");
    const again = await loadWorkspaceState(dir, "C:/work/repo-a");
    const other = await loadWorkspaceState(dir, "C:/work/repo-b");
    expect(first.localBindingRef).toMatch(/^cc-[0-9a-f-]{36}$/);
    expect(again.localBindingRef).toBe(first.localBindingRef);
    expect(other.localBindingRef).not.toBe(first.localBindingRef);

    await saveWorkspaceState(dir, { ...first, sessionId: SESSION });
    const saved = JSON.parse(
      await readFile(join(dir, "workspaces", `${workspaceKey("C:/work/repo-a")}.json`), "utf8"),
    );
    expect(saved).toMatchObject({ localBindingRef: first.localBindingRef, sessionId: SESSION });
    expect(JSON.stringify(saved)).not.toMatch(/tlc_/);
  });
});

describe("credential storage", () => {
  const memoryStore = (value: string | null): CredentialStore => ({
    description: "memory",
    load: async () => value,
    save: async () => {},
    clear: async () => {},
  });

  it("prefers the environment fallback and validates the format", async () => {
    expect(await loadToken(memoryStore(null), { [ENV_TOKEN]: TOKEN })).toEqual({
      token: TOKEN,
      source: "env",
    });
    expect(await loadToken(memoryStore(TOKEN), {})).toEqual({ token: TOKEN, source: "store" });
    await expect(loadToken(memoryStore(null), { [ENV_TOKEN]: "nope" })).rejects.toThrow();
  });

  it("keychain helpers receive the token on stdin, never in argv", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const run = async (_cmd: string, args: string[], input?: string) => {
      calls.push({ args, input });
      return { code: 0, stdout: "", stderr: "" };
    };
    await macKeychainStore(run).save(TOKEN);
    await linuxSecretToolStore(run).save(TOKEN);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      expect(call.input).toContain(TOKEN);
    }
  });

  it.runIf(process.platform === "win32")(
    "round-trips through Windows DPAPI and never writes the token in clear",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "tl-dpapi-"));
      try {
        const store = windowsDpapiStore(dir);
        await store.save(TOKEN);
        const onDisk = await readFile(join(dir, "credential.dpapi"), "utf8");
        expect(onDisk).not.toContain(TOKEN);
        expect(onDisk).not.toContain("tlc_");
        expect(await store.load()).toBe(TOKEN);
        await store.clear();
        expect(await store.load()).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("Claude Code executor", { timeout: 30_000 }, () => {
  const fake = join(__dirname, "fake-claude.mjs");
  const spawnFake = ((command: string, args: string[], options: object) =>
    spawn(process.execPath, [fake, ...args], options as never)) as unknown as typeof spawn;
  const task = { taskId: TASK.taskId, title: TASK.title, content: "say hi", priority: "C" };

  function executor(
    mode: string,
    extra: Partial<ConstructorParameters<typeof ClaudeCodeExecutor>[0]> = {},
  ) {
    process.env.FAKE_CLAUDE_MODE = mode;
    return new ClaudeCodeExecutor({ cwd: process.cwd(), spawnFn: spawnFake, ...extra });
  }

  it("uses official headless mode, read-only by default, with the prompt on stdin", async () => {
    const result = await executor("ok").execute(task, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toContain("-p --output-format json --permission-mode plan");
      expect(result.result).toContain("promptHasTask=true");
      expect(result.artifacts).toEqual([
        { type: "other", reference: "claude-code-session:11111111-2222-3333-4444-555555555555" },
      ]);
    }
  });

  it("maps Claude errors and unparseable output to failures", async () => {
    expect((await executor("error").execute(task, new AbortController().signal)).ok).toBe(false);
    const garbage = await executor("garbage").execute(task, new AbortController().signal);
    expect(garbage).toMatchObject({ ok: false });
  });

  it("kills the process on abort and on timeout", async () => {
    const abort = new AbortController();
    const pending = executor("hang").execute(task, abort.signal);
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("aborted") });
    const timed = await executor("hang", { timeoutMs: 300 }).execute(
      task,
      new AbortController().signal,
    );
    expect(timed).toMatchObject({ ok: false, error: expect.stringContaining("did not finish") });
  });

  it("frames the task without shell or argv injection", () => {
    const prompt = buildPrompt({ ...task, content: "$(rm -rf /) && `evil`" });
    expect(prompt).toContain("<task>\n$(rm -rf /) && `evil`\n</task>");
    expect(new ClaudeCodeExecutor({ cwd: "." }).args()).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
    ]);
  });
});
