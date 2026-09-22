import { z } from "zod";

import { sessionIdSchema } from "@/lib/sessions/model";
import {
  agentTaskInputSchema,
  completeInputSchema,
  createTaskInputSchema,
  failInputSchema,
  progressInputSchema,
  taskEnvelopeSchema,
  taskIdSchema,
  taskResultSchema,
  toTaskEnvelope,
  toTaskResult,
  type TaskEnvelope,
  type TaskResult,
} from "@/lib/tasks/model";

import { call, validate, type ClientDatabase } from "./operations";

/**
 * Task routing operations (connection-authenticated). The caller identifies
 * only its own session, the link (controller) or the task (agent); the
 * database resolves and re-validates the full route on every call:
 *   origin tlses_ -> active tllnk_ -> target tlses_ -> target connection.
 */

const parseEnvelope = (data: unknown): TaskEnvelope =>
  toTaskEnvelope(taskEnvelopeSchema.parse(data));

export type ClaimedTask = TaskEnvelope & { claimRef: string | null };

const parseClaimed = (data: unknown): ClaimedTask => {
  const row = taskEnvelopeSchema.parse(data);
  return { ...toTaskEnvelope(row), claimRef: row.claim_ref ?? null };
};

export async function createTask(
  db: ClientDatabase,
  credentialHash: string,
  rawInput: unknown,
): Promise<{ task: TaskEnvelope; created: boolean }> {
  const input = validate(createTaskInputSchema, rawInput);
  const row = await call(
    db,
    "create_task",
    {
      p_token_hash: credentialHash,
      p_origin_session_id: input.originSessionId,
      p_thread_link_id: input.threadLinkId,
      p_title: input.title,
      p_content: input.content,
      p_priority: input.priority ?? "C",
      p_task_type: input.taskType ?? "general",
      p_idempotency_key: input.idempotencyKey ?? null,
      p_expires_in_seconds: input.expiresInSeconds ?? null,
    },
    (data) => taskEnvelopeSchema.parse(data),
  );
  return { task: toTaskEnvelope(row), created: row.created === true };
}

export async function listInbox(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
  limit?: unknown,
): Promise<ClaimedTask[]> {
  const id = validate(sessionIdSchema, sessionId);
  const n = limit === null || limit === undefined ? 20 : Number(limit);
  const parsedLimit = validate(z.number().int().min(1).max(50), n);
  return call(
    db,
    "list_inbox",
    { p_token_hash: credentialHash, p_session_id: id, p_limit: parsedLimit },
    (data) => z.array(z.unknown()).parse(data).map(parseClaimed),
  );
}

type AgentStep = "claim_task" | "start_task" | "renew_task_lease";

async function agentStep(
  fn: AgentStep,
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  rawInput: unknown,
): Promise<ClaimedTask> {
  const id = validate(taskIdSchema, taskId);
  const { sessionId, claimRef } = validate(agentTaskInputSchema, rawInput);
  return call(
    db,
    fn,
    { p_token_hash: credentialHash, p_session_id: sessionId, p_task_id: id, p_claim_ref: claimRef },
    parseClaimed,
  );
}

export const claimTask = (db: ClientDatabase, hash: string, taskId: unknown, input: unknown) =>
  agentStep("claim_task", db, hash, taskId, input);

export const startTask = (db: ClientDatabase, hash: string, taskId: unknown, input: unknown) =>
  agentStep("start_task", db, hash, taskId, input);

/** Heartbeat: the claiming worker renews its lease (5 minutes from now). */
export const renewTaskLease = (db: ClientDatabase, hash: string, taskId: unknown, input: unknown) =>
  agentStep("renew_task_lease", db, hash, taskId, input);

/** The controller session's own recent tasks (metadata only, newest first). */
export async function listOriginTasks(
  db: ClientDatabase,
  credentialHash: string,
  sessionId: unknown,
  limit?: unknown,
): Promise<TaskEnvelope[]> {
  const id = validate(sessionIdSchema, sessionId);
  const n = limit === null || limit === undefined ? 20 : Number(limit);
  const parsedLimit = validate(z.number().int().min(1).max(50), n);
  return call(
    db,
    "list_origin_tasks",
    { p_token_hash: credentialHash, p_session_id: id, p_limit: parsedLimit },
    (data) => z.array(z.unknown()).parse(data).map(parseEnvelope),
  );
}

export async function reportProgress(
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  rawInput: unknown,
): Promise<{ messageId: string; taskId: string; status: string }> {
  const id = validate(taskIdSchema, taskId);
  const input = validate(progressInputSchema, rawInput);
  return call(
    db,
    "report_progress",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_task_id: id,
      p_claim_ref: input.claimRef,
      p_content: input.content,
    },
    (data) => {
      const row = z
        .object({ message_id: z.string(), task_id: z.string(), status: z.string() })
        .parse(data);
      return { messageId: row.message_id, taskId: row.task_id, status: row.status };
    },
  );
}

export async function completeTask(
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  rawInput: unknown,
): Promise<TaskEnvelope> {
  const id = validate(taskIdSchema, taskId);
  const input = validate(completeInputSchema, rawInput);
  return call(
    db,
    "complete_task",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_task_id: id,
      p_claim_ref: input.claimRef,
      p_result: input.result,
      p_artifacts: (input.artifacts ?? []).map((a) => ({
        type: a.type,
        reference: a.reference,
        metadata: a.metadata ?? {},
      })),
    },
    parseEnvelope,
  );
}

export async function failTask(
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  rawInput: unknown,
): Promise<TaskEnvelope> {
  const id = validate(taskIdSchema, taskId);
  const input = validate(failInputSchema, rawInput);
  return call(
    db,
    "fail_task",
    {
      p_token_hash: credentialHash,
      p_session_id: input.sessionId,
      p_task_id: id,
      p_claim_ref: input.claimRef,
      p_error: input.error,
    },
    parseEnvelope,
  );
}

export async function getTask(
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  sessionId: unknown,
): Promise<TaskEnvelope> {
  const id = validate(taskIdSchema, taskId);
  const session = validate(sessionIdSchema, sessionId);
  return call(
    db,
    "get_task",
    { p_token_hash: credentialHash, p_session_id: session, p_task_id: id },
    parseEnvelope,
  );
}

/** Result path: only the originating controller session may read it. */
export async function getTaskResult(
  db: ClientDatabase,
  credentialHash: string,
  taskId: unknown,
  sessionId: unknown,
): Promise<TaskResult> {
  const id = validate(taskIdSchema, taskId);
  const session = validate(sessionIdSchema, sessionId);
  return call(
    db,
    "get_task_result",
    { p_token_hash: credentialHash, p_session_id: session, p_task_id: id },
    (data) => toTaskResult(taskResultSchema.parse(data)),
  );
}
