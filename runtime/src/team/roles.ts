/**
 * Provider-neutral role assignment (docs/design/chat-first.md §4).
 *
 * No provider is special. For each role the candidates are the participants
 * that are `ready`; an unhealthy provider is never chosen, and a role that
 * cannot be filled is a refusal, never a substitution. Among the ready ones,
 * in this order:
 *
 *   1. the person's override for the role (absolute: if that provider is not
 *      ready, the job is refused rather than given to someone else);
 *   2. the project's role preference, when it actually distinguishes them
 *      (an agent with no roles listed, or every agent listing the role, is no
 *      preference);
 *   3. the strongest model class the provider has here;
 *   4. fewer recent failures;
 *   5. fewer roles already held in this job, so the work is shared;
 *   6. a deterministic tie-break from the job id, so load alternates across
 *      jobs instead of always landing on the same provider.
 *
 * Pure: no clock, no randomness, no I/O. The reasons it gives are built from
 * fixed text and provider names only, never from anything an agent wrote.
 */

import { createHash } from "node:crypto";

import type { ProviderHealth } from "./health.ts";
import {
  MODEL_CLASSES,
  type AgentProvider,
  type JobMode,
  type ModelClass,
  type TeamRole,
} from "./types.ts";

export const ASSIGNABLE_ROLES = [
  "coordinator",
  "planner",
  "builder",
  "reviewer",
  "integrator",
] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export type RoleOverrides = Partial<Record<AssignableRole, AgentProvider>>;

export type RoleCandidate = {
  provider: AgentProvider;
  health: ProviderHealth;
  /** Classes of the selectable models this provider has on this computer. */
  modelClasses: readonly ModelClass[];
};

export type AssignRolesInput = {
  mode: JobMode;
  /** The chat's participants, in the chat's order. */
  participants: readonly RoleCandidate[];
  /** The project's role preferences per provider (room_agents roles). */
  roomPrefs?: Partial<Record<AgentProvider, readonly TeamRole[]>>;
  overrides?: RoleOverrides;
  history?: { recentFailures?: Partial<Record<AgentProvider, number>> };
  /** The job id. */
  seed: string;
};

export type RoleAssignment = {
  ok: true;
  coordinator: AgentProvider;
  planner: AgentProvider;
  integrator: AgentProvider;
  /** Every provider that may build, best first. Solo and pair: exactly the builder. */
  builders: AgentProvider[];
  /** Every provider that may review, best first. Empty in solo. */
  reviewers: AgentProvider[];
  /** One fixed-text line per role decided. */
  reasons: string[];
};

export type RoleRefusal = {
  ok: false;
  verdict: "BLOCKED" | "NEEDS_USER_DECISION";
  role: AssignableRole;
  /** The provider the refusal is about, when there is one. */
  provider: AgentProvider | null;
  health: ProviderHealth | null;
  message: string;
};

export const PROVIDER_NAME: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const VERB: Record<AssignableRole, string> = {
  coordinator: "coordinates",
  planner: "plans",
  builder: "builds",
  reviewer: "reviews",
  integrator: "integrates",
};

const CLASS_RANK = Object.fromEntries(MODEL_CLASSES.map((c, i) => [c, i])) as Record<
  ModelClass,
  number
>;

function strongest(c: RoleCandidate): ModelClass | null {
  let best: ModelClass | null = null;
  for (const m of c.modelClasses) if (!best || CLASS_RANK[m] > CLASS_RANK[best]) best = m;
  return best;
}

function tieBreak(seed: string, provider: AgentProvider): string {
  return createHash("sha256").update(`${seed}\u0000${provider}`).digest("hex");
}

type Scored = {
  c: RoleCandidate;
  pref: number;
  strength: number;
  failures: number;
  load: number;
  tie: string;
};

function compare(a: Scored, b: Scored): number {
  return (
    b.pref - a.pref ||
    b.strength - a.strength ||
    a.failures - b.failures ||
    a.load - b.load ||
    (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0)
  );
}

/** Why `winner` beat `runnerUp`, in fixed words. */
function why(winner: Scored, runnerUp: Scored | undefined): string {
  if (!runnerUp) return "the only agent ready for it";
  if (winner.pref !== runnerUp.pref) return "the project prefers it for this role";
  if (winner.strength !== runnerUp.strength) {
    return `its strongest model here is ${strongest(winner.c) ?? "unknown"}`;
  }
  if (winner.failures !== runnerUp.failures) return "fewer recent failures";
  if (winner.load !== runnerUp.load) return "shares the work";
  return "even split, decided by this job";
}

export function assignRoles(input: AssignRolesInput): RoleAssignment | RoleRefusal {
  const participants = dedupe(input.participants);
  const byProvider = new Map(participants.map((p) => [p.provider, p]));
  const ready = participants.filter((p) => p.health === "ready");
  const overrides = input.overrides ?? {};
  const load = new Map<AgentProvider, number>();
  const reasons: string[] = [];

  const prefers = (provider: AgentProvider, role: AssignableRole): boolean => {
    const roles = input.roomPrefs?.[provider];
    return !roles || roles.length === 0 || roles.includes(role);
  };

  const rank = (role: AssignableRole, exclude: readonly AgentProvider[] = []): Scored[] => {
    const pool = ready.filter((c) => !exclude.includes(c.provider));
    const discriminating = !pool.every((c) => prefers(c.provider, role));
    return pool
      .map((c) => ({
        c,
        pref: discriminating && prefers(c.provider, role) ? 1 : 0,
        strength: CLASS_RANK[strongest(c) ?? "BALANCED"],
        failures: input.history?.recentFailures?.[c.provider] ?? 0,
        load: load.get(c.provider) ?? 0,
        tie: tieBreak(input.seed, c.provider),
      }))
      .sort(compare);
  };

  const refuseFor = (role: AssignableRole, exclude: readonly AgentProvider[] = []): RoleRefusal => {
    const unhealthy = participants.find(
      (p) => p.health !== "ready" && !exclude.includes(p.provider),
    );
    if (unhealthy) {
      return {
        ok: false,
        verdict: "BLOCKED",
        role,
        provider: unhealthy.provider,
        health: unhealthy.health,
        message: `No agent in this chat is ready to ${VERB[role].replace(/s$/, "")}: ${PROVIDER_NAME[unhealthy.provider]} is not ready.`,
      };
    }
    return {
      ok: false,
      verdict: "NEEDS_USER_DECISION",
      role,
      provider: null,
      health: null,
      message: `No agent in this chat can take the ${role} role. Add another agent, or choose a different mode.`,
    };
  };

  /**
   * One role holder. An override is absolute; otherwise the best-ranked ready
   * provider not excluded (a reviewer is never the builder it reviews).
   */
  const pick = (
    role: AssignableRole,
    exclude: readonly AgentProvider[] = [],
  ): AgentProvider | RoleRefusal => {
    const chosen = overrides[role];
    if (chosen) {
      const c = byProvider.get(chosen);
      if (!c) {
        return {
          ok: false,
          verdict: "NEEDS_USER_DECISION",
          role,
          provider: chosen,
          health: null,
          message: `${PROVIDER_NAME[chosen]} was chosen to take the ${role} role but is not part of this chat.`,
        };
      }
      if (exclude.includes(chosen)) {
        return {
          ok: false,
          verdict: "NEEDS_USER_DECISION",
          role,
          provider: chosen,
          health: null,
          message: `${PROVIDER_NAME[chosen]} cannot take the ${role} role: nobody reviews their own work.`,
        };
      }
      if (c.health !== "ready") {
        return {
          ok: false,
          verdict: "BLOCKED",
          role,
          provider: chosen,
          health: c.health,
          message: `${PROVIDER_NAME[chosen]} was chosen to take the ${role} role but is not ready. ThreadLink will not give the role to another agent.`,
        };
      }
      load.set(chosen, (load.get(chosen) ?? 0) + 1);
      reasons.push(`${PROVIDER_NAME[chosen]} ${VERB[role]} (you chose it)`);
      return chosen;
    }
    const ranked = rank(role, exclude);
    const winner = ranked[0];
    if (!winner) return refuseFor(role, exclude);
    load.set(winner.c.provider, (load.get(winner.c.provider) ?? 0) + 1);
    reasons.push(`${PROVIDER_NAME[winner.c.provider]} ${VERB[role]} (${why(winner, ranked[1])})`);
    return winner.c.provider;
  };

  if (input.mode === "solo" || input.mode === "pair") {
    const builder = pick("builder");
    if (typeof builder !== "string") return builder;
    if (input.mode === "solo") {
      return {
        ok: true,
        coordinator: builder,
        planner: builder,
        integrator: builder,
        builders: [builder],
        reviewers: [],
        reasons,
      };
    }
    const reviewer = pick("reviewer", [builder]);
    if (typeof reviewer !== "string") return reviewer;
    return {
      ok: true,
      coordinator: builder,
      planner: builder,
      integrator: builder,
      builders: [builder],
      reviewers: [reviewer],
      reasons,
    };
  }

  // Team: two or more distinct providers, every one of them ready.
  if (participants.length < 2) {
    return {
      ok: false,
      verdict: "NEEDS_USER_DECISION",
      role: "reviewer",
      provider: null,
      health: null,
      message:
        "Team needs at least two different agents in the chat, so that nobody reviews their own work.",
    };
  }
  for (const role of ["builder", "reviewer"] as const) {
    const chosen = overrides[role];
    if (!chosen) continue;
    const c = byProvider.get(chosen);
    if (!c || c.health !== "ready") {
      return {
        ok: false,
        verdict: c ? "BLOCKED" : "NEEDS_USER_DECISION",
        role,
        provider: chosen,
        health: c?.health ?? null,
        message: c
          ? `${PROVIDER_NAME[chosen]} was chosen to take the ${role} role but is not ready. ThreadLink will not give the role to another agent.`
          : `${PROVIDER_NAME[chosen]} was chosen to take the ${role} role but is not part of this chat.`,
      };
    }
  }
  const coordinator = pick("coordinator");
  if (typeof coordinator !== "string") return coordinator;
  const planner = pick("planner");
  if (typeof planner !== "string") return planner;
  const integrator = pick("integrator");
  if (typeof integrator !== "string") return integrator;

  // Builders and reviewers are ranked lists: the plan names who builds each
  // unit, and each unit is reviewed by the best-ranked provider that did not build it.
  const builders = orderedWithOverride("builder");
  const reviewers = orderedWithOverride("reviewer");
  if (builders.length < 1 || reviewers.length < 2) return refuseFor("reviewer");
  reasons.push(
    `${builders.map((p) => PROVIDER_NAME[p]).join(" and ")} build; each unit is reviewed by an agent that did not build it`,
  );
  return { ok: true, coordinator, planner, integrator, builders, reviewers, reasons };

  function orderedWithOverride(role: "builder" | "reviewer"): AgentProvider[] {
    const ranked = rank(role).map((s) => s.c.provider);
    const chosen = overrides[role];
    if (!chosen || !ranked.includes(chosen)) return ranked;
    return [chosen, ...ranked.filter((p) => p !== chosen)];
  }
}

function dedupe(list: readonly RoleCandidate[]): RoleCandidate[] {
  const seen = new Set<AgentProvider>();
  return list.filter((c) => (seen.has(c.provider) ? false : (seen.add(c.provider), true)));
}

/** The decision line: "Roles: Codex coordinates (…); Claude Code plans (…); …". */
export function rolesDecisionText(assignment: RoleAssignment): string {
  return `Roles: ${assignment.reasons.join("; ")}.`;
}
