import { Activity, Clock, Cpu, GitBranch, ListChecks, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { BlockedJob, ChatMenu, ModeControl } from "@/components/dashboard/chats";
import { ChatView, type ChatArtifact } from "@/components/dashboard/chat-view";
import { CopyId } from "@/components/dashboard/copy-id";
import { JobLog } from "@/components/dashboard/team";
import { cx } from "@/components/ui";
import { formatBytes } from "@/lib/dashboard/attachments";
import { initialPanel } from "@/lib/dashboard/chat-panel";
import {
  blockedCallout,
  chatHref,
  chatTechnical,
  modeControl,
  retryOption,
} from "@/lib/dashboard/chats";
import {
  loadChat,
  loadChatArtifacts,
  loadChatChoices,
  loadChatFindings,
  loadChatGroups,
  loadChatRuns,
  loadChatTimeline,
  loadHostStatus,
  loadProviderRegistryRows,
} from "@/lib/dashboard/chats-data";
import { loadControllerName, loadNow, loadProjectChoices } from "@/lib/dashboard/data";
import {
  effortLabel,
  humanize,
  jobState,
  modelDisplayName,
  OUTCOME_LABELS,
  roleLabel,
} from "@/lib/dashboard/labels";
import { deriveTeamLog, trim } from "@/lib/dashboard/pages";
import { parseJobParam } from "@/lib/dashboard/project";
import { providerDisplay, unhealthyAgents } from "@/lib/dashboard/providers-display";
import { buildRegistry, registryEntry } from "@/lib/dashboard/registry";
import {
  parseProvenance11,
  provenanceRows,
  sessionReasonText,
  verificationOf,
} from "@/lib/dashboard/timeline";
import { relativeTime } from "@/lib/dashboard/view-model";
import { runTimingsText } from "@/runtime/src/chat-presentation";

export const metadata: Metadata = { title: "Chat · ThreadLink" };

type Search = Record<string, string | string[] | undefined>;

const pageOf = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const SEVERITY: Record<string, { label: string; tone: string }> = {
  blocking: { label: "Blocking", tone: "text-danger" },
  important: { label: "Important", tone: "text-warning" },
  non_blocking: { label: "Minor", tone: "text-muted" },
};

/** The drawer's section card (design canvas), server side. */
function Section({
  title,
  icon: Icon = null,
  children,
}: {
  title: string;
  icon?: LucideIcon | null;
  children: ReactNode;
}) {
  return (
    <section className="border-line-soft bg-card flex flex-col gap-2.5 rounded-xl border p-3.5">
      <h3 className="text-subtle flex items-center gap-2 text-xs font-semibold">
        {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One chat (0.11 §8): the conversation owns the screen. The page renders the
 * chat screen and hands it the drawer's server-rendered parts (Progress,
 * Findings, the technical half of Details); nothing technical sits above the
 * messages.
 */
export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<Search>;
}) {
  const { chatId } = await params;
  const search = await searchParams;
  const askedJob = parseJobParam(search.job);
  const panel = initialPanel(search) ?? (askedJob ? "progress" : null);

  // A chat that is not yours reads exactly like one that does not exist.
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(chatId)) notFound();
  const data = await loadChat(chatId, askedJob);
  if (!data) notFound();
  const { chat, settings, jobs, detail, selectedJobId } = data;

  const [
    initial,
    controller,
    rooms,
    groupList,
    now,
    registryRows,
    findings,
    choiceRows,
    artifactRows,
    runRows,
    hostStatus,
  ] = await Promise.all([
    loadChatTimeline(chat.chatId),
    loadControllerName(),
    loadProjectChoices(),
    loadChatGroups(),
    loadNow(),
    loadProviderRegistryRows(),
    loadChatFindings(chat.chatId),
    loadChatChoices(chat.chatId),
    loadChatArtifacts(chat.chatId),
    loadChatRuns(chat.chatId),
    loadHostStatus(chat.chatId),
  ]);

  const registry = buildRegistry(registryRows);
  const participants = chat.participants.map((p) =>
    p.kind === "agent" && p.provider && hostStatus?.agents[p.provider]
      ? { ...p, health: hostStatus.agents[p.provider]!.health as typeof p.health }
      : p,
  );
  const findingStates: Record<string, string> = {};
  const findingRows: Record<string, Record<string, unknown>> = {};
  for (const f of findings ?? []) {
    const fid =
      typeof f.findingId === "string" ? f.findingId : typeof f.id === "string" ? f.id : null;
    if (!fid) continue;
    findingRows[fid] = f;
    if (typeof f.status === "string") findingStates[fid] = f.status;
  }
  const choices: Record<string, Record<string, unknown>> = {};
  for (const c of choiceRows ?? []) {
    const cid =
      typeof c.choiceId === "string" ? c.choiceId : typeof c.id === "string" ? c.id : null;
    if (cid) choices[cid] = c;
  }
  const artifacts: ChatArtifact[] | null = artifactRows
    ? artifactRows.map((a) => ({
        artifactId: a.artifactId,
        title: a.title,
        kind: humanize(a.kind),
        size: formatBytes(a.bytes),
        createdAt: a.createdAt,
      }))
    : null;
  const control = modeControl(settings, chat.participants);
  const agentParticipants = participants.filter((p) => p.kind === "agent" && p.provider);
  const seen = new Set<string>();
  const agents = agentParticipants
    .map((p) => {
      const entry = registryEntry(registry, p.provider, p.name);
      const h = hostStatus?.agents[p.provider!];
      return {
        provider: entry.id,
        name: entry.name,
        shortName: entry.shortName,
        health: h?.health ?? p.health ?? null,
        checkedAt: h?.checkedAt ?? null,
        resetsAt: h?.resetsAt ?? null,
      };
    })
    .filter((a) => (seen.has(a.provider) ? false : (seen.add(a.provider), true)));
  const healthHint = unhealthyAgents(chat.participants).find((a) => a.callout)?.callout ?? null;
  const blocked = detail ? blockedCallout(detail, chat.participants) : null;
  const retry = detail ? retryOption(detail, chat.participants) : null;
  const projectHref = chat.roomId ? `/dashboard/projects/${encodeURIComponent(chat.roomId)}` : null;
  const projects = (rooms ?? [])
    .filter((r) => !r.archived || r.roomId === chat.roomId)
    .map((r, i) => ({ key: `p${i}`, name: r.name, id: r.roomId }));
  // Without the group list a "Save group" could clear a group by accident, so
  // the menu then offers only the chat's own group.
  const groups = (
    groupList ??
    (chat.groupId ? [{ groupId: chat.groupId, name: chat.groupName ?? "Current group" }] : [])
  ).map((g, i) => ({ key: `g${i}`, name: g.name, id: g.groupId }));

  const runs = (runRows ?? []).map(parseProvenance11).filter((r) => r !== null);

  // ---- Drawer: Progress -------------------------------------------------
  const progress = (
    <div className="flex flex-col gap-3.5">
      {data.jobNotFound ? (
        <p role="status" className="text-muted text-sm">
          That work isn&apos;t in this chat, so the latest is shown instead.
        </p>
      ) : null}
      {jobs.length > 1 ? (
        <Section title="Work in this chat" icon={ListChecks}>
          <ul className="divide-border flex flex-col divide-y">
            {jobs.slice(0, 20).map((j, i) => {
              const s = jobState(j.status, j.verdict);
              const selected = j.jobId === selectedJobId;
              return (
                <li key={`j${i}`} className="flex flex-col gap-0.5 py-1.5">
                  <Link
                    href={chatHref(chat.chatId, { job: j.jobId, extra: { panel: "progress" } })}
                    aria-current={selected ? "true" : undefined}
                    scroll={false}
                    className={cx(
                      "min-w-0 truncate text-sm hover:underline",
                      selected && "font-semibold",
                    )}
                  >
                    {trim(j.goal)}
                  </Link>
                  <span className="text-subtle text-xs">
                    {s.label} · {relativeTime(j.finishedAt ?? j.startedAt, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {detail && selectedJobId ? (
        <JobLog
          view={
            deriveTeamLog(detail, chat.projectName ?? chat.name, now, {
              findings: pageOf(search.f),
              decisions: pageOf(search.d),
              models: pageOf(search.m),
            }).view
          }
          base={chatHref(chat.chatId)}
          search={{ panel: "progress", job: selectedJobId, f: search.f, d: search.d, m: search.m }}
        />
      ) : (
        <p className="text-muted text-sm">
          No work yet. Stages, reviews and model choices show up here once work runs.
        </p>
      )}
    </div>
  );

  // ---- Drawer: Findings -------------------------------------------------
  const findingList = Object.entries(findingRows);
  const findingsPanel =
    findings === null ? (
      <p className="text-muted text-sm">Findings could not be loaded right now.</p>
    ) : findingList.length === 0 ? (
      <p className="text-muted text-sm">No findings yet.</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {findingList.slice(0, 100).map(([fid, f]) => {
          const sev = SEVERITY[typeof f.severity === "string" ? f.severity : ""] ?? {
            label: "Finding",
            tone: "text-muted",
          };
          const raisedBy = typeof f.raisedBy === "string" ? f.raisedBy.split(":")[0] : null;
          return (
            <li
              key={fid}
              className="border-line-soft bg-card flex flex-col gap-1 rounded-xl border p-3 text-sm"
            >
              <span className="break-words">
                {typeof f.title === "string" ? f.title.slice(0, 300) : "Finding"}
              </span>
              <span className="text-subtle text-xs">
                <span className={sev.tone}>{sev.label}</span>
                {" · "}
                {humanize(typeof f.status === "string" ? f.status : "open")}
                {raisedBy ? ` · from ${registryEntry(registry, raisedBy).shortName}` : ""}
                {typeof f.filePath === "string" ? ` · ${f.filePath.slice(0, 120)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    );

  // ---- Drawer: Details (technical half) ---------------------------------
  const t = chatTechnical(chat, jobs, detail, {
    model: (id) => modelDisplayName(id),
    effort: effortLabel,
    role: roleLabel,
    provider: (p) => providerDisplay(p).name,
    outcome: (o) => OUTCOME_LABELS[o] ?? humanize(o),
  });
  const details = (
    <>
      {runs.length ? (
        <Section title="Runs" icon={Activity}>
          <ul className="flex flex-col gap-3">
            {runs.slice(0, 50).map((r) => {
              const v = verificationOf(r);
              const name = registryEntry(registry, r.provider, r.providerName || null).name;
              const timings = runTimingsText(r.timings);
              const session = sessionReasonText(r.sessionReason);
              return (
                <li key={r.runId} className="flex flex-col gap-0.5 text-sm">
                  <span>
                    <span className="font-medium">{name}</span>
                    {r.role ? <span className="text-muted"> · {roleLabel(r.role)}</span> : null}
                    <span
                      className={cx(
                        "pl-2 text-xs",
                        v.state === "verified" ? "text-success" : "text-subtle",
                      )}
                    >
                      {v.state === "verified" ? "✓ Verified" : v.label}
                    </span>
                  </span>
                  {timings ? <span className="text-muted text-xs">{timings}</span> : null}
                  {session ? <span className="text-subtle text-xs">{session}</span> : null}
                  <details className="text-xs">
                    <summary className="text-subtle cursor-pointer">Run details</summary>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1">
                      {provenanceRows(r, registry).map((x) => (
                        <div key={x.key} className="contents">
                          <dt className="text-muted">{x.label}</dt>
                          <dd className="min-w-0 break-words">{x.value}</dd>
                        </div>
                      ))}
                      <dt className="text-muted">Run ID</dt>
                      <dd className="min-w-0">
                        <CopyId value={r.runId} label="Run ID" />
                      </dd>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <Section title="Models" icon={Cpu}>
        {t.models.length === 0 ? (
          <p className="text-muted text-sm">Model choices appear once an agent starts.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {t.models.map((m) => (
              <li key={m.key} className="flex flex-col text-sm">
                <span>
                  {m.who} · {m.model}
                  {m.effort ? ` · ${m.effort}` : ""}
                </span>
                <span className="text-subtle text-xs">
                  {m.outcome} · {m.why}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {t.routing.length ? (
        <Section title="Routing and decisions" icon={GitBranch}>
          <ul className="flex flex-col gap-1 text-sm">
            {t.routing.map((r) => (
              <li key={r.key}>
                <span className="text-subtle font-mono text-xs">{r.label}</span> {r.text}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {t.timings.length ? (
        <Section title="Timings" icon={Clock}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {t.timings.map((x) => (
              <div key={x.key} className="contents">
                <dt className="text-muted">{x.label}</dt>
                <dd className="min-w-0 break-words">
                  {/^\d{4}-\d{2}-\d{2}T/.test(x.value) ? (
                    <time dateTime={x.value} title={x.value}>
                      {relativeTime(x.value, now)}
                    </time>
                  ) : (
                    x.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      <details className="border-line-soft bg-card rounded-xl border p-3.5 text-sm">
        <summary className="text-subtle cursor-pointer text-xs font-semibold">Identifiers</summary>
        <p className="text-subtle pt-1 text-xs">
          For support and troubleshooting. You never need these for normal use.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 pt-2">
          {t.ids.map((x) => (
            <div key={x.key} className="contents">
              <dt className="text-muted min-w-0 truncate" title={x.label}>
                {x.label}
              </dt>
              <dd className="min-w-0">
                <CopyId value={x.value} label={`${x.label} ID`} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-subtle pt-2 text-xs">
          Worktrees and full logs stay on your computer; open the ThreadLink app there to see them.
        </p>
      </details>
    </>
  );

  return (
    <ChatView
      key={chat.chatId}
      chatId={chat.chatId}
      initial={initial}
      controller={controller}
      agentProviders={agents.map((a) => a.provider)}
      modeSummary={control.summary}
      archived={chat.archived}
      hasProject={chat.roomId !== null}
      healthHint={healthHint}
      registryRows={registryRows}
      findingStates={findingStates}
      findings={findingRows}
      choices={choices}
      artifacts={artifacts}
      title={chat.name}
      modeControl={<ModeControl chatId={chat.chatId} control={control} compact />}
      menu={
        <ChatMenu
          row={{ name: chat.name, pinned: chat.pinned, archived: chat.archived }}
          chatId={chat.chatId}
          groupId={chat.groupId}
          roomId={chat.roomId}
          projects={projects}
          groups={groups}
        />
      }
      project={chat.projectName ? { name: chat.projectName, href: projectHref } : null}
      host={hostStatus?.host ?? null}
      agents={agents}
      initialPanel={panel}
      progress={progress}
      findingsPanel={findingsPanel}
      details={details}
      notice={
        blocked && detail && selectedJobId ? (
          <BlockedJob text={blocked} retry={retry} jobId={selectedJobId} />
        ) : null
      }
    />
  );
}
