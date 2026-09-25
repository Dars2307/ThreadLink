import type { Metadata } from "next";

import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { TeamJob } from "@/components/dashboard/team";
import { Card, CardTitle, EmptyState } from "@/components/ui";
import { loadTeam } from "@/lib/dashboard/data";
import { deriveTeam } from "@/lib/dashboard/pages";
import { projectHref } from "@/lib/dashboard/project";
import { CONTROLLER_HINT } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Team · ThreadLink" };

export default async function TeamPage() {
  const team = await loadTeam();
  if (!team) return <LoadError what="your team" />;
  const { view, handles } = deriveTeam(team, team.now);
  const logHref = (key: string) => {
    const h = handles[key]!;
    return h.roomId ? projectHref(h.roomId, { tab: "chat", job: h.jobId }) : null;
  };

  return (
    <Shell>
      <PageHeader
        title="Team"
        description="Claude and Codex plan, build and review each other's work. Every change is reviewed by the other agent, and nothing passes while a blocking finding is open."
      />

      {view.empty ? (
        <Card>
          <EmptyState title="No team work yet">
            Open a project and type <strong>@team</strong> and what you want built, or ask{" "}
            {CONTROLLER_HINT} to “start team work” on a project. Progress shows up here.
          </EmptyState>
        </Card>
      ) : null}

      {view.active.length ? (
        <section aria-labelledby="active-team" className="flex flex-col gap-4">
          <h2 id="active-team" className="text-sm font-semibold">
            Working now
          </h2>
          {view.active.map((job) => (
            <TeamJob key={job.key} job={job} logHref={logHref(job.key)} />
          ))}
        </section>
      ) : null}

      {view.recent.length ? (
        <section aria-labelledby="recent-team" className="flex flex-col gap-4">
          <h2 id="recent-team" className="text-sm font-semibold">
            Recent
          </h2>
          {view.recent.map((job) => (
            <TeamJob key={job.key} job={job} logHref={logHref(job.key)} />
          ))}
        </section>
      ) : null}

      <Card labelledBy="team-how">
        <CardTitle id="team-how">How the team works</CardTitle>
        <ul className="text-muted flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>Each agent works in its own git worktree, so their edits don&apos;t collide.</li>
          <li>
            A worktree only separates git changes. It is not a security sandbox: agents run with
            your permissions on your computer.
          </li>
          <li>Review rounds are limited. When they run out, the team stops and asks you.</li>
          <li>Anything about money, security or product direction is left for you to decide.</li>
        </ul>
      </Card>
    </Shell>
  );
}
