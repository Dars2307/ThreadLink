/**
 * Provider health for the desktop app: pure, Electron-free, unit-tested.
 *
 * "Signed in" from a CLI's status command is not proof that it works (a
 * Claude Code OAuth token can fail to refresh while `claude auth status` still
 * says logged in). Only the Runtime's authenticated probe is. This module shows
 * what that probe last found, in fixed words, and never anything the CLI
 * printed: no stderr, no free text, no paths.
 *
 * The Runtime's field and method names are read through a small tolerant
 * adapter (like plans.ts): anything unrecognised is shown as "Not checked
 * yet", never as Ready.
 */

import { PLAN_PROVIDERS, type PlanProvider } from "./plans.js";

export const HEALTH_VALUES = [
  "ready",
  "needs_sign_in",
  "not_installed",
  "api_key_auth",
  "usage_exhausted",
  "unknown",
] as const;
export type Health = (typeof HEALTH_VALUES)[number];

/** The user-facing words for each health value (docs/design/chat-first.md §2). */
export const HEALTH_TEXT: Record<Health, string> = {
  ready: "Ready",
  needs_sign_in: "Needs sign-in",
  not_installed: "Not installed",
  api_key_auth: "Uses an API key — sign in with your subscription",
  usage_exhausted: "Usage limit reached",
  unknown: "Not checked yet",
};

export const SIGN_IN_INSTRUCTION =
  "Open a terminal and run `claude` (or `codex login` for Codex) to sign in again, then press Check again.";

export const PROVIDER_NAMES: Record<PlanProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export type HealthTone = "ready" | "wait" | "fail";

const TONE: Record<Health, HealthTone> = {
  ready: "ready",
  needs_sign_in: "fail",
  not_installed: "fail",
  api_key_auth: "fail",
  usage_exhausted: "wait",
  unknown: "wait",
};

export function isHealth(v: unknown): v is Health {
  return typeof v === "string" && (HEALTH_VALUES as readonly string[]).includes(v);
}

export function isProvider(v: unknown): v is PlanProvider {
  return typeof v === "string" && (PLAN_PROVIDERS as readonly string[]).includes(v);
}

/** A provider's display name, or a neutral phrase for anything unknown. */
export function providerName(v: unknown): string {
  return isProvider(v) ? PROVIDER_NAMES[v] : "An agent";
}

// ---------------------------------------------------------------------------
// Reading whatever the Runtime sends
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const obj = (v: unknown): Row | null => (v && typeof v === "object" ? (v as Row) : null);

/** An ISO timestamp, or null. Never passes free text through. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The health value on one row, tolerating `health`, `healthStatus` or `health: { status }`. */
function healthOf(row: Row): {
  health: Health | null;
  checkedAt: string | null;
  resetsAt: string | null;
} {
  const raw = row.health ?? row.healthStatus ?? row.health_status;
  const nested = obj(raw);
  const value = nested ? (nested.status ?? nested.value ?? nested.health) : raw;
  const checked =
    row.healthCheckedAt ??
    row.health_checked_at ??
    nested?.checkedAt ??
    nested?.checked_at ??
    row.checkedAt;
  // 0.11 §5: only when the provider actually reported it; never invented.
  const resets = row.resetsAt ?? row.resets_at ?? nested?.resetsAt ?? nested?.resets_at;
  return {
    health: isHealth(value) ? value : null,
    checkedAt: isoOrNull(checked),
    resetsAt: isoOrNull(resets),
  };
}

/** Rows keyed by provider, from a list or a `{ provider: row }` record. */
function rowsOf(source: unknown): Map<PlanProvider, Row> {
  const out = new Map<PlanProvider, Row>();
  if (Array.isArray(source)) {
    for (const item of source) {
      const row = obj(item);
      const id = row?.provider ?? row?.id;
      if (row && isProvider(id) && !out.has(id)) out.set(id, row);
    }
  } else {
    const record = obj(source);
    for (const [id, value] of Object.entries(record ?? {})) {
      const row = obj(value) ?? (isHealth(value) ? { health: value } : null);
      if (row && isProvider(id)) out.set(id, row);
    }
  }
  return out;
}

export type HealthView = {
  provider: PlanProvider;
  providerName: string;
  health: Health;
  /** Fixed words, e.g. "Needs sign-in"; "Stale" for a Ready check that is too old. */
  text: string;
  /** "Claude Code — Needs sign-in". */
  line: string;
  tone: HealthTone;
  /** When the Runtime last probed, ISO, or null when it never said. */
  checkedAt: string | null;
  /** The fixed sign-in instruction, only when a sign-in is what is needed. */
  instruction: string | null;
  /** 0.10: the ONE freshness verdict. Only "ready" may be shown as Ready. */
  fresh: Freshness;
  /** "checked 23 s ago" / "last checked 2 h ago" / "not checked recently" / null. */
  when: string | null;
  /** "Ready · checked 23 s ago" / "Stale · last checked 2 h ago". */
  status: string;
  /** 0.11: when an exhausted plan resets, ISO — only when the provider reported it. */
  resetsAt?: string | null;
};

// ---------------------------------------------------------------------------
// Freshness (design 0.10 §8): one calculation, never "Ready" beside stale text.
// ---------------------------------------------------------------------------

/** A Ready check older than this is Stale. Same rule as the server and the terminal. */
export const HEALTH_FRESH_MS = 2 * 60 * 60 * 1000;

export type Freshness = "ready" | "stale" | "problem" | "unknown";

/** "23 s ago", "4 min ago", "2 h ago", "3 days ago". */
export function agoText(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function freshnessOf(
  health: Health,
  checkedAt: string | null,
  now = Date.now(),
): { fresh: Freshness; text: string; when: string | null; tone: HealthTone } {
  const t = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const known = Number.isFinite(t);
  if (health === "ready") {
    if (known && now - t <= HEALTH_FRESH_MS) {
      return {
        fresh: "ready",
        text: "Ready",
        when: `checked ${agoText(checkedAt!, now)}`,
        tone: "ready",
      };
    }
    return {
      fresh: "stale",
      text: "Stale",
      when: known ? `last checked ${agoText(checkedAt!, now)}` : "not checked recently",
      tone: "wait",
    };
  }
  return {
    fresh: health === "unknown" ? "unknown" : "problem",
    text: HEALTH_TEXT[health],
    when: known && health !== "unknown" ? `checked ${agoText(checkedAt!, now)}` : null,
    tone: TONE[health],
  };
}

export function healthView(
  provider: PlanProvider,
  health: Health,
  checkedAt: string | null,
  now = Date.now(),
) {
  const name = PROVIDER_NAMES[provider];
  const f = freshnessOf(health, checkedAt, now);
  return {
    provider,
    providerName: name,
    health,
    text: f.text,
    line: `${name} — ${f.text}`,
    tone: f.tone,
    checkedAt,
    instruction: health === "needs_sign_in" ? SIGN_IN_INSTRUCTION : null,
    fresh: f.fresh,
    when: f.when,
    status: f.when ? `${f.text} · ${f.when}` : f.text,
  } satisfies HealthView;
}

/**
 * The global status words (0.10): "1 agent working", "2 agents ready",
 * "Execution host online" -- never "Claude is open". `working` counts agents
 * doing something in a running job right now.
 */
export function agentsSummary(views: HealthView[], working: number): string {
  if (working > 0) return `${working} agent${working === 1 ? "" : "s"} working`;
  const ready = views.filter((v) => v.fresh === "ready").length;
  if (ready > 0) return `${ready} agent${ready === 1 ? "" : "s"} ready`;
  return "Execution host online";
}

/** Distinct providers doing something in a running team job (from the snapshot). */
export function workingAgents(team: unknown): number {
  const busy = new Set<string>();
  for (const job of Array.isArray(team) ? team : []) {
    const j = obj(job);
    if (!j || j.running === false) continue;
    for (const a of Array.isArray(j.agents) ? j.agents : []) {
      const agent = obj(a);
      if (agent && typeof agent.provider === "string" && agent.doing) busy.add(agent.provider);
    }
  }
  return busy.size;
}

/**
 * One view per known provider, in a stable order, from the engine snapshot.
 * Reads `teamProviders[].health` (and a separate `providerHealth` list or
 * record, if the Runtime sends one). A provider with no recognised health is
 * "Not checked yet" -- except one discovery could not find at all, which is
 * truthfully "Not installed".
 */
export function healthViews(snapshot: unknown, now = Date.now()): HealthView[] {
  const snap = obj(snapshot);
  const team = rowsOf(snap?.teamProviders);
  const extra = rowsOf(snap?.providerHealth);
  return PLAN_PROVIDERS.map((provider) => {
    const fromExtra = extra.get(provider);
    const fromTeam = team.get(provider);
    const found =
      (fromExtra && healthOf(fromExtra).health ? healthOf(fromExtra) : null) ??
      (fromTeam ? healthOf(fromTeam) : { health: null, checkedAt: null, resetsAt: null });
    let health: Health = found.health ?? "unknown";
    if (!found.health && fromTeam?.installed === false) health = "not_installed";
    const view: HealthView = healthView(provider, health, found.checkedAt, now);
    return health === "usage_exhausted" && found.resetsAt
      ? { ...view, resetsAt: found.resetsAt }
      : view;
  });
}

// ---------------------------------------------------------------------------
// "Check again": validation, rate limit, adapter
// ---------------------------------------------------------------------------

/** Once per 30 s, in main as well as in the renderer. */
export const CHECK_INTERVAL_MS = 30_000;

export class CheckLimiter {
  #last = Number.NEGATIVE_INFINITY;
  #busy = false;
  constructor(
    private readonly intervalMs = CHECK_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts a check if one is allowed now; otherwise says how long to wait. */
  tryStart(): { ok: true } | { ok: false; retryInSeconds: number } {
    const t = this.now();
    const wait = this.#last + this.intervalMs - t;
    if (this.#busy) return { ok: false, retryInSeconds: Math.max(1, Math.ceil(wait / 1000)) };
    if (wait > 0) return { ok: false, retryInSeconds: Math.ceil(wait / 1000) };
    this.#last = t;
    this.#busy = true;
    return { ok: true };
  }

  finish(): void {
    this.#busy = false;
  }
}

/** Engine method names for "re-probe now", best guess first (the lead reconciles). */
export const HEALTH_CHECKERS = [
  "checkProviders",
  "checkProviderHealth",
  "recheckProviders",
  "probeProviders",
  "refreshProviderHealth",
] as const;

export type HealthBackend = { check(): Promise<unknown> };

/** Finds the engine's re-probe method. Null (fail closed) when there is none. */
export function healthBackend(engine: unknown): HealthBackend | null {
  const target = obj(engine);
  if (!target) return null;
  for (const name of HEALTH_CHECKERS) {
    const fn = target[name];
    if (typeof fn === "function") {
      return { check: () => Promise.resolve(fn.call(engine)) };
    }
  }
  return null;
}

export type CheckAgainResult =
  | { ok: true; providers: HealthView[] }
  | {
      ok: false;
      error: "invalid" | "too-soon" | "unavailable" | "failed";
      retryInSeconds?: number;
      providers?: HealthView[];
    };

/**
 * The `providers:check` IPC operation without Electron. The renderer may name
 * one provider (or none); anything else is refused before the limiter or the
 * Runtime is touched. The probe re-checks every provider; its own errors are
 * never passed on, only a fixed code.
 */
export async function checkAgain(
  backend: HealthBackend | null,
  rawProvider: unknown,
  limiter: CheckLimiter,
  read: () => HealthView[],
): Promise<CheckAgainResult> {
  if (rawProvider !== undefined && rawProvider !== null && !isProvider(rawProvider)) {
    return { ok: false, error: "invalid" };
  }
  if (!backend) return { ok: false, error: "unavailable" };
  const slot = limiter.tryStart();
  if (!slot.ok) return { ok: false, error: "too-soon", retryInSeconds: slot.retryInSeconds };
  try {
    await backend.check();
  } catch {
    return { ok: false, error: "failed", providers: read() };
  } finally {
    limiter.finish();
  }
  return { ok: true, providers: read() };
}
