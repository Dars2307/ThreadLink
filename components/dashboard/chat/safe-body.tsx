"use client";

import { memo, useId, useMemo, useState } from "react";

import { cx } from "@/components/ui";
import { tokenize, type BlockToken, type InlineToken } from "@/lib/dashboard/safe-text";

/**
 * Renders an untrusted message body as TEXT: paragraphs, inline code, fenced
 * code blocks (with Copy) and http(s) links only. There is no HTML path.
 * Long bodies start collapsed behind "Show more".
 */

const COLLAPSE_CHARS = 1200;
const COLLAPSE_BLOCKS = 8;

function Inline({ parts }: { parts: InlineToken[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "text" ? (
          <span key={i}>{p.v}</span>
        ) : p.t === "code" ? (
          <code key={i} className="bg-surface-muted rounded px-1 py-0.5 font-mono text-[0.8125rem]">
            {p.v}
          </code>
        ) : (
          <a
            key={i}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent break-all underline underline-offset-2"
          >
            {p.v}
          </a>
        ),
      )}
    </>
  );
}

export function CodeBlock({
  code,
  lang,
  truncatedLines,
}: {
  code: string;
  lang: string | null;
  truncatedLines: number;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border-border bg-surface-muted/70 relative w-full min-w-0 rounded-lg border">
      <div className="text-subtle flex items-center justify-between gap-2 px-3 pt-1.5 text-[0.7rem]">
        <span>{lang ?? "code"}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable: the text is selectable */
            }
          }}
          className="hover:text-foreground rounded px-1.5 py-0.5 font-medium"
          aria-label="Copy code"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[28rem] overflow-auto px-3 pt-1 pb-2.5 font-mono text-[0.8125rem] leading-relaxed">
        <code>{code}</code>
      </pre>
      {truncatedLines > 0 ? (
        <p className="text-subtle px-3 pb-2 text-[0.7rem]">
          {truncatedLines.toLocaleString("en-GB")} more lines not shown.
        </p>
      ) : null}
    </div>
  );
}

function Block({ b }: { b: BlockToken }) {
  if (b.t === "code")
    return <CodeBlock code={b.v} lang={b.lang} truncatedLines={b.truncatedLines} />;
  return (
    <p className="text-sm [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
      <Inline parts={b.parts} />
    </p>
  );
}

export const SafeBody = memo(function SafeBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const doc = useMemo(() => tokenize(text), [text]);
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = doc.chars > COLLAPSE_CHARS || doc.blocks.length > COLLAPSE_BLOCKS;
  let blocks = doc.blocks;
  if (long && !open) {
    let used = 0;
    const kept: BlockToken[] = [];
    for (const b of doc.blocks) {
      if (kept.length >= 3 || used > COLLAPSE_CHARS / 2) break;
      kept.push(b);
      used += b.t === "code" ? b.v.length : b.parts.reduce((m, p) => m + p.v.length, 0);
    }
    blocks = kept;
  }
  return (
    <div className={cx("flex min-w-0 flex-col items-start gap-2", className)}>
      <div id={id} className="flex w-full min-w-0 flex-col gap-2">
        {blocks.map((b, i) => (
          <Block key={i} b={b} />
        ))}
      </div>
      {doc.truncated && (open || !long) ? (
        <p className="text-subtle text-[0.7rem]">
          This message is very long; only the first part is shown. Export the chat for the full
          text.
        </p>
      ) : null}
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="text-accent text-xs font-medium"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
});
