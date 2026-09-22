import { SignOutButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdvancedPanel } from "@/components/dashboard/advanced";
import { ConnectedApps, CurrentLinks, RecentActivity } from "@/components/dashboard/overview";
import { SetupWizard } from "@/components/dashboard/setup-wizard";
import { Badge, buttonStyles, Card } from "@/components/ui";
import { getIdentity } from "@/lib/auth/identity";
import { requireThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { Connection } from "@/lib/connections/model";
import { listMyConnections } from "@/lib/connections/repository";
import { deriveDashboard } from "@/lib/dashboard/view-model";
import { requestOrigin } from "@/lib/oauth/authorize";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerSession } from "@/lib/sessions/queries";
import { listMyRecentTasks, listMySessions, listMyThreadLinks } from "@/lib/sessions/repository";
import type { RecentTask } from "@/lib/tasks/queries";

export const metadata: Metadata = {
  title: "Dashboard · ThreadLink",
};

type AccountState =
  | {
      ok: true;
      user: ThreadLinkUser;
      connections: Connection[];
      sessions: OwnerSession[];
      links: ThreadLinkView[];
      tasks: RecentTask[];
      renderedAt: number;
    }
  | { ok: false };

async function loadAccount(): Promise<AccountState> {
  try {
    const user = await requireThreadLinkUser();
    const [connections, sessions, links, tasks] = await Promise.all([
      listMyConnections(),
      listMySessions(),
      listMyThreadLinks(),
      listMyRecentTasks(),
    ]);
    return { ok: true, user, connections, sessions, links, tasks, renderedAt: Date.now() };
  } catch {
    // Fail closed without leaking why (auth, database or mapping failure).
    return { ok: false };
  }
}

export default async function DashboardPage() {
  // Defence in depth: proxy.ts already requires a session for this route.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");

  // Profile fields are for display only. Never use them for authorization.
  const clerkUser = await currentUser();
  if (!clerkUser || clerkUser.id !== identity.clerkUserId) redirect("/sign-in");
  const firstName = clerkUser.firstName ?? clerkUser.username ?? null;

  const account = await loadAccount();
  if (!account.ok) {
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-semibold">Your account could not be loaded</h1>
          <p className="text-muted pt-1 text-sm">
            Nothing is wrong with your connections - try again in a moment.
          </p>
        </Card>
      </Shell>
    );
  }

  const origin = await requestOrigin();
  const view = deriveDashboard({
    connections: account.connections,
    sessions: account.sessions,
    links: account.links,
    tasks: account.tasks,
    now: account.renderedAt,
  });

  return (
    <Shell>
      <header className="flex flex-col gap-3">
        <p className="text-muted text-sm">
          {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {view.headline.text}
          </h1>
          <Badge tone={view.headline.tone}>
            {view.setupComplete ? "Account active" : "Setup in progress"}
          </Badge>
        </div>
      </header>

      {view.setupComplete ? null : (
        <SetupWizard
          steps={view.steps}
          origin={origin}
          controllerSessions={view.controllerSessions}
          agentSessions={view.agentSessions}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ConnectedApps apps={view.apps} />
        <CurrentLinks links={view.links} />
      </div>

      <RecentActivity activity={view.activity} />

      <AdvancedPanel
        userId={account.user.id}
        connections={account.connections}
        sessions={account.sessions}
        links={account.links}
        now={account.renderedAt}
      />

      <div>
        <SignOutButton>
          <button type="button" className={buttonStyles.ghost}>
            Sign out
          </button>
        </SignOutButton>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:py-12">
      {children}
    </div>
  );
}
