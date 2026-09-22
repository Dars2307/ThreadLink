import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Connection } from "@/lib/connections/model";
import { deriveDashboard, relativeTime, taskStatus } from "@/lib/dashboard/view-model";
import { formatUserCode, newUserCode, normalizeUserCode } from "@/lib/device/server";
import type { ThreadLinkView } from "@/lib/pairing/model";
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
  ...extra,
});
const link = (status: ThreadLinkView["status"]): ThreadLinkView => ({
  linkId: "tllnk_00000000000000000000000000000000",
  controllerSessionId: "tlses_c",
  agentSessionId: "tlses_g",
  controllerDisplayName: null,
  agentDisplayName: null,
  status,
  revokedReason: null,
  requestedAt: "2026-09-22T10:00:00Z",
  approvedAt: null,
  revokedAt: null,
});

describe("dashboard view model", () => {
  it("guides a new user through setup", () => {
    const view = deriveDashboard({ connections: [], sessions: [], links: [], tasks: [], now: NOW });
    expect(view.setupComplete).toBe(false);
    expect(view.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(view.headline.text).toBe("Finish setting up ThreadLink");
    expect(view.apps.map((a) => [a.label, a.connected])).toEqual([
      ["ChatGPT", false],
      ["Claude Code", false],
    ]);
  });

  it("shows 'Everything is connected' with an attached session and a live bridge", () => {
    const view = deriveDashboard({
      connections: [conn("chatgpt", "controller"), conn("claude-code", "agent")],
      sessions: [
        session("tlses_c", "controller"),
        session("tlses_g", "agent", {
          nativeSessionMode: "resume",
          nativeSessionId: "04158991-0630-4b8b-b461-58c86ee35453",
          workspacePath: "C:\\Users\\me\\ThreadLink",
        }),
      ],
      links: [link("active")],
      tasks: [],
      now: NOW,
    });
    expect(view.steps.every((s) => s.state === "done")).toBe(true);
    expect(view.headline.text).toBe("Everything is connected");
    expect(view.links[0]).toMatchObject({
      controllerLabel: "Planning chat",
      agentLabel: "ThreadLink",
      workspace: "ThreadLink",
      ready: true,
      agentDetail: "Continues your existing Claude Code session",
    });
    // No raw IDs in the primary card data except the React key.
    const { linkId, ...card } = view.links[0];
    expect(linkId).toMatch(/^tllnk_/);
    expect(JSON.stringify(card)).not.toMatch(/tlses_|tlcon_|tllnk_|04158991/);
  });

  it("flags an offline bridge and a pending link", () => {
    const view = deriveDashboard({
      connections: [conn("chatgpt", "controller"), conn("claude-code", "agent")],
      sessions: [
        session("tlses_c", "controller"),
        session("tlses_g", "agent", { lastSeenAt: "2026-09-22T09:00:00Z" }),
      ],
      links: [link("pending")],
      tasks: [],
      now: NOW,
    });
    expect(view.steps.find((s) => s.key === "link")?.state).toBe("waiting");
    expect(view.apps.find((a) => a.platform === "claude-code")?.detail).toMatch(/Bridge offline/);
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
    expect(taskStatus("failed", "session_busy").statusLabel).toBe(
      "Claude session was open elsewhere",
    );
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
