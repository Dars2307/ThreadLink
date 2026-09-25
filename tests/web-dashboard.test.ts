import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Connection } from "@/lib/connections/model";
import {
  CHATGPT_PLAN_LABELS,
  detectedPlanLabel,
  effortLabel,
  modelDisplayName,
  teamLabel,
  verdictLabel,
} from "@/lib/dashboard/labels";
import {
  agentLines,
  cleanupCandidates,
  deriveCleanup,
  deriveConversations,
  deriveDevices,
  deriveHome,
  deriveNotifications,
  deriveProjects,
  deriveProviders,
  deriveTasks,
  deriveTeam,
  deriveTeamLog,
  EMPTY_TEAM,
  paginate,
  taskGraph,
  type AccountData,
  type JobDetail,
  type TeamData,
} from "@/lib/dashboard/pages";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerProviderProfile } from "@/lib/providers/queries";
import type { OwnerRoom } from "@/lib/rooms/queries";
import type { OwnerRuntime } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import type { RecentTask } from "@/lib/tasks/queries";
import type { OwnerJobSummary } from "@/lib/team/queries";

// ---------------------------------------------------------------------------
// Fixtures: every identifier is a real-looking ThreadLink id, so a leak shows.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-25T12:00:00Z");
const hex = (n: number) => n.toString(16).padStart(32, "0");
const id = (prefix: string, n: number) => `${prefix}_${hex(n)}`;

const USER = id("tlusr", 1);
const ROOM_PRISM = id("tlrom", 1);
const ROOM_OLD = id("tlrom", 2);
const ROOM_ARCHIVED = id("tlrom", 3);
const JOB_RUNNING = id("tljob", 1);
const JOB_PASSED = id("tljob", 2);
const JOB_DECIDE = id("tljob", 3);
const RUNTIME = id("tlrun", 1);
const RUNTIME_OLD = id("tlrun", 2);
const RUNTIME_REVOKED = id("tlrun", 3);
const WORKSPACE = id("tlwsp", 1);
const CHAT = id("tlses", 1);
const AGENT = id("tlses", 2);
const LINK = id("tllnk", 1);
const PENDING_LINK = id("tllnk", 2);

const conn = (
  n: number,
  platform: Connection["platform"],
  role: Connection["role"],
): Connection => ({
  id: id("tlcon", n),
  ownerUserId: USER,
  platform,
  role,
  status: "active",
  displayName: null,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
  lastSeenAt: "2026-09-25T11:59:00Z",
  revokedAt: null,
  credential: null,
});

const session = (
  sid: string,
  role: OwnerSession["role"],
  extra: Partial<OwnerSession> = {},
): OwnerSession => ({
  sessionId: sid,
  connectionId: id("tlcon", role === "agent" ? 2 : 1),
  platform: role === "agent" ? "claude-code" : "chatgpt",
  role,
  displayName: role === "agent" ? "Claude Code · Prism build" : "Prism planning",
  status: "active",
  createdAt: "2026-09-01T10:00:00Z",
  lastSeenAt: "2026-09-25T11:59:30Z",
  nativeSessionMode: "worker",
  nativeSessionId: "04158991-0630-4b8b-b461-58c86ee35453",
  workspacePath: "C:/Users/me/prism",
  nativeAttachedAt: null,
  runtimeId: role === "agent" ? RUNTIME : null,
  workspaceId: role === "agent" ? WORKSPACE : null,
  provider: role === "agent" ? "claude-code" : null,
  busy: false,
  ...extra,
});

const link = (lid: string, status: ThreadLinkView["status"]): ThreadLinkView => ({
  linkId: lid,
  controllerSessionId: CHAT,
  agentSessionId: AGENT,
  controllerDisplayName: "Prism planning",
  agentDisplayName: "Claude Code · Prism build",
  status,
  paused: false,
  revokedReason: null,
  requestedAt: "2026-09-25T11:00:00Z",
  approvedAt: status === "active" ? "2026-09-25T11:01:00Z" : null,
  revokedAt: null,
});

const runtime = (over: Partial<OwnerRuntime>): OwnerRuntime => ({
  runtimeId: RUNTIME,
  label: "Joel's Laptop",
  platform: "windows",
  kind: "desktop",
  version: "0.7.0",
  capabilities: { "claude-code": "available", "claude-resume": "available" },
  settings: { autoStart: true },
  paused: false,
  status: "active",
  lastSeenAt: "2026-09-25T11:59:40Z",
  createdAt: "2026-08-01T09:00:00Z",
  ...over,
});

const task = (n: number, over: Partial<RecentTask> = {}): RecentTask => ({
  taskId: id("tltask", n),
  originSessionId: CHAT,
  targetSessionId: AGENT,
  status: "working",
  priority: "B",
  title: "Build client reports",
  createdAt: "2026-09-25T11:30:00Z",
  finishedAt: null,
  failureReason: null,
  ...over,
});

const account: AccountData = {
  connections: [conn(1, "chatgpt", "controller"), conn(2, "claude-code", "agent")],
  sessions: [session(CHAT, "controller"), session(AGENT, "agent")],
  links: [link(LINK, "active"), link(PENDING_LINK, "pending")],
  tasks: [
    task(1),
    task(2, {
      status: "failed",
      failureReason: "lease_exhausted",
      title: "Old run",
      finishedAt: "2026-09-25T10:00:00Z",
    }),
    task(3, { status: "completed", title: "Fix login", finishedAt: "2026-09-25T09:00:00Z" }),
  ],
  runtimes: [
    runtime({}),
    runtime({ runtimeId: RUNTIME_OLD, label: "Old desktop", lastSeenAt: "2026-09-06T12:00:00Z" }),
    runtime({
      runtimeId: RUNTIME_REVOKED,
      label: "Retired VM",
      status: "revoked",
      lastSeenAt: "2026-07-01T00:00:00Z",
    }),
  ],
  workspaces: [
    {
      workspaceId: WORKSPACE,
      runtimeId: RUNTIME,
      name: "prism",
      path: "C:/Users/me/prism",
      repoRemote: "github.com/me/prism",
      branch: "main",
    },
  ],
  now: NOW,
};

const room = (roomId: string, name: string, over: Partial<OwnerRoom> = {}): OwnerRoom => ({
  roomId,
  name,
  status: "active",
  statusLabel: "Active",
  workspaceName: "prism",
  agentName: "Claude Code · Prism build",
  usagePolicy: "balanced",
  budgets: { parallelAgents: 2, maxPlanningRounds: 2, maxReviewRounds: 3 },
  jobs: { total: 0, open: 0, passed: 0, needsAttention: 0 },
  lastJob: null,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-25T11:00:00Z",
  ...over,
});

const summary = (jobId: string, over: Partial<OwnerJobSummary>): OwnerJobSummary => ({
  jobId,
  goal: "Build client reports",
  status: "building",
  statusLabel: "Building",
  line: "Building client reports",
  verdict: null,
  finished: false,
  planning: "Round 1 of 2",
  review: "Round 2 of 3",
  startedAt: "2026-09-25T11:00:00Z",
  finishedAt: null,
  ...over,
});

const runningDetail: JobDetail = {
  ...summary(JOB_RUNNING, {}),
  summary: null,
  nodes: [
    {
      key: "ui",
      title: "UI",
      owner: "Codex",
      reviewer: "Claude",
      status: "running",
      statusLabel: "In progress",
      mixedAuthorship: false,
      dependsOn: [],
    },
    {
      key: "backend",
      title: "Backend",
      owner: "Claude",
      reviewer: "Codex",
      status: "approved",
      statusLabel: "Approved",
      mixedAuthorship: false,
      dependsOn: [],
    },
    {
      key: "api",
      title: "API contract",
      owner: "Claude",
      reviewer: "Codex",
      status: "in_review",
      statusLabel: "In review",
      mixedAuthorship: false,
      dependsOn: ["backend"],
    },
  ],
  findings: {
    open: { blocking: 1, important: 0, nonBlocking: 2 },
    recent: [
      {
        title: "Missing auth check on export",
        severity: "blocking",
        category: "security",
        status: "open",
        raisedBy: "Codex",
      },
      {
        title: "Rename helper",
        severity: "non_blocking",
        category: "architecture",
        status: "resolved",
        raisedBy: "Claude",
      },
    ],
  },
  decisions: [
    {
      label: "TL-00042",
      title: "Keep CSV export",
      resolution: "Keep CSV; add XLSX later",
      needsYou: false,
    },
  ],
  modelRuns: [
    {
      provider: "Claude",
      role: "builder",
      requested: "claude-sonnet-5",
      observed: "claude-sonnet-5",
      matched: true,
      modelClass: "BALANCED",
      reason: "Medium-complexity implementation with no special risk",
      outcome: "ok",
      at: "2026-09-25T11:10:00Z",
      effort: "medium",
    },
    {
      provider: "Codex",
      role: "reviewer",
      requested: "gpt-5.5-codex",
      observed: "gpt-5.5-codex",
      matched: true,
      modelClass: "STRONG",
      reason: "Security-sensitive review",
      outcome: "ok",
      at: "2026-09-25T11:20:00Z",
      effort: "high",
    },
  ],
};

const decideDetail: JobDetail = {
  ...summary(JOB_DECIDE, {
    status: "needs_user_decision",
    verdict: "NEEDS_USER_DECISION",
    finished: true,
    finishedAt: "2026-09-25T11:40:00Z",
    goal: "Switch billing provider",
  }),
  summary: "Needs a product decision",
  nodes: [],
  findings: { open: { blocking: 0, important: 0, nonBlocking: 0 }, recent: [] },
  decisions: [
    { label: "TL-00043", title: "Which billing provider", resolution: null, needsYou: true },
  ],
  modelRuns: [],
};

const team: TeamData = {
  rooms: [
    room(ROOM_PRISM, "Prism", { jobs: { total: 3, open: 1, passed: 1, needsAttention: 1 } }),
    room(ROOM_OLD, "Old site", {
      workspaceName: "old-site",
      agentName: null,
      updatedAt: "2026-07-01T00:00:00Z",
    }),
    room(ROOM_ARCHIVED, "Legacy", { status: "archived", statusLabel: "Archived" }),
  ],
  jobsByRoom: {
    [ROOM_PRISM]: [
      summary(JOB_RUNNING, {}),
      summary(JOB_DECIDE, {
        status: "needs_user_decision",
        verdict: "NEEDS_USER_DECISION",
        finished: true,
        finishedAt: "2026-09-25T11:40:00Z",
        goal: "Switch billing provider",
      }),
      summary(JOB_PASSED, {
        status: "completed",
        verdict: "PASS",
        finished: true,
        finishedAt: "2026-09-24T12:00:00Z",
        goal: "Fix login",
        line: null,
      }),
    ],
  },
  details: [runningDetail, decideDetail],
  profiles: [],
};

const profile = (
  over: Partial<OwnerProviderProfile> & Pick<OwnerProviderProfile, "provider">,
): OwnerProviderProfile => ({
  providerName: over.provider === "codex" ? "Codex" : "Claude Code",
  declaredPlan: "unknown",
  usagePolicy: "balanced",
  paidUsageEnabled: false,
  detected: { installed: null, authenticated: null, version: null, plan: null, currentModel: null },
  detectedAt: null,
  ...over,
});

const ID = /\btl[a-z]{2,5}_[0-9a-f]/;

// ---------------------------------------------------------------------------

describe("no raw identifiers in any normal page model", () => {
  const models = {
    home: deriveHome(account, team),
    notifications: deriveNotifications(account, team),
    projects: deriveProjects(team, NOW, { showArchived: true }),
    team: deriveTeam(team, NOW),
    log: deriveTeamLog(runningDetail, "Prism", NOW),
    tasks: deriveTasks(account, team),
    conversations: deriveConversations(account, team),
    devices: deriveDevices(account, { showDisconnected: true }),
    providers: deriveProviders([profile({ provider: "claude-code" })], NOW),
    cleanup: deriveCleanup(account, team),
  };

  it.each(Object.entries(models))("%s view has no tl*_ id, native id or path", (_name, model) => {
    const json = JSON.stringify(model.view);
    expect(json).not.toMatch(ID);
    expect(json).not.toContain("04158991");
    expect(json).not.toContain("C:/Users");
  });

  it("keeps the identifiers actions need in handles, keyed by opaque keys", () => {
    const { view, handles } = models.projects;
    const prism = view.projects.find((p) => p.name === "Prism")!;
    expect(prism.key).not.toMatch(ID);
    expect(handles[prism.key]).toEqual({ roomId: ROOM_PRISM });
    const conv = models.conversations;
    const card = conv.view.conversations[0]!;
    expect(conv.handles[card.key]).toEqual({ sessionId: AGENT });
    expect(conv.handles[card.chats[0]!.key]).toEqual({ linkId: LINK, controllerSessionId: CHAT });
  });
});

describe("Home", () => {
  it("counts projects, agents online, tasks running and reviews pending", () => {
    const { view } = deriveHome(account, team);
    expect(Object.fromEntries(view.counts.map((c) => [c.key, c.value]))).toEqual({
      projects: 2,
      agents: 1,
      tasks: 1,
      reviews: 1,
    });
  });

  it("shows each active project with its team and one status line", () => {
    const { view } = deriveHome(account, team);
    expect(view.active[0]).toMatchObject({
      name: "Prism",
      team: "Claude + Codex",
      status: "Building client reports",
      summary: "1 task running · 1 review pending · needs your decision",
    });
    expect(view.active.find((p) => p.name === "Old site")).toMatchObject({
      team: "Claude + Codex",
      status: "Ready",
    });
    expect(view.active.some((p) => p.name === "Legacy")).toBe(false);
  });

  it("lists what needs the user's decision", () => {
    const titles = deriveHome(account, team).view.needsYou.map((i) => i.title);
    expect(titles).toContain("Prism needs your decision");
    expect(titles).toContain("A link is waiting for your approval");
    expect(
      deriveHome(account, team).view.needsYou.find((i) => i.title.startsWith("Prism needs"))!
        .detail,
    ).toBe("TL-00043 · Which billing provider");
  });

  it("counts Codex as online when the device reports it signed in", () => {
    const withCodex = {
      ...team,
      profiles: [
        profile({
          provider: "codex",
          detected: {
            installed: true,
            authenticated: true,
            version: "0.155",
            plan: "plus",
            currentModel: null,
          },
          detectedAt: "2026-09-25T11:00:00Z",
        }),
      ],
    };
    expect(deriveHome(account, withCodex).view.counts.find((c) => c.key === "agents")!.value).toBe(
      2,
    );
  });
});

describe("Projects", () => {
  it("hides archived projects by default and says how many there are", () => {
    const { view } = deriveProjects(team, NOW);
    expect(view.projects.map((p) => p.name)).toEqual(["Prism", "Old site"]);
    expect(view.archivedCount).toBe(1);
    expect(view.showingArchived).toBe(false);
  });

  it("shows archived projects last when asked", () => {
    const { view } = deriveProjects(team, NOW, { showArchived: true });
    expect(view.projects.map((p) => [p.name, p.archived])).toEqual([
      ["Prism", false],
      ["Old site", false],
      ["Legacy", true],
    ]);
  });

  it("never lists deleted projects", () => {
    const withDeleted = {
      ...team,
      rooms: [...team.rooms, room(id("tlrom", 9), "Gone", { status: "deleted" })],
    };
    const names = deriveProjects(withDeleted, NOW, { showArchived: true }).view.projects.map(
      (p) => p.name,
    );
    expect(names).not.toContain("Gone");
  });

  it("describes the bounded team policy in words", () => {
    const prism = deriveProjects(team, NOW).view.projects[0]!;
    expect(prism.policy.text).toBe(
      "Up to 2 agents at once · 2 planning rounds · 3 review rounds · Balanced",
    );
    expect(prism.recentJobs.map((j) => j.status)).toEqual([
      "Building",
      "Needs your decision",
      "Passed final review",
    ]);
  });
});

describe("Team", () => {
  it("names each agent's role, provider, model display name and effort", () => {
    const lines = agentLines(runningDetail).map((a) => a.line);
    expect(lines).toEqual([
      "Reviewer · Codex · GPT-5.5 Codex · High effort",
      "Builder · Claude Code · Claude Sonnet 5 · Medium effort",
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/claude-sonnet-5|gpt-5\.5-codex/);
  });

  it("says what each agent is doing", () => {
    const byProvider = Object.fromEntries(
      agentLines(runningDetail).map((a) => [a.provider, a.doing]),
    );
    expect(byProvider).toEqual({
      Codex: "Building UI · Reviewing API contract",
      "Claude Code": "Waiting for review of API contract",
    });
  });

  it("flags a model mismatch in plain words", () => {
    const mismatch: JobDetail = {
      ...runningDetail,
      modelRuns: [
        {
          ...runningDetail.modelRuns[0]!,
          requested: "claude-haiku-4-5-20251001",
          observed: "claude-sonnet-5",
          matched: false,
        },
      ],
    };
    expect(agentLines(mismatch)[0]!.mismatch).toBe(
      "Asked for Claude Haiku 4.5, but Claude Sonnet 5 ran. ThreadLink stopped this run.",
    );
  });

  it("draws the plan as a tree with ✓ ● ○ and no graph words", () => {
    expect(taskGraph(runningDetail).map((l) => l.text)).toEqual([
      "✓ Plan",
      "├─ ● UI — Codex, reviewed by Claude Code",
      "├─ ✓ Backend — Claude Code, reviewed by Codex",
      "├─ ● API contract — Claude Code, reviewed by Codex",
      "└─ ○ Integration → Final review",
    ]);
    // A step always comes after the steps it depends on.
    const reordered = taskGraph({ ...runningDetail, nodes: [...runningDetail.nodes].reverse() });
    expect(reordered.map((l) => l.label).slice(1, 4)).toEqual(["Backend", "API contract", "UI"]);
    const done = taskGraph({ ...runningDetail, status: "completed", verdict: "PASS", nodes: [] });
    expect(done.map((l) => l.text)).toEqual(["✓ Plan", "└─ ✓ Integration → Final review"]);
    const planning = taskGraph({ status: "planning", verdict: null, nodes: [] });
    expect(planning[0]!.text).toBe("● Plan");
    expect(JSON.stringify(taskGraph(runningDetail))).not.toMatch(/\b(DAG|node|edge|graph)\b/i);
  });

  it("puts verdicts in plain words", () => {
    expect(verdictLabel("PASS")).toBe("Passed final review");
    expect(verdictLabel("NEEDS_FIX")).toBe("Needs fixes");
    expect(verdictLabel("BLOCKED")).toBe("Blocked");
    expect(verdictLabel("NEEDS_USER_DECISION")).toBe("Needs your decision");
    const { view } = deriveTeam(team, NOW);
    expect(view.recent.map((j) => [j.goal, j.status])).toEqual([
      ["Switch billing provider", "Needs your decision"],
      ["Fix login", "Passed final review"],
    ]);
  });

  it("shows rounds and findings remaining for a running job", () => {
    const job = deriveTeam(team, NOW).view.active[0]!;
    expect(job).toMatchObject({
      project: "Prism",
      planning: "Planning: round 1 of 2",
      review: "Review: round 2 of 3",
      findings: "3 findings remaining (1 blocking, 2 non-blocking)",
      findingsRemaining: 3,
    });
  });
});

describe("Full team log", () => {
  it("labels findings, numbers decisions and explains model choices", () => {
    const { view } = deriveTeamLog(runningDetail, "Prism", NOW);
    expect(view.findings.items.map((f) => [f.severity, f.status])).toEqual([
      ["BLOCKING", "Open"],
      ["NON-BLOCKING", "Resolved"],
    ]);
    expect(view.decisions.items[0]).toMatchObject({
      number: "TL-00042",
      topic: "Keep CSV export",
      resolution: "Keep CSV; add XLSX later",
      needsYou: false,
    });
    expect(view.models.items[0]!.selected).toBe(
      "Selected: Claude Sonnet 5 — Medium-complexity implementation with no special risk",
    );
    expect(view.models.items[0]!.who).toBe("Builder · Claude Code");
    expect(view.models.items[0]!.effort).toBe("Medium effort");
  });

  it("is bounded and paginated", () => {
    const many = Array.from({ length: 45 }, (_, i) => i);
    expect(paginate(many, 1)).toMatchObject({ page: 1, pageCount: 3, total: 45 });
    expect(paginate(many, 3).items).toHaveLength(5);
    expect(paginate(many, 99).page).toBe(3);
    expect(paginate(many, -4).page).toBe(1);
    expect(paginate([], 1)).toMatchObject({ page: 1, pageCount: 1, items: [] });
  });
});

describe("model display names", () => {
  it("uses display names and never the raw id when a name is known", () => {
    expect(modelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelDisplayName("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet");
    expect(modelDisplayName("gpt-5.5-codex")).toBe("GPT-5.5 Codex");
    expect(modelDisplayName("gpt-5-codex-mini")).toBe("GPT-5 Codex Mini");
    expect(modelDisplayName("x-model", { "x-model": "Catalogue Name" })).toBe("Catalogue Name");
    expect(modelDisplayName(null)).toBe("Model not reported yet");
    expect(effortLabel("xhigh")).toBe("Extra-high effort");
    expect(effortLabel(null)).toBeNull();
    expect(teamLabel(["codex", "Claude"])).toBe("Claude + Codex");
  });
});

describe("Tasks and Conversations", () => {
  it("reuses the plain task statuses", () => {
    const { view } = deriveTasks(account, team);
    expect(view.tasks.map((t) => t.status)).toEqual([
      "In progress",
      "Runtime stopped responding",
      "Completed",
    ]);
    expect(view.running).toBe(1);
    expect(view.teamJobs[0]).toMatchObject({ project: "Prism", status: "Building" });
  });

  it("shows linked conversations with mode, project and status", () => {
    const { view } = deriveConversations(account, team);
    expect(view.conversations[0]).toMatchObject({
      name: "Prism build",
      mode: "Background worker",
      folder: "prism",
      device: "Joel's Laptop",
      projects: ["Prism", "Legacy"],
      status: "Linked · Ready",
    });
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]!.text).toBe("Prism planning → Prism build");
  });
});

describe("Devices", () => {
  it("hides disconnected devices by default", () => {
    const { view } = deriveDevices(account);
    expect(view.devices.map((d) => d.name)).toEqual(["Joel's Laptop", "Old desktop"]);
    expect(view.disconnected).toEqual([]);
    expect(view.disconnectedCount).toBe(1);
  });

  it("shows them only when asked, and never offers a hard delete", () => {
    const { view } = deriveDevices(account, { showDisconnected: true });
    expect(view.disconnected.map((d) => [d.name, d.statusLabel])).toEqual([
      ["Retired VM", "Disconnected"],
    ]);
  });

  it("says online / last seen in plain words", () => {
    const { view } = deriveDevices(account);
    expect(view.devices.map((d) => [d.statusLabel, d.lastSeen])).toEqual([
      ["Online", "Last seen just now"],
      ["Offline", "Last seen 19 days ago"],
    ]);
  });
});

describe("Providers & plans", () => {
  const claude = profile({
    provider: "claude-code",
    declaredPlan: "max_5x",
    detected: {
      installed: true,
      authenticated: true,
      version: "2.1.266",
      plan: "max",
      currentModel: "claude-sonnet-5",
    },
    detectedAt: "2026-09-25T11:58:00Z",
  });
  const codex = profile({
    provider: "codex",
    declaredPlan: "business_standard",
    detected: {
      installed: true,
      authenticated: true,
      version: "0.155",
      plan: "team",
      currentModel: "gpt-5.5-codex",
    },
    detectedAt: "2026-09-25T11:58:00Z",
  });

  it("shows the declared plan next to what the device detected", () => {
    const [c, x] = deriveProviders([claude, codex], NOW).view.providers;
    expect(c!.declared.label).toBe("Max 5x");
    expect(Object.fromEntries(c!.detected.rows.map((r) => [r.label, r.value]))).toMatchObject({
      "Claude Code installed": "Yes",
      "Signed in": "Yes",
      "Reported plan": "Max",
      "Current model": "Claude Sonnet 5",
    });
    expect(c!.note).toMatch(/detects is what counts/);
    expect(x!.title).toBe("ChatGPT / Codex");
    expect(x!.declared.label).toBe("Business Standard");
  });

  it("never labels ChatGPT Business as Team", () => {
    const x = deriveProviders([codex], NOW).view.providers[1]!;
    expect(JSON.stringify(x)).not.toMatch(/\bTeam\b/);
    expect(detectedPlanLabel("codex", "team")).toBe("Business");
    expect(Object.values(CHATGPT_PLAN_LABELS)).not.toContain("Team");
    expect(x.declared.options.map((o) => o.label)).toEqual([
      "Free",
      "Go",
      "Plus",
      "Pro",
      "Business Standard",
      "Business Premium",
      "Enterprise",
      "Edu",
      "Other / Unknown",
    ]);
  });

  it("never shows a usage number or percentage", () => {
    const { view } = deriveProviders([claude, codex], NOW);
    expect(view.providers.map((p) => p.remaining)).toEqual([
      "Not reported by Claude",
      "Not reported by ChatGPT",
    ]);
    for (const p of view.providers) expect(p.remaining).not.toMatch(/\d|%/);
  });

  it("keeps paid usage off by default", () => {
    const { view } = deriveProviders([], NOW);
    expect(view.providers.map((p) => p.paidUsage)).toEqual([
      { enabled: false, label: "Off" },
      { enabled: false, label: "Off" },
    ]);
    expect(view.teamModeNote).toMatch(/only runs on the usage your subscriptions already include/);
  });

  it("warns that Claude Code is not on the Free plan unless detection shows it working", () => {
    const free = profile({ provider: "claude-code", declaredPlan: "free" });
    expect(deriveProviders([free], NOW).view.providers[0]!.planWarning).toBe(
      "Claude Code is not included on the Free plan.",
    );
    const working = { ...free, detected: { ...claude.detected }, detectedAt: claude.detectedAt };
    expect(deriveProviders([working], NOW).view.providers[0]!.planWarning).toBeNull();
  });

  it("offers the four usage policies with one-line explanations", () => {
    const c = deriveProviders([], NOW).view.providers[0]!;
    expect(c.usagePolicy.options.map((o) => o.label)).toEqual([
      "Conservative",
      "Balanced",
      "Maximum quality",
      "Manual",
    ]);
    for (const o of c.usagePolicy.options) expect(o.description.length).toBeGreaterThan(10);
  });
});

describe("Cleanup", () => {
  it("finds inactive projects and long-offline devices only", () => {
    const c = cleanupCandidates(account, team);
    expect(c.inactiveProjects.map((r) => r.name)).toEqual(["Old site"]);
    expect(c.offlineDevices.map((r) => r.label)).toEqual(["Old desktop"]);
    expect(cleanupCandidates(account, EMPTY_TEAM).inactiveProjects).toEqual([]);
  });

  it("never proposes deleting code", () => {
    const { view } = deriveCleanup(account, team);
    expect(view.projects.text).toMatch(/keeps their history/);
    expect(JSON.stringify(view)).not.toMatch(/delete/i);
  });
});
