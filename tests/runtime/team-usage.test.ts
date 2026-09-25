import { describe, expect, it } from "vitest";

import { classifyModels } from "../../runtime/src/team/models.ts";
import { selectModel } from "../../runtime/src/team/router.ts";
import { EXHAUSTION_OPTIONS, UsageGovernor } from "../../runtime/src/team/usage.ts";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const HOUR = 3_600_000;

describe("paid usage", () => {
  it("is off by default", () => {
    expect(new UsageGovernor().paidUsage).toBe(false);
  });

  it("cannot be enabled without an explicit user confirmation", () => {
    const g = new UsageGovernor();
    expect(() => g.setPaidUsage(true)).toThrow(/explicit user confirmation/);
    expect(() => g.setPaidUsage(true, {} as never)).toThrow();
    expect(() => g.setPaidUsage(true, { confirmedByUser: "yes" } as never)).toThrow();
    expect(() => g.setPaidUsage(true, { confirmedByUser: 1 } as never)).toThrow();
    expect(() => g.setPaidUsage(true, null as never)).toThrow();
    expect(() => g.setPaidUsage("true" as never, { confirmedByUser: true })).toThrow();
    expect(g.paidUsage).toBe(false);
  });

  it("is enabled only by setPaidUsage(true, { confirmedByUser: true }) and can always be turned off", () => {
    const g = new UsageGovernor();
    g.setPaidUsage(true, { confirmedByUser: true });
    expect(g.paidUsage).toBe(true);
    g.setPaidUsage(false);
    expect(g.paidUsage).toBe(false);
  });

  it("has no other way in", () => {
    const g = new UsageGovernor();
    expect(() => {
      (g as unknown as { paidUsage: boolean }).paidUsage = true;
    }).toThrow();
    expect(g.paidUsage).toBe(false);
  });
});

describe("exhaustion and reset", () => {
  it("marks a model exhausted until its reset time", () => {
    const g = new UsageGovernor();
    g.markExhausted("codex", "gpt-6-astra", T0 + HOUR);
    expect(g.isAvailable("codex", "gpt-6-astra", T0)).toBe(false);
    expect(g.isAvailable("codex", "gpt-6-sol", T0)).toBe(true);
    expect(g.isAvailable("claude-code", "gpt-6-astra", T0)).toBe(true);
    expect([...g.exhausted(T0)]).toEqual(["gpt-6-astra"]);
    expect(g.isAvailable("codex", "gpt-6-astra", T0 + HOUR)).toBe(true);
    expect(g.exhausted(T0 + HOUR).size).toBe(0);
  });

  it("a whole-provider mark covers every model of that provider only", () => {
    const g = new UsageGovernor();
    g.markExhausted("claude-code");
    expect(g.isAvailable("claude-code", "claude-sonnet-5", T0)).toBe(false);
    expect(g.isAvailable("claude-code", null, T0)).toBe(false);
    expect(g.isAvailable("codex", "gpt-6-sol", T0)).toBe(true);
    expect(g.exhausted(T0)).toEqual(new Set(["claude-code"]));
  });

  it("a mark with no reset time stays until cleared", () => {
    const g = new UsageGovernor();
    g.markExhausted("codex");
    expect(g.resetIfDue(T0 + 1000 * HOUR)).toEqual([]);
    expect(g.isAvailable("codex", null, T0 + 1000 * HOUR)).toBe(false);
    g.clearExhausted("codex");
    expect(g.isAvailable("codex", null, T0)).toBe(true);
  });

  it("resetIfDue clears only what is due", () => {
    const g = new UsageGovernor();
    g.markExhausted("codex", "gpt-6-astra", T0 + HOUR);
    g.markExhausted("claude-code", null, T0 + 2 * HOUR);
    expect(g.resetIfDue(T0)).toEqual([]);
    expect(g.resetIfDue(T0 + HOUR)).toEqual([{ provider: "codex", model: "gpt-6-astra" }]);
    expect(g.exhausted(T0 + HOUR)).toEqual(new Set(["claude-code"]));
    expect(g.resetIfDue(T0 + 3 * HOUR)).toEqual([{ provider: "claude-code", model: null }]);
  });

  it("rejects a non-finite reset time", () => {
    expect(() => new UsageGovernor().markExhausted("codex", null, Number.NaN)).toThrow();
  });

  it("feeds the router, which refuses instead of substituting", () => {
    const g = new UsageGovernor();
    g.markExhausted("codex", "gpt-6-sol", T0 + HOUR);
    g.markExhausted("codex", "gpt-5.6-terra", T0 + HOUR);
    const available = classifyModels("codex", [
      { id: "gpt-6-sol", description: "Workhorse model for coding and everyday work." },
      { id: "gpt-5.6-terra", description: "Older balanced model for straightforward work." },
      { id: "gpt-6-luna", description: "Fast and affordable model for easier tasks." },
    ]);
    const d = selectModel({
      provider: "codex",
      role: "builder",
      complexity: "medium",
      risk: { security: false, database: false, architecture: false, deployment: false },
      contextLarge: false,
      previousFailures: 0,
      disputedFindings: 0,
      policy: "balanced",
      overrides: [],
      available,
      exhausted: g.exhausted(T0),
      hints: g.hints("codex"),
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.options).toEqual([...EXHAUSTION_OPTIONS]);
  });
});

describe("decide()", () => {
  it("on quota exhaustion, marks and returns options — never another provider", () => {
    const g = new UsageGovernor();
    const d = g.decide({
      failure: "quota_exhausted",
      provider: "claude-code",
      model: "claude-opus-5-5",
      resetAt: T0 + HOUR,
    });
    expect(d.kind).toBe("quota_exhausted");
    if (d.kind !== "quota_exhausted") return;
    expect(d.provider).toBe("claude-code");
    expect(d.options).toEqual(["wait_for_reset", "use_other_provider", "reduce_tier", "ask_user"]);
    expect(d.chosen).toBeNull();
    expect(d.needsUserDecision).toBe(true);
    expect(d.reason).toMatch(/No other provider is used automatically/);
    expect(JSON.stringify(d)).not.toContain("codex");
    expect(g.isAvailable("claude-code", "claude-opus-5-5", T0)).toBe(false);
  });

  it("honours an option the room policy already chose, still without naming a provider", () => {
    const g = new UsageGovernor();
    const d = g.decide({ failure: "quota_exhausted", provider: "codex" }, "use_other_provider");
    if (d.kind !== "quota_exhausted") throw new Error("expected quota decision");
    expect(d.chosen).toBe("use_other_provider");
    expect(d.needsUserDecision).toBe(false);
    expect(d.provider).toBe("codex");
    expect(JSON.stringify(d)).not.toContain("claude");
  });

  it("ignores an unknown pre-chosen option", () => {
    const d = new UsageGovernor().decide(
      { failure: "quota_exhausted", provider: "codex" },
      "switch_to_claude" as never,
    );
    if (d.kind !== "quota_exhausted") throw new Error("expected quota decision");
    expect(d.chosen).toBeNull();
    expect(d.needsUserDecision).toBe(true);
  });

  it.each(["model_mismatch", "access_mismatch", "timeout", "provider_error", "not_authenticated"])(
    "%s is not a usage failure and marks nothing",
    (failure) => {
      const g = new UsageGovernor();
      const d = g.decide({ failure, provider: "codex", model: "gpt-6-sol" });
      expect(d.kind).toBe("not_a_usage_failure");
      expect(d.provider).toBe("codex");
      expect(g.exhausted(T0).size).toBe(0);
    },
  );
});

describe("preference hints", () => {
  it("preserve / prefer / avoid are exposed per provider", () => {
    const g = new UsageGovernor();
    g.preserve("claude-code");
    g.prefer("codex");
    g.avoid("gpt-6-astra");
    expect(g.hints("claude-code")).toEqual({
      preserve: true,
      preferred: false,
      avoid: new Set(["gpt-6-astra"]),
    });
    expect(g.hints("codex")).toEqual({
      preserve: false,
      preferred: true,
      avoid: new Set(["gpt-6-astra"]),
    });
    expect(g.preferredProviders()).toEqual(["codex"]);
    g.preserve("claude-code", false);
    g.avoid("gpt-6-astra", false);
    expect(g.hints("claude-code")).toEqual({ preserve: false, preferred: false, avoid: new Set() });
  });

  it("hands out a copy of the avoid list", () => {
    const g = new UsageGovernor();
    g.avoid("gpt-6-astra");
    (g.hints("codex").avoid as Set<string>).clear();
    expect(g.hints("codex").avoid.has("gpt-6-astra")).toBe(true);
  });
});

describe("remaining usage", () => {
  it("is unknown by default and never invented", () => {
    const g = new UsageGovernor();
    expect(g.remaining("codex")).toBe("unknown");
    expect(g.remaining("claude-code", "claude-opus-5-5")).toBe("unknown");
    g.markExhausted("codex", "gpt-6-sol", T0 + HOUR);
    g.decide({ failure: "quota_exhausted", provider: "claude-code" });
    expect(g.remaining("codex", "gpt-6-sol")).toBe("unknown");
    expect(g.remaining("claude-code")).toBe("unknown");
  });

  it("stores a number only with an official source", () => {
    const g = new UsageGovernor();
    expect(() => g.setRemaining("codex", 40, "percent", "", T0)).toThrow(/official source/);
    expect(() => g.setRemaining("codex", 140, "percent", "codex /status", T0)).toThrow();
    expect(() => g.setRemaining("codex", -1, "requests", "codex /status", T0)).toThrow();
    expect(() => g.setRemaining("codex", Number.NaN, "tokens", "codex /status", T0)).toThrow();
    g.setRemaining("codex", 40, "percent", "codex /status", T0);
    expect(g.remaining("codex")).toEqual({
      value: 40,
      unit: "percent",
      source: "codex /status",
      observedAt: T0,
    });
    expect(g.remaining("claude-code")).toBe("unknown");
  });
});
