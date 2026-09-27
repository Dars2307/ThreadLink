/**
 * The team job a carrier task delivers, parsed strictly.
 *
 * A team job reaches the Runtime as an ordinary ThreadLink task whose content
 * is this JSON document. It was built by the server, but it is still input
 * from the network, so it is validated field by field here and anything
 * unexpected fails the whole job rather than being guessed at.
 *
 * `verifyCommands` deserve particular care: ThreadLink runs them itself, with
 * the user's own privileges and outside any agent sandbox. They come only from
 * the owner's room policy or the controller at job start -- never from an
 * agent's output -- and are bounded here as well as on the server.
 */

import type { TeamSpec } from "./prompts.ts";
import { parseTimeoutOverrides, type TimeoutOverrides } from "./timeouts.ts";
import {
  parseChatId,
  parseParticipants,
  parseRoleOverrides,
  WireFieldError,
  type OverridableRole,
} from "./wire.ts";
import {
  AGENT_PROVIDERS,
  JOB_MODES,
  TEAM_LIMITS,
  TEAM_ROLES,
  USAGE_POLICIES,
  type AgentProvider,
  type JobMode,
  type TeamRole,
  type UsagePolicy,
} from "./types.ts";

export type TeamJobDefinition = {
  jobId: string;
  roomId: string;
  roomName: string;
  goal: string;
  spec: Partial<TeamSpec>;
  budgets: { maxPlanningRounds: number; maxReviewRounds: number; parallelAgents: number };
  policy: {
    usagePolicy: UsagePolicy;
    paidUsage: boolean;
    crossReview: boolean;
    finalInspection: boolean;
    worktreeIsolation: boolean;
    overrides: unknown[];
  };
  agents: { provider: AgentProvider; displayName: string; roles: TeamRole[] }[];
  verifyCommands: string[];
  /**
   * How the job is run. Absent in older job documents, which were all Team
   * Mode; `parseTeamJob` always sets it.
   */
  mode?: JobMode;
  /**
   * For solo and pair: the provider the owner chose to build. Null means
   * "choose for me" (roles.ts), never "Claude Code".
   */
  builder?: AgentProvider | null;
  /** For pair: the provider the owner chose to review. Null = choose. */
  reviewer?: AgentProvider | null;
  /** 0.9: roles the owner pinned to a provider. Absolute: never substituted. */
  roleOverrides?: Partial<Record<OverridableRole, AgentProvider>>;
  /** 0.9: the chat's participants (provider ids). Null = the room's agents. */
  participants?: AgentProvider[] | null;
  /** 0.9: the chat this job belongs to. */
  chatId?: string | null;
  /**
   * 0.10: the project's per-step timeout overrides, in minutes, within
   * 2-120 (timeouts.ts). Absent: the defaults.
   */
  timeouts?: TimeoutOverrides;
};

export class TeamJobError extends Error {
  constructor(message: string) {
    super(`This team job cannot be run: ${message}`);
    this.name = "TeamJobError";
  }
}

const ID = {
  job: /^tljob_[0-9a-f]{32}$/,
  room: /^tlrom_[0-9a-f]{32}$/,
};

const SPEC_FIELDS = [
  "requirements",
  "constraints",
  "architectureConstraints",
  "securityConstraints",
  "filesAndSystems",
  "testsRequired",
  "doNotChange",
  "deploymentRules",
  "definitionOfDone",
] as const;

function str(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TeamJobError(`${what} is missing or too long.`);
  }
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new TeamJobError(`${what} must be true or false.`);
  return value;
}

function strings(value: unknown, what: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TeamJobError(`${what} must be a short list.`);
  }
  return value.map((v, i) => str(v, `${what}[${i}]`, maxLength));
}

function bounded(value: unknown, what: string, limits: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TeamJobError(`${what} must be a whole number.`);
  }
  if (value < limits.min || value > limits.max) {
    throw new TeamJobError(`${what} must be between ${limits.min} and ${limits.max}.`);
  }
  return value;
}

/** A command ThreadLink will execute. One line, no control characters, bounded. */
function command(value: unknown, index: number): string {
  const text = str(value, `verifyCommands[${index}]`, 300);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new TeamJobError(`verifyCommands[${index}] contains control characters.`);
  }
  return text.trim();
}

export function parseTeamJob(content: string): TeamJobDefinition {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new TeamJobError("its definition is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TeamJobError("its definition is not an object.");
  }
  if (raw.kind !== "threadlink.team_job" || raw.version !== 1) {
    throw new TeamJobError("it is not a version 1 ThreadLink team job.");
  }

  const jobId = str(raw.jobId, "jobId", 64);
  const roomId = str(raw.roomId, "roomId", 64);
  if (!ID.job.test(jobId)) throw new TeamJobError("jobId is malformed.");
  if (!ID.room.test(roomId)) throw new TeamJobError("roomId is malformed.");

  const specIn = (raw.spec ?? {}) as Record<string, unknown>;
  if (typeof specIn !== "object" || Array.isArray(specIn)) {
    throw new TeamJobError("spec must be an object.");
  }
  const spec: Partial<TeamSpec> = {};
  for (const field of SPEC_FIELDS) {
    if (specIn[field] !== undefined)
      spec[field] = strings(specIn[field], `spec.${field}`, 50, 2_000);
  }

  const b = (raw.budgets ?? {}) as Record<string, unknown>;
  const p = (raw.policy ?? {}) as Record<string, unknown>;
  if (!USAGE_POLICIES.includes(p.usagePolicy as UsagePolicy)) {
    throw new TeamJobError("policy.usagePolicy is not a known policy.");
  }

  const agentsIn = raw.agents;
  if (!Array.isArray(agentsIn) || agentsIn.length === 0 || agentsIn.length > 8) {
    throw new TeamJobError("it names no agents.");
  }
  const agents = agentsIn.map((a, i) => {
    const agent = a as Record<string, unknown>;
    if (!AGENT_PROVIDERS.includes(agent.provider as AgentProvider)) {
      throw new TeamJobError(`agents[${i}] is not a supported provider.`);
    }
    const roles = strings(agent.roles, `agents[${i}].roles`, TEAM_ROLES.length, 40);
    for (const role of roles) {
      if (!TEAM_ROLES.includes(role as TeamRole)) {
        throw new TeamJobError(`agents[${i}] has an unknown role "${role}".`);
      }
    }
    return {
      provider: agent.provider as AgentProvider,
      displayName: str(agent.displayName, `agents[${i}].displayName`, 100),
      roles: roles as TeamRole[],
    };
  });

  const { mode, builder, reviewer } = parseMode(raw.mode, raw.builder, raw.reviewer, agents);

  let roleOverrides: Partial<Record<OverridableRole, AgentProvider>>;
  let participants: AgentProvider[] | null;
  let chatId: string | null;
  try {
    roleOverrides = parseRoleOverrides(raw.roleOverrides);
    participants = parseParticipants(raw.participants);
    chatId = parseChatId(raw.chatId);
  } catch (error) {
    if (error instanceof WireFieldError) throw new TeamJobError(error.message);
    throw error;
  }
  // The same role named twice with different providers is not something to pick between.
  if (builder && roleOverrides.builder && roleOverrides.builder !== builder) {
    throw new TeamJobError("builder and roleOverrides.builder name different agents.");
  }
  if (reviewer && roleOverrides.reviewer && roleOverrides.reviewer !== reviewer) {
    throw new TeamJobError("reviewer and roleOverrides.reviewer name different agents.");
  }

  let timeouts: TimeoutOverrides;
  try {
    timeouts = parseTimeoutOverrides(raw.timeouts ?? p.timeouts);
  } catch (error) {
    throw new TeamJobError((error as Error).message);
  }

  const verifyIn = raw.verifyCommands ?? [];
  if (!Array.isArray(verifyIn) || verifyIn.length > 10) {
    throw new TeamJobError("verifyCommands must be a list of at most 10 commands.");
  }

  return {
    jobId,
    roomId,
    roomName: str(raw.roomName, "roomName", 100),
    goal: str(raw.goal, "goal", 20_000),
    spec,
    budgets: {
      maxPlanningRounds: bounded(
        b.maxPlanningRounds,
        "maxPlanningRounds",
        TEAM_LIMITS.planningRounds,
      ),
      maxReviewRounds: bounded(b.maxReviewRounds, "maxReviewRounds", TEAM_LIMITS.reviewRounds),
      parallelAgents: bounded(b.parallelAgents, "parallelAgents", TEAM_LIMITS.parallelAgents),
    },
    policy: {
      usagePolicy: p.usagePolicy as UsagePolicy,
      // Paid usage is the owner's switch, set on their provider profile. Team
      // Mode's agents cannot use it anyway (their environment is scrubbed of
      // API keys and only subscription sign-ins are accepted), so a job that
      // arrives with it on runs on included usage and says so.
      paidUsage: bool(p.paidUsage, "policy.paidUsage"),
      crossReview: bool(p.crossReview, "policy.crossReview"),
      finalInspection: bool(p.finalInspection, "policy.finalInspection"),
      worktreeIsolation: bool(p.worktreeIsolation, "policy.worktreeIsolation"),
      overrides: Array.isArray(p.overrides) ? p.overrides.slice(0, 50) : [],
    },
    agents,
    verifyCommands: verifyIn.map(command),
    mode,
    builder,
    reviewer,
    roleOverrides,
    participants,
    chatId,
    timeouts,
  };
}

/**
 * The job's mode and, for solo and pair, who the owner chose to build and
 * review. All optional on the wire (absent means Team Mode, as every job was
 * before modes existed; no builder means "choose for me"), but a value that is
 * present must be exactly right: an unknown mode, or a builder or reviewer
 * that is not in the room, fails the job rather than being guessed at. No
 * provider is a default (docs/design/chat-first.md §4).
 */
function parseMode(
  rawMode: unknown,
  rawBuilder: unknown,
  rawReviewer: unknown,
  agents: { provider: AgentProvider }[],
): { mode: JobMode; builder: AgentProvider | null; reviewer: AgentProvider | null } {
  if (rawMode !== undefined && rawMode !== null && !JOB_MODES.includes(rawMode as JobMode)) {
    throw new TeamJobError("mode is not solo, pair or team.");
  }
  const mode = (rawMode ?? "team") as JobMode;
  const provider = (value: unknown, what: string): AgentProvider | null => {
    if (value === undefined || value === null) return null;
    if (!AGENT_PROVIDERS.includes(value as AgentProvider)) {
      throw new TeamJobError(`${what} is not a supported provider.`);
    }
    return value as AgentProvider;
  };
  const builder = provider(rawBuilder, "builder");
  const reviewer = provider(rawReviewer, "reviewer");
  if (mode === "team") return { mode, builder: null, reviewer: null };
  const present = new Set(agents.map((a) => a.provider));
  if (builder && !present.has(builder)) {
    throw new TeamJobError("the builder is not one of the room's agents.");
  }
  if (mode === "solo") return { mode, builder, reviewer: null };
  if (reviewer && !present.has(reviewer)) {
    throw new TeamJobError("the reviewer is not one of the room's agents.");
  }
  if (builder && reviewer && builder === reviewer) {
    throw new TeamJobError("the builder cannot review its own work.");
  }
  return { mode, builder, reviewer };
}
