import { Show } from "@clerk/nextjs";
import Link from "next/link";

export default function LandingPage() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <p className="text-foreground/60 text-sm font-medium tracking-wide uppercase">Alpha v0.1</p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">ThreadLink</h1>
      <p className="text-foreground/80 max-w-2xl text-lg">
        An authenticated coordination and routing layer between AI sessions. Stay in your primary
        conversation and send work to a linked execution agent, with results returned to the right
        place.
      </p>
      <p className="text-foreground/60 max-w-2xl">
        Alpha starts with ChatGPT as the controller and Claude Code as the execution agent.
      </p>
      <div className="flex gap-3">
        <Show when="signed-out">
          <Link
            href="/sign-up"
            className="bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium"
          >
            Create account
          </Link>
          <Link
            href="/sign-in"
            className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
          >
            Sign in
          </Link>
        </Show>
        <Show when="signed-in">
          <Link
            href="/dashboard"
            className="bg-foreground text-background rounded-md px-4 py-2 text-sm font-medium"
          >
            Go to dashboard
          </Link>
        </Show>
      </div>
    </section>
  );
}
