"use client";

import { ArrowDown, Ellipsis, Menu, PanelLeft, PanelRight } from "lucide-react";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Composer, type ComposerJob } from "@/components/dashboard/chat/composer";
import { OPEN_NAV_EVENT } from "@/components/dashboard/sidebar";

import { JobControls } from "@/components/dashboard/chat/controls";
import { ChatDrawer } from "@/components/dashboard/chat/drawer";
import {
  CardRow,
  MessageRow,
  NoteRow,
  PhaseRow,
  UnreadRow,
  type RowHandlers,
} from "@/components/dashboard/chat/items";
import {
  ActivityPanel,
  agentNames,
  DetailsPanel,
  PingDot,
  StatusDot,
  type DrawerAgent,
  type DrawerArtifact,
} from "@/components/dashboard/chat/panels";
import { ProvenancePanel } from "@/components/dashboard/chat/provenance-drawer";
import { buttonStyles, cx, EmptyState } from "@/components/ui";
import { chatActivityUrl, chatPageUrl, chatReadUrl } from "@/lib/dashboard/chat";
import {
  clientLines,
  headerStatus,
  newestLiveAt,
  parseHostStatus,
  type ChatHost,
} from "@/lib/dashboard/presence";
import { buildRegistry } from "@/lib/dashboard/registry";
import {
  anchoredScrollTop,
  buildTimeline,
  countNewAfter,
  findingState,
  internItems,
  isNearBottom,
  liveIndicator,
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
  type LiveRun,
  type TimelineEvent,
  type TimelinePage,
  type VerificationView,
} from "@/lib/dashboard/timeline";
import type { FindingState } from "@/lib/chat/types";
import type { DrawerTab } from "@/lib/dashboard/chat-panel";

const LOAD_FAILED = "Could not load the chat right now. ThreadLink keeps trying.";
/** Items rendered at once; older loaded items appear as the reader scrolls up. */
const WINDOW = 150;
/** Load older rows when the reader is this close to the top (px). */
const TOP_LOAD_PX = 400;
/** Host presence refresh while nothing runs (ms). */
const HOST_REFRESH_MS = 20_000;

export type ChatArtifact = {
  artifactId: string;
  title: string;
  kind: string;
  size: string;
  createdAt: string | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The 0.11 chat screen (§8): a compact sticky header, ONE scroll surface (the
 * timeline), a sticky composer and a right drawer (Activity, Progress,
 * Findings, Details, Provenance). ThreadLink stays quiet: only rows whose
 * placement is "chat" appear in the timeline; the rest live in Activity.
 *
 * Scrolling: sticks to the bottom only within 120 px; otherwise new rows
 * never move the reader and a "Jump to latest" pill counts them. Older pages
 * keep the reader's anchor (scrollHeight delta). No smooth-scroll hijacking.
 *
 * Performance: events are paged by the per-chat cursor, merged by chat_seq;
 * rows are interned (unchanged rows keep their object) and memoised; only a
 * window renders (plus content-visibility); the composer owns its draft.
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
  title = null,
  modeControl = null,
  menu = null,
  project = null,
  host: initialHost = null,
  agents = [],
  initialPanel = null,
  progress = null,
  findingsPanel = null,
  details = null,
  notice = null,
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
  /** The header (null: no header, e.g. embedded). */
  title?: string | null;
  modeControl?: ReactNode;
  menu?: ReactNode;
  project?: { name: string; href: string | null } | null;
  /** The execution host as the server judged it when the page rendered. */
  host?: ChatHost | null;
  agents?: DrawerAgent[];
  initialPanel?: DrawerTab | null;
  progress?: ReactNode;
  findingsPanel?: ReactNode;
  details?: ReactNode;
  /** A blocked-job callout (with its explicit retry), shown at the end of the timeline. */
  notice?: ReactNode;
}) {
  const registry = useMemo(() => buildRegistry(registryRows), [registryRows]);
  const first = useMemo<TimelinePage | null>(() => parsePage(initial), [initial]);
  const [events, setEvents] = useState<TimelineEvent[]>(first?.events ?? []);
  const [hasOlder, setHasOlder] = useState(
    first ? first.hasOlder || first.events.length >= PAGE_SIZE : false,
  );
  const [activeJob, setActiveJob] = useState<TimelinePage["activeJob"]>(first?.activeJob ?? null);
  const [live, setLive] = useState<LiveRun[]>(first?.live ?? []);
  const [host, setHost] = useState<ChatHost | null>(initialHost);
  const [agentHealth, setAgentHealth] = useState<DrawerAgent[]>(agents);
  const [loaded, setLoaded] = useState(first !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [online, setOnline] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{
    tab: DrawerTab;
    run: { runId: string; who: string } | null;
  } | null>(initialPanel ? { tab: initialPanel, run: null } : null);
  const [verified, setVerified] = useState<ReadonlyMap<string, VerificationView>>(new Map());
  const [announce, setAnnounce] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const cursor = useRef(first ? Math.max(first.cursor, newestSeq(first.events)) : 0);
  const readUpTo = useRef(0);
  const inFlight = useRef(false);
  const failuresRef = useRef(0);
  const hostAt = useRef(0);
  const pokeRef = useRef<() => void>(() => {});
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const anchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // The read cursor when the chat opened: the unread divider stays put while reading.
  const [openedReadSeq] = useState(lastReadSeq ?? first?.lastReadSeq ?? null);
  const pendingJump = useRef<string | null>(null);

  // The server's panel (Alt+2/3, ?tab=…) follows the URL.
  const [panelProp, setPanelProp] = useState(initialPanel);
  if (panelProp !== initialPanel) {
    setPanelProp(initialPanel);
    setDrawer(initialPanel ? { tab: initialPanel, run: null } : null);
  }

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
      internItems(
        registry,
        buildTimeline(events, registry, {
          quiet: true,
          lastReadSeq: openedReadSeq,
          findingStates: findingMap,
          findings: findingRows,
          choices: choiceMap,
        }),
      ),
    [events, registry, openedReadSeq, findingMap, findingRows, choiceMap],
  );
  const windowed = useMemo(() => windowItems(items, windowSize), [items, windowSize]);
  const targets = useMemo(() => replyTargets(items), [items]);
  const newBelow = atBottom ? 0 : countNewAfter(items, seenKey);

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

  const noteResult = useCallback((ok: boolean) => {
    const next = ok ? 0 : failuresRef.current + 1;
    if (next !== failuresRef.current) {
      failuresRef.current = next;
      setFailures(next);
    }
  }, []);

  /** Live rows and the host's presence, from the activity route. */
  const refreshActivity = useCallback(() => {
    hostAt.current = Date.now();
    void fetch(chatActivityUrl(chatId), {
      cache: "no-store",
      headers: { accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (!j) return;
        const rows = parseLiveList(j);
        if (rows) setLive((prev) => (same(prev, rows) ? prev : rows));
        const status = parseHostStatus((j as Record<string, unknown>).host);
        if (status) {
          setHost((prev) => (same(prev, status.host) ? prev : status.host));
          setAgentHealth((prev) => {
            const next = prev.map((a) => {
              const h = status.agents[a.provider];
              return h
                ? { ...a, health: h.health, checkedAt: h.checkedAt, resetsAt: h.resetsAt }
                : a;
            });
            return same(prev, next) ? prev : next;
          });
        }
        setNow(Date.now());
      })
      .catch(() => {});
  }, [chatId]);

  /** Newer rows after the per-chat cursor. `quiet` for the first load. */
  const poll = useCallback(
    async (quiet: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const after = cursor.current;
      try {
        const res = await fetch(
          chatPageUrl(
            chatId,
            after > 0 ? { after, technical: false } : { limit: PAGE_SIZE, technical: false },
          ),
          { cache: "no-store", headers: { accept: "application/json" } },
        );
        const page = parsePage(res.ok ? await res.json().catch(() => null) : null);
        if (!page) throw new Error("bad page");
        noteResult(true);
        cursor.current = Math.max(cursor.current, page.cursor, newestSeq(page.events));
        setActiveJob((prev) => (same(prev, page.activeJob) ? prev : page.activeJob));
        if (page.live) setLive((prev) => (same(prev, page.live) ? prev : page.live!));
        else if (!page.activeJob) setLive((prev) => (prev.length ? [] : prev));
        if (page.activeJob || Date.now() - hostAt.current >= HOST_REFRESH_MS) refreshActivity();
        setLoadError(null);
        setLoaded(true);
        if (after === 0) setHasOlder(page.hasOlder || page.events.length >= PAGE_SIZE);
        if (page.events.length) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const added = page.events.filter((e) => !seen.has(e.id) && e.visibility === "visible");
            if (!quiet && added.length) {
              const msgs = added.filter(
                (e) => e.authorKind !== "threadlink" && e.authorKind !== "owner",
              );
              if (msgs.length === 1)
                setAnnounce(`New message from ${msgs[0]!.authorLabel || "an agent"}.`);
              else if (msgs.length > 1) setAnnounce(`${msgs.length} new messages.`);
            }
            return mergeTimeline(prev, page.events);
          });
        }
        markRead();
      } catch {
        noteResult(false);
        setLoadError(LOAD_FAILED);
        setLoaded(true);
      } finally {
        inFlight.current = false;
      }
    },
    [chatId, markRead, noteResult, refreshActivity],
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
        failures: failuresRef.current,
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
    const onOnline = () => {
      setOnline(true);
      wake();
    };
    const onOffline = () => setOnline(false);
    pokeRef.current = () => {
      lastActive = Date.now();
      paused = false;
      void poll(false).then(schedule);
    };
    if (cursor.current === 0) void poll(true).then(schedule);
    else {
      markRead();
      refreshActivity();
      schedule();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // Re-run only when the chat changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll]);

  // Live rows tick ("42 s ago") without refetching.
  useEffect(() => {
    if (live.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [live.length]);

  const liveRows = useMemo(
    () => live.map((a) => liveIndicator(a, registry, now)),
    [live, registry, now],
  );

  // After each render that changed the rows: keep the reader's anchor when
  // rows were added above, else stay at the bottom only if already there.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = anchoredScrollTop(anchor.current, el.scrollHeight);
      anchor.current = null;
      return;
    }
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [windowed.items, liveRows.length, loaded]);

  // The viewport or the content changed size (composer grew, drawer opened,
  // a row finished rendering): a reader at the bottom stays at the bottom.
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  // PageUp/PageDown/Home/End scroll the timeline even when nothing has focus
  // (the page itself never scrolls on a chat).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = list.current;
      const active = document.activeElement;
      if (!el || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (active && active !== document.body && active !== document.documentElement) return;
      const page = el.clientHeight * 0.9;
      const to =
        e.key === "PageDown"
          ? el.scrollTop + page
          : e.key === "PageUp"
            ? el.scrollTop - page
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? el.scrollHeight
                : null;
      if (to === null) return;
      e.preventDefault();
      el.scrollTop = to;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First open: land on the unread divider when there is one.

  useEffect(() => {
    const divider = document.getElementById("unread-divider");
    const el = list.current;
    if (divider && el) {
      nearBottom.current = false;
      el.scrollTop = Math.max(0, divider.offsetTop - el.clientHeight / 3);
    }
  }, []);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const oldest = oldestSeq(events);
    if (loadingOlder || oldest === null || !hasOlder) return false;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        chatPageUrl(chatId, { before: oldest, limit: PAGE_SIZE, technical: false }),
        { cache: "no-store", headers: { accept: "application/json" } },
      );
      const page = parsePage(res.ok ? await res.json().catch(() => null) : null);
      if (!page) throw new Error("bad page");
      const older = page.events.filter((e) => e.chatSeq < oldest);
      setHasOlder(page.hasOlder && older.length > 0);
      const el = list.current;
      if (el && older.length)
        anchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      setEvents((prev) => mergeTimeline(prev, older));
      setWindowSize((w) => w + older.length);
      return older.length > 0;
    } catch {
      setLoadError(LOAD_FAILED);
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, events, hasOlder, loadingOlder]);

  const showMore = useCallback(() => {
    const el = list.current;
    if (el) anchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    setWindowSize((w) => w + WINDOW);
  }, []);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    const bottom = isNearBottom(el);
    nearBottom.current = bottom;
    if (bottom !== atBottom) {
      setAtBottom(bottom);
      if (!bottom) setSeenKey(items.at(-1)?.key ?? null);
    }
    if (bottom) markRead();
    if (el.scrollTop < TOP_LOAD_PX && !anchor.current) {
      if (windowed.hiddenBefore > 0) showMore();
      else if (hasOlder && !loadingOlder) void loadOlder();
    }
  };

  const scrollToKey = useCallback((key: string) => {
    const el = document.getElementById(`m-${key}`);
    if (!el) return false;
    nearBottom.current = false;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
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
        const idx = items.findIndex((it) => it.key === r.key);
        if (idx >= 0 && idx < items.length - windowSize) setWindowSize(items.length - idx + 20);
        requestAnimationFrame(() => scrollToKey(r.key));
      } else if (r.kind === "load_older") {
        pendingJump.current = eventId;
        void loadOlder();
      } else {
        setAnnounce("That message is not available.");
      }
    },
    [targets, events, hasOlder, items, windowSize, scrollToKey, loadOlder],
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
    (runId: string, who: string) => setDrawer({ tab: "details", run: { runId, who } }),
    [],
  );
  const onOpenPanel = useCallback(
    (tab: DrawerTab) => setDrawer((d) => ({ tab, run: d?.run ?? null })),
    [],
  );
  const closeDrawer = useCallback(() => setDrawer(null), []);
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
  const noopToggle = useCallback(() => {}, []);
  const handlers = useMemo<RowHandlers>(
    () => ({ chatId, onOpenProvenance, onJump, onTogglePhase: noopToggle, onOpenPanel }),
    [chatId, onOpenProvenance, onJump, noopToggle, onOpenPanel],
  );
  const onSent = useCallback(() => {
    nearBottom.current = true;
    setAtBottom(true);
    pokeRef.current();
  }, []);

  const jumpToLatest = () => {
    const el = list.current;
    if (!el) return;
    nearBottom.current = true;
    setAtBottom(true);
    setWindowSize(WINDOW);
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      markRead();
    });
  };

  const agentIds = useMemo(() => [...new Set(agentProviders)], [agentProviders]);
  const composerJob = useMemo<ComposerJob>(
    () =>
      activeJob
        ? { jobId: activeJob.jobId, status: activeJob.status, control: activeJob.control }
        : null,
    [activeJob],
  );

  const openFindings = Object.values(findings ?? {}).filter((f) =>
    ["open", "accepted", "disputed"].includes(String(f.status ?? "open")),
  ).length;
  const lastLiveAt = newestLiveAt(live);
  const status = headerStatus({ host, now, lastLiveAt });
  const client = clientLines({ failures, browserOnline: online });
  const names = agentNames(
    agentHealth.length
      ? agentHealth
      : agentIds.map((p) => ({ provider: p, shortName: registry.byId.get(p)?.shortName ?? null })),
  );
  const offlineLine =
    status.presence === "offline"
      ? failures > 0 || !online
        ? "Reconnecting to ThreadLink…"
        : status.offlineNote
      : null;

  const drawerBody = drawer ? (
    drawer.tab === "activity" ? (
      <ActivityPanel
        chatId={chatId}
        registry={registry}
        events={events}
        onOpenRun={onOpenProvenance}
      />
    ) : drawer.tab === "progress" ? (
      <div className="flex flex-col gap-4">
        {composerJob ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm">
              <span className="text-accent">●</span> Work is running
            </p>
            <JobControls chatId={chatId} job={composerJob} />
          </div>
        ) : null}
        {progress ?? <p className="text-muted text-sm">No work in this chat yet.</p>}
      </div>
    ) : drawer.tab === "findings" ? (
      (findingsPanel ?? <p className="text-muted text-sm">No findings yet.</p>)
    ) : drawer.tab === "provenance" ? (
      drawer.run ? (
        <ProvenancePanel
          key={drawer.run.runId}
          chatId={chatId}
          runId={drawer.run.runId}
          who={drawer.run.who}
          registry={registry}
          onVerified={onVerified}
        />
      ) : (
        <p className="text-muted text-sm">
          Choose Details on an agent message to see where it came from.
        </p>
      )
    ) : (
      <DetailsPanel
        chatId={chatId}
        you={client.you}
        service={client.service}
        host={status}
        hostOfflineNote={offlineLine}
        agents={agentHealth}
        artifacts={
          artifacts
            ? artifacts.map<DrawerArtifact>((a) => ({
                artifactId: a.artifactId,
                title: a.title,
                kind: a.kind,
                size: a.size,
              }))
            : null
        }
        now={now}
        selected={
          drawer.run ? (
            <ProvenancePanel
              key={drawer.run.runId}
              chatId={chatId}
              runId={drawer.run.runId}
              who={drawer.run.who}
              registry={registry}
              onVerified={onVerified}
              compact
            />
          ) : null
        }
      >
        {details}
      </DetailsPanel>
    )
  ) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Chat">
        {title !== null ? (
          <header className="border-line-soft relative z-10 flex h-[60px] shrink-0 items-center gap-2 border-b px-2 pt-[env(safe-area-inset-top)] sm:h-14 sm:gap-3 sm:pr-3 sm:pl-3.5">
            <button
              type="button"
              aria-label="Toggle sidebar"
              onClick={() => window.dispatchEvent(new Event(OPEN_NAV_EVENT))}
              className="text-muted hover:bg-active hover:text-foreground flex size-11 shrink-0 items-center justify-center rounded-[10px] sm:size-7 sm:rounded-md"
            >
              <Menu aria-hidden className="size-5 sm:hidden" />
              <PanelLeft aria-hidden className="hidden size-4 sm:block" />
            </button>
            <span aria-hidden className="bg-border hidden h-4 w-px sm:block" />
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">
                  {title}
                </h1>
                {modeControl}
                {archived ? <span className="text-subtle text-xs">Archived</span> : null}
              </div>
              <div className="text-subtle hidden min-w-0 truncate text-xs sm:block">
                {project?.href ? (
                  <Link href={project.href} className="hover:text-foreground">
                    {project.name}
                  </Link>
                ) : (
                  (project?.name ?? (hasProject ? null : "No project"))
                )}
                {names.length ? `${project || !hasProject ? " · " : ""}${names.join(" · ")}` : null}
              </div>
              {/* Phones: the status sits under the title (design canvas, Mobile). */}
              <button
                type="button"
                onClick={() => onOpenPanel("details")}
                className="text-subtle flex min-w-0 items-center gap-1.5 text-left text-xs sm:hidden"
              >
                <StatusDot tone={status.tone} />
                <span className="truncate">
                  {status.presence === "offline" && failures === 0 && online
                    ? `${status.text.replace(/ · Offline$/, " offline")} · you're connected`
                    : status.text}
                </span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => onOpenPanel("details")}
              className="border-line-soft bg-card text-muted hover:text-foreground hidden h-[30px] shrink-0 items-center gap-2 rounded-full border px-2.5 text-xs sm:flex"
              title="Connection and agents"
            >
              <PingDot
                tone={status.tone}
                live={status.presence === "working" || status.presence === "online"}
              />
              <span className={cx(status.presence === "working" && "text-foreground font-medium")}>
                {status.text}
              </span>
            </button>
            <button
              type="button"
              onClick={() => (drawer ? closeDrawer() : onOpenPanel("details"))}
              aria-expanded={drawer !== null}
              aria-label={drawer ? "Close details" : "Open details"}
              className="text-muted hover:bg-active hover:text-foreground flex size-11 shrink-0 items-center justify-center rounded-lg sm:size-[30px] sm:rounded-md"
            >
              <Ellipsis aria-hidden className="size-[18px] sm:hidden" />
              <PanelRight aria-hidden className="hidden size-4 sm:block" />
            </button>
            <div className="hidden shrink-0 sm:block">{menu}</div>
          </header>
        ) : null}

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announce}
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={list}
            onScroll={onScroll}
            className="h-full overflow-y-auto overscroll-contain focus-visible:outline-none"
            role="region"
            aria-label="Chat messages"
            tabIndex={0}
            id="tl-timeline"
          >
            <div className="mx-auto flex w-full max-w-[808px] flex-col px-4 pt-3 pb-6 sm:px-6 sm:pt-5">
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
                  <div className="py-10">
                    <EmptyState title="No messages yet">
                      Ask a question or describe what you want done. It runs as {modeSummary}. Start
                      with @ to ask someone specific. You can also ask {controller} to send work
                      here; everything shows up in this chat.
                    </EmptyState>
                  </div>
                )
              ) : (
                <>
                  {hasOlder || windowed.hiddenBefore > 0 ? (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        className={cx(buttonStyles.ghost, "text-xs")}
                        disabled={loadingOlder}
                        onClick={() => (windowed.hiddenBefore > 0 ? showMore() : void loadOlder())}
                      >
                        {loadingOlder ? "Loading…" : "Load older messages"}
                      </button>
                    </div>
                  ) : (
                    <p className="text-subtle pt-2 text-center text-xs">
                      This is the start of the chat.
                    </p>
                  )}
                  <ol className="flex flex-col" aria-label="Messages">
                    {windowed.items.map((it) => {
                      switch (it.kind) {
                        case "message":
                          return (
                            <MessageRow
                              key={it.key}
                              item={it}
                              verified={
                                it.runId ? verified.get(it.runId)?.state === "verified" : false
                              }
                              selected={
                                drawer !== null &&
                                it.runId !== null &&
                                drawer.run?.runId === it.runId
                              }
                              highlighted={highlight === it.key}
                              handlers={handlers}
                            />
                          );
                        case "card":
                          return (
                            <CardRow
                              key={it.key}
                              item={it}
                              verified={
                                it.runId ? verified.get(it.runId)?.state === "verified" : false
                              }
                              highlighted={highlight === it.key}
                              handlers={handlers}
                            />
                          );
                        case "note":
                          return (
                            <NoteRow key={it.key} item={it} highlighted={highlight === it.key} />
                          );
                        case "phase":
                          return (
                            <PhaseRow
                              key={it.key}
                              item={it}
                              collapsed={false}
                              onToggle={noopToggle}
                            />
                          );
                        case "unread":
                          return <UnreadRow key={it.key} item={it} />;
                      }
                    })}
                  </ol>
                  {healthHint && items.some((i) => i.kind === "note" && i.callout) ? (
                    <p className="text-foreground pt-2 text-sm sm:pl-10">{healthHint}</p>
                  ) : null}
                </>
              )}
              {liveRows.length ? (
                <ul className="flex flex-col gap-2 pt-6" aria-label="Working now">
                  {liveRows.map((r, i) => (
                    <li
                      key={r.key}
                      className="text-muted flex min-w-0 items-center gap-2.5 text-[13px]"
                    >
                      <span aria-hidden className="relative inline-flex size-2 shrink-0">
                        <span
                          className={cx(
                            "tl-ping absolute inset-0 rounded-full",
                            r.avatar === "claude"
                              ? "bg-live-claude"
                              : r.avatar === "codex"
                                ? "bg-live-codex"
                                : "bg-accent",
                          )}
                        />
                        <span
                          className={cx(
                            "relative inline-flex size-2 rounded-full",
                            r.avatar === "claude"
                              ? "bg-live-claude"
                              : r.avatar === "codex"
                                ? "bg-live-codex"
                                : "bg-accent",
                          )}
                        />
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenProvenance(r.runId, r.who)}
                        className="hover:text-foreground flex min-w-0 items-baseline gap-2.5 text-left"
                        title="Details"
                      >
                        <span className="text-foreground shrink-0 font-medium">{r.who}</span>
                        {i === 0 && !r.stalled ? (
                          <span className="tl-shimmer min-w-0">
                            <span className="tl-shimmer-base">{r.doing}…</span>
                            <span aria-hidden className="tl-shimmer-win">
                              <span className="tl-shimmer-copy">{r.doing}…</span>
                            </span>
                          </span>
                        ) : (
                          <span className="min-w-0 truncate">{r.doing}</span>
                        )}
                        {r.ago ? <span className="text-subtle shrink-0">· {r.ago}</span> : null}
                      </button>
                      {r.stalled ? (
                        <span className="text-warning shrink-0">{r.stalled}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {notice ? <div className="pt-5">{notice}</div> : null}
              {offlineLine ? (
                <div
                  role="status"
                  className="tl-glass border-line-soft mt-5 flex flex-col gap-1.5 rounded-xl border px-3.5 py-3 text-sm leading-normal"
                >
                  <span className="text-muted text-xs font-semibold">ThreadLink</span>
                  {offlineLine}
                </div>
              ) : null}
            </div>
          </div>
          {!atBottom ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
              <button
                type="button"
                onClick={jumpToLatest}
                className="tl-glass tl-float border-field shadow-float text-foreground pointer-events-auto flex h-8 items-center gap-1.5 rounded-2xl border px-3 text-xs font-medium"
              >
                <ArrowDown aria-hidden className="size-[13px]" />
                {newBelow > 0 ? `Jump to latest · ${newBelow} new` : "Jump to latest"}
              </button>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2">
            {loadError && items.length > 0 ? (
              <p role="alert" className="text-danger px-1 pb-1 text-xs">
                {loadError}
              </p>
            ) : null}
            <Composer
              chatId={chatId}
              registry={registry}
              agentIds={agentIds}
              activeJob={composerJob}
              modeSummary={modeSummary}
              archived={archived}
              hasProject={hasProject}
              onSent={onSent}
            />
          </div>
        </div>
      </section>

      {drawer ? (
        <ChatDrawer
          tab={drawer.tab}
          onTab={onOpenPanel}
          onClose={closeDrawer}
          hasProvenance={drawer.run !== null || drawer.tab === "provenance"}
          findingCount={openFindings}
        >
          {drawerBody}
        </ChatDrawer>
      ) : null}
    </div>
  );
}
