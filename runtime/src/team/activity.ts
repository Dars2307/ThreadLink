/**
 * Live run activity (docs/design/threadlink-0.10.md §2, §3, §6).
 *
 * The chat shows "Codex · reviewer · reading · 2 min" while a run works. That
 * line may only come from real signals:
 *
 *   - the run's phase (it started as a review, so it is reviewing), or
 *   - a provider event of a known type, mapped to a fixed enum here.
 *
 * Nothing an agent wrote is ever forwarded: a Codex command's text is looked
 * at on this computer only to tell "running tests" from "reading", and only
 * the enum value leaves it. Reasoning items are never read at all.
 *
 * ActivityReporter rate-limits what is sent (at most one update per run per
 * five seconds) and sends only when a real signal arrived, so the server's
 * `last_activity_at` is honest and a stalled run shows as stalled.
 */

import type { TeamRole } from "./types.ts";

export const RUN_ACTIVITIES = [
  "queued",
  "reading",
  "planning",
  "building",
  "reviewing",
  "testing",
  "waiting",
  "responding",
  "integrating",
] as const;
export type RunActivity = (typeof RUN_ACTIVITIES)[number];

export const ACTIVITY_MIN_INTERVAL_MS = 5_000;

/** The kinds of step an agent run can be. Timeouts and activity key on these. */
export const STEP_KINDS = [
  "normalise",
  "plan",
  "plan_review",
  "build",
  "review",
  "security_review",
  "inspection",
  "verify",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Steps that can change files. A crash during one of these is never re-run blindly. */
export const WRITE_STEPS: ReadonlySet<StepKind> = new Set(["build"]);

/** What a run is doing before any event arrives: its phase. */
export function phaseActivity(step: StepKind): RunActivity {
  switch (step) {
    case "normalise":
    case "plan":
      return "planning";
    case "build":
      return "building";
    case "verify":
      return "testing";
    default:
      return "reviewing";
  }
}

const TEST_COMMAND =
  /\b(?:test|tests|vitest|jest|pytest|mocha|tap|ava|rspec|phpunit|ctest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|tsc|typecheck|lint|eslint)\b/i;

/**
 * Maps one `codex exec --json` event to an activity, or null for an event
 * that says nothing about what the run is doing. Only the event's `type` and
 * its item's `type` are read -- plus, for a command, whether it looks like a
 * test run (kept local).
 */
export function codexEventActivity(event: unknown, role: TeamRole): RunActivity | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "item.started" && e.type !== "item.completed") return null;
  const item = e.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const i = item as Record<string, unknown>;
  const writes = role === "builder" || role === "integrator";
  switch (i.type) {
    case "command_execution":
      return typeof i.command === "string" && TEST_COMMAND.test(i.command) ? "testing" : "reading";
    case "file_change":
      return writes ? "building" : "reading";
    case "web_search":
    case "mcp_tool_call":
      return "reading";
    case "todo_list":
      return "planning";
    case "agent_message":
      return e.type === "item.completed" ? "responding" : null;
    default:
      // reasoning and unknown item types: nothing is inferred from them.
      return null;
  }
}

export type ActivityClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realClock: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Sends a run's activity at most once per `minIntervalMs`. `signal()` is
 * called for every real signal (a provider event, the run starting); the
 * latest one is sent now if the interval allows, or when it does. Nothing is
 * sent without a signal, so a silent run is visibly silent.
 */
export class ActivityReporter {
  readonly #send: (activity: RunActivity) => Promise<void>;
  readonly #min: number;
  readonly #clock: ActivityClock;
  #lastSentAt = -Infinity;
  #pending: RunActivity | null = null;
  #timer: unknown = null;
  #stopped = false;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(
    send: (activity: RunActivity) => Promise<void>,
    options: { minIntervalMs?: number; clock?: ActivityClock } = {},
  ) {
    this.#send = send;
    this.#min = options.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS;
    this.#clock = options.clock ?? realClock;
  }

  /** The run's start already reported its activity (run_started): the interval starts now. */
  primed(): void {
    this.#lastSentAt = this.#clock.now();
  }

  signal(activity: RunActivity): void {
    if (this.#stopped) return;
    this.#pending = activity;
    const wait = this.#lastSentAt + this.#min - this.#clock.now();
    if (wait <= 0) {
      this.#flush();
      return;
    }
    if (this.#timer === null) {
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = null;
        this.#flush();
      }, wait);
    }
  }

  #flush(): void {
    if (this.#stopped || this.#pending === null) return;
    const activity = this.#pending;
    this.#pending = null;
    this.#lastSentAt = this.#clock.now();
    // Activity is advisory: a failed update never stops the run.
    this.#inFlight = this.#inFlight.then(() => this.#send(activity).catch(() => undefined));
  }

  /** Stops sending. Anything still pending is dropped: run_finished follows. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = null;
    await this.#inFlight;
  }
}
