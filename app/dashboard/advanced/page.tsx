import type { Metadata } from "next";

import { AdvancedPanel } from "@/components/dashboard/advanced";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Card, CardTitle, Mono } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { relativeTime } from "@/lib/dashboard/view-model";
import { runtimeOnline } from "@/lib/runtimes/queries";

export const metadata: Metadata = { title: "Advanced · ThreadLink" };

/** Everything technical: identifiers, fingerprints, heartbeats, manual controls. */
export default async function AdvancedPage() {
  const account = await loadAccount();
  if (!account) {
    return (
      <Shell>
        <Card>Could not load account details.</Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <PageHeader
        title="Advanced"
        description="Identifiers and controls for debugging. Everyday use never needs this page."
      />

      <Card labelledBy="rt-title">
        <CardTitle id="rt-title">Runtimes and workspaces</CardTitle>
        {account.runtimes.length === 0 ? (
          <p className="text-muted text-sm">No Runtimes.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {account.runtimes.map((r) => (
              <li key={r.runtimeId} className="border-border rounded-xl border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.label}
                  <Mono>{r.runtimeId}</Mono>
                </p>
                <p className="text-muted flex flex-wrap gap-x-3 pt-1 text-xs">
                  <span>
                    {r.platform} · {r.kind} · v{r.version ?? "?"} · {r.status}
                    {r.paused ? " · paused" : ""}
                  </span>
                  <span>
                    heartbeat {relativeTime(r.lastSeenAt, account.now)} (
                    {runtimeOnline(r, account.now) ? "online" : "offline"})
                  </span>
                  <span>capabilities: {JSON.stringify(r.capabilities)}</span>
                </p>
                <ul className="text-muted pt-2 text-xs">
                  {account.workspaces
                    .filter((w) => w.runtimeId === r.runtimeId)
                    .map((w) => (
                      <li key={w.workspaceId} className="flex flex-wrap gap-x-3">
                        <Mono>{w.workspaceId}</Mono>
                        <span className="break-all">{w.path}</span>
                        {w.repoRemote ? (
                          <span>
                            {w.repoRemote}
                            {w.branch ? `#${w.branch}` : ""}
                          </span>
                        ) : null}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AdvancedPanel
        defaultOpen
        userId={account.user.id}
        connections={account.connections}
        sessions={account.sessions}
        links={account.links}
        now={account.now}
      />
    </Shell>
  );
}
