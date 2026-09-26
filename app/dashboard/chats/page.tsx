import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ChatListRow, GroupManager, NewChatForm, type Choice } from "@/components/dashboard/chats";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { buttonStyles, Card, CardTitle, cx, EmptyState } from "@/components/ui";
import {
  chatHref,
  chatListHref,
  deriveChatList,
  MODE_LABELS,
  parseChatListQuery,
  type ChatListQuery,
} from "@/lib/dashboard/chats";
import { loadChatGroups, loadChats } from "@/lib/dashboard/chats-data";
import { loadNow, loadProjectChoices } from "@/lib/dashboard/data";

export const metadata: Metadata = { title: "Chats · ThreadLink" };

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      scroll={false}
      className={cx(
        "rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors",
        active
          ? "border-accent bg-accent-soft text-accent font-medium"
          : "border-border text-muted hover:bg-surface-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

export default async function ChatsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseChatListQuery(await searchParams);
  const [chats, groups, rooms, now] = await Promise.all([
    loadChats(),
    loadChatGroups(),
    loadProjectChoices(),
    loadNow(),
  ]);
  if (!chats) return <LoadError what="your chats" />;
  const projects = (rooms ?? []).filter((r) => !r.archived);
  const { view, handles } = deriveChatList(chats, groups ?? [], projects, query, now);
  const with_ = (patch: Partial<ChatListQuery>) => chatListHref({ ...query, ...patch });

  const projectChoices: Choice[] = view.projectChoices.map((p) => ({
    ...p,
    id: handles[p.key]!.roomId!,
  }));
  const groupChoices: Choice[] = view.groupChoices.map((g) => ({
    ...g,
    id: handles[g.key]!.groupId!,
  }));

  return (
    <Shell>
      <PageHeader
        title="Chats"
        description="Chat with one agent, two, or the whole team. Projects decide which folder the work happens in."
        actions={
          <a href="#new-chat" className={buttonStyles.primary}>
            New chat
          </a>
        }
      />

      <form
        method="get"
        action="/dashboard/chats"
        role="search"
        className="flex flex-wrap items-end gap-2"
      >
        {query.mode ? <input type="hidden" name="mode" value={query.mode} /> : null}
        {query.group ? <input type="hidden" name="group" value={query.group} /> : null}
        {query.project ? <input type="hidden" name="project" value={query.project} /> : null}
        {query.show !== "all" ? <input type="hidden" name="show" value={query.show} /> : null}
        {query.by !== "none" ? <input type="hidden" name="by" value={query.by} /> : null}
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="sr-only">Search chats</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            placeholder="Search chats, projects and messages"
            maxLength={100}
            className={cx(field, "w-full")}
          />
        </label>
        <button type="submit" className={buttonStyles.secondary}>
          Search
        </button>
      </form>

      <nav aria-label="Filter chats" className="flex flex-col gap-2">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          <FilterLink href={with_({ show: "all" })} active={query.show === "all"}>
            All ({view.total})
          </FilterLink>
          <FilterLink href={with_({ show: "attention" })} active={query.show === "attention"}>
            Needs you ({view.counts.attention})
          </FilterLink>
          <FilterLink href={with_({ show: "unread" })} active={query.show === "unread"}>
            Unread ({view.counts.unread})
          </FilterLink>
          <FilterLink href={with_({ show: "archived" })} active={query.show === "archived"}>
            Archived ({view.counts.archived})
          </FilterLink>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          <FilterLink href={with_({ mode: null })} active={!query.mode}>
            Any mode
          </FilterLink>
          {(["solo", "pair", "team"] as const).map((m) => (
            <FilterLink key={m} href={with_({ mode: m })} active={query.mode === m}>
              {MODE_LABELS[m]}
            </FilterLink>
          ))}
        </div>
        {view.groups.length ? (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            <FilterLink href={with_({ group: null })} active={!query.group}>
              Any group
            </FilterLink>
            {view.groups.map((g) => (
              <FilterLink
                key={g.key}
                href={with_({ group: handles[g.key]!.groupId! })}
                active={g.active}
              >
                {g.name} ({g.count})
              </FilterLink>
            ))}
            <FilterLink href={with_({ group: "none" })} active={query.group === "none"}>
              No group
            </FilterLink>
          </div>
        ) : null}
        {view.projects.length ? (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
            <FilterLink href={with_({ project: null })} active={!query.project}>
              Any project
            </FilterLink>
            {view.projects.map((p) => (
              <FilterLink
                key={p.key}
                href={with_({ project: handles[p.key]!.roomId! })}
                active={p.active}
              >
                {p.name} ({p.count})
              </FilterLink>
            ))}
            <FilterLink href={with_({ project: "none" })} active={query.project === "none"}>
              No project
            </FilterLink>
          </div>
        ) : null}
        <p className="text-subtle flex flex-wrap items-center gap-2 text-xs">
          <span>Show as:</span>
          <FilterLink href={with_({ by: "none" })} active={query.by === "none"}>
            Recent
          </FilterLink>
          <FilterLink href={with_({ by: "group" })} active={query.by === "group"}>
            By group
          </FilterLink>
          <FilterLink href={with_({ by: "project" })} active={query.by === "project"}>
            By project
          </FilterLink>
          {view.filtered ? (
            <Link href="/dashboard/chats" className="text-accent">
              Clear filters
            </Link>
          ) : null}
        </p>
      </nav>

      {groups === null || rooms === null ? (
        <p role="status" className="text-warning text-sm">
          Some filters could not be loaded right now.
        </p>
      ) : null}

      {view.sections.length === 0 ? (
        <Card>
          <EmptyState title={view.filtered ? "No matching chats" : "No chats yet"}>
            {view.emptyText}
          </EmptyState>
        </Card>
      ) : (
        view.sections.map((s) => (
          <Card key={s.key} labelledBy={`${s.key}-title`}>
            <CardTitle id={`${s.key}-title`}>{s.title}</CardTitle>
            <ul className="-my-3 flex flex-col">
              {s.rows.map((row) => {
                const h = handles[row.key]!;
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
          </Card>
        ))
      )}

      <Card labelledBy="new-chat-title">
        <div id="new-chat" className="scroll-mt-8" />
        <CardTitle
          id="new-chat-title"
          description="Pick a project so the agents know which folder to work in. You can add one later."
        >
          New chat
        </CardTitle>
        <NewChatForm projects={projectChoices} groups={groupChoices} />
      </Card>

      <Card labelledBy="groups-title">
        <CardTitle
          id="groups-title"
          description="Your own folders for chats. A chat can be in one group."
        >
          Groups
        </CardTitle>
        {groups === null ? (
          <p className="text-muted text-sm">Groups could not be loaded right now.</p>
        ) : (
          <GroupManager groups={groupChoices} />
        )}
      </Card>
    </Shell>
  );
}
