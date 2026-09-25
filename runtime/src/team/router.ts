/**
 * Model router: pick one model (and effort) from ONE provider for one role.
 *
 * docs/design/team-mode.md §3.3. Pure: the caller supplies the discovered,
 * classified models, the exhausted set and the preference hints.
 *
 * Guarantees (each is tested):
 * - Never returns a model from another provider. The router is given one
 *   provider and either picks from it or refuses.
 * - Never substitutes silently. An unavailable override, an exhausted tier or
 *   an empty catalogue is `ok: false` with options for the user.
 * - Escalation is stepwise and recorded (`escalatedFrom`, `escalationReason`)
 *   and never passes the policy's ceiling unless a room override allows it.
 * - Every decision carries a specific, human-readable `reason`.
 *
 * Classes are a routing policy, not a quality ranking (see models.ts).
 */

import { isSelectable, type ClassifiedModel } from "./models.ts";
import type { RouteHints } from "./usage.ts";
import {
  MODEL_CLASSES,
  type AgentProvider,
  type ModelClass,
  type TeamRole,
  type UsagePolicy,
} from "./types.ts";

export type { ClassifiedModel } from "./models.ts";

export type Complexity = "trivial" | "low" | "medium" | "high";

export type RouteRisk = {
  security: boolean;
  database: boolean;
  architecture: boolean;
  deployment: boolean;
};

export type RouteOption = "wait_for_reset" | "use_other_provider" | "reduce_tier" | "ask_user";

/**
 * A per-room routing rule. Every field present in `match` must match.
 * - `use`: always use this exact model id ("Always use Fable for Prism architecture").
 *   An explicit `use` is the user's own choice and is honoured above the
 *   policy ceiling; if the model is not available the route fails.
 * - `never`: a model id or a ModelClass that must not be picked
 *   ("Never use Astra for simple tests").
 * - `allowAboveCeiling`: lets automatic escalation pass the policy ceiling.
 */
export type RouteOverride = {
  match: {
    role?: TeamRole | readonly TeamRole[];
    provider?: AgentProvider;
    taskKind?: string | readonly string[];
    complexity?: Complexity | readonly Complexity[];
  };
  use?: string;
  never?: string;
  allowAboveCeiling?: boolean;
  /** How the user phrased it; quoted in the reason. */
  label?: string;
};

export type RouteInput = {
  provider: AgentProvider;
  role: TeamRole;
  complexity: Complexity;
  risk: RouteRisk;
  contextLarge: boolean;
  previousFailures: number;
  disputedFindings: number;
  policy: UsagePolicy;
  overrides: readonly RouteOverride[];
  available: readonly ClassifiedModel[];
  /** Provider names and model ids with no included usage left (UsageGovernor.exhausted). */
  exhausted: ReadonlySet<string>;
  /** Free-form kind of task, matched by overrides (e.g. "architecture", "tests", "rename"). */
  taskKind?: string;
  /** User preference hints from the UsageGovernor. */
  hints?: Partial<RouteHints>;
};

export type RouteDecision =
  | {
      ok: true;
      provider: AgentProvider;
      model: string;
      effort: string | null;
      modelClass: ModelClass;
      reason: string;
      escalatedFrom?: ModelClass;
      escalationReason?: string;
      /** The class the rules asked for, when a lower one had to be used. */
      steppedDownFrom?: ModelClass;
      /** Label of the room override that decided, if any. */
      override?: string;
    }
  | { ok: false; provider: AgentProvider; reason: string; options: RouteOption[] };

const EXHAUSTED_OPTIONS: RouteOption[] = [
  "wait_for_reset",
  "use_other_provider",
  "reduce_tier",
  "ask_user",
];

const REVIEW_ROLES: ReadonlySet<TeamRole> = new Set([
  "reviewer",
  "security_reviewer",
  "test_reviewer",
]);
const PLAN_ROLES: ReadonlySet<TeamRole> = new Set(["planner", "coordinator"]);

const ROLE_NOUN: Record<TeamRole, string> = {
  coordinator: "coordination",
  planner: "planning",
  builder: "implementation",
  reviewer: "review",
  security_reviewer: "security review",
  test_reviewer: "test review",
  integrator: "integration",
  investigator: "investigation",
};

const COMPLEXITY_BASE: Record<Complexity, ModelClass> = {
  trivial: "FAST",
  low: "FAST",
  medium: "BALANCED",
  high: "STRONG",
};

/** Efforts tried in order per class; only ones the model supports are used. */
const EFFORT_PREFERENCE: Record<ModelClass, readonly string[]> = {
  FAST: ["low", "minimal", "medium"],
  BALANCED: ["medium", "high", "low"],
  STRONG: ["high", "xhigh", "medium"],
  FRONTIER: ["xhigh", "high", "medium"],
};

const rank = (c: ModelClass) => MODEL_CLASSES.indexOf(c);
const up = (c: ModelClass): ModelClass => MODEL_CLASSES[Math.min(rank(c) + 1, 3)]!;
const isClass = (v: string): v is ModelClass => (MODEL_CLASSES as readonly string[]).includes(v);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function listMatch<T extends string>(want: T | readonly T[] | undefined, got: T | undefined) {
  if (want === undefined) return true;
  if (got === undefined) return false;
  return typeof want === "string" ? want === got : want.includes(got);
}

function overrideMatches(o: RouteOverride, input: RouteInput): boolean {
  return (
    (o.match.provider === undefined || o.match.provider === input.provider) &&
    listMatch(o.match.role, input.role) &&
    listMatch(o.match.taskKind, input.taskKind) &&
    listMatch(o.match.complexity, input.complexity)
  );
}

function describeOverride(o: RouteOverride): string {
  if (o.label) return `"${o.label}"`;
  return o.use ? `"always use ${o.use}"` : `"never use ${o.never}"`;
}

function riskNames(risk: RouteRisk): string[] {
  return (["security", "database", "architecture", "deployment"] as const).filter((k) => risk[k]);
}

/** Pick an effort for the class from what the model actually supports. */
export function pickEffort(
  model: Pick<ClassifiedModel, "efforts" | "defaultEffort">,
  modelClass: ModelClass,
): string | null {
  const supported = model.efforts ?? [];
  if (supported.length === 0) return null;
  const lower = supported.map((e) => e.toLowerCase());
  for (const wanted of EFFORT_PREFERENCE[modelClass]) {
    const i = lower.indexOf(wanted);
    if (i >= 0) return supported[i]!;
  }
  if (model.defaultEffort && supported.includes(model.defaultEffort)) return model.defaultEffort;
  return supported[0]!;
}

export function selectModel(input: RouteInput): RouteDecision {
  const { provider, role, complexity, policy } = input;
  const fail = (reason: string, options: RouteOption[]): RouteDecision => ({
    ok: false,
    provider,
    reason,
    options,
  });

  const risks = riskNames(input.risk);
  const anyRisk = risks.length > 0;
  const isReview = REVIEW_ROLES.has(role);
  const isPlan = PLAN_ROLES.has(role);
  const task =
    `${cap(complexity)}-complexity ${ROLE_NOUN[role]} (${role})` +
    (input.taskKind ? `, task "${input.taskKind}"` : "") +
    (anyRisk ? `, ${risks.join("/")} risk` : "") +
    ".";

  // Only this provider's selectable models. Never another provider's.
  const candidates = input.available.filter((m) => m.provider === provider && isSelectable(m));
  const isExhausted = (id: string) => input.exhausted.has(id);

  if (input.exhausted.has(provider)) {
    return fail(
      `${task} ${provider} has no included usage left. Not switching provider or tier automatically.`,
      EXHAUSTED_OPTIONS,
    );
  }

  const matched = input.overrides.filter((o) => overrideMatches(o, input));
  const neverModels = new Set<string>();
  const neverClasses = new Set<ModelClass>();
  for (const o of matched) {
    if (!o.never) continue;
    if (isClass(o.never)) neverClasses.add(o.never);
    else neverModels.add(o.never);
  }
  const neverNotes = matched.filter((o) => o.never).map(describeOverride);

  // ── Explicit "always use X" override ──────────────────────────────────────
  const useRules = matched.filter((o) => o.use);
  const useIds = [...new Set(useRules.map((o) => o.use!))];
  if (useIds.length > 1) {
    return fail(
      `${task} Room overrides conflict (${useRules.map(describeOverride).join(", ")}); ask the user which model to use.`,
      ["ask_user"],
    );
  }
  if (useIds.length === 1) {
    const rule = useRules[0]!;
    const id = useIds[0]!;
    const label = describeOverride(rule);
    const model = candidates.find((m) => m.id === id);
    if (!model) {
      return fail(
        `${task} Room override ${label} names ${id}, which is not available for ${provider}. ` +
          "Not picking another model; choose one or update the override.",
        ["ask_user"],
      );
    }
    if (neverModels.has(id) || neverClasses.has(model.modelClass)) {
      return fail(
        `${task} Room override ${label} conflicts with ${neverNotes.join(", ")}; ask the user.`,
        ["ask_user"],
      );
    }
    if (isExhausted(id)) {
      return fail(
        `${task} Room override ${label} names ${id}, which has no included usage left. Not substituting.`,
        EXHAUSTED_OPTIONS,
      );
    }
    return {
      ok: true,
      provider,
      model: id,
      effort: pickEffort(model, model.modelClass),
      modelClass: model.modelClass,
      override: rule.label ?? `always use ${id}`,
      reason: `${task} Room override ${label}: using ${id} (${model.modelClass}).`,
    };
  }

  if (policy === "manual") {
    return fail(
      `${task} The manual usage policy needs the user to choose a ${provider} model for ${ROLE_NOUN[role]}; no override matches.`,
      ["ask_user"],
    );
  }

  // ── Base class: role × complexity × policy ────────────────────────────────
  const notes: string[] = [];
  const preserve = input.hints?.preserve === true;
  let base = COMPLEXITY_BASE[complexity];
  if ((isPlan || role === "reviewer" || role === "security_reviewer") && rank(base) < 1) {
    base = "BALANCED";
    notes.push(`${cap(ROLE_NOUN[role])} is never routed below BALANCED.`);
  }
  if (isPlan && anyRisk && complexity === "high") {
    base = "FRONTIER";
    notes.push(`High-complexity ${risks.join("/")} ${ROLE_NOUN[role]} gets a FRONTIER model.`);
  }
  if (policy === "maximum_quality" && (isPlan || isReview) && base !== "FRONTIER") {
    notes.push(`maximum_quality policy: ${ROLE_NOUN[role]} one class up from ${base}.`);
    base = up(base);
  }
  if (input.contextLarge && base === "FAST") {
    base = "BALANCED";
    notes.push("Large context: not routed to a FAST model.");
  }
  const conservative = policy === "conservative" || preserve;
  if (conservative && rank(base) > rank("BALANCED")) {
    notes.push(
      preserve && policy !== "conservative"
        ? `Preserving the ${provider} allowance: base class held at BALANCED.`
        : "Conservative policy: base class held at BALANCED.",
    );
    base = "BALANCED";
  }
  if (role === "builder" && anyRisk) {
    notes.push(`Stronger model reserved for the final ${risks.join("/")} review.`);
  }

  // ── Escalation: stepwise, recorded ────────────────────────────────────────
  let target = base;
  const escalations: string[] = [];
  if (input.previousFailures >= 2) {
    const next = up(target);
    if (next !== target) {
      escalations.push(`${input.previousFailures} previous failures (${target} → ${next})`);
      target = next;
    }
  }
  if (isReview && input.disputedFindings >= 2 && target !== "FRONTIER") {
    escalations.push(
      `${input.disputedFindings} disputed findings on a review (${target} → FRONTIER)`,
    );
    target = "FRONTIER";
  }
  if (isReview && anyRisk && target !== "FRONTIER") {
    escalations.push(`${risks.join("/")} risk on a review (${target} → FRONTIER)`);
    target = "FRONTIER";
  }

  // ── Ceiling ────────────────────────────────────────────────────────────────
  const lifted = matched.find((o) => o.allowAboveCeiling);
  let ceiling: ModelClass = "FRONTIER";
  if (conservative) ceiling = isReview && anyRisk ? "FRONTIER" : "STRONG";
  if (lifted) ceiling = "FRONTIER";
  if (rank(target) > rank(ceiling)) {
    escalations.push(
      `capped at ${ceiling} by the ${preserve && policy !== "conservative" ? "preserve-allowance hint" : `${policy} policy`}`,
    );
    target = ceiling;
  } else if (lifted && conservative && rank(target) > rank("STRONG")) {
    escalations.push(`above the ${policy} ceiling because ${describeOverride(lifted)} allows it`);
  }
  const escalated = rank(target) > rank(base);
  const escalationReason = escalated ? `Escalated: ${escalations.join("; ")}.` : undefined;
  const cappedOnly = !escalated && escalations.length > 0 ? `Note: ${escalations.join("; ")}.` : "";

  // ── Choose a model: same provider only, stepping DOWN if needed ───────────
  const avoid = input.hints?.avoid ?? new Set<string>();
  const stepNotes: string[] = [];
  for (let r = rank(target); r >= 0; r--) {
    const cls = MODEL_CLASSES[r]!;
    if (neverClasses.has(cls)) {
      stepNotes.push(`${cls} excluded by ${neverNotes.join(", ")}`);
      continue;
    }
    const pool = candidates.filter((m) => m.modelClass === cls && !neverModels.has(m.id));
    if (pool.length === 0) {
      const excluded = candidates.some((m) => m.modelClass === cls);
      stepNotes.push(
        excluded
          ? `every ${cls} model excluded by ${neverNotes.join(", ")}`
          : `no ${cls} model available for ${provider}`,
      );
      continue;
    }
    const avoidAllowed = cls === "FRONTIER" && target === "FRONTIER" && anyRisk;
    const usable = avoidAllowed ? pool : pool.filter((m) => !avoid.has(m.id));
    if (usable.length === 0) {
      stepNotes.push(`${cls} models are on the avoid list (${pool.map((m) => m.id).join(", ")})`);
      continue;
    }
    const live = usable.filter((m) => !isExhausted(m.id));
    if (live.length === 0) {
      return fail(
        `${task} Every ${cls} ${provider} model (${usable.map((m) => m.id).join(", ")}) is out of included usage. ` +
          "Not substituting a lower tier or another provider automatically.",
        EXHAUSTED_OPTIONS,
      );
    }
    // Current models before legacy ones; otherwise discovery order. Non-avoided first.
    const ordered = [...live].sort(
      (a, b) =>
        Number(avoid.has(a.id)) - Number(avoid.has(b.id)) || Number(a.legacy) - Number(b.legacy),
    );
    const pick = ordered[0]!;
    const effort = pickEffort(pick, cls);
    const steppedDown = cls !== target;
    const parts = [
      task,
      `Routed to ${cls} ${pick.id} under the ${policy} policy${effort ? ` with ${effort} effort` : ""}.`,
      ...notes,
    ];
    if (escalationReason) parts.push(escalationReason);
    if (cappedOnly) parts.push(cappedOnly);
    if (steppedDown) parts.push(`Stepped down from ${target}: ${stepNotes.join("; ")}.`);
    if (neverModels.size > 0 && pool.length < candidates.filter((m) => m.modelClass === cls).length)
      parts.push(`Excluded by ${neverNotes.join(", ")}.`);
    if (avoid.has(pick.id))
      parts.push(`${pick.id} is on the avoid list but FRONTIER is required for high-risk work.`);
    if (pick.legacy) {
      parts.push(
        ordered.some((m) => !m.legacy)
          ? `${pick.id} is a legacy model.`
          : `${pick.id} is a legacy model; no current ${cls} model was usable.`,
      );
    }
    const skippedExhausted = usable.filter((m) => isExhausted(m.id)).map((m) => m.id);
    if (skippedExhausted.length) parts.push(`Skipped exhausted: ${skippedExhausted.join(", ")}.`);

    return {
      ok: true,
      provider,
      model: pick.id,
      effort,
      modelClass: cls,
      reason: parts.join(" "),
      ...(escalated ? { escalatedFrom: base, escalationReason } : {}),
      ...(steppedDown ? { steppedDownFrom: target } : {}),
    };
  }

  return fail(
    `${task} No selectable ${provider} model at or below ${target}: ${stepNotes.join("; ")}.`,
    ["use_other_provider", "ask_user"],
  );
}

/** Exposed for tests and the UI: the class the rules ask for before availability. */
export const ROUTER_INTERNALS = { COMPLEXITY_BASE, EFFORT_PREFERENCE, REVIEW_ROLES, PLAN_ROLES };
