/**
 * Model classification: which routing class a discovered model sits in.
 *
 * This is a ROUTING POLICY, not a quality ranking. The class says "use this
 * model for this kind of work by default", nothing more. No model is ever
 * declared permanently "the strongest": the table below is a default derived
 * from the provider's own catalogue wording (Codex) or model family (Claude),
 * and the user can override any model's class. A user override always wins.
 *
 * Pure: no filesystem, no network, no clock.
 */

import type { AgentProvider, ModelClass } from "./types.ts";

/** What discovery knows about a model. Only `id` is required. */
export type ModelInfo = {
  id: string;
  displayName?: string | null;
  description?: string | null;
  /** Reasoning/effort levels the model reports supporting. Empty = unknown. */
  efforts?: readonly string[];
  defaultEffort?: string | null;
  /** Codex catalogue visibility. `hide` models are never selectable. */
  visibility?: "list" | "hide" | null;
};

export type ModelClassification = {
  modelClass: ModelClass;
  /** Older/legacy model: kept usable, but the router prefers current models. */
  legacy: boolean;
  /** Never selectable by the router (catalogue-hidden or internal). */
  hidden: boolean;
  /** True when the class came from the user's per-model override. */
  overridden: boolean;
  /** Human-readable explanation of how the class was chosen. */
  reason: string;
};

/** A model ready for the router: its facts plus its classification. */
export type ClassifiedModel = {
  id: string;
  displayName: string;
  description: string | null;
  provider: AgentProvider;
  modelClass: ModelClass;
  legacy: boolean;
  hidden: boolean;
  overridden: boolean;
  efforts: string[];
  defaultEffort: string | null;
  reason: string;
};

/** Per-model user overrides. Always win over the default table. */
export type ModelClassOverrides = ReadonlyMap<string, ModelClass>;

/**
 * Internal or hidden Codex models. They are never offered to the router even
 * if a catalogue lists them as visible.
 */
export const HIDDEN_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-reserve", "codex-auto-review"]);

type KeywordRule = { modelClass: ModelClass; keywords: readonly string[] };

/**
 * Default Codex policy, keyed on the catalogue description. Checked in order;
 * the first rule with a matching keyword decides. Order matters only for
 * descriptions that contain words from several rules.
 */
const CODEX_DESCRIPTION_RULES: readonly KeywordRule[] = [
  { modelClass: "FRONTIER", keywords: ["frontier", "most demanding"] },
  { modelClass: "STRONG", keywords: ["complex work"] },
  { modelClass: "BALANCED", keywords: ["workhorse", "everyday", "balanced", "straightforward"] },
  { modelClass: "FAST", keywords: ["fast", "affordable", "efficient"] },
];

const LEGACY_KEYWORDS = ["legacy", "older"] as const;

/** Default Claude policy, keyed on the family word in the model id. */
const CLAUDE_FAMILY_RULES: readonly { family: string; modelClass: ModelClass }[] = [
  { family: "haiku", modelClass: "FAST" },
  { family: "sonnet", modelClass: "BALANCED" },
  { family: "opus", modelClass: "STRONG" },
  { family: "fable", modelClass: "FRONTIER" },
];

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

function isHidden(model: ModelInfo): boolean {
  return model.visibility === "hide" || HIDDEN_MODEL_IDS.has(model.id);
}

function classifyCodex(model: ModelInfo): {
  modelClass: ModelClass;
  legacy: boolean;
  reason: string;
} {
  const description = model.description?.trim() ?? "";
  const legacyWord = LEGACY_KEYWORDS.find((word) => containsWord(description, word));
  const legacy = legacyWord !== undefined;
  const legacyNote = legacy
    ? ` Marked legacy ("${legacyWord}"); current models are preferred.`
    : "";

  if (!description) {
    return {
      modelClass: "BALANCED",
      legacy,
      reason: `Codex model ${model.id} has no catalogue description; defaulted to BALANCED.`,
    };
  }
  for (const rule of CODEX_DESCRIPTION_RULES) {
    const hit = rule.keywords.find((keyword) => containsWord(description, keyword));
    if (hit) {
      return {
        modelClass: rule.modelClass,
        legacy,
        reason: `Codex catalogue describes ${model.id} as "${hit}"; default policy class ${rule.modelClass}.${legacyNote}`,
      };
    }
  }
  return {
    modelClass: "BALANCED",
    legacy,
    reason: `Codex catalogue description of ${model.id} has no class keyword; defaulted to BALANCED.${legacyNote}`,
  };
}

function classifyClaude(model: ModelInfo): {
  modelClass: ModelClass;
  legacy: boolean;
  reason: string;
} {
  const id = model.id.toLowerCase();
  for (const rule of CLAUDE_FAMILY_RULES) {
    if (id.includes(rule.family)) {
      return {
        modelClass: rule.modelClass,
        legacy: false,
        reason: `Claude ${rule.family} family (${model.id}); default policy class ${rule.modelClass}.`,
      };
    }
  }
  return {
    modelClass: "BALANCED",
    legacy: false,
    reason: `Claude model family of ${model.id} was unrecognised; defaulted to BALANCED.`,
  };
}

/**
 * Classify one model. A user override for the model id always wins; the
 * legacy and hidden flags are facts about the model and are kept either way.
 */
export function classifyModel(
  provider: AgentProvider | string,
  model: ModelInfo,
  overrides?: ModelClassOverrides,
): ModelClassification {
  const hidden = isHidden(model);
  let base: { modelClass: ModelClass; legacy: boolean; reason: string };
  if (provider === "codex") base = classifyCodex(model);
  else if (provider === "claude-code") base = classifyClaude(model);
  else {
    base = {
      modelClass: "BALANCED",
      legacy: false,
      reason: `Provider "${provider}" has no classification policy and ${model.id} gives no signal; defaulted to BALANCED.`,
    };
  }

  const override = overrides?.get(model.id);
  if (override) {
    return {
      modelClass: override,
      legacy: base.legacy,
      hidden,
      overridden: true,
      reason: `User override: ${model.id} is routed as ${override} (default would be ${base.modelClass}).`,
    };
  }
  return { ...base, hidden, overridden: false };
}

/** Classify a discovered list for the router. Hidden models are kept but flagged. */
export function classifyModels(
  provider: AgentProvider,
  models: readonly ModelInfo[],
  overrides?: ModelClassOverrides,
): ClassifiedModel[] {
  return models.map((model) => {
    const c = classifyModel(provider, model, overrides);
    return {
      id: model.id,
      displayName: model.displayName?.trim() || model.id,
      description: model.description ?? null,
      provider,
      modelClass: c.modelClass,
      legacy: c.legacy,
      hidden: c.hidden,
      overridden: c.overridden,
      efforts: [...(model.efforts ?? [])],
      defaultEffort: model.defaultEffort ?? null,
      reason: c.reason,
    };
  });
}

/** Whether the router may ever pick this model. */
export function isSelectable(model: { id: string; hidden?: boolean }): boolean {
  return !model.hidden && !HIDDEN_MODEL_IDS.has(model.id);
}
