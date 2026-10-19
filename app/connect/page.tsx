import type { Metadata } from "next";
import Link from "next/link";

import { buttonStyles, Card } from "@/components/ui";
import { lookupPendingDevice } from "@/lib/device/approve";
import { formatUserCode } from "@/lib/device/server";

import { approveDeviceAction, denyDeviceAction } from "./actions";

export const metadata: Metadata = { title: "Connect Claude Code · ThreadLink" };
export const dynamic = "force-dynamic";

const RESULTS: Record<string, { title: string; body: string }> = {
  approved: {
    title: "Claude Code is connected",
    body: "Return to your terminal - the ThreadLink bridge finishes setup there.",
  },
  denied: { title: "Request denied", body: "Nothing was connected. You can close this tab." },
  invalid: {
    title: "That code is no longer valid",
    body: "Codes expire after 10 minutes and work once. Run the bridge setup again for a new code.",
  },
};

/**
 * Human approval for a Claude Code bridge sign-in (device authorization).
 * proxy.ts requires a Clerk session here; the database takes the owner from it.
 */
export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const result = RESULTS[one(params.result) ?? ""];
  const rawCode = one(params.code);
  const pending = rawCode && !result ? await lookupPendingDevice(rawCode) : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-16">
      <Card>
        {result ? (
          <div className="flex flex-col gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{result.title}</h1>
            <p className="text-muted text-sm">{result.body}</p>
            <Link href="/dashboard" className={buttonStyles.secondary}>
              Go to dashboard
            </Link>
          </div>
        ) : pending ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="text-accent text-sm font-medium">Connect Claude Code</p>
              <h1 className="text-xl font-semibold tracking-tight">{pending.displayName}</h1>
              <p className="text-muted text-sm">
                wants to connect to your ThreadLink account. Only approve if you just started setup
                in your own terminal and it shows this code:
              </p>
            </div>
            <div className="bg-surface-muted flex flex-col items-center gap-1 rounded-xl px-4 py-5">
              <span className="text-subtle mb-1 text-xs font-medium tracking-wide uppercase">
                Confirmation code
              </span>
              <p className="font-mono text-2xl font-semibold tracking-[0.3em]">
                {formatUserCode(pending.code)}
              </p>
            </div>
            <ul className="text-muted list-disc pl-5 text-sm">
              <li>It will receive tasks from conversations you explicitly link to it.</li>
              <li>It cannot read your other sessions or manage your account.</li>
              <li>You can disconnect it any time from the dashboard.</li>
            </ul>
            <form className="flex gap-3">
              <input type="hidden" name="code" value={pending.code} />
              <button formAction={approveDeviceAction} className={buttonStyles.primary}>
                Approve
              </button>
              <button formAction={denyDeviceAction} className={buttonStyles.secondary}>
                Deny
              </button>
            </form>
          </div>
        ) : (
          <form className="flex flex-col gap-4" action="/connect">
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Connect Claude Code</h1>
              <p className="text-muted text-sm">
                {rawCode
                  ? "That code was not found or has expired. Check your terminal and try again."
                  : "Enter the code shown by the ThreadLink bridge in your terminal."}
              </p>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Code</span>
              <input
                name="code"
                required
                autoComplete="off"
                placeholder="BCDF-GHJK"
                className="border-border-strong bg-surface rounded-lg border px-3 py-2 font-mono tracking-widest uppercase"
              />
            </label>
            <button type="submit" className={buttonStyles.primary}>
              Continue
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
