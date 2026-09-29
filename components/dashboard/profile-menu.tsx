"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cx } from "@/components/ui";
import { persistTheme } from "@/lib/theme-client";
import { THEMES, type Theme } from "@/lib/theme";

/** Account menu: identity, account settings, appearance and sign out. */
export function ProfileMenu({ theme }: { theme: Theme }) {
  const { user } = useUser();
  const clerk = useClerk();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Theme>(theme);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function chooseTheme(next: Theme) {
    setCurrent(next);
    persistTheme(next);
    router.refresh(); // keeps Clerk's UI in step
  }

  const name = user?.fullName ?? user?.username ?? "ThreadLink user";
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hover:bg-active flex h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors motion-reduce:transition-none"
      >
        <span
          aria-hidden
          className="bg-accent-soft text-accent-hover flex size-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold"
        >
          {(name[0] ?? "T").toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-sm leading-tight font-semibold">{name}</span>
          {email ? (
            <span className="text-subtle truncate text-xs leading-tight">{email}</span>
          ) : null}
        </span>
        <ChevronsUpDown aria-hidden className="text-subtle size-4 shrink-0" />
      </button>

      {open ? (
        <div
          role="menu"
          className="tl-glass border-field shadow-float absolute bottom-full left-0 z-30 mb-2 w-60 rounded-xl border p-1"
        >
          <div className="border-border border-b px-3 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            {email ? <p className="text-subtle truncate text-xs">{email}</p> : null}
          </div>
          <button
            type="button"
            role="menuitem"
            className="hover:bg-surface-muted w-full rounded-lg px-3 py-2 text-left text-sm"
            onClick={() => {
              setOpen(false);
              clerk.openUserProfile();
            }}
          >
            Account
          </button>
          <Link
            role="menuitem"
            href="/dashboard/settings"
            className="hover:bg-surface-muted block rounded-lg px-3 py-2 text-sm"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          <div className="border-border mt-1 border-t px-3 pt-2 pb-1">
            <p className="text-subtle pb-1 text-xs">Appearance</p>
            <div className="bg-surface-muted flex gap-1 rounded-lg p-1">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={current === t}
                  onClick={() => chooseTheme(t)}
                  className={cx(
                    "flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors",
                    current === t
                      ? "bg-surface text-foreground shadow-card font-medium"
                      : "text-muted",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="hover:bg-surface-muted text-danger mt-1 w-full rounded-lg px-3 py-2 text-left text-sm"
            onClick={() => clerk.signOut({ redirectUrl: "/" })}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
