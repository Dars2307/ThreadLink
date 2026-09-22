import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { revokeRuntimeAction, updateRuntimeAction } from "@/app/dashboard/actions";
import { RevokeConnectionButton } from "@/components/connections/revoke-connection-button";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { ThemeChoice } from "@/components/dashboard/theme-choice";
import { Badge, buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { PLATFORM_LABELS } from "@/lib/connections/model";
import { loadAccount } from "@/lib/dashboard/data";
import { conversationMode, conversationName, deriveDashboard } from "@/lib/dashboard/view-model";
import { KIND_NAMES, PLATFORM_NAMES } from "@/lib/runtimes/queries";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = { title: "Settings · ThreadLink" };

export default async function SettingsPage() {
  const account = await loadAccount();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  if (!account) {
    return (
      <Shell>
        <Card>Could not load settings.</Card>
      </Shell>
    );
  }
  const view = deriveDashboard(account);
  const primary = view.runtimeTree[0];
  const attached = view.agentSessions;

  return (
    <Shell>
      <PageHeader title="Settings" />

      <Card labelledBy="general">
        <CardTitle
          id="general"
          description="Applied to your Runtime the next time it checks in - including remote ones."
        >
          General
        </CardTitle>
        {primary ? (
          <form action={updateRuntimeAction} className="flex flex-col gap-2">
            <input type="hidden" name="runtimeId" value={primary.runtimeId} />
            <input type="hidden" name="intent" value="settings" />
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="autoStart"
                defaultChecked={primary.settings.autoStart !== false}
              />{" "}
              Start ThreadLink when I log in
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="autoReconnect"
                defaultChecked={primary.settings.autoReconnect !== false}
              />{" "}
              Reconnect automatically
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="notifications"
                defaultChecked={primary.settings.notifications !== false}
              />{" "}
              Show desktop notifications
            </label>
            <button type="submit" className={`${buttonStyles.secondary} w-fit`}>
              Save
            </button>
          </form>
        ) : (
          <EmptyState title="No Runtime yet">
            Install the ThreadLink app to see these options.
          </EmptyState>
        )}
      </Card>

      <Card labelledBy="appearance">
        <CardTitle id="appearance" description="Saved on this device.">
          Appearance
        </CardTitle>
        <ThemeChoice theme={theme} />
      </Card>

      <Card labelledBy="runtime">
        <CardTitle id="runtime" description="The computer or environment that runs your requests.">
          Runtime
        </CardTitle>
        {primary ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{primary.label}</p>
                <p className="text-muted text-xs">
                  {PLATFORM_NAMES[primary.platform]} · {KIND_NAMES[primary.kind]}
                  {primary.version ? ` · v${primary.version}` : ""}
                </p>
              </div>
              <Badge tone={primary.paused ? "neutral" : primary.online ? "success" : "warning"}>
                {primary.paused
                  ? "Paused"
                  : primary.online
                    ? "Online"
                    : `Last seen ${primary.lastSeen}`}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <form action={updateRuntimeAction}>
                <input type="hidden" name="runtimeId" value={primary.runtimeId} />
                <input type="hidden" name="intent" value="restart" />
                <button type="submit" className={buttonStyles.ghost}>
                  Restart Runtime
                </button>
              </form>
              <Link href="/dashboard/runtimes" className={buttonStyles.ghost}>
                All Runtimes
              </Link>
            </div>
          </div>
        ) : (
          <EmptyState title="No Runtime connected">
            Install the ThreadLink app, or run{" "}
            <code className="font-mono">npx threadlink setup</code>.
          </EmptyState>
        )}
      </Card>

      <Card labelledBy="claude">
        <CardTitle id="claude" description="Detected on your Runtime.">
          Claude Code
        </CardTitle>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">
            {primary
              ? primary.claudeAvailable
                ? "Claude Code is installed and available."
                : "Claude Code was not detected on this Runtime."
              : "No Runtime yet."}
          </p>
          {attached.length === 0 ? (
            <p className="text-muted">No conversation attached yet.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {attached.map((s) => (
                <li key={s.sessionId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{conversationName(s, null)}</p>
                    <p className="text-muted text-xs">{conversationMode(s)}</p>
                  </div>
                  <Badge tone={s.busy ? "warning" : "success"}>
                    {s.busy ? "In use" : "Available"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="text-subtle text-xs">
            To change which conversation is used, open the ThreadLink app on that computer (or run{" "}
            <code className="font-mono">npx threadlink attach</code>).
          </p>
        </div>
      </Card>

      <Card labelledBy="security">
        <CardTitle id="security" description="Everything connected to your account.">
          Security
        </CardTitle>
        <div className="flex flex-col gap-4 text-sm">
          <div>
            <h3 className="pb-2 font-medium">Chat apps</h3>
            <ul className="flex flex-col gap-2">
              {account.connections
                .filter((c) => c.role === "controller" && c.status !== "revoked")
                .map((c) => (
                  <li
                    key={c.id}
                    className="border-border flex items-center justify-between gap-3 rounded-xl border p-3"
                  >
                    <span>{c.displayName ?? PLATFORM_LABELS[c.platform]}</span>
                    <RevokeConnectionButton connectionId={c.id} />
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <h3 className="pb-2 font-medium">Devices (Runtimes)</h3>
            <ul className="flex flex-col gap-2">
              {view.runtimeTree.map((r) => (
                <li
                  key={r.runtimeId}
                  className="border-border flex items-center justify-between gap-3 rounded-xl border p-3"
                >
                  <span>
                    {r.label}
                    <span className="text-subtle"> · {PLATFORM_NAMES[r.platform]}</span>
                  </span>
                  <form action={revokeRuntimeAction}>
                    <input type="hidden" name="runtimeId" value={r.runtimeId} />
                    <button type="submit" className={buttonStyles.danger}>
                      Disconnect
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </Shell>
  );
}
