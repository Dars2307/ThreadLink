import { ApiError, type ThreadLinkApi, type TaskEnvelope } from "./api.ts";
import { DEFAULT_BACKOFF, nextDelay, type BackoffOptions } from "./backoff.ts";
import type { Executor } from "./executor.ts";

/**
 * Poll -> claim -> start -> heartbeat while executing -> complete/fail.
 *
 * - One task at a time per bridge process.
 * - claimRef identifies this worker process; the server's lease (5 min) is
 *   renewed by a heartbeat every `heartbeatMs` (default 60 s).
 * - If a heartbeat is rejected (lease lost, link revoked, credential revoked),
 *   execution is aborted and the result is NOT submitted.
 */

const MAX_RESULT_BYTES = 250 * 1024;
const MAX_ERROR_BYTES = 60 * 1024;
const TRAILING_REPLACEMENT_CHAR = new RegExp(String.fromCharCode(0xfffd) + "$");

export type Log = (message: string) => void;

export type WorkerDeps = {
  api: Pick<
    ThreadLinkApi,
    "inbox" | "claim" | "start" | "heartbeat" | "progress" | "complete" | "fail"
  >;
  executor: Executor;
  sessionId: string;
  claimRef: string;
  heartbeatMs?: number;
  log?: Log;
};

export type Outcome = "none" | "completed" | "failed" | "lost" | "skipped";

export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const suffix = "\n[truncated by ThreadLink bridge]";
  const head = buf.subarray(0, maxBytes - Buffer.byteLength(suffix)).toString("utf8");
  return head.replace(TRAILING_REPLACEMENT_CHAR, "") + suffix;
}

function isLeaseLoss(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
}

/** Processes at most one task. Returns what happened. */
export async function processNextTask(deps: WorkerDeps): Promise<Outcome> {
  const log = deps.log ?? (() => {});
  const { api, sessionId, claimRef } = deps;

  const inbox = await api.inbox(sessionId, 10);
  const next: TaskEnvelope | undefined = inbox.find((t) => t.status === "queued");
  if (!next) return "none";

  let task: TaskEnvelope;
  try {
    task = await api.claim(next.taskId, sessionId, claimRef);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return "skipped"; // another worker won
    throw error;
  }
  log(`claimed ${task.taskId} (attempt ${task.attemptCount ?? "?"})`);

  const controller = new AbortController();
  try {
    await api.start(task.taskId, sessionId, claimRef);
    await api.progress(
      task.taskId,
      sessionId,
      claimRef,
      `Claude Code bridge started (${deps.executor.name}).`,
    );
  } catch (error) {
    if (isLeaseLoss(error)) return "lost";
    throw error;
  }

  const heartbeat = setInterval(() => {
    api.heartbeat(task.taskId, sessionId, claimRef).catch((error: unknown) => {
      if (isLeaseLoss(error)) {
        log(`lease lost for ${task.taskId}; aborting`);
        controller.abort();
      }
    });
  }, deps.heartbeatMs ?? 60_000);

  let result;
  try {
    result = await deps.executor.execute(
      {
        taskId: task.taskId,
        title: task.title,
        content: task.content ?? "",
        priority: task.priority,
      },
      controller.signal,
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (controller.signal.aborted) return "lost";

  try {
    if (result.ok) {
      await api.complete(
        task.taskId,
        sessionId,
        claimRef,
        truncateBytes(result.result, MAX_RESULT_BYTES),
        result.artifacts,
      );
      log(`completed ${task.taskId}`);
      return "completed";
    }
    await api.fail(task.taskId, sessionId, claimRef, truncateBytes(result.error, MAX_ERROR_BYTES));
    log(`failed ${task.taskId}`);
    return "failed";
  } catch (error) {
    if (isLeaseLoss(error)) return "lost";
    throw error;
  }
}

export type LoopOptions = WorkerDeps & {
  signal: AbortSignal;
  backoff?: BackoffOptions;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Polls until stopped. Credential rejection (401) stops the loop. */
export async function runLoop(options: LoopOptions): Promise<"stopped" | "unauthorized"> {
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  let idle = 0;
  while (!options.signal.aborted) {
    let delay: number;
    try {
      const outcome = await processNextTask(options);
      if (outcome === "none") {
        delay = nextDelay(idle++, options.backoff ?? DEFAULT_BACKOFF, options.random);
      } else {
        idle = 0;
        delay = 250;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        log("the ThreadLink credential was rejected (revoked?); stopping");
        return "unauthorized";
      }
      const detail = error instanceof ApiError ? `${error.status} ${error.kind}` : "unexpected";
      log(`poll error (${detail}); backing off`);
      delay = nextDelay(idle++, options.backoff ?? DEFAULT_BACKOFF, options.random);
    }
    await sleep(delay, options.signal);
  }
  return "stopped";
}
