import { Show } from "@clerk/nextjs";
import Link from "next/link";

import { buttonStyles } from "@/components/ui";

export default function LandingPage() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-8 px-4 py-20">
      <p className="bg-accent-soft text-accent w-fit rounded-full px-3 py-1 text-xs font-medium">
        Alpha
      </p>
      <div className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Send it to Claude without leaving ChatGPT.
        </h1>
        <p className="text-muted text-lg">
          Link a ChatGPT conversation to your Claude Code session once. Then just say &ldquo;send
          this to Claude&rdquo; - the work runs in your project and the answer comes back to the
          same conversation.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Show when="signed-out">
          <Link href="/sign-up" className={buttonStyles.primary}>
            Get started
          </Link>
          <Link href="/sign-in" className={buttonStyles.secondary}>
            Sign in
          </Link>
        </Show>
        <Show when="signed-in">
          <Link href="/dashboard" className={buttonStyles.primary}>
            Open dashboard
          </Link>
        </Show>
      </div>
      <ul className="grid max-w-3xl gap-4 pt-4 text-sm sm:grid-cols-3">
        {[
          ["Your accounts", "Sign in once; every connection is tied to you and revocable."],
          ["Explicit links", "Nothing is paired automatically - you confirm each link."],
          ["Your session", "Tasks can continue the Claude Code session you choose."],
        ].map(([title, body]) => (
          <li key={title} className="border-border bg-surface shadow-card rounded-2xl border p-4">
            <p className="font-medium">{title}</p>
            <p className="text-muted pt-1">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
