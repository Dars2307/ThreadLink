"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { cx } from "@/components/ui";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/links", label: "Links" },
  { href: "/dashboard/sessions", label: "Conversations" },
  { href: "/dashboard/runtimes", label: "Runtimes" },
  { href: "/dashboard/activity", label: "Activity" },
  { href: "/dashboard/apps", label: "Apps" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/advanced", label: "Advanced" },
] as const;

export function Sidebar({
  profile,
  badges,
}: {
  profile: ReactNode;
  badges?: Record<string, number>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="ThreadLink">
      {NAV.map((item) => {
        const active = pathname === item.href;
        const badge = badges?.[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={cx(
              "flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-accent-soft text-accent font-medium"
                : "text-muted hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {item.label}
            {badge ? (
              <span className="bg-accent text-accent-foreground rounded-full px-1.5 text-[0.7rem] font-semibold">
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile bar */}
      <div className="border-border bg-surface sticky top-0 z-20 flex items-center justify-between border-b px-4 py-3 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden
            className="bg-accent text-accent-foreground flex size-6 items-center justify-center rounded-md text-xs"
          >
            ⇄
          </span>
          ThreadLink
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="tl-nav"
          onClick={() => setOpen((v) => !v)}
          className="border-border-strong rounded-lg border px-3 py-1.5 text-sm"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open ? (
        <div id="tl-nav" className="border-border bg-surface border-b p-3 lg:hidden">
          {nav}
          <div className="border-border mt-3 border-t pt-3">{profile}</div>
        </div>
      ) : null}

      {/* Desktop rail */}
      <aside className="border-border bg-surface sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r p-4 lg:flex">
        <Link
          href="/dashboard"
          className="mb-6 flex items-center gap-2 px-2 font-semibold tracking-tight"
        >
          <span
            aria-hidden
            className="bg-accent text-accent-foreground flex size-6 items-center justify-center rounded-md text-xs"
          >
            ⇄
          </span>
          ThreadLink
        </Link>
        {nav}
        <div className="mt-auto">{profile}</div>
      </aside>
    </>
  );
}
