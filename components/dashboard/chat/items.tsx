"use client";

import { ArrowRight, Clock, Reply, RotateCcw, TriangleAlert, type LucideIcon } from "lucide-react";
import { memo, useActionState, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { decideChoiceAction } from "@/app/dashboard/chat-live-actions";
import { ActionStatus } from "@/components/dashboard/action-form";
import { SafeBody } from "@/components/dashboard/chat/safe-body";
import { Badge, buttonStyles, cx, type Tone } from "@/components/ui";
import { runAction, type ActionResult } from "@/lib/dashboard/action-result";
import { artifactHref } from "@/lib/dashboard/chat";
import { resetTimeText } from "@/runtime/src/chat-presentation";

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

export type RowHandlers = {
  chatId: string;
  onOpenProvenance: (runId: string, who: string) => void;
  onJump: (eventId: string) => void;
  onTogglePhase: (phase: Phase) => void;
  /** 0.11: open the right drawer on a tab (Progress, Findings…). */
  onOpenPanel?: (tab: "activity" | "progress" | "findings" | "details") => void;
};

/** Hover/focus-only detail: never takes space from the conversation's text. */
const REVEAL =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none";

const ROW = "tl-row [contain-intrinsic-size:auto_4.5rem] [content-visibility:auto]";

function Time({ at, className }: { at: string; className?: string }) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <time
      dateTime={at}
      suppressHydrationWarning
      title={d.toLocaleString()}
      className={cx("text-subtle text-[0.7rem] tabular-nums", className)}
    >
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** "Replying to Claude · “The biggest one I see is coupling…”" (design canvas). */
function Quote({ quote, onJump }: { quote: QuoteView; onJump: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onJump(quote.targetId)}
      className="text-subtle hover:text-foreground mb-0.5 flex max-w-full min-w-0 items-center gap-1.5 text-left text-[13px]"
      aria-label={`Replying to ${quote.who}: ${quote.excerpt}. Jump to that message.`}
    >
      <Reply aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Replying to {quote.who} · “{quote.excerpt}”
      </span>
    </button>
  );
}

const AVATAR: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-surface-muted text-muted",
};

/** Provider colours from the design: Claude clay, Codex graphite, others by registry tone. */
export function avatarClass(identity: Pick<Identity, "avatar" | "tone" | "style">): string {
  if (identity.style === "controller")
    return "border-border-strong text-muted border border-dashed";
  if (identity.avatar === "claude") return "bg-claude-bg text-claude-fg";
  if (identity.avatar === "codex") return "bg-codex-bg text-codex-fg";
  return AVATAR[identity.tone];
}

function Avatar({ identity }: { identity: Identity }) {
  return (
    <span
      aria-hidden
      className={cx(
        "flex size-7 items-center justify-center rounded-lg text-xs font-semibold select-none max-sm:size-[26px] max-sm:text-[11px]",
        avatarClass(identity),
      )}
    >
      {identity.initial}
    </span>
  );
}

/** "Claude · Builder", a subtle ✓ Verified, the time on hover. */
function NameLine({
  identity,
  at,
  runId,
  verified,
  onOpenProvenance,
}: {
  identity: Identity;
  at: string;
  runId: string | null;
  verified: boolean;
  onOpenProvenance: RowHandlers["onOpenProvenance"];
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
      <span className="text-foreground font-semibold">{identity.name}</span>
      {identity.role ? <span className="text-subtle">· {identity.role}</span> : null}
      {verified ? (
        <button
          type="button"
          onClick={() => runId && onOpenProvenance(runId, identity.headline)}
          className="text-success/80 hover:text-success text-[0.7rem]"
          title="Verified: see where this came from"
        >
          ✓ Verified
        </button>
      ) : null}
      {identity.modelMismatch ? (
        <button
          type="button"
          onClick={() => runId && onOpenProvenance(runId, identity.headline)}
          className="text-danger text-[0.7rem]"
          title={identity.modelMismatch}
        >
          <span aria-hidden>⚠ </span>Model differs
        </button>
      ) : null}
      <Time at={at} className={REVEAL} />
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  item,
  verified,
  highlighted,
  handlers,
  selected = false,
}: {
  item: MessageItem;
  verified: boolean;
  highlighted: boolean;
  handlers: RowHandlers;
  /** Its run is shown in the Details drawer. */
  selected?: boolean;
}) {
  const id = item.identity;
  if (id.style === "owner") {
    const quietDelivery = item.delivery !== null && /^(Sent|Seen by)/.test(item.delivery);
    return (
      <li
        id={`m-${item.key}`}
        data-key={item.key}
        className={cx(ROW, "group flex flex-col items-end", item.showHeader ? "pt-5" : "pt-1.5")}
      >
        <span className="sr-only">You:</span>
        <div
          className={cx(
            "bg-bubble text-foreground flex max-w-[min(35rem,88%)] min-w-0 flex-col rounded-[16px_16px_4px_16px] px-3.5 py-2.5 text-[15px] leading-[1.55]",
            highlighted && "ring-accent ring-2",
          )}
        >
          {item.quote ? <Quote quote={item.quote} onJump={handlers.onJump} /> : null}
          {item.audience ? <p className="text-subtle text-[0.7rem]">{item.audience}</p> : null}
          <SafeBody text={item.body} />
        </div>
        <div className="flex items-center gap-2 pt-0.5 text-[0.7rem]">
          {item.delivery ? (
            <span
              className={cx("text-subtle", quietDelivery && REVEAL)}
              aria-label={`Delivery: ${item.delivery}`}
            >
              {item.delivery}
            </span>
          ) : null}
          <Time at={item.at} className={REVEAL} />
        </div>
      </li>
    );
  }
  const agent = id.style === "agent";
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className={cx(
        ROW,
        "group flex items-start gap-3 max-sm:gap-2.5",
        item.showHeader ? "pt-5" : "pt-1.5",
        selected && "bg-sel border-line-soft -mx-3 mt-3.5 rounded-xl border px-3 pt-2.5 pb-2.5",
      )}
      aria-label={item.showHeader ? undefined : `${id.headline}, continued`}
      aria-current={selected ? "true" : undefined}
    >
      <div className="w-7 shrink-0 pt-0.5">{item.showHeader ? <Avatar identity={id} /> : null}</div>
      <div
        className={cx(
          "flex min-w-0 flex-1 flex-col gap-1 rounded-lg",
          highlighted && "ring-accent ring-2 ring-offset-4 ring-offset-[var(--background)]",
        )}
      >
        {item.showHeader ? (
          <NameLine
            identity={id}
            at={item.at}
            runId={item.runId}
            verified={verified}
            onOpenProvenance={handlers.onOpenProvenance}
          />
        ) : (
          <span className="sr-only">{id.headline}:</span>
        )}
        {item.quote ? <Quote quote={item.quote} onJump={handlers.onJump} /> : null}
        {item.kindLabel || item.audience || item.round ? (
          <p className="text-subtle text-[0.7rem]">
            {[item.kindLabel, item.audience, item.round].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <div className="text-foreground text-[15px] leading-[1.6]">
          <SafeBody text={item.body} />
        </div>
        {selected ? (
          <p className="text-accent text-xs">Selected · details shown on the right</p>
        ) : null}
        {agent && item.runId && !selected ? (
          <div className={cx("flex items-center gap-2 pt-0.5", REVEAL)}>
            {!item.showHeader ? <Time at={item.at} /> : null}
            <button
              type="button"
              onClick={() => handlers.onOpenProvenance(item.runId!, id.headline)}
              className="text-subtle hover:text-foreground rounded text-[0.7rem]"
              aria-label={`Details about ${id.headline}'s run`}
            >
              Details
            </button>
          </div>
        ) : null}
      </div>
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
    // The design's notice card: failover, provider blocked, usage notices.
    return (
      <li id={`m-${item.key}`} data-key={item.key} className={cx(ROW, "pt-5")}>
        <div
          role="note"
          className={cx(
            "border-notice-line bg-notice-bg flex flex-col gap-2.5 rounded-xl border px-4 py-3.5",
            highlighted && "ring-accent ring-2",
          )}
        >
          <p className="text-notice-ink flex items-center gap-2 text-[13px] font-semibold">
            <TriangleAlert aria-hidden className="size-[15px]" />
            ThreadLink
          </p>

          <p className="text-foreground text-sm leading-[1.55] break-words">{item.text}</p>
          {item.subject ? (
            <p className="text-subtle text-xs" suppressHydrationWarning>
              {item.resetsAt
                ? `${item.subject} ${resetTimeText(item.resetsAt).replace(/^Resets/, "resets")}`
                : `${item.subject}: reset time not reported`}{" "}
              · No paid usage was used
            </p>
          ) : null}
        </div>
      </li>
    );
  }
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className={cx(
        ROW,
        "group flex items-baseline justify-center gap-2 px-1 pt-3 text-xs",
        highlighted && "bg-accent-soft rounded",
      )}
    >
      <span aria-hidden className={cx("shrink-0", TONE_TEXT[item.tone])}>
        {item.symbol}
      </span>
      <p
        className={cx(
          "min-w-0 text-center break-words",
          item.tone === "neutral" ? "text-muted" : TONE_TEXT[item.tone],
          item.technical && "opacity-80",
        )}
      >
        <span className="sr-only">ThreadLink: </span>
        {item.text}
      </p>
      <Time at={item.at} className={REVEAL} />
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
      className={cx(ROW, "flex items-center gap-3 py-2")}
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
      className={cx(ROW, "flex items-center gap-3 pt-4")}
      role="separator"
      aria-label={`${item.count} unread`}
    >
      <span aria-hidden className="bg-accent/40 h-px flex-1" />
      <span className="text-accent text-[0.7rem] font-medium">
        {item.count === 1 ? "1 new message" : `${item.count} new messages`}
      </span>
      <span aria-hidden className="bg-accent/40 h-px flex-1" />
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

/** 0.11 kinds answered with one click (reversible, never an approval). */
const ONE_CLICK = new Set(["usage_exhausted", "start_work"]);

const OPTION_ICONS: Record<string, LucideIcon> = {
  continue_other: ArrowRight,
  use_other: ArrowRight,
  retry_other: ArrowRight,
  run_work: ArrowRight,
  check_again: RotateCcw,
  wait: Clock,
};

function OneClickButton({
  label,
  primary,
  danger = false,
  optionKey,
}: {
  label: string;
  primary: boolean;
  danger?: boolean;
  optionKey: string;
}) {
  const Icon = Object.hasOwn(OPTION_ICONS, optionKey) ? OPTION_ICONS[optionKey] : null;
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cx(
        "flex h-[34px] items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-opacity disabled:opacity-60 motion-reduce:transition-none",
        danger
          ? "text-danger hover:bg-danger-soft"
          : primary
            ? "bg-send-bg text-send-fg hover:opacity-90"
            : "border-field text-foreground hover:bg-active border",
      )}
    >
      {Icon && !danger ? <Icon aria-hidden className="size-3.5" /> : null}
      {pending ? "Sending…" : label}
    </button>
  );
}

/** "Resets around 14:52" in the viewer's own time, or "Reset time not reported." */
function ResetLine({ resetsAt }: { resetsAt: string | null }) {
  return (
    <p className="text-subtle text-xs" suppressHydrationWarning>
      {resetTimeText(resetsAt)}
    </p>
  );
}

/**
 * Allowed options only (from the server's per-kind allow-list). Approval and
 * 0.10 kinds: pick, then confirm. usage_exhausted / start_work: one click.
 */
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
  if (!choice.approval && choice.kindName && ONE_CLICK.has(choice.kindName)) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={choice.title}>
          {choice.options.map((o, i) => (
            <form key={o.key} action={formAction}>
              <input type="hidden" name="choiceId" value={choice.choiceId!} />
              <input type="hidden" name="chatId" value={chatId} />
              <input type="hidden" name="option" value={o.key} />
              <input type="hidden" name="confirmed" value={o.key} />
              <OneClickButton
                label={o.label}
                primary={i === 0}
                danger={o.key === "stop"}
                optionKey={o.key}
              />
            </form>
          ))}
        </div>
        {choice.kindName === "usage_exhausted" ? <ResetLine resetsAt={choice.resetsAt} /> : null}
        <ActionStatus state={state} />
      </div>
    );
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
    "border-border bg-card flex w-full min-w-0 flex-col gap-2 rounded-xl border px-4 py-3 text-sm",

    highlighted && "ring-accent ring-2",
  );
  const agentHeader =
    item.identity.style === "agent" ? (
      <NameLine
        identity={item.identity}
        at={item.at}
        runId={item.runId}
        verified={verified}
        onOpenProvenance={handlers.onOpenProvenance}
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
          className={cx(frame, "shadow-float gap-3 p-4")}
          role="group"
          aria-label="Your decision is needed"
        >
          <p className="text-subtle text-[11px] font-semibold tracking-[0.06em] uppercase">
            Needs your decision
          </p>
          <p className="text-sm leading-normal font-semibold break-words">{c.title}</p>
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
            {handlers.onOpenPanel ? (
              <button
                type="button"
                onClick={() => handlers.onOpenPanel?.("progress")}
                className="text-accent text-xs font-medium"
              >
                Findings and progress
              </button>
            ) : (
              <a href="?tab=progress" className="text-accent text-xs font-medium">
                Findings and progress
              </a>
            )}
          </p>
        </div>
      );
      break;
  }
  return (
    <li
      id={`m-${item.key}`}
      data-key={item.key}
      className={cx(ROW, "group flex items-start gap-3 pt-5 max-sm:gap-2.5")}
    >
      {item.identity.style === "agent" ? (
        <div className="w-7 shrink-0 pt-0.5">
          <Avatar identity={item.identity} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        {agentHeader}
        {item.quote ? <Quote quote={item.quote} onJump={handlers.onJump} /> : null}
        {body}
      </div>
    </li>
  );
});
