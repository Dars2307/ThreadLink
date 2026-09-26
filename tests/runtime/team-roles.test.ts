import { describe, expect, it } from "vitest";

import {
  assignRoles,
  rolesDecisionText,
  type AssignRolesInput,
  type RoleAssignment,
  type RoleCandidate,
} from "../../runtime/src/team/roles.ts";
import type { ProviderHealth } from "../../runtime/src/team/health.ts";

/**
 * Provider-neutral roles (docs/design/chat-first.md §4): no provider is
 * special, an unhealthy one is never chosen, an override is absolute, and
 * equal providers share the load across jobs.
 */

const claude = (health: ProviderHealth = "ready", classes = ["FRONTIER", "FAST"] as const) =>
  ({ provider: "claude-code", health, modelClasses: [...classes] }) as RoleCandidate;
const codex = (health: ProviderHealth = "ready", classes = ["FRONTIER", "BALANCED"] as const) =>
  ({ provider: "codex", health, modelClasses: [...classes] }) as RoleCandidate;

const seed = (i: number) => `tljob_${i.toString(16).padStart(32, "0")}`;

const team = (over: Partial<AssignRolesInput> = {}) =>
  assignRoles({ mode: "team", participants: [claude(), codex()], seed: seed(1), ...over });

const ok = (r: ReturnType<typeof assignRoles>): RoleAssignment => {
  if (!r.ok) throw new Error(`refused: ${r.message}`);
  return r;
};

describe("assigning roles", () => {
  it("Claude-only: solo builds with Claude Code; team is refused rather than self-reviewed", () => {
    const solo = ok(assignRoles({ mode: "solo", participants: [claude()], seed: seed(1) }));
    expect(solo).toMatchObject({
      builders: ["claude-code"],
      reviewers: [],
      coordinator: "claude-code",
    });
    const teamOnly = assignRoles({ mode: "team", participants: [claude()], seed: seed(1) });
    expect(teamOnly).toMatchObject({ ok: false, verdict: "NEEDS_USER_DECISION" });
    const pair = assignRoles({ mode: "pair", participants: [claude()], seed: seed(1) });
    expect(pair.ok).toBe(false);
  });

  it("Codex-only: solo builds with Codex", () => {
    const solo = ok(assignRoles({ mode: "solo", participants: [codex()], seed: seed(2) }));
    expect(solo.builders).toEqual(["codex"]);
    expect(solo.coordinator).toBe("codex");
  });

  it("both healthy and equal: the coordinator alternates with the job id, deterministically", () => {
    const coordinators = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const a = ok(team({ seed: seed(i) }));
      const again = ok(team({ seed: seed(i) }));
      expect(again).toEqual(a); // same job, same answer
      coordinators.set(a.coordinator, (coordinators.get(a.coordinator) ?? 0) + 1);
      // The work is shared: the planner is not the coordinator when both are equal.
      expect(a.planner).not.toBe(a.coordinator);
      expect(a.reviewers).toHaveLength(2);
    }
    expect(coordinators.get("claude-code")).toBeGreaterThan(5);
    expect(coordinators.get("codex")).toBeGreaterThan(5);
  });

  it("both healthy: the order of participants does not decide", () => {
    for (let i = 0; i < 10; i++) {
      const a = ok(team({ seed: seed(i), participants: [claude(), codex()] }));
      const b = ok(team({ seed: seed(i), participants: [codex(), claude()] }));
      expect(b.coordinator).toBe(a.coordinator);
      expect(b.planner).toBe(a.planner);
    }
  });

  it("one unhealthy: it is never chosen, and a job that needs it is refused", () => {
    for (let i = 0; i < 20; i++) {
      const solo = ok(
        assignRoles({
          mode: "solo",
          participants: [claude("needs_sign_in"), codex()],
          seed: seed(i),
        }),
      );
      expect(solo.builders).toEqual(["codex"]);
    }
    const t = team({ participants: [claude("needs_sign_in"), codex()] });
    expect(t).toMatchObject({
      ok: false,
      verdict: "BLOCKED",
      provider: "claude-code",
      health: "needs_sign_in",
    });
    const pair = assignRoles({
      mode: "pair",
      participants: [claude(), codex("api_key_auth")],
      seed: seed(1),
    });
    expect(pair).toMatchObject({ ok: false, provider: "codex", health: "api_key_auth" });
  });

  it("honours an override absolutely", () => {
    for (let i = 0; i < 20; i++) {
      const a = ok(
        team({ seed: seed(i), overrides: { coordinator: "codex", integrator: "claude-code" } }),
      );
      expect(a.coordinator).toBe("codex");
      expect(a.integrator).toBe("claude-code");
      expect(a.reasons.join(" ")).toMatch(/Codex coordinates \(you chose it\)/);
    }
    const pair = ok(
      assignRoles({
        mode: "pair",
        participants: [claude(), codex()],
        overrides: { builder: "codex" },
        seed: seed(3),
      }),
    );
    expect(pair.builders).toEqual(["codex"]);
    expect(pair.reviewers).toEqual(["claude-code"]);
  });

  it("refuses an override whose provider is not ready, and never substitutes", () => {
    const r = team({
      participants: [claude(), codex("needs_sign_in")],
      overrides: { coordinator: "codex" },
    });
    expect(r).toMatchObject({ ok: false, verdict: "BLOCKED", provider: "codex" });
    const solo = assignRoles({
      mode: "solo",
      participants: [claude(), codex("usage_exhausted")],
      overrides: { builder: "codex" },
      seed: seed(1),
    });
    expect(solo).toMatchObject({ ok: false, provider: "codex", health: "usage_exhausted" });
    const absent = assignRoles({
      mode: "solo",
      participants: [claude()],
      overrides: { builder: "codex" },
      seed: seed(1),
    });
    expect(absent).toMatchObject({ ok: false, verdict: "NEEDS_USER_DECISION", provider: "codex" });
    const self = assignRoles({
      mode: "pair",
      participants: [claude(), codex()],
      overrides: { builder: "codex", reviewer: "codex" },
      seed: seed(1),
    });
    expect(self).toMatchObject({ ok: false, verdict: "NEEDS_USER_DECISION" });
  });

  it("uses the project's role preference only when it distinguishes the agents", () => {
    for (let i = 0; i < 20; i++) {
      const a = ok(
        team({
          seed: seed(i),
          roomPrefs: {
            "claude-code": ["builder", "reviewer"],
            codex: ["planner", "builder", "reviewer"],
          },
        }),
      );
      expect(a.planner).toBe("codex");
    }
    // Every agent listing every role (the reset default) is no preference: the split still alternates.
    const all = ["coordinator", "planner", "builder", "reviewer", "integrator"] as const;
    const planners = new Set(
      Array.from(
        { length: 30 },
        (_, i) =>
          ok(team({ seed: seed(i), roomPrefs: { "claude-code": [...all], codex: [...all] } }))
            .planner,
      ),
    );
    expect(planners).toEqual(new Set(["claude-code", "codex"]));
  });

  it("prefers the stronger model class, then fewer recent failures", () => {
    const strong = ok(
      team({
        participants: [claude("ready", ["STRONG"] as never), codex("ready", ["FRONTIER"] as never)],
      }),
    );
    expect(strong.coordinator).toBe("codex");
    for (let i = 0; i < 10; i++) {
      const a = ok(team({ seed: seed(i), history: { recentFailures: { codex: 2 } } }));
      expect(a.coordinator).toBe("claude-code");
    }
  });

  it("explains itself in fixed words, naming providers only", () => {
    const a = ok(team({ overrides: { coordinator: "codex" } }));
    const text = rolesDecisionText(a);
    expect(text).toMatch(/^Roles: Codex coordinates \(you chose it\); Claude Code plans \(/);
    expect(text).toMatch(/each unit is reviewed by an agent that did not build it/);
  });
});
