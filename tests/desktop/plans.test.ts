import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CHATGPT_PLANS, CLAUDE_PLANS } from "../../runtime/src/team/types.ts";
import {
  CHATGPT_PLAN_OPTIONS,
  CLAUDE_PLAN_OPTIONS,
  CODEX_NOT_REPORTED,
  loadPlans,
  normalizeProfiles,
  parsePlanRequest,
  planBackend,
  planView,
  planViews,
  savePlan,
  type PlanBackend,
  type PlanProfile,
} from "../../desktop/src/plans.ts";

/**
 * Providers & plans in the desktop app, below the renderer: the view model,
 * the allow-list that guards the IPC channel, and the adapter to the Runtime.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

const profile = (over: Partial<PlanProfile> = {}): PlanProfile => ({
  provider: "claude-code",
  declaredPlan: "pro",
  usagePolicy: "balanced",
  paidUsageEnabled: false,
  detectedPlan: null,
  ...over,
});

describe("the plan lists", () => {
  it("mirror the Runtime's canonical lists exactly, in order", () => {
    expect(CLAUDE_PLAN_OPTIONS.map(([v]) => v)).toEqual([...CLAUDE_PLANS]);
    expect(CHATGPT_PLAN_OPTIONS.map(([v]) => v)).toEqual([...CHATGPT_PLANS]);
  });

  it("use the agreed labels", () => {
    expect(CLAUDE_PLAN_OPTIONS.map(([, l]) => l)).toEqual([
      "Free",
      "Pro",
      "Max 5×",
      "Max 20×",
      "Team",
      "Enterprise",
      "Not set",
    ]);
    expect(CHATGPT_PLAN_OPTIONS.map(([, l]) => l)).toEqual([
      "Free",
      "Go",
      "Plus",
      "Pro",
      "Business Standard",
      "Business Premium",
      "Enterprise",
      "Edu",
      "Not set",
    ]);
  });

  it("have no generic Business", () => {
    for (const [value, label] of [...CLAUDE_PLAN_OPTIONS, ...CHATGPT_PLAN_OPTIONS]) {
      expect(value).not.toBe("business");
      expect(label).not.toBe("Business");
    }
  });
});

describe("the plan view model", () => {
  it("labels a declared plan", () => {
    expect(planView("claude-code", profile({ declaredPlan: "max_5x" })).yourPlan).toBe("Max 5×");
    expect(
      planView("codex", profile({ provider: "codex", declaredPlan: "business_standard" })).yourPlan,
    ).toBe("Business Standard");
  });

  it("says a plan that is not set is not set", () => {
    const view = planView("claude-code", profile({ declaredPlan: "unknown" }));
    expect(view.yourPlan).toBe("Not set — choose your plan");
    expect(view.notSet).toBe(true);
    expect(view.declared).toBe("unknown");
  });

  it("treats no profile at all as not set, not as a guess", () => {
    const view = planView("codex", null);
    expect(view.yourPlan).toBe("Not set — choose your plan");
    expect(view.usagePolicy).toBe("Not available");
    expect(view.paidUsage).toBe("Not available");
  });

  it("asks for a Business tier when an old ChatGPT Team/Business value is held", () => {
    for (const legacy of ["team", "business"]) {
      const view = planView("codex", profile({ provider: "codex", declaredPlan: legacy }));
      expect(view.declared).toBe("unknown");
      expect(view.yourPlan).toContain("Business Standard or Business Premium");
    }
  });

  it("says Codex does not report a plan, rather than Unknown", () => {
    const view = planView("codex", profile({ provider: "codex" }), { detectedPlan: null });
    expect(view.reported).toBe(CODEX_NOT_REPORTED);
    expect(view.reported).toBe(
      "Codex doesn't report your plan — ThreadLink uses the plan you chose.",
    );
    expect(view.reported).not.toMatch(/unknown|not reported/i);
  });

  it("never shows a Codex-reported plan even if one arrives", () => {
    const view = planView("codex", profile({ provider: "codex", detectedPlan: "plus" }));
    expect(view.reported).toBe(CODEX_NOT_REPORTED);
  });

  it("shows what Claude Code reported, without guessing which Max", () => {
    expect(planView("claude-code", profile(), { detectedPlan: "max" }).reported).toBe("Max");
    expect(planView("claude-code", profile(), { detectedPlan: "pro" }).reported).toBe("Pro");
    expect(planView("claude-code", profile(), { detectedPlan: "max_20x" }).reported).toBe(
      "Max 20×",
    );
  });

  it("prefers this computer's detection, then the server's copy", () => {
    const p = profile({ detectedPlan: "pro" });
    expect(planView("claude-code", p, { detectedPlan: "max" }).reported).toBe("Max");
    expect(planView("claude-code", p, null).reported).toBe("Pro");
  });

  it("says Claude Code has not reported yet, or needs signing in", () => {
    expect(planView("claude-code", profile(), { detectedPlan: null }).reported).toBe(
      "Claude Code hasn't reported a plan yet.",
    );
    expect(
      planView("claude-code", profile(), { detectedPlan: null, authenticated: false }).reported,
    ).toContain("Sign in to Claude Code");
  });

  it("shows usage policy and paid usage in words", () => {
    const view = planView(
      "claude-code",
      profile({ usagePolicy: "maximum_quality", paidUsageEnabled: true }),
    );
    expect(view.usagePolicy).toBe("Maximum quality");
    expect(view.paidUsage).toBe("On");
  });

  it("returns both providers in a stable order", () => {
    expect(planViews([]).map((v) => v.provider)).toEqual(["claude-code", "codex"]);
  });
});

describe("what the plans:set channel accepts", () => {
  it("accepts a known provider with a plan from its own list", () => {
    expect(parsePlanRequest("claude-code", "max_20x")).toEqual({
      provider: "claude-code",
      plan: "max_20x",
    });
    expect(parsePlanRequest("codex", "business_premium")).toEqual({
      provider: "codex",
      plan: "business_premium",
    });
    expect(parsePlanRequest("codex", "unknown")).toEqual({ provider: "codex", plan: "unknown" });
  });

  it("rejects an unknown provider", () => {
    for (const provider of ["claude", "Claude-Code", "cursor", "", null, undefined, 1, {}]) {
      expect(parsePlanRequest(provider, "pro")).toBeNull();
    }
  });

  it("rejects an unknown plan, and a plan from the other provider's list", () => {
    for (const plan of ["platinum", "PRO", " pro", "", null, 3, ["pro"], { plan: "pro" }]) {
      expect(parsePlanRequest("claude-code", plan)).toBeNull();
    }
    expect(parsePlanRequest("claude-code", "plus")).toBeNull();
    expect(parsePlanRequest("claude-code", "business_standard")).toBeNull();
    expect(parsePlanRequest("codex", "max_5x")).toBeNull();
  });

  it("rejects a generic Business, and ChatGPT's retired Team", () => {
    expect(parsePlanRequest("codex", "business")).toBeNull();
    expect(parsePlanRequest("claude-code", "business")).toBeNull();
    expect(parsePlanRequest("codex", "team")).toBeNull();
  });
});

describe("saving a plan", () => {
  const backend = (over: Partial<PlanBackend> = {}) => {
    let held: PlanProfile[] = [
      profile(),
      profile({ provider: "codex", declaredPlan: "unknown", usagePolicy: "balanced" }),
    ];
    const b = {
      getProfiles: vi.fn(async () => ({ profiles: held })),
      setDeclaredPlan: vi.fn(async (provider: string, plan: string) => {
        held = held.map((p) => (p.provider === provider ? { ...p, declaredPlan: plan } : p));
      }),
      ...over,
    };
    return b;
  };

  it("never calls the Runtime for an invalid request", async () => {
    const b = backend();
    const reload = vi.fn();
    for (const [provider, plan] of [
      ["cursor", "pro"],
      ["codex", "business"],
      ["claude-code", "plus"],
      ["codex", { toString: () => "plus" }],
    ] as const) {
      expect(await savePlan(b, provider, plan, reload)).toEqual({ ok: false, error: "invalid" });
    }
    expect(b.setDeclaredPlan).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("fails closed when the Runtime offers no way to set a plan", async () => {
    expect(await savePlan(null, "codex", "plus", vi.fn())).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("sets, then re-reads, and returns what the server holds", async () => {
    const b = backend();
    const cache = { profiles: null as PlanProfile[] | null };
    const result = await savePlan(b, "codex", "plus", () => loadPlans(b, [], cache));
    expect(b.setDeclaredPlan).toHaveBeenCalledWith("codex", "plus");
    expect(b.getProfiles).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.providers?.find((p) => p.provider === "codex")?.yourPlan).toBe("Plus");
  });

  it("reports a Runtime failure as a failure", async () => {
    const b = backend({
      setDeclaredPlan: vi.fn(async () => {
        throw new Error("HTTP 403");
      }),
    });
    expect(await savePlan(b, "codex", "plus", vi.fn())).toEqual({ ok: false, error: "failed" });
  });

  it("is not a success when the server did not keep the plan", async () => {
    const b = backend({ setDeclaredPlan: vi.fn(async () => undefined) });
    const cache = { profiles: null as PlanProfile[] | null };
    const result = await savePlan(b, "codex", "plus", () => loadPlans(b, [], cache));
    expect(result.ok).toBe(false);
    expect(result.providers?.find((p) => p.provider === "codex")?.declared).toBe("unknown");
  });

  it("asks the screen to re-read when the fresh copy cannot be fetched", async () => {
    const b = backend();
    const result = await savePlan(b, "codex", "plus", async () => ({
      ok: false,
      error: "failed",
    }));
    expect(result).toEqual({ ok: true, providers: null });
  });
});

describe("loading plans", () => {
  it("keeps the last server answer in memory and marks it stale when offline", async () => {
    const cache = { profiles: null as PlanProfile[] | null };
    const good = { getProfiles: async () => [profile()], setDeclaredPlan: async () => {} };
    const first = await loadPlans(good, [], cache);
    expect(first.ok && first.stale).toBe(false);

    const down = {
      getProfiles: async () => {
        throw new Error("offline");
      },
      setDeclaredPlan: async () => {},
    };
    const second = await loadPlans(down, [], cache);
    expect(second.ok && second.stale).toBe(true);
    expect(second.ok && second.providers[0]!.yourPlan).toBe("Pro");
  });

  it("fails without a cache instead of inventing a plan", async () => {
    expect(await loadPlans(null, [], { profiles: null })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("normalising the server's answer", () => {
  it("accepts the Runtime's shapes and drops what this screen does not know", () => {
    const out = normalizeProfiles({
      profiles: [
        {
          provider: "claude-code",
          declared_plan: "max_5x",
          usage_policy: "manual",
          paid_usage_enabled: true,
          detected: { detectedPlan: "max", email: "a@b.c" },
        },
        { provider: "cursor", declaredPlan: "pro" },
        { provider: "codex" },
        "junk",
      ],
    });
    expect(out).toEqual([
      {
        provider: "claude-code",
        declaredPlan: "max_5x",
        usagePolicy: "manual",
        paidUsageEnabled: true,
        detectedPlan: "max",
      },
    ]);
    expect(normalizeProfiles("nope")).toBeNull();
  });
});

describe("the adapter to the Runtime", () => {
  it("uses engine-level methods first", async () => {
    const engine = {
      getProviderProfiles: vi.fn(async () => []),
      setDeclaredPlan: vi.fn(async () => {}),
    };
    const api = { providerProfiles: vi.fn(), setDeclaredPlan: vi.fn() };
    const b = planBackend(engine, api)!;
    await b.getProfiles();
    await b.setDeclaredPlan("codex", "plus");
    expect(engine.getProviderProfiles).toHaveBeenCalled();
    expect(engine.setDeclaredPlan).toHaveBeenCalledWith("codex", "plus");
    expect(api.setDeclaredPlan).not.toHaveBeenCalled();
  });

  it("falls back to the API client, keeping `this`", async () => {
    class Api {
      calls: unknown[][] = [];
      async providerProfiles() {
        return this.calls;
      }
      async setDeclaredPlan(...args: unknown[]) {
        this.calls.push(args);
      }
    }
    const api = new Api();
    const b = planBackend({}, api)!;
    await b.setDeclaredPlan("claude-code", "pro");
    expect(await b.getProfiles()).toEqual([["claude-code", "pro"]]);
  });

  it("is null (fail closed) when either half is missing", () => {
    expect(planBackend(null, null)).toBeNull();
    expect(planBackend({ getProviderProfiles: async () => [] }, {})).toBeNull();
    expect(planBackend({}, { setDeclaredPlan: async () => {} })).toBeNull();
  });
});

describe("the IPC surface", () => {
  const main = readFileSync(join(ROOT, "desktop", "src", "main.ts"), "utf8");
  const preload = readFileSync(join(ROOT, "desktop", "src", "preload.cts"), "utf8");

  it("routes plans:set through the validating savePlan", () => {
    expect(main).toMatch(
      /ipcMain\.handle\("plans:set",[\s\S]{0,120}savePlan\(planBackend\(engine, api\), rawProvider, rawPlan/,
    );
  });

  it("exposes only fixed arguments to the renderer", () => {
    expect(preload).toContain('ipcRenderer.invoke("plans:get")');
    expect(preload).toContain('ipcRenderer.invoke("plans:set", provider, plan)');
  });

  it("never writes a plan to disk", () => {
    const plans = readFileSync(join(ROOT, "desktop", "src", "plans.ts"), "utf8");
    expect(plans).not.toMatch(/node:fs|writeFile|saveSettings|saveConfig/);
    expect(main).not.toMatch(/saveSettings\([^)]*[Pp]lan/);
  });
});
