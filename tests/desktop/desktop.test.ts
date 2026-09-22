import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAutoStart,
  linuxAutostartContents,
  linuxAutostartFile,
} from "../../desktop/src/autostart.ts";
import {
  notificationFor,
  statusLine,
  trayIconPixels,
  trayMenu,
  type AppState,
} from "../../desktop/src/model.ts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../desktop/src/settings.ts";

const snapshot = (over: Record<string, unknown> = {}) =>
  ({
    status: "online",
    detail: null,
    identity: { label: "Joel's Laptop", platform: "windows", kind: "desktop" },
    runtime: {
      runtimeId: "tlrun_1",
      label: "Joel's Laptop",
      platform: "windows",
      kind: "desktop",
      paused: false,
      restartRequestedAt: null,
      settings: {},
      status: "active",
    },
    providers: [{ id: "claude-code", name: "Claude Code", available: true, version: "2.1.266" }],
    workspaces: [
      {
        path: "C:/work/ThreadLink",
        name: "ThreadLink",
        workspaceId: "tlwsp_1",
        exists: true,
        conversations: [
          {
            provider: "claude-code",
            title: "Dashboard redesign",
            mode: "resume",
            nativeSessionId: "04158991-0630-4b8b-b461-58c86ee35453",
            sessionId: "tlses_1",
            localBindingRef: "cc:04158991-0630-4b8b-b461-58c86ee35453",
            busy: false,
          },
        ],
      },
    ],
    pendingLinks: [],
    lastHeartbeatAt: "2026-09-22T12:00:00Z",
    tasksCompleted: 0,
    ...over,
  }) as unknown as AppState["snapshot"];

const state = (over: Partial<AppState> = {}): AppState => ({
  signedIn: true,
  baseUrl: "https://threadlink.example",
  snapshot: snapshot(),
  pendingSignIn: null,
  error: null,
  localPaused: false,
  settings: { autoStart: true, notifications: true },
  ...over,
});

describe("desktop status", () => {
  it("tells the user what is happening in plain words", () => {
    expect(statusLine(state())).toMatchObject({ title: "ThreadLink Ready", tone: "ready" });
    expect(statusLine(state({ signedIn: false }))).toMatchObject({
      title: "Sign in to ThreadLink",
    });
    expect(statusLine(state({ snapshot: snapshot({ status: "offline" }) }))).toMatchObject({
      title: "Reconnecting…",
      tone: "warn",
    });
    expect(statusLine(state({ snapshot: snapshot({ status: "paused" }) })).title).toBe(
      "ThreadLink paused",
    );
    expect(
      statusLine(
        state({
          snapshot: snapshot({
            providers: [
              { id: "claude-code", name: "Claude Code", available: false, version: null },
            ],
          }),
        }),
      ).title,
    ).toBe("Claude Code not found");
  });

  it("shows a busy conversation as busy, not as an error", () => {
    const busy = snapshot({
      workspaces: [
        {
          path: "C:/work/ThreadLink",
          name: "ThreadLink",
          workspaceId: "tlwsp_1",
          exists: true,
          conversations: [
            { title: "Dashboard redesign", mode: "resume", busy: true, localBindingRef: "x" },
          ],
        },
      ],
    });
    expect(statusLine(state({ snapshot: busy }))).toMatchObject({
      tone: "busy",
      detail: "A Claude conversation is in use right now",
    });
  });
});

describe("tray menu", () => {
  it("offers setup when signed out", () => {
    const labels = trayMenu(state({ signedIn: false })).map((i) => ("label" in i ? i.label : "-"));
    expect(labels).toContain("Set up ThreadLink…");
    expect(labels).toContain("Quit ThreadLink");
    expect(labels).not.toContain("Pause Runtime");
  });

  it("lists workspaces, conversations and the usual actions", () => {
    const items = trayMenu(state());
    const labels = items.map((i) => ("label" in i ? i.label : "-"));
    expect(labels).toEqual(
      expect.arrayContaining([
        "ThreadLink Ready",
        "ThreadLink",
        "   Dashboard redesign",
        "Open ThreadLink",
        "Open dashboard in browser",
        "Pause Runtime",
        "Restart Runtime",
        "Quit ThreadLink",
      ]),
    );
    expect(items.filter((i) => i.type === "action").map((i) => i.id)).toEqual(
      expect.arrayContaining(["open-window", "open-dashboard", "toggle-pause", "restart", "quit"]),
    );
  });

  it("surfaces waiting link requests", () => {
    const withLink = state({
      snapshot: snapshot({
        pendingLinks: [
          {
            linkId: "tllnk_1",
            sessionId: "tlses_1",
            from: "Planning chat",
            conversation: "Dashboard redesign",
          },
        ],
      }),
    });
    expect(trayMenu(withLink).map((i) => ("label" in i ? i.label : ""))).toContain(
      "1 link request waiting…",
    );
  });

  it("says Resume while paused", () => {
    expect(
      trayMenu(state({ localPaused: true })).map((i) => ("label" in i ? i.label : "")),
    ).toContain("Resume Runtime");
  });
});

describe("tray icon", () => {
  it("is drawn from pixels with a status colour and transparent corners", () => {
    const { buffer, size } = trayIconPixels("ready");
    expect(size).toBe(16);
    expect(buffer.length).toBe(16 * 16 * 4);
    const centre = (8 * 16 + 8) * 4;
    expect(buffer[centre + 3]).toBe(255); // opaque middle
    expect(buffer[3]).toBe(0); // transparent corner
    expect([...trayIconPixels("warn").buffer.subarray(centre, centre + 3)]).not.toEqual([
      ...buffer.subarray(centre, centre + 3),
    ]);
  });
});

describe("notifications", () => {
  it("explains a busy conversation and never includes request content", () => {
    const n = notificationFor(
      {
        type: "task",
        outcome: "failed",
        reason: "session_busy",
        title: "Run tests",
        conversation: "Dashboard redesign",
      },
      state(),
    );
    expect(n).toEqual({
      title: "Claude conversation is in use",
      body: "“Dashboard redesign” is open elsewhere, so the request was not sent.",
    });
  });

  it("is silent when the user turned notifications off", () => {
    expect(
      notificationFor(
        { type: "task", outcome: "completed", title: "x", conversation: "y" },
        state({ settings: { autoStart: true, notifications: false } }),
      ),
    ).toBeNull();
  });

  it("announces link requests", () => {
    expect(
      notificationFor({ type: "link-request", link: { from: "Planning chat" } }, state()),
    ).toMatchObject({
      title: "New link request",
    });
  });
});

describe("start at login", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("uses the OS login-item API on Windows and macOS", () => {
    const api = {
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false }),
    };
    applyAutoStart(true, { platform: "win32", api });
    expect(api.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
      args: ["--hidden"],
    });
    applyAutoStart(false, { platform: "darwin", api });
    expect(api.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ openAtLogin: false }),
    );
  });

  it("writes and removes an XDG autostart entry on Linux", () => {
    dir = mkdtempSync(join(tmpdir(), "tl-autostart-"));
    applyAutoStart(true, { platform: "linux", home: dir, execPath: "/usr/bin/threadlink" });
    const file = linuxAutostartFile(dir);
    expect(readFileSync(file, "utf8")).toBe(linuxAutostartContents("/usr/bin/threadlink"));
    expect(readFileSync(file, "utf8")).toContain("Exec=/usr/bin/threadlink --hidden");
    applyAutoStart(false, { platform: "linux", home: dir });
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});

describe("desktop settings", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("defaults sensibly and round-trips", () => {
    dir = mkdtempSync(join(tmpdir(), "tl-settings-"));
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(dir, { notifications: false })).toEqual({
      autoStart: true,
      notifications: false,
    });
    expect(loadSettings(dir)).toEqual({ autoStart: true, notifications: false });
  });
});
