"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge, buttonStyles, cx, EmptyState } from "@/components/ui";
import type { ChatEvent, ChatPage, JobMode } from "@/lib/chat/types";
import {
  announcement,
  checkDraft,
  COMPOSER_MAX,
  groupChat,
  isChatPage,
  isPostResult,
  jobRequest,
  MENTION_HINTS,
  mergeEvents,
  MODE_OPTIONS,
  nextCursor,
  pollDelay,
  routeBanner,
  SEND_FAILED,
  sendOutcome,
  type Builder,
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

function Bubbles({ items }: { items: ChatBubbleView[] }) {
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
        <span className="text-foreground font-semibold">{head.label}</span>
        {head.badge ? <Badge tone={head.badgeTone}>{head.badge}</Badge> : null}
        {head.role ? <span className="text-muted">{head.role}</span> : null}
        {head.round ? <span className="text-subtle">{head.round}</span> : null}
        <Time at={head.at} />
      </div>
      {items.map((item, i) => {
        const prevModel = i > 0 ? items[i - 1]!.model : null;
        const showModel = item.model && (i === 0 || item.model !== prevModel);
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

function Milestone({ item }: { item: ChatMilestoneView }) {
  return (
    <li className="flex justify-center px-2">
      <p
        className={cx(
          "bg-surface-muted max-w-full rounded-full px-3 py-1 text-center text-xs break-words",
          MILESTONE_TEXT[item.tone],
          item.technical && "opacity-80",
        )}
      >
        <span aria-hidden>— </span>
        {item.text}
        <span aria-hidden> —</span>
      </p>
    </li>
  );
}

export function ProjectChat({
  roomId,
  initial,
  controller,
  twoAgents,
  archived,
}: {
  roomId: string;
  /** First page rendered by the server, or null to load it in the browser. */
  initial: ChatPage | null;
  /** The connected controller's name, e.g. "ChatGPT", or a generic phrase. */
  controller: string;
  twoAgents: boolean;
  archived: boolean;
}) {
  const [events, setEvents] = useState<ChatEvent[]>(initial?.events ?? []);
  const [activeJob, setActiveJob] = useState<ChatPage["activeJob"]>(initial?.activeJob ?? null);
  const [loaded, setLoaded] = useState(initial !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [technical, setTechnical] = useState(false);
  const [live, setLive] = useState("");

  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<JobMode>(twoAgents ? "team" : "solo");
  const [builder, setBuilder] = useState<Builder>("claude-code");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  const cursor = useRef(initial ? nextCursor(0, initial) : 0);
  const technicalRef = useRef(false);
  const inFlight = useRef(false);
  const idempotencyKey = useRef<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pokeRef = useRef<() => void>(() => {});
  const ids = useId();

  /** Fetch everything after the cursor and append it. `announce` is false for the first load. */
  const poll = useCallback(
    async (announce: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const tech = technicalRef.current;
      try {
        const q = new URLSearchParams({
          room: roomId,
          after: String(cursor.current),
          technical: tech ? "1" : "0",
        });
        const res = await fetch(`/api/dashboard/chat?${q.toString()}`, {
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
      } catch {
        setLoadError(LOAD_FAILED);
        setLoaded(true);
      } finally {
        inFlight.current = false;
      }
    },
    [roomId],
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
    else schedule();

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
    // Re-run only when the room or the technical view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, technical]);

  // Keep the newest message in view when the reader is already at the bottom.
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const groups = useMemo(() => groupChat(events, { technical }), [events, technical]);
  const banner = routeBanner(activeJob, draft);
  const request = jobRequest(draft, { mode, builder });
  const remaining = COMPOSER_MAX - draft.length;

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
    if (sending || archived) return;
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
      const res = await fetch("/api/dashboard/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          roomId,
          body: check.body,
          ...(activeJob ? {} : request),
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
              <Badge tone="accent">Job running</Badge>{" "}
              <span className="sr-only">A job is running in this project.</span>
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
        aria-label="Project chat"
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
              Type <strong>@Claude</strong> and a task to give it to Claude Code,{" "}
              <strong>@Codex</strong> for Codex
              {twoAgents ? (
                <>
                  , or <strong>@team</strong> for both
                </>
              ) : null}
              . You can also ask {controller} to send work to this project; everything shows up
              here.
            </EmptyState>
          )
        ) : (
          <ol className="flex flex-col gap-4" aria-label="Messages">
            {groups.map((g) =>
              g.kind === "milestone" ? (
                <Milestone key={g.key} item={g.item} />
              ) : (
                <Bubbles key={g.key} items={g.items} />
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
        </p>

        {!activeJob && !archived ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-subtle mb-1 text-xs font-medium">How to run it</legend>
            <div className="flex flex-wrap gap-2">
              {MODE_OPTIONS.filter((o) => twoAgents || o.value === "solo").map((o) => (
                <label
                  key={o.value}
                  className="border-border has-[:checked]:border-accent has-[:checked]:bg-accent-soft flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
                  title={o.description}
                >
                  <input
                    type="radio"
                    name={`${ids}-mode`}
                    value={o.value}
                    checked={mode === o.value}
                    onChange={() => setMode(o.value)}
                  />
                  {o.label}
                </label>
              ))}
              {mode !== "team" ? (
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted">Builder</span>
                  <select
                    value={builder}
                    onChange={(e) => setBuilder(e.target.value as Builder)}
                    className="border-border-strong bg-surface rounded-lg border px-2 py-1.5"
                  >
                    <option value="claude-code">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
              ) : null}
            </div>
            <p className="text-subtle text-xs">
              {MODE_OPTIONS.find((o) => o.value === request.mode)?.description}
              {request.mode !== mode ? " (from your @mention)" : ""}
            </p>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap gap-1.5" aria-label="Mention hints">
          {MENTION_HINTS.filter((h) => twoAgents || !h.label.startsWith("@team")).map((h) => (
            <button
              key={h.label}
              type="button"
              onClick={() => insertMention(h.insert)}
              disabled={archived}
              title={h.description}
              className="border-border text-muted hover:bg-surface-muted hover:text-foreground rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-60"
            >
              {h.label}
            </button>
          ))}
        </div>

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
            disabled={archived}
            aria-describedby={`${ids}-count ${ids}-outcome`}
            placeholder={
              archived
                ? "This project is archived."
                : twoAgents
                  ? "@Claude fix the login bug… or @team build the settings page…"
                  : "@Claude fix the login bug…"
            }
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
              disabled={sending || archived || draft.trim() === ""}
              className={buttonStyles.primary}
            >
              {sending ? "Sending…" : activeJob ? "Send to job" : "Send"}
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
        {archived ? (
          <p className="text-muted text-xs">
            This project is archived. Restore it on the Projects page to send messages.
          </p>
        ) : null}
      </form>
    </div>
  );
}
