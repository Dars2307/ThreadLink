import "server-only";

import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card } from "@/components/ui";
import { MissionControlFeed } from "@/components/dashboard/mission-control";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";
import { TASK_STATUSES } from "@/lib/tasks/model";
import type { Tone } from "@/components/ui";

type TaskStatus = (typeof TASK_STATUSES)[number];

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
};

function statusTone(status: TaskStatus): Tone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "working" || status === "claimed") return "accent";
  return "neutral";
}

function statusLabel(status: TaskStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ taskId: string }>;
}): Promise<Metadata> {
  const { taskId } = await params;
  return { title: `Task ${taskId.slice(-8)} · ThreadLink` };
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;

  // Auth: requireThreadLinkUser throws (→ redirect) if unauthenticated.
  await requireThreadLinkUser();

  // RLS ensures the user can only read their own tasks. A task that doesn't
  // exist or belongs to someone else both return null here.
  const db = createUserSupabaseClient();
  const { data } = await db
    .from("tasks")
    .select("id, title, status, priority, created_at, completed_at, failed_at, cancelled_at")
    .eq("id", taskId)
    .maybeSingle();

  if (!data) notFound();
  const task = data as TaskRow;

  const finishedAt = task.completed_at ?? task.failed_at ?? task.cancelled_at;

  return (
    <Shell>
      <div className="flex flex-wrap items-start gap-3">
        <Link
          href="/dashboard/tasks"
          className="text-muted hover:text-foreground mt-0.5 text-sm transition-colors"
        >
          ← Tasks
        </Link>
      </div>

      <PageHeader
        title={task.title}
        badge={task.priority}
        tone="neutral"
        description={`Started ${formatDate(task.created_at)}${finishedAt ? ` · Finished ${formatDate(finishedAt)}` : ""}`}
      />

      <Card as="div">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={statusTone(task.status)}>{statusLabel(task.status)}</Badge>
          <span className="text-muted font-mono text-xs">{task.id}</span>
        </div>
      </Card>

      <MissionControlFeed taskId={task.id} />
    </Shell>
  );
}
