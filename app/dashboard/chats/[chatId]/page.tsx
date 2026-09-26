import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChatMenu, BlockedJob, ChatHeader, ModeControl } from "@/components/dashboard/chats";
import { ChatView } from "@/components/dashboard/chat-view";
import { CopyId } from "@/components/dashboard/copy-id";
import { Shell } from "@/components/dashboard/shell";
import { JobLog } from "@/components/dashboard/team";
import { Badge, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import {
  blockedCallout,
  CHAT_TAB_LABELS,
  CHAT_TABS,
  chatHeader,
  chatHref,
  chatTechnical,
  modeControl,
  parseChatTab,
  retryOption,
} from "@/lib/dashboard/chats";
import { loadChat, loadChatEvents, loadChatGroups } from "@/lib/dashboard/chats-data";
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

  const [initial, controller, rooms, groupList, now] = await Promise.all([
    tab === "chat" ? loadChatEvents(chat.chatId) : Promise.resolve(null),
    loadControllerName(),
    loadProjectChoices(),
    loadChatGroups(),
    loadNow(),
  ]);

  const header = chatHeader(chat);
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

      <ChatHeader header={header} projectHref={projectLink} />
      <ModeControl chatId={chat.chatId} control={control} />

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

      {tab === "details" ? <ChatDetails chat={chat} jobs={jobs} detail={detail} now={now} /> : null}
    </Shell>
  );
}

function ChatDetails({
  chat,
  jobs,
  detail,
  now,
}: {
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
