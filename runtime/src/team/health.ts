/**
 * Provider health (docs/design/chat-first.md §2).
 *
 * `claude auth status` said `loggedIn: true` on a computer where Claude Code
 * could no longer refresh its OAuth token, and the first agent run of a Team
 * job failed. Status output is not proof of a working sign-in; only an
 * authenticated call is. So each provider is checked with the smallest real
 * call there is -- "Reply with OK", no tools, the lightest model, one turn --
 * run exactly like a Team run: the same scrubbed environment, the same
 * subscription-only rule, the same forbidden-flag check, stdin closed.
 *
 * Scheduling (ProviderHealthMonitor):
 *   - at Runtime start;
 *   - at most every 30 minutes while idle (`tick`);
 *   - at job claim when the cached result is older than 10 minutes (`ensureFresh`);
 *   - an auth-classified failure in a real run marks the provider at once
 *     (`noteFailure`); that failure is the evidence, so no extra call is made;
 *   - never in a loop: while a provider needs sign-in (or is out of usage) it
 *     is not probed again for at least 10 minutes, unless the person asks
 *     ("Check again" → `checkAll({ force: true })`).
 *
 * What leaves this module is an enum, a timestamp and a short FIXED sentence.
 * Provider output (stderr, the answer) is never stored or reported.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseClaudeOutput } from "../executor.ts";
import type { ProviderDiscovery } from "./discovery.ts";
import { buildAgentEnv, type EnvLike } from "./env.ts";
import { classifyModels, isSelectable } from "./models.ts";
import { SUBSCRIPTION_AUTH } from "./providers.ts";
import {
  classifyFailureText,
  forbiddenArg,
  processFailure,
  runProcess,
  type AgentRunFailure,
  type SpawnFn,
} from "./runner.ts";
import { newCodexEventState, onCodexEvent } from "./runners/codex.ts";
import { AGENT_PROVIDERS, MODEL_CLASSES, type AgentProvider } from "./types.ts";

/** Mirrors PROVIDER_HEALTH in lib/chat/types.ts. */
export const PROVIDER_HEALTH = [
  "ready",
  "needs_sign_in",
  "not_installed",
  "api_key_auth",
  "usage_exhausted",
  "unknown",
] as const;
export type ProviderHealth = (typeof PROVIDER_HEALTH)[number];

/** The only text ever reported with a health value. Never provider output. */
export const HEALTH_DETAIL: Record<ProviderHealth, string> = {
  ready: "Signed in and answering.",
  needs_sign_in: "Needs you to sign in again on this computer.",
  not_installed: "Not installed on this computer.",
  api_key_auth:
    "Signed in with an API key, which would bill per use. Sign in with your subscription.",
  usage_exhausted: "Usage limit reached.",
  unknown: "Not checked yet, or the check could not finish.",
};

export type HealthRecord = {
  provider: AgentProvider;
  health: ProviderHealth;
  /** ISO time of the observation this health rests on. Null when never checked. */
  checkedAt: string | null;
  detail: string;
};

/** "ok" when the authenticated call answered; otherwise why it did not. */
export type ProbeResult = "ok" | AgentRunFailure;
export type ProbeFn = (provider: AgentProvider, found: ProviderDiscovery) => Promise<ProbeResult>;

export const PROBE_TIMEOUT_MS = 60_000;
export const HEALTH_IDLE_INTERVAL_MS = 30 * 60_000;
export const HEALTH_CLAIM_MAX_AGE_MS = 10 * 60_000;
export const HEALTH_FAILURE_BACKOFF_MS = 10 * 60_000;
/** How long a failure counts against a provider when roles are assigned. */
export const RECENT_FAILURE_WINDOW_MS = 6 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What discovery alone already settles, without a call. Null means "installed
 * and signed in with the subscription": only a real call can say more.
 */
export function staticHealth(found: ProviderDiscovery | undefined): ProviderHealth | null {
  if (!found || !found.installed) return "not_installed";
  if (!found.authenticated) return "needs_sign_in";
  if (found.authMethod === null || !SUBSCRIPTION_AUTH[found.provider].includes(found.authMethod)) {
    return "api_key_auth";
  }
  return null;
}

export function healthFromProbe(result: ProbeResult): ProviderHealth {
  switch (result) {
    case "ok":
      return "ready";
    case "not_authenticated":
      return "needs_sign_in";
    case "quota_exhausted":
      return "usage_exhausted";
    case "not_installed":
      return "not_installed";
    default:
      // A timeout, a network error or anything unexpected proves nothing either way.
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// The probe call
// ---------------------------------------------------------------------------

const PROBE_PROMPT = "[ThreadLink health check] Reply with OK.";
const CLASS_RANK = Object.fromEntries(MODEL_CLASSES.map((c, i) => [c, i])) as Record<
  (typeof MODEL_CLASSES)[number],
  number
>;

/** The lightest selectable model discovery knows for a provider, or null for the CLI default. */
export function lightestModel(found: ProviderDiscovery): { id: string; efforts: string[] } | null {
  const classified = classifyModels(
    found.provider,
    found.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    })),
  ).filter(isSelectable);
  classified.sort(
    (a, b) =>
      CLASS_RANK[a.modelClass] - CLASS_RANK[b.modelClass] ||
      Number(a.legacy) - Number(b.legacy) ||
      a.id.localeCompare(b.id),
  );
  const pick = classified[0];
  return pick ? { id: pick.id, efforts: pick.efforts } : null;
}

/**
 * `claude -p` with no tools and nothing persisted. Never --bare (API-key
 * billing). `--tools ""` removes every tool, so the answer is a single turn.
 */
export function buildClaudeProbeArgs(model: string | null): string[] {
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  args.push(
    "--safe-mode",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
  );
  return args;
}

/**
 * `codex exec` read-only with the runner's safe flags; the probe runs in an
 * empty temporary folder, so it skips the git-repository check. The prompt is
 * the last argument and stdin is never opened.
 */
export function buildCodexProbeArgs(
  model: { id: string; efforts: string[] } | null,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
  ];
  if (model) args.push("-m", model.id);
  if (platform === "win32") args.push("-c", 'windows.sandbox="unelevated"');
  if (model?.efforts.includes("low")) args.push("-c", 'model_reasoning_effort="low"');
  args.push("-C", cwd, PROBE_PROMPT);
  return args;
}

export type ProbeOptions = {
  spawnFn?: SpawnFn;
  env?: EnvLike;
  timeoutMs?: number;
  /** Claude executable when discovery did not record one. */
  claudeCommand?: string;
};

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "threadlink-probe-"));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a killed child on Windows can hold it briefly; the OS cleans temp */
    }
  }
}

export async function probeClaude(
  found: ProviderDiscovery,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const model = lightestModel(found);
  const args = buildClaudeProbeArgs(model?.id ?? null);
  if (forbiddenArg(args)) return "provider_error";
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return inTempDir(async (cwd) => {
    const outcome = await runProcess({
      spawnFn: options.spawnFn ?? spawn,
      command: found.executable ?? options.claudeCommand ?? "claude",
      args,
      cwd,
      env: buildAgentEnv(options.env ?? process.env).env,
      stdinText: PROBE_PROMPT,
      timeoutMs,
    });
    const failed = processFailure({ model: model?.id ?? "" }, outcome, "Claude Code", timeoutMs);
    if (failed) return failed.failure ?? "provider_error";
    const parsed = parseClaudeOutput(outcome.stdout) as {
      is_error?: unknown;
      result?: unknown;
    } | null;
    if (parsed && parsed.is_error !== true && outcome.code === 0) return "ok";
    const text = parsed && typeof parsed.result === "string" ? parsed.result : outcome.stdout;
    return classifyFailureText(`${text}\n${outcome.stderr}`) ?? "provider_error";
  });
}

export async function probeCodex(
  found: ProviderDiscovery,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  if (!found.executable) return "not_installed";
  const model = lightestModel(found);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return inTempDir(async (cwd) => {
    const args = buildCodexProbeArgs(model, cwd);
    if (forbiddenArg(args)) return "provider_error";
    const state = newCodexEventState();
    const outcome = await runProcess({
      spawnFn: options.spawnFn ?? spawn,
      command: found.executable!,
      args,
      cwd,
      env: buildAgentEnv(options.env ?? process.env).env,
      stdinText: null,
      timeoutMs,
      onStdoutLine: (line) => onCodexEvent(state, line),
    });
    const failed = processFailure({ model: model?.id ?? "" }, outcome, "Codex", timeoutMs);
    if (failed) return failed.failure ?? "provider_error";
    if (state.turnCompleted && !state.turnFailed && outcome.code === 0) return "ok";
    const diagnostics = [state.turnFailed, ...state.errors, outcome.stderr]
      .filter(Boolean)
      .join("\n");
    return classifyFailureText(diagnostics) ?? "provider_error";
  });
}

/** The real probe, for the Runtime. Never throws. */
/** Pause before re-checking a sign-in failure (a token refresh can fail once and then work). */
export const SIGN_IN_CONFIRM_DELAY_MS = 5_000;

export function probeProvider(
  options: ProbeOptions & { confirmDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): ProbeFn {
  const once = async (provider: AgentProvider, found: ProviderDiscovery): Promise<ProbeResult> => {
    try {
      return provider === "codex"
        ? await probeCodex(found, options)
        : await probeClaude(found, options);
    } catch {
      return "provider_error";
    }
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (provider, found) => {
    const first = await once(provider, found);
    if (first !== "not_authenticated") return first;
    // Observed for real: Claude Code's OAuth refresh failed once and the very
    // next call worked. One failed refresh is not "needs sign-in"; two are.
    await sleep(options.confirmDelayMs ?? SIGN_IN_CONFIRM_DELAY_MS);
    return once(provider, found);
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type HealthMonitorOptions = {
  discover: () => Promise<ProviderDiscovery[]>;
  probe: ProbeFn;
  now?: () => number;
  /** Health changed outside checkAll (at a claim, or after a failed run). */
  onChange?: (changed: AgentProvider[]) => void;
  idleIntervalMs?: number;
  claimMaxAgeMs?: number;
  failureBackoffMs?: number;
};

type State = {
  health: ProviderHealth;
  /** When the observation was made (probe, discovery or failed run). */
  checkedAtMs: number | null;
  /** When a probe was last started, for the backoff. */
  probedAtMs: number | null;
};

const BACKOFF_HEALTH = new Set<ProviderHealth>(["needs_sign_in", "usage_exhausted"]);

export class ProviderHealthMonitor {
  readonly #o: Required<Omit<HealthMonitorOptions, "onChange">> &
    Pick<HealthMonitorOptions, "onChange">;
  readonly #state = new Map<AgentProvider, State>();
  readonly #found = new Map<AgentProvider, ProviderDiscovery>();
  readonly #inflight = new Map<AgentProvider, Promise<void>>();
  #failures: { provider: AgentProvider; at: number }[] = [];
  #lastFullCheck: number | null = null;
  #full: Promise<HealthRecord[]> | null = null;

  constructor(options: HealthMonitorOptions) {
    this.#o = {
      now: Date.now,
      idleIntervalMs: HEALTH_IDLE_INTERVAL_MS,
      claimMaxAgeMs: HEALTH_CLAIM_MAX_AGE_MS,
      failureBackoffMs: HEALTH_FAILURE_BACKOFF_MS,
      ...options,
    };
  }

  /** Every provider ThreadLink runs, "unknown" until checked. */
  records(): HealthRecord[] {
    return AGENT_PROVIDERS.map((p) => this.get(p));
  }

  get(provider: AgentProvider): HealthRecord {
    const s = this.#state.get(provider);
    const health = s?.health ?? "unknown";
    return {
      provider,
      health,
      checkedAt: s?.checkedAtMs != null ? new Date(s.checkedAtMs).toISOString() : null,
      detail: HEALTH_DETAIL[health],
    };
  }

  /** The discovery each health value was derived from (local only). */
  discovery(provider: AgentProvider): ProviderDiscovery | undefined {
    return this.#found.get(provider);
  }

  /**
   * Checks every provider: discovery, then a probe where discovery cannot
   * settle it. `force` is the person's "Check again": it ignores the backoff.
   */
  async checkAll(
    options: { force?: boolean; found?: ProviderDiscovery[] } = {},
  ): Promise<HealthRecord[]> {
    // A scheduled check that is already running is joined, not repeated.
    if (!options.force && this.#full) return this.#full;
    const work = (async () => {
      const found = options.found ?? (await this.#o.discover());
      this.#remember(found);
      await Promise.all(AGENT_PROVIDERS.map((p) => this.#check(p, Boolean(options.force))));
      this.#lastFullCheck = this.#o.now();
      return this.records();
    })();
    if (options.force) return work;
    this.#full = work.finally(() => {
      this.#full = null;
    });
    return this.#full;
  }

  /**
   * At a job claim: each named provider's health, re-checked if the cached
   * result is older than 10 minutes (the backoff still applies).
   */
  async ensureFresh(
    providers: readonly AgentProvider[],
    options: { found?: ProviderDiscovery[] } = {},
  ): Promise<Record<AgentProvider, HealthRecord>> {
    const now = this.#o.now();
    const stale = [...new Set(providers)].filter((p) => {
      const s = this.#state.get(p);
      return s?.checkedAtMs == null || now - s.checkedAtMs > this.#o.claimMaxAgeMs;
    });
    if (stale.length) {
      this.#remember(options.found ?? (await this.#o.discover()));
      await Promise.all(stale.map((p) => this.#check(p, false)));
      // Reported even when the value is the same: the check time moved, and
      // the server gate refuses health older than two hours.
      this.#o.onChange?.(stale);
    }
    return Object.fromEntries(providers.map((p) => [p, this.get(p)])) as Record<
      AgentProvider,
      HealthRecord
    >;
  }

  /** While idle: a full check at most every 30 minutes. True when one ran. */
  async tick(): Promise<boolean> {
    const now = this.#o.now();
    if (this.#lastFullCheck !== null && now - this.#lastFullCheck < this.#o.idleIntervalMs) {
      return false;
    }
    await this.checkAll();
    return true;
  }

  /**
   * A real run failed. An auth or usage failure is itself the observation:
   * the provider is marked at once (and the backoff starts), no call is made.
   */
  noteFailure(provider: AgentProvider, failure: AgentRunFailure): void {
    const now = this.#o.now();
    this.#failures.push({ provider, at: now });
    this.#failures = this.#failures.filter((f) => now - f.at <= RECENT_FAILURE_WINDOW_MS);
    const health: ProviderHealth | null =
      failure === "not_authenticated"
        ? "needs_sign_in"
        : failure === "quota_exhausted"
          ? "usage_exhausted"
          : failure === "not_installed"
            ? "not_installed"
            : null;
    if (!health) return;
    this.#state.set(provider, { health, checkedAtMs: now, probedAtMs: now });
    this.#o.onChange?.([provider]);
  }

  /**
   * A fresh probe of one provider now, ignoring the backoff: used after a run
   * failed on sign-in, to tell a one-off token refresh failure from a real
   * sign-out before the job is stopped.
   */
  async confirm(provider: AgentProvider): Promise<ProviderHealth> {
    await this.#check(provider, true);
    this.#o.onChange?.([provider]);
    return this.get(provider).health;
  }

  /** Failed runs per provider in the last six hours, for role assignment. */
  recentFailures(): Partial<Record<AgentProvider, number>> {
    const now = this.#o.now();
    const counts: Partial<Record<AgentProvider, number>> = {};
    for (const f of this.#failures) {
      if (now - f.at <= RECENT_FAILURE_WINDOW_MS)
        counts[f.provider] = (counts[f.provider] ?? 0) + 1;
    }
    return counts;
  }

  #remember(found: readonly ProviderDiscovery[]): void {
    for (const p of found) this.#found.set(p.provider, p);
  }

  /** One provider; concurrent callers share one probe. */
  #check(provider: AgentProvider, force: boolean): Promise<void> {
    const running = this.#inflight.get(provider);
    if (running) return running;
    const work = this.#checkNow(provider, force).finally(() => this.#inflight.delete(provider));
    this.#inflight.set(provider, work);
    return work;
  }

  async #checkNow(provider: AgentProvider, force: boolean): Promise<void> {
    const found = this.#found.get(provider);
    const settled = staticHealth(found);
    const now = this.#o.now();
    const prev = this.#state.get(provider);
    if (settled) {
      this.#state.set(provider, {
        health: settled,
        checkedAtMs: now,
        probedAtMs: prev?.probedAtMs ?? null,
      });
      return;
    }
    if (
      !force &&
      prev &&
      BACKOFF_HEALTH.has(prev.health) &&
      prev.probedAtMs !== null &&
      now - prev.probedAtMs < this.#o.failureBackoffMs
    ) {
      return; // never probe in a loop on failure
    }
    let result: ProbeResult;
    try {
      result = await this.#o.probe(provider, found!);
    } catch {
      result = "provider_error";
    }
    const done = this.#o.now();
    this.#state.set(provider, {
      health: healthFromProbe(result),
      checkedAtMs: done,
      probedAtMs: now,
    });
  }
}
