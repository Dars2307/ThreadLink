/**
 * Binds the orchestrator's ports to the real router, usage governor and task
 * graph. Kept separate so the orchestrator stays testable with fakes, and so
 * the one place that decides which model runs is easy to find.
 */

import {
  analyseOverlap,
  integrationOrder,
  patternsOverlap,
  schedule,
  validateGraph,
  type DagNode,
} from "./dag.ts";
import type { ClassifiedModel } from "./models.ts";
import type { GraphNode, GraphPort, RouteRequest, RouteResult } from "./orchestrator.ts";
import { selectModel, type RouteOverride } from "./router.ts";
import type { UsagePolicy } from "./types.ts";
import type { UsageGovernor } from "./usage.ts";

const toDag = (n: GraphNode): DagNode => ({
  key: n.key,
  deps: n.dependsOn,
  files: n.files,
  readOnly: n.readOnly,
});

function describeGraphErrors(
  errors: Exclude<ReturnType<typeof validateGraph>, { ok: true }>["errors"],
) {
  return errors
    .map((e) => {
      switch (e.kind) {
        case "empty_key":
          return `unit ${e.index + 1} has no key`;
        case "duplicate_key":
          return `"${e.key}" is used for more than one unit`;
        case "unknown_dep":
          return `"${e.key}" depends on "${e.dep}", which is not in the plan`;
        case "self_dep":
          return `"${e.key}" depends on itself`;
        case "cycle":
          return `the units ${e.cycle.join(" → ")} depend on each other in a loop`;
      }
    })
    .join("; ");
}

export function graphPort(): GraphPort {
  return {
    validate(nodes) {
      const result = validateGraph(nodes.map(toDag));
      if (!result.ok)
        throw new Error(`The plan is not a valid graph: ${describeGraphErrors(result.errors)}.`);
    },
    schedule(nodes, statuses, parallelLimit) {
      return schedule(nodes.map(toDag), statuses, parallelLimit);
    },
    integrationOrder(nodes) {
      return integrationOrder(nodes.map(toDag));
    },
    outOfScope(files, scope) {
      // No declared scope means the plan did not restrict the unit.
      if (!scope.length) return [];
      return files.filter((file) => !scope.some((pattern) => patternsOverlap(file, pattern)));
    },
    serialisations(nodes) {
      return analyseOverlap(nodes.map(toDag)).serialisations;
    },
  };
}

export type RoutePortOptions = {
  /** Discovered, classified models for every provider in the room. */
  available: readonly ClassifiedModel[];
  policy: UsagePolicy;
  overrides: readonly RouteOverride[];
  governor: UsageGovernor;
  now?: () => number;
};

/**
 * The orchestrator asks "which model for this role and this work?"; this adds
 * what it cannot know itself -- the room's policy and overrides, the models
 * actually discovered on this computer, and which ones have run out.
 */
export function routePort(options: RoutePortOptions): (request: RouteRequest) => RouteResult {
  const now = options.now ?? Date.now;
  return (request) => {
    const decision = selectModel({
      provider: request.provider,
      role: request.role,
      complexity: request.complexity,
      risk: request.risk,
      contextLarge: false,
      previousFailures: request.previousFailures,
      disputedFindings: request.disputedFindings,
      policy: options.policy,
      overrides: options.overrides,
      available: options.available.filter((m) => m.provider === request.provider),
      exhausted: options.governor.exhausted(now()),
      hints: options.governor.hints(request.provider),
    });
    if (!decision.ok) return { ok: false, reason: decision.reason, options: decision.options };
    // The router is given one provider and must return that provider. Checked
    // here too, because a quiet provider switch is the one thing this must not do.
    if (decision.provider !== request.provider) {
      return {
        ok: false,
        reason: `The router tried to switch from ${request.provider} to ${decision.provider}; refused.`,
        options: ["ask_user"],
      };
    }
    return {
      ok: true,
      model: decision.model,
      effort: decision.effort,
      modelClass: decision.modelClass,
      reason: decision.reason,
      escalatedFrom: decision.escalatedFrom,
      escalationReason: decision.escalationReason,
    };
  };
}
