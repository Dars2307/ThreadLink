import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CardRow, MessageRow, type RowHandlers } from "@/components/dashboard/chat/items";
import { SafeBody } from "@/components/dashboard/chat/safe-body";
import type { RunProvenance } from "@/lib/chat/types";
import { attachmentTitle, checkAttachment, decodeText } from "@/lib/dashboard/attachments";
import { chatHeader10 } from "@/lib/dashboard/chat-header";
import { chatNav } from "@/lib/dashboard/nav";
import { onboarding } from "@/lib/dashboard/onboarding";
import { projectHub } from "@/lib/dashboard/project-hub";
import {
  buildRegistry,
  filterMentions,
  mentionAtCaret,
  mentionOptions,
  mentionTarget,
  registryEntry,
} from "@/lib/dashboard/registry";
import { cleanText, oneLine, safeHref, tokenize } from "@/lib/dashboard/safe-text";
import { parseSearchQuery, searchResults } from "@/lib/dashboard/search";
import { adjacentChat, shortcutFor } from "@/lib/dashboard/shortcuts";
import {
  applyCollapsed,
  buildTimeline,
  choiceCard,
  composerBanner,
  CONTROL_TEXT,
  controlOptions,
  deliveryText,
  healthFreshness,
  HEALTH_FRESH_MS,
  hostView,
  identityOf,
  liveRow,
  mergeTimeline,
  nextPollDelay,
  parseEvent,
  parsePage,
  provenanceRows,
  replyTargets,
  resolveJump,
  SEND_NOTE,
  timeoutText,
  verificationOf,
  windowItems,
  type CardItem,
  type MessageItem,
  type TimelineEvent,
} from "@/lib/dashboard/timeline";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CHAT = `tlcht_${hex(1)}`;
const JOB = `tljob_${hex(1)}`;
const RUN = `tlarn_${hex(1)}`;
const T0 = Date.parse("2026-09-26T12:00:00Z");
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
    authorProvider: "codex",
    authorLabel: "Codex",
    authorRole: "coordinator",
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

const handlers: RowHandlers = {
  chatId: CHAT,
  onOpenProvenance: () => {},
  onJump: () => {},
  onTogglePhase: () => {},
};

const fullRun: RunProvenance = {
  runId: RUN,
  provider: "codex",
  providerName: "Codex",
  participantKey: "codex:coordinator",
  role: "coordinator",
  requestedModel: "gpt-6-sol",
  observedModel: "gpt-6-sol",
  modelVerified: true,
  effort: "high",
  access: "read-only",
  accessVerified: true,
  nativeSession: { available: true, kind: "codex_thread", continuity: "fresh" },
  executionHost: "Nickron's PC",
  worktreeLabel: "Prism / auth-review",
  status: "completed",
  activity: null,
  startedAt: "2026-09-26T11:00:00Z",
  finishedAt: "2026-09-26T11:10:00Z",
  lastActivityAt: "2026-09-26T11:10:00Z",
  verified: "verified",
  verificationNotes: [],
};

// ---------------------------------------------------------------------------

describe("identity (registry metadata, never a provider switch)", () => {
  it("renders each author style distinctly", () => {
    expect(identityOf(ev({ authorKind: "owner", authorProvider: null }), registry).headline).toBe(
      "You",
    );
    expect(
      identityOf(
        ev({ authorKind: "controller", authorProvider: null, authorLabel: "ChatGPT" }),
        registry,
      ).headline,
    ).toBe("ChatGPT · Controller");
    expect(identityOf(ev({ authorKind: "threadlink", authorProvider: null }), registry).style).toBe(
      "threadlink",
    );
    const codex = identityOf(ev({ modelObserved: "gpt-6-sol" }), registry);
    expect(codex.headline).toBe("Codex · Coordinator");
    expect(codex.model).toBe("GPT-6 Sol");
  });

  it("renders an unknown provider generically, never as another provider", () => {
    const id = identityOf(
      ev({ authorProvider: "gemini-cli-next", authorLabel: "", authorRole: "reviewer" }),
      registry,
    );
    expect(id.headline).toBe("Gemini cli next · Reviewer");
    expect(id.headline).not.toMatch(/Claude|Codex/);
    expect(id.tone).toBe("neutral");
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        item: buildTimeline(
          [ev({ authorProvider: "brand-new", authorLabel: "Brand New" })],
          registry,
        )[0] as MessageItem,
        verified: false,
        highlighted: false,
        handlers,
      }),
    );
    expect(html).toContain("Brand New");
  });

  it("uses server registry names and aliases when provided", () => {
    const r = buildRegistry([
      {
        id: "claude-code",
        displayName: "Claude Code",
        shortName: "Claude",
        mentionAliases: ["claude", "claudecode"],
        supported: true,
        sort: 1,
      },
      {
        id: "codex",
        displayName: "Codex",
        shortName: "Codex",
        mentionAliases: ["codex"],
        supported: true,
        sort: 2,
      },
      {
        id: "gemini-cli",
        displayName: "Gemini CLI",
        mentionAliases: ["gemini"],
        supported: false,
        sort: 3,
      },
      { id: "BAD ID", displayName: "x" },
    ]);
    expect(r.fromServer).toBe(true);
    expect(r.entries.map((e) => e.id)).toEqual(["claude-code", "codex", "gemini-cli"]);
    expect(mentionTarget(r, "@claudecode please")).toBe("claude-code");
    expect(mentionTarget(r, "@gemini hi")).toBeNull(); // unsupported: not routable
    expect(registryEntry(r, "gemini-cli").name).toBe("Gemini CLI");
    expect(r.byId.get("claude-code")!.tone).not.toBe(r.byId.get("codex")!.tone);
  });

  it("builds @mentions from aliases; @team only with two or more agents", () => {
    expect(mentionOptions(registry, ["claude-code"]).map((o) => o.label)).toEqual(["@claude"]);
    expect(mentionOptions(registry, ["claude-code", "codex"]).map((o) => o.label)).toEqual([
      "@claude",
      "@codex",
      "@team",
    ]);
    expect(
      filterMentions(mentionOptions(registry, ["claude-code", "codex"]), "co").map((o) => o.label),
    ).toEqual(["@codex"]);
    expect(mentionAtCaret("hi @cod", 7)).toEqual({ start: 3, typed: "cod" });
    expect(mentionAtCaret("email@x", 7)).toBeNull();
  });
});

describe("verified badge", () => {
  it("is Verified only with full evidence", () => {
    expect(verificationOf(fullRun).state).toBe("verified");
    for (const broken of [
      { status: "running" as const },
      { modelVerified: false },
      { accessVerified: false },
      { nativeSession: { available: false, kind: null, continuity: null } },
      { executionHost: null },
      { verified: "partial" as const },
    ]) {
      const v = verificationOf({ ...fullRun, ...broken });
      expect(v.state).not.toBe("verified");
      expect(v.label).not.toBe("Verified");
    }
    expect(verificationOf({ ...fullRun, modelVerified: false }).notes).toContain(
      "The model that ran was not confirmed.",
    );
    expect(verificationOf(null).state).toBe("unverified");
  });

  it("never claims Verified from the server flag alone", () => {
    const v = verificationOf({ ...fullRun, verified: "verified", accessVerified: false });
    expect(v.state).toBe("partial");
  });

  it("renders the badge only when told the run is verified", () => {
    const item = buildTimeline([ev({ runId: RUN })], registry)[0] as MessageItem;
    const off = renderToStaticMarkup(
      createElement(MessageRow, { item, verified: false, highlighted: false, handlers }),
    );
    const on = renderToStaticMarkup(
      createElement(MessageRow, { item, verified: true, highlighted: false, handlers }),
    );
    expect(off).not.toContain("Verified");
    expect(on).toContain("✓ Verified");
  });

  it("provenance rows never include the native session id", () => {
    const rows = provenanceRows({ ...fullRun }, registry);
    expect(rows.find((r) => r.key === "session")!.value).toBe("Available · Fresh session");
    expect(JSON.stringify(rows)).not.toMatch(/codex_thread|thread_/);
    const none = provenanceRows(
      { ...fullRun, nativeSession: { available: false, kind: null, continuity: null } },
      registry,
    );
    expect(none.find((r) => r.key === "session")!.value).toBe(
      "Persistent native session: not exposed by this provider",
    );
  });
});

describe("delivery states", () => {
  it("says sent / queued / seen / not delivered in words", () => {
    expect(deliveryText({ state: "sent" }, registry)).toBe("Sent");
    expect(deliveryText({ state: "queued", for: ["claude-code:reviewer"] }, registry)).toBe(
      "Queued for Claude's next turn",
    );
    expect(
      deliveryText(
        { state: "queued", for: ["claude-code:reviewer", "codex:coordinator"] },
        registry,
      ),
    ).toBe("Queued for Claude and Codex's next turns");
    expect(deliveryText({ state: "seen", by: ["claude-code"] }, registry)).toBe("Seen by Claude");
    expect(deliveryText({ state: "not_delivered" }, registry)).toMatch(/^Not delivered/);
    expect(deliveryText(null, registry)).toBeNull();
  });

  it("shows delivery only on the owner's messages", () => {
    const items = buildTimeline(
      [
        ev({
          authorKind: "owner",
          authorProvider: null,
          delivery: { state: "seen", by: ["codex"] },
        }),
        ev({ delivery: { state: "sent" } }),
      ],
      registry,
    ) as MessageItem[];
    expect(items[0]!.delivery).toBe("Seen by Codex");
    expect(items[1]!.delivery).toBeNull();
  });
});

describe("job controls", () => {
  it("labels and explains each control; a note never stops anything", () => {
    expect(SEND_NOTE.explain).toMatch(/Nothing stops/);
    expect(CONTROL_TEXT.pause_after_step.label).toBe("Pause after this step");
    expect(CONTROL_TEXT.stop_after_review.label).toBe("Stop after review");
    expect(CONTROL_TEXT.stop_before_integration.label).toBe("Stop before integration");
    expect(CONTROL_TEXT.stop_now.label).toBe("Stop now");
    expect(CONTROL_TEXT.stop_now.confirm).toBe(true);
    expect(CONTROL_TEXT.cancel_queued.label).toBe("Cancel queued work");
    for (const c of Object.values(CONTROL_TEXT)) expect(c.explain.length).toBeGreaterThan(20);
  });

  it("offers Resume only when paused", () => {
    const running = controlOptions({ status: "building", control: null }).map((o) => o.action);
    expect(running).not.toContain("resume");
    expect(running).toContain("stop_now");
    const paused = controlOptions({ status: "paused", control: null }).map((o) => o.action);
    expect(paused).toContain("resume");
    expect(paused).not.toContain("pause_after_step");
    expect(controlOptions(null)).toEqual([]);
  });
});

describe("cards", () => {
  it("choice cards keep only allowed, well-formed options", () => {
    const c = choiceCard({
      choiceId: "tlchc_1",
      kind: "timeout",
      title: "Claude Code timed out",
      options: [
        { key: "retry_step", label: "Retry step" },
        { key: "use_other", label: "Retry with Codex" },
        { key: "DROP TABLE", label: "bad" },
        { key: "stop", label: "" },
        { key: "stop", label: "Stop" },
      ],
      status: "pending",
    });
    expect(c.options.map((o) => o.key)).toEqual(["retry_step", "use_other", "stop"]);
    expect(c.choiceKind).toBe("timeout");
    expect(
      choiceCard({ ...c, status: "chosen", chosenKey: "stop", options: c.options }).chosenLabel,
    ).toBe("Stop");
  });

  it("renders a choice card with its options and a confirmation step", () => {
    const [item] = buildTimeline(
      [
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "choice",
          payload: {
            choiceId: "tlchc_2",
            kind: "provider_failure",
            title: "Codex could not run",
            options: [
              { key: "retry", label: "Retry same agent" },
              { key: "stop", label: "Stop" },
            ],
            status: "pending",
          },
        }),
      ],
      registry,
    );
    const html = renderToStaticMarkup(
      createElement(CardRow, {
        item: item as CardItem,
        verified: false,
        highlighted: false,
        handlers,
      }),
    );
    expect(html).toContain("Needs your decision");
    expect(html).toContain("Retry same agent");
    expect(html).toContain('type="radio"');
    expect(html).not.toContain("Confirm:"); // only after picking
  });

  it("finding cards follow state transitions (legacy wont_fix → dismissed)", () => {
    const events = [
      ev({
        eventType: "finding",
        authorProvider: "claude-code",
        authorLabel: "Claude Code",
        authorRole: "reviewer",
        payload: {
          findingId: "F1",
          category: "security",
          severity: "blocking",
          title: "Token logged",
          raisedBy: "claude-code:reviewer",
          owner: "codex:builder",
          status: "open",
          filePath: "lib/auth.ts",
          line: 42,
        },
      }),
      ev({
        eventType: "finding",
        ref: { kind: "finding", id: "F1" },
        payload: { findingId: "F1", status: "accepted", title: "Token logged" },
      }),
      ev({
        eventType: "finding",
        ref: { kind: "finding", id: "F1" },
        payload: { findingId: "F1", status: "fixed" },
      }),
    ];
    const items = buildTimeline(events, registry);
    const card = (items[0] as CardItem).card;
    expect(card.kind).toBe("finding");
    if (card.kind !== "finding") return;
    expect(card.status).toBe("fixed");
    expect(card.history).toEqual(["open", "accepted", "fixed"]);
    expect(card.location).toBe("lib/auth.ts:42");
    expect(card.raisedBy).toBe("Claude Code · Reviewer");
    expect(card.owner).toBe("Codex · Builder");
    expect(items[1]).toMatchObject({
      kind: "note",
      text: expect.stringContaining("Finding marked accepted"),
    });
    // The findings list (server truth) wins over the timeline.
    const later = buildTimeline(events, registry, { findingStates: new Map([["F1", "resolved"]]) });
    expect(((later[0] as CardItem).card as { status: string }).status).toBe("resolved");
    const legacy = buildTimeline(
      [ev({ eventType: "finding", payload: { findingId: "F9", status: "wont_fix", title: "x" } })],
      registry,
    );
    expect(((legacy[0] as CardItem).card as { statusLabel: string }).statusLabel).toBe("Dismissed");
  });

  it("decision cards show a human title and keep IDs inside Details only", () => {
    const [item] = buildTimeline(
      [
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "decision",
          body: "TL-00001 Roles chosen",
          payload: { title: "Roles chosen", titleSource: "threadlink", decisionId: "TL-00001" },
        }),
      ],
      registry,
    );
    const card = (item as CardItem).card;
    expect(card).toMatchObject({
      kind: "decision",
      title: "Roles chosen",
      attributedTo: null,
      technicalId: "TL-00001",
    });
    const html = renderToStaticMarkup(
      createElement(CardRow, {
        item: item as CardItem,
        verified: false,
        highlighted: false,
        handlers,
      }),
    );
    const outsideDetails = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(outsideDetails).not.toContain("TL-00001");
    expect(html).toContain("<details");
  });

  it("an agent-titled decision is attributed to that agent", () => {
    const [item] = buildTimeline(
      [ev({ eventType: "decision", payload: { title: "Use a queue", titleSource: "agent" } })],
      registry,
    );
    expect((item as CardItem).card).toMatchObject({ attributedTo: "Codex · Coordinator" });
  });

  it("timeout text comes from trusted fields", () => {
    expect(
      timeoutText(
        { provider: "claude-code", minutes: 30, step: "review", subject: "auth-module" },
        registry,
        "x",
      ),
    ).toBe("Claude Code timed out after 30 min while reviewing auth-module.");
    expect(
      timeoutText({ provider: "codex", timeoutMs: 1_800_000, step: "build" }, registry, "x"),
    ).toBe("Codex timed out after 30 min while building.");
    expect(timeoutText({}, registry, "Fallback line")).toBe("Fallback line");
  });

  it("code change and job summary cards carry counts, tests and artifact links", () => {
    const items = buildTimeline(
      [
        ev({
          eventType: "code_change",
          runId: RUN,
          payload: {
            filesChanged: 3,
            insertions: 40,
            deletions: 2,
            files: ["a.ts", "b.ts", "c.ts"],
            branch: "tl/auth",
            tests: [{ command: "npm test", ok: true }],
            diffArtifactId: "tlart_1",
          },
        }),
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "job_summary",
          payload: {
            verdict: "PASS",
            unitsDone: 2,
            findings: { open: 0, fixed: 3 },
            testsRun: 5,
            testsPassed: 5,
            agents: ["claude-code", "codex"],
            finalVerifier: "claude-code:inspector",
            openItems: 0,
            reportArtifactId: "tlart_2",
          },
        }),
      ],
      registry,
    ) as CardItem[];
    expect(items[0]!.card).toMatchObject({
      kind: "code_change",
      filesChanged: 3,
      insertions: 40,
      deletions: 2,
      diffArtifactId: "tlart_1",
    });
    expect(items[1]!.card).toMatchObject({
      kind: "job_summary",
      verdict: "Passed",
      verdictTone: "success",
      tests: "5 of 5 checks passed",
      agents: "Claude Code, Codex",
    });
    const html = renderToStaticMarkup(
      createElement(CardRow, { item: items[1]!, verified: false, highlighted: false, handlers }),
    );
    expect(html).toContain("Open report");
    expect(html).toContain(`/dashboard/chats/${CHAT}/artifacts/tlart_2`);
  });
});

describe("server payload shapes (0.10 migration)", () => {
  it("decision_card: human title, TL number only as the technical id", () => {
    const [agentCard, tlCard, legacy] = buildTimeline(
      [
        ev({
          eventType: "decision_card",
          body: "Use a queue for retries\nThis needs your decision.",
          payload: { decisionId: "tldec_1", number: 42, titleSource: "agent", requiresUser: true },
        }),
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "decision_card",
          body: "Roles chosen",
          payload: {
            decisionId: "tldec_2",
            number: 7,
            titleSource: "threadlink",
            requiresUser: false,
          },
        }),
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "decision",
          body: "Decision TL-00003\nThis needs your decision.",
        }),
      ],
      registry,
    );
    expect((agentCard as CardItem).card).toMatchObject({
      kind: "decision",
      title: "Use a queue for retries",
      attributedTo: "Codex · Coordinator",
      technicalId: "TL-00042",
      body: "This needs your decision.",
    });
    expect((tlCard as CardItem).card).toMatchObject({
      title: "Roles chosen",
      technicalId: "TL-00007",
    });
    expect(legacy).toMatchObject({ kind: "note" });
    expect((legacy as { text: string }).text).not.toContain("TL-");
  });

  it("finding titles come from the findings list, attributed to the raising agent", () => {
    const [item] = buildTimeline(
      [
        ev({
          authorKind: "agent",
          eventType: "finding",
          body: "Blocking finding from Claude Code (security)",
          payload: {
            findingId: "tlfnd_1",
            severity: "blocking",
            category: "security",
            status: "open",
            raisedBy: "claude-code",
            ownerParticipant: "codex:builder",
            filePath: "lib/a.ts",
            line: 3,
          },
        }),
      ],
      registry,
      {
        findings: new Map([["tlfnd_1", { title: "Secret written to logs", status: "disputed" }]]),
      },
    );
    expect((item as CardItem).card).toMatchObject({
      title: "Secret written to logs",
      status: "disputed",
      raisedBy: "Claude Code",
      owner: "Codex · Builder",
      location: "lib/a.ts:3",
    });
  });

  it("job_summary reads units, findings.byState and tests objects", () => {
    const [item] = buildTimeline(
      [
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "job_summary",
          payload: {
            verdict: "NEEDS_FIX",
            findings: {
              bySeverity: { blocking: 1 },
              byState: { open: 1, resolved: 2, dismissed: 0 },
            },
            units: { done: 3, skipped: 0, total: 4 },
            tests: { run: 4, passed: 3 },
            agents: ["claude-code", "codex"],
            finalVerifier: "claude-code",
            openItems: 1,
            changes: 2,
          },
        }),
      ],
      registry,
    );
    const card = (item as CardItem).card;
    expect(card).toMatchObject({
      verdict: "Needs fixes",
      verdictTone: "danger",
      tests: "3 of 4 checks passed",
      openItems: 1,
    });
    if (card.kind !== "job_summary") return;
    expect(Object.fromEntries(card.counts.map((c) => [c.key, c.value]))).toMatchObject({
      units: 3,
      open: 1,
      resolved: 2,
      changes: 2,
    });
  });

  it("uses any registry provider id and the per-chat read cursor from the page", () => {
    const e = parseEvent({
      id: "z",
      seq: 3,
      chatSeq: 3,
      body: "b",
      authorKind: "agent",
      authorProvider: null,
      authorProviderId: "gemini-cli",
      audienceId: "team",
    })!;
    expect(e.authorProvider).toBe("gemini-cli");
    expect(e.audience).toBe("team");
    expect(
      parsePage({ events: [], cursor: 0, activeJob: null, hasMore: false, lastReadChatSeq: 12 })!
        .lastReadSeq,
    ).toBe(12);
  });
});

describe("phases, unread divider, replies", () => {
  it("inserts collapsible phase separators", () => {
    const items = buildTimeline(
      [
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "phase",
          payload: { phase: "planning" },
        }),
        ev({ body: "plan" }),
        ev({
          authorKind: "threadlink",
          authorProvider: null,
          eventType: "job_status",
          body: "Building",
          payload: { status: "building" },
        }),
        ev({ body: "built" }),
      ],
      registry,
    );
    expect(
      items.filter((i) => i.kind === "phase").map((i) => (i as { label: string }).label),
    ).toEqual(["Planning", "Build"]);
    const collapsed = applyCollapsed(items, new Set(["planning"] as const));
    expect(collapsed.some((i) => i.kind === "message" && i.body === "plan")).toBe(false);
    expect(collapsed.some((i) => i.kind === "message" && i.body === "built")).toBe(true);
  });

  it("places one unread divider after the read cursor (not before your own messages)", () => {
    const a = ev({ body: "old" });
    const b = ev({ authorKind: "owner", authorProvider: null, body: "mine" });
    const c = ev({ body: "new 1" });
    const d = ev({ body: "new 2" });
    const items = buildTimeline([a, b, c, d], registry, { lastReadSeq: a.chatSeq });
    const i = items.findIndex((x) => x.kind === "unread");
    expect(items[i + 1]).toMatchObject({ body: "new 1" });
    expect(items[i]).toMatchObject({ count: 2 });
    expect(
      buildTimeline([a, b], registry, { lastReadSeq: a.chatSeq }).some((x) => x.kind === "unread"),
    ).toBe(false);
  });

  it("maps a reply to its target and resolves jumps", () => {
    const target = ev({ body: "The plan: split auth into two units." });
    const reply = ev({
      authorProvider: "claude-code",
      authorLabel: "Claude Code",
      authorRole: "reviewer",
      replyTo: target.id,
      body: "Looks good",
    });
    const items = buildTimeline([target, reply], registry);
    const r = items[1] as MessageItem;
    expect(r.quote).toMatchObject({
      targetId: target.id,
      who: "Codex · Coordinator",
      excerpt: "The plan: split auth into two units.",
    });
    const targets = replyTargets(items);
    expect(resolveJump(target.id, targets, [target, reply], false)).toEqual({
      kind: "item",
      key: target.id,
    });
    expect(resolveJump("tlcev_missing", targets, [target, reply], true)).toEqual({
      kind: "load_older",
    });
    expect(resolveJump("tlcev_missing", targets, [target, reply], false)).toEqual({
      kind: "missing",
    });
    const orphan = buildTimeline([ev({ replyTo: "tlcev_old" })], registry)[0] as MessageItem;
    expect(orphan.quote).toMatchObject({ targetId: "tlcev_old", excerpt: "Not loaded yet" });
  });
});

describe("paging by the per-chat cursor", () => {
  it("merges pages and de-duplicates by id and chat_seq", () => {
    const a = ev({ chatSeq: 10, id: "e10" });
    const b = ev({ chatSeq: 11, id: "e11" });
    const c = ev({ chatSeq: 12, id: "e12" });
    const older = [ev({ chatSeq: 8, id: "e8" }), ev({ chatSeq: 9, id: "e9" }), a];
    const merged = mergeTimeline([a, b], [c, b]);
    expect(merged.map((e) => e.id)).toEqual(["e10", "e11", "e12"]);
    expect(mergeTimeline(merged, older).map((e) => e.chatSeq)).toEqual([8, 9, 10, 11, 12]);
    // A newer copy of a row (delivery state changed) replaces the old one.
    const seen = { ...b, delivery: { state: "seen" as const, by: ["codex"] } };
    expect(mergeTimeline(merged, [seen]).find((e) => e.id === "e11")!.delivery).toEqual(
      seen.delivery,
    );
    // Two ids claiming one chat_seq: the server's latest copy wins, never both.
    const clash = mergeTimeline(merged, [ev({ chatSeq: 12, id: "e12b" })]);
    expect(clash.filter((e) => e.chatSeq === 12).map((e) => e.id)).toEqual(["e12b"]);
    expect(mergeTimeline(merged, [])).toBe(merged);
  });

  it("parses pages defensively (chat_seq, older servers' seq, bad rows)", () => {
    const raw = {
      events: [
        {
          id: "x1",
          chatSeq: 5,
          body: "hi",
          authorKind: "agent",
          authorProvider: "codex",
          authorLabel: "Codex",
          createdAt: "2026-09-26T12:00:00Z",
        },
        { id: "x2", seq: 6, body: "old server", authorKind: "owner", authorLabel: "You" },
      ],
      cursor: 6,
      activeJob: { jobId: JOB, mode: "team", status: "building", control: "pause_after_step" },
      hasOlder: true,
      live: [
        {
          runId: RUN,
          provider: "claude-code",
          role: "reviewer",
          activity: "reviewing",
          startedAt: "2026-09-26T11:57:00Z",
          lastActivityAt: "2026-09-26T11:59:48Z",
        },
        { bad: true },
      ],
    };
    const p = parsePage(raw)!;
    expect(p.events.map((e) => e.chatSeq)).toEqual([5, 6]);
    expect(p.hasOlder).toBe(true);
    expect(p.activeJob).toMatchObject({ control: "pause_after_step" });
    expect(p.live).toHaveLength(1);
    expect(parsePage({ ...raw, events: [{ id: "x", body: 3 }] })).toBeNull();
    expect(parsePage(null)).toBeNull();
    expect(parseEvent({ id: "y", chatSeq: 1, body: "b", authorKind: "martian" })).toBeNull();
    expect(
      parseEvent({
        id: "y",
        chatSeq: 1,
        body: "b",
        authorKind: "agent",
        ref: { kind: "evil", id: "1" },
      })!.ref,
    ).toBeNull();
  });

  it("windows the rendered list and backs off polling", () => {
    const arr = Array.from({ length: 500 }, (_, i) => i);
    expect(windowItems(arr, 150)).toMatchObject({ hiddenBefore: 350 });
    expect(windowItems(arr, 150).items[0]).toBe(350);
    expect(nextPollDelay({ visible: true, idleMs: 0, failures: 0, working: true })).toBe(3000);
    expect(nextPollDelay({ visible: true, idleMs: 0, failures: 3, working: true })).toBe(24000);
    expect(nextPollDelay({ visible: true, idleMs: 0, failures: 20, working: true })).toBe(60000);
    expect(nextPollDelay({ visible: false, idleMs: 0, failures: 0, working: true })).toBe(15000);
    expect(
      nextPollDelay({ visible: true, idleMs: 11 * 60_000, failures: 0, working: true }),
    ).toBeNull();
  });
});

describe("health freshness (one calculation, never contradictory)", () => {
  const now = T0;
  it("is Ready only when freshly checked", () => {
    const fresh = healthFreshness("ready", new Date(now - 23_000).toISOString(), now);
    expect(fresh).toMatchObject({ state: "ready", text: "Ready · checked 23 s ago" });
    const stale = healthFreshness("ready", new Date(now - 2 * 3600_000 - 1000).toISOString(), now);
    expect(stale).toMatchObject({ state: "stale", text: "Stale · last checked 2 h ago" });
    expect(healthFreshness("ready", null, now).state).toBe("stale");
    expect(healthFreshness("ready", "garbage", now).state).toBe("stale");
  });

  it("never pairs Ready with stale words across the whole range", () => {
    for (let age = 0; age < 5 * HEALTH_FRESH_MS; age += 7 * 60_000 + 13_000) {
      const f = healthFreshness("ready", new Date(now - age).toISOString(), now);
      const readyWord = /\bReady\b/.test(f.text);
      const staleWord = /stale|last checked/i.test(f.text);
      expect(readyWord && staleWord).toBe(false);
      expect(f.state === "ready").toBe(age <= HEALTH_FRESH_MS);
    }
  });

  it("the chat header uses the same rule and says where work runs", () => {
    const header = chatHeader10(
      {
        chatId: CHAT,
        name: "Auth",
        mode: "team",
        roomId: null,
        projectName: "Prism",
        groupId: null,
        groupName: null,
        pinned: false,
        archived: false,
        participants: [
          {
            kind: "agent",
            provider: "claude-code",
            name: "Claude Code",
            shortName: "Claude",
            health: "ready",
          },
          { kind: "agent", provider: "codex", name: "Codex", shortName: "Codex", health: "ready" },
        ],
        lastMessage: null,
        lastActivityAt: new Date(now).toISOString(),
        unread: false,
        needsAttention: false,
        activeJob: null,
      },
      {
        registry,
        checkedAt: {
          "claude-code": new Date(now - 23_000).toISOString(),
          codex: new Date(now - 3 * 3600_000).toISOString(),
        },
        host: {
          label: "Nickron's PC",
          online: false,
          lastSeenAt: new Date(now - 5 * 60_000).toISOString(),
          working: false,
          protocolOutdated: true,
        },
        now,
      },
    );
    expect(header.agents.map((a) => a.freshness.text)).toEqual([
      "Ready · checked 23 s ago",
      "Stale · last checked 3 h ago",
    ]);
    expect(header.host!.text).toBe("Runs on Nickron's PC · Offline · last seen 5 min ago");
    expect(header.offlineNote).toBe("Nickron's PC is offline. Work continues when it reconnects.");
    expect(header.callouts.some((c) => c.text.includes("needs an update"))).toBe(true);
    expect(hostView({ label: "Box", online: true, working: true }, now)!.text).toBe(
      "Runs on Box · Online · Working",
    );
  });
});

describe("live activity", () => {
  it("shows activity, elapsed and last activity; stalls after 3 min of silence", () => {
    const row = liveRow(
      {
        runId: RUN,
        provider: "claude-code",
        providerName: "",
        role: "reviewer",
        activity: "reviewing",
        startedAt: new Date(T0 - 3 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - 12_000).toISOString(),
      },
      registry,
      T0,
    );
    expect(row.who).toBe("Claude Code · Reviewer");
    expect(row.line).toBe("● Reviewing · 3m · last activity 12 s ago");
    expect(row.stalled).toBeNull();
    const quiet = liveRow(
      {
        runId: RUN,
        provider: "codex",
        providerName: "",
        role: "builder",
        activity: "building",
        startedAt: new Date(T0 - 10 * 60_000).toISOString(),
        lastActivityAt: new Date(T0 - 4 * 60_000).toISOString(),
      },
      registry,
      T0,
    );
    expect(quiet.stalled).toBe("No output for 4 min");
  });
});

describe("safe rendering", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(SafeBody, { text }));

  it("never renders HTML; only http(s) links, with noopener nofollow", () => {
    const html = render(
      `<img src=x onerror=alert(1)> <script>alert(1)</script> [x](javascript:alert(1)) javascript:alert(1) data:text/html,hi https://example.com/a?b=1). http://user:pw@evil.test/`,
    );
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="(javascript|data):/);
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain('user:pw@evil.test/"'); // credentials in a URL are not linked
    expect(safeHref("ftp://x")).toBeNull();
    expect(safeHref("HTTPS://ok.test")).toBe("https://ok.test/");
  });

  it("strips ANSI escapes, control characters and bidi overrides", () => {
    expect(cleanText("\u001b[31mred\u001b[0m \u0007bell\u0000 \u202eevil\u202c ok")).toBe(
      "red bell evil ok",
    );
    expect(cleanText("\u001b]0;title\u0007after")).toBe("after");
    expect(render("\u001b[1mBold\u001b[0m")).not.toContain("\u001b");
  });

  it("keeps code blocks usable (monospace, copy) without interpreting them", () => {
    const doc = tokenize("Before\n```ts\nconst a = '<b>';\n```\nAfter `x < y`");
    expect(doc.blocks.map((b) => b.t)).toEqual(["para", "code", "para"]);
    const html = render("```ts\nconst a = '<b>';\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("Copy");
  });

  it("caps huge bodies and long code blocks", () => {
    const huge = "x".repeat(200_000);
    const doc = tokenize(huge);
    expect(doc.truncated).toBe(true);
    expect(doc.chars).toBe(200_000);
    const code = tokenize(
      "```\n" + Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n```",
    );
    expect(code.blocks[0]).toMatchObject({ t: "code", truncatedLines: 600 });
    const t = performance.now();
    render("a ".repeat(100_000));
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("oneLine previews are single-line and bounded", () => {
    expect(oneLine("a\n\nb```code\nx```c", 100)).toBe("a b [code] c");
    expect(oneLine("y".repeat(500), 10)).toHaveLength(10);
  });
});

describe("performance budget", () => {
  it("builds the view model for 10,000 events within budget", () => {
    const kinds = ["agent_message", "message", "job_status", "finding", "decision", "code_change"];
    const events: TimelineEvent[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const k = kinds[i % kinds.length]!;
      events.push({
        id: `e${i}`,
        chatSeq: i,
        createdAt: new Date(T0 + i * 1000).toISOString(),
        jobId: JOB,
        runId: i % 3 === 0 ? RUN : null,
        authorKind: k === "message" ? "owner" : k === "job_status" ? "threadlink" : "agent",
        authorProvider: i % 2 ? "codex" : "claude-code",
        authorLabel: "",
        authorRole: i % 2 ? "builder" : "reviewer",
        audience: null,
        eventType: k,
        messageType: null,
        round: null,
        modelRequested: null,
        modelObserved: "gpt-6-sol",
        body: `Message ${i} with a link https://example.com/${i} and \`code\``,
        visibility: "visible",
        replyTo: i > 10 && i % 7 === 0 ? `e${i - 5}` : null,
        ref: k === "finding" && i > 100 ? { kind: "finding", id: `F${i % 50}` } : null,
        payload:
          k === "finding"
            ? {
                findingId: `F${i % 50}`,
                status: i % 4 ? "open" : "fixed",
                title: "t",
                severity: "important",
                category: "tests",
              }
            : k === "decision"
              ? { title: "d", titleSource: "threadlink" }
              : k === "code_change"
                ? { filesChanged: 1, insertions: 1, deletions: 0, files: ["a.ts"] }
                : k === "job_status"
                  ? { status: i % 12 ? "building" : "reviewing" }
                  : null,
        delivery: k === "message" ? { state: "seen", by: ["codex"] } : null,
      });
    }
    const merged = mergeTimeline(events.slice(0, 5000), events.slice(4900));
    expect(merged).toHaveLength(10_000);
    // Best of three runs (the first includes JIT warm-up), so a busy machine
    // measures the algorithm rather than scheduler noise.
    let items: ReturnType<typeof buildTimeline> = [];
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      items = buildTimeline(merged, registry, { lastReadSeq: 9_000 });
      best = Math.min(best, performance.now() - start);
    }
    expect(items.length).toBeGreaterThan(9_000);
    expect(items.filter((i) => i.kind === "unread")).toHaveLength(1);
    // Generous for CI; a quiet machine does this in well under 100 ms.
    expect(best).toBeLessThan(500);
  });
});

describe("composer banner", () => {
  it("says a message to running work is a note; mentions route by alias", () => {
    expect(composerBanner({ status: "building" }, "hi", registry, "Team").text).toMatch(
      /note to the running work/,
    );
    expect(composerBanner(null, "@codex fix it", registry, "Team").text).toBe(
      "Starts new work for Codex only (from your @mention).",
    );
    expect(composerBanner(null, "@team go", registry, "Team").text).toBe(
      "Starts new work for the whole team.",
    );
    expect(composerBanner(null, "plain", registry, "Team · Claude Code + Codex").text).toBe(
      "Starts new work in this chat · Team · Claude Code + Codex.",
    );
  });
});

describe("attachments", () => {
  it("accepts text up to 64 KiB only", () => {
    expect(checkAttachment({ name: "notes.md", size: 100, type: "text/markdown" })).toMatchObject({
      ok: true,
      title: "notes.md",
    });
    expect(checkAttachment({ name: "a.ts", size: 100, type: "" })).toMatchObject({
      ok: true,
      mime: "text/plain",
    });
    expect(checkAttachment({ name: "big.txt", size: 64 * 1024 + 1, type: "text/plain" }).ok).toBe(
      false,
    );
    expect(checkAttachment({ name: "x.png", size: 10, type: "image/png" }).ok).toBe(false);
    expect(checkAttachment({ name: "x.txt", size: 0, type: "text/plain" }).ok).toBe(false);
    expect(decodeText(new Uint8Array([104, 105]))).toBe("hi");
    expect(decodeText(new Uint8Array([104, 0, 105]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(attachmentTitle("C:\\secret\\dir\\\u202enotes.txt")).toBe("notes.txt");
    expect(checkAttachment({ name: "plan.md", size: 10, type: "" })).toMatchObject({
      ok: true,
      mime: "text/markdown",
    });
  });
});

describe("navigation, shortcuts, search, onboarding, project hub", () => {
  const chat = (over: Record<string, unknown>) => ({
    chatId: CHAT,
    name: "Chat",
    mode: "team" as const,
    roomId: null,
    projectName: null,
    groupId: null,
    groupName: null,
    pinned: false,
    archived: false,
    participants: [],
    lastMessage: null,
    lastActivityAt: new Date(T0).toISOString(),
    unread: false,
    needsAttention: false,
    activeJob: null,
    ...over,
  });

  it("organises the sidebar as Pinned · Projects · Groups · Recent", () => {
    const nav = chatNav([
      chat({ chatId: "c1", name: "Pinned one", pinned: true }),
      chat({ chatId: "c2", name: "In Prism", roomId: "r1", projectName: "Prism" }),
      chat({ chatId: "c3", name: "Grouped", groupId: "g1", groupName: "Work" }),
      chat({ chatId: "c4", name: "Old", archived: true }),
    ]);
    expect(nav.pinned.map((c) => c.name)).toEqual(["Pinned one"]);
    expect(nav.projects[0]).toMatchObject({ name: "Prism", href: "/dashboard/projects/r1" });
    expect(nav.groups[0]!.chats[0]!.name).toBe("Grouped");
    expect(nav.recent.map((c) => c.name)).not.toContain("Old");
    expect(nav.order[0]).toBe("/dashboard/chats/c1");
    expect(adjacentChat(nav.order, "/dashboard/chats/c1", 1)).toBe(nav.order[1]);
    expect(adjacentChat(nav.order, "/dashboard/chats/c1", -1)).toBeNull();
  });

  it("maps keyboard shortcuts without stealing typed characters", () => {
    const k = (key: string, o: Partial<Parameters<typeof shortcutFor>[0]> = {}) =>
      shortcutFor({
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        inEditable: false,
        ...o,
      });
    expect(k("k", { ctrlKey: true })).toBe("search");
    expect(k("k", { metaKey: true, inEditable: true })).toBe("search");
    expect(k("n", { altKey: true })).toBe("new_chat");
    expect(k("ArrowDown", { altKey: true })).toBe("next_chat");
    expect(k("2", { altKey: true })).toBe("tab_progress");
    expect(k("/")).toBe("focus_composer");
    expect(k("/", { inEditable: true })).toBeNull();
    expect(k("?")).toBe("help");
    expect(k("Escape", { inEditable: true })).toBe("escape");
    expect(k("a")).toBeNull();
  });

  it("validates search input and shapes results as plain text", () => {
    const q = parseSearchQuery({
      q: "  auth\nbug ",
      project: "../x",
      agent: "codex",
      mode: "team",
      status: "bogus",
      from: "2026-09-01",
      to: "tomorrow",
    });
    expect(q).toMatchObject({
      q: "auth bug",
      projectId: null,
      agent: "codex",
      mode: "team",
      status: null,
      from: "2026-09-01",
      to: null,
    });
    const facts = new Map([
      [
        CHAT,
        {
          chatId: CHAT,
          roomId: "r1",
          projectName: "Prism",
          mode: "team",
          agents: ["claude-code", "codex"],
          working: true,
          needsAttention: false,
        },
      ],
    ]);
    const rows = [
      {
        kind: "finding",
        chatId: CHAT,
        chatName: "<b>Auth</b>",
        refId: "f1",
        snippet: "line1\nline2",
        chatSeq: null,
        at: "2026-09-10T10:00:00Z",
      },
      { chatId: "../../etc", chatName: "x", at: "2026-09-10T10:00:00Z" },
      { chatId: "tlcht_other", chatName: "Not mine", at: "2026-09-10T10:00:00Z" },
    ];
    const r = searchResults(rows, q, facts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      chat: "<b>Auth</b>",
      project: "Prism",
      kind: "Finding",
      excerpt: "line1 line2",
      href: `/dashboard/chats/${CHAT}`,
    });
    // Filters apply to the chat's facts and the row's date.
    expect(searchResults(rows, { ...q, mode: "solo" }, facts)).toHaveLength(0);
    expect(searchResults(rows, { ...q, agent: "cursor" }, facts)).toHaveLength(0);
    expect(searchResults(rows, { ...q, status: "finished" }, facts)).toHaveLength(0);
    expect(searchResults(rows, { ...q, status: "working", projectId: "r1" }, facts)).toHaveLength(
      1,
    );
    expect(searchResults(rows, { ...q, from: "2026-09-11" }, facts)).toHaveLength(0);
    expect(searchResults(rows, { ...q, to: "2026-09-10" }, facts)).toHaveLength(1);
  });

  it("first run: connect agents, then create the first chat", () => {
    const none = onboarding({ chats: 0, readyAgents: [], detectedAgents: 0 });
    expect(none.show).toBe(true);
    expect(none.title).toBe("Welcome to ThreadLink");
    expect(none.steps.map((s) => [s.key, s.state])).toEqual([
      ["agents", "current"],
      ["chat", "todo"],
    ]);
    const ready = onboarding({ chats: 0, readyAgents: ["Claude Code"], detectedAgents: 1 });
    expect(ready.steps.map((s) => s.state)).toEqual(["done", "current"]);
    expect(onboarding({ chats: 2, readyAgents: [], detectedAgents: 0 }).show).toBe(false);
  });

  it("project hub: no fake verification; suggestions only from detected tooling", () => {
    const empty = projectHub(null, { projectName: "Prism", controller: "ChatGPT", now: T0 });
    expect(empty.verification.empty).toBe("No project verification commands configured.");
    expect(empty.verification.howTo).toContain("Prism");
    expect(empty.verification.suggestions).toEqual([]);
    const detected = projectHub(
      { detectedTooling: ["npm", "vitest", "unknown-tool"] },
      { projectName: "Prism", controller: "ChatGPT", now: T0 },
    );
    expect(detected.verification.suggestions).toEqual(["npm test", "npx vitest run"]);
    expect(detected.verification.suggestionNote).toMatch(/Nothing runs until you add it/);
    const configured = projectHub(
      { verificationCommands: ["npm run check"], detectedTooling: ["npm"] },
      { projectName: "Prism", controller: "ChatGPT", now: T0 },
    );
    expect(configured.verification).toMatchObject({
      commands: ["npm run check"],
      empty: null,
      suggestions: [],
    });
  });
});
