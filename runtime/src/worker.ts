import { ApiError, type ThreadLinkApi, type TaskEnvelope } from "./api.ts";
import { DEFAULT_BACKOFF, nextDelay, type BackoffOptions } from "./backoff.ts";
import type { BlockedReason, Executor } from "./executor.ts";
import { summarize } from "./summary.ts";

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
    "inbox" | "claim" | "start" | "heartbeat" | "progress" | "complete" | "fail" | "blocked"
  >;
  executor: Executor;
  sessionId: string;
  claimRef: string;
  heartbeatMs?: number;
  log?: Log;
  /**
   * Worker mode: the native conversation ThreadLink used. Reported so the
   * Runtime can reuse the same background conversation next time instead of
   * branching a new one.
   */
  onWorkerSession?: (nativeSessionId: string) => void;
  /**
   * Observes a task beginning, once the claim and lease are real. Never
   * receives the prompt: a mirror of what the worker is doing must not become
   * a second copy of what it was asked to do.
   */
  onStarted?: (event: { taskId: string; title: string }) => void;
  /**
   * Observes a task that is alive but waiting on a person. The task keeps its
   * claim; this is not an outcome.
   */
  onBlocked?: (event: { taskId: string; title: string; reason: BlockedReason }) => void;
  /**
   * Observes each finished task (for UI/notifications). Never receives the
   * result itself -- only a summary already stripped of code, credentials and
   * paths, which may be absent when nothing safe was left to say.
   */
  onOutcome?: (event: {
    taskId: string;
    title: string;
    outcome: "completed" | "failed" | "lost";
    reason?: string;
    summary?: string | null;
  }) => void;
  /**
   * Best-effort lifecycle event emission for Mission Control. Never throws;
   * call sites use void or fire-and-forget — task execution is never blocked
   * on event delivery.
   */
  emitEvent?: (event: {
    taskId: string;
    speaker: "user" | "chatgpt" | "claude_code" | "system";
    event_type: string;
    content?: string;
    payload?: Record<string, unknown>;
  }) => void;
};

export type Outcome = "none" | "completed" | "failed" | "lost" | "skipped" | "blocked";

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
  const inbox = await deps.api.inbox(deps.sessionId, 10);
  const next: TaskEnvelope | undefined = inbox.find((t) => t.status === "queued");
  if (!next) return "none";
  return processTask(deps, next);
}

/** Claims one specific queued task and runs it to its outcome. */
export async function processTask(deps: WorkerDeps, next: TaskEnvelope): Promise<Outcome> {
  const task = await claimTask(deps, next);
  if (task === "skipped") return "skipped";
  return runClaimedTask(deps, task);
}

/**
 * Claims a queued task for this worker. "skipped" when another worker won it
 * (409). 0.11: the engine claims first and then runs the task in the
 * background (runClaimedTask), so the loop keeps polling (§3.3).
 */
export async function claimTask(
  deps: Pick<WorkerDeps, "api" | "sessionId" | "claimRef" | "log">,
  next: TaskEnvelope,
): Promise<TaskEnvelope | "skipped"> {
  let task: TaskEnvelope;
  try {
    task = await deps.api.claim(next.taskId, deps.sessionId, deps.claimRef);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return "skipped"; // another worker won
    throw error;
  }
  (deps.log ?? (() => {}))(`claimed ${task.taskId} (attempt ${task.attemptCount ?? "?"})`);
  // The claim answer may leave out fields the inbox had; the inbox's are the same task's.
  return {
    ...task,
    content: task.content ?? next.content,
    taskType: task.taskType ?? next.taskType,
    createdAt: task.createdAt ?? next.createdAt ?? null,
  };
}

/** Starts, heartbeats, executes and completes a task this worker has claimed. */
export async function runClaimedTask(deps: WorkerDeps, task: TaskEnvelope): Promise<Outcome> {
  const log = deps.log ?? (() => {});
  const { api, sessionId, claimRef } = deps;

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
  // Only now is the task really ours and really running.
  deps.onStarted?.({ taskId: task.taskId, title: task.title });
  deps.emitEvent?.({ taskId: task.taskId, speaker: "claude_code", event_type: "task_started" });

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
        taskType: task.taskType,
        createdAt: task.createdAt ?? null,
        // The server's claim time when it sent one; otherwise now (same clock
        // as createdAt only when the server's is used, so null is safer).
        claimedAt: task.claimedAt ?? null,
      },
      controller.signal,
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (controller.signal.aborted) {
    deps.onOutcome?.({ taskId: task.taskId, title: task.title, outcome: "lost" });
    return "lost";
  }

  try {
    // Worker mode learns its own conversation id from the first run.
    if (result.workerSessionId) deps.onWorkerSession?.(result.workerSessionId);
    if (result.ok) {
      await api.complete(
        task.taskId,
        sessionId,
        claimRef,
        truncateBytes(result.result, MAX_RESULT_BYTES),
        result.artifacts,
      );
      log(`completed ${task.taskId}`);
      deps.emitEvent?.({ taskId: task.taskId, speaker: "claude_code", event_type: "task_completed" });
      deps.onOutcome?.({
        taskId: task.taskId,
        title: task.title,
        outcome: "completed",
        summary: summarize(result.result),
      });
      return "completed";
    }
    // A run that stopped because it needs a person is not a failure: say so,
    // and leave the claim alone so the task is not lost while they decide.
    if (result.blocked) {
      await api.blocked(task.taskId, sessionId, claimRef, result.blocked);
      log(`blocked ${task.taskId} (${result.blocked})`);
      deps.onBlocked?.({ taskId: task.taskId, title: task.title, reason: result.blocked });
      return "blocked";
    }
    const error = truncateBytes(result.error, MAX_ERROR_BYTES);
    if (result.reason) await api.fail(task.taskId, sessionId, claimRef, error, result.reason);
    else await api.fail(task.taskId, sessionId, claimRef, error);
    log(`failed ${task.taskId}${result.reason ? ` (${result.reason})` : ""}`);
    deps.emitEvent?.({
      taskId: task.taskId,
      speaker: "system",
      event_type: "task_failed",
      ...(result.reason ? { payload: { reason: result.reason } } : {}),
    });
    deps.onOutcome?.({
      taskId: task.taskId,
      title: task.title,
      outcome: "failed",
      reason: result.reason,
    });
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
