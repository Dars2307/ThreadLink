import type { Metadata } from "next";

import { revokeRuntimeAction, updateRuntimeAction } from "@/app/dashboard/actions";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDashboard } from "@/lib/dashboard/view-model";
import { KIND_NAMES, PLATFORM_NAMES } from "@/lib/runtimes/queries";

export const metadata: Metadata = { title: "Runtimes · ThreadLink" };

const CAPABILITY_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-resume": "Continue existing conversations",
  "interactive-session-discovery": "Find your conversations",
  codex: "Codex",
  nova: "Nova",
};

/** Devices and environments that can run your requests. */
export default async function RuntimesPage() {
  const account = await loadAccount();
  if (!account) {
    return (
      <Shell>
        <Card>Could not load your Runtimes.</Card>
      </Shell>
    );
  }
  const view = deriveDashboard(account);

  return (
    <Shell>
      <PageHeader
        title="Runtimes"
        description="A Runtime is a computer or environment where ThreadLink can reach Claude Code: your laptop, an SSH host, a Codespace or a cloud VM."
      />

      {view.runtimeTree.length === 0 ? (
        <Card>
          <EmptyState title="No Runtime connected">
            Install the ThreadLink app, or run{" "}
            <code className="font-mono">npx threadlink setup</code> on a server or cloud
            environment.
          </EmptyState>
        </Card>
      ) : null}

      {view.runtimeTree.map((r) => (
        <Card key={r.runtimeId} labelledBy={`rt-${r.runtimeId}`}>
          <CardTitle
            id={`rt-${r.runtimeId}`}
            description={`${PLATFORM_NAMES[r.platform]} · ${KIND_NAMES[r.kind]}${r.version ? ` · v${r.version}` : ""}`}
            action={
              <Badge tone={r.paused ? "neutral" : r.online ? "success" : "warning"}>
                {r.paused ? "Paused" : r.online ? "Online" : `Last seen ${r.lastSeen}`}
              </Badge>
            }
          >
            {r.label}
          </CardTitle>

          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {Object.entries(r.capabilities)
                .filter(([key]) => key in CAPABILITY_LABELS)
                .map(([key, value]) => (
                  <Badge key={key} tone={value === "available" ? "success" : "neutral"}>
                    {CAPABILITY_LABELS[key]}:{" "}
                    {value === "available" ? "available" : "not available"}
                  </Badge>
                ))}
            </div>

            <div>
              <h3 className="text-sm font-medium">Workspaces</h3>
              {r.workspaces.length === 0 ? (
                <p className="text-muted pt-1 text-sm">None yet.</p>
              ) : (
                <ul className="text-muted flex flex-col gap-1 pt-1 text-sm">
                  {r.workspaces.map((w) => (
                    <li key={w.workspaceId}>
                      {w.name}
                      {w.conversations.length
                        ? ` · ${w.conversations.length} conversation${w.conversations.length === 1 ? "" : "s"}`
                        : ""}
                      {w.repoRemote ? ` · ${w.repoRemote}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form action={updateRuntimeAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="runtimeId" value={r.runtimeId} />
              <input type="hidden" name="intent" value="rename" />
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-subtle text-xs">Name</span>
                <input
                  name="label"
                  defaultValue={r.label}
                  maxLength={100}
                  className="border-border-strong bg-surface rounded-lg border px-3 py-2"
                />
              </label>
              <button type="submit" className={buttonStyles.secondary}>
                Rename
              </button>
            </form>

            <form action={updateRuntimeAction} className="flex flex-col gap-2">
              <input type="hidden" name="runtimeId" value={r.runtimeId} />
              <input type="hidden" name="intent" value="settings" />
              <label className="text-muted flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="autoStart"
                  defaultChecked={r.settings.autoStart !== false}
                />{" "}
                Start when I log in
              </label>
              <label className="text-muted flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="autoReconnect"
                  defaultChecked={r.settings.autoReconnect !== false}
                />{" "}
                Reconnect automatically
              </label>
              <label className="text-muted flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="notifications"
                  defaultChecked={r.settings.notifications !== false}
                />{" "}
                Show notifications
              </label>
              <button type="submit" className={`${buttonStyles.secondary} w-fit`}>
                Save settings
              </button>
            </form>

            <div className="border-border flex flex-wrap gap-2 border-t pt-3">
              <form action={updateRuntimeAction}>
                <input type="hidden" name="runtimeId" value={r.runtimeId} />
                <input type="hidden" name="intent" value={r.paused ? "resume" : "pause"} />
                <button type="submit" className={buttonStyles.ghost}>
                  {r.paused ? "Resume" : "Pause"}
                </button>
              </form>
              <form action={updateRuntimeAction}>
                <input type="hidden" name="runtimeId" value={r.runtimeId} />
                <input type="hidden" name="intent" value="restart" />
                <button type="submit" className={buttonStyles.ghost}>
                  Restart
                </button>
              </form>
              <form action={revokeRuntimeAction}>
                <input type="hidden" name="runtimeId" value={r.runtimeId} />
                <button type="submit" className={buttonStyles.danger}>
                  Disconnect device
                </button>
              </form>
            </div>
          </div>
        </Card>
      ))}
    </Shell>
  );
}
