import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { updateRuntimeAction } from "@/app/dashboard/actions";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { SettingsNav } from "@/components/dashboard/settings-nav";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { ThemeChoice } from "@/components/dashboard/theme-choice";
import { buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDevices } from "@/lib/dashboard/pages";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = { title: "Settings · ThreadLink" };

const MORE = [
  {
    href: "/dashboard/settings/providers",
    title: "Providers & plans",
    text: "Your Claude and ChatGPT plans, usage policy and paid usage.",
  },
  {
    href: "/dashboard/settings/apps",
    title: "Connected apps",
    text: "Connect ChatGPT, Claude or another MCP client, and manage the apps that can send work.",
  },
  {
    href: "/dashboard/settings/cleanup",
    title: "Cleanup",
    text: "Archive old projects and disconnect devices you no longer use.",
  },
  {
    href: "/dashboard/settings/advanced",
    title: "Advanced",
    text: "Technical details for troubleshooting.",
  },
] as const;

export default async function SettingsPage() {
  const account = await loadAccount();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  if (!account) return <LoadError what="settings" />;
  const { view, handles } = deriveDevices(account);
  const primary = view.devices[0];

  return (
    <Shell>
      <PageHeader title="Settings" />
      <SettingsNav current="/dashboard/settings" />

      <Card labelledBy="general">
        <CardTitle
          id="general"
          description={
            primary
              ? `For ${primary.name}. Applied the next time it checks in.`
              : "Applied to your device the next time it checks in."
          }
        >
          ThreadLink app
        </CardTitle>
        {primary ? (
          <ActionForm action={updateRuntimeAction} className="flex flex-col gap-2">
            <input type="hidden" name="runtimeId" value={handles[primary.key]!.runtimeId} />
            <input type="hidden" name="intent" value="settings" />
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                key={String(primary.settings.autoStart)}
                type="checkbox"
                name="autoStart"
                defaultChecked={primary.settings.autoStart}
              />
              Start ThreadLink when I log in
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                key={String(primary.settings.autoReconnect)}
                type="checkbox"
                name="autoReconnect"
                defaultChecked={primary.settings.autoReconnect}
              />
              Reconnect automatically
            </label>
            <label className="text-muted flex items-center gap-2 text-sm">
              <input
                key={String(primary.settings.notifications)}
                type="checkbox"
                name="notifications"
                defaultChecked={primary.settings.notifications}
              />
              Show desktop notifications
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <SubmitButton>Save</SubmitButton>
              <Link href="/dashboard/devices" className={buttonStyles.ghost}>
                All devices
              </Link>
            </div>
          </ActionForm>
        ) : (
          <EmptyState title="No device yet">
            Install the ThreadLink app to see these options.
          </EmptyState>
        )}
      </Card>

      <Card labelledBy="appearance">
        <CardTitle id="appearance" description="Saved on this browser.">
          Appearance
        </CardTitle>
        <ThemeChoice theme={theme} />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {MORE.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="border-border bg-surface shadow-card hover:border-border-strong flex flex-col gap-1 rounded-2xl border p-5 transition-colors"
          >
            <span className="text-sm font-semibold">{m.title} →</span>
            <span className="text-muted text-sm">{m.text}</span>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
