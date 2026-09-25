import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyId } from "@/components/dashboard/copy-id";
import { ProjectChat } from "@/components/dashboard/project-chat";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { JobLog } from "@/components/dashboard/team";
import { Badge, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import { listMyChat } from "@/lib/chat/owner";
import { loadProject } from "@/lib/dashboard/data";
import { deriveTeamLog } from "@/lib/dashboard/pages";
import {
  deriveProject,
  parseJobParam,
  parseTab,
  PROJECT_TABS,
  projectHref,
  TAB_LABELS,
} from "@/lib/dashboard/project";

export const metadata: Metadata = { title: "Project · ThreadLink" };

type Search = Record<string, string | string[] | undefined>;

const pageOf = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<Search>;
}) {
  const { roomId } = await params;
  const search = await searchParams;
  const tab = parseTab(search.tab);
  const askedJob = parseJobParam(search.job);

  // A room that is not yours reads exactly like one that does not exist.
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) notFound();
  const data = await loadProject(roomId, askedJob);
  if (!data) notFound();

  const { view, handles, technical, selectedJobId } = deriveProject(
    data.room,
    data.jobs,
    data.detail,
    data.now,
    { job: askedJob },
  );
  const room = handles.room!.roomId!;
  // The first page is rendered here; the chat then polls for newer events.
  // A failure only means the browser loads it instead.
  const initialChat = tab === "chat" ? await listMyChat({ roomId: room }).catch(() => null) : null;
  const tabHref = (t: (typeof PROJECT_TABS)[number]) =>
    projectHref(room, { tab: t, job: askedJob && !view.jobNotFound ? askedJob : null });

  return (
    <Shell>
      <Link href="/dashboard/projects" className="text-accent w-fit text-sm">
        ← Projects
      </Link>
      <PageHeader
        eyebrow={`${view.team} · ${view.folder}${view.conversation ? ` · ${view.conversation}` : ""}`}
        title={view.name}
        badge={view.archived ? "Archived" : view.status}
        tone={view.archived ? "neutral" : view.tone}
        description={view.summary}
      />

      <nav aria-label="Project sections" className="border-border flex gap-1 border-b">
        {PROJECT_TABS.map((t) => (
          <Link
            key={t}
            href={tabHref(t)}
            aria-current={tab === t ? "page" : undefined}
            scroll={false}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              tab === t
                ? "border-accent text-foreground font-medium"
                : "text-muted hover:text-foreground border-transparent",
            )}
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {view.jobNotFound ? (
        <p role="status" className="text-muted text-sm">
          That job isn&apos;t in this project, so the latest one is shown instead.
        </p>
      ) : null}

      {tab === "chat" ? (
        <>
          {askedJob && !view.jobNotFound && selectedJobId ? (
            <p className="text-muted text-sm">
              The chat shows the whole project.{" "}
              <Link
                href={projectHref(room, { tab: "progress", job: selectedJobId })}
                className="text-accent"
              >
                See this job&apos;s progress →
              </Link>
            </p>
          ) : null}
          <ProjectChat
            key={room}
            roomId={room}
            initial={initialChat}
            controller={data.controller}
            twoAgents={view.twoAgents}
            archived={view.archived}
          />
        </>
      ) : null}

      {tab === "progress" ? (
        <div className="flex flex-col gap-6">
          {view.jobs.length > 1 ? (
            <Card labelledBy="jobs-title">
              <CardTitle id="jobs-title" description="Choose a job to see its progress.">
                Jobs in this project
              </CardTitle>
              <ul className="divide-border flex flex-col divide-y">
                {view.jobs.map((j) => (
                  <li
                    key={j.key}
                    className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <Link
                      href={projectHref(room, { tab: "progress", job: handles[j.key]!.jobId })}
                      aria-current={j.selected ? "true" : undefined}
                      scroll={false}
                      className={cx(
                        "min-w-0 truncate text-sm hover:underline",
                        j.selected && "font-semibold",
                      )}
                    >
                      {j.goal}
                    </Link>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-subtle text-xs">{j.when}</span>
                      <Badge tone={j.tone}>{j.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.detail && selectedJobId ? (
            <JobLog
              view={
                deriveTeamLog(data.detail, view.name, data.now, {
                  findings: pageOf(search.f),
                  decisions: pageOf(search.d),
                  models: pageOf(search.m),
                }).view
              }
              base={projectHref(room)}
              search={{
                tab: "progress",
                job: selectedJobId,
                f: search.f,
                d: search.d,
                m: search.m,
              }}
            />
          ) : (
            <Card>
              <EmptyState title="No work yet">
                Start something from the Chat tab (for example{" "}
                <strong>@Claude add a health check</strong>) or ask {data.controller}. Its units,
                reviews, findings and model choices show up here.
              </EmptyState>
            </Card>
          )}
        </div>
      ) : null}

      {tab === "details" ? (
        <Card labelledBy="details-title">
          <CardTitle
            id="details-title"
            description="Technical identifiers, for support and troubleshooting. You never need these for normal use."
          >
            Details
          </CardTitle>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Project (room)</dt>
            <dd className="min-w-0">
              <CopyId value={technical.roomId} label="project ID" />
            </dd>
            {technical.jobs.map((j) => (
              <div key={j.jobId} className="contents">
                <dt className="text-muted min-w-0 truncate" title={j.goal}>
                  Job{j.selected ? " (shown)" : ""} · {j.goal}
                </dt>
                <dd className="min-w-0">
                  <CopyId value={j.jobId} label={`job ID for ${j.goal}`} />
                </dd>
              </div>
            ))}
            {technical.units.map((u) => (
              <div key={u.key} className="contents">
                <dt className="text-muted min-w-0 truncate">Unit · {u.title}</dt>
                <dd className="min-w-0">
                  <CopyId value={u.key} label={`unit key for ${u.title}`} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-subtle pt-4 text-xs">
            Conversation and device IDs are on{" "}
            <Link href="/dashboard/settings/advanced" className="text-accent">
              Settings → Advanced
            </Link>
            .
          </p>
        </Card>
      ) : null}
    </Shell>
  );
}
