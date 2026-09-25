import type { Metadata } from "next";
import Link from "next/link";

import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { deriveNotifications, EMPTY_TEAM } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Notifications · ThreadLink" };

const TONE_WORD = {
  warning: "Needs you",
  danger: "Blocked",
  success: "Done",
  accent: "Update",
  neutral: "Info",
} as const;

export default async function NotificationsPage() {
  const [account, team] = await Promise.all([loadAccount(), loadTeam()]);
  if (!account) return <LoadError what="your notifications" />;
  const { view } = deriveNotifications(account, team ?? EMPTY_TEAM);

  return (
    <Shell>
      <PageHeader
        title="Notifications"
        description="Decisions waiting for you, finished team work, stopped tasks and offline devices."
        badge={view.needsYou ? `${view.needsYou} need you` : undefined}
        tone="warning"
      />
      <Card>
        {view.items.length === 0 ? (
          <EmptyState title="You're all caught up">Nothing needs your attention.</EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.items.map((item) => (
              <li key={item.key} className="py-1 first:pt-0 last:pb-0">
                <Link
                  href={item.href}
                  className="hover:bg-surface-muted -mx-2 flex flex-col gap-1 rounded-lg px-2 py-2.5 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="text-muted block text-xs">{item.detail}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {item.when ? <span className="text-subtle text-xs">{item.when}</span> : null}
                    <Badge tone={item.tone}>{TONE_WORD[item.tone]}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {team === null ? (
        <p className="text-subtle text-xs">Team updates could not be loaded right now.</p>
      ) : null}
    </Shell>
  );
}
