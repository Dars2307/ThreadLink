import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader, Shell, StatGrid, StatTile } from "@/components/dashboard/shell";
import { SetupWizard } from "@/components/dashboard/setup-wizard";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { getIdentity } from "@/lib/auth/identity";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { deriveHome, EMPTY_TEAM } from "@/lib/dashboard/pages";
import { projectHref } from "@/lib/dashboard/project";
import { controllerName, deriveDashboard } from "@/lib/dashboard/view-model";
import { requestOrigin } from "@/lib/oauth/authorize";

export const metadata: Metadata = { title: "Home · ThreadLink" };

export default async function HomePage() {
  // Defence in depth: proxy.ts already requires a session for this route.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");
  const clerkUser = await currentUser();
  if (!clerkUser || clerkUser.id !== identity.clerkUserId) redirect("/sign-in");

  const [account, team] = await Promise.all([loadAccount(), loadTeam()]);
  if (!account) {
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-semibold">Your account could not be loaded</h1>
          <p className="text-muted pt-1 text-sm">Try again in a moment.</p>
        </Card>
      </Shell>
    );
  }

  const { view, handles } = deriveHome(account, team ?? EMPTY_TEAM);
  const firstName = clerkUser.firstName ?? clerkUser.username ?? null;
  // The setup steps need the session choices; they only render until setup is done.
  const setup = view.setupComplete ? null : deriveDashboard(account);
  const origin = setup ? await requestOrigin() : "";

  return (
    <Shell>
      <PageHeader
        eyebrow={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        title={view.headline.text}
        tone={view.headline.tone}
        badge={view.setupComplete ? "Account active" : "Setup in progress"}
      />

      <StatGrid>
        {view.counts.map((c) => (
          <StatTile key={c.key} label={c.label} value={c.value} />
        ))}
      </StatGrid>

      {setup ? (
        <SetupWizard
          steps={setup.steps}
          origin={origin}
          controllerSessions={setup.controllerSessions}
          agentSessions={setup.agentSessions}
        />
      ) : null}

      <Card labelledBy="active-title">
        <CardTitle
          id="active-title"
          action={
            <Link href="/dashboard/projects" className="text-accent text-sm">
              All projects
            </Link>
          }
        >
          Active
        </CardTitle>
        {team === null ? (
          <p className="text-muted text-sm">Projects could not be loaded right now.</p>
        ) : view.active.length === 0 ? (
          <EmptyState title="No projects yet">
            Ask {controllerName(account.connections)} to “create a ThreadLink project” for a folder
            on your computer.
          </EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.active.map((p) => (
              <li
                key={p.key}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    <Link href={projectHref(handles[p.key]!.roomId!)} className="hover:underline">
                      {p.name}
                    </Link>{" "}
                    <span className="text-subtle font-normal">· {p.team}</span>
                  </p>
                  <p className="text-muted truncate text-xs">{p.summary}</p>
                </div>
                <Badge tone={p.tone}>{p.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {view.needsYou.length ? (
        <Card labelledBy="needs-title">
          <CardTitle
            id="needs-title"
            action={
              <Link href="/dashboard/notifications" className="text-accent text-sm">
                All notifications
              </Link>
            }
          >
            Needs you
          </CardTitle>
          <ul className="flex flex-col gap-2">
            {view.needsYou.slice(0, 5).map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="border-border hover:bg-surface-muted flex flex-col gap-1 rounded-xl border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="text-muted block truncate text-xs">{item.detail}</span>
                  </span>
                  {item.when ? <span className="text-subtle text-xs">{item.when}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Shell>
  );
}
