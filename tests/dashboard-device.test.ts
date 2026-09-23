import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Connection } from "@/lib/connections/model";
import { deriveDashboard, relativeTime, taskStatus } from "@/lib/dashboard/view-model";
import { formatUserCode, newUserCode, normalizeUserCode } from "@/lib/device/server";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerRuntime, OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const conn = (platform: Connection["platform"], role: Connection["role"]): Connection => ({
  id: `tlcon_${platform
    .padEnd(32, "0")
    .replace(/[^0-9a-f]/g, "a")
    .slice(0, 32)}`,
  ownerUserId: "tlusr_00000000000000000000000000000000",
  platform,
  role,
  status: "active",
  displayName: null,
  createdAt: "2026-09-22T10:00:00Z",
  updatedAt: "2026-09-22T10:00:00Z",
  lastSeenAt: "2026-09-22T11:59:00Z",
  revokedAt: null,
  credential: null,
});
const session = (
  id: string,
  role: OwnerSession["role"],
  extra: Partial<OwnerSession> = {},
): OwnerSession => ({
  sessionId: id,
  connectionId: "tlcon_00000000000000000000000000000000",
  platform: role === "agent" ? "claude-code" : "chatgpt",
  role,
  displayName: role === "agent" ? "Claude Code · ThreadLink" : "Planning chat",
  status: "active",
  createdAt: "2026-09-22T10:00:00Z",
  lastSeenAt: "2026-09-22T11:59:30Z",
  nativeSessionMode: "fresh",
  nativeSessionId: null,
  workspacePath: null,
  nativeAttachedAt: null,
  runtimeId: null,
  workspaceId: null,
  provider: role === "agent" ? "claude-code" : null,
  busy: false,
  ...extra,
});
const link = (status: ThreadLinkView["status"]): ThreadLinkView => ({
  linkId: "tllnk_00000000000000000000000000000000",
  controllerSessionId: "tlses_c",
  agentSessionId: "tlses_g",
  controllerDisplayName: null,
  agentDisplayName: null,
  status,
  paused: false,
  revokedReason: null,
  requestedAt: "2026-09-22T10:00:00Z",
  approvedAt: null,
  revokedAt: null,
});

const runtime = (over: Partial<OwnerRuntime> = {}): OwnerRuntime => ({
  runtimeId: "tlrun_00000000000000000000000000000001",
  label: "Joel's Laptop",
  platform: "windows",
  kind: "desktop",
  version: "0.6.6",
  capabilities: { "claude-code": "available" },
  settings: { autoStart: true, autoReconnect: true, notifications: true },
  paused: false,
  status: "active",
  lastSeenAt: "2026-09-22T11:59:40Z",
  createdAt: "2026-09-22T09:00:00Z",
  ...over,
});

const workspace = (over: Partial<OwnerWorkspace> = {}): OwnerWorkspace => ({
  workspaceId: "tlwsp_00000000000000000000000000000001",
  runtimeId: "tlrun_00000000000000000000000000000001",
  name: "ThreadLink",
  path: "C:/Users/me/ThreadLink",
  repoRemote: "github.com/dars2307/threadlink",
  branch: "main",
  ...over,
});

describe("dashboard view model", () => {
  it("guides a new user through setup", () => {
    const view = deriveDashboard({ connections: [], sessions: [], links: [], tasks: [], now: NOW });
    expect(view.setupComplete).toBe(false);
    expect(view.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(view.headline.text).toBe("Finish setting up ThreadLink");
    expect(view.apps.map((a) => [a.label, a.connected])).toEqual([
      ["ChatGPT", false],
      ["ThreadLink app (Runtime)", false],
    ]);
  });

  it("shows a ready link with its Claude conversation, workspace and Runtime", () => {
    const view = deriveDashboard({
      connections: [conn("chatgpt", "controller"), conn("claude-code", "agent")],
      sessions: [
        session("tlses_c", "controller", { displayName: "Phase 6.6 planning" }),
        session("tlses_g", "agent", {
          displayName: "Dashboard redesign",
          nativeSessionMode: "resume",
          nativeSessionId: "04158991-0630-4b8b-b461-58c86ee35453",
          runtimeId: "tlrun_00000000000000000000000000000001",
          workspaceId: "tlwsp_00000000000000000000000000000001",
        }),
      ],
      links: [link("active")],
      tasks: [],
      runtimes: [runtime()],
      workspaces: [workspace()],
      now: NOW,
    });
    expect(view.steps.every((s) => s.state === "done")).toBe(true);
    expect(view.headline.text).toBe("Everything is connected");
    expect(view.links[0]).toMatchObject({
      chat: "Phase 6.6 planning",
      conversation: "Dashboard redesign",
      conversationDetail: "Resumes this exact conversation, which must not be open",
      modeLabel: "Exact conversation",
      mode: "resume",
      workspace: "ThreadLink",
      runtime: "Joel's Laptop",
      status: "ready",
      statusLabel: "Ready",
    });
    const { linkId, controllerSessionId, agentSessionId, ...card } = view.links[0]!;
    expect(JSON.stringify(card)).not.toMatch(/tlses_|tlcon_|tllnk_|tlrun_|04158991|C:/);
    expect(linkId + controllerSessionId + agentSessionId).toContain("tllnk_");
  });

  it("keeps a background-worker link Ready while the user's Claude is open", () => {
    // The bug this pins: a worker link showed "Claude conversation in use" and
    // told the user to close Claude, even though the worker runs alongside it.
    const view = deriveDashboard({
      connections: [conn("chatgpt", "controller"), conn("claude-code", "agent")],
      sessions: [
        session("tlses_c", "controller"),
        session("tlses_g", "agent", {
          busy: true,
          nativeSessionMode: "worker",
          runtimeId: "tlrun_00000000000000000000000000000001",
        }),
      ],
      links: [link("active")],
      tasks: [],
      runtimes: [runtime()],
      workspaces: [workspace()],
      now: NOW,
    });
    expect(view.links[0]).toMatchObject({
      mode: "worker",
      modeLabel: "Background worker",
      conversationDetail: "Works while Claude Code is open",
      status: "ready",
      statusLabel: "Ready",
      busy: false,
    });
    expect(view.headline.text).toBe("Everything is connected");
    expect(JSON.stringify(view.links[0])).not.toMatch(/in use|close Claude/i);
  });

  it("reports a busy Claude conversation and an offline Runtime", () => {
    const base = {
      connections: [conn("chatgpt", "controller"), conn("claude-code", "agent")],
      sessions: [
        session("tlses_c", "controller"),
        session("tlses_g", "agent", {
          busy: true,
          nativeSessionMode: "resume",
          runtimeId: "tlrun_00000000000000000000000000000001",
        }),
      ],
      links: [link("active")],
      tasks: [],
      workspaces: [workspace()],
      now: NOW,
    };
    expect(deriveDashboard({ ...base, runtimes: [runtime()] }).links[0]).toMatchObject({
      status: "busy",
      statusLabel: "Claude is currently open",
    });
    const offline = deriveDashboard({
      ...base,
      runtimes: [runtime({ lastSeenAt: "2026-09-22T09:00:00Z" })],
    });
    expect(offline.links[0]!.status).toBe("offline");
    expect(offline.headline.text).toBe("Connected, but no Runtime is online");
    const paused = deriveDashboard({ ...base, runtimes: [runtime({ paused: true })] });
    expect(paused.links[0]!.status).toBe("paused");
  });

  it("groups conversations by Runtime and workspace, with several per workspace", () => {
    const view = deriveDashboard({
      connections: [conn("claude-code", "agent")],
      sessions: [
        session("tlses_g1", "agent", {
          displayName: "Dashboard redesign",
          nativeSessionMode: "resume",
          runtimeId: "tlrun_00000000000000000000000000000001",
          workspaceId: "tlwsp_00000000000000000000000000000001",
        }),
        session("tlses_g2", "agent", {
          displayName: "Security review",
          nativeSessionMode: "resume",
          runtimeId: "tlrun_00000000000000000000000000000001",
          workspaceId: "tlwsp_00000000000000000000000000000001",
        }),
      ],
      links: [],
      tasks: [],
      runtimes: [runtime()],
      workspaces: [workspace()],
      now: NOW,
    });
    expect(view.runtimeTree).toHaveLength(1);
    expect(view.runtimeTree[0]!.workspaces[0]!.conversations.map((c) => c.name)).toEqual([
      "Dashboard redesign",
      "Security review",
    ]);
    expect(view.runtimeTree[0]!.online).toBe(true);
    expect(view.runtimeTree[0]!.claudeAvailable).toBe(true);
  });

  it("labels Claude desktop connections correctly (not as ChatGPT)", () => {
    const view = deriveDashboard({
      connections: [conn("claude-desktop", "controller")],
      sessions: [],
      links: [],
      tasks: [],
      now: NOW,
    });
    expect(view.apps.map((a) => a.label)).toContain("Claude");
    expect(view.apps.find((a) => a.label === "ChatGPT")?.connected).toBe(false);
  });

  it("explains failures in plain words", () => {
    expect(taskStatus("failed", "session_busy").statusLabel).toBe("Claude conversation was in use");
    expect(taskStatus("failed", "lease_exhausted").statusLabel).toBe("Runtime stopped responding");
    expect(taskStatus("completed", null)).toEqual({ statusLabel: "Completed", tone: "success" });
    expect(relativeTime("2026-09-22T11:30:00Z", NOW)).toBe("30 min ago");
    expect(relativeTime(null, NOW)).toBe("never");
  });
});
describe("device sign-in codes", () => {
  it("are 8 unambiguous consonants, shown as XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("normalises user input and rejects anything else", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDFGHJK");
    expect(normalizeUserCode("AEIO-UUUU")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode(null)).toBeNull();
    expect(normalizeUserCode("'; drop table")).toBeNull();
  });
});
