import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ChatView } from "@/components/dashboard/chat-view";
import { CardRow, MessageRow, NoteRow, type RowHandlers } from "@/components/dashboard/chat/items";
import { NAV } from "@/components/dashboard/sidebar";
import { isChatRoute } from "@/components/dashboard/frame";
import { composerKey, isPostResult, LANES, parseLane, sendOutcome } from "@/lib/dashboard/chat";
import { initialPanel, parseDrawerTab } from "@/lib/dashboard/chat-panel";
import { parseFailoverPolicy, FAILOVER_OPTIONS } from "@/lib/dashboard/failover";
import { clientLines, headerStatus, newestLiveAt, parseHostStatus } from "@/lib/dashboard/presence";
import { buildRegistry } from "@/lib/dashboard/registry";
import {
  activityRows,
  anchoredScrollTop,
  buildTimeline,
  countNewAfter,
  internItems,
  isNearBottom,
  liveIndicator,
  NEAR_BOTTOM_PX,
  parseProvenance11,
  stabilizeItems,
  type CardItem,
  type MessageItem,
  type NoteItem,
  type TimelineEvent,
} from "@/lib/dashboard/timeline";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CHAT = `tlcht_${hex(1)}`;
const JOB = `tljob_${hex(1)}`;
const T0 = Date.parse("2026-09-29T12:00:00Z");
const registry = buildRegistry(null);

let seq = 0;
function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `tlcev_${hex(seq)}`,
    chatSeq: seq,
    createdAt: new Date(T0 + seq * 1000).toISOString(),
    jobId: JOB,
    runId: null,
    authorKind: "agent",
    authorProvider: "claude-code",
    authorLabel: "Claude Code",
    authorRole: "builder",
    audience: null,
    eventType: "agent_message",
    messageType: null,
    round: null,
    modelRequested: null,
    modelObserved: null,
    body: "Hello",
    visibility: "visible",
    replyTo: null,
    ref: null,
    payload: null,
    delivery: null,
    ...over,
  };
}
const tl = (eventType: string, body: string, payload: Record<string, unknown> | null = null) =>
  ev({
    authorKind: "threadlink",
    authorProvider: null,
    authorLabel: "ThreadLink",
    authorRole: null,
    eventType,
    body,
    payload,
  });

const handlers: RowHandlers = {
  chatId: CHAT,
  onOpenProvenance: () => {},
  onJump: () => {},
  onTogglePhase: () => {},
};

describe("quiet timeline (§7 placement)", () => {
  const events = [
    ev({
      authorKind: "owner",
      authorProvider: null,
      authorLabel: "You",
      authorRole: null,
      eventType: "message",
      body: "@team fix login",
    }),
    tl("job_started", "Team Mode job started."),
    tl("phase", "Planning", { phase: "planning" }),
    ev({ body: "Plan: change the session check.", messageType: "proposal", round: 1 }),
    tl("decision", "Decision TL-00003"),
    tl("plan_agreed", "Plan agreed. Building now."),
    tl("unit_status", "Unit auth started"),
    tl("task_started", "Codex started building"),
    tl("model_used", "Codex used GPT-6"),
    tl("job_verdict", "Result: PASS"),
  ];

  it("keeps only conversation rows, with no phase separators", () => {
    const items = buildTimeline(events, registry, { quiet: true });
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "note", "note"]);
    const texts = items.map((i) =>
      i.kind === "note" ? i.text : i.kind === "message" ? i.body : "",
    );
    expect(texts.join(" ")).not.toMatch(/TL-|job started|Unit auth|GPT-6/);
  });

  it("drops kind and round labels, and names agents by short name + role", () => {
    const items = buildTimeline(events, registry, { quiet: true });
    const agent = items[1] as MessageItem;
    expect(agent.kindLabel).toBeNull();
    expect(agent.round).toBeNull();
    expect(agent.identity.name).toBe("Claude");
    expect(agent.identity.role).toBe("Builder");
    expect(agent.identity.initial).toBe("C");
  });

  it("the 0.10 (non-quiet) build is unchanged", () => {
    const items = buildTimeline(events, registry, {});
    expect(items.some((i) => i.kind === "phase")).toBe(true);
  });

  it("activity rows hold the rest, in words", () => {
    const rows = activityRows(events, registry);
    expect(rows.map((r) => r.text)).toContain("Team Mode job started.");
    expect(rows.map((r) => r.text)).toContain("Decision recorded.");
    expect(rows.some((r) => /TL-/.test(r.text))).toBe(false);
  });

  it("a fixed finding leaves the chat; an open blocking one stays", () => {
    const f = tl("finding", "Blocking finding from Codex (security)", {
      findingId: "F1",
      severity: "blocking",
      status: "open",
    });
    expect(buildTimeline([f], registry, { quiet: true })).toHaveLength(1);
    expect(
      buildTimeline([f], registry, { quiet: true, findingStates: new Map([["F1", "fixed"]]) }),
    ).toHaveLength(0);
  });

  it("failover notices are calm callouts", () => {
    const [n] = buildTimeline(
      [tl("failover", "x", { from: "codex", to: "claude-code", reviewWaits: true })],
      registry,
      { quiet: true },
    ) as NoteItem[];
    expect(n!.callout).toBe(true);
    expect(n!.text).toBe(
      "Codex usage is exhausted. Continuing with Claude. Independent review will wait for Codex.",
    );
    const html = renderToStaticMarkup(createElement(NoteRow, { item: n!, highlighted: false }));
    expect(html).toContain('role="note"');
  });
});

describe("choice cards (§5, §2.5)", () => {
  const choice = (kind: string, options: { key: string; label: string }[], extra = {}) =>
    buildTimeline(
      [
        tl("choice", "Codex usage is exhausted.", {
          choiceId: "tlcho_1",
          kind,
          title: "Codex usage is exhausted.",
          options,
          status: "pending",
          ...extra,
        }),
      ],
      registry,
      { quiet: true },
    )[0] as CardItem;

  it("usage_exhausted: one click, never Retry Codex, reset time only when reported", () => {
    const item = choice("usage_exhausted", [
      { key: "continue_other", label: "Continue with Claude" },
      { key: "check_again", label: "Check Codex again" },
      { key: "retry", label: "Retry Codex" },
      { key: "wait", label: "Wait for Codex" },
      { key: "stop", label: "Stop" },
    ]);
    const html = renderToStaticMarkup(
      createElement(CardRow, { item, verified: false, highlighted: false, handlers }),
    );
    expect(html).toContain("Continue with Claude");
    expect(html).toContain("Check Codex again");
    expect(html).toContain("Wait for Codex");
    expect(html).toContain("Stop");
    expect(html).not.toContain("Retry Codex");
    expect(html).not.toContain('type="radio"');
    expect(html).toContain("Reset time not reported.");

    const timed = choice("usage_exhausted", [{ key: "wait", label: "Wait for Codex" }], {
      resetsAt: "2026-09-29T14:52:00Z",
    });
    expect((timed.card as { resetsAt: string | null }).resetsAt).toBe("2026-09-29T14:52:00Z");
    const html2 = renderToStaticMarkup(
      createElement(CardRow, { item: timed, verified: false, highlighted: false, handlers }),
    );
    expect(html2).toMatch(/Resets around/);
  });

  it("start_work: Run this as work / Keep chatting", () => {
    const item = choice("start_work", [
      { key: "run_work", label: "Run this as work" },
      { key: "keep_chatting", label: "Keep chatting" },
    ]);
    const html = renderToStaticMarkup(
      createElement(CardRow, { item, verified: false, highlighted: false, handlers }),
    );
    expect(html).toContain("Run this as work");
    expect(html).toContain("Keep chatting");
    expect(html).not.toContain("Reset time");
  });

  it("approval kinds keep pick-then-confirm", () => {
    const item = choice("migration", [{ key: "approve", label: "Approve" }]);
    const html = renderToStaticMarkup(
      createElement(CardRow, { item, verified: false, highlighted: false, handlers }),
    );
    expect(html).toContain('type="radio"');
  });
});

describe("message rows (§8 density)", () => {
  it("owner right-aligned light bubble; agent left with an initial avatar and a details affordance", () => {
    const [owner, agent] = buildTimeline(
      [
        ev({
          authorKind: "owner",
          authorProvider: null,
          authorLabel: "You",
          authorRole: null,
          eventType: "message",
          body: "hi",
        }),
        ev({ runId: `tlarn_${hex(9)}`, body: "<b>hello</b>" }),
      ],
      registry,
      { quiet: true },
    ) as MessageItem[];
    const o = renderToStaticMarkup(
      createElement(MessageRow, { item: owner!, verified: false, highlighted: false, handlers }),
    );
    expect(o).toContain("items-end");
    expect(o).toContain("bg-bubble");
    const a = renderToStaticMarkup(
      createElement(MessageRow, { item: agent!, verified: true, highlighted: false, handlers }),
    );
    expect(a).toContain(">C</span>");
    expect(a).toContain("Claude");
    expect(a).toContain("· Builder");
    expect(a).toContain("✓ Verified");
    expect(a).toContain("Details");
    expect(a).toContain("&lt;b&gt;hello&lt;/b&gt;");
  });
});

describe("row stability (no re-render of unchanged rows)", () => {
  it("stabilizeItems / internItems reuse unchanged row objects", () => {
    const events = [ev({ body: "a" }), ev({ body: "b" })];
    const first = buildTimeline(events, registry, { quiet: true });
    const again = buildTimeline(events, registry, { quiet: true });
    expect(stabilizeItems(first, again)).toBe(first);
    const grown = buildTimeline([...events, ev({ body: "c" })], registry, { quiet: true });
    const s = stabilizeItems(first, grown);
    expect(s[0]).toBe(first[0]);
    expect(s[2]).toBe(grown[2]);

    const scope = {};
    const i1 = internItems(scope, first);
    const i2 = internItems(scope, again);
    expect(i2[0]).toBe(i1[0]);
    expect(i2[1]).toBe(i1[1]);
  });
});

describe("scrolling (§8)", () => {
  it("sticks to the bottom only within 120 px", () => {
    expect(NEAR_BOTTOM_PX).toBe(120);
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1379, clientHeight: 500 })).toBe(false);
  });
  it("keeps the anchor when older rows load above", () => {
    expect(anchoredScrollTop({ scrollHeight: 2000, scrollTop: 150 }, 3200)).toBe(1350);
    expect(anchoredScrollTop({ scrollHeight: 2000, scrollTop: 0 }, 2000)).toBe(0);
  });
  it("counts new rows below the reader, not the owner's own", () => {
    const items = buildTimeline(
      [
        ev({ body: "seen" }),
        ev({ body: "new 1" }),
        ev({
          authorKind: "owner",
          authorProvider: null,
          authorLabel: "You",
          authorRole: null,
          eventType: "message",
          body: "mine",
        }),
        ev({ body: "new 2" }),
      ],
      registry,
      { quiet: true },
    );
    expect(countNewAfter(items, items[0]!.key)).toBe(2);
    expect(countNewAfter(items, null)).toBe(0);
  });
});

describe("composer", () => {
  const k = (o: Partial<Parameters<typeof composerKey>[0]>) =>
    composerKey({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      coarsePointer: false,
      ...o,
    });
  it("Enter sends, Shift+Enter is a new line, IME never sends", () => {
    expect(k({})).toBe("send");
    expect(k({ shiftKey: true })).toBe("newline");
    expect(k({ ctrlKey: true })).toBe("send");
    expect(k({ isComposing: true })).toBeNull();
    expect(k({ coarsePointer: true })).toBe("newline");
    expect(k({ key: "a" })).toBeNull();
  });
  it("lanes", () => {
    expect(LANES.map((l) => l.label)).toEqual(["Auto", "Chat only", "Run work"]);
    expect(parseLane("work")).toBe("work");
    expect(parseLane("evil")).toBe("auto");
  });
  it("choice_resolved is a success, never an error", () => {
    const r = {
      ok: true as const,
      routed: "choice_resolved",
      jobId: null,
      chosenLabel: "Continue with Claude",
    };
    expect(isPostResult(r)).toBe(true);
    expect(sendOutcome(r)).toEqual({ ok: true, message: "Answered: Continue with Claude." });
    expect(isPostResult({ ok: true, routed: "<script>" })).toBe(false);
  });
});

describe("presence (§4)", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const raw = (presence: string, extra: Record<string, unknown> = {}) => ({
    now: new Date(now).toISOString(),
    runtime: {
      label: "Nickron PC",
      presence,
      lastSeenAt: new Date(now - 10_000).toISOString(),
      protocol: 11,
      needsUpdate: false,
    },
    agents: [
      {
        provider: "codex",
        health: "usage_exhausted",
        checkedAt: null,
        resetsAt: "2026-09-29T14:52:00Z",
      },
      {
        provider: "claude-code",
        health: "ready",
        checkedAt: null,
        resetsAt: "2026-09-29T14:52:00Z",
      },
    ],
    ...extra,
  });

  it("parses v2 presence and reset times (usage_exhausted only)", () => {
    const s = parseHostStatus(raw("reconnecting"))!;
    expect(s.host!.presence).toBe("reconnecting");
    expect(s.agents.codex!.resetsAt).toBe("2026-09-29T14:52:00Z");
    expect(s.agents["claude-code"]!.resetsAt).toBeNull();
    expect(parseHostStatus(null)).toBeNull();
  });

  it("the header shows the host, never Offline beside fresh work", () => {
    const off = parseHostStatus(raw("offline"))!.host;
    expect(headerStatus({ host: off, now, lastLiveAt: null }).text).toBe("Nickron PC · Offline");
    expect(headerStatus({ host: off, now, lastLiveAt: null }).offlineNote).toMatch(
      /^You're connected\. Nickron PC is offline/,
    );
    const live = headerStatus({ host: off, now, lastLiveAt: new Date(now - 42_000).toISOString() });
    expect(live.text).toBe("Nickron PC · Working");
    expect(live.offlineNote).toBeNull();
    expect(headerStatus({ host: null, now, lastLiveAt: null }).text).toBe("No computer connected");
  });

  it("You and the service come from this browser only", () => {
    expect(clientLines({ failures: 0, browserOnline: true }).you.text).toBe("You · Connected");
    expect(clientLines({ failures: 3, browserOnline: true }).you.text).toBe("You · Reconnecting");
    expect(clientLines({ failures: 0, browserOnline: true }).service.text).toBe(
      "ThreadLink service · Reachable",
    );
  });

  it("newest live time", () => {
    expect(
      newestLiveAt([
        { lastActivityAt: "2026-09-29T11:00:00Z", startedAt: null },
        { lastActivityAt: null, startedAt: "2026-09-29T11:30:00Z" },
      ]),
    ).toBe("2026-09-29T11:30:00Z");
    expect(newestLiveAt([])).toBeNull();
  });
});

describe("live indicators", () => {
  it("● Claude · Reviewing authentication · 42 s ago", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const r = liveIndicator(
      {
        runId: `tlarn_${hex(3)}`,
        provider: "claude-code",
        providerName: "Claude Code",
        role: "reviewer",
        activity: "reviewing",
        startedAt: new Date(now - 120_000).toISOString(),
        lastActivityAt: new Date(now - 42_000).toISOString(),
        subject: "authentication",
      },
      registry,
      now,
    );
    expect(r.text).toBe("Claude · Reviewing authentication · 42 s ago");
    expect(r.stalled).toBeNull();
  });
});

describe("drawer, nav, settings", () => {
  it("opens from ?panel= or the 0.10 ?tab=", () => {
    expect(initialPanel({ panel: "activity" })).toBe("activity");
    expect(initialPanel({ tab: "progress" })).toBe("progress");
    expect(initialPanel({ tab: "details" })).toBe("details");
    expect(initialPanel({ tab: "chat" })).toBeNull();
    expect(initialPanel({ panel: "provenance" })).toBeNull();
    expect(parseDrawerTab("evil")).toBeNull();
  });
  it("quiet navigation", () => {
    expect(NAV.map((n) => n.label)).toEqual([
      "Chats",
      "Projects",
      "Agents",
      "Notifications",
      "Settings",
    ]);
    expect(isChatRoute("/dashboard/chats/abc")).toBe(true);
    expect(isChatRoute("/dashboard/chats")).toBe(false);
  });
  it("failover preference", () => {
    expect(FAILOVER_OPTIONS.map((o) => o.label)).toEqual([
      "Continue with another included agent",
      "Ask me first",
      "Wait for the same agent",
    ]);
    expect(parseFailoverPolicy({ policy: "ask" })).toBe("ask");
    expect(parseFailoverPolicy({ policy: "paid" })).toBeNull();
  });
  it("run provenance keeps 0.11 timings and session reason", () => {
    const p = parseProvenance11({
      runId: `tlarn_${hex(4)}`,
      provider: "codex",
      status: "completed",
      timings: { spawnMs: 500, contextMs: 300, providerMs: 34_000, persistMs: 200 },
      sessionReason: "resumed",
    })!;
    expect(p.timings!.providerMs).toBe(34_000);
    expect(p.sessionReason).toBe("resumed");
  });
});

describe("the chat screen", () => {
  const page = {
    events: [
      {
        id: "e1",
        chatSeq: 1,
        createdAt: "2026-09-29T11:00:00Z",
        authorKind: "owner",
        authorLabel: "You",
        eventType: "message",
        body: "hi",
        visibility: "visible",
      },
      {
        id: "e2",
        chatSeq: 2,
        createdAt: "2026-09-29T11:00:05Z",
        authorKind: "threadlink",
        authorLabel: "ThreadLink",
        eventType: "job_started",
        body: "Team Mode job started.",
        visibility: "visible",
      },
    ],
    cursor: 2,
    activeJob: { jobId: JOB, mode: "team", status: "building" },
  };
  const html = renderToStaticMarkup(
    createElement(ChatView, {
      chatId: CHAT,
      initial: page,
      controller: "ChatGPT",
      agentProviders: ["claude-code", "codex"],
      modeSummary: "Team · Claude Code + Codex",
      archived: false,
      hasProject: true,
      healthHint: null,
      title: "Login fix",
      host: {
        label: "Nickron PC",
        presence: "working",
        online: true,
        lastSeenAt: null,
        serverNow: null,
        working: true,
        protocolOutdated: false,
      },
    }),
  );
  it("has a compact header with the host status, one timeline, a composer with Stop", () => {
    expect(html).toContain("Login fix");
    expect(html).toContain("Nickron PC · Working");
    expect(html).not.toContain("Offline");
    expect(html).toContain('id="tl-timeline"');
    expect(html).toContain("Stop");
    expect(html).toContain(">Auto<");
    expect(html).not.toContain("Show technical");
    expect(html).not.toContain("Team Mode job started.");
  });
});
