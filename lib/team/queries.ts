import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import { sessionIdSchema } from "@/lib/sessions/model";

import {
  AGENT_PROVIDERS,
  decisionLabel,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  JOB_STATUSES,
  JOB_VERDICTS,
  jobIdSchema,
  MODEL_CLASSES,
  NODE_STATUSES,
  roomIdSchema,
  TERMINAL_JOB_STATUSES,
  type AgentProvider,
  type JobStatus,
  type JobVerdict,
  type NodeStatus,
} from "./model";

/**
 * Dashboard reads of team jobs in human-friendly shapes: provider names,
 * status labels, "round 2 of 3", "TL-00042". USER-SCOPED client (RLS) plus an
 * owner re-check on every row. IDs appear only as action handles.
 */

export const PROVIDER_NAMES: Record<AgentProvider, string> = {
  "claude-code": "Claude",
  codex: "Codex",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Waiting for the Runtime",
  normalising: "Understanding the goal",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  integrating: "Integrating",
  inspecting: "Final inspection",
  completed: "Passed",
  needs_fix: "Needs fixes",
  blocked: "Blocked",
  needs_user_decision: "Needs your decision",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const NODE_STATUS_LABELS: Record<NodeStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "In progress",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  integrated: "Integrated",
  failed: "Failed",
  skipped: "Skipped",
};

const owned = z.object({ owner_user_id: z.string() });
const jobRow = owned.extend({
  id: z.string(),
  room_id: z.string(),
  goal: z.string(),
  status: z.enum(JOB_STATUSES),
  status_line: z.string().nullable(),
  summary: z.string().nullable(),
  verdict: z.enum(JOB_VERDICTS).nullable(),
  planning_round: z.number(),
  max_planning_rounds: z.number(),
  review_round: z.number(),
  max_review_rounds: z.number(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
const nodeRow = owned.extend({
  node_key: z.string(),
  title: z.string(),
  owner_provider: z.enum(AGENT_PROVIDERS),
  reviewer_provider: z.enum(AGENT_PROVIDERS).nullable(),
  status: z.enum(NODE_STATUSES),
  authorship: z.enum(["single", "mixed"]),
  depends_on: z.array(z.string()),
});
const findingRow = owned.extend({
  severity: z.enum(FINDING_SEVERITIES),
  category: z.enum(FINDING_CATEGORIES),
  status: z.enum(FINDING_STATUSES),
  title: z.string(),
  raised_by: z.string(),
  raised_round: z.number(),
});
const decisionRow = owned.extend({
  number: z.number(),
  title: z.string(),
  resolution: z.string().nullable(),
  requires_user: z.boolean(),
  created_at: z.string(),
});
const usageRow = owned.extend({
  provider: z.enum(AGENT_PROVIDERS),
  role: z.string(),
  requested_model: z.string(),
  observed_model: z.string().nullable(),
  model_class: z.enum(MODEL_CLASSES),
  reason: z.string(),
  outcome: z.string(),
  created_at: z.string(),
});

function assertOwned(user: ThreadLinkUser, rows: { owner_user_id: string }[]) {
  if (rows.some((r) => r.owner_user_id !== user.id)) throw new OwnershipViolationError();
}

export type OwnerJobSummary = {
  jobId: string;
  goal: string;
  status: JobStatus;
  statusLabel: string;
  line: string | null;
  verdict: JobVerdict | null;
  finished: boolean;
  planning: string;
  review: string;
  startedAt: string;
  finishedAt: string | null;
};

const roundText = (n: number, max: number) => `Round ${n} of ${max}`;

function toSummary(j: z.infer<typeof jobRow>): OwnerJobSummary {
  return {
    jobId: j.id,
    goal: j.goal.slice(0, 200),
    status: j.status,
    statusLabel: JOB_STATUS_LABELS[j.status],
    line: j.status_line,
    verdict: j.verdict,
    finished: (TERMINAL_JOB_STATUSES as readonly string[]).includes(j.status),
    planning: roundText(j.planning_round, j.max_planning_rounds),
    review: roundText(j.review_round, j.max_review_rounds),
    startedAt: j.created_at,
    finishedAt: j.finished_at,
  };
}

const JOB_COLUMNS =
  "id, owner_user_id, room_id, goal, status, status_line, summary, verdict, planning_round, " +
  "max_planning_rounds, review_round, max_review_rounds, created_at, finished_at";

export async function listRoomJobsFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawRoomId: unknown,
): Promise<OwnerJobSummary[]> {
  const roomId = roomIdSchema.parse(rawRoomId);
  const { data, error } = await db
    .from("team_jobs")
    .select(JOB_COLUMNS)
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Failed to load team jobs");
  const rows = z.array(jobRow).parse(data);
  assertOwned(user, rows);
  return rows.map(toSummary);
}

export type OwnerJobDetail = OwnerJobSummary & {
  summary: string | null;
  nodes: {
    key: string;
    title: string;
    owner: string;
    reviewer: string | null;
    status: NodeStatus;
    statusLabel: string;
    mixedAuthorship: boolean;
    dependsOn: string[];
  }[];
  findings: {
    open: { blocking: number; important: number; nonBlocking: number };
    recent: {
      title: string;
      severity: string;
      category: string;
      status: string;
      raisedBy: string;
    }[];
  };
  decisions: { label: string; title: string; resolution: string | null; needsYou: boolean }[];
  modelRuns: {
    provider: string;
    role: string;
    requested: string;
    observed: string | null;
    matched: boolean;
    modelClass: string;
    reason: string;
    outcome: string;
    at: string;
  }[];
};

export async function getJobDetailFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
  rawJobId: unknown,
): Promise<OwnerJobDetail | null> {
  const jobId = jobIdSchema.parse(rawJobId);
  const job = await db.from("team_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (job.error) throw new Error("Failed to load the team job");
  if (!job.data) return null;
  const j = jobRow.parse(job.data);
  assertOwned(user, [j]);

  const [nodes, findings, decisions, usage] = await Promise.all([
    db
      .from("team_nodes")
      .select(
        "owner_user_id, node_key, title, owner_provider, reviewer_provider, status, authorship, depends_on",
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: true })
      .limit(100),
    db
      .from("team_findings")
      .select("owner_user_id, severity, category, status, title, raised_by, raised_round")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(200),
    db
      .from("team_decisions")
      .select("owner_user_id, number, title, resolution, requires_user, created_at")
      .eq("job_id", jobId)
      .order("number", { ascending: true })
      .limit(100),
    db
      .from("model_usage_events")
      .select(
        "owner_user_id, provider, role, requested_model, observed_model, model_class, reason, outcome, created_at",
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (nodes.error || findings.error || decisions.error || usage.error) {
    throw new Error("Failed to load the team job");
  }
  const n = z.array(nodeRow).parse(nodes.data);
  const f = z.array(findingRow).parse(findings.data);
  const d = z.array(decisionRow).parse(decisions.data);
  const u = z.array(usageRow).parse(usage.data);
  assertOwned(user, [...n, ...f, ...d, ...u]);

  const open = f.filter((x) => x.status === "open");
  const name = (p: string | null) =>
    p === null ? null : (PROVIDER_NAMES[p as AgentProvider] ?? "ThreadLink");
  return {
    ...toSummary(j),
    summary: j.summary,
    nodes: n.map((x) => ({
      key: x.node_key,
      title: x.title,
      owner: PROVIDER_NAMES[x.owner_provider],
      reviewer: name(x.reviewer_provider),
      status: x.status,
      statusLabel: NODE_STATUS_LABELS[x.status],
      mixedAuthorship: x.authorship === "mixed",
      dependsOn: x.depends_on,
    })),
    findings: {
      open: {
        blocking: open.filter((x) => x.severity === "blocking").length,
        important: open.filter((x) => x.severity === "important").length,
        nonBlocking: open.filter((x) => x.severity === "non_blocking").length,
      },
      recent: f.slice(0, 20).map((x) => ({
        title: x.title,
        severity: x.severity,
        category: x.category,
        status: x.status,
        raisedBy: name(x.raised_by) ?? "ThreadLink",
      })),
    },
    decisions: d.map((x) => ({
      label: decisionLabel(x.number),
      title: x.title,
      resolution: x.resolution,
      needsYou: x.requires_user && x.resolution === null,
    })),
    modelRuns: u.map((x) => ({
      provider: PROVIDER_NAMES[x.provider],
      role: x.role,
      requested: x.requested_model,
      observed: x.observed_model,
      matched: x.observed_model === null || x.observed_model === x.requested_model,
      modelClass: x.model_class,
      reason: x.reason,
      outcome: x.outcome,
      at: x.created_at,
    })),
  };
}

/**
 * Owner action: "Remove from ThreadLink".
 *
 * Retires the conversation's session binding, which revokes its links (and so
 * cancels their open tasks) through the same cascade a client's own
 * retire_session uses. It does NOT delete the provider's native conversation
 * history: ThreadLink never had it and cannot touch it. Idempotent.
 */

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "ConversationNotFoundError";
  }
}

const resultSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  links_revoked: z.number(),
  native_history_deleted: z.literal(false),
});

export type RemovedConversation = { status: string; linksRevoked: number };

export async function removeConversationAs(
  db: SupabaseClient,
  rawSessionId: unknown,
): Promise<RemovedConversation> {
  const { data, error } = await db.rpc("remove_conversation", {
    p_session_id: sessionIdSchema.parse(rawSessionId),
  });
  if (error) {
    if (error.code === "P0002") throw new ConversationNotFoundError();
    throw new Error("Failed to remove the conversation");
  }
  const r = resultSchema.parse(data);
  return { status: r.status, linksRevoked: r.links_revoked };
}
