import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader, Shell } from "@/components/dashboard/shell";
import { AgentList, TaskGraph } from "@/components/dashboard/team";
import { Badge, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import { loadJob } from "@/lib/dashboard/data";
import { deriveTeamLog, type Page } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Team log · ThreadLink" };

type Search = Record<string, string | string[] | undefined>;

const pageOf = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/** Previous / next links for one section, keeping the other sections' pages. */
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

export default async function TeamLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Search>;
}) {
  const { jobId } = await params;
  const search = await searchParams;
  const job = await loadJob(jobId);
  if (!job) notFound();

  const { view } = deriveTeamLog(job.detail, job.project, job.now, {
    findings: pageOf(search.f),
    decisions: pageOf(search.d),
    models: pageOf(search.m),
  });
  const base = `/dashboard/team/${jobId}`;

  return (
    <Shell>
      <Link href="/dashboard/team" className="text-accent w-fit text-sm">
        ← Team
      </Link>
      <PageHeader
        eyebrow={`${view.project} · Full team log`}
        title={view.goal.length > 120 ? `${view.goal.slice(0, 119)}…` : view.goal}
        badge={view.status}
        tone={view.tone}
        description={[view.planning, view.review, view.findingCounts].join(" · ")}
      />

      {view.summary ? (
        <Card>
          <p className="text-sm">{view.summary}</p>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card labelledBy="log-agents">
          <CardTitle id="log-agents">Agents</CardTitle>
          <AgentList agents={view.agents} />
        </Card>
        <Card labelledBy="log-plan">
          <CardTitle id="log-plan">Plan</CardTitle>
          <TaskGraph lines={view.graph} />
        </Card>
      </div>

      <Card labelledBy="log-findings">
        <CardTitle id="log-findings" description="What reviewers raised, most recent first.">
          Findings
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
          description="Disagreements and choices, numbered so you can refer to them in ChatGPT."
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
          Model choices
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
                {m.mismatch ? <p className="text-danger text-xs">{m.mismatch}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <Pager page={view.models} param="m" search={search} base={base} />
      </Card>

      <Card labelledBy="log-messages">
        <CardTitle id="log-messages">Messages</CardTitle>
        <p className="text-muted text-sm">{view.messages.note}</p>
      </Card>
    </Shell>
  );
}
