import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ChatListRow, NewChatForm, type Choice } from "@/components/dashboard/chats";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { ProjectPolicyForm } from "@/components/dashboard/project-settings";
import { Card, CardTitle, EmptyState } from "@/components/ui";
import {
  chatHref,
  defaultChatFor,
  deriveChatList,
  parseChatListQuery,
  projectTabRedirect,
} from "@/lib/dashboard/chats";
import { loadChatGroups, loadChats } from "@/lib/dashboard/chats-data";
import { loadProject, loadProjectChoices } from "@/lib/dashboard/data";
import { USAGE_POLICY_TEXT, plural } from "@/lib/dashboard/labels";
import { usagePolicyOptions } from "@/lib/dashboard/pages";
import { deriveProject } from "@/lib/dashboard/project";
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
  const [data, chats, groups, rooms] = await Promise.all([
    loadProject(roomId, null),
    loadChats(),
    loadChatGroups(),
    loadProjectChoices(),
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
          <dd>The checks each request asks for run in this folder before work can pass.</dd>
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
