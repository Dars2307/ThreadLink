"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { cx } from "@/components/ui";
import { persistTheme } from "@/lib/theme-client";
import { THEMES, type Theme } from "@/lib/theme";

/** System / Light / Dark, stored per device and applied without a reload. */
export function ThemeChoice({ theme }: { theme: Theme }) {
  const [current, setCurrent] = useState<Theme>(theme);
  const router = useRouter();

  function choose(next: Theme) {
    setCurrent(next);
    persistTheme(next);
    router.refresh();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="bg-surface-muted flex w-fit gap-1 rounded-xl p-1"
    >
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={current === t}
          onClick={() => choose(t)}
          className={cx(
            "rounded-lg px-4 py-1.5 text-sm capitalize transition-colors",
            current === t ? "bg-surface text-foreground shadow-card font-medium" : "text-muted",
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
