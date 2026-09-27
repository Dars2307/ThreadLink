/**
 * Timeout policy per step kind (docs/design/threadlink-0.10.md §6).
 *
 * Defaults, overridable per project within 2-120 minutes. A value outside the
 * bounds is refused when the job is parsed (job.ts), never clamped silently.
 */

import { STEP_KINDS, type StepKind } from "./activity.ts";

const MIN = 60_000;

export const STEP_TIMEOUT_DEFAULTS_MIN: Readonly<Record<StepKind, number>> = {
  normalise: 10,
  plan: 15,
  plan_review: 15,
  build: 30,
  review: 30,
  security_review: 40,
  inspection: 30,
  verify: 30,
};

export const STEP_TIMEOUT_BOUNDS_MIN = { min: 2, max: 120 } as const;

export type TimeoutOverrides = Partial<Record<StepKind, number>>;

/** Parses project overrides (minutes). Throws a readable message for anything malformed. */
export function parseTimeoutOverrides(value: unknown): TimeoutOverrides {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("timeouts must be an object of step kind to minutes.");
  }
  const out: TimeoutOverrides = {};
  for (const [key, minutes] of Object.entries(value as Record<string, unknown>)) {
    if (!(STEP_KINDS as readonly string[]).includes(key)) {
      throw new Error(`timeouts.${key.slice(0, 40)} is not a step kind.`);
    }
    if (minutes === null || minutes === undefined) continue;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < STEP_TIMEOUT_BOUNDS_MIN.min ||
      minutes > STEP_TIMEOUT_BOUNDS_MIN.max
    ) {
      throw new Error(
        `timeouts.${key} must be a whole number of minutes between ${STEP_TIMEOUT_BOUNDS_MIN.min} and ${STEP_TIMEOUT_BOUNDS_MIN.max}.`,
      );
    }
    out[key as StepKind] = minutes;
  }
  return out;
}

/** The timeout for one step, in milliseconds. */
export function stepTimeoutMs(step: StepKind, overrides: TimeoutOverrides = {}): number {
  return (overrides[step] ?? STEP_TIMEOUT_DEFAULTS_MIN[step]) * MIN;
}

/** "Increase timeout": double it, within the upper bound. Null when already at the bound. */
export function increasedTimeoutMs(current: number): number | null {
  const max = STEP_TIMEOUT_BOUNDS_MIN.max * MIN;
  if (current >= max) return null;
  return Math.min(current * 2, max);
}
