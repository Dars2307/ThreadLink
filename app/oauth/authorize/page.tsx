import type { Metadata } from "next";

import { validateAuthorization } from "@/lib/oauth/authorize";

import { approveAuthorization, denyAuthorization } from "./actions";

export const metadata: Metadata = { title: "Authorize · ThreadLink" };
export const dynamic = "force-dynamic";

/**
 * OAuth consent. proxy.ts requires a Clerk session here, so the human signs in
 * with Clerk first; approval then issues a one-time code for THIS user only.
 */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const validated = await validateAuthorization(raw);

  if ("error" in validated) {
    return (
      <section className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-16">
        <h1 className="text-2xl font-semibold">Authorization failed</h1>
        <p className="text-foreground/70">{validated.error}</p>
        <p className="text-foreground/50 text-sm">
          Start the connection again from your MCP client.
        </p>
      </section>
    );
  }

  const { request, client } = validated;
  const redirectHost = new URL(request.redirect_uri).host;
  const hidden = Object.entries(request).filter(([, v]) => v !== undefined) as [string, string][];

  return (
    <section className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">Connect {client.clientName} to ThreadLink?</h1>
      <div className="text-foreground/80 flex flex-col gap-2 text-sm">
        <p>
          <span className="font-medium">{client.clientName}</span> is asking to act as a ThreadLink{" "}
          <span className="font-medium">controller</span> connection on your account. It will be
          able to:
        </p>
        <ul className="list-disc pl-5">
          <li>create ThreadLink sessions for its conversations;</li>
          <li>send tasks over thread links you have approved;</li>
          <li>read the status and results of tasks it sent.</li>
        </ul>
        <p>
          It cannot approve pairings, read other sessions&apos; results, or manage your account.
        </p>
        <p className="text-foreground/60">
          You will be returned to <span className="font-mono">{redirectHost}</span>. You can revoke
          this connection at any time from the dashboard.
        </p>
      </div>
      <form className="flex gap-3">
        {hidden.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <button
          formAction={approveAuthorization}
          className="bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium"
        >
          Allow
        </button>
        <button
          formAction={denyAuthorization}
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
        >
          Deny
        </button>
      </form>
    </section>
  );
}
