import type { ReactNode } from "react";

import { Badge, type Tone } from "@/components/ui";

/** Shared page frame for the signed-in app. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
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
    <header className="flex flex-col gap-3">
      {eyebrow ? <p className="text-muted text-sm">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          {badge ? <Badge tone={tone}>{badge}</Badge> : null}
        </div>
        {actions}
      </div>
      {description ? <p className="text-muted max-w-2xl text-sm">{description}</p> : null}
    </header>
  );
}
