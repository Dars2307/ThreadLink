"use client";

import { useEffect, useRef, useState } from "react";

import { provenanceAction, revealSessionAction } from "@/app/dashboard/chat-live-actions";
import { Badge, buttonStyles, cx } from "@/components/ui";
import type { RunProvenance } from "@/lib/chat/types";
import type { Registry } from "@/lib/dashboard/registry";
import { provenanceRows, verificationOf, type VerificationView } from "@/lib/dashboard/timeline";

/**
 * Where one agent message came from: provider, role, models, native session
 * (Available / Not exposed, owner-only reveal), host, worktree, times, access
 * and verification. A side panel on wide screens, a bottom sheet on phones.
 * Escape closes it and focus returns to what opened it.
 */
export function ProvenanceDrawer({
  chatId,
  runId,
  who,
  registry,
  onClose,
  onVerified,
}: {
  chatId: string;
  runId: string;
  who: string;
  registry: Registry;
  onClose: () => void;
  onVerified: (runId: string, v: VerificationView) => void;
}) {
  const [state, setState] = useState<{ loading: boolean; p: RunProvenance | null }>({
    loading: true,
    p: null,
  });
  const [reveal, setReveal] = useState<
    { sessionId: string; command: string | null } | { message: string } | null
  >(null);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    provenanceAction(chatId, runId)
      .then((p) => {
        if (!live) return;
        setState({ loading: false, p });
        if (p) onVerified(runId, verificationOf(p));
      })
      .catch(() => live && setState({ loading: false, p: null }));
    return () => {
      live = false;
    };
  }, [chatId, runId, onVerified]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const p = state.p;
  const v = p ? verificationOf(p) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center lg:items-stretch lg:justify-end"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close details"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prov-title"
        tabIndex={-1}
        className="border-border bg-surface shadow-card relative flex max-h-[85dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-2xl border p-5 outline-none lg:h-dvh lg:max-h-none lg:w-[26rem] lg:rounded-none lg:rounded-l-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="prov-title" className="text-base font-semibold">
              Where this came from
            </h2>
            <p className="text-muted text-sm">{who}</p>
          </div>
          <button type="button" onClick={onClose} className={buttonStyles.ghost}>
            Close
          </button>
        </div>

        {state.loading ? (
          <p className="text-muted text-sm" role="status">
            Loading…
          </p>
        ) : !p ? (
          <p className="text-muted text-sm" role="status">
            Run details are not available for this message.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Badge
                tone={
                  v!.state === "verified"
                    ? "success"
                    : v!.state === "partial"
                      ? "warning"
                      : "neutral"
                }
              >
                {v!.state === "verified" ? "✓ Verified" : v!.label}
              </Badge>
              {v!.notes.length ? (
                <ul className="text-muted list-disc pl-5 text-xs">
                  {v!.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {provenanceRows(p, registry).map((r) => (
                <div key={r.key} className="contents">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className="min-w-0 break-words">
                    {/^\d{4}-\d{2}-\d{2}T/.test(r.value) ? (
                      <time dateTime={r.value} suppressHydrationWarning>
                        {new Date(r.value).toLocaleString()}
                      </time>
                    ) : (
                      r.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {p.nativeSession.available ? (
              <div className="border-border flex flex-col gap-2 border-t pt-3">
                <p className="text-muted text-xs">
                  The native session id is private to you. Reveal it only to continue this work in
                  the provider yourself.
                </p>
                {reveal && "sessionId" in reveal ? (
                  <div className="flex flex-col gap-2">
                    <code className="bg-surface-muted rounded px-2 py-1 font-mono text-xs break-all">
                      {reveal.command ?? reveal.sessionId}
                    </code>
                    <button
                      type="button"
                      className={cx(buttonStyles.secondary, "w-fit")}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(reveal.command ?? reveal.sessionId);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        } catch {
                          /* selectable */
                        }
                      }}
                    >
                      {copied ? "Copied" : reveal.command ? "Copy command" : "Copy session id"}
                    </button>
                    {reveal.command ? (
                      <p className="text-subtle text-xs">
                        Run it yourself in the project folder. ThreadLink never runs it for you.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    className={cx(buttonStyles.secondary, "w-fit")}
                    onClick={async () => {
                      const r = await revealSessionAction(chatId, runId).catch(() => ({
                        ok: false as const,
                        message: "Could not reveal the session.",
                      }));
                      setReveal(
                        r.ok
                          ? { sessionId: r.sessionId, command: r.command }
                          : { message: r.message },
                      );
                    }}
                  >
                    Reveal native session
                  </button>
                )}
                {reveal && "message" in reveal ? (
                  <p role="alert" className="text-danger text-xs">
                    {reveal.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
