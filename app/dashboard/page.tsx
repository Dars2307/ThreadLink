import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader, Shell, StatGrid, StatTile } from "@/components/dashboard/shell";
import { ModeBadge } from "@/components/dashboard/chats";
import { MissionControl } from "@/components/dashboard/mission-control";
import { OnboardingCard } from "@/components/dashboard/onboarding";
import { SetupWizard } from "@/components/dashboard/setup-wizard";
import { Badge, buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { getIdentity } from "@/lib/auth/identity";
import { chatHref, homeChats, type ChatRow } from "@/lib/dashboard/chats";
import { loadChats } from "@/lib/dashboard/chats-data";
import { profileHealth } from "@/lib/dashboard/agents";
import { loadAccount, loadProjectChoices, loadProviders, loadTeam } from "@/lib/dashboard/data";
import { onboarding } from "@/lib/dashboard/onboarding";
import { deriveHome, EMPTY_TEAM } from "@/lib/dashboard/pages";
import { projectHref } from "@/lib/dashboard/project";
import { providerDisplay } from "@/lib/dashboard/providers-display";
import { healthFreshness } from "@/lib/dashboard/timeline";
import { controllerName, deriveDashboard } from "@/lib/dashboard/view-model";
import { requestOrigin } from "@/lib/oauth/authorize";

export const metadata: Metadata = { title: "Home · ThreadLink" };

export default async function HomePage() {
  // Defence in depth: proxy.ts already requires a session for this route.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");
  const clerkUser = await currentUser();
  if (!clerkUser || clerkUser.id !== identity.clerkUserId) redirect("/sign-in");

  const [account, team, chats, providers, rooms] = await Promise.all([
    loadAccount(),
    loadTeam(),
    loadChats(),
    loadProviders(),
    loadProjectChoices(),
  ]);
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
  const home = chats ? homeChats(chats, account.now) : null;
  const chatLink = (row: ChatRow) => chatHref(home!.handles[row.key]!.chatId!);
  const firstName = clerkUser.firstName ?? clerkUser.username ?? null;
  // Always derive the full view model — activity goes to Mission Control, setup
  // steps only render until setup is done.
  const dashView = deriveDashboard(account);
  const setup = view.setupComplete ? null : dashView;
  const origin = setup ? await requestOrigin() : "";
  // First run: connect agents → create the first chat. "Ready" counts only when freshly checked.
  const profiles = providers?.profiles ?? [];
  const readyAgents = profiles
    .filter((p) => {
      const h = profileHealth(p);
      return healthFreshness(h.health, h.checkedAt, account.now).state === "ready";
    })
    .map((p) => providerDisplay(p.provider).name);
  const firstRun = onboarding({
    chats: chats?.length ?? 1,
    readyAgents,
    detectedAgents: profiles.filter((p) => p.detected.installed === true || p.detectedAt).length,
  });
  const projectChoices = (rooms ?? [])
    .filter((r) => !r.archived)
    .map((r, i) => ({ key: `p${i}`, name: r.name, id: r.roomId }));

  return (
    <Shell>
      <OnboardingCard model={firstRun} projects={projectChoices} />
      <PageHeader
        eyebrow={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        title={view.headline.text}
        tone={view.headline.tone}
        badge={view.setupComplete ? "Account active" : "Setup in progress"}
        actions={
          <Link href="/dashboard/chats#new-chat" className={buttonStyles.primary}>
            New chat
          </Link>
        }
      />

      {home && home.view.attention.length ? (
        <Card labelledBy="attention-title">
          <CardTitle id="attention-title" description="These chats are waiting for you.">
            Needs attention
          </CardTitle>
          <ul className="flex flex-col gap-2">
            {home.view.attention.map((row) => (
              <li key={row.key}>
                <Link
                  href={chatLink(row)}
                  className="border-warning/40 hover:bg-surface-muted flex flex-col gap-1 rounded-xl border px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{row.name}</span>
                    <span className="text-muted block truncate text-xs">{row.preview}</span>
                  </span>
                  <span className="text-subtle text-xs">{row.when}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card labelledBy="chats-title">
        <CardTitle
          id="chats-title"
          action={
            <Link href="/dashboard/chats" className="text-accent text-sm">
              All chats
            </Link>
          }
        >
          Chats
        </CardTitle>
        {home === null ? (
          <p className="text-muted text-sm">Chats could not be loaded right now.</p>
        ) : home.view.recent.length === 0 ? (
          <EmptyState title="No chats yet">
            Start one with New chat: talk to one agent, two, or the whole team. Pick a project so
            the agents know which folder to work in.
          </EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {home.view.recent.map((row) => (
              <li key={row.key} className="py-3 first:pt-0 last:pb-0">
                <Link href={chatLink(row)} className="group flex flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      className={
                        row.unread
                          ? "truncate text-sm font-semibold group-hover:underline"
                          : "truncate text-sm font-medium group-hover:underline"
                      }
                    >
                      {row.name}
                    </span>
                    <ModeBadge badge={row.modeBadge} mode={row.mode} />
                    {row.pinned ? <span className="text-subtle text-xs">Pinned</span> : null}
                    {row.working ? <Badge tone="accent">Working</Badge> : null}
                    <span className="text-subtle ml-auto text-xs">{row.when}</span>
                  </span>
                  <span className="text-muted truncate text-xs">
                    {row.participants}
                    {row.project ? ` · ${row.project}` : ""}
                  </span>
                  <span className="text-subtle truncate text-sm">{row.preview}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <StatGrid>
        {view.counts.map((c) => (
          <StatTile key={c.key} label={c.label} value={c.value} />
        ))}
      </StatGrid>

      <MissionControl activity={dashView.activity} />

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
          Projects
        </CardTitle>
        {team === null ? (
          <p className="text-muted text-sm">Projects could not be loaded right now.</p>
        ) : view.active.length === 0 ? (
          <EmptyState title="No projects yet">
            A project is a folder on your computer where agents work. Ask{" "}
            {controllerName(account.connections)} to “create a ThreadLink project” for one.
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
