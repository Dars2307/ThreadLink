"use client";

import { useState } from "react";

import { buttonStyles } from "@/components/ui";

/** Copies public, non-secret text (URLs, commands). Never used for credentials. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code
        aria-label={label}
        className="border-border bg-surface-muted flex-1 overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[0.8125rem] whitespace-nowrap"
      >
        {value}
      </code>
      <button
        type="button"
        className={buttonStyles.secondary}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable: the text is selectable */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
