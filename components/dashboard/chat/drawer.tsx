"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "@/components/ui";
import { DRAWER_LABELS, DRAWER_TABS, type DrawerTab } from "@/lib/dashboard/chat-panel";

export type { DrawerTab } from "@/lib/dashboard/chat-panel";

/** Below this width the drawer is an overlay (full-screen sheet on phones). */
const OVERLAY_QUERY = "(max-width: 1023.98px)";

function subscribeOverlay(cb: () => void) {
  const mq = window.matchMedia?.(OVERLAY_QUERY);
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
}

function useOverlay(): boolean {
  return useSyncExternalStore(
    subscribeOverlay,
    () => window.matchMedia?.(OVERLAY_QUERY).matches ?? false,
    () => true,
  );
}

/**
 * The chat's right drawer (§8): Activity, Progress, Findings, Details,
 * Provenance. A column beside the chat on wide screens, a sheet over it on
 * narrow ones (full screen on phones). Escape closes it and focus returns to
 * whatever opened it. Tabs follow the WAI-ARIA tabs pattern (arrow keys).
 */
export function ChatDrawer({
  tab,
  onTab,
  onClose,
  hasProvenance,
  findingCount = 0,
  children,
}: {
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
  hasProvenance: boolean;
  /** Open findings, shown beside the Findings tab. */
  findingCount?: number;
  children: ReactNode;
}) {
  const overlay = useOverlay();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const tabs = DRAWER_TABS.filter((t) => t !== "provenance" || hasProvenance);

  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(tab);
    let next: DrawerTab | null = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length]!;
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length]!;
    else if (e.key === "Home") next = tabs[0]!;
    else if (e.key === "End") next = tabs[tabs.length - 1]!;
    if (next) {
      e.preventDefault();
      onTab(next);
      requestAnimationFrame(() => document.getElementById(`tl-dtab-${next}`)?.focus());
    }
  };

  return (
    <>
      {overlay ? (
        <button
          type="button"
          aria-label="Close panel"
          tabIndex={-1}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={panel}
        tabIndex={-1}
        role={overlay ? "dialog" : "complementary"}
        aria-modal={overlay ? true : undefined}
        aria-labelledby="tl-drawer-title"
        className={cx(
          "border-line-soft flex min-h-0 flex-col outline-none",
          "tl-panel sm:shadow-float fixed inset-0 z-40 sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[384px] sm:rounded-[14px] sm:border",
          // Wide screens: a column inside the inset card.
          "lg:bg-hint lg:static lg:z-auto lg:w-[384px] lg:shrink-0 lg:rounded-none lg:border-0 lg:border-l lg:shadow-none lg:backdrop-blur-none",
        )}
      >
        <div className="border-line-soft flex h-14 shrink-0 items-center justify-between border-b pt-[env(safe-area-inset-top)] pr-3 pl-[18px]">
          <h2 id="tl-drawer-title" className="text-sm font-semibold">
            {DRAWER_LABELS[tab]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:bg-active hover:text-foreground flex size-7 items-center justify-center rounded-md"
            aria-label="Close details"
          >
            <X aria-hidden className="size-[15px]" />
          </button>
        </div>
        <div className="shrink-0 px-3.5 pt-3 pb-1">
          <div
            role="tablist"
            aria-label="Chat details"
            className="bg-tabs grid gap-0.5 rounded-[9px] p-[3px]"
            style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
            onKeyDown={onTabKey}
          >
            {tabs.map((t) => (
              <button
                key={t}
                id={`tl-dtab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="tl-dpanel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => onTab(t)}
                className={cx(
                  "h-7 min-w-0 truncate rounded-md px-1 text-xs transition-colors motion-reduce:transition-none",
                  tab === t
                    ? "bg-card text-foreground font-medium shadow-[0_1px_2px_rgb(16_16_24/0.08)]"
                    : "text-muted hover:text-foreground",
                )}
              >
                {DRAWER_LABELS[t]}
                {t === "findings" && findingCount ? (
                  <span className="text-warning pl-1">{findingCount}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <div
          id="tl-dpanel"
          role="tabpanel"
          aria-labelledby={`tl-dtab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[18px] pt-3.5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        >
          {children}
        </div>
      </aside>
    </>
  );
}
