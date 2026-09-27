import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import {
  JOB_STATUSES,
  JOB_VERDICTS,
  ROOM_STATUSES,
  roomIdSchema,
  roomRowSchema,
  TEAM_LIMITS,
  TERMINAL_JOB_STATUSES,
  toRoomView,
  USAGE_POLICIES,
  verifyCommandsSchema,
  type JobStatus,
  type JobVerdict,
  type RoomStatus,
  type RoomView,
  type UsagePolicy,
} from "@/lib/team/model";

/**
 * Dashboard reads of rooms, in human-friendly shapes: names, statuses and
 * counts, so the UI never renders a raw ID. `roomId` is carried only as the
 * handle for actions. USER-SCOPED client (RLS) plus an owner re-check per row.
 */

export type OwnerRoom = {
  roomId: string;
  name: string;
  status: RoomStatus;
  statusLabel: string;
  workspaceName: string;
  agentName: string | null;
  usagePolicy: UsagePolicy;
  budgets: { parallelAgents: number; maxPlanningRounds: number; maxReviewRounds: number };
  jobs: { total: number; open: number; passed: number; needsAttention: number };
  lastJob: { goal: string; status: JobStatus; verdict: JobVerdict | null; at: string } | null;
  createdAt: string;
  updatedAt: string;
};

export const ROOM_STATUS_LABELS: Record<RoomStatus, string> = {
  active: "Active",
  archived: "Archived",
  deleted: "Deleted",
};

const roomSchema = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  name: z.string(),
  status: z.enum(ROOM_STATUSES),
  workspace_id: z.string(),
  agent_session_id: z.string().nullable(),
  parallel_agents: z.number(),
  max_planning_rounds: z.number(),
  max_review_rounds: z.number(),
  usage_policy: z.enum(USAGE_POLICIES),
  created_at: z.string(),
  updated_at: z.string(),
});
const named = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  display_name: z.string().nullable(),
});
const jobSchema = z.object({
  room_id: z.string(),
  owner_user_id: z.string(),
  goal: z.string(),
  status: z.enum(JOB_STATUSES),
  verdict: z.enum(JOB_VERDICTS).nullable(),
  created_at: z.string(),
});

const TERMINAL = new Set<string>(TERMINAL_JOB_STATUSES);
const ATTENTION = new Set<string>(["needs_fix", "blocked", "needs_user_decision", "failed"]);

export async function listRoomsFor(db: SupabaseClient, user: ThreadLinkUser): Promise<OwnerRoom[]> {
  const rooms = await db
    .from("rooms")
    .select(
      "id, owner_user_id, name, status, workspace_id, agent_session_id, parallel_agents, " +
        "max_planning_rounds, max_review_rounds, usage_policy, created_at, updated_at",
    )
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (rooms.error) throw new Error("Failed to load rooms");
  const rRows = z.array(roomSchema).parse(rooms.data);
  if (rRows.length === 0) return [];

  const [workspaces, sessions, jobs] = await Promise.all([
    db
      .from("runtime_workspaces")
      .select("id, owner_user_id, display_name")
      .in(
        "id",
        rRows.map((r) => r.workspace_id),
      ),
    db
      .from("session_bindings")
      .select("id, owner_user_id, display_name")
      .in(
        "id",
        rRows.flatMap((r) => (r.agent_session_id ? [r.agent_session_id] : [])),
      ),
    db
      .from("team_jobs")
      .select("room_id, owner_user_id, goal, status, verdict, created_at")
      .in(
        "room_id",
        rRows.map((r) => r.id),
      )
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (workspaces.error || sessions.error || jobs.error) throw new Error("Failed to load rooms");
  const wRows = z.array(named).parse(workspaces.data);
  const sRows = z.array(named).parse(sessions.data);
  const jRows = z.array(jobSchema).parse(jobs.data);
  if ([...rRows, ...wRows, ...sRows, ...jRows].some((row) => row.owner_user_id !== user.id)) {
    throw new OwnershipViolationError();
  }

  const workspaceName = new Map(wRows.map((w) => [w.id, w.display_name ?? "Workspace"]));
  const agentName = new Map(sRows.map((s) => [s.id, s.display_name]));

  return rRows.map((r) => {
    const mine = jRows.filter((j) => j.room_id === r.id);
    const last = mine[0];
    return {
      roomId: r.id,
      name: r.name,
      status: r.status,
      statusLabel: ROOM_STATUS_LABELS[r.status],
      workspaceName: workspaceName.get(r.workspace_id) ?? "Workspace",
      agentName: r.agent_session_id ? (agentName.get(r.agent_session_id) ?? null) : null,
      usagePolicy: r.usage_policy,
      budgets: {
        parallelAgents: r.parallel_agents,
        maxPlanningRounds: r.max_planning_rounds,
        maxReviewRounds: r.max_review_rounds,
      },
      jobs: {
        total: mine.length,
        open: mine.filter((j) => !TERMINAL.has(j.status)).length,
        passed: mine.filter((j) => j.verdict === "PASS").length,
        needsAttention: mine.filter((j) => ATTENTION.has(j.status)).length,
      },
      lastJob: last
        ? {
            goal: last.goal.slice(0, 120),
            status: last.status,
            verdict: last.verdict,
            at: last.created_at,
          }
        : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Owner operations (Clerk-authenticated client; the database re-checks
// ownership). Deleting is a status change and a detach: never files, never
// the carrier tasks' history.
// ---------------------------------------------------------------------------
export class RoomNotFoundError extends Error {
  constructor() {
    super("Room not found");
    this.name = "RoomNotFoundError";
  }
}

async function rpc(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.code === "P0002") throw new RoomNotFoundError();
    throw new Error("Failed to update the room");
  }
  return data;
}

const nameSchema = z.string().trim().min(1).max(100);

export async function renameRoomAs(
  db: SupabaseClient,
  rawRoomId: unknown,
  rawName: unknown,
): Promise<RoomView> {
  const data = await rpc(db, "rename_room", {
    p_room_id: roomIdSchema.parse(rawRoomId),
    p_name: nameSchema.parse(rawName),
  });
  return toRoomView(roomRowSchema.parse(data));
}

export async function archiveRoomAs(
  db: SupabaseClient,
  rawRoomId: unknown,
  archived: boolean,
): Promise<RoomView> {
  const data = await rpc(db, "archive_room", {
    p_room_id: roomIdSchema.parse(rawRoomId),
    p_archived: z.boolean().parse(archived),
  });
  return toRoomView(roomRowSchema.parse(data));
}

export async function deleteRoomAs(db: SupabaseClient, rawRoomId: unknown): Promise<void> {
  await rpc(db, "delete_room", { p_room_id: roomIdSchema.parse(rawRoomId) });
}

export const roomPolicyInputSchema = z
  .object({
    parallelAgents: z
      .number()
      .int()
      .min(TEAM_LIMITS.parallelAgents.min)
      .max(TEAM_LIMITS.parallelAgents.max)
      .optional(),
    maxPlanningRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.planningRounds.min)
      .max(TEAM_LIMITS.planningRounds.max)
      .optional(),
    maxReviewRounds: z
      .number()
      .int()
      .min(TEAM_LIMITS.reviewRounds.min)
      .max(TEAM_LIMITS.reviewRounds.max)
      .optional(),
    usagePolicy: z.enum(USAGE_POLICIES).optional(),
    crossReview: z.boolean().optional(),
    finalInspection: z.boolean().optional(),
    verifyCommands: verifyCommandsSchema.optional(),
  })
  .strict();

export async function updateRoomPolicyAs(
  db: SupabaseClient,
  rawRoomId: unknown,
  rawPolicy: unknown,
): Promise<RoomView> {
  const p = roomPolicyInputSchema.parse(rawPolicy);
  const data = await rpc(db, "update_room_policy", {
    p_room_id: roomIdSchema.parse(rawRoomId),
    p_parallel_agents: p.parallelAgents ?? null,
    p_max_planning_rounds: p.maxPlanningRounds ?? null,
    p_max_review_rounds: p.maxReviewRounds ?? null,
    p_usage_policy: p.usagePolicy ?? null,
    p_cross_review: p.crossReview ?? null,
    p_final_inspection: p.finalInspection ?? null,
    p_verify_commands: p.verifyCommands ?? null,
  });
  return toRoomView(roomRowSchema.parse(data));
}

/** 0.10 (section 6): the step kinds a project may set a timeout for, in minutes (2-120). */
export const STEP_KINDS = [
  "normalise",
  "plan",
  "plan_review",
  "build",
  "review",
  "security_review",
  "inspection",
  "verify",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const stepTimeoutsSchema = z
  .partialRecord(z.enum(STEP_KINDS), z.number().int().min(2).max(120))
  .refine((v) => Object.keys(v).length <= STEP_KINDS.length, "too many");

/**
 * Replaces the project's step timeouts ({} = the Runtime's defaults). Only
 * jobs started afterwards carry them (the carrier's `timeouts`).
 */
export async function setRoomStepTimeoutsAs(
  db: SupabaseClient,
  rawRoomId: unknown,
  rawTimeouts: unknown,
): Promise<Partial<Record<StepKind, number>>> {
  const timeouts = stepTimeoutsSchema.parse(rawTimeouts);
  const data = await rpc(db, "set_room_step_timeouts", {
    p_room_id: roomIdSchema.parse(rawRoomId),
    p_timeouts: timeouts,
  });
  return z.object({ step_timeouts: stepTimeoutsSchema }).passthrough().parse(data).step_timeouts;
}
