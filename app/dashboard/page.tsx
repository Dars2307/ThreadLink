import { SignOutButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getIdentity } from "@/lib/auth/identity";
import { maskIdentifier } from "@/lib/security/mask";

export const metadata: Metadata = {
  title: "Dashboard · ThreadLink",
};

export default async function DashboardPage() {
  // Defence in depth: proxy.ts already requires a session for this route.
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");

  // Profile fields are for display only. Never use them for authorization.
  const user = await currentUser();
  if (!user || user.id !== identity.clerkUserId) redirect("/sign-in");

  const displayName =
    user.fullName ?? user.username ?? user.primaryEmailAddress?.emailAddress ?? "ThreadLink user";
  const email = user.primaryEmailAddress?.emailAddress ?? null;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-foreground/60">Signed in as {displayName}</p>
      </header>

      <dl className="grid gap-4 rounded-lg border border-black/10 p-6 sm:grid-cols-[max-content_1fr] dark:border-white/15">
        <dt className="text-foreground/60 text-sm">Status</dt>
        <dd className="font-medium">Authenticated</dd>

        <dt className="text-foreground/60 text-sm">Name</dt>
        <dd>{displayName}</dd>

        {email ? (
          <>
            <dt className="text-foreground/60 text-sm">Email</dt>
            <dd>{email}</dd>
          </>
        ) : null}

        <dt className="text-foreground/60 text-sm">User ID</dt>
        <dd className="font-mono text-sm" title="Masked for display">
          {maskIdentifier(identity.clerkUserId)}
        </dd>
      </dl>

      <p className="text-foreground/60 text-sm">
        Connections and ThreadLinks will appear here in later alpha phases.
      </p>

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
