import type { ReactNode } from "react";

import { Badge, type Tone } from "@/components/ui";

/** Shared page frame for the signed-in app. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
  tone = "neutral",
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  badge?: string;
  tone?: Tone;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {eyebrow ? <p className="text-subtle text-xs font-medium tracking-wide uppercase">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {badge ? <Badge tone={tone}>{badge}</Badge> : null}
        </div>
        {actions}
      </div>
      {description ? <p className="text-muted max-w-2xl text-sm leading-relaxed">{description}</p> : null}
    </header>
  );
}

/** A page whose data could not be loaded: fail closed, say so plainly. */
export function LoadError({ what }: { what: string }) {
  return (
    <Shell>
      <div className="border-border bg-surface shadow-card rounded-2xl border p-6">
        <h1 className="text-lg font-semibold">Could not load {what}</h1>
        <p className="text-muted pt-1 text-sm">Try again in a moment.</p>
      </div>
    </Shell>
  );
}

/** A compact number with a label, for page summaries. */
export function StatTile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="border-border bg-surface shadow-card flex flex-col gap-1 rounded-2xl border px-4 py-3">
      <span className="text-accent text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="text-muted text-xs">{label}</span>
      {hint ? <span className="text-subtle text-[0.7rem]">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>;
}
