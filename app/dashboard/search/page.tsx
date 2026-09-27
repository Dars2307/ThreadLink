import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader, Shell } from "@/components/dashboard/shell";
import { buttonStyles, Card, cx, EmptyState } from "@/components/ui";
import { loadChats, loadProviderRegistryRows, searchChats } from "@/lib/dashboard/chats-data";
import { loadNow, loadProjectChoices } from "@/lib/dashboard/data";
import { buildRegistry } from "@/lib/dashboard/registry";
import { MODE_LABELS } from "@/lib/dashboard/chats";
import {
  parseSearchQuery,
  searchResults,
  SEARCH_STATUSES,
  type SearchChatFacts,
} from "@/lib/dashboard/search";
import { relativeTime } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Search · ThreadLink" };

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";
const STATUS_LABELS: Record<(typeof SEARCH_STATUSES)[number], string> = {
  working: "Working",
  needs_you: "Needs you",
  finished: "Finished",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSearchQuery(await searchParams);
  const [rooms, registryRows, now, chats, rows] = await Promise.all([
    loadProjectChoices(),
    loadProviderRegistryRows(),
    loadNow(),
    loadChats(),
    query.q.length >= 2 ? searchChats(query.q) : Promise.resolve([]),
  ]);
  const registry = buildRegistry(registryRows);
  // The server searches text; project / agent / mode / status come from your chat list.
  const facts: Map<string, SearchChatFacts> | null = chats
    ? new Map(
        chats.map((c) => [
          c.chatId,
          {
            chatId: c.chatId,
            roomId: c.roomId,
            projectName: c.projectName,
            mode: c.mode,
            agents: c.participants.flatMap((p) =>
              p.kind === "agent" && p.provider ? [p.provider] : [],
            ),
            working: c.activeJob !== null,
            needsAttention: c.needsAttention,
          },
        ]),
      )
    : null;
  const results = rows ? searchResults(rows, query, facts) : null;

  return (
    <Shell>
      <PageHeader
        title="Search"
        description="Chats, projects, messages, findings, decisions and artifacts — yours only."
      />
      <form method="get" action="/dashboard/search" role="search" className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="sr-only">Search for</span>
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              minLength={2}
              maxLength={100}
              autoFocus
              placeholder="What are you looking for?"
              className={cx(field, "w-full")}
            />
          </label>
          <button type="submit" className={buttonStyles.primary}>
            Search
          </button>
        </div>
        <fieldset className="flex flex-wrap gap-2 text-sm">
          <legend className="sr-only">Filters</legend>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">Project</span>
            <select name="project" defaultValue={query.projectId ?? ""} className={field}>
              <option value="">Any project</option>
              {(rooms ?? []).map((r) => (
                <option key={r.roomId} value={r.roomId}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">Agent</span>
            <select name="agent" defaultValue={query.agent ?? ""} className={field}>
              <option value="">Any agent</option>
              {registry.entries
                .filter((e) => e.supported)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">Mode</span>
            <select name="mode" defaultValue={query.mode ?? ""} className={field}>
              <option value="">Any mode</option>
              {(["solo", "pair", "team"] as const).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">Status</span>
            <select name="status" defaultValue={query.status ?? ""} className={field}>
              <option value="">Any status</option>
              {SEARCH_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">From</span>
            <input type="date" name="from" defaultValue={query.from ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-subtle text-xs">To</span>
            <input type="date" name="to" defaultValue={query.to ?? ""} className={field} />
          </label>
        </fieldset>
      </form>

      {query.q.length < 2 ? (
        <Card>
          <EmptyState title="Type at least two characters">
            Search looks through chat names, projects, messages, findings, decisions and artifacts.
          </EmptyState>
        </Card>
      ) : results === null ? (
        <Card>
          <EmptyState title="Search isn't available right now">
            You can still{" "}
            <Link
              href={`/dashboard/chats?q=${encodeURIComponent(query.q)}`}
              className="text-accent"
            >
              filter your chats by name
            </Link>
            .
          </EmptyState>
        </Card>
      ) : results.length === 0 ? (
        <Card>
          <EmptyState title="Nothing found">Try fewer words or clear a filter.</EmptyState>
        </Card>
      ) : (
        <Card>
          <p className="text-muted pb-2 text-sm" role="status">
            {results.length === 1 ? "1 result" : `${results.length} results`}
          </p>
          <ul className="divide-border flex flex-col divide-y">
            {results.map((r) => (
              <li key={r.key} className="py-3 first:pt-0 last:pb-0">
                <Link href={r.href} className="group flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium group-hover:underline">{r.chat}</span>
                    {r.project ? <span className="text-muted text-xs">{r.project}</span> : null}
                    <span className="bg-surface-muted text-muted rounded px-1.5 text-[0.7rem]">
                      {r.kind}
                    </span>
                    {r.at ? (
                      <span className="text-subtle ml-auto text-xs">{relativeTime(r.at, now)}</span>
                    ) : null}
                  </span>
                  {r.excerpt ? (
                    <span className="text-muted truncate text-xs">{r.excerpt}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Shell>
  );
}
