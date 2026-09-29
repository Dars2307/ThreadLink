"use client";

import { Clock, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { provenanceAction, revealSessionAction } from "@/app/dashboard/chat-live-actions";
import { DrawerCard } from "@/components/dashboard/chat/panels";
import { buttonStyles, cx } from "@/components/ui";
import { modelDisplayName } from "@/lib/dashboard/labels";
import { registryEntry, type Registry } from "@/lib/dashboard/registry";
import {
  provenanceRows,
  sessionReasonText,
  verificationOf,
  type RunProvenance11,
  type VerificationView,
} from "@/lib/dashboard/timeline";
import {
  agentShortName,
  durationText,
  runTimingsText,
  timingBreakdown,
} from "@/runtime/src/chat-presentation";

/**
 * Where one agent message came from: provider, role, models, native session
 * (Available / Not exposed, owner-only reveal), host, worktree, times,
 * timings, access and verification. Rendered inside the chat's right drawer
 * (Provenance tab); the drawer owns focus, Escape and the overlay.
 */
export function ProvenancePanel({
  chatId,
  runId,
  who,
  registry,
  onVerified,
  compact = false,
}: {
  chatId: string;
  runId: string;
  who: string;
  registry: Registry;
  onVerified: (runId: string, v: VerificationView) => void;
  /** Details tab: only "This message" and "Where the time went". */
  compact?: boolean;
}) {
  const [state, setState] = useState<{
    runId: string;
    loading: boolean;
    p: RunProvenance11 | null;
  }>({ runId, loading: true, p: null });
  const [reveal, setReveal] = useState<
    { sessionId: string; command: string | null } | { message: string } | null
  >(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    provenanceAction(chatId, runId)
      .then((p) => {
        if (!live) return;
        setState({ runId, loading: false, p });
        if (p) onVerified(runId, verificationOf(p));
      })
      .catch(() => live && setState({ runId, loading: false, p: null }));
    return () => {
      live = false;
    };
  }, [chatId, runId, onVerified]);

  const loading = state.loading || state.runId !== runId;
  const p = loading ? null : state.p;
  const v = p ? verificationOf(p) : null;
  const timings = p ? runTimingsText(p.timings) : null;
  const session = p ? sessionReasonText(p.sessionReason) : null;

  const entry = p ? registryEntry(registry, p.provider, p.providerName || null) : null;
  const parts = p ? timingBreakdown(p.timings, agentShortName(entry!.id, entry!.shortName)) : [];

  return (
    <div className="flex flex-col gap-3.5">
      {loading ? (
        <p className="text-muted text-sm" role="status">
          Loading…
        </p>
      ) : !p ? (
        <p className="text-muted text-sm" role="status">
          Run details are not available for this message.
        </p>
      ) : (
        <>
          <DrawerCard icon={ShieldCheck} title="This message">
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-y-[7px] text-[13px]">
              <dt className="text-subtle">Agent</dt>
              <dd className="min-w-0 break-words">{who}</dd>
              <dt className="text-subtle">Model</dt>
              <dd className="min-w-0 break-words">
                {p.observedModel ? modelDisplayName(p.observedModel) : "Not reported"}
                {p.observedModel ? (p.modelVerified ? " · verified" : " · not confirmed") : ""}
              </dd>
              <dt className="text-subtle">Session</dt>
              <dd className="min-w-0 break-words">
                {session ??
                  (p.nativeSession.available ? "Available" : "Not exposed by this provider")}
              </dd>
              <dt className="text-subtle">Ran on</dt>
              <dd className="min-w-0 break-words">{p.executionHost ?? "Unknown"}</dd>
              <dt className="text-subtle">Evidence</dt>
              <dd
                className={cx(
                  v!.state === "verified"
                    ? "text-success"
                    : v!.state === "partial"
                      ? "text-warning"
                      : "text-muted",
                )}
              >
                {v!.state === "verified" ? "Verified" : v!.label}
              </dd>
            </dl>
            {v!.notes.length ? (
              <ul className="text-muted list-disc pl-5 text-xs">
                {v!.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </DrawerCard>

          {parts.length ? (
            <DrawerCard icon={Clock} title="Where the time went">
              <div
                className="bg-track tl-grow flex h-2 overflow-hidden rounded"
                role="img"
                aria-label={timings ?? "Timings"}
              >
                {parts.map((t) => (
                  <span
                    key={t.key}
                    style={{ width: `${t.percent}%` }}
                    className={
                      t.key === "provider"
                        ? "from-accent bg-gradient-to-r to-[#8b7bff]"
                        : t.key === "startup"
                          ? "bg-seg2"
                          : "bg-seg1"
                    }
                  />
                ))}
              </div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-[5px] text-[13px]">
                {parts.map((t) => (
                  <div key={t.key} className="contents">
                    <dt className="text-muted">{t.label}</dt>
                    <dd className="font-mono">{durationText(t.ms)}</dd>
                  </div>
                ))}
              </dl>
            </DrawerCard>
          ) : null}

          {compact ? null : (
            <details className="border-line-soft bg-card rounded-xl border px-3.5 py-3 text-sm">
              <summary className="text-subtle cursor-pointer text-xs font-semibold">
                All run details
              </summary>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 pt-3 text-[13px]">
                {provenanceRows(p, registry).map((r) => (
                  <div key={r.key} className="contents">
                    <dt className="text-subtle">{r.label}</dt>
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
                {timings ? (
                  <>
                    <dt className="text-subtle">Timings</dt>
                    <dd className="min-w-0 break-words">{timings}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          )}
          {!compact && p.nativeSession.available ? (
            <div className="border-border flex flex-col gap-2 border-t pt-3">
              <p className="text-muted text-xs">
                The native session id is private to you. Reveal it only to continue this work in the
                provider yourself.
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
  );
}
