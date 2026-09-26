/**
 * Honest progress (docs/design/chat-first.md §3): the stages a job shows, and
 * where each one stands, derived only from what really happened.
 *
 *   Understanding request · Plan · Build · Review · Integration   (solo: no Review)
 *
 * Plan is `done` only when a plan was persisted AND approved. The stage where a
 * finished job stopped is `failed`; every later stage is `skipped` (never
 * reached). Pure, so the desktop app can be given the result without guessing.
 */

import type { JobMode, JobVerdict, NodeStatus } from "./types.ts";
import type { VerdictReason } from "./verdict-reasons.ts";

export const STAGE_KEYS = ["understanding", "plan", "build", "review", "integration"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** ✓ done · ● active · ✕ failed · ○ waiting (not started) · – skipped (never reached). */
export const STAGE_STATES = ["done", "active", "failed", "waiting", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export type TeamStage = { key: StageKey; label: string; state: StageState };

export const STAGE_LABELS: Record<StageKey, string> = {
  understanding: "Understanding request",
  plan: "Plan",
  build: "Build",
  review: "Review",
  integration: "Integration",
};

export type StageInput = {
  mode: JobMode;
  /** The last non-terminal status the job reached ("queued" before any). */
  phase: string;
  /** The specification was written. */
  specDone: boolean;
  /** A plan was persisted and approved. */
  planApproved: boolean;
  /** This job has a review stage that runs (pair, or team with cross-review). */
  reviews: boolean;
  units: readonly { status: NodeStatus }[];
  /** Null while running. */
  verdict: JobVerdict | null;
  reason?: VerdictReason | null;
};

/** Failures that belong to the Review stage when they happen while building. */
const REVIEW_REASONS = new Set<VerdictReason>([
  "review_not_passed",
  "agents_disagree",
  "changed_during_review",
]);

const FINISHED_UNIT = new Set<NodeStatus>(["approved", "integrated"]);

function stageAt(input: StageInput): StageKey {
  switch (input.phase) {
    case "planning":
      return input.planApproved ? "build" : "plan";
    case "building":
    case "reviewing":
      return "build";
    case "integrating":
    case "inspecting":
      return "integration";
    default:
      // queued / normalising: until the specification exists, the request is
      // still being understood.
      return input.specDone ? "plan" : "understanding";
  }
}

export function deriveStages(input: StageInput): TeamStage[] {
  const keys = STAGE_KEYS.filter((k) => k !== "review" || input.mode !== "solo");
  const reviewApplies = input.mode !== "solo" && input.reviews;
  const state = new Map<StageKey, StageState>();

  if (input.verdict === "PASS") {
    for (const k of keys) state.set(k, "done");
    if (!reviewApplies) state.set("review", "skipped");
    if (!input.planApproved) state.set("plan", "skipped");
  } else if (input.verdict !== null) {
    let failed = stageAt(input);
    if (failed === "build" && reviewApplies && input.reason && REVIEW_REASONS.has(input.reason)) {
      failed = "review";
    }
    const at = keys.indexOf(failed);
    keys.forEach((k, i) => state.set(k, i < at ? "done" : i === at ? "failed" : "skipped"));
    // Build and Review run together; a failure while building never reached review.
    if (failed === "build") state.set("review", "skipped");
    if (failed === "review") state.set("build", "done");
    if (!reviewApplies && at > keys.indexOf("review")) state.set("review", "skipped");
  } else {
    const current = stageAt(input);
    const at = keys.indexOf(current);
    keys.forEach((k, i) => state.set(k, i < at ? "done" : i === at ? "active" : "waiting"));
    if (current === "build") {
      const units = input.units;
      const allDone = units.length > 0 && units.every((u) => FINISHED_UNIT.has(u.status));
      if (allDone) state.set("build", "done");
      if (reviewApplies) {
        const inReview = units.some((u) => u.status === "in_review");
        state.set("review", allDone ? "done" : inReview ? "active" : "waiting");
      }
    }
    if (!reviewApplies && keys.includes("review")) state.set("review", "skipped");
  }

  // Never claim a plan that was not persisted and approved.
  if (state.get("plan") === "done" && !input.planApproved) state.set("plan", "skipped");

  return keys.map((key) => ({ key, label: STAGE_LABELS[key], state: state.get(key)! }));
}
