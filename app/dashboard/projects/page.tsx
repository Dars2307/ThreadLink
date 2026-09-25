import type { Metadata } from "next";
import Link from "next/link";

import {
  archiveProjectAction,
  deleteProjectAction,
  renameProjectAction,
  updateProjectPolicyAction,
} from "@/app/dashboard/team-actions";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, EmptyState } from "@/components/ui";
import { loadTeam } from "@/lib/dashboard/data";
import { deriveProjects } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Projects · ThreadLink" };

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const showArchived = (await searchParams).archived === "1";
  const team = await loadTeam();
  if (!team) return <LoadError what="your projects" />;
  const { view, handles } = deriveProjects(team, team.now, { showArchived });
  const { limits } = view;

  return (
    <Shell>
      <PageHeader
        title="Projects"
        description="A project is a folder on your computer that Claude and Codex work on together. Ask ChatGPT to “create a ThreadLink project” to add one."
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
            In ChatGPT, say “Create a ThreadLink project for my app”. It appears here with its team,
            and you can rename, archive or remove it.
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
                    {p.name}
                  </h2>
                  <p className="text-muted text-sm">
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
                      <Link
                        href={`/dashboard/team/${handles[j.key]!.jobId}`}
                        className="min-w-0 truncate text-sm hover:underline"
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
              ) : null}

              <details className="group">
                <summary className="text-muted hover:text-foreground cursor-pointer text-sm">
                  Team settings <span className="text-subtle">· {p.policy.text}</span>
                </summary>
                <form
                  action={updateProjectPolicyAction}
                  className="bg-surface-muted mt-3 grid gap-3 rounded-xl p-4 sm:grid-cols-2"
                >
                  <input type="hidden" name="roomId" value={roomId} />
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-subtle text-xs">Agents working at once</span>
                    <select
                      name="parallelAgents"
                      defaultValue={p.policy.parallelAgents}
                      className={field}
                    >
                      {range(limits.parallelAgents.min, limits.parallelAgents.max).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-subtle text-xs">Usage policy</span>
                    <select
                      name="usagePolicy"
                      defaultValue={p.policy.usagePolicy}
                      className={field}
                    >
                      {view.usagePolicies.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-subtle text-xs">Planning rounds (at most)</span>
                    <select
                      name="maxPlanningRounds"
                      defaultValue={p.policy.maxPlanningRounds}
                      className={field}
                    >
                      {range(limits.planningRounds.min, limits.planningRounds.max).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-subtle text-xs">Review rounds (at most)</span>
                    <select
                      name="maxReviewRounds"
                      defaultValue={p.policy.maxReviewRounds}
                      className={field}
                    >
                      {range(limits.reviewRounds.min, limits.reviewRounds.max).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-subtle text-xs sm:col-span-2">
                    Applies to new team work in this project. When the rounds run out, the team
                    stops and asks you rather than passing work that is not ready.
                  </p>
                  <button type="submit" className={`${buttonStyles.secondary} w-fit`}>
                    Save team settings
                  </button>
                </form>
              </details>

              <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
                <details className="group">
                  <summary className={`${buttonStyles.ghost} cursor-pointer`}>Rename</summary>
                  <form
                    action={renameProjectAction}
                    className="bg-surface-muted mt-2 flex flex-wrap items-end gap-2 rounded-xl p-3"
                  >
                    <input type="hidden" name="roomId" value={roomId} />
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-subtle text-xs">New name</span>
                      <input
                        name="name"
                        defaultValue={p.name}
                        required
                        maxLength={100}
                        className={field}
                      />
                    </label>
                    <button type="submit" className={buttonStyles.secondary}>
                      Save
                    </button>
                  </form>
                </details>

                <form action={archiveProjectAction}>
                  <input type="hidden" name="roomId" value={roomId} />
                  <input type="hidden" name="archived" value={p.archived ? "false" : "true"} />
                  <button type="submit" className={buttonStyles.ghost}>
                    {p.archived ? "Restore" : "Archive"}
                  </button>
                </form>

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
