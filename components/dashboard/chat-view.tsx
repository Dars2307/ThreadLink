"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge, buttonStyles, cx, EmptyState } from "@/components/ui";
import type { ChatEvent, ChatPage } from "@/lib/chat/types";
import {
  announcement,
  CHAT_POST_URL,
  chatEventsUrl,
  chatReadUrl,
  checkDraft,
  COMPOSER_MAX,
  groupChat,
  isChatPage,
  isPostResult,
  mentionHints,
  mergeEvents,
  nextCursor,
  pollDelay,
  routeBanner,
  SEND_FAILED,
  sendOutcome,
  type ChatBubbleView,
  type ChatMilestoneView,
} from "@/lib/dashboard/chat";
import type { Tone } from "@/lib/dashboard/labels";

const LOAD_FAILED = "Could not load the chat right now. ThreadLink keeps trying.";

const MILESTONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
  neutral: "text-muted",
};

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

function Time({ at }: { at: string }) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <time dateTime={at} suppressHydrationWarning className="text-subtle text-[0.7rem]">
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

/** Body text: always a text node, never HTML. Long bodies start collapsed. */
function Body({ item }: { item: ChatBubbleView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-1">
      <p id={id} className="text-sm break-words whitespace-pre-wrap">
        {item.collapsible && !open ? item.preview : item.body}
      </p>
      {item.collapsible ? (
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
}

function Bubbles({ items, technical }: { items: ChatBubbleView[]; technical: boolean }) {
  const head = items[0]!;
  const right = head.side === "right";
  return (
    <li className={cx("flex flex-col gap-1", right ? "items-end" : "items-start")}>
      <div
        className={cx(
          "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs",
          right && "justify-end",
        )}
      >
        <span className="text-foreground font-semibold">{head.headline}</span>
        {head.author === "controller" ? <Badge tone="neutral">Controller</Badge> : null}
        {head.role ? <span className="text-muted">{head.role}</span> : null}
        {head.round ? <span className="text-subtle">{head.round}</span> : null}
        <Time at={head.at} />
      </div>
      {items.map((item, i) => {
        const prevModel = i > 0 ? items[i - 1]!.model : null;
        // The header already names the model; the line shows only when it matters.
        const showModel =
          item.model &&
          (item.modelMismatch || (technical && (i === 0 || item.model !== prevModel)));
        return (
          <div
            key={item.key}
            className={cx(
              "flex max-w-[min(42rem,100%)] flex-col gap-1.5 rounded-2xl px-3.5 py-2.5",
              right
                ? "bg-accent-soft text-foreground rounded-tr-md"
                : item.author === "controller"
                  ? "border-border bg-surface-muted/60 rounded-tl-md border"
                  : "border-border bg-surface rounded-tl-md border",
            )}
          >
            {item.kindLabel || item.audience ? (
              <p className="text-subtle text-[0.7rem] font-medium tracking-wide uppercase">
                {[item.kindLabel, item.audience].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <Body item={item} />
            {showModel ? (
              <p
                className={cx("text-[0.7rem]", item.modelMismatch ? "text-danger" : "text-subtle")}
              >
                {item.modelMismatch ? <span aria-hidden>⚠ </span> : null}
                {item.modelMismatch ? "Model mismatch: " : "Model: "}
                {item.model}
              </p>
            ) : null}
          </div>
        );
      })}
    </li>
  );
}

/** A ThreadLink line: compact, one symbol, plain text. */
function Milestone({ item, calloutHint }: { item: ChatMilestoneView; calloutHint: string | null }) {
  if (item.callout) {
    return (
      <li>
        <div
          role="note"
          className="border-warning/40 bg-warning-soft text-warning flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm"
        >
          <p className="break-words">{item.text}</p>
          {calloutHint && calloutHint !== item.text ? (
            <p className="text-foreground break-words">{calloutHint}</p>
          ) : null}
        </div>
      </li>
    );
  }
  return (
    <li className="flex items-baseline gap-2 px-1 text-xs">
      <span aria-hidden className={cx("w-3 shrink-0 text-center", MILESTONE_TEXT[item.tone])}>
        {item.symbol}
      </span>
      <p
        className={cx(
          "min-w-0 break-words",
          item.tone === "neutral" ? "text-muted" : MILESTONE_TEXT[item.tone],
          item.technical && "opacity-80",
        )}
      >
        <span className="sr-only">ThreadLink: </span>
        {item.text}
      </p>
    </li>
  );
}

export function ChatView({
  chatId,
  initial,
  controller,
  agentProviders,
  modeSummary,
  archived,
  hasProject,
  healthHint,
}: {
  chatId: string;
  /** First page rendered by the server, or null to load it in the browser. */
  initial: ChatPage | null;
  /** The connected controller's name, e.g. "ChatGPT", or a generic phrase. */
  controller: string;
  /** Provider ids of the chat's agents (for @mention hints). */
  agentProviders: string[];
  /** The chat's mode in words, e.g. "Team · Claude Code + Codex". */
  modeSummary: string;
  archived: boolean;
  hasProject: boolean;
  /** Fixed-text instruction shown beside a provider-blocked line, if any agent needs the user. */
  healthHint: string | null;
}) {
  const [events, setEvents] = useState<ChatEvent[]>(initial?.events ?? []);
  const [activeJob, setActiveJob] = useState<ChatPage["activeJob"]>(initial?.activeJob ?? null);
  const [loaded, setLoaded] = useState(initial !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const [live, setLive] = useState("");

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const cursor = useRef(initial ? nextCursor(0, initial) : 0);
  const readUpTo = useRef(0);
  const technicalRef = useRef(false);
  const inFlight = useRef(false);
  const idempotencyKey = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pokeRef = useRef<() => void>(() => {});
  const ids = useId();

  /** Tell the server the owner has seen up to the cursor. Best effort: a miss only leaves "unread". */
  const markRead = useCallback(() => {
    const seq = cursor.current;
    if (seq <= readUpTo.current || document.visibilityState !== "visible") return;
    readUpTo.current = seq;
    void fetch(chatReadUrl(chatId), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ seq }),
    }).catch(() => {
      readUpTo.current = 0;
    });
  }, [chatId]);

  /** Fetch everything after the cursor and append it. `announce` is false for the first load. */
  const poll = useCallback(
    async (announce: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const tech = technicalRef.current;
      try {
        const res = await fetch(chatEventsUrl(chatId, cursor.current, tech), {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const json: unknown = res.ok ? await res.json().catch(() => null) : null;
        if (!isChatPage(json)) throw new Error("bad page");
        if (tech !== technicalRef.current) return; // toggled meanwhile; a fresh load follows
        const page = json;
        cursor.current = nextCursor(cursor.current, page);
        setActiveJob(page.activeJob);
        setLoadError(null);
        setLoaded(true);
        if (page.events.length) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const added = page.events.filter((e) => !seen.has(e.id));
            if (announce && added.length) {
              const text = announcement(added, tech);
              if (text) setLive(text);
            }
            return mergeEvents(prev, page.events);
          });
        }
        markRead();
      } catch {
        setLoadError(LOAD_FAILED);
        setLoaded(true);
      } finally {
        inFlight.current = false;
      }
    },
    [chatId, markRead],
  );

  // Poll: every 3 s while visible, 15 s while hidden, paused after 10 minutes
  // without interaction until the person focuses or touches the page again.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paused = false;
    let stopped = false;
    let lastActive = Date.now();

    const schedule = () => {
      if (stopped) return;
      clearTimeout(timer);
      const delay = pollDelay({
        visible: document.visibilityState === "visible",
        idleMs: Date.now() - lastActive,
      });
      if (delay === null) {
        paused = true;
        return;
      }
      timer = setTimeout(async () => {
        await poll(true);
        schedule();
      }, delay);
    };
    const wake = () => {
      lastActive = Date.now();
      if (paused) {
        paused = false;
        void poll(true).then(schedule);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        lastActive = Date.now();
        paused = false;
        void poll(true).then(schedule);
      } else {
        schedule();
      }
    };
    pokeRef.current = () => {
      lastActive = Date.now();
      paused = false;
      void poll(true).then(schedule);
    };

    if (!loaded || cursor.current === 0) void poll(false).then(schedule);
    else {
      markRead();
      schedule();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
    // Re-run only when the chat or the technical view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, technical]);

  // Keep the newest message in view when the reader is already at the bottom.
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const groups = useMemo(() => groupChat(events, { technical }), [events, technical]);
  const hints = useMemo(() => mentionHints(agentProviders), [agentProviders]);
  const banner = routeBanner(activeJob, draft, modeSummary);
  const remaining = COMPOSER_MAX - draft.length;
  const closed = archived;

  const toggleTechnical = () => {
    const next = !technical;
    technicalRef.current = next;
    cursor.current = 0;
    setEvents([]);
    setLoaded(false);
    setTechnical(next);
  };

  const changeDraft = (value: string) => {
    // A changed message is a new message: it gets a new idempotency key.
    idempotencyKey.current = null;
    setDraft(value);
    if (outcome && !outcome.ok) setOutcome(null);
  };

  const insertMention = (insert: string) => {
    const rest = draft.replace(/^\s*@(claude|codex|team)\b\s*/i, "");
    const value = insert.startsWith("@team stop") ? insert : `${insert}${rest}`;
    changeDraft(value.slice(0, COMPOSER_MAX));
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (sending || closed) return;
    const check = checkDraft(draft);
    if (!check.ok) {
      setOutcome({ ok: false, message: check.message });
      textarea.current?.focus();
      return;
    }
    idempotencyKey.current ??= newKey();
    setSending(true);
    setOutcome(null);
    let result: { ok: boolean; message: string };
    try {
      // Only the chat and the text: the server routes it by the chat's mode and
      // any leading @mention. The browser never picks a builder.
      const res = await fetch(CHAT_POST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          chatId,
          body: check.body,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      result = isPostResult(json) ? sendOutcome(json) : { ok: false, message: SEND_FAILED };
    } catch {
      result = { ok: false, message: SEND_FAILED };
    }
    setOutcome(result);
    setSending(false);
    if (result.ok) {
      idempotencyKey.current = null;
      setDraft("");
      nearBottom.current = true;
      pokeRef.current();
    }
    // Focus returns to the composer either way, so the next message (or a fix) can follow.
    requestAnimationFrame(() => textarea.current?.focus());
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted text-sm">
          {activeJob ? (
            <>
              <Badge tone="accent">Working</Badge>{" "}
              <span className="sr-only">Work is running in this chat.</span>
            </>
          ) : null}
        </p>
        <button
          type="button"
          onClick={toggleTechnical}
          aria-pressed={technical}
          className={buttonStyles.ghost}
        >
          {technical ? "Hide technical details" : "Show technical details"}
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {live}
      </div>

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="border-border bg-surface max-h-[65vh] min-h-48 overflow-y-auto rounded-2xl border p-3 sm:p-4"
        role="region"
        aria-label="Chat"
        tabIndex={0}
      >
        {!loaded ? (
          <p className="text-muted py-8 text-center text-sm">Loading the chat…</p>
        ) : groups.length === 0 ? (
          loadError ? (
            <p role="alert" className="text-danger py-8 text-center text-sm">
              {loadError}
            </p>
          ) : (
            <EmptyState title="No messages yet">
              Write what you want done and send it. It runs as {modeSummary}
              {hints.length ? (
                <>
                  ; start with{" "}
                  {hints
                    .map((h) => h.label)
                    .filter((l) => !l.includes("stop"))
                    .join(", ")}{" "}
                  to ask someone specific
                </>
              ) : null}
              . You can also ask {controller} to send work here; everything shows up in this chat.
            </EmptyState>
          )
        ) : (
          <ol className="flex flex-col gap-3" aria-label="Messages">
            {groups.map((g) =>
              g.kind === "milestone" ? (
                <Milestone key={g.key} item={g.item} calloutHint={healthHint} />
              ) : (
                <Bubbles key={g.key} items={g.items} technical={technical} />
              ),
            )}
          </ol>
        )}
      </div>
      {loadError && groups.length > 0 ? (
        <p role="alert" className="text-danger text-xs">
          {loadError}
        </p>
      ) : null}

      <form onSubmit={send} className="flex flex-col gap-3" aria-labelledby={`${ids}-composer`}>
        <h2 id={`${ids}-composer`} className="sr-only">
          Send a message
        </h2>
        <p
          className={cx(
            "rounded-xl px-3 py-2 text-xs",
            banner.tone === "accent"
              ? "bg-accent-soft text-accent"
              : banner.tone === "warning"
                ? "bg-warning-soft text-warning"
                : "bg-surface-muted text-muted",
          )}
        >
          {banner.text}
          {!hasProject && !activeJob ? (
            <> Choose a project for this chat so the agents know which folder to work in.</>
          ) : null}
        </p>

        {hints.length ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Mention hints">
            {hints.map((h) => (
              <button
                key={h.label}
                type="button"
                onClick={() => insertMention(h.insert)}
                disabled={closed}
                title={h.description}
                className="border-border text-muted hover:bg-surface-muted hover:text-foreground rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-60"
              >
                {h.label}
              </button>
            ))}
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span className="sr-only">Message</span>
          <textarea
            ref={textarea}
            value={draft}
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            maxLength={COMPOSER_MAX}
            rows={3}
            disabled={closed}
            aria-describedby={`${ids}-count ${ids}-outcome`}
            placeholder={closed ? "This chat is archived." : "Write a message…"}
            className="border-border-strong bg-surface rounded-xl border px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            id={`${ids}-count`}
            className={cx("text-xs tabular-nums", remaining < 200 ? "text-warning" : "text-subtle")}
          >
            {remaining.toLocaleString("en-GB")} characters left
          </span>
          <div className="flex items-center gap-2">
            <span className="text-subtle hidden text-xs sm:inline">Ctrl + Enter to send</span>
            <button
              type="submit"
              disabled={sending || closed || draft.trim() === ""}
              className={buttonStyles.primary}
            >
              {sending ? "Sending…" : activeJob ? "Send to running work" : "Send"}
            </button>
          </div>
        </div>
        <p
          id={`${ids}-outcome`}
          role={outcome && !outcome.ok ? "alert" : "status"}
          aria-live="polite"
          className={cx(
            "text-sm",
            !outcome && "sr-only",
            outcome?.ok ? "text-success" : "text-danger",
          )}
        >
          {outcome?.message ?? ""}
        </p>
        {closed ? (
          <p className="text-muted text-xs">
            This chat is archived. Restore it from the chat list to send messages.
          </p>
        ) : null}
      </form>
    </div>
  );
}
