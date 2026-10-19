import { Show } from "@clerk/nextjs";
import { Link2, Monitor, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { buttonStyles } from "@/components/ui";

const FEATURES = [
  {
    icon: ShieldCheck,
    title: "Your accounts",
    body: "Sign in once; every connection is tied to you and revocable.",
  },
  {
    icon: Link2,
    title: "Explicit links",
    body: "Nothing is paired automatically — you confirm each link.",
  },
  {
    icon: Monitor,
    title: "Your session",
    body: "Tasks can continue the Claude Code session you choose.",
  },
] as const;

export default function LandingPage() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-10 px-4 py-20">
      <div className="flex max-w-2xl flex-col gap-5">
        <p className="bg-accent-soft text-accent w-fit rounded-full px-3 py-1 text-xs font-medium tracking-wide">
          Alpha
        </p>
        <h1 className="text-4xl leading-[1.15] font-semibold tracking-tight sm:text-5xl">
          Send it to Claude without leaving ChatGPT.
        </h1>
        <p className="text-muted max-w-xl text-lg leading-relaxed">
          Link a ChatGPT conversation to your Claude Code session once. Then just say &ldquo;send
          this to Claude&rdquo; — the work runs in your project and the answer comes back to the
          same conversation.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
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
      </div>

      <ul className="grid max-w-3xl gap-4 sm:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="border-border bg-surface shadow-card flex flex-col gap-4 rounded-2xl border p-5"
          >
            <span className="bg-accent-soft text-accent flex size-9 items-center justify-center rounded-xl">
              <Icon aria-hidden className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">{title}</p>
              <p className="text-muted pt-1 text-sm leading-relaxed">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
