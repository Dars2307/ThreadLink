"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "@/components/dashboard/chat/composer";
import { JobControls } from "@/components/dashboard/chat/controls";
import {
  CardRow,
  MessageRow,
  NoteRow,
  PhaseRow,
  UnreadRow,
  type RowHandlers,
} from "@/components/dashboard/chat/items";
import { ProvenanceDrawer } from "@/components/dashboard/chat/provenance-drawer";
import { buttonStyles, cx, EmptyState } from "@/components/ui";
import { artifactHref, chatActivityUrl, chatPageUrl, chatReadUrl } from "@/lib/dashboard/chat";
import { buildRegistry } from "@/lib/dashboard/registry";
import {
  applyCollapsed,
  buildTimeline,
  findingState,
  liveRow,
  mergeTimeline,
  newestSeq,
  nextPollDelay,
  oldestSeq,
  PAGE_SIZE,
  parseLiveList,
  parsePage,
  replyTargets,
  resolveJump,
  windowItems,
  type Phase,
  type TimelineEvent,
  type TimelinePage,
  type VerificationView,
} from "@/lib/dashboard/timeline";
import type { FindingState, LiveActivity } from "@/lib/chat/types";

const LOAD_FAILED = "Could not load the chat right now. ThreadLink keeps trying.";
/** Items rendered at once; older loaded items appear as the reader scrolls up. */
const WINDOW = 150;

export type ChatArtifact = {
  artifactId: string;
  title: string;
  kind: string;
  size: string;
  createdAt: string | null;
};

/**
 * The 0.10 chat timeline: identity-styled messages, cards, phases, live
 * activity, replies, delivery states, controls, provenance and artifacts.
 *
 * Performance: events are paged by the per-chat cursor (latest 100 first,
 * "Load older" by `before`), merged and de-duplicated by chat_seq; the view
 * model is memoised; only a window of rows renders (plus content-visibility);
 * rows are memoised; the composer owns its draft so typing never re-renders
 * the list; polling backs off on failure and pauses when idle.
 */
export function ChatView({
  chatId,
  initial,
  controller,
  agentProviders,
  modeSummary,
  archived,
  hasProject,
  healthHint,
  registryRows = null,
  lastReadSeq = null,
  findingStates = null,
  findings = null,
  choices = null,
  artifacts = null,
  hostOffline = null,
}: {
  chatId: string;
  /** First page rendered by the server (any ChatPage shape), or null to load it in the browser. */
  initial: unknown;
  /** The connected controller's name, e.g. "ChatGPT", or a generic phrase. */
  controller: string;
  /** Provider ids of the chat's agents (for @mentions). */
  agentProviders: string[];
  modeSummary: string;
  archived: boolean;
  hasProject: boolean;
  /** Fixed-text instruction shown under a provider-blocked line, if any agent needs the user. */
  healthHint: string | null;
  /** Provider registry rows from the server (null → local fallback). */
  registryRows?: unknown[] | null;
  /** The owner's read cursor (chat_seq) when the page loaded: the unread divider goes after it. */
  lastReadSeq?: number | null;
  findingStates?: Record<string, string> | null;
  /** Finding rows from the findings list (titles are agent text), by finding id. */
  findings?: Record<string, Record<string, unknown>> | null;
  choices?: Record<string, Record<string, unknown>> | null;
  artifacts?: ChatArtifact[] | null;
  /** "Nickron's PC is offline. Work continues when it reconnects." when the host is offline. */
  hostOffline?: string | null;
}) {
  const registry = useMemo(() => buildRegistry(registryRows), [registryRows]);
  const first = useMemo<TimelinePage | null>(() => parsePage(initial), [initial]);
  const [events, setEvents] = useState<TimelineEvent[]>(first?.events ?? []);
  const [hasOlder, setHasOlder] = useState(
    first ? first.hasOlder || first.events.length >= PAGE_SIZE : false,
  );
  const [activeJob, setActiveJob] = useState<TimelinePage["activeJob"]>(first?.activeJob ?? null);
  const [live, setLive] = useState<LiveActivity[]>(first?.live ?? []);
  const [loaded, setLoaded] = useState(first !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [collapsed, setCollapsed] = useState<ReadonlySet<Phase>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ runId: string; who: string } | null>(null);
  const [verified, setVerified] = useState<ReadonlyMap<string, VerificationView>>(new Map());
  const [announce, setAnnounce] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const cursor = useRef(first ? Math.max(first.cursor, newestSeq(first.events)) : 0);
  const readUpTo = useRef(0);
  const technicalRef = useRef(false);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const pokeRef = useRef<() => void>(() => {});
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  // The read cursor when the chat opened: the unread divider stays put while reading.
  const [openedReadSeq] = useState(lastReadSeq ?? first?.lastReadSeq ?? null);
  const pendingJump = useRef<string | null>(null);

  const findingMap = useMemo(() => {
    const m = new Map<string, FindingState>();
    for (const [k, v] of Object.entries(findingStates ?? {})) {
      const st = findingState(v);
      if (st) m.set(k, st);
    }
    return m;
  }, [findingStates]);
  const choiceMap = useMemo(() => new Map(Object.entries(choices ?? {})), [choices]);
  const findingRows = useMemo(() => new Map(Object.entries(findings ?? {})), [findings]);

  const items = useMemo(
    () =>
      buildTimeline(events, registry, {
        technical,
        lastReadSeq: openedReadSeq,
        findingStates: findingMap,
        findings: findingRows,
        choices: choiceMap,
      }),
    [events, registry, technical, openedReadSeq, findingMap, findingRows, choiceMap],
  );
  const visible = useMemo(() => applyCollapsed(items, collapsed), [items, collapsed]);
  const windowed = useMemo(() => windowItems(visible, windowSize), [visible, windowSize]);
  const targets = useMemo(() => replyTargets(visible), [visible]);

  const markRead = useCallback(() => {
    const seq = cursor.current;
    if (seq <= readUpTo.current || document.visibilityState !== "visible" || !nearBottom.current)
      return;
    readUpTo.current = seq;
    void fetch(chatReadUrl(chatId), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ chatSeq: seq }),
    }).catch(() => {
      readUpTo.current = 0;
    });
  }, [chatId]);

  /** Newer rows after the per-chat cursor. `quiet` for the first load. */
  const poll = useCallback(
    async (quiet: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const tech = technicalRef.current;
      const after = cursor.current;
      try {
        const res = await fetch(
          chatPageUrl(
            chatId,
            after > 0 ? { after, technical: tech } : { limit: PAGE_SIZE, technical: tech },
          ),
          { cache: "no-store", headers: { accept: "application/json" } },
        );
        const page = parsePage(res.ok ? await res.json().catch(() => null) : null);
        if (!page) throw new Error("bad page");
        if (tech !== technicalRef.current) return;
        failures.current = 0;
        cursor.current = Math.max(cursor.current, page.cursor, newestSeq(page.events));
        setActiveJob(page.activeJob);
        if (page.live) setLive(page.live);
        else if (!page.activeJob) setLive([]);
        else {
          // Live activity rows come from their own route while work runs.
          void fetch(chatActivityUrl(chatId), {
            cache: "no-store",
            headers: { accept: "application/json" },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              const rows = parseLiveList(j);
              if (rows) setLive(rows);
            })
            .catch(() => {});
        }
        setLoadError(null);
        setLoaded(true);
        if (after === 0) setHasOlder(page.hasOlder || page.events.length >= PAGE_SIZE);
        if (page.events.length) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const added = page.events.filter(
              (e) => !seen.has(e.id) && (tech || e.visibility === "visible"),
            );
            if (!quiet && added.length) {
              const msgs = added.filter(
                (e) => e.authorKind !== "threadlink" && e.authorKind !== "owner",
              );
              if (msgs.length === 1)
                setAnnounce(`New message from ${msgs[0]!.authorLabel || "an agent"}.`);
              else if (msgs.length > 1) setAnnounce(`${msgs.length} new messages.`);
              if (!nearBottom.current) setNewBelow((n) => n + added.length);
            }
            return mergeTimeline(prev, page.events);
          });
        }
        markRead();
      } catch {
        failures.current += 1;
        setLoadError(LOAD_FAILED);
        setLoaded(true);
      } finally {
        inFlight.current = false;
      }
    },
    [chatId, markRead],
  );

  // Poll with backoff: 3 s while work runs and the tab is visible, slower when
  // nothing runs or the tab is hidden, doubling per failure (≤ 60 s), paused
  // after 10 idle minutes until the reader is back.
  const working = activeJob !== null;
  const workingRef = useRef(working);
  useEffect(() => {
    workingRef.current = working;
  }, [working]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paused = false;
    let stopped = false;
    let lastActive = Date.now();
    const schedule = () => {
      if (stopped) return;
      clearTimeout(timer);
      const delay = nextPollDelay({
        visible: document.visibilityState === "visible",
        idleMs: Date.now() - lastActive,
        failures: failures.current,
        working: workingRef.current,
      });
      if (delay === null) {
        paused = true;
        return;
      }
      timer = setTimeout(async () => {
        await poll(false);
        schedule();
      }, delay);
    };
    const wake = () => {
      lastActive = Date.now();
      if (paused) {
        paused = false;
        void poll(false).then(schedule);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
      else schedule();
    };
    pokeRef.current = () => {
      lastActive = Date.now();
      paused = false;
      void poll(false).then(schedule);
    };
    if (cursor.current === 0) void poll(true).then(schedule);
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

  // Live rows tick (elapsed, stall) without refetching.
  useEffect(() => {
    if (live.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [live.length]);

  // Keep the newest message in view when the reader is at the bottom.
  useEffect(() => {
    const el = list.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [windowed.items.length]);

  // First open: land on the unread divider when there is one.
  useEffect(() => {
    const divider = document.getElementById("unread-divider");
    if (divider && list.current) {
      nearBottom.current = false;
      divider.scrollIntoView({ block: "center" });
    }
  }, []);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const oldest = oldestSeq(events);
    if (loadingOlder || oldest === null || !hasOlder) return false;
    setLoadingOlder(true);
    const el = list.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const res = await fetch(
        chatPageUrl(chatId, { before: oldest, limit: PAGE_SIZE, technical: technicalRef.current }),
        {
          cache: "no-store",
          headers: { accept: "application/json" },
        },
      );
      const page = parsePage(res.ok ? await res.json().catch(() => null) : null);
      if (!page) throw new Error("bad page");
      const older = page.events.filter((e) => e.chatSeq < oldest);
      setHasOlder(page.hasOlder && older.length > 0);
      setEvents((prev) => mergeTimeline(prev, older));
      setWindowSize((w) => w + older.length);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
      return older.length > 0;
    } catch {
      setLoadError(LOAD_FAILED);
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, events, hasOlder, loadingOlder]);

  const scrollToKey = useCallback((key: string) => {
    const el = document.getElementById(`m-${key}`);
    if (!el) return false;
    nearBottom.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(key);
    setTimeout(() => setHighlight((h) => (h === key ? null : h)), 2500);
    const focusable = el.querySelector<HTMLElement>("button, a");
    focusable?.focus({ preventScroll: true });
    return true;
  }, []);

  const onJump = useCallback(
    (eventId: string) => {
      const r = resolveJump(eventId, targets, events, hasOlder);
      if (r.kind === "item") {
        const idx = visible.findIndex((it) => it.key === r.key);
        if (idx >= 0 && idx < visible.length - windowSize) setWindowSize(visible.length - idx + 20);
        requestAnimationFrame(() => scrollToKey(r.key));
      } else if (r.kind === "load_older") {
        pendingJump.current = eventId;
        void loadOlder();
      } else {
        setAnnounce("That message is not available.");
      }
    },
    [targets, events, hasOlder, visible, windowSize, scrollToKey, loadOlder],
  );

  // After older rows arrive, continue a pending reply jump (bounded by what exists).
  useEffect(() => {
    const target = pendingJump.current;
    if (!target) return;
    if (targets.has(target)) {
      pendingJump.current = null;
      onJump(target);
    } else if (!hasOlder && !loadingOlder) {
      pendingJump.current = null;
      setAnnounce("That message is not available.");
    } else if (!loadingOlder) {
      void loadOlder();
    }
  }, [targets, hasOlder, loadingOlder, onJump, loadOlder]);

  const onOpenProvenance = useCallback(
    (runId: string, who: string) => setDrawer({ runId, who }),
    [],
  );
  const onTogglePhase = useCallback(
    (p: Phase) =>
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      }),
    [],
  );
  const onVerified = useCallback(
    (runId: string, v: VerificationView) =>
      setVerified((m) => {
        if (m.get(runId)?.state === v.state) return m;
        const next = new Map(m);
        next.set(runId, v);
        return next;
      }),
    [],
  );
  const handlers = useMemo<RowHandlers>(
    () => ({ chatId, onOpenProvenance, onJump, onTogglePhase }),
    [chatId, onOpenProvenance, onJump, onTogglePhase],
  );
  const onSent = useCallback(() => {
    nearBottom.current = true;
    pokeRef.current();
  }, []);

  const jumpToLatest = () => {
    const el = list.current;
    if (!el) return;
    nearBottom.current = true;
    setAtBottom(true);
    setNewBelow(0);
    setWindowSize(WINDOW);
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      markRead();
    });
  };

  const toggleTechnical = () => {
    const next = !technical;
    technicalRef.current = next;
    cursor.current = 0;
    setEvents([]);
    setLoaded(false);
    setWindowSize(WINDOW);
    setTechnical(next);
  };

  const liveRows = useMemo(() => live.map((a) => liveRow(a, registry, now)), [live, registry, now]);
  const agentIds = useMemo(() => [...new Set(agentProviders)], [agentProviders]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted text-sm" aria-live="polite">
          {activeJob ? (
            <span className="text-accent font-medium">
              <span aria-hidden>● </span>Working
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {artifacts ? (
            <button
              type="button"
              className={cx(buttonStyles.ghost, "text-xs")}
              onClick={() => setShowArtifacts(true)}
              aria-haspopup="dialog"
            >
              Artifacts ({artifacts.length})
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleTechnical}
            aria-pressed={technical}
            className={cx(buttonStyles.ghost, "text-xs")}
          >
            {technical ? "Hide technical rows" : "Show technical rows"}
          </button>
          <JobControls
            chatId={chatId}
            job={
              activeJob
                ? { jobId: activeJob.jobId, status: activeJob.status, control: activeJob.control }
                : null
            }
          />
        </div>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announce}
      </div>

      <div className="relative">
        <div
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            nearBottom.current = bottom;
            if (bottom !== atBottom) setAtBottom(bottom);
            if (bottom) {
              setNewBelow(0);
              markRead();
            }
            if (el.scrollTop < 200 && windowed.hiddenBefore > 0) setWindowSize((w) => w + WINDOW);
          }}
          className="border-border bg-surface h-[min(68dvh,48rem)] min-h-64 overflow-y-auto overscroll-contain rounded-2xl border p-3 sm:p-4"
          role="region"
          aria-label="Chat messages"
          tabIndex={0}
          id="tl-timeline"
        >
          {!loaded ? (
            <p className="text-muted py-8 text-center text-sm" role="status">
              Loading the chat…
            </p>
          ) : items.length === 0 ? (
            loadError ? (
              <p role="alert" className="text-danger py-8 text-center text-sm">
                {loadError}
              </p>
            ) : (
              <EmptyState title="No messages yet">
                Write what you want done and send it. It runs as {modeSummary}. Start with @ to ask
                someone specific. You can also ask {controller} to send work here; everything shows
                up in this chat.
              </EmptyState>
            )
          ) : (
            <>
              {hasOlder || windowed.hiddenBefore > 0 ? (
                <div className="flex justify-center pb-3">
                  <button
                    type="button"
                    className={cx(buttonStyles.ghost, "text-xs")}
                    disabled={loadingOlder}
                    onClick={() =>
                      windowed.hiddenBefore > 0
                        ? setWindowSize((w) => w + WINDOW)
                        : void loadOlder()
                    }
                  >
                    {loadingOlder ? "Loading…" : "Load older messages"}
                  </button>
                </div>
              ) : (
                <p className="text-subtle pb-3 text-center text-xs">
                  This is the start of the chat.
                </p>
              )}
              <ol className="flex flex-col gap-1.5" aria-label="Messages">
                {windowed.items.map((it) => {
                  switch (it.kind) {
                    case "message":
                      return (
                        <MessageRow
                          key={it.key}
                          item={it}
                          verified={it.runId ? verified.get(it.runId)?.state === "verified" : false}
                          highlighted={highlight === it.key}
                          handlers={handlers}
                        />
                      );
                    case "card":
                      return (
                        <CardRow
                          key={it.key}
                          item={it}
                          verified={it.runId ? verified.get(it.runId)?.state === "verified" : false}
                          highlighted={highlight === it.key}
                          handlers={handlers}
                        />
                      );
                    case "note":
                      return <NoteRow key={it.key} item={it} highlighted={highlight === it.key} />;
                    case "phase":
                      return (
                        <PhaseRow
                          key={it.key}
                          item={it}
                          collapsed={collapsed.has(it.phase)}
                          onToggle={onTogglePhase}
                        />
                      );
                    case "unread":
                      return <UnreadRow key={it.key} item={it} />;
                  }
                })}
              </ol>
              {healthHint && items.some((i) => i.kind === "note" && i.callout) ? (
                <p className="text-foreground px-1 pt-2 text-sm">{healthHint}</p>
              ) : null}
            </>
          )}
          {liveRows.length ? (
            <ul className="flex flex-col gap-1 pt-3" aria-label="Working now">
              {liveRows.map((r) => (
                <li
                  key={r.key}
                  className="border-border bg-surface-muted/50 flex flex-wrap items-baseline gap-x-2 rounded-lg border border-dashed px-3 py-1.5 text-xs"
                >
                  <span className="font-semibold">{r.who}</span>
                  <span className="text-muted">{r.line}</span>
                  {r.stalled ? <span className="text-warning font-medium">{r.stalled}</span> : null}
                  <button
                    type="button"
                    className="text-subtle hover:text-foreground ml-auto"
                    onClick={() => onOpenProvenance(r.runId, r.who)}
                  >
                    Details
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {hostOffline && activeJob ? (
            <p role="status" className="text-warning px-1 pt-2 text-xs">
              {hostOffline}
            </p>
          ) : null}
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className={cx(
              buttonStyles.secondary,
              "shadow-card absolute right-4 bottom-4 px-3 py-1.5 text-xs",
            )}
          >
            {newBelow > 0 ? `${newBelow} new · Jump to latest` : "Jump to latest"}
          </button>
        ) : null}
      </div>
      {loadError && items.length > 0 ? (
        <p role="alert" className="text-danger text-xs">
          {loadError}
        </p>
      ) : null}

      <Composer
        chatId={chatId}
        registry={registry}
        agentIds={agentIds}
        activeJob={activeJob}
        modeSummary={modeSummary}
        archived={archived}
        hasProject={hasProject}
        onSent={onSent}
      />

      {drawer ? (
        <ProvenanceDrawer
          chatId={chatId}
          runId={drawer.runId}
          who={drawer.who}
          registry={registry}
          onClose={() => setDrawer(null)}
          onVerified={onVerified}
        />
      ) : null}
      {showArtifacts && artifacts ? (
        <ArtifactsPanel
          chatId={chatId}
          artifacts={artifacts}
          onClose={() => setShowArtifacts(false)}
        />
      ) : null}
    </div>
  );
}

function ArtifactsPanel({
  chatId,
  artifacts,
  onClose,
}: {
  chatId: string;
  artifacts: ChatArtifact[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center lg:items-stretch lg:justify-end"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close artifacts"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifacts-title"
        tabIndex={-1}
        className="border-border bg-surface relative flex max-h-[85dvh] w-full flex-col gap-3 overflow-y-auto rounded-t-2xl border p-5 outline-none lg:h-dvh lg:max-h-none lg:w-[24rem] lg:rounded-none lg:rounded-l-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="artifacts-title" className="text-base font-semibold">
            Artifacts
          </h2>
          <button type="button" className={buttonStyles.ghost} onClick={onClose}>
            Close
          </button>
        </div>
        {artifacts.length === 0 ? (
          <p className="text-muted text-sm">
            Reports, plans, diffs and your attachments appear here.
          </p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {artifacts.map((a) => (
              <li key={a.artifactId} className="flex flex-col gap-1 py-2">
                <span className="text-sm font-medium break-words">{a.title}</span>
                <span className="text-subtle text-xs">
                  {a.kind}
                  {a.size ? ` · ${a.size}` : ""}
                </span>
                <span className="flex gap-3 text-xs">
                  <a
                    href={artifactHref(chatId, a.artifactId)}
                    download
                    className="text-accent font-medium"
                  >
                    Download
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
