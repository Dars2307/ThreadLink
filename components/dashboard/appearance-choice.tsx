"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { cx } from "@/components/ui";
import { BACKDROP_LABELS, BACKDROPS, type Backdrop } from "@/lib/dashboard/appearance";
import { persistBackdrop, persistMotion } from "@/lib/dashboard/appearance-client";

/** A small preview swatch per backdrop (static; the real one moves). */
const SWATCH: Record<Backdrop, string> = {
  aurora:
    "radial-gradient(circle at 85% 0%, var(--bd-indigo), transparent 60%), radial-gradient(circle at 10% 100%, var(--bd-clay), transparent 60%), radial-gradient(circle at 100% 85%, var(--bd-teal), transparent 60%), var(--bd-base)",
  dusk: "radial-gradient(circle at 70% 0%, var(--bd-violet), transparent 65%), var(--bd-dusk)",
  grid: "radial-gradient(circle at 1px 1px, var(--bd-dot) 1px, transparent 0) 0 0 / 8px 8px, var(--bd-grid-base)",
  plain: "var(--bd-plain)",
};

/**
 * Settings → Appearance: the app backdrop and whether it moves. Saved per
 * browser (a cookie, like the theme) so pages render without a flash; the
 * change applies at once. Reduced-motion users never get animation.
 */
export function AppearanceChoice({ backdrop, animate }: { backdrop: Backdrop; animate: boolean }) {
  const [current, setCurrent] = useState<Backdrop>(backdrop);
  const [moving, setMoving] = useState(animate);
  const router = useRouter();
  const id = useId();

  const choose = (next: Backdrop) => {
    setCurrent(next);
    persistBackdrop(next);
    router.refresh();
  };
  const toggle = () => {
    const next = !moving;
    setMoving(next);
    persistMotion(next);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p id={`${id}-bg`} className="text-sm font-medium">
          Background
        </p>
        <div role="radiogroup" aria-labelledby={`${id}-bg`} className="flex flex-wrap gap-3">
          {BACKDROPS.map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={current === b}
              onClick={() => choose(b)}
              className={cx(
                "flex w-24 flex-col gap-1.5 rounded-xl border p-1.5 text-left text-xs transition-colors motion-reduce:transition-none",
                current === b
                  ? "border-accent ring-accent/30 font-medium ring-2"
                  : "border-border hover:border-border-strong",
              )}
            >
              <span
                aria-hidden
                className="border-line-soft block h-12 rounded-lg border"
                style={{ background: SWATCH[b] }}
              />
              <span className="px-0.5">{BACKDROP_LABELS[b]}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="flex w-fit cursor-pointer items-center gap-3 text-sm">
        <button
          type="button"
          role="switch"
          aria-checked={moving}
          onClick={toggle}
          className={cx(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none",
            moving ? "bg-accent" : "bg-border-strong",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "bg-surface inline-block size-4 rounded-full shadow transition-transform motion-reduce:transition-none",
              moving ? "translate-x-[18px]" : "translate-x-0.5",
            )}
          />
          <span className="sr-only">Animate background</span>
        </button>
        <span>
          Animate background
          <span className="text-subtle block text-xs">
            Slow, soft movement. Always off when your system asks for reduced motion.
          </span>
        </span>
      </label>
    </div>
  );
}
