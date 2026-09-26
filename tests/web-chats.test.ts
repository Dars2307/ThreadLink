import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const data = vi.hoisted(() => ({
  createChat: vi.fn(async (input: unknown) => (void input, "tlcht_" + "0".repeat(31) + "9")),
  updateChat: vi.fn(async (...args: unknown[]) => void args),
  retryJobWithRoles: vi.fn(async (...args: unknown[]) => void args),
  setChatPinned: vi.fn(),
  setChatArchived: vi.fn(),
  deleteChat: vi.fn(),
  createChatGroup: vi.fn(),
  renameChatGroup: vi.fn(),
  deleteChatGroup: vi.fn(),
}));
vi.mock("@/lib/dashboard/chats-data", () => ({
  ...data,
  ChatServerUnavailableError: class ChatServerUnavailableError extends Error {},
}));

import {
  createChatAction,
  retryJobAction,
  setChatModeAction,
  setChatProjectAction,
} from "@/app/dashboard/chat-actions";
import { ChatView } from "@/components/dashboard/chat-view";
import { ChatHeader, ChatListRow } from "@/components/dashboard/chats";
import { NAV } from "@/components/dashboard/sidebar";
import type { ChatEvent, ChatSummary, ParticipantView } from "@/lib/chat/types";
import { safeHref } from "@/lib/dashboard/action-result";
import { deriveAgents, profileHealth } from "@/lib/dashboard/agents";
import { chatItemView, milestoneSymbol } from "@/lib/dashboard/chat";
import {
  blockedCallout,
  chatHeader,
  chatHref,
  chatListHref,
  CONVERSATIONS_REDIRECT,
  defaultChatFor,
  deriveChatList,
  homeChats,
  jobRedirect,
  keepLogPages,
  MODE_BADGES,
  modeControl,
  NO_PROJECT_TEXT,
  parseChatListQuery,
  previewText,
  projectTabRedirect,
  retryOption,
  sortChats,
  TEAM_REDIRECT,
} from "@/lib/dashboard/chats";
import { taskGraph, type JobDetail } from "@/lib/dashboard/pages";
import {
  healthCallout,
  healthLine,
  participantLines,
  participantsText,
  providerDisplay,
  shortModelName,
} from "@/lib/dashboard/providers-display";
import type { OwnerProviderProfile } from "@/lib/providers/queries";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const CHAT = (n: number) => `tlcht_${hex(n)}`;
const ROOM = `tlrom_${hex(1)}`;
const ROOM2 = `tlrom_${hex(2)}`;
const GROUP = `tlgrp_${hex(1)}`;
const JOB = `tljob_${hex(1)}`;
const ID = /\btl[a-z]{2,5}_[0-9a-f]/;
const NOW = Date.parse("2026-09-26T12:00:00Z");

const you: ParticipantView = {
  kind: "owner",
  provider: null,
  name: "You",
  shortName: "You",
  health: null,
};
const agent = (
  provider: string,
  health: ParticipantView["health"],
  name = "",
): ParticipantView => ({
  kind: "agent",
  provider,
  name,
  shortName: name,
  health,
});
const CLAUDE_OK = agent("claude-code", "ready", "Claude Code");
const CODEX_OK = agent("codex", "ready", "Codex");
const CLAUDE_SIGNIN = agent("claude-code", "needs_sign_in", "Claude Code");

const chat = (n: number, over: Partial<ChatSummary> = {}): ChatSummary => ({
  chatId: CHAT(n),
  name: `Chat ${n}`,
  mode: "team",
  roomId: ROOM,
  projectName: "Prism",
  groupId: null,
  groupName: null,
  pinned: false,
  archived: false,
  participants: [you, CLAUDE_OK, CODEX_OK],
  lastMessage: "Done.",
  lastActivityAt: new Date(NOW - n * 60_000).toISOString(),
  unread: false,
  needsAttention: false,
  activeJob: null,
  ...over,
});

const CHATS: ChatSummary[] = [
  chat(1, { name: "Newest" }),
  chat(2, { name: "Pinned old", pinned: true, lastActivityAt: "2026-09-01T00:00:00Z" }),
  chat(3, {
    name: "Solo fix",
    mode: "solo",
    roomId: ROOM2,
    projectName: "Site",
    groupId: GROUP,
    groupName: "Work",
    unread: true,
    participants: [you, CODEX_OK],
    lastMessage: "Line one\n\n  <b>line</b>   two",
  }),
  chat(4, { name: "Blocked", needsAttention: true, roomId: null, projectName: null }),
  chat(5, { name: "Old archived", archived: true }),
];
const GROUPS = [{ groupId: GROUP, name: "Work" }];
const PROJECTS = [
  { roomId: ROOM, name: "Prism" },
  { roomId: ROOM2, name: "Site" },
];
const list = (search: Record<string, string> = {}) =>
  deriveChatList(CHATS, GROUPS, PROJECTS, parseChatListQuery(search), NOW);
const names = (search: Record<string, string> = {}) =>
  list(search).view.sections.flatMap((s) => s.rows.map((r) => r.name));

// ---------------------------------------------------------------------------

describe("chat list view model", () => {
  it("puts pinned chats first, then the most recent; archived chats are hidden", () => {
    expect(names()).toEqual(["Pinned old", "Newest", "Solo fix", "Blocked"]);
    expect(list().view.sections.map((s) => s.title)).toEqual(["Pinned", "Recent"]);
    expect(sortChats([chat(9, { name: "b" }), chat(9, { name: "a" })]).map((c) => c.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("filters by mode, group, project, attention, unread and archived", () => {
    expect(names({ mode: "solo" })).toEqual(["Solo fix"]);
    expect(names({ group: GROUP })).toEqual(["Solo fix"]);
    expect(names({ group: "none" })).toEqual(["Pinned old", "Newest", "Blocked"]);
    expect(names({ project: ROOM2 })).toEqual(["Solo fix"]);
    expect(names({ project: "none" })).toEqual(["Blocked"]);
    expect(names({ show: "attention" })).toEqual(["Blocked"]);
    expect(names({ show: "unread" })).toEqual(["Solo fix"]);
    expect(names({ show: "archived" })).toEqual(["Old archived"]);
    expect(names({ mode: "bogus" })).toHaveLength(4);
    expect(list({ group: "../x" }).view.query.group).toBeNull();
  });

  it("searches names, projects, groups, messages and participants", () => {
    expect(names({ q: "solo" })).toEqual(["Solo fix"]);
    expect(names({ q: "site" })).toEqual(["Solo fix"]);
    expect(names({ q: "work" })).toEqual(["Solo fix"]);
    expect(names({ q: "line two" })).toEqual(["Solo fix"]);
    expect(names({ q: "claude" })).toEqual(["Pinned old", "Newest", "Blocked"]);
    expect(names({ q: "nothing-like-this" })).toEqual([]);
    expect(list({ q: "nothing-like-this" }).view.emptyText).toMatch(/Clear the filters/);
  });

  it("groups into sections by group or by project", () => {
    expect(list({ by: "group" }).view.sections.map((s) => [s.title, s.rows.length])).toEqual([
      ["Work", 1],
      ["No group", 3],
    ]);
    expect(list({ by: "project" }).view.sections.map((s) => s.title)).toEqual([
      "Prism",
      "Site",
      "No project",
    ]);
  });

  it("shows participants, mode badge, badges, counts and relative time", () => {
    const rows = list().view.sections.flatMap((s) => s.rows);
    const solo = rows.find((r) => r.name === "Solo fix")!;
    expect(solo).toMatchObject({
      participants: "Codex",
      modeBadge: "SOLO",
      unread: true,
      project: "Site",
      group: "Work",
      when: "3 min ago",
    });
    expect(rows.find((r) => r.name === "Newest")!.participants).toBe("Claude Code + Codex");
    expect(rows.find((r) => r.name === "Blocked")!.needsAttention).toBe(true);
    expect(list().view.counts).toEqual({ attention: 1, unread: 1, archived: 1 });
    expect(MODE_BADGES).toEqual({ solo: "SOLO", pair: "BUILDER + REVIEWER", team: "TEAM" });
  });

  it("previews the last message as one line of plain text", () => {
    const solo = list()
      .view.sections.flatMap((s) => s.rows)
      .find((r) => r.name === "Solo fix")!;
    expect(solo.preview).toBe("Line one <b>line</b> two");
    expect(previewText(null)).toBe("No messages yet");
    expect(previewText("   \n ")).toBe("No messages yet");
    expect(previewText("x".repeat(500))).toHaveLength(120);
    expect(previewText("a\u0000b\u0007c")).toBe("abc");
  });

  it("never puts a raw id in the view; ids are only in handles", () => {
    const m = list({ by: "project" });
    expect(JSON.stringify(m.view)).not.toMatch(ID);
    const row = m.view.sections[0]!.rows[0]!;
    expect(m.handles[row.key]!.chatId).toMatch(/^tlcht_/);
    const home = homeChats(CHATS, NOW);
    expect(JSON.stringify(home.view)).not.toMatch(ID);
    expect(home.view.recent[0]!.name).toBe("Pinned old");
    expect(home.view.attention.map((r) => r.name)).toEqual(["Blocked"]);
  });

  it("builds list links without defaults", () => {
    expect(chatListHref({})).toBe("/dashboard/chats");
    expect(chatListHref({ mode: "team", show: "all", by: "none" })).toBe(
      "/dashboard/chats?mode=team",
    );
    expect(chatListHref({ q: "a b", show: "attention" })).toBe(
      "/dashboard/chats?q=a+b&show=attention",
    );
  });
});

describe("participants and providers", () => {
  it("renders an unknown provider generically, without crashing or borrowing a name", () => {
    const lines = participantLines([you, agent("gemini-cli", "ready"), CODEX_OK]);
    const gemini = lines.find((l) => l.kind === "agent" && l.name !== "Codex")!;
    expect(gemini.name).toBe("Gemini cli");
    expect(gemini.tone).toBe("neutral");
    expect(gemini.health?.line).toBe("Gemini cli — Ready");
    expect(participantsText([agent("gemini-cli", null), CLAUDE_OK])).toBe(
      "Gemini cli + Claude Code",
    );
    expect(providerDisplay("<script>")).toMatchObject({
      id: "agent",
      name: "Agent",
      supported: false,
    });
    expect(providerDisplay("claude")).toMatchObject({ id: "claude-code", name: "Claude Code" });
    expect(providerDisplay("cursor")).toMatchObject({ name: "Cursor", supported: false });
    expect(healthCallout("gemini-cli", "needs_sign_in")).toBe(
      "Gemini cli needs you to sign in again on this computer. Sign in to it again, then press Check again on the ThreadLink app.",
    );
  });

  it("says health in fixed words, warning tone for sign-in", () => {
    expect(healthLine("claude-code", "needs_sign_in")).toBe("Claude Code — Needs sign-in");
    expect(healthLine("codex", "ready")).toBe("Codex — Ready");
    expect(healthLine("codex", null)).toBe("Codex — Not checked yet");
    expect(participantLines([CLAUDE_SIGNIN])[0]!.health).toEqual({
      text: "Needs sign-in",
      tone: "warning",
      line: "Claude Code — Needs sign-in",
    });
  });

  it("gives the exact sign-in instruction", () => {
    expect(healthCallout("claude-code", "needs_sign_in")).toBe(
      "Claude Code needs you to sign in again on this computer. Open a terminal and run `claude`, then press Check again on the ThreadLink app.",
    );
    expect(healthCallout("codex", "needs_sign_in")).toContain("run `codex login`");
    expect(healthCallout("codex", "ready")).toBeNull();
  });

  it("shows the model that answered in agent headers", () => {
    expect(shortModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(shortModelName("gpt-6-sol")).toBe("GPT-6 Sol");
    const base: ChatEvent = {
      seq: 1,
      id: "e1",
      createdAt: "2026-09-26T11:00:00Z",
      roomId: ROOM,
      agentSessionId: "s",
      jobId: JOB,
      taskId: null,
      nodeId: null,
      authorKind: "agent",
      authorProvider: "codex",
      authorLabel: "Codex",
      authorRole: "reviewer",
      audience: null,
      eventType: "agent_message",
      messageType: null,
      round: null,
      modelRequested: "gpt-6-sol",
      modelObserved: "gpt-6-sol",
      body: "Looks good.",
      visibility: "visible",
    };
    expect(chatItemView(base)).toMatchObject({ headline: "Codex · GPT-6 Sol" });
    // Requested only: the header does not claim a model.
    expect(chatItemView({ ...base, modelObserved: null })).toMatchObject({ headline: "Codex" });
    // An unknown provider id still renders.
    const odd = chatItemView({ ...base, authorProvider: "gemini-cli" as never, authorLabel: "" });
    expect(odd).toMatchObject({ headline: "Gemini cli · GPT-6 Sol", badgeTone: "neutral" });
  });

  it("marks ThreadLink lines with compact symbols", () => {
    expect(milestoneSymbol({ eventType: "job_verdict", body: "Result: PASS" })).toBe("✓");
    expect(milestoneSymbol({ eventType: "job_verdict", body: "Result: BLOCKED" })).toBe("✕");
    expect(milestoneSymbol({ eventType: "task_started", body: "" })).toBe("●");
    expect(milestoneSymbol({ eventType: "plan_agreed", body: "" })).toBe("✓");
    expect(milestoneSymbol({ eventType: "provider_blocked" as never, body: "" })).toBe("✕");
  });
});

describe("mode control", () => {
  const settings = {
    mode: "pair" as const,
    soloProvider: null,
    builderProvider: "codex",
    reviewerProvider: null,
  };

  it("labels the modes and offers the chat's agents plus Auto", () => {
    const c = modeControl(settings, [you, CLAUDE_OK, CODEX_OK]);
    expect(c.options.map((o) => o.label)).toEqual(["Solo", "Builder + Reviewer", "Team"]);
    expect(c.badge).toBe("BUILDER + REVIEWER");
    expect(c.providers).toEqual([
      { value: "", label: "Auto" },
      { value: "claude-code", label: "Claude Code" },
      { value: "codex", label: "Codex" },
    ]);
    expect(c.summary).toBe("Builder: Codex · Reviewer: Auto");
    expect(c.note).toMatch(/future work only/);
    expect(modeControl({ ...settings, mode: "team" }, [you, CLAUDE_OK, CODEX_OK]).summary).toBe(
      "Team · Claude Code + Codex",
    );
    expect(modeControl({ ...settings, mode: "solo" }, [you, CLAUDE_OK]).summary).toBe(
      "Solo · Auto",
    );
  });

  it("does not offer two-agent modes with one agent, and ignores a provider not in the chat", () => {
    const c = modeControl({ ...settings, builderProvider: "gemini-cli" }, [you, CODEX_OK]);
    expect(c.options.map((o) => o.available)).toEqual([true, false, false]);
    expect(c.builder).toBe("");
  });
});

describe("chat header", () => {
  it("names the project, or asks for one", () => {
    expect(chatHeader(chat(1)).projectText).toBe("Project: Prism");
    expect(chatHeader(chat(1, { roomId: null, projectName: null })).projectText).toBe(
      NO_PROJECT_TEXT,
    );
    expect(NO_PROJECT_TEXT).toBe("No project — choose one so agents know which folder to use");
  });

  it("shows health callouts for agents that need the user", () => {
    const h = chatHeader(chat(1, { participants: [you, CLAUDE_SIGNIN, CODEX_OK] }));
    expect(h.participants.filter((p) => p.kind === "agent").map((p) => p.health?.line)).toEqual([
      "Claude Code — Needs sign-in",
      "Codex — Ready",
    ]);
    expect(h.callouts.map((c) => c.text)).toEqual([
      "Claude Code needs you to sign in again on this computer. Open a terminal and run `claude`, then press Check again on the ThreadLink app.",
    ]);
    expect(JSON.stringify(h)).not.toMatch(ID);
  });
});

// ---------------------------------------------------------------------------
// Blocked jobs, retry and honest stages
// ---------------------------------------------------------------------------

const blockedJob = (over: Partial<JobDetail> = {}): JobDetail => ({
  jobId: JOB,
  goal: "Add a health check",
  status: "blocked",
  statusLabel: "Blocked",
  line: null,
  verdict: "BLOCKED",
  finished: true,
  planning: "Round 0 of 3",
  review: "Round 0 of 3",
  startedAt: "2026-09-26T11:00:00Z",
  finishedAt: "2026-09-26T11:01:00Z",
  summary: null,
  nodes: [],
  findings: { open: { blocking: 0, important: 0, nonBlocking: 0 }, recent: [] },
  decisions: [],
  modelRuns: [
    {
      provider: "Claude",
      role: "coordinator",
      requested: "claude-sonnet-5",
      observed: null,
      matched: true,
      modelClass: "BALANCED",
      reason: "Coordinator",
      outcome: "provider_error",
      at: "2026-09-26T11:00:30Z",
    },
  ],
  verdictReason: "agent_needs_sign_in",
  verdictProvider: "claude-code",
  planPersisted: false,
  planApproved: false,
  lastPhase: "normalising",
  ...over,
});

describe("blocked on sign-in: callout and retry", () => {
  const people = [you, CLAUDE_SIGNIN, CODEX_OK];

  it("explains the sign-in in fixed words", () => {
    expect(blockedCallout(blockedJob(), people)).toBe(
      "Claude Code needs you to sign in again on this computer. Open a terminal and run `claude`, then press Check again on the ThreadLink app.",
    );
    // No verdictProvider: the one participant needing sign-in is named.
    expect(blockedCallout(blockedJob({ verdictProvider: null }), people)).toContain(
      "Claude Code needs you",
    );
    expect(blockedCallout(blockedJob({ verdictReason: "tests_failed" }), people)).toBeNull();
    expect(blockedCallout(blockedJob({ status: "completed", verdict: "PASS" }), people)).toBeNull();
  });

  it("offers Retry with Codex as coordinator only before any plan, and only with a ready agent", () => {
    expect(retryOption(blockedJob(), people)).toMatchObject({
      provider: "codex",
      label: "Retry with Codex as coordinator",
    });
    expect(retryOption(blockedJob({ planPersisted: true }), people)).toBeNull();
    expect(
      retryOption(
        blockedJob({
          nodes: [
            {
              key: "a",
              title: "A",
              owner: "Claude",
              reviewer: null,
              status: "pending",
              statusLabel: "",
              mixedAuthorship: false,
              dependsOn: [],
            },
          ],
        }),
        people,
      ),
    ).toBeNull();
    expect(
      retryOption(blockedJob(), [you, CLAUDE_SIGNIN, agent("codex", "needs_sign_in")]),
    ).toBeNull();
    expect(retryOption(blockedJob(), [you, CLAUDE_SIGNIN])).toBeNull();
    expect(retryOption(blockedJob({ verdictReason: "tests_failed" }), people)).toBeNull();
    expect(
      retryOption(blockedJob({ status: "building", verdict: null, finished: false }), people),
    ).toBeNull();
    // A provider ThreadLink cannot run is never offered.
    expect(retryOption(blockedJob(), [you, CLAUDE_SIGNIN, agent("cursor", "ready")])).toBeNull();
  });
});

const stages = (job: Parameters<typeof taskGraph>[0]) =>
  taskGraph(job)
    .filter((l) => !l.branch)
    .map((l) => `${l.symbol} ${l.label}`);

describe("honest stages (regressions)", () => {
  it("failure before normalisation: nothing is done", () => {
    expect(stages(blockedJob({ lastPhase: "queued" }))).toEqual([
      "✕ Understanding request",
      "– Plan",
      "– Build",
      "– Review",
      "– Integration",
    ]);
  });

  it("failure during normalisation (the production job) never shows Plan ✓", () => {
    expect(stages(blockedJob())).toEqual([
      "✕ Understanding request",
      "– Plan",
      "– Build",
      "– Review",
      "– Integration",
    ]);
    // Same job from an older server without last_phase: still not Plan ✓.
    const legacy = stages(
      blockedJob({ lastPhase: undefined, planPersisted: undefined, planApproved: undefined }),
    );
    expect(legacy[0]).toBe("✕ Understanding request");
    expect(legacy[1]).toBe("– Plan");
  });

  it("failure before the first planning round: Plan ✕, no plan", () => {
    const g = stages(blockedJob({ lastPhase: "planning" }));
    expect(g).toEqual([
      "✓ Understanding request",
      "✕ Plan",
      "– Build",
      "– Review",
      "– Integration",
    ]);
  });

  it("failure during planning with a draft plan: Plan ✕ (persisted but not approved)", () => {
    expect(
      stages(blockedJob({ lastPhase: "planning", planPersisted: true, planApproved: false })),
    ).toEqual(["✓ Understanding request", "✕ Plan", "– Build", "– Review", "– Integration"]);
    // Without last_phase, a planner run proves only that planning started.
    const legacy = blockedJob({
      lastPhase: undefined,
      planPersisted: undefined,
      planApproved: undefined,
      modelRuns: [{ ...blockedJob().modelRuns[0]!, role: "planner" }],
    });
    expect(stages(legacy).slice(0, 2)).toEqual(["✓ Understanding request", "✕ Plan"]);
  });

  it("Plan is ✓ only when persisted AND approved", () => {
    const building = { status: "building" as const, verdict: null, nodes: [] };
    expect(stages({ ...building, planPersisted: true, planApproved: false })[1]).toBe("– Plan");
    expect(stages({ ...building, planPersisted: true, planApproved: true })[1]).toBe("✓ Plan");
  });

  it("later stages are – after a failure; solo has no Review", () => {
    const g = stages(
      blockedJob({ lastPhase: "building", planPersisted: true, planApproved: true, mode: "solo" }),
    );
    expect(g).toEqual(["✓ Understanding request", "✓ Plan", "✕ Build", "– Integration"]);
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe("old addresses", () => {
  const chats = [
    {
      chatId: CHAT(1),
      roomId: ROOM,
      name: "Side chat",
      lastActivityAt: "2026-09-26T11:00:00Z",
      archived: false,
    },
    {
      chatId: CHAT(2),
      roomId: ROOM,
      name: "Prism",
      lastActivityAt: "2026-09-20T11:00:00Z",
      archived: false,
    },
    {
      chatId: CHAT(3),
      roomId: ROOM2,
      name: "Other",
      lastActivityAt: "2026-09-26T11:00:00Z",
      archived: false,
    },
  ];

  it("sends Team and Conversations to their new homes", () => {
    expect(TEAM_REDIRECT).toBe("/dashboard/chats?mode=team");
    expect(CONVERSATIONS_REDIRECT).toBe("/dashboard/agents");
    expect(parseChatListQuery({ mode: "team" }).mode).toBe("team");
  });

  it("finds a project's default chat", () => {
    expect(defaultChatFor(ROOM, "Prism", [...chats, { ...chats[0]!, isRoomDefault: true }])).toBe(
      CHAT(1),
    );
    expect(defaultChatFor(ROOM, "Prism", chats)).toBe(CHAT(2));
    expect(defaultChatFor(ROOM, "Renamed", chats)).toBe(CHAT(1));
    expect(defaultChatFor(`tlrom_${hex(9)}`, "X", chats)).toBeNull();
  });

  it("sends a job to its chat's Progress tab, else its project", () => {
    expect(
      jobRedirect(JOB, { chatId: CHAT(1), roomId: ROOM }, { f: "2", d: "x", m: "12345" }),
    ).toBe(`/dashboard/chats/${CHAT(1)}?tab=progress&job=${JOB}&f=2`);
    expect(jobRedirect(JOB, { chatId: null, roomId: ROOM })).toBe(`/dashboard/projects/${ROOM}`);
    expect(jobRedirect(JOB, { chatId: null, roomId: null })).toBeNull();
    expect(keepLogPages({ f: ["3"], d: "1", m: "-1" })).toEqual({ f: "3", d: "1" });
  });

  it("sends 0.8 project tabs to the default chat", () => {
    expect(projectTabRedirect({ tab: "chat" }, CHAT(2))).toBe(`/dashboard/chats/${CHAT(2)}`);
    expect(projectTabRedirect({ tab: "progress", job: JOB }, CHAT(2))).toBe(
      `/dashboard/chats/${CHAT(2)}?tab=progress&job=${JOB}`,
    );
    expect(projectTabRedirect({ tab: "progress", job: "../../x" }, CHAT(2))).toBe(
      `/dashboard/chats/${CHAT(2)}?tab=progress`,
    );
    expect(projectTabRedirect({}, CHAT(2))).toBeNull();
    expect(projectTabRedirect({ tab: "evil" }, CHAT(2))).toBeNull();
    expect(projectTabRedirect({ tab: "chat" }, null)).toBeNull();
    expect(chatHref(CHAT(1), { tab: "chat" })).toBe(`/dashboard/chats/${CHAT(1)}`);
  });

  it("has the chat-first navigation", () => {
    expect(NAV.map((n) => n.label)).toEqual([
      "Home",
      "Chats",
      "Projects",
      "Agents",
      "Notifications",
      "Settings",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Agents page
// ---------------------------------------------------------------------------

describe("agents page model", () => {
  const profile = (
    over: Partial<OwnerProviderProfile> & Pick<OwnerProviderProfile, "provider">,
  ): OwnerProviderProfile => ({
    providerName: "",
    declaredPlan: "max_5x",
    usagePolicy: "balanced",
    paidUsageEnabled: false,
    detected: {
      installed: true,
      authenticated: true,
      version: null,
      plan: null,
      currentModel: null,
    },
    detectedAt: "2026-09-26T11:00:00Z",
    ...over,
  });

  it("never takes a status report as Ready; uses the probe's health", () => {
    expect(profileHealth(profile({ provider: "claude-code" })).health).toBe("unknown");
    expect(
      profileHealth(
        profile({
          provider: "claude-code",
          detected: {
            installed: true,
            authenticated: false,
            version: null,
            plan: null,
            currentModel: null,
          },
        }),
      ).health,
    ).toBe("needs_sign_in");
    const probed = profile({
      provider: "claude-code",
      detected: {
        installed: true,
        authenticated: true,
        version: null,
        plan: null,
        currentModel: null,
        health: "needs_sign_in",
        healthCheckedAt: "2026-09-26T11:50:00Z",
      } as never,
    });
    const { view } = deriveAgents([probed], NOW);
    const claude = view.agents.find((a) => a.name === "Claude Code")!;
    expect(claude.health.line).toBe("Claude Code — Needs sign-in");
    expect(claude.callout).toContain("run `claude`");
    expect(claude.checked).toBe("Checked 10 min ago by the ThreadLink app");
    expect(view.agents.find((a) => a.name === "Cursor")).toMatchObject({
      supported: false,
      capabilities: "Not supported yet",
    });
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("chat actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never retries without the dialog's confirmation", async () => {
    const r = await retryJobAction(form({ jobId: JOB, coordinator: "codex" }));
    expect(r.ok).toBe(false);
    expect(data.retryJobWithRoles).not.toHaveBeenCalled();
    const ok = await retryJobAction(form({ jobId: JOB, coordinator: "codex", confirmed: "retry" }));
    expect(ok.ok).toBe(true);
    expect(data.retryJobWithRoles).toHaveBeenCalledWith(JOB, "codex");
  });

  it("creates a chat and links to it", async () => {
    const r = await createChatAction(form({ name: "  New  ", roomId: "", mode: "solo" }));
    expect(data.createChat).toHaveBeenCalledWith({
      name: "New",
      roomId: null,
      groupId: null,
      mode: "solo",
    });
    expect(r).toMatchObject({ ok: true, href: `/dashboard/chats/tlcht_${"0".repeat(31)}9` });
  });

  it("sends only the fields a mode uses; empty picks mean Auto", async () => {
    await setChatModeAction(
      form({
        chatId: CHAT(1),
        mode: "pair",
        builderProvider: "codex",
        reviewerProvider: "",
        soloProvider: "claude-code",
      }),
    );
    expect(data.updateChat).toHaveBeenCalledWith(CHAT(1), {
      mode: "pair",
      builderProvider: "codex",
      reviewerProvider: null,
    });
    await setChatProjectAction(form({ chatId: CHAT(1), roomId: "" }));
    expect(data.updateChat).toHaveBeenLastCalledWith(CHAT(1), { roomId: null });
    const missing = await setChatProjectAction(form({ chatId: CHAT(1) }));
    expect(missing.ok).toBe(false);
  });

  it("links only to dashboard paths", () => {
    expect(safeHref("/dashboard/chats/x")).toBe("/dashboard/chats/x");
    expect(safeHref("https://evil.example")).toBeUndefined();
    expect(safeHref("//evil.example/dashboard")).toBeUndefined();
    expect(safeHref("/dashboard//evil")).toBeUndefined();
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rendering: names and messages are text, never HTML
// ---------------------------------------------------------------------------

describe("chat names and messages render as text", () => {
  const XSS = `<img src=x onerror=alert(1)>`;

  it("escapes a chat name and preview in the list", () => {
    const m = deriveChatList(
      [chat(1, { name: XSS, lastMessage: `<script>alert(1)</script>` })],
      [],
      [],
      parseChatListQuery({}),
      NOW,
    );
    const row = m.view.sections[0]!.rows[0]!;
    const html = renderToStaticMarkup(
      createElement(ChatListRow, {
        row,
        href: chatHref(CHAT(1)),
        chatId: CHAT(1),
        groupId: null,
        roomId: ROOM,
        projects: [],
        groups: [],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a chat name in the header and shows the sign-in callout", () => {
    const html = renderToStaticMarkup(
      createElement(ChatHeader, {
        header: chatHeader(chat(1, { name: XSS, participants: [you, CLAUDE_SIGNIN, CODEX_OK] })),
        projectHref: `/dashboard/projects/${ROOM}`,
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("Claude Code — Needs sign-in");
    expect(html).toContain("Open a terminal and run `claude`");
    expect(html).toContain("TEAM");
  });

  it("renders a provider-blocked line as a callout, as text", () => {
    const blocked: ChatEvent = {
      seq: 1,
      id: "e1",
      createdAt: "2026-09-26T11:00:00Z",
      roomId: ROOM,
      agentSessionId: "s",
      jobId: null,
      taskId: null,
      nodeId: null,
      authorKind: "threadlink",
      authorProvider: null,
      authorLabel: "ThreadLink",
      authorRole: null,
      audience: null,
      eventType: "provider_blocked" as never,
      messageType: null,
      round: null,
      modelRequested: null,
      modelObserved: null,
      body: "Claude Code needs you to sign in again on this computer. Codex is ready. <b>x</b>",
      visibility: "visible",
    };
    const html = renderToStaticMarkup(
      createElement(ChatView, {
        chatId: CHAT(1),
        initial: { events: [blocked], cursor: 1, activeJob: null },
        controller: "your controller",
        agentProviders: ["claude-code", "codex"],
        modeSummary: "Team · Claude Code + Codex",
        archived: false,
        hasProject: true,
        healthHint: healthCallout("claude-code", "needs_sign_in"),
      }),
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("Codex is ready. &lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Open a terminal and run `claude`");
  });
});
