/**
 * Usage governor: what included (subscription) usage is left, and what the
 * user wants done with it.
 *
 * Rules this module enforces (docs/design/team-mode.md §3.4, §5):
 * - Paid usage is OFF by default. Only an explicit, user-confirmed call turns
 *   it on; anything else throws.
 * - An exhausted provider/model is marked until its reset time. The router
 *   receives the exhausted set and refuses rather than substituting.
 * - `decide()` NEVER picks another provider. It returns options for the user
 *   (or the room's pre-chosen option) and names only the provider that failed.
 * - Remaining usage is "unknown" unless a number is supplied from an official
 *   source. A percentage is never invented.
 *
 * Pure state: no filesystem, no network, and no clock. Every time-dependent
 * method takes `now` (epoch milliseconds) from the caller.
 */

import type { AgentProvider } from "./types.ts";

export const EXHAUSTION_OPTIONS = [
  "wait_for_reset",
  "use_other_provider",
  "reduce_tier",
  "ask_user",
] as const;
export type ExhaustionOption = (typeof EXHAUSTION_OPTIONS)[number];

export type RemainingUsage =
  | "unknown"
  | { value: number; unit: "percent" | "requests" | "tokens"; source: string; observedAt: number };

/** Preference hints the router reads for one provider. */
export type RouteHints = {
  /** "Preserve my Claude allowance": route this provider more conservatively. */
  preserve: boolean;
  /** "Use Codex more today": for the orchestrator's provider choice; the router never switches provider. */
  preferred: boolean;
  /** "Don't use Astra unless necessary": only for FRONTIER-required, high-risk work. */
  avoid: ReadonlySet<string>;
};

export type UsageFailure = {
  failure: string;
  provider: AgentProvider;
  model?: string | null;
  resetAt?: number | null;
};

export type UsageDecision =
  | {
      kind: "quota_exhausted";
      /** Always the provider that failed. Never a substitute. */
      provider: AgentProvider;
      model: string | null;
      resetAt: number | null;
      options: ExhaustionOption[];
      /** The room policy's pre-chosen option, or null → needs_user_decision. */
      chosen: ExhaustionOption | null;
      needsUserDecision: boolean;
      reason: string;
    }
  | { kind: "not_a_usage_failure"; provider: AgentProvider; reason: string };

type ExhaustionEntry = { resetAt: number | null };

const key = (provider: string, model?: string | null) =>
  model ? `${provider}\u0000${model}` : provider;

export class UsageGovernor {
  #paidUsage = false;
  readonly #exhausted = new Map<string, ExhaustionEntry>();
  readonly #preserve = new Set<AgentProvider>();
  readonly #prefer = new Set<AgentProvider>();
  readonly #avoid = new Set<string>();
  readonly #remaining = new Map<string, Exclude<RemainingUsage, "unknown">>();

  get paidUsage(): boolean {
    return this.#paidUsage;
  }

  /**
   * Turning paid usage ON requires `{ confirmedByUser: true }` from a real
   * user action. Turning it off is always allowed.
   */
  setPaidUsage(enabled: boolean, confirmation?: { confirmedByUser: true }): void {
    if (typeof enabled !== "boolean") throw new TypeError("paid usage must be a boolean");
    if (!enabled) {
      this.#paidUsage = false;
      return;
    }
    if (
      confirmation === null ||
      typeof confirmation !== "object" ||
      (confirmation as { confirmedByUser?: unknown }).confirmedByUser !== true
    ) {
      throw new Error("Paid usage can only be enabled by an explicit user confirmation.");
    }
    this.#paidUsage = true;
  }

  /** Mark a whole provider (no model) or one model as out of included usage. */
  markExhausted(provider: AgentProvider, model?: string | null, resetAt?: number | null): void {
    if (resetAt !== undefined && resetAt !== null && !Number.isFinite(resetAt)) {
      throw new TypeError("resetAt must be a finite epoch-milliseconds number");
    }
    this.#exhausted.set(key(provider, model), { resetAt: resetAt ?? null });
  }

  /** Clear an exhaustion mark by hand (e.g. the user says the allowance is back). */
  clearExhausted(provider: AgentProvider, model?: string | null): void {
    this.#exhausted.delete(key(provider, model));
  }

  #live(entry: ExhaustionEntry, now: number): boolean {
    return entry.resetAt === null || now < entry.resetAt;
  }

  isAvailable(provider: AgentProvider, model: string | null, now: number): boolean {
    const whole = this.#exhausted.get(key(provider));
    if (whole && this.#live(whole, now)) return false;
    if (model) {
      const one = this.#exhausted.get(key(provider, model));
      if (one && this.#live(one, now)) return false;
    }
    return true;
  }

  /**
   * The set the router consumes: provider names and model ids that are
   * currently exhausted. An exhaustion with no reset time stays until cleared.
   */
  exhausted(now: number): Set<string> {
    const out = new Set<string>();
    for (const [k, entry] of this.#exhausted) {
      if (!this.#live(entry, now)) continue;
      const [provider, model] = k.split("\u0000");
      out.add(model ?? provider!);
    }
    return out;
  }

  /** Drop every mark whose reset time has passed. Returns what was cleared. */
  resetIfDue(now: number): { provider: string; model: string | null }[] {
    const cleared: { provider: string; model: string | null }[] = [];
    for (const [k, entry] of [...this.#exhausted]) {
      if (entry.resetAt !== null && now >= entry.resetAt) {
        this.#exhausted.delete(k);
        const [provider, model] = k.split("\u0000");
        cleared.push({ provider: provider!, model: model ?? null });
      }
    }
    return cleared;
  }

  /**
   * Turn a run failure into a usage decision. A quota failure marks the
   * provider/model exhausted and returns the options; it never names, picks or
   * retries another provider. `roomChoice` is an option the room policy has
   * already chosen (then no user decision is needed).
   */
  decide(failure: UsageFailure, roomChoice?: ExhaustionOption | null): UsageDecision {
    if (failure.failure !== "quota_exhausted") {
      return {
        kind: "not_a_usage_failure",
        provider: failure.provider,
        reason: `"${failure.failure}" is not a usage failure; the usage governor takes no action.`,
      };
    }
    const model = failure.model ?? null;
    const resetAt = failure.resetAt ?? null;
    this.markExhausted(failure.provider, model, resetAt);
    const chosen =
      roomChoice && (EXHAUSTION_OPTIONS as readonly string[]).includes(roomChoice)
        ? roomChoice
        : null;
    const what = model ? `${failure.provider} model ${model}` : failure.provider;
    const when = resetAt === null ? "at an unknown time" : `at ${new Date(resetAt).toISOString()}`;
    return {
      kind: "quota_exhausted",
      provider: failure.provider,
      model,
      resetAt,
      options: [...EXHAUSTION_OPTIONS],
      chosen,
      needsUserDecision: chosen === null,
      reason:
        `Included usage for ${what} is exhausted (resets ${when}). ` +
        (chosen
          ? `The room policy already chose "${chosen}".`
          : "No other provider is used automatically; the user decides."),
    };
  }

  preserve(provider: AgentProvider, on = true): void {
    if (on) this.#preserve.add(provider);
    else this.#preserve.delete(provider);
  }

  prefer(provider: AgentProvider, on = true): void {
    if (on) this.#prefer.add(provider);
    else this.#prefer.delete(provider);
  }

  avoid(model: string, on = true): void {
    if (on) this.#avoid.add(model);
    else this.#avoid.delete(model);
  }

  preferredProviders(): AgentProvider[] {
    return [...this.#prefer].sort();
  }

  hints(provider: AgentProvider): RouteHints {
    return {
      preserve: this.#preserve.has(provider),
      preferred: this.#prefer.has(provider),
      avoid: new Set(this.#avoid),
    };
  }

  /**
   * Record a remaining-usage figure. Only accepted with a named official
   * source; there is no way to store an estimate.
   */
  setRemaining(
    provider: AgentProvider,
    value: number,
    unit: "percent" | "requests" | "tokens",
    source: string,
    observedAt: number,
    model?: string | null,
  ): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("remaining must be ≥ 0");
    if (unit === "percent" && value > 100) throw new RangeError("a percentage cannot exceed 100");
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("A remaining-usage figure needs its official source.");
    }
    this.#remaining.set(key(provider, model), { value, unit, source: source.trim(), observedAt });
  }

  remaining(provider: AgentProvider, model?: string | null): RemainingUsage {
    return this.#remaining.get(key(provider, model)) ?? "unknown";
  }
}
