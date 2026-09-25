import Link from "next/link";

import { Badge, cx } from "@/components/ui";
import type { AgentLine, GraphLine, TeamJobCard } from "@/lib/dashboard/pages";

const SYMBOL_COLOUR: Record<GraphLine["state"], string> = {
  done: "text-success",
  active: "text-accent",
  waiting: "text-subtle",
  failed: "text-danger",
  skipped: "text-subtle",
};

const STATE_WORDS: Record<GraphLine["state"], string> = {
  done: "done",
  active: "in progress",
  waiting: "not started",
  failed: "stopped",
  skipped: "skipped",
};

/** The job's plan as a small tree: ✓ done, ● in progress, ○ not started. */
export function TaskGraph({ lines }: { lines: GraphLine[] }) {
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Plan">
      {lines.map((l) => (
        <li key={l.key} className="flex min-w-0 items-baseline gap-2">
          {l.branch ? (
            <span aria-hidden className="text-subtle w-5 shrink-0 font-mono text-xs">
              {l.branch}
            </span>
          ) : null}
          <span aria-hidden className={cx("w-3 shrink-0 text-center", SYMBOL_COLOUR[l.state])}>
            {l.symbol}
          </span>
          <span className="min-w-0">
            <span className={cx("font-medium", l.state === "waiting" && "text-muted")}>
              {l.label}
            </span>
            <span className="sr-only"> ({STATE_WORDS[l.state]})</span>
            {l.detail ? <span className="text-muted"> — {l.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AgentList({ agents }: { agents: AgentLine[] }) {
  if (agents.length === 0) {
    return <p className="text-muted text-sm">No agent has started yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {agents.map((a) => (
        <li key={a.key} className="bg-surface-muted/60 flex flex-col gap-0.5 rounded-xl px-3 py-2">
          <span className="text-sm font-medium">{a.line}</span>
          <span className="text-muted text-xs">{a.doing}</span>
          {a.mismatch ? <span className="text-danger text-xs">{a.mismatch}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** One team job: project, goal, verdict, rounds, agents and plan. */
export function TeamJob({ job, logHref }: { job: TeamJobCard; logHref: string | null }) {
  return (
    <article className="border-border bg-surface shadow-card flex flex-col gap-5 rounded-2xl border p-5 sm:p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-subtle text-xs font-medium tracking-wide uppercase">{job.project}</p>
          <Badge tone={job.tone}>{job.status}</Badge>
        </div>
        <h3 className="text-base font-semibold tracking-tight">{job.goal}</h3>
        {job.statusLine && !job.finished ? (
          <p className="text-muted text-sm">{job.statusLine}</p>
        ) : null}
        {job.summary && job.finished ? <p className="text-muted text-sm">{job.summary}</p> : null}
        <p className="text-subtle flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span>{job.started}</span>
          <span>{job.planning}</span>
          <span>{job.review}</span>
          <span className={job.findingsRemaining ? "text-warning" : undefined}>{job.findings}</span>
          {job.decisionsNeedingYou ? (
            <span className="text-warning">
              {job.decisionsNeedingYou === 1
                ? "1 decision needs you"
                : `${job.decisionsNeedingYou} decisions need you`}
            </span>
          ) : null}
        </p>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h4 className="text-subtle text-xs font-medium">Agents</h4>
          {job.hasDetail ? (
            <AgentList agents={job.agents} />
          ) : (
            <p className="text-muted text-sm">Open the full log for details.</p>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="text-subtle text-xs font-medium">Plan</h4>
          <TaskGraph lines={job.graph} />
        </section>
      </div>

      {logHref ? (
        <div className="border-border border-t pt-3">
          <Link href={logHref} className="text-accent text-sm font-medium">
            Full team log →
          </Link>
        </div>
      ) : null}
    </article>
  );
}
