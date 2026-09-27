import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChatHeaderBar } from "@/components/dashboard/chat/header";
import { ChatMenu, BlockedJob } from "@/components/dashboard/chats";
import { ChatView, type ChatArtifact } from "@/components/dashboard/chat-view";
import { CopyId } from "@/components/dashboard/copy-id";
import { Shell } from "@/components/dashboard/shell";
import { JobLog } from "@/components/dashboard/team";
import { Badge, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import { formatBytes } from "@/lib/dashboard/attachments";
import { chatHeader10 } from "@/lib/dashboard/chat-header";
import {
  blockedCallout,
  CHAT_TAB_LABELS,
  CHAT_TABS,
  chatHref,
  chatTechnical,
  modeControl,
  parseChatTab,
  retryOption,
} from "@/lib/dashboard/chats";
import {
  loadChat,
  loadChatArtifacts,
  loadChatChoices,
  loadChatTimeline,
  loadChatFindings,
  loadChatGroups,
  loadChatRuns,
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
import { buildRegistry } from "@/lib/dashboard/registry";
import { parseProvenance, provenanceRows, verificationOf } from "@/lib/dashboard/timeline";
import { relativeTime } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Chat · ThreadLink" };

type Search = Record<string, string | string[] | undefined>;

const pageOf = (v: string | string[] | undefined) => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<Search>;
}) {
  const { chatId } = await params;
  const search = await searchParams;
  const tab = parseChatTab(search.tab);
  const askedJob = parseJobParam(search.job);

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
    tab === "chat" ? loadChatTimeline(chat.chatId) : Promise.resolve(null),
    loadControllerName(),
    loadProjectChoices(),
    loadChatGroups(),
    loadNow(),
    loadProviderRegistryRows(),
    tab === "chat" ? loadChatFindings(chat.chatId) : Promise.resolve(null),
    tab === "chat" ? loadChatChoices(chat.chatId) : Promise.resolve(null),
    loadChatArtifacts(chat.chatId),
    tab === "details" ? loadChatRuns(chat.chatId) : Promise.resolve(null),
    loadHostStatus(chat.chatId),
  ]);

  const registry = buildRegistry(registryRows);
  // Health from the host-status check (same instant as its checkedAt), else the chat's participants.
  const participants = chat.participants.map((p) =>
    p.kind === "agent" && p.provider && hostStatus?.agents[p.provider]
      ? { ...p, health: hostStatus.agents[p.provider]!.health as typeof p.health }
      : p,
  );
  const checkedAt: Record<string, string | null> = {};
  for (const [provider, a] of Object.entries(hostStatus?.agents ?? {})) {
    checkedAt[provider] = a.checkedAt;
  }
  const header = chatHeader10(
    { ...chat, participants },
    { registry, checkedAt, host: hostStatus?.host ?? null, now },
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
  const runs = (runRows ?? []).map(parseProvenance).filter((r) => r !== null);
  const control = modeControl(settings, chat.participants);
  const agents = chat.participants.filter((p) => p.kind === "agent" && p.provider);
  const healthHint = unhealthyAgents(chat.participants).find((a) => a.callout)?.callout ?? null;
  const blocked = detail ? blockedCallout(detail, chat.participants) : null;
  const retry = detail ? retryOption(detail, chat.participants) : null;
  const projectLink = chat.roomId ? `/dashboard/projects/${encodeURIComponent(chat.roomId)}` : null;
  const tabHref = (t: (typeof CHAT_TABS)[number]) =>
    chatHref(chat.chatId, { tab: t, job: askedJob && !data.jobNotFound ? askedJob : null });
  const projects = (rooms ?? [])
    .filter((r) => !r.archived || r.roomId === chat.roomId)
    .map((r, i) => ({ key: `p${i}`, name: r.name, id: r.roomId }));
  // Without the group list a "Save group" could clear a group by accident, so
  // the menu then offers only the chat's own group.
  const groups = (
    groupList ??
    (chat.groupId ? [{ groupId: chat.groupId, name: chat.groupName ?? "Current group" }] : [])
  ).map((g, i) => ({ key: `g${i}`, name: g.name, id: g.groupId }));

  return (
    <Shell>
      <div className="flex items-center justify-between gap-2">
        <Link href="/dashboard/chats" className="text-accent w-fit text-sm">
          ← Chats
        </Link>
        <ChatMenu
          row={{ name: chat.name, pinned: chat.pinned, archived: chat.archived }}
          chatId={chat.chatId}
          groupId={chat.groupId}
          roomId={chat.roomId}
          projects={projects}
          groups={groups}
        />
      </div>

      <ChatHeaderBar
        header={header}
        chatId={chat.chatId}
        control={control}
        projectHref={projectLink}
      />

      {blocked && detail && selectedJobId ? (
        <BlockedJob text={blocked} retry={retry} jobId={selectedJobId} />
      ) : null}

      <nav aria-label="Chat sections" className="border-border flex gap-1 border-b">
        {CHAT_TABS.map((t) => (
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
            {CHAT_TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      {data.jobNotFound ? (
        <p role="status" className="text-muted text-sm">
          That work isn&apos;t in this chat, so the latest is shown instead.
        </p>
      ) : null}

      {tab === "chat" ? (
        <ChatView
          key={chat.chatId}
          chatId={chat.chatId}
          initial={initial}
          controller={controller}
          agentProviders={agents.map((a) => a.provider!)}
          modeSummary={control.summary}
          archived={chat.archived}
          hasProject={chat.roomId !== null}
          healthHint={healthHint}
          registryRows={registryRows}
          findingStates={findingStates}
          findings={findingRows}
          choices={choices}
          artifacts={artifacts}
          hostOffline={header.offlineNote}
        />
      ) : null}

      {tab === "progress" ? (
        <div className="flex flex-col gap-6">
          {jobs.length > 1 ? (
            <Card labelledBy="jobs-title">
              <CardTitle id="jobs-title" description="Choose one to see its progress.">
                Work in this chat
              </CardTitle>
              <ul className="divide-border flex flex-col divide-y">
                {jobs.slice(0, 20).map((j, i) => {
                  const s = jobState(j.status, j.verdict);
                  const selected = j.jobId === selectedJobId;
                  return (
                    <li
                      key={`j${i}`}
                      className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                    >
                      <Link
                        href={chatHref(chat.chatId, { tab: "progress", job: j.jobId })}
                        aria-current={selected ? "true" : undefined}
                        scroll={false}
                        className={cx(
                          "min-w-0 truncate text-sm hover:underline",
                          selected && "font-semibold",
                        )}
                      >
                        {trim(j.goal)}
                      </Link>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-subtle text-xs">
                          {relativeTime(j.finishedAt ?? j.startedAt, now)}
                        </span>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
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
                Send a message on the Chat tab, or ask {controller} to send work to this chat. Its
                stages, reviews and model choices show up here.
              </EmptyState>
            </Card>
          )}
        </div>
      ) : null}

      {tab === "details" ? (
        <ChatDetails
          chat={chat}
          jobs={jobs}
          detail={detail}
          now={now}
          runs={runs.map((r) => ({
            key: r.runId,
            title: `${registry.byId.get(r.provider)?.name ?? providerDisplay(r.provider, r.providerName).name}${r.role ? ` · ${roleLabel(r.role)}` : ""}`,
            verification: verificationOf(r),
            rows: provenanceRows(r, registry),
            runId: r.runId,
          }))}
        />
      ) : null}
    </Shell>
  );
}

type RunLine = {
  key: string;
  title: string;
  runId: string;
  verification: ReturnType<typeof verificationOf>;
  rows: ReturnType<typeof provenanceRows>;
};

function ChatDetails({
  chat,
  jobs,
  detail,
  now,
  runs,
}: {
  runs: RunLine[];
  chat: NonNullable<Awaited<ReturnType<typeof loadChat>>>["chat"];
  jobs: NonNullable<Awaited<ReturnType<typeof loadChat>>>["jobs"];
  detail: NonNullable<Awaited<ReturnType<typeof loadChat>>>["detail"];
  now: number;
}) {
  const t = chatTechnical(chat, jobs, detail, {
    model: (id) => modelDisplayName(id),
    effort: effortLabel,
    role: roleLabel,
    provider: (p) => providerDisplay(p).name,
    outcome: (o) => OUTCOME_LABELS[o] ?? humanize(o),
  });
  return (
    <div className="flex flex-col gap-6">
      <Card labelledBy="models-title">
        <CardTitle
          id="models-title"
          description="Which model and effort each step used, and why it was chosen."
        >
          Models
        </CardTitle>
        {t.models.length === 0 ? (
          <EmptyState title="No runs yet">Model choices appear once an agent starts.</EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {t.models.map((m) => (
              <li key={m.key} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
                <span className="text-sm font-medium">
                  {m.who} · {m.model}
                  {m.effort ? ` · ${m.effort}` : ""}
                </span>
                <span className="text-muted text-xs">
                  {m.outcome} · {m.why}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card labelledBy="runs-title">
        <CardTitle
          id="runs-title"
          description="Every agent run in this chat: provider, role, models, worktree, access and how well it was verified."
        >
          Runs
        </CardTitle>
        {runs.length === 0 ? (
          <p className="text-muted text-sm">
            Open Details on any agent message in the chat to see where it came from: provider,
            models, worktree, access and verification.
          </p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {runs.slice(0, 50).map((r) => (
              <li key={r.key} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{r.title}</span>
                  <Badge
                    tone={
                      r.verification.state === "verified"
                        ? "success"
                        : r.verification.state === "partial"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {r.verification.state === "verified" ? "✓ Verified" : r.verification.label}
                  </Badge>
                </div>
                <details className="text-sm">
                  <summary className="text-muted cursor-pointer text-xs">Run details</summary>
                  <dl className="grid gap-x-6 gap-y-1 pt-2 text-xs sm:grid-cols-[auto_1fr]">
                    {r.rows.map((x) => (
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
                  {r.verification.notes.length ? (
                    <ul className="text-muted list-disc pt-2 pl-5 text-xs">
                      {r.verification.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card labelledBy="routing-title">
        <CardTitle
          id="routing-title"
          description="Why work was routed the way it was: the roles chosen and decisions made."
        >
          Routing and decisions
        </CardTitle>
        {t.routing.length === 0 ? (
          <p className="text-muted text-sm">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {t.routing.map((r) => (
              <li key={r.key}>
                <span className="text-muted font-mono text-xs">{r.label}</span> {r.text}
              </li>
            ))}
          </ul>
        )}
        <p className="text-subtle pt-3 text-xs">
          Worktrees and full logs stay on your computer; open the ThreadLink app there to see them.
        </p>
      </Card>

      {t.timings.length ? (
        <Card labelledBy="timings-title">
          <CardTitle id="timings-title">Timings</CardTitle>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
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
        </Card>
      ) : null}

      <Card labelledBy="ids-title">
        <CardTitle
          id="ids-title"
          description="Technical identifiers, for support and troubleshooting. You never need these for normal use."
        >
          Identifiers
        </CardTitle>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
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
      </Card>
    </div>
  );
}
