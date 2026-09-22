import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import type { deriveDashboard } from "@/lib/dashboard/view-model";

type View = ReturnType<typeof deriveDashboard>;

export function ConnectedApps({ apps }: { apps: View["apps"] }) {
  return (
    <Card labelledBy="apps-title">
      <CardTitle id="apps-title">Connected apps</CardTitle>
      <ul className="divide-border flex flex-col divide-y">
        {apps.map((app) => (
          <li
            key={app.platform}
            className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <AppMark platform={app.platform} />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {app.label}
                  {app.count > 1 ? <span className="text-subtle"> · {app.count}</span> : null}
                </p>
                <p className="text-muted truncate text-xs">{app.detail}</p>
              </div>
            </div>
            <Badge tone={app.connected ? "success" : "neutral"}>
              {app.connected ? "Connected" : "Not connected"}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AppMark({ platform }: { platform: string }) {
  const letter = platform === "chatgpt" ? "G" : platform === "generic-mcp" ? "M" : "C";
  return (
    <span
      aria-hidden
      className="bg-surface-muted text-muted flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
    >
      {letter}
    </span>
  );
}

export function CurrentLinks({ links }: { links: View["links"] }) {
  return (
    <Card labelledBy="links-title">
      <CardTitle
        id="links-title"
        description="Say “send this to Claude” in the linked conversation. Results come back there."
      >
        Current link{links.length > 1 ? "s" : ""}
      </CardTitle>
      {links.length === 0 ? (
        <EmptyState title="No conversation is linked yet">
          Finish the setup steps above to link ChatGPT to Claude Code.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {links.map((link) => (
            <li key={link.linkId} className="border-border rounded-xl border p-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-subtle text-xs">{link.controllerApp}</p>
                    <p className="truncate text-sm font-medium">{link.controllerLabel}</p>
                  </div>
                  <Badge tone={link.ready ? "success" : "warning"}>
                    {link.ready ? "Ready" : "Bridge offline"}
                  </Badge>
                </div>
                <div aria-hidden className="text-subtle flex items-center gap-2 pl-1">
                  <span className="text-lg leading-none">↕</span>
                  <span className="bg-border h-px flex-1" />
                </div>
                <div className="min-w-0">
                  <p className="text-subtle text-xs">
                    Claude Code{link.workspace ? ` · ${link.workspace}` : ""}
                  </p>
                  <p className="truncate text-sm font-medium">{link.agentLabel}</p>
                  <p className="text-muted text-xs">{link.agentDetail}</p>
                  {!link.ready ? (
                    <p className="text-warning pt-1 text-xs">
                      Last seen {link.lastSeen}. Start it with{" "}
                      <code className="font-mono">threadlink-bridge run</code>.
                    </p>
                  ) : null}
                </div>
                <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <details className="group text-sm">
                    <summary className="text-accent hover:text-accent-hover cursor-pointer font-medium">
                      Change Claude session
                    </summary>
                    <p className="text-muted pt-2">
                      In that project folder run{" "}
                      <code className="font-mono">threadlink-bridge attach</code> and pick another
                      session. The link stays the same.
                    </p>
                  </details>
                  <RevokeLinkButton linkId={link.linkId} label="Unlink" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RecentActivity({ activity }: { activity: View["activity"] }) {
  return (
    <Card labelledBy="activity-title">
      <CardTitle id="activity-title">Recent activity</CardTitle>
      {activity.length === 0 ? (
        <EmptyState title="Nothing sent yet">Tasks you send to Claude appear here.</EmptyState>
      ) : (
        <ul className="divide-border flex flex-col divide-y">
          {activity.map((item) => (
            <li
              key={item.taskId}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-muted text-xs">
                  {item.route} · {item.when}
                </p>
              </div>
              <Badge tone={item.tone}>{item.statusLabel}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
