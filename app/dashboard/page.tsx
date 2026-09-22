import { SignOutButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getIdentity } from "@/lib/auth/identity";
import { requireThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { Connection } from "@/lib/connections/model";
import { listMyConnections } from "@/lib/connections/repository";
import { RegisterConnectionForm } from "@/components/connections/register-connection-form";
import { RevokeConnectionButton } from "@/components/connections/revoke-connection-button";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { maskIdentifier } from "@/lib/security/mask";
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
    return { ok: true, user, connections, sessions, links, tasks };
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

  const displayName =
    clerkUser.fullName ??
    clerkUser.username ??
    clerkUser.primaryEmailAddress?.emailAddress ??
    "ThreadLink user";
  const email = clerkUser.primaryEmailAddress?.emailAddress ?? null;
  const account = await loadAccount();

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-foreground/60">Signed in as {displayName}</p>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">ThreadLink Account</h2>
        <dl className="grid gap-4 rounded-lg border border-black/10 p-6 sm:grid-cols-[max-content_1fr] dark:border-white/15">
          <dt className="text-foreground/60 text-sm">Status</dt>
          <dd className="font-medium">{account.ok ? "Connected" : "Unavailable"}</dd>

          {account.ok ? (
            <>
              <dt className="text-foreground/60 text-sm">ThreadLink User ID</dt>
              <dd className="font-mono text-sm" title="Masked for display">
                {maskIdentifier(account.user.id, 6)}
              </dd>
            </>
          ) : null}

          <dt className="text-foreground/60 text-sm">Identity Provider</dt>
          <dd>Clerk</dd>

          <dt className="text-foreground/60 text-sm">Name</dt>
          <dd>{displayName}</dd>

          {email ? (
            <>
              <dt className="text-foreground/60 text-sm">Email</dt>
              <dd>{email}</dd>
            </>
          ) : null}
        </dl>
        {account.ok ? null : (
          <p className="text-sm text-red-700 dark:text-red-400">
            Your ThreadLink account could not be loaded. Try again shortly.
          </p>
        )}
      </div>

      {account.ok ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Connections</h2>
          <RegisterConnectionForm />
          {account.connections.length === 0 ? (
            <p className="text-foreground/60 text-sm">No connections yet</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {account.connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex flex-col gap-2 rounded-md border border-black/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/15"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {connection.displayName ?? connection.platform}
                    </span>
                    <span className="text-foreground/60">
                      {connection.platform} · {connection.role} ·{" "}
                      <span
                        className={
                          connection.status === "revoked" ? "text-red-700 dark:text-red-400" : ""
                        }
                      >
                        {connection.status}
                      </span>
                      {connection.credential ? (
                        <>
                          {" "}
                          · <span className="font-mono">{connection.credential.tokenPrefix}…</span>
                        </>
                      ) : null}
                    </span>
                    <span className="text-foreground/50 text-xs">
                      Created {formatDate(connection.createdAt)}
                      {connection.lastSeenAt
                        ? ` · Last used ${formatDate(connection.lastSeenAt)}`
                        : " · Never used"}
                      {connection.revokedAt ? ` · Revoked ${formatDate(connection.revokedAt)}` : ""}
                    </span>
                  </div>
                  {connection.status === "active" || connection.status === "idle" ? (
                    <RevokeConnectionButton connectionId={connection.id} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {account.ok ? <SessionsSection sessions={account.sessions} /> : null}
      {account.ok ? <LinksSection links={account.links} sessions={account.sessions} /> : null}
      {account.ok ? <TasksSection tasks={account.tasks} sessions={account.sessions} /> : null}

      <div>
        <SignOutButton>
          <button
            type="button"
            className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
          >
            Sign out
          </button>
        </SignOutButton>
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return (
    new Date(value).toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }) + " UTC"
  );
}

function SessionsSection({ sessions }: { sessions: OwnerSession[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-foreground/60 text-sm">No sessions yet</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {sessions.map((session) => (
            <li
              key={session.sessionId}
              className="flex flex-col gap-1 rounded-md border border-black/10 px-4 py-3 dark:border-white/15"
            >
              <span className="font-medium">{session.displayName ?? "Unnamed session"}</span>
              <span className="text-foreground/60">
                <span className="font-mono">{maskIdentifier(session.sessionId, 6)}</span> ·{" "}
                {session.platform} · {session.role} · {session.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LinksSection({ links, sessions }: { links: ThreadLinkView[]; sessions: OwnerSession[] }) {
  const label = (id: string) => {
    const session = sessions.find((s) => s.sessionId === id);
    return `${session?.displayName ?? "session"} (${maskIdentifier(id, 6)})`;
  };
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Thread Links</h2>
      {links.length === 0 ? (
        <p className="text-foreground/60 text-sm">No thread links yet</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {links.map((link) => (
            <li
              key={link.linkId}
              className="flex flex-col gap-2 rounded-md border border-black/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/15"
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono">{maskIdentifier(link.linkId, 6)}</span>
                <span className="text-foreground/60">
                  Controller: {label(link.controllerSessionId)} → Agent:{" "}
                  {label(link.agentSessionId)}
                </span>
                <span className="text-foreground/60">
                  {link.status}
                  {link.revokedReason ? ` · ${link.revokedReason.replaceAll("_", " ")}` : ""}
                </span>
              </div>
              {link.status !== "revoked" ? <RevokeLinkButton linkId={link.linkId} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TasksSection({ tasks, sessions }: { tasks: RecentTask[]; sessions: OwnerSession[] }) {
  const label = (id: string) =>
    `${sessions.find((s) => s.sessionId === id)?.displayName ?? "session"} (${maskIdentifier(id, 6)})`;
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Recent Tasks</h2>
      {tasks.length === 0 ? (
        <p className="text-foreground/60 text-sm">No tasks yet</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {tasks.map((task) => (
            <li
              key={task.taskId}
              className="flex flex-col gap-1 rounded-md border border-black/10 px-4 py-3 dark:border-white/15"
            >
              <span className="font-medium">
                {task.title} <span className="text-foreground/60 font-mono">[{task.priority}]</span>
              </span>
              <span className="text-foreground/60">
                <span className="font-mono">{maskIdentifier(task.taskId, 6)}</span> · {task.status}
              </span>
              <span className="text-foreground/60">
                {label(task.originSessionId)} → {label(task.targetSessionId)}
              </span>
              <span className="text-foreground/50 text-xs">
                Created {formatDate(task.createdAt)}
                {task.finishedAt ? ` · Finished ${formatDate(task.finishedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
