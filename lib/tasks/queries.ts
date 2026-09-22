import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import { idPattern } from "@/lib/ids";

import { FAILURE_REASONS, PRIORITY_PATTERN, TASK_STATUSES, type FailureReason } from "./model";

/**
 * Dashboard read of recent task history. USER-SCOPED client (RLS) and an
 * owner re-check. Metadata only: task content is not loaded here.
 */
const recentTaskSchema = z.object({
  id: z.string().regex(idPattern("task")),
  owner_user_id: z.string(),
  origin_session_id: z.string().regex(idPattern("sessionBinding")),
  target_session_id: z.string().regex(idPattern("sessionBinding")),
  status: z.enum(TASK_STATUSES),
  priority: z.string().regex(PRIORITY_PATTERN),
  title: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  failure_reason: z.enum(FAILURE_REASONS).nullable(),
});

export type RecentTask = {
  taskId: string;
  originSessionId: string;
  targetSessionId: string;
  status: (typeof TASK_STATUSES)[number];
  priority: string;
  title: string;
  createdAt: string;
  finishedAt: string | null;
  failureReason: FailureReason | null;
};

export async function listRecentTasks(
  db: SupabaseClient,
  user: ThreadLinkUser,
  limit = 20,
): Promise<RecentTask[]> {
  const { data, error } = await db
    .from("tasks")
    .select(
      "id, owner_user_id, origin_session_id, target_session_id, status, priority, title, created_at, completed_at, failed_at, cancelled_at, failure_reason",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Failed to load tasks");
  const rows = z.array(recentTaskSchema).parse(data);
  if (rows.some((row) => row.owner_user_id !== user.id)) throw new OwnershipViolationError();
  return rows.map((row) => ({
    taskId: row.id,
    originSessionId: row.origin_session_id,
    targetSessionId: row.target_session_id,
    status: row.status,
    priority: row.priority,
    title: row.title,
    createdAt: row.created_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.cancelled_at,
    failureReason: row.failure_reason,
  }));
}
