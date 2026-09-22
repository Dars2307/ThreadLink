import { z } from "zod";

import { idPattern } from "@/lib/ids";
import { linkIdSchema } from "@/lib/pairing/model";
import { sessionIdSchema } from "@/lib/sessions/model";

/**
 * Tasks, routing messages and artifact references. Mirrors
 * supabase/migrations/*_tasks_and_routing.sql. Limits are checked here first
 * (so oversized requests never reach the database) and again by CHECK constraints.
 */

export const TASK_LIMITS = {
  titleChars: 255,
  contentBytes: 64 * 1024,
  resultBytes: 256 * 1024,
  messageBytes: 64 * 1024,
  artifactsPerTask: 20,
  artifactReferenceChars: 1024,
  artifactMetadataBytes: 4 * 1024,
  /** Request body caps (payload + JSON envelope overhead). */
  createBodyBytes: 80 * 1024,
  completeBodyBytes: 320 * 1024,
  smallBodyBytes: 80 * 1024,
} as const;

export const TASK_STATUSES = [
  "queued",
  "claimed",
  "working",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "expired"] as const;
export const ARTIFACT_TYPES = [
  "git_commit",
  "pull_request",
  "file_path",
  "deployment",
  "test_report",
  "url",
  "other",
] as const;

export const PRIORITY_PATTERN = /^(A[1-3]?|[B-E])$/;
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const boundedText = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((v) => byteLength(v) <= maxBytes, `must be at most ${maxBytes} bytes`);

export const taskIdSchema = z.string().regex(idPattern("task"));
export const claimRefSchema = z.string().regex(REF_PATTERN);

/** Controller request. Target session/connection/owner are never accepted: the link decides. */
export const createTaskInputSchema = z
  .object({
    originSessionId: sessionIdSchema,
    threadLinkId: linkIdSchema,
    title: z.string().trim().min(1).max(TASK_LIMITS.titleChars),
    content: boundedText(TASK_LIMITS.contentBytes),
    priority: z.string().regex(PRIORITY_PATTERN).optional(),
    taskType: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .optional(),
    idempotencyKey: z.string().regex(REF_PATTERN).optional(),
    expiresInSeconds: z.number().int().min(60).max(604_800).optional(),
  })
  .strict();

/** Agent requests: the caller's own agent session plus the worker's claim ref. */
export const agentTaskInputSchema = z
  .object({ sessionId: sessionIdSchema, claimRef: claimRefSchema })
  .strict();

export const progressInputSchema = agentTaskInputSchema
  .extend({ content: boundedText(TASK_LIMITS.messageBytes) })
  .strict();

export const artifactInputSchema = z
  .object({
    type: z.enum(ARTIFACT_TYPES),
    reference: z.string().min(1).max(TASK_LIMITS.artifactReferenceChars),
    metadata: z
      .record(z.string(), z.unknown())
      .refine((m) => byteLength(JSON.stringify(m)) <= TASK_LIMITS.artifactMetadataBytes)
      .optional(),
  })
  .strict();

export const completeInputSchema = agentTaskInputSchema
  .extend({
    result: boundedText(TASK_LIMITS.resultBytes),
    artifacts: z.array(artifactInputSchema).max(TASK_LIMITS.artifactsPerTask).optional(),
  })
  .strict();

export const failInputSchema = agentTaskInputSchema
  .extend({ error: boundedText(TASK_LIMITS.messageBytes) })
  .strict();

// ---------------------------------------------------------------------------
// Database envelopes -> client views
// ---------------------------------------------------------------------------
export const taskEnvelopeSchema = z.object({
  task_id: taskIdSchema,
  message_id: z.string().regex(idPattern("message")).nullable(),
  thread_link_id: linkIdSchema,
  origin_session_id: sessionIdSchema,
  target_session_id: sessionIdSchema,
  type: z.literal("task"),
  task_type: z.string(),
  priority: z.string().regex(PRIORITY_PATTERN),
  title: z.string(),
  content: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  cancel_reason: z.enum(["link_revoked", "route_invalid"]).nullable(),
  created_at: z.string(),
  claimed_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  expired_at: z.string().nullable(),
  expires_at: z.string(),
  created: z.boolean().optional(),
  claim_ref: z.string().nullable().optional(),
});

export const taskResultSchema = taskEnvelopeSchema.extend({
  result: z.string().nullable(),
  error: z.string().nullable(),
  progress: z.array(
    z.object({ message_id: z.string(), content: z.string(), created_at: z.string() }),
  ),
  artifacts: z.array(
    z.object({
      artifact_id: z.string().regex(idPattern("artifact")),
      type: z.enum(ARTIFACT_TYPES),
      reference: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
});

export type TaskEnvelope = {
  taskId: string;
  messageId: string | null;
  threadLinkId: string;
  originSessionId: string;
  targetSessionId: string;
  type: "task";
  taskType: string;
  priority: string;
  title: string;
  content: string | null;
  status: (typeof TASK_STATUSES)[number];
  cancelReason: "link_revoked" | "route_invalid" | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  expiresAt: string;
};

export function toTaskEnvelope(row: z.infer<typeof taskEnvelopeSchema>): TaskEnvelope {
  return {
    taskId: row.task_id,
    messageId: row.message_id,
    threadLinkId: row.thread_link_id,
    originSessionId: row.origin_session_id,
    targetSessionId: row.target_session_id,
    type: row.type,
    taskType: row.task_type,
    priority: row.priority,
    title: row.title,
    content: row.content,
    status: row.status,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    expiresAt: row.expires_at,
  };
}

export type TaskResult = TaskEnvelope & {
  result: string | null;
  error: string | null;
  progress: { messageId: string; content: string; createdAt: string }[];
  artifacts: {
    artifactId: string;
    type: (typeof ARTIFACT_TYPES)[number];
    reference: string;
    metadata: Record<string, unknown>;
  }[];
};

export function toTaskResult(row: z.infer<typeof taskResultSchema>): TaskResult {
  return {
    ...toTaskEnvelope(row),
    result: row.result,
    error: row.error,
    progress: row.progress.map((p) => ({
      messageId: p.message_id,
      content: p.content,
      createdAt: p.created_at,
    })),
    artifacts: row.artifacts.map((a) => ({
      artifactId: a.artifact_id,
      type: a.type,
      reference: a.reference,
      metadata: a.metadata,
    })),
  };
}
