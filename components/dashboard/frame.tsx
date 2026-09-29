"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Backdrop } from "@/components/dashboard/backdrop";
import { cx } from "@/components/ui";
import type { Backdrop as BackdropKind } from "@/lib/dashboard/appearance";

/** A chat page: the conversation owns the screen and the page itself never scrolls. */
export function isChatRoute(pathname: string): boolean {
  return /^\/dashboard\/chats\/[^/]+\/?$/.test(pathname);
}

/**
 * The signed-in frame: the animated backdrop, the sidebar sitting on it, and
 * the content as a frosted inset card. On a chat route it is exactly the viewport high
 * (h-dvh, overflow hidden): the timeline is the only scroll surface (§8).
 * Every other page keeps normal document scrolling.
 */
export function DashboardFrame({
  sidebar,
  children,
  after,
  backdrop = "aurora",
  animate = true,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  after?: ReactNode;
  backdrop?: BackdropKind;
  animate?: boolean;
}) {
  const chat = isChatRoute(usePathname());
  return (
    <div className={cx("flex flex-col lg:flex-row", chat ? "h-dvh overflow-hidden" : "min-h-dvh")}>
      <Backdrop kind={backdrop} animate={animate} />
      <a
        href="#main"
        className="focus:bg-surface focus:text-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      {sidebar}
      <main
        id="main"
        className={cx(
          // The inset card (shadcn "sidebar inset"): frosted, hairline border, soft shadow.
          "tl-inset lg:border-line-soft lg:shadow-float min-w-0 flex-1 lg:my-2 lg:mr-2 lg:rounded-[14px] lg:border",
          chat ? "flex min-h-0 flex-col overflow-hidden" : "lg:min-h-[calc(100dvh-1rem)]",
        )}
      >
        {children}
      </main>
      {after}
    </div>
  );
}
