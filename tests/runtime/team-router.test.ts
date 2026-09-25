import { describe, expect, it } from "vitest";

import { classifyModels, type ClassifiedModel } from "../../runtime/src/team/models.ts";
import {
  pickEffort,
  selectModel,
  type RouteDecision,
  type RouteInput,
  type RouteOverride,
} from "../../runtime/src/team/router.ts";
import { MODEL_CLASSES, TEAM_ROLES, type AgentProvider } from "../../runtime/src/team/types.ts";

/**
 * The router's policy is these tests. Each rule in the brief has a case.
 */

const CODEX = classifyModels("codex", [
  {
    id: "gpt-6-sol",
    description: "Workhorse model for coding and everyday work.",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-6-astra",
    description: "Frontier intelligence for the most demanding work.",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-6-luna",
    description: "Fast and affordable model for easier tasks.",
    efforts: ["minimal", "low", "medium"],
  },
  {
    id: "gpt-5.6-sol",
    description: "Older coding model for complex work.",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-5.6-terra",
    description: "Older balanced model for straightforward work.",
    efforts: ["medium"],
  },
  { id: "gpt-5.6-luna", description: "Older fast and efficient model.", efforts: ["low"] },
  { id: "gpt-5.5", description: "Legacy coding model.", efforts: [] },
  { id: "gpt-reserve", description: "Fast reserve model.", visibility: "hide" },
  { id: "codex-auto-review", description: "Frontier review." },
]);

const CLAUDE = classifyModels("claude-code", [
  { id: "claude-haiku-4-5-20251001", efforts: [] },
  { id: "claude-sonnet-5", efforts: ["low", "medium", "high", "max"] },
  { id: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-fable-5-1", efforts: ["low", "medium", "high", "xhigh", "max"] },
]);

const NO_RISK = { security: false, database: false, architecture: false, deployment: false };

function route(over: Partial<RouteInput> = {}): RouteDecision {
  return selectModel({
    provider: "codex",
    role: "builder",
    complexity: "medium",
    risk: NO_RISK,
    contextLarge: false,
    previousFailures: 0,
    disputedFindings: 0,
    policy: "balanced",
    overrides: [],
    available: [...CODEX, ...CLAUDE],
    exhausted: new Set(),
    ...over,
  });
}

function ok(d: RouteDecision) {
  if (!d.ok) throw new Error(`expected ok, got: ${d.reason}`);
  return d;
}
function notOk(d: RouteDecision) {
  if (d.ok) throw new Error(`expected refusal, got ${d.model}: ${d.reason}`);
  return d;
}

describe("base class: role × complexity × policy", () => {
  it("trivial rename → FAST", () => {
    const d = ok(route({ complexity: "trivial", taskKind: "rename" }));
    expect(d.modelClass).toBe("FAST");
    expect(d.model).toBe("gpt-6-luna");
    expect(d.reason).toMatch(/Trivial-complexity implementation \(builder\)/);
  });

  it("ordinary implementation (builder, medium) → BALANCED under balanced", () => {
    const d = ok(route());
    expect(d.modelClass).toBe("BALANCED");
    expect(d.model).toBe("gpt-6-sol");
    expect(d.escalatedFrom).toBeUndefined();
  });

  it.each(["investigator", "builder"] as const)("complex debugging (%s, high) → STRONG", (role) => {
    const d = ok(route({ role, complexity: "high", taskKind: "debugging" }));
    expect(d.modelClass).toBe("STRONG");
  });

  it.each(["balanced", "maximum_quality"] as const)(
    "high-risk architecture/security/database work → FRONTIER under %s",
    (policy) => {
      for (const risk of ["architecture", "security", "database"] as const) {
        const planner = ok(
          route({
            role: "planner",
            complexity: "high",
            policy,
            risk: { ...NO_RISK, [risk]: true },
          }),
        );
        expect(planner.modelClass).toBe("FRONTIER");
        const inspection = ok(
          route({
            role: "reviewer",
            complexity: "high",
            policy,
            taskKind: "final_inspection",
            risk: { ...NO_RISK, [risk]: true },
          }),
        );
        expect(inspection.modelClass).toBe("FRONTIER");
        expect(inspection.model).toBe("gpt-6-astra");
        expect(inspection.reason).toContain(risk);
      }
    },
  );

  it("medium-complexity implementation touching auth stays BALANCED and says why", () => {
    const d = ok(route({ risk: { ...NO_RISK, security: true } }));
    expect(d.modelClass).toBe("BALANCED");
    expect(d.reason).toMatch(/Medium-complexity implementation \(builder\)/);
    expect(d.reason).toMatch(/Stronger model reserved for the final security review/);
  });

  it("reviewers and planners are never routed below BALANCED", () => {
    expect(ok(route({ role: "reviewer", complexity: "trivial" })).modelClass).toBe("BALANCED");
    expect(ok(route({ role: "planner", complexity: "low" })).modelClass).toBe("BALANCED");
  });

  it("large context lifts FAST to BALANCED", () => {
    const d = ok(route({ complexity: "trivial", contextLarge: true }));
    expect(d.modelClass).toBe("BALANCED");
    expect(d.reason).toMatch(/Large context/);
  });
});

describe("conservative policy", () => {
  it("never gives a builder FRONTIER, whatever the inputs", () => {
    for (const complexity of ["trivial", "low", "medium", "high"] as const) {
      for (const previousFailures of [0, 2, 5]) {
        for (const risky of [false, true]) {
          const d = ok(
            route({
              policy: "conservative",
              complexity,
              previousFailures,
              disputedFindings: 3,
              contextLarge: true,
              risk: { security: risky, database: risky, architecture: risky, deployment: risky },
            }),
          );
          expect(d.modelClass).not.toBe("FRONTIER");
        }
      }
    }
  });

  it("uses FAST/BALANCED by default", () => {
    expect(ok(route({ policy: "conservative", complexity: "high" })).modelClass).toBe("BALANCED");
    expect(ok(route({ policy: "conservative", complexity: "low" })).modelClass).toBe("FAST");
    const planner = ok(
      route({
        policy: "conservative",
        role: "planner",
        complexity: "high",
        risk: { ...NO_RISK, architecture: true },
      }),
    );
    expect(planner.modelClass).toBe("BALANCED");
    expect(planner.reason).toMatch(/Conservative policy/);
  });

  it("reserves FRONTIER for high-risk reviews", () => {
    const d = ok(
      route({
        policy: "conservative",
        role: "security_reviewer",
        risk: { ...NO_RISK, security: true },
      }),
    );
    expect(d.modelClass).toBe("FRONTIER");
    const plain = ok(route({ policy: "conservative", role: "reviewer", disputedFindings: 2 }));
    expect(plain.modelClass).toBe("STRONG");
    expect(plain.reason).toMatch(/capped at STRONG by the conservative policy/);
  });
});

describe("maximum_quality policy", () => {
  it("is one class stronger for planning and review, not for building", () => {
    expect(ok(route({ policy: "maximum_quality", role: "planner" })).modelClass).toBe("STRONG");
    expect(ok(route({ policy: "maximum_quality", role: "reviewer" })).modelClass).toBe("STRONG");
    expect(ok(route({ policy: "maximum_quality", role: "builder" })).modelClass).toBe("BALANCED");
  });

  it("is still bounded at FRONTIER", () => {
    const d = ok(
      route({
        policy: "maximum_quality",
        role: "planner",
        complexity: "high",
        previousFailures: 3,
      }),
    );
    expect(d.modelClass).toBe("FRONTIER");
  });
});

describe("manual policy", () => {
  it("fails with a clear reason when no override chooses the model", () => {
    const d = notOk(route({ policy: "manual" }));
    expect(d.options).toEqual(["ask_user"]);
    expect(d.reason).toMatch(
      /manual usage policy needs the user to choose a codex model for implementation/,
    );
  });

  it("uses the override", () => {
    const d = ok(
      route({ policy: "manual", overrides: [{ match: { role: "builder" }, use: "gpt-6-sol" }] }),
    );
    expect(d.model).toBe("gpt-6-sol");
  });
});

describe("escalation", () => {
  it("two previous failures → one class up, recorded", () => {
    const d = ok(route({ previousFailures: 2 }));
    expect(d.modelClass).toBe("STRONG");
    expect(d.escalatedFrom).toBe("BALANCED");
    expect(d.escalationReason).toMatch(/2 previous failures \(BALANCED → STRONG\)/);
    expect(d.reason).toContain(d.escalationReason!);
  });

  it("one failure does not escalate", () => {
    expect(ok(route({ previousFailures: 1 })).modelClass).toBe("BALANCED");
  });

  it("is stepwise: failures move one class, not straight to FRONTIER", () => {
    const d = ok(route({ complexity: "trivial", previousFailures: 4 }));
    expect(d.modelClass).toBe("BALANCED");
    expect(d.escalatedFrom).toBe("FAST");
  });

  it("two disputed findings on a review → FRONTIER reviewer", () => {
    const d = ok(route({ role: "reviewer", disputedFindings: 2 }));
    expect(d.modelClass).toBe("FRONTIER");
    expect(d.escalatedFrom).toBe("BALANCED");
    expect(d.reason).toMatch(/2 disputed findings on a review/);
  });

  it("high-risk authentication review after two disputed findings reads specifically", () => {
    const d = ok(
      route({
        role: "security_reviewer",
        taskKind: "authentication",
        disputedFindings: 2,
        risk: { ...NO_RISK, security: true },
      }),
    );
    expect(d.modelClass).toBe("FRONTIER");
    expect(d.reason).toMatch(/security review \(security_reviewer\)/);
    expect(d.reason).toMatch(/authentication/);
    expect(d.reason).toMatch(/disputed findings/);
  });

  it("disputed findings do not escalate a builder", () => {
    expect(ok(route({ disputedFindings: 5 })).modelClass).toBe("BALANCED");
  });

  it.each(["security", "database", "architecture", "deployment"] as const)(
    "%s risk on a reviewer → FRONTIER",
    (risk) => {
      const d = ok(route({ role: "reviewer", risk: { ...NO_RISK, [risk]: true } }));
      expect(d.modelClass).toBe("FRONTIER");
      expect(d.escalationReason).toContain(`${risk} risk on a review`);
    },
  );

  it("an override can explicitly lift the ceiling", () => {
    const d = ok(
      route({
        policy: "conservative",
        complexity: "high",
        previousFailures: 2,
        overrides: [
          { match: { role: "builder" }, allowAboveCeiling: true, label: "Let builders escalate" },
        ],
      }),
    );
    expect(d.modelClass).toBe("STRONG"); // BALANCED base + one step; the lift only removes the cap
  });
});

describe("overrides", () => {
  const always: RouteOverride = {
    match: { provider: "claude-code", taskKind: "architecture" },
    use: "claude-fable-5-1",
    label: "Always use Fable for Prism architecture",
  };
  const never: RouteOverride = {
    match: { provider: "codex", role: "test_reviewer", complexity: ["trivial", "low", "medium"] },
    never: "gpt-6-astra",
    label: "Never use Astra for simple tests",
  };

  it('"Always use X for Prism architecture"', () => {
    const d = ok(
      route({
        provider: "claude-code",
        role: "planner",
        complexity: "low",
        taskKind: "architecture",
        overrides: [always],
      }),
    );
    expect(d.model).toBe("claude-fable-5-1");
    expect(d.override).toBe("Always use Fable for Prism architecture");
    expect(d.reason).toContain("Always use Fable for Prism architecture");
  });

  it("an always-rule does not apply outside its match", () => {
    const d = ok(
      route({
        provider: "claude-code",
        role: "planner",
        complexity: "low",
        taskKind: "tests",
        overrides: [always],
      }),
    );
    expect(d.model).not.toBe("claude-fable-5-1");
  });

  it('"Never use Astra for simple tests" — even when disputes would want FRONTIER', () => {
    const d = ok(route({ role: "test_reviewer", disputedFindings: 3, overrides: [never] }));
    expect(d.model).not.toBe("gpt-6-astra");
    expect(d.modelClass).toBe("STRONG");
    expect(d.steppedDownFrom).toBe("FRONTIER");
    expect(d.reason).toContain("Never use Astra for simple tests");
  });

  it("the never-rule does not apply to hard tests", () => {
    const d = ok(
      route({ role: "test_reviewer", complexity: "high", disputedFindings: 3, overrides: [never] }),
    );
    expect(d.model).toBe("gpt-6-astra");
  });

  it("never can name a whole class", () => {
    const d = ok(
      route({
        role: "reviewer",
        disputedFindings: 2,
        overrides: [{ match: {}, never: "FRONTIER" }],
      }),
    );
    expect(d.modelClass).toBe("STRONG");
  });

  it("an override naming an unavailable model → ok:false, nothing else picked", () => {
    const d = notOk(
      route({
        overrides: [{ match: { role: "builder" }, use: "gpt-7-nova", label: "Always use Nova" }],
      }),
    );
    expect(d.options).toEqual(["ask_user"]);
    expect(d.reason).toMatch(/Always use Nova.*gpt-7-nova, which is not available for codex/);
  });

  it("an override naming a hidden model → ok:false", () => {
    notOk(route({ overrides: [{ match: {}, use: "gpt-reserve" }] }));
  });

  it("an override naming another provider's model → ok:false (no provider switch)", () => {
    const d = notOk(route({ overrides: [{ match: {}, use: "claude-opus-5-5" }] }));
    expect(d.provider).toBe("codex");
  });

  it("an exhausted override model → ok:false with the exhaustion options", () => {
    const d = notOk(
      route({ overrides: [{ match: {}, use: "gpt-6-sol" }], exhausted: new Set(["gpt-6-sol"]) }),
    );
    expect(d.options).toEqual(["wait_for_reset", "use_other_provider", "reduce_tier", "ask_user"]);
  });

  it("conflicting always-rules → ask the user", () => {
    const d = notOk(
      route({
        overrides: [
          { match: {}, use: "gpt-6-sol" },
          { match: {}, use: "gpt-6-luna" },
        ],
      }),
    );
    expect(d.reason).toMatch(/conflict/);
  });

  it("an always-rule that a never-rule forbids → ask the user", () => {
    notOk(
      route({
        overrides: [
          { match: {}, use: "gpt-6-sol" },
          { match: {}, never: "BALANCED" },
        ],
      }),
    );
  });
});

describe("provider is never switched", () => {
  const providers: AgentProvider[] = ["codex", "claude-code"];
  it("across every role, complexity and policy", () => {
    for (const provider of providers) {
      for (const role of TEAM_ROLES) {
        for (const complexity of ["trivial", "low", "medium", "high"] as const) {
          for (const policy of ["conservative", "balanced", "maximum_quality"] as const) {
            const d = route({
              provider,
              role,
              complexity,
              policy,
              previousFailures: 2,
              risk: { ...NO_RISK, security: true },
            });
            expect(d.provider).toBe(provider);
            if (d.ok) {
              const all = [...CODEX, ...CLAUDE];
              expect(all.find((m) => m.id === d.model)!.provider).toBe(provider);
            }
          }
        }
      }
    }
  });

  it("refuses when the provider has no models, rather than using the other", () => {
    const d = notOk(route({ provider: "claude-code", available: CODEX }));
    expect(d.provider).toBe("claude-code");
    expect(d.options).toContain("use_other_provider");
    expect(d.reason).toMatch(/No selectable claude-code model/);
  });
});

describe("availability", () => {
  it("steps down one class at a time within the provider and says so", () => {
    const noFrontierNoStrong = CODEX.filter((m) => !["FRONTIER", "STRONG"].includes(m.modelClass));
    const d = ok(
      route({
        role: "reviewer",
        risk: { ...NO_RISK, security: true },
        available: noFrontierNoStrong,
      }),
    );
    expect(d.modelClass).toBe("BALANCED");
    expect(d.steppedDownFrom).toBe("FRONTIER");
    expect(d.reason).toMatch(
      /Stepped down from FRONTIER: no FRONTIER model available for codex; no STRONG model available for codex/,
    );
  });

  it("never steps up", () => {
    const onlyStrong = CODEX.filter((m) => m.modelClass === "STRONG");
    const d = notOk(route({ complexity: "trivial", available: onlyStrong }));
    expect(d.reason).toMatch(/at or below FAST/);
  });

  it("hidden models are never picked even when they are the only match", () => {
    const hiddenOnly: ClassifiedModel[] = CODEX.filter((m) => m.hidden);
    expect(hiddenOnly.length).toBe(2);
    notOk(route({ complexity: "trivial", available: hiddenOnly }));
  });

  it("prefers current models over legacy ones in a class", () => {
    expect(ok(route({ complexity: "low" })).model).toBe("gpt-6-luna");
    expect(ok(route({ complexity: "high" })).model).toBe("gpt-5.6-sol"); // only STRONG is legacy
    const legacyFirst = [...CODEX].reverse();
    expect(ok(route({ available: legacyFirst })).model).toBe("gpt-6-sol");
  });

  it("uses a legacy model only when no current model in the class is usable, and says so", () => {
    const d = ok(route({ exhausted: new Set(["gpt-6-sol"]) }));
    expect(d.model).toBe("gpt-5.6-terra");
    expect(d.reason).toMatch(/Skipped exhausted: gpt-6-sol/);
    expect(d.reason).toMatch(/legacy model/);
  });
});

describe("exhaustion", () => {
  const OPTIONS = ["wait_for_reset", "use_other_provider", "reduce_tier", "ask_user"];

  it("an exhausted provider → ok:false with every option", () => {
    const d = notOk(route({ exhausted: new Set(["codex"]) }));
    expect(d.options).toEqual(OPTIONS);
    expect(d.provider).toBe("codex");
  });

  it("an exhausted class is not silently replaced by a lower one", () => {
    const d = notOk(
      route({ role: "reviewer", disputedFindings: 2, exhausted: new Set(["gpt-6-astra"]) }),
    );
    expect(d.options).toEqual(OPTIONS);
    expect(d.reason).toMatch(/Every FRONTIER codex model \(gpt-6-astra\) is out of included usage/);
  });

  it("the other provider's exhaustion does not matter", () => {
    ok(route({ exhausted: new Set(["claude-code", "claude-sonnet-5"]) }));
  });
});

describe("preference hints", () => {
  it("an avoided model is not used for ordinary FRONTIER-class work", () => {
    const d = ok(
      route({ role: "reviewer", disputedFindings: 2, hints: { avoid: new Set(["gpt-6-astra"]) } }),
    );
    expect(d.model).not.toBe("gpt-6-astra");
    expect(d.reason).toMatch(/avoid list/);
  });

  it("an avoided model is used when FRONTIER is required for high-risk work, with a reason", () => {
    const d = ok(
      route({
        role: "reviewer",
        risk: { ...NO_RISK, database: true },
        hints: { avoid: new Set(["gpt-6-astra"]) },
      }),
    );
    expect(d.model).toBe("gpt-6-astra");
    expect(d.reason).toMatch(
      /gpt-6-astra is on the avoid list but FRONTIER is required for high-risk work/,
    );
  });

  it("preserve holds base routing at BALANCED like conservative", () => {
    const d = ok(route({ provider: "claude-code", complexity: "high", hints: { preserve: true } }));
    expect(d.modelClass).toBe("BALANCED");
    expect(d.reason).toMatch(/Preserving the claude-code allowance/);
  });
});

describe("effort", () => {
  it("per class, only from supported efforts", () => {
    expect(ok(route({ complexity: "trivial" })).effort).toBe("low");
    expect(ok(route()).effort).toBe("medium");
    expect(ok(route({ complexity: "high" })).effort).toBe("high");
    expect(ok(route({ role: "reviewer", disputedFindings: 2 })).effort).toBe("xhigh");
  });

  it("falls back to a supported effort, never an unsupported one", () => {
    const model = { efforts: ["medium"], defaultEffort: null };
    for (const c of MODEL_CLASSES) expect(pickEffort(model, c)).toBe("medium");
    expect(pickEffort({ efforts: ["turbo"], defaultEffort: "turbo" }, "FAST")).toBe("turbo");
  });

  it("is null when the model reports no efforts", () => {
    expect(ok(route({ provider: "claude-code", complexity: "trivial" })).effort).toBeNull();
    expect(pickEffort({ efforts: [], defaultEffort: "high" }, "STRONG")).toBeNull();
  });

  it("does not pick max for FRONTIER automatically", () => {
    const d = ok(
      route({ provider: "claude-code", role: "reviewer", risk: { ...NO_RISK, security: true } }),
    );
    expect(d.model).toBe("claude-fable-5-1");
    expect(d.effort).toBe("xhigh");
  });
});

describe("every decision has a specific reason", () => {
  it("mentions the role and the complexity driver, for every combination", () => {
    for (const role of TEAM_ROLES) {
      for (const complexity of ["trivial", "low", "medium", "high"] as const) {
        for (const policy of ["conservative", "balanced", "maximum_quality", "manual"] as const) {
          const d = route({ role, complexity, policy });
          expect(d.reason.length).toBeGreaterThan(40);
          expect(d.reason).toContain(`(${role})`);
          expect(d.reason.toLowerCase()).toContain(`${complexity}-complexity`);
          if (d.ok) expect(d.reason).toContain(d.model);
        }
      }
    }
  });
});
