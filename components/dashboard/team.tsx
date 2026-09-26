import Link from "next/link";

import { Badge, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import type { AgentLine, GraphLine, Page, TeamJobCard, TeamLogView } from "@/lib/dashboard/pages";

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

/** The job's stages (units under Build): ✓ done, ● in progress, ✕ stopped, ○ not started, – not reached. */
export function TaskGraph({ lines }: { lines: GraphLine[] }) {
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Progress">
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
            Open in project →
          </Link>
        </div>
      ) : null}
    </article>
  );
}

type Search = Record<string, string | string[] | undefined>;

/** Previous / next links for one section, keeping every other query parameter. */
function Pager({
  page,
  param,
  search,
  base,
}: {
  page: Page<unknown>;
  param: string;
  search: Search;
  base: string;
}) {
  if (page.pageCount <= 1) return null;
  const href = (n: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) if (typeof v === "string") q.set(k, v);
    q.set(param, String(n));
    return `${base}?${q.toString()}`;
  };
  const link = "text-accent text-sm";
  return (
    <nav className="flex items-center justify-between pt-3 text-sm" aria-label="Pages">
      {page.page > 1 ? (
        <Link href={href(page.page - 1)} className={link} scroll={false}>
          ← Newer
        </Link>
      ) : (
        <span />
      )}
      <span className="text-subtle text-xs">
        Page {page.page} of {page.pageCount} · {page.total} total
      </span>
      {page.page < page.pageCount ? (
        <Link href={href(page.page + 1)} className={link} scroll={false}>
          Older →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/**
 * One job in full: status, agents, plan (units), findings, decisions and the
 * model each step used (with a mismatch flag and why it was chosen).
 */
export function JobLog({
  view,
  base,
  search,
}: {
  view: TeamLogView;
  base: string;
  search: Search;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight">
              {view.goal.length > 160 ? `${view.goal.slice(0, 159)}…` : view.goal}
            </h2>
            <Badge tone={view.tone}>{view.status}</Badge>
          </div>
          <p className="text-subtle flex flex-wrap gap-x-3 text-xs">
            <span>{view.planning}</span>
            <span>{view.review}</span>
            <span>{view.findingCounts}</span>
          </p>
          {view.summary ? <p className="text-muted text-sm">{view.summary}</p> : null}
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card labelledBy="log-agents">
          <CardTitle id="log-agents">Agents</CardTitle>
          <AgentList agents={view.agents} />
        </Card>
        <Card labelledBy="log-plan">
          <CardTitle id="log-plan">Progress</CardTitle>
          <TaskGraph lines={view.graph} />
        </Card>
      </div>

      <Card labelledBy="log-findings">
        <CardTitle id="log-findings" description="What reviewers raised, most recent first.">
          Reviews and findings
        </CardTitle>
        {view.findings.total === 0 ? (
          <EmptyState title="No findings">Reviews have not raised anything yet.</EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.findings.items.map((f) => (
              <li key={f.key} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={f.severityTone}>{f.severity}</Badge>
                  <span className={cx("text-xs", f.open ? "text-warning" : "text-subtle")}>
                    {f.status}
                  </span>
                </div>
                <p className="text-sm font-medium">{f.title}</p>
                <p className="text-subtle text-xs">
                  {f.category} · {f.raisedBy}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Pager page={view.findings} param="f" search={search} base={base} />
      </Card>

      <Card labelledBy="log-decisions">
        <CardTitle
          id="log-decisions"
          description="Disagreements and choices, numbered so you can refer to them in chat."
        >
          Decisions
        </CardTitle>
        {view.decisions.total === 0 ? (
          <EmptyState title="No decisions">Nothing has needed deciding yet.</EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.decisions.items.map((d) => (
              <li key={d.key} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted font-mono text-xs">{d.number}</span>
                  {d.needsYou ? <Badge tone="warning">Needs your decision</Badge> : null}
                </div>
                <p className="text-sm font-medium">{d.topic}</p>
                <p className="text-muted text-sm">{d.resolution}</p>
                {d.evidence ? <p className="text-subtle text-xs">Evidence: {d.evidence}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <Pager page={view.decisions} param="d" search={search} base={base} />
      </Card>

      <Card labelledBy="log-models">
        <CardTitle
          id="log-models"
          description="Which model each step used, and why. A run stops if a different model answers than was asked for."
        >
          Model usage
        </CardTitle>
        {view.models.total === 0 ? (
          <EmptyState title="No runs yet">Model choices appear once an agent starts.</EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.models.items.map((m) => (
              <li key={m.key} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <p className="text-sm">{m.selected}</p>
                <p className="text-subtle flex flex-wrap gap-x-3 text-xs">
                  <span>{m.who}</span>
                  {m.effort ? <span>{m.effort}</span> : null}
                  <span className={m.ok ? undefined : "text-danger"}>{m.outcome}</span>
                  <span>{m.when}</span>
                </p>
                {m.mismatch ? (
                  <p className="text-danger text-xs">
                    <span aria-hidden>⚠ </span>
                    {m.mismatch}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Pager page={view.models} param="m" search={search} base={base} />
      </Card>
    </div>
  );
}
