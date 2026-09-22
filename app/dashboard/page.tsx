import { SignOutButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getIdentity } from "@/lib/auth/identity";
import { requireThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { Connection } from "@/lib/connections/model";
import { listMyConnections } from "@/lib/connections/repository";
import { maskIdentifier } from "@/lib/security/mask";

export const metadata: Metadata = {
  title: "Dashboard · ThreadLink",
};

type AccountState = { ok: true; user: ThreadLinkUser; connections: Connection[] } | { ok: false };

async function loadAccount(): Promise<AccountState> {
  try {
    const user = await requireThreadLinkUser();
    const connections = await listMyConnections();
    return { ok: true, user, connections };
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
          {account.connections.length === 0 ? (
            <p className="text-foreground/60 text-sm">No connections yet</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {account.connections.map((connection) => (
                <li
                  key={connection.id}
                  className="rounded-md border border-black/10 px-4 py-3 dark:border-white/15"
                >
                  <span className="font-medium">
                    {connection.displayName ?? connection.platform}
                  </span>{" "}
                  <span className="text-foreground/60">
                    · {connection.platform} · {connection.role} · {connection.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

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
