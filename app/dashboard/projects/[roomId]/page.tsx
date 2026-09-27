import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ChatListRow, NewChatForm, type Choice } from "@/components/dashboard/chats";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { ProjectPolicyForm } from "@/components/dashboard/project-settings";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { artifactHref } from "@/lib/dashboard/chat";
import {
  chatHref,
  defaultChatFor,
  deriveChatList,
  parseChatListQuery,
  projectTabRedirect,
} from "@/lib/dashboard/chats";
import { loadChatGroups, loadChats, loadProjectHub } from "@/lib/dashboard/chats-data";
import { loadControllerName, loadProject, loadProjectChoices } from "@/lib/dashboard/data";
import { USAGE_POLICY_TEXT, plural } from "@/lib/dashboard/labels";
import { usagePolicyOptions } from "@/lib/dashboard/pages";
import { deriveProject } from "@/lib/dashboard/project";
import { projectHub } from "@/lib/dashboard/project-hub";
import { TEAM_LIMITS } from "@/lib/team/model";

export const metadata: Metadata = { title: "Project · ThreadLink" };

type Search = Record<string, string | string[] | undefined>;

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<Search>;
}) {
  const { roomId } = await params;
  const search = await searchParams;

  // A project that is not yours reads exactly like one that does not exist.
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) notFound();
  const [data, chats, groups, rooms, hubRaw, controller] = await Promise.all([
    loadProject(roomId, null),
    loadChats(),
    loadChatGroups(),
    loadProjectChoices(),
    loadProjectHub(roomId),
    loadControllerName(),
  ]);
  if (!data) notFound();
  const room = data.room.roomId;

  // 0.8 links (?tab=chat|progress|details) open the project's default chat.
  const moved = projectTabRedirect(
    search,
    chats ? defaultChatFor(room, data.room.name, chats) : null,
  );
  if (moved) redirect(moved);

  const { view } = deriveProject(data.room, data.jobs, data.detail, data.now);
  const hub = projectHub(hubRaw, { projectName: data.room.name, controller, now: data.now });
  const list = chats
    ? deriveChatList(
        chats,
        groups ?? [],
        [{ roomId: room, name: data.room.name }],
        { ...parseChatListQuery({}), project: room },
        data.now,
      )
    : null;
  const projectChoices: Choice[] = (rooms ?? [])
    .filter((r) => !r.archived || r.roomId === room)
    .map((r, i) => ({ key: `p${i}`, name: r.name, id: r.roomId }));
  const groupChoices: Choice[] = (groups ?? []).map((g, i) => ({
    key: `g${i}`,
    name: g.name,
    id: g.groupId,
  }));
  const b = data.room.budgets;
  const policy = {
    ...b,
    usagePolicy: data.room.usagePolicy,
    text: [
      `Up to ${plural(b.parallelAgents, "agent")} at once`,
      plural(b.maxPlanningRounds, "planning round"),
      plural(b.maxReviewRounds, "review round"),
      USAGE_POLICY_TEXT[data.room.usagePolicy].label,
    ].join(" · "),
  };

  return (
    <Shell>
      <Link href="/dashboard/projects" className="text-accent w-fit text-sm">
        ← Projects
      </Link>
      <PageHeader
        eyebrow={`${view.team} · ${view.folder}`}
        title={view.name}
        badge={view.archived ? "Archived" : view.status}
        tone={view.archived ? "neutral" : view.tone}
        description={view.summary}
      />

      <Card labelledBy="chats-title">
        <CardTitle
          id="chats-title"
          description="Every chat here runs its work in this project's folder."
        >
          Chats
        </CardTitle>
        {list === null ? (
          <p className="text-muted text-sm">Chats could not be loaded right now.</p>
        ) : list.view.shown === 0 ? (
          <EmptyState title="No chats in this project yet">
            Start one below, or move an existing chat here from the chat list.
          </EmptyState>
        ) : (
          <ul className="-my-3 flex flex-col">
            {list.view.sections
              .flatMap((s) => s.rows)
              .map((row) => {
                const h = list.handles[row.key]!;
                return (
                  <ChatListRow
                    key={row.key}
                    row={row}
                    href={chatHref(h.chatId!)}
                    chatId={h.chatId!}
                    groupId={h.groupId ?? null}
                    roomId={h.roomId ?? null}
                    projects={projectChoices}
                    groups={groupChoices}
                  />
                );
              })}
          </ul>
        )}
      </Card>

      {view.archived ? null : (
        <Card labelledBy="new-chat-title">
          <CardTitle id="new-chat-title">New chat in {view.name}</CardTitle>
          <NewChatForm projects={projectChoices} defaultProject={room} groups={groupChoices} />
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card labelledBy="where-title">
          <CardTitle
            id="where-title"
            description="The folder and computer this project's work runs on."
          >
            Where it runs
          </CardTitle>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Folder</dt>
            <dd className="min-w-0 break-words">{hub.repository?.folder ?? view.folder}</dd>
            <dt className="text-muted">Computer</dt>
            <dd>{hub.host ? hub.host.text : "Reported by the ThreadLink app"}</dd>
            {hub.repository?.branch ? (
              <>
                <dt className="text-muted">Branch</dt>
                <dd className="font-mono text-xs">{hub.repository.branch}</dd>
              </>
            ) : null}
            {hub.repository?.remote ? (
              <>
                <dt className="text-muted">Repository</dt>
                <dd className="min-w-0 font-mono text-xs break-all">{hub.repository.remote}</dd>
              </>
            ) : null}
            <dt className="text-muted">Agents</dt>
            <dd>{view.team}</dd>
          </dl>
          {hub.host?.outdated ? (
            <p role="status" className="text-warning pt-3 text-sm">
              {hub.host.outdated}
            </p>
          ) : null}
        </Card>

        <Card labelledBy="verify-title">
          <CardTitle
            id="verify-title"
            description="Commands every piece of work must pass in this folder before it can be called done."
          >
            Verification
          </CardTitle>
          {hub.verification.commands.length ? (
            <ul className="flex flex-col gap-1">
              {hub.verification.commands.map((c, i) => (
                <li key={i}>
                  <code className="bg-surface-muted rounded px-2 py-0.5 font-mono text-xs">
                    {c}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{hub.verification.empty}</p>
              <p className="text-muted">{hub.verification.howTo}</p>
              {hub.verification.suggestions.length ? (
                <div className="flex flex-col gap-1">
                  <p className="text-subtle text-xs">{hub.verification.suggestionNote}</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {hub.verification.suggestions.map((c) => (
                      <li key={c}>
                        <Badge tone="neutral">
                          <span className="font-mono">{c}</span>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <Card labelledBy="artifacts-title">
        <CardTitle
          id="artifacts-title"
          description="Reports, plans, diffs and attachments from this project's chats."
        >
          Artifacts
        </CardTitle>
        {hub.artifacts.length === 0 ? (
          <p className="text-muted text-sm">
            Nothing here yet. Each chat keeps its own artifacts — open a chat and choose Artifacts.
          </p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {hub.artifacts.map((a) => (
              <li
                key={a.key}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="min-w-0 break-words">
                  {a.title} <span className="text-subtle text-xs">· {a.kind}</span>
                </span>
                <a
                  href={artifactHref(a.chatId, a.artifactId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent text-xs font-medium"
                >
                  Open
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card labelledBy="config-title">
        <CardTitle id="config-title" description="How work from this project's chats runs.">
          Project settings
        </CardTitle>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Folder</dt>
          <dd>{view.folder}</dd>
          <dt className="text-muted">Claude Code conversation</dt>
          <dd>{view.conversation ?? "A new background session for each request"}</dd>
          <dt className="text-muted">Agents</dt>
          <dd>{view.team}</dd>
          <dt className="text-muted">Checks</dt>
          <dd>
            {hub.verification.commands.length
              ? "The verification commands above, plus the checks each request asks for."
              : "Only the checks each request asks for (no project verification commands configured)."}
          </dd>
          <dt className="text-muted">Routing</dt>
          <dd>
            Each chat&apos;s mode decides who works on a request; a leading @mention picks someone
            for one message. Moving a chat to another project changes only future work.
          </dd>
        </dl>
        <details className="group pt-4">
          <summary className="text-muted hover:text-foreground cursor-pointer text-sm">
            Usage and rounds <span className="text-subtle">· {policy.text}</span>
          </summary>
          <ProjectPolicyForm
            roomId={room}
            policy={policy}
            limits={TEAM_LIMITS}
            usagePolicies={usagePolicyOptions()}
          />
        </details>
        <p className="text-subtle pt-4 text-xs">
          Rename, archive or delete the project on the{" "}
          <Link href="/dashboard/projects" className="text-accent">
            Projects
          </Link>{" "}
          page.
        </p>
      </Card>
    </Shell>
  );
}
