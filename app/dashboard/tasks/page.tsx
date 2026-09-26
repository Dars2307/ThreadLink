import type { Metadata } from "next";
import Link from "next/link";

import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { deriveTasks, EMPTY_TEAM } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Tasks · ThreadLink" };

export default async function TasksPage() {
  const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
  if (!account) return <LoadError what="your tasks" />;
  const { view, handles } = deriveTasks(account, team ?? EMPTY_TEAM);

  return (
    <Shell>
      <PageHeader
        title="Tasks"
        description="Work sent from your chats, newest first. Only titles and statuses are kept here, never the content."
        badge={view.running ? `${view.running} running` : undefined}
        tone="accent"
      />

      {view.teamJobs.length ? (
        <Card labelledBy="team-tasks">
          <CardTitle
            id="team-tasks"
            action={
              <Link href="/dashboard/chats" className="text-accent text-sm">
                Chats
              </Link>
            }
          >
            Team work
          </CardTitle>
          <ul className="divide-border flex flex-col divide-y">
            {view.teamJobs.map((j) => (
              <li
                key={j.key}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <Link
                  href={`/dashboard/team/${handles[j.key]!.jobId}`}
                  className="min-w-0 hover:underline"
                >
                  <span className="block truncate text-sm font-medium">{j.goal}</span>
                  <span className="text-muted block text-xs">
                    {j.project} · {j.when}
                  </span>
                </Link>
                <Badge tone={j.tone}>{j.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card labelledBy="recent-tasks">
        <CardTitle id="recent-tasks">Recent tasks</CardTitle>
        {view.tasks.length === 0 ? (
          <EmptyState title="Nothing sent yet">
            Say “send this to Claude” in a linked conversation in your controller (for example
            ChatGPT), or open a project and type <strong>@Claude</strong> and a task.
          </EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.tasks.map((t) => (
              <li
                key={t.key}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="text-muted text-xs">
                    {t.route} · {t.when}
                  </p>
                </div>
                <Badge tone={t.tone}>{t.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {view.byConversation.length ? (
        <Card labelledBy="by-conversation">
          <CardTitle id="by-conversation" description="What ran in each linked conversation.">
            By conversation
          </CardTitle>
          <ul className="flex flex-col gap-4">
            {view.byConversation.map((g) => (
              <li key={g.key} className="border-border rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{g.conversation}</p>
                    <p className="text-muted text-xs">{g.attribution}</p>
                  </div>
                  <Badge tone="neutral">{g.mode}</Badge>
                </div>
                {g.tasks.length === 0 ? (
                  <p className="text-muted pt-3 text-xs">{g.emptyHint}</p>
                ) : (
                  <ul className="divide-border border-border mt-3 flex flex-col divide-y border-t pt-1">
                    {g.tasks.map((t) => (
                      <li
                        key={t.key}
                        className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <span className="min-w-0 truncate text-sm">{t.title}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-subtle text-xs">{t.when}</span>
                          <Badge tone={t.tone}>{t.status}</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {g.more ? (
                  <p className="text-subtle pt-2 text-xs">{g.more} more in this conversation</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Shell>
  );
}
