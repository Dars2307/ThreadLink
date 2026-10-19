import { Show } from "@clerk/nextjs";
import Link from "next/link";

import { buttonStyles } from "@/components/ui";

const STEPS = [
  {
    num: "01",
    title: "Link once",
    body: "Run one command in Claude Code to register your session. ThreadLink gives it a stable identity you control.",
  },
  {
    num: "02",
    title: 'Say "send this to Claude"',
    body: "In ChatGPT, say anything that means hand this off. ThreadLink detects the intent and routes it automatically.",
  },
  {
    num: "03",
    title: "Answer comes back",
    body: "Claude works in the background. The result arrives in the same ChatGPT conversation you sent from.",
  },
] as const;

const FEATURES = [
  {
    icon: "⟳",
    title: "Live Mission Control",
    body: "Every tool call, every step — visible in your dashboard as it happens. Nothing runs in the dark.",
  },
  {
    icon: "⇄",
    title: "Explicit, revocable links",
    body: "Nothing pairs automatically. You confirm every connection. Each link is tied to your account and can be removed in one click.",
  },
  {
    icon: "✦",
    title: "Zero context switch",
    body: "Stay in ChatGPT the whole time. ThreadLink is invisible infrastructure — you only see the result.",
  },
] as const;

export default function LandingPage() {
  return (
    <>
      {/* ─── Hero ─────────────────────────────────────────────────── */}
      <section className="relative flex min-h-[calc(100dvh-3.5rem)] items-center overflow-hidden px-4 py-20 sm:px-6">
        {/* Atmospheric glow — two layered blobs, compositor-only */}
        <div aria-hidden className="pointer-events-none absolute inset-0 select-none overflow-hidden">
          <div className="absolute top-[-15%] left-1/2 h-[640px] w-[900px] -translate-x-1/2 rounded-full bg-accent opacity-[0.09] blur-[140px]" />
          <div className="absolute top-[30%] right-[-8%] h-[360px] w-[500px] rounded-full bg-accent opacity-[0.06] blur-[100px]" />
        </div>

        <div className="relative mx-auto w-full max-w-5xl">
          <div className="flex flex-col gap-8 sm:gap-10">
            {/* Alpha pill */}
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
                Alpha — limited access
              </span>
            </div>

            {/* Headline */}
            <div className="flex max-w-4xl flex-col gap-5">
              <h1 className="font-display text-[clamp(2.5rem,8vw,5rem)] font-bold leading-[1.08] tracking-tight text-foreground">
                Stay in ChatGPT.
                <br />
                <span className="text-accent">Claude Code</span>
                <br className="hidden sm:block" />
                {" works in the background."}
              </h1>
              <p className="max-w-lg text-[1.125rem] leading-relaxed text-muted">
                ThreadLink routes your ChatGPT messages to Claude Code and brings the answers
                back — without switching tabs, copying prompts, or losing thread.
              </p>
            </div>

            {/* CTAs */}
            <div className="flex flex-wrap gap-3">
              <Show when="signed-out">
                <Link href="/sign-up" className={buttonStyles.primary}>
                  Get started free
                </Link>
                <Link href="/sign-in" className={buttonStyles.ghost}>
                  Sign in →
                </Link>
              </Show>
              <Show when="signed-in">
                <Link href="/dashboard" className={buttonStyles.primary}>
                  Open dashboard
                </Link>
              </Show>
            </div>

            {/* Trust signals */}
            <p className="text-subtle text-xs tracking-wide">
              Free during Alpha · No card required · Links are yours and revocable
            </p>
          </div>
        </div>
      </section>

      {/* ─── How it works ─────────────────────────────────────────── */}
      <section className="border-t border-border px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 flex flex-col gap-3">
            <p className="font-display text-xs font-semibold uppercase tracking-[0.15em] text-accent">
              How it works
            </p>
            <h2 className="font-display text-[clamp(1.75rem,4vw,2.5rem)] font-bold tracking-tight text-foreground">
              Three steps. Zero context switch.
            </h2>
          </div>

          <ol className="grid gap-10 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.num} className="flex flex-col gap-3">
                <span className="font-display text-5xl font-bold leading-none text-accent/30">
                  {step.num}
                </span>
                <div className="flex flex-col gap-2">
                  <h3 className="font-display text-base font-semibold text-foreground">
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Feature cards ────────────────────────────────────────── */}
      <section className="border-t border-border px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 flex flex-col gap-3">
            <p className="font-display text-xs font-semibold uppercase tracking-[0.15em] text-accent">
              Built for power users
            </p>
            <h2 className="font-display text-[clamp(1.75rem,4vw,2.5rem)] font-bold tracking-tight text-foreground">
              What you get
            </h2>
          </div>

          <ul className="grid gap-4 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <li
                key={f.title}
                className="group flex flex-col gap-4 rounded-2xl border border-border bg-surface/60 p-6 transition-colors hover:border-accent/30 hover:bg-surface"
              >
                <span
                  aria-hidden
                  className="flex size-10 items-center justify-center rounded-xl border border-border bg-surface-muted text-lg text-accent"
                >
                  {f.icon}
                </span>
                <div className="flex flex-col gap-1.5">
                  <h3 className="font-display text-sm font-semibold text-foreground">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ─── CTA footer ───────────────────────────────────────────── */}
      <section className="border-t border-border px-4 py-24 sm:px-6">
        <div className="mx-auto max-w-3xl text-center">
          {/* Subtle top glow */}
          <div aria-hidden className="pointer-events-none relative">
            <div className="absolute -top-24 left-1/2 h-[200px] w-[600px] -translate-x-1/2 rounded-full bg-accent opacity-[0.06] blur-[80px]" />
          </div>
          <h2 className="font-display text-[clamp(1.75rem,4vw,2.75rem)] font-bold tracking-tight text-foreground">
            Ready to link your first conversation?
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted">
            Takes about two minutes. Your ChatGPT conversations, Claude Code working for you.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Show when="signed-out">
              <Link href="/sign-up" className={buttonStyles.primary}>
                Get started free
              </Link>
              <Link href="/sign-in" className={buttonStyles.ghost}>
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
      </section>
    </>
  );
}
