/**
 * Idle polling backoff with jitter. No work: 2 s, 4 s, 8 s ... capped at 60 s,
 * each +/-20 %. After a task, polling restarts at the minimum.
 */
export type BackoffOptions = { minMs: number; maxMs: number; factor: number; jitter: number };

export const DEFAULT_BACKOFF: BackoffOptions = {
  minMs: 2_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

export function nextDelay(
  idleRounds: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(options.maxMs, options.minMs * options.factor ** Math.max(0, idleRounds));
  const spread = base * options.jitter;
  const value = base - spread + random() * 2 * spread;
  return Math.round(
    Math.min(
      options.maxMs * (1 + options.jitter),
      Math.max(options.minMs * (1 - options.jitter), value),
    ),
  );
}
