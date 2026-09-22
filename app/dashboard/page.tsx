import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  ConnectedApps,
  CurrentLinks,
  RecentActivity,
  RuntimeSummary,
} from "@/components/dashboard/overview";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { SetupWizard } from "@/components/dashboard/setup-wizard";
import { Card } from "@/components/ui";
import { getIdentity } from "@/lib/auth/identity";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDashboard } from "@/lib/dashboard/view-model";
import { requestOrigin } from "@/lib/oauth/authorize";

export const metadata: Metadata = { title: "Overview · ThreadLink" };

export default async function OverviewPage() {
  // Defence in depth: proxy.ts already requires a session for this route.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");
  const clerkUser = await currentUser();
  if (!clerkUser || clerkUser.id !== identity.clerkUserId) redirect("/sign-in");

  const account = await loadAccount();
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

  const origin = await requestOrigin();
  const view = deriveDashboard(account);
  const firstName = clerkUser.firstName ?? clerkUser.username ?? null;

  return (
    <Shell>
      <PageHeader
        eyebrow={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        title={view.headline.text}
        tone={view.headline.tone}
        badge={view.setupComplete ? "Account active" : "Setup in progress"}
      />

      {view.setupComplete ? null : (
        <SetupWizard
          steps={view.steps}
          origin={origin}
          controllerSessions={view.controllerSessions}
          agentSessions={view.agentSessions}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-6">
          <ConnectedApps apps={view.apps} />
          <RuntimeSummary runtimes={view.runtimeTree} />
        </div>
        <CurrentLinks links={view.links} />
      </div>

      <RecentActivity activity={view.activity} />
    </Shell>
  );
}
