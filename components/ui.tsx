import type { ReactNode } from "react";

/** Small, dependency-free UI primitives on the ThreadLink design tokens. */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export const buttonStyles = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:opacity-60",
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted disabled:opacity-60",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-muted hover:text-foreground disabled:opacity-60",
  danger:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-soft disabled:opacity-60",
} as const;

export function Card({
  children,
  className,
  as: Tag = "section",
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
  labelledBy?: string;
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={cx(
        "border-border bg-surface shadow-card rounded-2xl border p-5 sm:p-6",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({
  id,
  children,
  action,
  description,
}: {
  id?: string;
  children: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {children}
        </h2>
        {description ? <p className="text-muted text-sm">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export type Tone = "success" | "warning" | "danger" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-surface-muted text-muted",
  accent: "bg-accent-soft text-accent",
};

const DOTS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-subtle",
  accent: "bg-accent",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
      )}
    >
      <span aria-hidden className={cx("size-1.5 rounded-full", DOTS[tone])} />
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border-border-strong bg-surface-muted/50 rounded-xl border border-dashed px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="text-muted mx-auto mt-1 max-w-sm text-sm">{children}</div> : null}
    </div>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="text-muted font-mono text-[0.8125rem]">
      {children}
    </span>
  );
}
