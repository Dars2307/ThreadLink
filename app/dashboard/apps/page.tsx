import type { Metadata } from "next";

import { RevokeConnectionButton } from "@/components/connections/revoke-connection-button";
import { CopyField } from "@/components/copy-button";
import { ConnectedApps } from "@/components/dashboard/overview";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { PLATFORM_LABELS } from "@/lib/connections/model";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDashboard, relativeTime } from "@/lib/dashboard/view-model";
import { requestOrigin } from "@/lib/oauth/authorize";

export const metadata: Metadata = { title: "Apps · ThreadLink" };

/** Chat apps connected to ThreadLink (ChatGPT, Claude, other MCP clients). */
export default async function AppsPage() {
  const account = await loadAccount();
  if (!account) {
    return (
      <Shell>
        <Card>Could not load your apps.</Card>
      </Shell>
    );
  }
  const view = deriveDashboard(account);
  const origin = await requestOrigin();
  const clients = account.connections.filter(
    (c) => c.role === "controller" && c.status !== "revoked",
  );

  return (
    <Shell>
      <PageHeader
        title="Apps"
        description="Chat apps that can send work to your Claude conversations."
      />

      <ConnectedApps apps={view.apps} />

      <Card labelledBy="add-title">
        <CardTitle
          id="add-title"
          description="In ChatGPT: Settings → Apps &amp; Connectors → create a connector with this URL and sign in. Claude uses the same URL."
        >
          Connect a chat app
        </CardTitle>
        <CopyField label="ThreadLink connector URL" value={`${origin}/mcp`} />
      </Card>

      <Card labelledBy="clients-title">
        <CardTitle
          id="clients-title"
          description="Each app keeps its own connection; revoke any at any time."
        >
          Connected clients
        </CardTitle>
        {clients.length === 0 ? (
          <EmptyState title="No chat apps connected yet">Add one with the URL above.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((c) => (
              <li
                key={c.id}
                className="border-border flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {c.displayName ?? PLATFORM_LABELS[c.platform]}
                    <Badge tone="neutral">{PLATFORM_LABELS[c.platform]}</Badge>
                  </p>
                  <p className="text-muted text-xs">
                    Added {relativeTime(c.createdAt, account.now)} · last used{" "}
                    {relativeTime(c.lastSeenAt, account.now)}
                  </p>
                </div>
                <RevokeConnectionButton connectionId={c.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
