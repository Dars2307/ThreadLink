import type { Metadata } from "next";
import Link from "next/link";

import {
  archiveProjectAction,
  deleteProjectAction,
  renameProjectAction,
} from "@/app/dashboard/team-actions";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { ProjectPolicyForm } from "@/components/dashboard/project-settings";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, EmptyState } from "@/components/ui";
import { chatCounts, chatCountText } from "@/lib/dashboard/chats";
import { loadChats } from "@/lib/dashboard/chats-data";
import { loadTeam } from "@/lib/dashboard/data";
import { deriveProjects } from "@/lib/dashboard/pages";
import { projectHref } from "@/lib/dashboard/project";
import { CONTROLLER_HINT } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Projects · ThreadLink" };

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const showArchived = (await searchParams).archived === "1";
  const [team, chats] = await Promise.all([loadTeam(), loadChats()]);
  const counts = chats ? chatCounts(chats) : null;
  if (!team) return <LoadError what="your projects" />;
  const { view, handles } = deriveProjects(team, team.now, { showArchived });
  const { limits } = view;

  return (
    <Shell>
      <PageHeader
        title="Projects"
        description={`A project is a folder on your computer. Its chats run their work there. Ask ${CONTROLLER_HINT} to “create a ThreadLink project” to add one.`}
        actions={
          view.archivedCount ? (
            <Link
              href={showArchived ? "/dashboard/projects" : "/dashboard/projects?archived=1"}
              className={buttonStyles.ghost}
            >
              {showArchived ? "Hide archived" : `Show archived (${view.archivedCount})`}
            </Link>
          ) : null
        }
      />

      {view.projects.length === 0 ? (
        <Card>
          <EmptyState title="No projects yet">
            Ask {CONTROLLER_HINT} to “create a ThreadLink project for my app”. It appears here with
            its team, and you can open its chat, rename, archive or remove it.
          </EmptyState>
        </Card>
      ) : null}

      {view.projects.map((p) => {
        const roomId = handles[p.key]!.roomId!;
        return (
          <Card key={p.key} as="article" labelledBy={`${p.key}-title`}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={`${p.key}-title`} className="text-base font-semibold tracking-tight">
                    <Link href={projectHref(roomId)} className="hover:underline">
                      {p.name}
                    </Link>
                  </h2>
                  <p className="text-muted text-sm">
                    {counts ? `${chatCountText(counts.get(roomId))} · ` : ""}
                    {p.team} · {p.folder}
                    {p.conversation ? ` · ${p.conversation}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {p.archived ? <Badge tone="neutral">Archived</Badge> : null}
                  <Badge tone={p.tone}>{p.status}</Badge>
                </div>
              </div>

              <p className="text-subtle flex flex-wrap gap-x-3 text-xs">
                <span>{p.summary}</span>
                <span>{p.lastActivity}</span>
              </p>

              {p.recentJobs.length ? (
                <ul className="divide-border border-border flex flex-col divide-y rounded-xl border">
                  {p.recentJobs.map((j) => (
                    <li
                      key={j.key}
                      className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <span className="min-w-0 truncate text-sm">{j.goal}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-subtle text-xs">{j.when}</span>
                        <Badge tone={j.tone}>{j.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <details className="group">
                <summary className="text-muted hover:text-foreground cursor-pointer text-sm">
                  Team settings <span className="text-subtle">· {p.policy.text}</span>
                </summary>
                <ProjectPolicyForm
                  roomId={roomId}
                  policy={p.policy}
                  limits={limits}
                  usagePolicies={view.usagePolicies}
                />
              </details>

              <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
                <details className="group">
                  <summary className={`${buttonStyles.ghost} cursor-pointer`}>Rename</summary>
                  <ActionForm
                    action={renameProjectAction}
                    className="bg-surface-muted mt-2 flex flex-wrap items-end gap-2 rounded-xl p-3"
                    statusClassName="w-full"
                  >
                    <input type="hidden" name="roomId" value={roomId} />
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-subtle text-xs">New name</span>
                      <input
                        key={p.name}
                        name="name"
                        defaultValue={p.name}
                        required
                        maxLength={100}
                        className={field}
                      />
                    </label>
                    <SubmitButton>Save</SubmitButton>
                  </ActionForm>
                </details>

                <ActionForm action={archiveProjectAction} className="flex flex-col gap-1">
                  <input type="hidden" name="roomId" value={roomId} />
                  <input type="hidden" name="archived" value={p.archived ? "false" : "true"} />
                  <SubmitButton className={buttonStyles.ghost} pendingLabel="Working…">
                    {p.archived ? "Restore" : "Archive"}
                  </SubmitButton>
                </ActionForm>

                <Link href={projectHref(roomId)} className={buttonStyles.ghost}>
                  Open project
                </Link>

                <ConfirmAction
                  action={deleteProjectAction}
                  fields={{ roomId }}
                  label="Delete"
                  title={`Delete ${p.name}?`}
                  confirmLabel="Delete project"
                >
                  <p>
                    This removes the project from ThreadLink and stops any team work still running
                    in it.
                  </p>
                  <p className="text-foreground font-medium">
                    It never deletes files in your repository.
                  </p>
                  <p>To keep its history instead, choose Archive.</p>
                </ConfirmAction>
              </div>
            </div>
          </Card>
        );
      })}
    </Shell>
  );
}
