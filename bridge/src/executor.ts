import { spawn } from "node:child_process";

import type { Artifact } from "./api.ts";

/**
 * How the bridge hands a task to Claude Code.
 *
 * ThreadLink does NOT inject prompts into an existing interactive Claude Code
 * session (no supported mechanism exists). Instead each task runs as a
 * controlled, headless Claude Code worker process using the official print
 * mode: `claude -p --output-format json --permission-mode <mode>`, in the
 * bridge's workspace, with the prompt on stdin (no shell, no argv injection).
 *
 * Default permission mode is `plan` (read-only analysis). Allowing edits or
 * commands is an explicit opt-in (`--permission-mode acceptEdits`, etc.).
 */

export type TaskInput = { taskId: string; title: string; content: string; priority: string };

export type ExecutionResult =
  { ok: true; result: string; artifacts: Artifact[] } | { ok: false; error: string };

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

export function buildPrompt(task: TaskInput): string {
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

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  #options: Required<Omit<ClaudeExecutorOptions, "model">> & { model?: string };

  constructor(options: ClaudeExecutorOptions) {
    this.#options = {
      command: "claude",
      permissionMode: "plan",
      timeoutMs: 20 * 60_000,
      spawnFn: spawn,
      ...options,
    };
  }

  args(): string[] {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      this.#options.permissionMode,
    ];
    if (this.#options.model) args.push("--model", this.#options.model);
    return args;
  }

  execute(task: TaskInput, signal: AbortSignal): Promise<ExecutionResult> {
    const { command, cwd, timeoutMs, spawnFn } = this.#options;
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
          done({
            ok: false,
            error: `Claude Code exited with code ${code ?? "?"}${tail ? `: ${tail}` : ""}`,
          });
          return;
        }
        if (parsed.is_error === true || code !== 0) {
          done({
            ok: false,
            error: parsed.result || `Claude Code reported an error (exit ${code ?? "?"}).`,
          });
          return;
        }
        const artifacts: Artifact[] =
          typeof parsed.session_id === "string"
            ? [{ type: "other", reference: `claude-code-session:${parsed.session_id}` }]
            : [];
        done({ ok: true, result: parsed.result, artifacts });
      });

      child.stdin?.end(buildPrompt(task));
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
