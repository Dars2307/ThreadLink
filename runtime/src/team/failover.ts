/**
 * Usage exhaustion and failover (docs/design/threadlink-0.11.md §5), shared by
 * both lanes.
 *
 * When a provider runs out of included usage mid-job, what happens next is
 * the owner's preference, snapshotted on the job (`failoverPolicy`):
 *
 *   auto  continue with another ready, included-usage agent, and say so once
 *         (`failover_notice`). If the step was an independent review that no
 *         one else may do, the work continues and the review waits: the job
 *         can then finish REVIEW_PENDING, never PASS.
 *   ask   a `usage_exhausted` choice: continue_other / check_again / wait / stop.
 *   wait  the step waits for the provider (the same choice is still offered,
 *         so the owner can change their mind).
 *
 * Rules enforced here:
 *   - The exhausted provider is never retried without a fresh health check that
 *     came back ready. "Check again" is a check, not a retry.
 *   - Waiting re-checks at the provider's stated reset time + 1 minute when it
 *     stated one, otherwise at most every 15 minutes. Never a tight loop.
 *   - Only included-usage agents are candidates (the caller passes ready
 *     runners only; environments stay stripped of API keys). Never paid usage.
 */

import type { ProviderHealth } from "./health.ts";
import type { AgentProvider } from "./types.ts";
import {
  failoverNoticePayload,
  OPS_0_10,
  OPS_0_11,
  parseChoiceId,
  parseChoices,
  readChoicesPayload,
  requestChoicePayload,
  type FailoverPolicy,
} from "./wire.ts";

export const RECHECK_INTERVAL_MS = 15 * 60_000;
export const RESET_GRACE_MS = 60_000;

export type FailoverClock = {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export type FailoverDeps = {
  /** team_job_write for this job (claim-gated). */
  write(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  /** A fresh authenticated health check of one provider (ignores backoff). */
  recheck?(provider: AgentProvider): Promise<ProviderHealth>;
  clock: FailoverClock;
  signal: AbortSignal;
  /** How often the owner's answer is polled (default 15 s). */
  choicePollMs?: number;
  /** How long to wait in total (default 24 h). */
  choiceWaitMs?: number;
  /** Notices already sent, shared per Runtime: at most one per chat per exhaustion. */
  noticesSent?: Set<string>;
  chatId?: string | null;
  /** Called once when the provider is confirmed ready again. */
  onRecovered?(provider: AgentProvider): void;
  log?(message: string): void;
};

export type ExhaustedInput = {
  provider: AgentProvider;
  resetsAt: string | null;
  policy: FailoverPolicy;
  /** Ready, included-usage agents that may take this step instead, best first. */
  alternatives: AgentProvider[];
  /**
   * The step is an independent review that nobody else may do: continuing
   * means going on without it (review pending), to `continueWith`.
   */
  reviewPending?: { continueWith: AgentProvider | null } | null;
  /**
   * The step moves to `alternatives[0]`, but that agent is the only one who
   * could have reviewed it: the notice says the review will wait.
   */
  noticeReviewPending?: boolean;
  /** Trusted params for the choice (step, unit, role). No ids beyond the server's. */
  params?: Record<string, string | number | null>;
  /** Unique per decision point, so a redelivered job does not ask twice. */
  key: string;
};

export type FailoverAction =
  | { action: "other"; provider: AgentProvider }
  /** The review cannot happen now; the work goes on and the review is pending. */
  | { action: "skip"; continueWith: AgentProvider | null }
  /** A fresh check said the provider is ready again: run the step on it again. */
  | { action: "retry" }
  | { action: "stop"; why: "owner" | "expired" | "no_choice" };

/** Sends failover_notice at most once per chat, provider and exhaustion. Best effort. */
export async function sendFailoverNotice(
  deps: FailoverDeps,
  input: {
    from: AgentProvider;
    to: AgentProvider | null;
    reviewPending: boolean;
    resetsAt: string | null;
  },
): Promise<void> {
  const mark = `${deps.chatId ?? "job"}|${input.from}|${input.to ?? "-"}|${input.reviewPending ? 1 : 0}|${input.resetsAt ?? "?"}`;
  if (deps.noticesSent?.has(mark)) return;
  deps.noticesSent?.add(mark);
  try {
    await deps.write(OPS_0_11.failoverNotice, failoverNoticePayload(input));
  } catch {
    // An older server without failover_notice: the provider health report
    // still tells the owner; the job's own outcome is unchanged.
    deps.log?.("failover notice was not accepted by the server");
  }
}

/** When to look again: the stated reset + 1 minute, otherwise 15 minutes from now. */
export function nextRecheckAt(resetsAt: string | null, now: number): number {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isFinite(reset) && reset + RESET_GRACE_MS > now) return reset + RESET_GRACE_MS;
  return now + RECHECK_INTERVAL_MS;
}

/**
 * The owner's (or the policy's) answer to "this provider is out of usage".
 * Never throws for an ordinary outcome; a stop is an action.
 */
export async function handleExhausted(
  input: ExhaustedInput,
  deps: FailoverDeps,
): Promise<FailoverAction> {
  const other = input.alternatives[0] ?? null;
  const skip = input.reviewPending ?? null;
  if (input.policy === "auto") {
    if (other && !skip) {
      await sendFailoverNotice(deps, {
        from: input.provider,
        to: other,
        reviewPending: input.noticeReviewPending === true,
        resetsAt: input.resetsAt,
      });
      return { action: "other", provider: other };
    }
    if (skip) {
      await sendFailoverNotice(deps, {
        from: input.provider,
        to: skip.continueWith,
        reviewPending: true,
        resetsAt: input.resetsAt,
      });
      return { action: "skip", continueWith: skip.continueWith };
    }
    // Nobody else can take it: the owner decides (the choice below).
  }
  return askOrWait(input, deps, other, skip);
}

async function askOrWait(
  input: ExhaustedInput,
  deps: FailoverDeps,
  other: AgentProvider | null,
  skip: { continueWith: AgentProvider | null } | null,
): Promise<FailoverAction> {
  const clock = deps.clock;
  const poll = deps.choicePollMs ?? 15_000;
  const deadline = clock.now() + (deps.choiceWaitMs ?? 24 * 60 * 60_000);
  const canContinue = Boolean(other || skip);
  let waiting = input.policy === "wait";
  let recheckAt = waiting ? nextRecheckAt(input.resetsAt, clock.now()) : Infinity;
  let round = 0;

  const request = async (): Promise<string | null> => {
    round++;
    try {
      return parseChoiceId(
        await deps.write(
          OPS_0_10.requestChoice,
          requestChoicePayload(
            "usage_exhausted",
            {
              provider: input.provider,
              otherProvider: other ?? skip?.continueWith ?? null,
              resetsAt: input.resetsAt,
              reviewPending: skip ? 1 : 0,
              ...(input.params ?? {}),
            },
            [...(canContinue ? (["continue_other"] as const) : []), "check_again", "wait", "stop"],
            `${input.key}:exhausted:${round}`,
          ),
        ),
      );
    } catch {
      return null;
    }
  };

  let choiceId = await request();
  if (!choiceId && !waiting) return { action: "stop", why: "no_choice" };

  const continueOther = async (): Promise<FailoverAction> => {
    if (other && !skip) {
      await sendFailoverNotice(deps, {
        from: input.provider,
        to: other,
        reviewPending: input.noticeReviewPending === true,
        resetsAt: input.resetsAt,
      });
      return { action: "other", provider: other };
    }
    await sendFailoverNotice(deps, {
      from: input.provider,
      to: skip?.continueWith ?? null,
      reviewPending: true,
      resetsAt: input.resetsAt,
    });
    return { action: "skip", continueWith: skip?.continueWith ?? null };
  };

  /** A fresh check. Only "ready" allows the step to run on this provider again. */
  const checkNow = async (): Promise<boolean> => {
    if (!deps.recheck) return false;
    const health = await deps.recheck(input.provider).catch(() => "unknown" as const);
    if (health === "ready") {
      deps.onRecovered?.(input.provider);
      return true;
    }
    return false;
  };

  for (;;) {
    if (deps.signal.aborted) return { action: "stop", why: "owner" };
    if (clock.now() >= deadline) return { action: "stop", why: "expired" };

    if (choiceId) {
      let answer: Record<string, unknown> | void;
      try {
        answer = await deps.write(OPS_0_10.readChoices, readChoicesPayload([choiceId]));
      } catch {
        answer = undefined;
      }
      const state = parseChoices(answer).find((c) => c.id === choiceId);
      if (state?.status === "chosen") {
        switch (state.chosenKey) {
          case "continue_other":
            if (canContinue) return continueOther();
            break;
          case "check_again":
            if (await checkNow()) return { action: "retry" };
            // Still out: ask again (never a retry without a ready check).
            choiceId = await request();
            if (!choiceId) return { action: "stop", why: "no_choice" };
            continue;
          case "wait":
            if (!waiting) {
              waiting = true;
              recheckAt = nextRecheckAt(input.resetsAt, clock.now());
            }
            // The choice is settled; waiting continues without it.
            choiceId = null;
            break;
          default:
            return { action: "stop", why: "owner" };
        }
      } else if (state?.status === "expired") {
        return { action: "stop", why: "expired" };
      } else if (state?.status === "cancelled") {
        return { action: "stop", why: "owner" };
      }
    }

    if (waiting && clock.now() >= recheckAt) {
      if (await checkNow()) {
        // The owner chose to wait (or the policy is wait): resuming is what they asked for.
        return { action: "retry" };
      }
      recheckAt = clock.now() + RECHECK_INTERVAL_MS;
    }
    if (!choiceId && !waiting) return { action: "stop", why: "no_choice" };
    // Sleep until the next poll (or the recheck, if sooner). Never a tight loop.
    const until = waiting ? Math.min(poll, recheckAt - clock.now()) : poll;
    await clock.sleep(until > 0 ? until : poll, deps.signal);
  }
}
