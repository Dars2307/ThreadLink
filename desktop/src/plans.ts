/**
 * Providers & plans for the desktop app: pure, Electron-free, unit-tested.
 *
 * The server is the only source of truth for the plan the owner declared. This
 * module never stores one; main keeps at most an in-memory copy of the last
 * server response. What the provider's own CLI reported ("detected") is shown
 * beside it, never instead of it.
 *
 * The plan lists mirror runtime/src/team/types.ts (CLAUDE_PLANS, CHATGPT_PLANS)
 * and the server's check constraint. ChatGPT has no generic "Business" and no
 * "Team": those legacy values are refused here as they are on the server.
 */

export const PLAN_PROVIDERS = ["claude-code", "codex"] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

export const CLAUDE_PLAN_OPTIONS = [
  ["free", "Free"],
  ["pro", "Pro"],
  ["max_5x", "Max 5×"],
  ["max_20x", "Max 20×"],
  ["team", "Team"],
  ["enterprise", "Enterprise"],
  ["unknown", "Not set"],
] as const;

export const CHATGPT_PLAN_OPTIONS = [
  ["free", "Free"],
  ["go", "Go"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["business_standard", "Business Standard"],
  ["business_premium", "Business Premium"],
  ["enterprise", "Enterprise"],
  ["edu", "Edu"],
  ["unknown", "Not set"],
] as const;

const OPTIONS: Record<PlanProvider, readonly (readonly [string, string])[]> = {
  "claude-code": CLAUDE_PLAN_OPTIONS,
  codex: CHATGPT_PLAN_OPTIONS,
};

const PROVIDER_NAMES: Record<PlanProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const USAGE_POLICY_LABELS: Record<string, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  maximum_quality: "Maximum quality",
  manual: "Manual",
};

export const CODEX_NOT_REPORTED =
  "Codex doesn't report your plan — ThreadLink uses the plan you chose.";
export const NOT_SET = "Not set — choose your plan";
export const SAVED = "Saved";
export const SAVE_FAILED = "Couldn't save your plan — nothing changed";

export function isPlanProvider(v: unknown): v is PlanProvider {
  return typeof v === "string" && (PLAN_PROVIDERS as readonly string[]).includes(v);
}

export function planValues(provider: PlanProvider): string[] {
  return OPTIONS[provider].map(([value]) => value);
}

export function isPlanFor(provider: PlanProvider, v: unknown): v is string {
  return typeof v === "string" && planValues(provider).includes(v);
}

/**
 * The only shape `plans:set` accepts from the renderer: a known provider and a
 * plan from that provider's list, compared exactly (no trimming, no case
 * folding). Anything else, including ChatGPT's retired "business"/"team", is
 * refused before the Runtime is called.
 */
export function parsePlanRequest(
  rawProvider: unknown,
  rawPlan: unknown,
): { provider: PlanProvider; plan: string } | null {
  if (!isPlanProvider(rawProvider)) return null;
  if (!isPlanFor(rawProvider, rawPlan)) return null;
  return { provider: rawProvider, plan: rawPlan };
}

// ---------------------------------------------------------------------------
// What the server sent, normalised
// ---------------------------------------------------------------------------

export type PlanProfile = {
  provider: PlanProvider;
  declaredPlan: string;
  usagePolicy: string | null;
  paidUsageEnabled: boolean | null;
  detectedPlan: string | null;
};

const str = (v: unknown, max = 64): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/**
 * Accepts the Runtime's answer as either `[...]` or `{ profiles: [...] }`, with
 * camelCase or snake_case keys, and keeps only what this screen shows. A row
 * for an unknown provider, or without a declared plan, is dropped.
 */
export function normalizeProfiles(raw: unknown): PlanProfile[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { profiles?: unknown }).profiles)
      ? (raw as { profiles: unknown[] }).profiles
      : null;
  if (!list) return null;
  const out: PlanProfile[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (!isPlanProvider(r.provider)) continue;
    const declared = str(r.declaredPlan ?? r.declared_plan);
    if (!declared) continue;
    const detected = (r.detected && typeof r.detected === "object" ? r.detected : {}) as Record<
      string,
      unknown
    >;
    const paid = r.paidUsageEnabled ?? r.paid_usage_enabled;
    out.push({
      provider: r.provider,
      declaredPlan: declared,
      usagePolicy: str(r.usagePolicy ?? r.usage_policy),
      paidUsageEnabled: typeof paid === "boolean" ? paid : null,
      detectedPlan: str(detected.detectedPlan ?? detected.detected_plan, 40),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type PlanView = {
  provider: PlanProvider;
  providerName: string;
  /** The plan the server holds, as a value from `options` ("unknown" when not set). */
  declared: string;
  /** "Your plan", in words. */
  yourPlan: string;
  notSet: boolean;
  /** "Provider reported", in words. */
  reported: string;
  options: { value: string; label: string }[];
  usagePolicy: string;
  paidUsage: string;
};

function humanize(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40);
  return clean.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Unrecognised";
}

/** A Claude plan as the Claude Code CLI reported it, in the words of the plan list. */
export function reportedPlanText(
  provider: PlanProvider,
  detectedPlan: string | null,
  signedIn: boolean | null,
): string {
  if (provider === "codex") return CODEX_NOT_REPORTED;
  if (!detectedPlan) {
    return signedIn === false
      ? "Sign in to Claude Code to see the plan it reports."
      : "Claude Code hasn't reported a plan yet.";
  }
  const key = detectedPlan
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  // The CLI says "max" without saying which Max; do not guess.
  if (key === "max") return "Max";
  const hit = CLAUDE_PLAN_OPTIONS.find(([value]) => value === key && value !== "unknown");
  return hit ? hit[1] : humanize(detectedPlan);
}

export function planView(
  provider: PlanProvider,
  profile: PlanProfile | null,
  local: { detectedPlan?: string | null; authenticated?: boolean } | null = null,
): PlanView {
  const options = OPTIONS[provider].map(([value, label]) => ({ value, label }));
  const raw = profile?.declaredPlan ?? "unknown";
  const known = isPlanFor(provider, raw);
  const declared = known ? raw : "unknown";
  const notSet = declared === "unknown";
  const legacy = provider === "codex" && (raw === "team" || raw === "business");
  const yourPlan = notSet
    ? legacy
      ? "Not set — choose Business Standard or Business Premium"
      : NOT_SET
    : (options.find((o) => o.value === declared)?.label ?? NOT_SET);
  // This computer's own detection is fresher than the copy on the server.
  const detected = local?.detectedPlan ?? profile?.detectedPlan ?? null;
  return {
    provider,
    providerName: PROVIDER_NAMES[provider],
    declared,
    yourPlan,
    notSet,
    reported: reportedPlanText(provider, detected, local?.authenticated ?? null),
    options,
    usagePolicy: profile?.usagePolicy
      ? (USAGE_POLICY_LABELS[profile.usagePolicy] ?? humanize(profile.usagePolicy))
      : "Not available",
    paidUsage:
      profile?.paidUsageEnabled === true
        ? "On"
        : profile?.paidUsageEnabled === false
          ? "Off"
          : "Not available",
  };
}

/** One view per provider, in a stable order. */
export function planViews(
  profiles: PlanProfile[],
  local: { provider: string; detectedPlan?: string | null; authenticated?: boolean }[] = [],
): PlanView[] {
  return PLAN_PROVIDERS.map((provider) =>
    planView(
      provider,
      profiles.find((p) => p.provider === provider) ?? null,
      local.find((l) => l.provider === provider) ?? null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Adapter to the Runtime (names reconciled by the lead)
// ---------------------------------------------------------------------------

export type PlanBackend = {
  getProfiles(): Promise<unknown>;
  setDeclaredPlan(provider: PlanProvider, plan: string): Promise<unknown>;
};

type AnyFn = (...args: unknown[]) => Promise<unknown>;

function method(target: unknown, names: readonly string[]): AnyFn | null {
  if (!target || typeof target !== "object") return null;
  for (const name of names) {
    const fn = (target as Record<string, unknown>)[name];
    if (typeof fn === "function") return (...args) => Promise.resolve(fn.apply(target, args));
  }
  return null;
}

/** Engine-level names first (the lead's plan), then the API client's. */
export const PROFILE_READERS = ["getProviderProfiles", "providerProfiles"] as const;
export const PLAN_WRITERS = ["setDeclaredPlan", "setProviderPlan"] as const;

/**
 * Finds how to read profiles and set the declared plan on whatever the Runtime
 * offers. Null (fail closed) when either half is missing.
 */
export function planBackend(engine: unknown, api: unknown): PlanBackend | null {
  const read = method(engine, PROFILE_READERS) ?? method(api, PROFILE_READERS);
  const write = method(engine, PLAN_WRITERS) ?? method(api, PLAN_WRITERS);
  if (!read || !write) return null;
  return {
    getProfiles: () => read(),
    setDeclaredPlan: (provider, plan) => write(provider, plan),
  };
}

// ---------------------------------------------------------------------------
// The two IPC operations, without Electron (main.ts only wires them up)
// ---------------------------------------------------------------------------

export type PlansResult =
  | { ok: true; stale: boolean; providers: PlanView[] }
  | { ok: false; error: "unavailable" | "failed" };

export type SavePlanResult =
  | { ok: true; providers: PlanView[] | null }
  | {
      ok: false;
      error: "invalid" | "unavailable" | "failed" | "not-stored";
      providers?: PlanView[];
    };

type LocalDetection = { provider: string; detectedPlan?: string | null; authenticated?: boolean };

/**
 * Always asks the server. The last answer (memory only) is used just when the
 * server cannot be reached, and is marked stale so the screen can say so.
 */
export async function loadPlans(
  backend: PlanBackend | null,
  local: LocalDetection[],
  cache: { profiles: PlanProfile[] | null },
): Promise<PlansResult> {
  if (backend) {
    try {
      const profiles = normalizeProfiles(await backend.getProfiles());
      if (profiles) {
        cache.profiles = profiles;
        return { ok: true, stale: false, providers: planViews(profiles, local) };
      }
    } catch {
      /* fall through to the cache */
    }
  }
  if (cache.profiles) return { ok: true, stale: true, providers: planViews(cache.profiles, local) };
  return { ok: false, error: backend ? "failed" : "unavailable" };
}

/**
 * Validates, sets, then re-reads. Nothing reaches the Runtime unless the
 * provider and plan are on the allow-list, and success means the server now
 * holds exactly the plan that was asked for.
 */
export async function savePlan(
  backend: PlanBackend | null,
  rawProvider: unknown,
  rawPlan: unknown,
  reload: () => Promise<PlansResult>,
): Promise<SavePlanResult> {
  const request = parsePlanRequest(rawProvider, rawPlan);
  if (!request) return { ok: false, error: "invalid" };
  if (!backend) return { ok: false, error: "unavailable" };
  try {
    await backend.setDeclaredPlan(request.provider, request.plan);
  } catch {
    return { ok: false, error: "failed" };
  }
  const after = await reload();
  // Saved, but the fresh copy could not be read: the screen asks again.
  if (!after.ok || after.stale) return { ok: true, providers: null };
  const stored = after.providers.find((p) => p.provider === request.provider)?.declared;
  return stored === request.plan
    ? { ok: true, providers: after.providers }
    : { ok: false, error: "not-stored", providers: after.providers };
}
