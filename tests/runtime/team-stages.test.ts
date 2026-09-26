import { describe, expect, it } from "vitest";

import { deriveStages, type StageInput } from "../../runtime/src/team/stages.ts";

/**
 * Honest progress (docs/design/chat-first.md §3). The production job that
 * failed at planning round 0 with no plan was shown "Plan ✓". Never again.
 */

const base: StageInput = {
  mode: "team",
  phase: "queued",
  specDone: false,
  planApproved: false,
  reviews: true,
  units: [],
  verdict: null,
  reason: null,
};

const view = (input: Partial<StageInput>) =>
  deriveStages({ ...base, ...input })
    .map((s) => `${s.label}:${s.state}`)
    .join(" · ");

describe("the stage list", () => {
  it("names the stages in order; solo has no Review", () => {
    expect(deriveStages(base).map((s) => s.label)).toEqual([
      "Understanding request",
      "Plan",
      "Build",
      "Review",
      "Integration",
    ]);
    expect(deriveStages({ ...base, mode: "solo" }).map((s) => s.key)).toEqual([
      "understanding",
      "plan",
      "build",
      "integration",
    ]);
  });

  it("failure before normalisation (a provider needs sign-in at preflight)", () => {
    expect(view({ phase: "queued", verdict: "BLOCKED", reason: "agent_needs_sign_in" })).toBe(
      "Understanding request:failed · Plan:skipped · Build:skipped · Review:skipped · Integration:skipped",
    );
  });

  it("failure during normalisation", () => {
    expect(view({ phase: "normalising", verdict: "BLOCKED", reason: "agent_failed" })).toBe(
      "Understanding request:failed · Plan:skipped · Build:skipped · Review:skipped · Integration:skipped",
    );
  });

  it("failure before the first planning round: Plan is failed, never done", () => {
    expect(
      view({ phase: "planning", specDone: true, verdict: "BLOCKED", reason: "agent_failed" }),
    ).toBe(
      "Understanding request:done · Plan:failed · Build:skipped · Review:skipped · Integration:skipped",
    );
  });

  it("failure during planning, including a plan that was proposed but never approved", () => {
    expect(
      view({
        phase: "planning",
        specDone: true,
        planApproved: false,
        verdict: "NEEDS_USER_DECISION",
        reason: "agents_disagree",
      }),
    ).toBe(
      "Understanding request:done · Plan:failed · Build:skipped · Review:skipped · Integration:skipped",
    );
  });

  it("while running: active where the job is, waiting after it", () => {
    expect(view({ phase: "normalising" })).toBe(
      "Understanding request:active · Plan:waiting · Build:waiting · Review:waiting · Integration:waiting",
    );
    expect(view({ phase: "planning", specDone: true })).toBe(
      "Understanding request:done · Plan:active · Build:waiting · Review:waiting · Integration:waiting",
    );
    expect(
      view({
        phase: "building",
        specDone: true,
        planApproved: true,
        units: [{ status: "in_review" }, { status: "running" }],
      }),
    ).toBe(
      "Understanding request:done · Plan:done · Build:active · Review:active · Integration:waiting",
    );
  });

  it("puts a failed review in Review, and a build failure in Build", () => {
    const building = { phase: "building", specDone: true, planApproved: true } as const;
    expect(view({ ...building, verdict: "NEEDS_FIX", reason: "review_not_passed" })).toBe(
      "Understanding request:done · Plan:done · Build:done · Review:failed · Integration:skipped",
    );
    expect(view({ ...building, verdict: "BLOCKED", reason: "agent_needs_sign_in" })).toBe(
      "Understanding request:done · Plan:done · Build:failed · Review:skipped · Integration:skipped",
    );
  });

  it("a PASS is done throughout; Review is skipped when it did not run", () => {
    const done = {
      phase: "inspecting",
      specDone: true,
      planApproved: true,
      verdict: "PASS",
    } as const;
    expect(view(done)).toBe(
      "Understanding request:done · Plan:done · Build:done · Review:done · Integration:done",
    );
    expect(view({ ...done, reviews: false })).toBe(
      "Understanding request:done · Plan:done · Build:done · Review:skipped · Integration:done",
    );
  });

  it("never shows Plan done without an approved plan", () => {
    for (const phase of ["queued", "normalising", "planning", "building", "integrating"]) {
      for (const verdict of [null, "PASS", "BLOCKED"] as const) {
        const plan = deriveStages({ ...base, phase, specDone: true, verdict }).find(
          (s) => s.key === "plan",
        )!;
        expect(plan.state, `${phase}/${verdict}`).not.toBe("done");
      }
    }
  });
});
