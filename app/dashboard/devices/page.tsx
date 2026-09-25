import type { Metadata } from "next";
import Link from "next/link";

import { updateRuntimeAction } from "@/app/dashboard/actions";
import { disconnectDeviceAction, renameDeviceAction } from "@/app/dashboard/team-actions";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, EmptyState } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDevices, type DeviceCard } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Devices · ThreadLink" };

const field = "border-border-strong bg-surface rounded-lg border px-3 py-2 text-sm";

function DeviceHeader({ d }: { d: DeviceCard }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold tracking-tight">{d.name}</h2>
        <p className="text-muted text-sm">
          {d.platform} · {d.kind}
          {d.version ? ` · ${d.version}` : ""}
        </p>
        <p className="text-subtle pt-0.5 text-xs">{d.lastSeen}</p>
      </div>
      <Badge tone={d.tone}>{d.statusLabel}</Badge>
    </div>
  );
}

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const showDisconnected = (await searchParams).disconnected === "1";
  const account = await loadAccount();
  if (!account) return <LoadError what="your devices" />;
  const { view, handles } = deriveDevices(account, { showDisconnected });

  return (
    <Shell>
      <PageHeader
        title="Devices"
        description="Computers and environments where the ThreadLink app runs Claude Code and Codex for you."
        actions={
          view.disconnectedCount ? (
            <Link
              href={showDisconnected ? "/dashboard/devices" : "/dashboard/devices?disconnected=1"}
              className={buttonStyles.ghost}
            >
              {showDisconnected
                ? "Hide disconnected devices"
                : `Show disconnected devices (${view.disconnectedCount})`}
            </Link>
          ) : null
        }
      />

      {view.devices.length === 0 ? (
        <Card>
          <EmptyState title="No device connected">
            Install the ThreadLink app, or run{" "}
            <code className="font-mono">npx threadlink setup</code> on a server or cloud
            environment.
          </EmptyState>
        </Card>
      ) : null}

      {view.devices.map((d) => {
        const runtimeId = handles[d.key]!.runtimeId!;
        return (
          <Card key={d.key} as="article">
            <div className="flex flex-col gap-4">
              <DeviceHeader d={d} />

              {d.agents.length ? (
                <div className="flex flex-wrap gap-2">
                  {d.agents.map((a) => (
                    <Badge key={a.name} tone={a.available ? "success" : "neutral"}>
                      {a.name}
                      {a.available ? "" : " not found"}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {d.folders.length ? (
                <div>
                  <h3 className="text-subtle text-xs font-medium">Folders</h3>
                  <ul className="text-muted flex flex-col gap-0.5 pt-1 text-sm">
                    {d.folders.map((f) => (
                      <li key={f.key}>
                        {f.name}
                        {f.conversations
                          ? ` · ${f.conversations} conversation${f.conversations === 1 ? "" : "s"}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <details>
                <summary className="text-muted hover:text-foreground cursor-pointer text-sm">
                  Device settings
                </summary>
                <form
                  action={updateRuntimeAction}
                  className="bg-surface-muted mt-2 flex flex-col gap-2 rounded-xl p-4"
                >
                  <input type="hidden" name="runtimeId" value={runtimeId} />
                  <input type="hidden" name="intent" value="settings" />
                  <label className="text-muted flex items-center gap-2 text-sm">
                    <input type="checkbox" name="autoStart" defaultChecked={d.settings.autoStart} />
                    Start when I log in
                  </label>
                  <label className="text-muted flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="autoReconnect"
                      defaultChecked={d.settings.autoReconnect}
                    />
                    Reconnect automatically
                  </label>
                  <label className="text-muted flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="notifications"
                      defaultChecked={d.settings.notifications}
                    />
                    Show notifications
                  </label>
                  <button type="submit" className={`${buttonStyles.secondary} w-fit`}>
                    Save settings
                  </button>
                </form>
              </details>

              <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
                <details>
                  <summary className={`${buttonStyles.ghost} cursor-pointer`}>Rename</summary>
                  <form
                    action={renameDeviceAction}
                    className="bg-surface-muted mt-2 flex flex-wrap items-end gap-2 rounded-xl p-3"
                  >
                    <input type="hidden" name="runtimeId" value={runtimeId} />
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-subtle text-xs">Name</span>
                      <input
                        name="label"
                        defaultValue={d.name}
                        required
                        maxLength={100}
                        className={field}
                      />
                    </label>
                    <button type="submit" className={buttonStyles.secondary}>
                      Save
                    </button>
                  </form>
                </details>
                <form action={updateRuntimeAction}>
                  <input type="hidden" name="runtimeId" value={runtimeId} />
                  <input type="hidden" name="intent" value={d.paused ? "resume" : "pause"} />
                  <button type="submit" className={buttonStyles.ghost}>
                    {d.paused ? "Resume" : "Pause"}
                  </button>
                </form>
                <form action={updateRuntimeAction}>
                  <input type="hidden" name="runtimeId" value={runtimeId} />
                  <input type="hidden" name="intent" value="restart" />
                  <button type="submit" className={buttonStyles.ghost}>
                    Restart
                  </button>
                </form>
                <ConfirmAction
                  action={disconnectDeviceAction}
                  fields={{ runtimeId }}
                  label="Disconnect"
                  title={`Disconnect ${d.name}?`}
                  confirmLabel="Disconnect device"
                >
                  <p>
                    This signs the device out of ThreadLink: its credential stops working at once
                    and work waiting for it is not delivered.
                  </p>
                  <p>To reconnect it later, sign in again from the ThreadLink app on it.</p>
                  <p>Nothing on the device itself is deleted.</p>
                </ConfirmAction>
              </div>
            </div>
          </Card>
        );
      })}

      {view.showingDisconnected ? (
        <section aria-labelledby="disconnected" className="flex flex-col gap-3">
          <h2 id="disconnected" className="text-sm font-semibold">
            Disconnected devices
          </h2>
          <p className="text-muted text-sm">
            Kept for your history. They cannot reach ThreadLink until they sign in again.
          </p>
          {view.disconnected.map((d) => (
            <Card key={d.key} as="article" className="opacity-80">
              <DeviceHeader d={d} />
            </Card>
          ))}
        </section>
      ) : null}
    </Shell>
  );
}
