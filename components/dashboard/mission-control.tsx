"use client";

import type { ActivityItem } from "@/lib/dashboard/view-model";
import { cx } from "@/components/ui";

const TONE_SYM: Record<ActivityItem["tone"], string> = {
  success: "✓",
  danger: "✗",
  neutral: "·",
  accent: "→",
};

const TONE_CLS: Record<ActivityItem["tone"], string> = {
  success: "text-success",
  danger: "text-danger",
  neutral: "text-subtle",
  accent: "text-accent",
};

/**
 * A terminal-style live feed of recent task activity. Data is passed from
 * the server page — no polling, no client-side data fetching.
 */
export function MissionControl({ activity }: { activity: ActivityItem[] }) {
  const hasLive = activity.some((a) => a.tone === "accent");

  return (
    <section
      aria-labelledby="mc-title"
      className="border-border bg-[var(--card)] overflow-hidden rounded-2xl border shadow-card"
    >
      {/* Terminal header bar */}
      <div className="border-border bg-surface-muted/60 flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-danger/40" />
            <span className="size-2.5 rounded-full bg-warning/40" />
            <span className="size-2.5 rounded-full bg-success/40" />
          </div>
          <h2
            id="mc-title"
            className="font-mono text-[11px] font-medium uppercase tracking-widest text-subtle"
          >
            Mission Control
          </h2>
        </div>
        {hasLive ? (
          <span className="flex items-center gap-1.5 text-[11px] text-success">
            <span
              aria-label="Live activity"
              className="tl-pulse size-1.5 rounded-full bg-success shadow-[0_0_0_3px_var(--ok-ring)]"
            />
            Live
          </span>
        ) : (
          <span className="font-mono text-[11px] text-subtle">idle</span>
        )}
      </div>

      {/* Feed */}
      <div className="divide-border divide-y font-mono text-xs">
        {activity.length === 0 ? (
          <p className="px-4 py-5 text-subtle">
            <span className="text-accent">$</span> awaiting first task&hellip;
          </p>
        ) : (
          activity.slice(0, 10).map((item, i) => (
            <div
              key={item.taskId}
              className={cx(
                "flex min-w-0 items-start gap-3 px-4 py-2.5 transition-colors",
                item.tone === "accent" && "bg-accent/[0.04]",
              )}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              {/* Status symbol */}
              <span
                aria-hidden
                className={cx(
                  "mt-px shrink-0 font-mono text-[11px] font-semibold leading-none",
                  TONE_CLS[item.tone],
                )}
              >
                {TONE_SYM[item.tone]}
              </span>

              {/* Content */}
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground leading-snug">
                {item.title}
              </span>

              {/* Right: status + time */}
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <span className={cx("text-[10px] font-medium", TONE_CLS[item.tone])}>
                  {item.statusLabel}
                </span>
                <span className="text-[10px] text-subtle">{item.when}</span>
              </span>
            </div>
          ))
        )}
      </div>

      {activity.length > 10 ? (
        <div className="border-border border-t px-4 py-2">
          <span className="font-mono text-[11px] text-subtle">
            + {activity.length - 10} earlier entries
          </span>
        </div>
      ) : null}
    </section>
  );
}
