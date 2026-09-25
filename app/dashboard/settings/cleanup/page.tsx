import type { Metadata } from "next";

import {
  archiveInactiveProjectsAction,
  disconnectOfflineDevicesAction,
} from "@/app/dashboard/team-actions";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { SettingsNav } from "@/components/dashboard/settings-nav";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card } from "@/components/ui";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { deriveCleanup, EMPTY_TEAM } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Cleanup · ThreadLink" };

function Names({ names, count }: { names: string[]; count: number }) {
  if (!count) return null;
  return (
    <p className="text-muted text-xs">
      {names.join(", ")}
      {count > names.length ? ` and ${count - names.length} more` : ""}
    </p>
  );
}

export default async function CleanupPage() {
  const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
  if (!account) return <LoadError what="cleanup" />;
  const { view } = deriveCleanup(account, team ?? EMPTY_TEAM);

  return (
    <Shell>
      <PageHeader title="Settings" />
      <SettingsNav current="/dashboard/settings/cleanup" />

      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Cleanup</h2>
        <p className="text-muted max-w-2xl text-sm">
          Tidy up what ThreadLink shows you. ThreadLink never deletes your code or repositories.
        </p>
      </div>

      <Card as="article">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Archive inactive projects</h3>
            <Badge tone={view.projects.count ? "accent" : "neutral"}>
              {view.projects.count} found
            </Badge>
          </div>
          <p className="text-muted text-sm">{view.projects.text}</p>
          <Names names={view.projects.names} count={view.projects.count} />
          {team === null ? (
            <p className="text-subtle text-xs">Projects could not be loaded right now.</p>
          ) : view.projects.count ? (
            <div>
              <ConfirmAction
                action={archiveInactiveProjectsAction}
                fields={{}}
                label={`Archive ${view.projects.count} project${view.projects.count === 1 ? "" : "s"}`}
                title="Archive inactive projects?"
                confirmLabel="Archive"
                tone="primary"
              >
                <p>They move to “Show archived” on the Projects page, with their history kept.</p>
                <p>You can restore any of them at any time. No files are touched.</p>
              </ConfirmAction>
            </div>
          ) : null}
        </div>
      </Card>

      <Card as="article">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Disconnect offline devices</h3>
            <Badge tone={view.devices.count ? "accent" : "neutral"}>
              {view.devices.count} found
            </Badge>
          </div>
          <p className="text-muted text-sm">{view.devices.text}</p>
          <Names names={view.devices.names} count={view.devices.count} />
          {view.devices.count ? (
            <div>
              <ConfirmAction
                action={disconnectOfflineDevicesAction}
                fields={{}}
                label={`Disconnect ${view.devices.count} device${view.devices.count === 1 ? "" : "s"}`}
                title="Disconnect offline devices?"
                confirmLabel="Disconnect"
              >
                <p>
                  Their credentials stop working. Each device must sign in again from the ThreadLink
                  app to reconnect.
                </p>
                <p>
                  They stay listed under “Show disconnected devices”. Nothing on them is deleted.
                </p>
              </ConfirmAction>
            </div>
          ) : null}
        </div>
      </Card>

      <Card as="article">
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">Task history and local files</h3>
          <p className="text-muted text-sm">
            Task history is kept as titles and statuses only, and there is no option to hide it yet.
            Worktrees and caches on your computer are managed by the ThreadLink app there, not from
            this page.
          </p>
        </div>
      </Card>
    </Shell>
  );
}
