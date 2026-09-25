/**
 * Runs the owner's test commands in the integration worktree.
 *
 * These are the commands ThreadLink runs itself, rather than taking an agent's
 * word that the tests pass. They come only from the owner -- the room policy or
 * the controller at job start, validated in job.ts -- and never from an agent's
 * output, because they run with the owner's own privileges and outside any
 * agent sandbox.
 *
 * They go through the shell, because "npm test" on Windows is npm.cmd and a
 * project's test command is written for a shell. That is safe only because of
 * where the command comes from; nothing here builds a command from other input.
 */

import { spawn } from "node:child_process";

import { isScrubbedVariable } from "./env.ts";
import type { VerifyResult } from "./orchestrator.ts";

/** How much of a command's output is kept: the end, where the failures are. */
export const VERIFY_OUTPUT_TAIL_BYTES = 16_000;
export const VERIFY_TIMEOUT_MS = 30 * 60_000;

/**
 * The environment a verify command sees.
 *
 * The command is the owner's, but what it runs -- test files, package scripts
 * -- was written by the agents in this job, and it runs outside any agent
 * sandbox. So it gets the same scrubbing as an agent (no AI provider keys or
 * third-party provider switches, which could also move billing onto a key)
 * plus nothing of ThreadLink's own. This removes secrets from reach; it is not
 * a sandbox, and the docs say so.
 */
export type EnvMap = Record<string, string | undefined>;

export function verifyEnv(parent: EnvMap = process.env): NodeJS.ProcessEnv {
  const env: EnvMap = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^THREADLINK_/i.test(key)) continue;
    if (isScrubbedVariable(key)) continue;
    env[key] = value;
  }
  env.CI = env.CI ?? "1";
  return env as NodeJS.ProcessEnv;
}

function tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return `…${buf.subarray(buf.length - maxBytes).toString("utf8")}`;
}

function kill(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    // The shell's children outlive a plain kill on Windows.
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function runCommand(
  cwd: string,
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? verifyEnv(),
    });
    let output = "";
    let settled = false;
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString("utf8"), VERIFY_OUTPUT_TAIL_BYTES * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const finish = (result: VerifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, output: tail(result.output, VERIFY_OUTPUT_TAIL_BYTES) });
    };

    // A stopped command is reported only once its process has really gone.
    // Answering earlier would let the next step -- removing the worktree --
    // race a process that still has it open.
    let stopped: string | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = (why: string) => {
      if (stopped || settled) return;
      stopped = why;
      kill(child.pid);
      grace = setTimeout(
        () =>
          finish({
            command,
            ok: false,
            exitCode: null,
            output: `${output}
[${why}; it may still be exiting]`,
          }),
        15_000,
      );
    };
    const limitMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
    const timer = setTimeout(
      () =>
        stop(`stopped: took longer than ${Math.max(1, Math.round(limitMs / 60_000))} minute(s)`),
      limitMs,
    );
    const onAbort = () => stop("stopped: cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) =>
      finish({ command, ok: false, exitCode: null, output: `Could not start: ${error.message}` }),
    );
    child.on("close", (code) =>
      stopped
        ? finish({
            command,
            ok: false,
            exitCode: null,
            output: `${output}
[${stopped}]`,
          })
        : finish({ command, ok: code === 0, exitCode: code, output }),
    );
  });
}

/**
 * Runs every command in order and stops at the first failure: later commands
 * usually depend on earlier ones, and the first failure is the one to fix.
 */
export async function runVerify(
  cwd: string,
  commands: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const result = await runCommand(cwd, command, options);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
