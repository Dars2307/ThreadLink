"use client";

import { resetTimeText } from "@/runtime/src/chat-presentation";

/** "Resets around 14:52" in the viewer's own time zone (rendered in the browser). */
export function ResetTime({ at, className }: { at: string | null; className?: string }) {
  return (
    <span className={className} suppressHydrationWarning>
      {resetTimeText(at)}
    </span>
  );
}
