import { describe, expect, it } from "vitest";

import {
  classifyModel,
  classifyModels,
  HIDDEN_MODEL_IDS,
  isSelectable,
  type ModelInfo,
} from "../../runtime/src/team/models.ts";
import type { ModelClass } from "../../runtime/src/team/types.ts";

/**
 * Model classes are a routing policy, not a quality ranking. These tests pin
 * the default table against the real catalogue wording.
 */

const CODEX_CATALOG: (ModelInfo & { expected: ModelClass; legacy: boolean })[] = [
  {
    id: "gpt-6-sol",
    description: "Workhorse model for coding and everyday work.",
    expected: "BALANCED",
    legacy: false,
  },
  {
    id: "gpt-6-astra",
    description: "Frontier intelligence for the most demanding work.",
    expected: "FRONTIER",
    legacy: false,
  },
  {
    id: "gpt-6-luna",
    description: "Fast and affordable model for easier tasks.",
    expected: "FAST",
    legacy: false,
  },
  {
    id: "gpt-5.6-sol",
    description: "Older coding model for complex work.",
    expected: "STRONG",
    legacy: true,
  },
  {
    id: "gpt-5.6-terra",
    description: "Older balanced model for straightforward work.",
    expected: "BALANCED",
    legacy: true,
  },
  {
    id: "gpt-5.6-luna",
    description: "Older fast and efficient model.",
    expected: "FAST",
    legacy: true,
  },
  { id: "gpt-5.5", description: "Legacy coding model.", expected: "BALANCED", legacy: true },
];

describe("Codex catalogue classification", () => {
  it.each(CODEX_CATALOG)("$id → $expected (legacy: $legacy)", (model) => {
    const c = classifyModel("codex", model);
    expect(c.modelClass).toBe(model.expected);
    expect(c.legacy).toBe(model.legacy);
    expect(c.hidden).toBe(false);
    expect(c.overridden).toBe(false);
    expect(c.reason).toContain(model.id);
  });

  it("quotes the catalogue keyword that decided", () => {
    expect(classifyModel("codex", CODEX_CATALOG[1]!).reason).toMatch(/frontier/i);
    expect(classifyModel("codex", CODEX_CATALOG[2]!).reason).toMatch(/"fast"/i);
  });

  it("says why a legacy model is marked", () => {
    expect(classifyModel("codex", CODEX_CATALOG[3]!).reason).toMatch(/legacy/i);
  });

  it("defaults a Codex model with no description to BALANCED with a reason", () => {
    const c = classifyModel("codex", { id: "gpt-mystery" });
    expect(c.modelClass).toBe("BALANCED");
    expect(c.reason).toMatch(/no catalogue description/);
  });
});

describe("hidden models", () => {
  it.each(["gpt-reserve", "codex-auto-review"])("%s is never selectable", (id) => {
    expect(HIDDEN_MODEL_IDS.has(id)).toBe(true);
    const c = classifyModel("codex", { id, description: "Fast model.", visibility: "list" });
    expect(c.hidden).toBe(true);
    expect(isSelectable({ id })).toBe(false);
    expect(isSelectable({ id, hidden: false })).toBe(false);
  });

  it("catalogue visibility 'hide' makes any model unselectable", () => {
    const [m] = classifyModels("codex", [
      { id: "gpt-x", description: "Fast.", visibility: "hide" },
    ]);
    expect(m!.hidden).toBe(true);
    expect(isSelectable(m!)).toBe(false);
  });

  it("listed models are selectable", () => {
    const [m] = classifyModels("codex", [CODEX_CATALOG[0]!]);
    expect(isSelectable(m!)).toBe(true);
  });
});

describe("Claude family classification", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "FAST"],
    ["claude-sonnet-5", "BALANCED"],
    ["claude-opus-5-5", "STRONG"],
    ["claude-fable-5-1", "FRONTIER"],
  ] as const)("%s → %s", (id, expected) => {
    const c = classifyModel("claude-code", { id });
    expect(c.modelClass).toBe(expected);
    expect(c.legacy).toBe(false);
    expect(c.reason).toContain(id);
  });

  it("an unrecognised Claude family is BALANCED and says it was unrecognised", () => {
    const c = classifyModel("claude-code", { id: "claude-sonata-9" });
    expect(c.modelClass).toBe("BALANCED");
    expect(c.reason).toMatch(/unrecognised/);
  });
});

describe("unknown provider", () => {
  it("is BALANCED with an explaining reason", () => {
    const c = classifyModel("nova", { id: "nova-1" });
    expect(c.modelClass).toBe("BALANCED");
    expect(c.reason).toMatch(/no classification policy/);
  });
});

describe("user overrides", () => {
  it("always win over the default table", () => {
    const overrides = new Map<string, ModelClass>([
      ["gpt-6-luna", "STRONG"],
      ["claude-fable-5-1", "BALANCED"],
    ]);
    const luna = classifyModel("codex", CODEX_CATALOG[2]!, overrides);
    expect(luna.modelClass).toBe("STRONG");
    expect(luna.overridden).toBe(true);
    expect(luna.reason).toMatch(/User override.*default would be FAST/);
    const fable = classifyModel("claude-code", { id: "claude-fable-5-1" }, overrides);
    expect(fable.modelClass).toBe("BALANCED");
  });

  it("keep the legacy flag (a fact, not a class)", () => {
    const c = classifyModel("codex", CODEX_CATALOG[6]!, new Map([["gpt-5.5", "FAST"]]));
    expect(c.modelClass).toBe("FAST");
    expect(c.legacy).toBe(true);
  });

  it("cannot make a hidden model selectable", () => {
    const c = classifyModel("codex", { id: "gpt-reserve" }, new Map([["gpt-reserve", "FAST"]]));
    expect(c.hidden).toBe(true);
  });
});

describe("classifyModels", () => {
  it("carries facts through for the router", () => {
    const [m] = classifyModels("codex", [
      {
        id: "gpt-6-sol",
        displayName: "GPT-6 Sol",
        description: CODEX_CATALOG[0]!.description,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
    ]);
    expect(m).toMatchObject({
      id: "gpt-6-sol",
      displayName: "GPT-6 Sol",
      provider: "codex",
      modelClass: "BALANCED",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("falls back to the id as display name", () => {
    expect(classifyModels("claude-code", [{ id: "claude-sonnet-5" }])[0]!.displayName).toBe(
      "claude-sonnet-5",
    );
  });
});
