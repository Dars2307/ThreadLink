"use client";

import { memo, useActionState, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { decideChoiceAction } from "@/app/dashboard/chat-live-actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { SafeBody } from "@/components/dashboard/chat/safe-body";
import { Badge, buttonStyles, cx, type Tone } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";
import { artifactHref } from "@/lib/dashboard/chat";
import type {
  CardItem,
  ChoiceCardView,
  Identity,
  MessageItem,
  NoteItem,
  Phase,
  PhaseItem,
  QuoteView,
  UnreadItem,
} from "@/lib/dashboard/timeline";

/**
 * One row of the chat timeline. Every row is memoised: typing in the composer
 * or a poll that adds rows never re-renders rows that did not change.
 */

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
  neutral: "text-muted",
};

const TONE_BORDER: Record<Tone, string> = {
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
  accent: "border-l-accent",
  neutral: "border-l-border-strong",
};

const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-subtle",
};

export type RowHandlers = {
  chatId: string;
  onOpenProvenance: (runId: string, who: string) => void;
  onJump: (eventId: string) => void;
  onTogglePhase: (phase: Phase) => void;
};

function Time({ at }: { at: string }) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <time
      dateTime={at}
      suppressHydrationWarning
      title={d.toLocaleString()}
      className="text-subtle text-[0.7rem]"
    >
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

function Quote({ quote, onJump }: { quote: QuoteView; onJump: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onJump(quote.targetId)}
      className="border-border-strong text-muted hover:text-foreground hover:bg-surface-muted flex max-w-full min-w-0 items-baseline gap-1.5 rounded-md border-l-2 px-2 py-1 text-left text-xs"
      aria-label={`Replying to ${quote.who}: ${quote.excerpt}. Jump to that message.`}
    >
      <span aria-hidden>↩</span>
      <span className="shrink-0 font-medium">{quote.who}</span>
      <span className="min-w-0 truncate">{quote.excerpt}</span>
    </button>
  );
}

/** Header for an author: distinct per identity style; agents from registry metadata. */
function Header({
  identity,
  at,
  runId,
  verified,
  onOpenProvenance,
  right,
}: {
  identity: Identity;
  at: string;
  runId: string | null;
  verified: boolean;
  onOpenProvenance: RowHandlers["onOpenProvenance"];
  right: boolean;
}) {
  return (
    <div className={cx("flex flex-col gap-0.5", right && "items-end")}>
      <div
        className={cx(
          "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs",
          right && "justify-end",
        )}
      >
        {identity.style === "agent" ? (
          <span aria-hidden className={cx("size-2 rounded-full", TONE_DOT[identity.tone])} />
        ) : null}
        <span className="text-foreground font-semibold">{identity.headline}</span>
        {verified ? (
          <button
            type="button"
            onClick={() => runId && onOpenProvenance(runId, identity.headline)}
            className="text-success hover:bg-success-soft rounded-full px-1.5 text-[0.7rem] font-medium"
            title="Verified: see where this came from"
          >
            ✓ Verified
          </button>
        ) : null}
        <Time at={at} />
        {runId && identity.style === "agent" ? (
          <button
            type="button"
            onClick={() => onOpenProvenance(runId, identity.headline)}
            className="text-subtle hover:text-foreground rounded px-1 text-[0.7rem]"
            aria-label={`Details about ${identity.headline}'s run`}
          >
            Details
          </button>
        ) : null}
      </div>
      {identity.model ? <p className="text-subtle text-[0.7rem]">{identity.model}</p> : null}
      {identity.modelMismatch ? (
        <p className="text-danger text-[0.7rem]">
          <span aria-hidden>⚠ </span>Model mismatch: {identity.modelMismatch}
        </p>
      ) : null}
    </div>
  );
}

const BUBBLE: Record<Identity["style"], string> = {
  owner: "bg-accent-soft text-foreground rounded-tr-md",
  controller: "border-border-strong bg-surface-muted/60 rounded-tl-md border border-dashed",
  threadlink: "border-border bg-surface-muted rounded-tl-md border",
  agent: "border-border bg-surface rounded-tl-md border border-l-4",
};

export const MessageRow = memo(function MessageRow({
  item,
  verified,
  highlighted,
  handlers,
}: {
  item: MessageItem;
  verified: boolean;
  highlighted: boolean;
  handlers: RowHandlers;
}) {
  const right = item.identity.style === "owner";
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className={cx(
        "tl-row flex flex-col gap-1 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]",
        right ? "items-end" : "items-start",
        item.showHeader ? "pt-2" : "",
      )}
      aria-label={item.showHeader ? undefined : `${item.identity.headline}, continued`}
    >
      {item.showHeader ? (
        <Header
          identity={item.identity}
          at={item.at}
          runId={item.runId}
          verified={verified}
          onOpenProvenance={handlers.onOpenProvenance}
          right={right}
        />
      ) : (
        <span className="sr-only">{item.identity.headline}:</span>
      )}
      <div
        className={cx(
          "flex max-w-[min(44rem,100%)] min-w-0 flex-col gap-1.5 rounded-2xl px-3.5 py-2.5 transition-shadow",
          BUBBLE[item.identity.style],
          item.identity.style === "agent" && TONE_BORDER[item.identity.tone],
          highlighted && "ring-accent ring-2",
        )}
      >
        {item.quote ? <Quote quote={item.quote} onJump={handlers.onJump} /> : null}
        {item.kindLabel || item.audience || item.round ? (
          <p className="text-subtle text-[0.7rem] font-medium tracking-wide uppercase">
            {[item.kindLabel, item.audience, item.round].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <SafeBody text={item.body} />
      </div>
      {item.delivery ? (
        <p className="text-subtle text-[0.7rem]" aria-label={`Delivery: ${item.delivery}`}>
          {item.delivery}
        </p>
      ) : null}
    </li>
  );
});

export const NoteRow = memo(function NoteRow({
  item,
  highlighted,
}: {
  item: NoteItem;
  highlighted: boolean;
}) {
  if (item.callout) {
    return (
      <li
        id={`m-${item.key}`}
        data-key={item.key}
        className="tl-row [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
      >
        <div
          role="note"
          className="border-warning/40 bg-warning-soft text-warning flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm"
        >
          <p className="break-words">
            <span className="sr-only">ThreadLink: </span>
            {item.text}
          </p>
        </div>
      </li>
    );
  }
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className={cx(
        "tl-row flex items-baseline gap-2 px-1 text-xs [contain-intrinsic-size:auto_4rem] [content-visibility:auto]",
        highlighted && "bg-accent-soft rounded",
      )}
    >
      <span aria-hidden className={cx("w-3 shrink-0 text-center", TONE_TEXT[item.tone])}>
        {item.symbol}
      </span>
      <p
        className={cx(
          "min-w-0 break-words",
          item.tone === "neutral" ? "text-muted" : TONE_TEXT[item.tone],
          item.technical && "opacity-80",
        )}
      >
        <span className="sr-only">ThreadLink: </span>
        {item.text}
      </p>
      <span className="ml-auto shrink-0">
        <Time at={item.at} />
      </span>
    </li>
  );
});

export const PhaseRow = memo(function PhaseRow({
  item,
  collapsed,
  onToggle,
}: {
  item: PhaseItem;
  collapsed: boolean;
  onToggle: (p: Phase) => void;
}) {
  return (
    <li
      className="tl-row flex items-center gap-3 py-2 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
      role="separator"
      aria-label={`${item.label} phase`}
    >
      <span aria-hidden className="bg-border h-px flex-1" />
      <button
        type="button"
        onClick={() => onToggle(item.phase)}
        aria-expanded={!collapsed}
        className="text-muted hover:text-foreground border-border rounded-full border px-3 py-0.5 text-[0.7rem] font-semibold tracking-wide uppercase"
      >
        {item.label} <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
        <span className="sr-only">{collapsed ? " (collapsed, show)" : " (hide)"}</span>
      </button>
      <span aria-hidden className="bg-border h-px flex-1" />
    </li>
  );
});

export const UnreadRow = memo(function UnreadRow({ item }: { item: UnreadItem }) {
  return (
    <li
      id="unread-divider"
      className="tl-row flex items-center gap-3 py-1 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
      role="separator"
      aria-label={`${item.count} unread`}
    >
      <span aria-hidden className="bg-danger/50 h-px flex-1" />
      <span className="text-danger text-[0.7rem] font-semibold">
        {item.count === 1 ? "1 new message" : `${item.count} new messages`}
      </span>
      <span aria-hidden className="bg-danger/50 h-px flex-1" />
    </li>
  );
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function ConfirmChoiceButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonStyles.primary}>
      {pending ? "Sending…" : `Confirm: ${label}`}
    </button>
  );
}

/** Allowed options only (from the server's per-kind allow-list); pick, then confirm. */
export function ChoiceBlock({ choice, chatId }: { choice: ChoiceCardView; chatId: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => runAction(decideChoiceAction, fd),
    null,
  );
  if (choice.status !== "pending") {
    return (
      <p className="text-muted text-sm">
        {choice.status === "chosen"
          ? `You chose: ${choice.chosenLabel ?? "an option"}.`
          : choice.status === "expired"
            ? "This choice expired."
            : "This choice was cancelled."}
      </p>
    );
  }
  if (!choice.choiceId || choice.options.length === 0) {
    return <p className="text-muted text-sm">Waiting for the options to load.</p>;
  }
  const pickedOption = choice.options.find((o) => o.key === picked) ?? null;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="choiceId" value={choice.choiceId} />
      <input type="hidden" name="chatId" value={chatId} />
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{choice.title}</legend>
        {choice.options.map((o) => (
          <label
            key={o.key}
            className={cx(
              "cursor-pointer rounded-lg border px-3 py-1.5 text-sm",
              picked === o.key
                ? "border-accent bg-accent-soft text-accent font-medium"
                : "border-border-strong hover:bg-surface-muted",
            )}
          >
            <input
              type="radio"
              name="option"
              value={o.key}
              checked={picked === o.key}
              onChange={() => setPicked(o.key)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      {pickedOption ? (
        <div className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="confirmed" value={pickedOption.key} />
          <ConfirmChoiceButton label={pickedOption.label} />
          <button type="button" className={buttonStyles.ghost} onClick={() => setPicked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      <ActionStatus state={state} />
    </form>
  );
}

function ArtifactLink({
  chatId,
  artifactId,
  children,
}: {
  chatId: string;
  artifactId: string;
  children: string;
}) {
  return (
    <a
      href={artifactHref(chatId, artifactId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent text-xs font-medium"
    >
      {children}
    </a>
  );
}

export const CardRow = memo(function CardRow({
  item,
  verified,
  highlighted,
  handlers,
}: {
  item: CardItem;
  verified: boolean;
  highlighted: boolean;
  handlers: RowHandlers;
}) {
  const c = item.card;
  const frame = cx(
    "border-border bg-surface flex w-full max-w-[min(44rem,100%)] min-w-0 flex-col gap-2 rounded-xl border px-4 py-3 text-sm",
    highlighted && "ring-accent ring-2",
  );
  const agentHeader =
    item.identity.style === "agent" ? (
      <Header
        identity={item.identity}
        at={item.at}
        runId={item.runId}
        verified={verified}
        onOpenProvenance={handlers.onOpenProvenance}
        right={false}
      />
    ) : null;
  let body: ReactNode;
  switch (c.kind) {
    case "finding":
      body = (
        <div
          className={cx(
            frame,
            "border-l-4",
            c.severityTone === "danger"
              ? "border-l-danger"
              : c.severityTone === "warning"
                ? "border-l-warning"
                : "border-l-border-strong",
          )}
        >
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-subtle font-semibold tracking-wide uppercase">Finding</span>
            <span className="text-muted">{c.category}</span>
            <Badge tone={c.severityTone}>{c.severity}</Badge>
            <Badge tone={c.statusTone}>{c.statusLabel}</Badge>
          </p>
          <p className="font-medium break-words">{c.title}</p>
          <dl className="text-muted grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt>Raised by</dt>
            <dd>{c.raisedBy}</dd>
            {c.owner ? (
              <>
                <dt>Owner</dt>
                <dd>{c.owner}</dd>
              </>
            ) : null}
            {c.location ? (
              <>
                <dt>Where</dt>
                <dd className="font-mono break-all">{c.location}</dd>
              </>
            ) : null}
            {c.history.length > 1 ? (
              <>
                <dt>History</dt>
                <dd>{c.history.map((h) => h[0]!.toUpperCase() + h.slice(1)).join(" → ")}</dd>
              </>
            ) : null}
          </dl>
        </div>
      );
      break;
    case "decision":
      body = (
        <div className={frame}>
          <p className="text-subtle text-xs font-semibold tracking-wide uppercase">Decision</p>
          <p className="font-medium break-words">{c.title}</p>
          {c.attributedTo ? (
            <p className="text-subtle text-xs">Proposed by {c.attributedTo}</p>
          ) : null}
          {c.body ? <SafeBody text={c.body} /> : null}
          {c.technicalId ? (
            <details className="text-subtle text-xs">
              <summary className="cursor-pointer">Details</summary>
              <p className="pt-1 font-mono">{c.technicalId}</p>
            </details>
          ) : null}
        </div>
      );
      break;
    case "choice":
      body = (
        <div
          className={cx(frame, "border-warning/50 border-l-warning border-l-4")}
          role="group"
          aria-label="Your decision is needed"
        >
          <p className="text-warning text-xs font-semibold tracking-wide uppercase">
            Needs your decision
          </p>
          <p className="font-medium break-words">{c.title}</p>
          <ChoiceBlock choice={c} chatId={handlers.chatId} />
        </div>
      );
      break;
    case "timeout":
    case "interrupted":
      body = (
        <div
          className={cx(frame, "border-warning/50 border-l-warning border-l-4")}
          role="group"
          aria-label={c.kind === "timeout" ? "Timed out" : "Interrupted"}
        >
          <p className="text-warning text-xs font-semibold tracking-wide uppercase">
            {c.kind === "timeout" ? "Timed out" : "Interrupted"}
          </p>
          <p className="break-words">{c.text}</p>
          {c.choice ? <ChoiceBlock choice={c.choice} chatId={handlers.chatId} /> : null}
        </div>
      );
      break;
    case "code_change":
      body = (
        <div className={frame}>
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-subtle font-semibold tracking-wide uppercase">Code change</span>
            <span>
              {c.filesChanged} {c.filesChanged === 1 ? "file" : "files"} ·{" "}
              <span className="text-success">+{c.insertions}</span>{" "}
              <span className="text-danger">−{c.deletions}</span>
            </span>
            {c.branch ? <span className="text-muted font-mono">{c.branch}</span> : null}
            {c.commit ? <span className="text-subtle font-mono">{c.commit}</span> : null}
          </p>
          {c.files.length ? (
            <ul className="text-muted flex flex-col font-mono text-xs">
              {c.files.map((f, i) => (
                <li key={i} className="truncate" title={f}>
                  {f}
                </li>
              ))}
              {c.moreFiles > 0 ? (
                <li className="text-subtle font-sans">and {c.moreFiles} more</li>
              ) : null}
            </ul>
          ) : null}
          {c.tests.length ? (
            <ul className="flex flex-col gap-0.5 text-xs">
              {c.tests.map((t, i) => (
                <li key={i} className={t.ok ? "text-success" : "text-danger"}>
                  <span aria-hidden>{t.ok ? "✓ " : "✕ "}</span>
                  <span className="sr-only">{t.ok ? "Passed: " : "Failed: "}</span>
                  <span className="font-mono">{t.command}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-subtle text-xs">No checks were recorded for this change.</p>
          )}
          {c.diffArtifactId ? (
            <ArtifactLink chatId={handlers.chatId} artifactId={c.diffArtifactId}>
              View diff
            </ArtifactLink>
          ) : null}
        </div>
      );
      break;
    case "job_summary":
      body = (
        <div
          className={cx(
            frame,
            "border-l-4",
            c.verdictTone === "success"
              ? "border-l-success"
              : c.verdictTone === "danger"
                ? "border-l-danger"
                : "border-l-warning",
          )}
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-subtle text-xs font-semibold tracking-wide uppercase">
              Summary
            </span>
            <Badge tone={c.verdictTone}>{c.verdict}</Badge>
          </p>
          {c.counts.length ? (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {c.counts.map((x) => (
                <div key={x.key} className="bg-surface-muted rounded-lg px-2 py-1.5">
                  <dt className="text-subtle text-[0.7rem]">{x.label}</dt>
                  <dd className="text-base font-semibold tabular-nums">{x.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <ul className="text-muted flex flex-col gap-0.5 text-xs">
            {c.tests ? <li>{c.tests}</li> : null}
            {c.agents ? <li>Agents: {c.agents}</li> : null}
            {c.finalVerifier ? <li>Final check by {c.finalVerifier}</li> : null}
            <li>
              {c.openItems === 0
                ? "Nothing left open."
                : `${c.openItems} item${c.openItems === 1 ? "" : "s"} still open.`}
            </li>
          </ul>
          <p className="flex flex-wrap gap-3">
            {c.reportArtifactId ? (
              <ArtifactLink chatId={handlers.chatId} artifactId={c.reportArtifactId}>
                Open report
              </ArtifactLink>
            ) : null}
            {c.diffArtifactId ? (
              <ArtifactLink chatId={handlers.chatId} artifactId={c.diffArtifactId}>
                View changes
              </ArtifactLink>
            ) : null}
            <a href="?tab=progress" className="text-accent text-xs font-medium">
              Findings and progress
            </a>
          </p>
        </div>
      );
      break;
  }
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className="tl-row flex flex-col items-start gap-1 pt-2 [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
    >
      {agentHeader}
      {item.quote ? <Quote quote={item.quote} onJump={handlers.onJump} /> : null}
      {body}
    </li>
  );
});
