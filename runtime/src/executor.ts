import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

import type { Artifact } from "./api.ts";
import { buildAgentEnv } from "./team/env.ts";
import type { AgentsLister } from "./claude-sessions.ts";

/**
 * How the bridge hands a task to Claude Code (official headless print mode only;
 * no UI scraping, no keystroke injection):
 *
 *   fresh     claude -p --output-format json --permission-mode <m>
 *   resume    claude -p --resume <native-session-id> ...   (attached existing session)
 *   continue  claude -p --continue ...                      (most recent session in the workspace)
 *   worker    claude -p --resume <worker-id> ...            (ThreadLink's own background worker)
 *             claude -p --resume <source-id> --fork-session (first run: branch a worker off the
 *                                                            user's conversation)
 *
 * The prompt always goes on stdin; the process is spawned without a shell in the
 * workspace directory. Verified on Claude Code 2.1.x: `-p --resume <id>` keeps the
 * same session ID (unless --fork-session), retains prior context and appends the
 * turn to that session's transcript.
 *
 * Concurrency: before resuming, the bridge asks `claude agents --json` whether the
 * session is running anywhere (terminal, Claude desktop, background, another -p).
 * If it is — or if that cannot be determined — the task fails with `session_busy`.
 * It never silently falls back to a new session. A per-session lock file also
 * serialises bridge processes on the same machine.
 *
 * An already-open interactive UI does NOT live-refresh with turns added this way;
 * ThreadLink therefore refuses to write while the session is open.
 *
 * Background worker mode exists because that refusal is the right rule but the
 * wrong daily experience: nobody should have to close Claude Code to delegate.
 * Verified against Claude Code 2.1.266:
 *   - `--resume <id>` on a running session is refused, and Claude itself says
 *     "Add --fork-session to branch off a copy instead";
 *   - `--resume <id> --fork-session` on a RUNNING session succeeds;
 *   - the fork gets a new session ID and the source transcript is byte-identical
 *     afterwards, so the user's open conversation is never written to.
 * ThreadLink forks once to create a worker, then resumes that worker by ID, so
 * repeated delegation does not litter the project with forks.
 */

export type TaskInput = {
  taskId: string;
  title: string;
  content: string;
  priority: string;
  /**
   * The server's classification of the task. Routing on this, rather than on
   * what the content looks like, means a controller cannot make an ordinary
   * task run as a team job by shaping its text.
   */
  taskType?: string;
};

export type FailureReason =
  | "session_busy"
  | "native_session_unavailable"
  /** The provider cannot run this execution mode; the user must choose another. */
  | "background_mode_unsupported";

/** Why a claimed task is alive but not progressing. */
export type BlockedReason = "plan_mode" | "approval_required" | "user_input_required";

export type ExecutionResult =
  | { ok: true; result: string; artifacts: Artifact[]; workerSessionId?: string }
  | {
      ok: false;
      error: string;
      reason?: FailureReason;
      workerSessionId?: string;
      /**
       * Set only when the run failed AND said why in terms of a person: it is
       * waiting for permission or an answer, rather than having gone wrong.
       * Never set for a successful run -- exact-conversation mode runs in Plan
       * Mode on purpose and its plans are results, not blockages.
       */
      blocked?: BlockedReason;
    };

export type Executor = {
  readonly name: string;
  execute(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult>;
};

export const PERMISSION_MODES = [
  "plan",
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type NativeSession =
  | { mode: "fresh" }
  | { mode: "continue" }
  | { mode: "resume"; sessionId: string }
  /**
   * ThreadLink's own background conversation for a workspace. `workerSessionId`
   * is null until the first run creates it; `sourceSessionId` (optional) is the
   * user's conversation to branch it from, so the worker starts with context.
   */
  | { mode: "worker"; sourceSessionId: string | null; workerSessionId: string | null };

const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildPrompt(task: TaskInput, native: NativeSession["mode"] = "fresh"): string {
  if (native === "worker") {
    return [
      `[ThreadLink] A task from the user's linked ChatGPT conversation (task ${task.taskId}, priority ${task.priority}).`,
      `Title: ${task.title}`,
      "",
      "<task>",
      task.content,
      "</task>",
      "",
      "You are ThreadLink's background worker for this project. You are NOT the user's open Claude",
      "Code conversation: they may be working in it right now, so do not assume they can see what",
      "you do here. Work in this workspace within your permissions, then reply with a concise",
      "summary of what you did and the outcome; your reply is returned to ChatGPT through ThreadLink.",
      "If you could not complete the task, say why.",
    ].join("\n");
  }
  if (native !== "fresh") {
    return [
      `[ThreadLink] A message from the user's linked ChatGPT conversation (task ${task.taskId}, priority ${task.priority}).`,
      `Title: ${task.title}`,
      "",
      "<task>",
      task.content,
      "</task>",
      "",
      "Continue in this conversation's context. Do the task within your permissions, then reply with a",
      "concise answer; your reply is returned to ChatGPT through ThreadLink.",
    ].join("\n");
  }
  return [
    "You are running as a ThreadLink execution agent (Claude Code, headless, non-interactive).",
    "The task below was sent by the workspace owner from their ThreadLink controller session.",
    `ThreadLink task: ${task.taskId}`,
    `Priority: ${task.priority}`,
    `Title: ${task.title}`,
    "",
    "<task>",
    task.content,
    "</task>",
    "",
    "Do the task in this workspace within your permissions, then reply with a concise summary of what",
    "you did and the outcome. If you could not complete it, say why.",
  ].join("\n");
}

type SpawnFn = typeof spawn;

export type ClaudeExecutorOptions = {
  cwd: string;
  command?: string;
  permissionMode?: PermissionMode;
  model?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  native?: NativeSession;
  /** Required for resume/continue: official running-session listing. */
  listRunning?: AgentsLister;
  /** Directory for per-session lock files (bridge config dir). */
  lockDir?: string;
};

const MAX_CAPTURE = 1024 * 1024;

type ClaudeOutput = { result?: unknown; is_error?: unknown; session_id?: unknown };

/** Parses `claude -p --output-format json` output; null if it is not a JSON object. */
export function parseClaudeOutput(stdout: string): ClaudeOutput | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    return value && typeof value === "object" ? (value as ClaudeOutput) : null;
  } catch {
    return null;
  }
}

/** Claude Code's own refusal when the session is running elsewhere (verified wording). */
const BUSY_PATTERNS = [
  /is running as a background session/i,
  /already running/i,
  /is currently in use/i,
];
const MISSING_PATTERNS = [/No conversation found/i];

/**
 * A failure that is really a person-shaped wait. Deliberately narrow: these
 * match Claude Code saying it needs something from the user, not any error
 * that happens to contain the word "permission". A false positive here leaves
 * a task claimed until its lease expires, so the cost of guessing is real.
 */
const BLOCKED_PATTERNS: [RegExp, BlockedReason][] = [
  [/\brequires? (?:your )?approval\b/i, "approval_required"],
  [/\bneeds? (?:your )?permission to\b/i, "approval_required"],
  [/\brequested permissions? to\b/i, "approval_required"],
  [/\bpermission to use [^\n]{0,60}(?:was )?denied\b/i, "approval_required"],
  [/\bwaiting for (?:your |user )?(?:input|answer|response)\b/i, "user_input_required"],
  [/\bneeds? (?:more )?information from you\b/i, "user_input_required"],
  [/\bin plan mode\b[^\n]{0,80}\b(?:cannot|can't|will not|won't)\b/i, "plan_mode"],
];

/** The blocked reason a failing run is really reporting, if any. */
export function blockedReason(text: string): BlockedReason | null {
  for (const [pattern, reason] of BLOCKED_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}

export const BACKGROUND_UNSUPPORTED_MESSAGE =
  "This agent cannot run work in the background. Choose “Exact conversation” for it instead " +
  "(that conversation must not be open while the task runs).";

export const WORKER_BUSY_MESSAGE =
  "ThreadLink's background worker for this project is already running another task. " +
  "The request will be retried.";

export const BUSY_MESSAGE =
  "The attached Claude Code session is open or running elsewhere (terminal, Claude desktop or a " +
  "background agent). ThreadLink will not write into a session that is open. Close or stop that " +
  "session, then send the task again.";

/** Exclusive per-session lock; stale locks (dead pid) are reclaimed. */
export function acquireSessionLock(dir: string, sessionId: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch {
      let pid = NaN;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {
        /* vanished */
      }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  #options: Required<Omit<ClaudeExecutorOptions, "model" | "listRunning" | "lockDir">> & {
    model?: string;
    listRunning?: AgentsLister;
    lockDir?: string;
  };

  constructor(options: ClaudeExecutorOptions) {
    this.#options = {
      command: "claude",
      permissionMode: "plan",
      timeoutMs: 20 * 60_000,
      spawnFn: spawn,
      native: { mode: "fresh" },
      ...options,
    };
    const native = this.#options.native;
    if (native.mode === "resume" && !NATIVE_ID.test(native.sessionId)) {
      throw new Error("Invalid native Claude Code session ID.");
    }
    if (native.mode === "worker") {
      for (const id of [native.sourceSessionId, native.workerSessionId]) {
        if (id !== null && !NATIVE_ID.test(id)) {
          throw new Error("Invalid native Claude Code session ID.");
        }
      }
    }
  }

  get native(): NativeSession {
    return this.#options.native;
  }

  args(): string[] {
    const args = ["-p"];
    const native = this.#options.native;
    if (native.mode === "resume") args.push("--resume", native.sessionId);
    if (native.mode === "continue") args.push("--continue");
    if (native.mode === "worker") {
      if (native.workerSessionId) {
        // The worker already exists: continue it, so delegated work accumulates
        // in one conversation instead of a new fork every time.
        args.push("--resume", native.workerSessionId);
      } else if (native.sourceSessionId) {
        // First run: branch a copy off the user's conversation. This is what
        // Claude Code itself recommends for a session that is open, and it
        // leaves the source transcript untouched.
        args.push("--resume", native.sourceSessionId, "--fork-session");
      }
      // Neither: a plain fresh session becomes the worker.
    }
    args.push("--output-format", "json", "--permission-mode", this.#options.permissionMode);
    if (this.#options.model) args.push("--model", this.#options.model);
    return args;
  }

  /** The native session this run must serialise against, if any. */
  #lockTarget(): string | null {
    const native = this.#options.native;
    if (native.mode === "resume") return native.sessionId;
    // A worker is ThreadLink's own conversation: two tasks must not write to it
    // at once. Before it exists there is nothing to serialise against.
    if (native.mode === "worker") return native.workerSessionId;
    return null;
  }

  /** null = free; otherwise a failure result explaining why we will not run. */
  async #busyCheck(): Promise<ExecutionResult | null> {
    const native = this.#options.native;
    if (native.mode !== "resume") return null;
    if (!this.#options.listRunning) {
      return { ok: false, reason: "session_busy", error: BUSY_MESSAGE };
    }
    try {
      const running = await this.#options.listRunning();
      if (running.some((r) => r.sessionId === native.sessionId)) {
        return { ok: false, reason: "session_busy", error: BUSY_MESSAGE };
      }
    } catch {
      // Fail closed: if we cannot tell whether it is open, do not touch it.
      return {
        ok: false,
        reason: "session_busy",
        error:
          "Could not confirm the attached Claude Code session is closed (claude agents failed).",
      };
    }
    return null;
  }

  async execute(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult> {
    const native = this.#options.native;
    let release: (() => void) | null = null;
    const lockTarget = this.#lockTarget();
    if (lockTarget && this.#options.lockDir) {
      release = acquireSessionLock(join(this.#options.lockDir, "locks"), lockTarget);
      if (!release) {
        return native.mode === "worker"
          ? { ok: false, reason: "session_busy", error: WORKER_BUSY_MESSAGE }
          : { ok: false, reason: "session_busy", error: BUSY_MESSAGE };
      }
    }
    // Exact-conversation mode refuses to write into a session that is open.
    // Worker mode deliberately does not ask that question of the user's
    // conversation: not disturbing it is the whole point.
    if (native.mode === "resume") {
      const busy = await this.#busyCheck();
      if (busy) {
        release?.();
        return busy;
      }
    }
    try {
      return await this.#run(task, signal);
    } finally {
      release?.();
    }
  }

  #run(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult> {
    const { command, cwd, timeoutMs, spawnFn, native } = this.#options;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: ExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };

      let child: ReturnType<SpawnFn>;
      try {
        child = spawnFn(command, this.args(), {
          cwd,
          // The same scrubbed environment Team Mode uses: no API keys or
          // provider base URLs, so a single task can only run on the owner's
          // subscription sign-in, never bill per token.
          env: buildAgentEnv(process.env).env as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        done({
          ok: false,
          error: "Could not start Claude Code (is the `claude` CLI installed and on PATH?).",
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
      });

      const kill = () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      };
      const onAbort = () => {
        kill();
        done({ ok: false, error: "Execution aborted (lease lost or bridge stopping)." });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        kill();
        done({
          ok: false,
          error: `Claude Code did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`,
        });
      }, timeoutMs);

      child.on("error", () =>
        done({
          ok: false,
          error: "Could not start Claude Code (is the `claude` CLI installed and on PATH?).",
        }),
      );
      child.on("close", (code) => {
        const parsed = parseClaudeOutput(stdout);
        if (!parsed || typeof parsed.result !== "string") {
          const tail = stderr.trim().slice(-500);
          if (native.mode !== "fresh" && BUSY_PATTERNS.some((p) => p.test(stderr))) {
            done({ ok: false, reason: "session_busy", error: BUSY_MESSAGE });
            return;
          }
          if (native.mode === "resume" && MISSING_PATTERNS.some((p) => p.test(stderr))) {
            done({
              ok: false,
              reason: "native_session_unavailable",
              error:
                "The attached Claude Code session no longer exists on this machine. Re-run " +
                "`threadlink-bridge setup` to attach a session. (ThreadLink did not start a new one.)",
            });
            return;
          }
          done({
            ok: false,
            error: `Claude Code exited with code ${code ?? "?"}${tail ? `: ${tail}` : ""}`,
          });
          return;
        }
        if (parsed.is_error === true || code !== 0) {
          const error = parsed.result || `Claude Code reported an error (exit ${code ?? "?"}).`;
          done({ ok: false, error, blocked: blockedReason(error) ?? undefined });
          return;
        }
        const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
        // Worker mode: whatever session answered IS the worker from now on. On
        // the first run that is the fork's new id; afterwards it must be the
        // same worker we resumed, or something is wrong and we say so.
        if (native.mode === "worker") {
          if (!sessionId) {
            done({ ok: false, error: "Claude Code did not report a session id for the worker." });
            return;
          }
          if (native.workerSessionId && sessionId !== native.workerSessionId) {
            done({
              ok: false,
              reason: "native_session_unavailable",
              error:
                "The background worker answered from a different Claude conversation than the " +
                "one ThreadLink started; the result was discarded.",
            });
            return;
          }
          done({
            ok: true,
            result: parsed.result,
            artifacts: [{ type: "other", reference: `claude-code-session:${sessionId}` }],
            workerSessionId: sessionId,
          });
          return;
        }
        if (native.mode === "resume" && sessionId !== native.sessionId) {
          // Never report a different (forked/new) session as the attached one.
          done({
            ok: false,
            reason: "native_session_unavailable",
            error:
              "Claude Code answered from a different session than the attached one; the result was " +
              "discarded. Re-run `threadlink-bridge setup`.",
          });
          return;
        }
        const artifacts: Artifact[] = sessionId
          ? [{ type: "other", reference: `claude-code-session:${sessionId}` }]
          : [];
        done({ ok: true, result: parsed.result, artifacts });
      });

      child.stdin?.end(buildPrompt(task, native.mode));
    });
  }
}

/** Deterministic executor for tests and dry runs: no model, no side effects. */
export class EchoExecutor implements Executor {
  readonly name = "echo";
  async execute(task: TaskInput): Promise<ExecutionResult> {
    return { ok: true, result: `Echo: ${task.content}`, artifacts: [] };
  }
}
