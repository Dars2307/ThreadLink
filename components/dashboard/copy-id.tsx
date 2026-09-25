"use client";

import { useState } from "react";

import { cx } from "@/components/ui";

/** A technical identifier with a Copy button. Used only on Settings → Advanced and a project's Details tab. */
export function CopyId({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <code
        aria-label={label}
        className="text-muted min-w-0 truncate font-mono text-[0.8125rem]"
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label ?? value}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable: the text is selectable */
          }
        }}
        className={cx(
          "border-border hover:bg-surface-muted shrink-0 rounded-md border px-1.5 py-0.5 text-[0.7rem] font-medium transition-colors",
          copied ? "text-success" : "text-muted",
        )}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
