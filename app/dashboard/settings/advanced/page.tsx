import type { Metadata } from "next";

import { TechnicalDetails } from "@/components/dashboard/advanced";
import { SettingsNav } from "@/components/dashboard/settings-nav";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";

export const metadata: Metadata = { title: "Advanced · ThreadLink" };

/** Settings → Advanced → Technical details: the only page that shows raw identifiers. */
export default async function AdvancedPage() {
  const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
  if (!account) return <LoadError what="account details" />;

  return (
    <Shell>
      <PageHeader title="Settings" />
      <SettingsNav current="/dashboard/settings/advanced" />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Technical details</h2>
        <p className="text-muted max-w-2xl text-sm">
          Identifiers, credential prefixes and heartbeats for troubleshooting or support. Everyday
          use never needs this page.
        </p>
      </div>
      <TechnicalDetails
        userId={account.user.id}
        connections={account.connections}
        sessions={account.sessions}
        links={account.links}
        tasks={account.tasks}
        runtimes={account.runtimes}
        workspaces={account.workspaces}
        team={team}
        now={account.now}
      />
    </Shell>
  );
}
