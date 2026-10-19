import Link from "next/link";

import { NewChatForm, type Choice } from "@/components/dashboard/chats";
import { buttonStyles, Card, cx } from "@/components/ui";
import type { Onboarding } from "@/lib/dashboard/onboarding";

const MARK = { done: "✓", current: "→", todo: "·" } as const;
const WORD = { done: "Done", current: "Next", todo: "Later" } as const;

/** The first-run card: connect agents → create the first chat (inline form). */
export function OnboardingCard({ model, projects }: { model: Onboarding; projects: Choice[] }) {
  if (!model.show) return null;
  return (
    <Card labelledBy="welcome-title" className="border-accent/40">
      <h2 id="welcome-title" className="text-xl font-semibold tracking-tight sm:text-2xl">
        {model.title}
      </h2>
      <p className="text-muted pt-1 text-sm">{model.intro}</p>
      <ol className="flex flex-col gap-5 pt-5">
        {model.steps.map((s, i) => (
          <li key={s.key} className="flex gap-4">
            <span
              aria-hidden
              className={cx(
                "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-2 ring-offset-2",
                s.state === "done"
                  ? "bg-success-soft text-success ring-success/20"
                  : s.state === "current"
                    ? "bg-accent text-accent-foreground ring-accent/30 shadow-glow"
                    : "bg-surface-muted text-muted ring-transparent",
                "ring-offset-surface",
              )}
            >
              {s.state === "done" ? MARK.done : i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2 pb-1">
              <p className="text-sm font-medium leading-tight">
                {s.title} <span className="sr-only">({WORD[s.state]})</span>
                {s.state === "done" ? (
                  <span className="text-success pl-2 text-xs font-normal">Done</span>
                ) : null}
              </p>
              <p className="text-muted text-sm leading-relaxed">{s.detail}</p>
              {s.key === "chat" && s.state !== "done" ? (
                <details
                  open={s.state === "current"}
                  className="border-border rounded-xl border p-3"
                >
                  <summary className="text-accent cursor-pointer text-sm font-medium">
                    Create your first chat
                  </summary>
                  <div className="pt-3">
                    <NewChatForm projects={projects} />
                  </div>
                </details>
              ) : (
                <Link
                  href={s.href}
                  className={cx(
                    s.state === "current" ? buttonStyles.primary : buttonStyles.secondary,
                    "w-fit",
                  )}
                >
                  {s.cta}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
