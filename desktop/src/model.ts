import type { EngineSnapshot } from "threadlink";

/**
 * Pure presentation logic for the desktop app (tray menu, status text, icon
 * colour). No Electron imports, so it is unit-tested directly.
 */

export type AppState = {
  signedIn: boolean;
  baseUrl: string | null;
  snapshot: EngineSnapshot | null;
  pendingSignIn: { userCode: string; url: string } | null;
  error: string | null;
  localPaused: boolean;
  settings: { autoStart: boolean; notifications: boolean };
};

export type StatusTone = "ready" | "busy" | "warn" | "off";

export function statusLine(state: AppState): { title: string; detail: string; tone: StatusTone } {
  if (!state.signedIn) {
    return { title: "Sign in to ThreadLink", detail: "Not connected", tone: "warn" };
  }
  const snap = state.snapshot;
  const attached = snap?.workspaces.flatMap((w) => w.conversations) ?? [];
  const claude = snap?.providers.find((p) => p.id === "claude-code");
  if (claude && !claude.available) {
    return {
      title: "Claude Code not found",
      detail: "Install Claude Code to receive requests",
      tone: "warn",
    };
  }
  switch (snap?.status) {
    case "online":
      return attached.length
        ? {
            title: "ThreadLink Ready",
            detail: attached.some((c) => c.busy)
              ? "A Claude conversation is in use right now"
              : `${attached.length} conversation${attached.length === 1 ? "" : "s"} ready`,
            tone: attached.some((c) => c.busy) ? "busy" : "ready",
          }
        : { title: "Choose a Claude conversation", detail: "Nothing attached yet", tone: "warn" };
    case "paused":
      return {
        title: "ThreadLink paused",
        detail: "Requests are not being delivered",
        tone: "warn",
      };
    case "offline":
      return { title: "Reconnecting…", detail: "Can't reach ThreadLink", tone: "warn" };
    case "signed-out":
      return { title: "Sign in again", detail: "ThreadLink sign-in expired", tone: "warn" };
    case "revoked":
      return {
        title: "Runtime disconnected",
        detail: "This device was revoked in ThreadLink",
        tone: "off",
      };
    case "starting":
      return { title: "Starting…", detail: "Connecting to ThreadLink", tone: "warn" };
    default:
      return { title: "ThreadLink", detail: "Idle", tone: "off" };
  }
}

export type MenuItemModel =
  | { type: "label"; label: string; enabled: false }
  | { type: "separator" }
  | { type: "action"; id: string; label: string; enabled?: boolean; checked?: boolean };

/** The tray/menu-bar menu, as data. */
export function trayMenu(state: AppState): MenuItemModel[] {
  const status = statusLine(state);
  const snap = state.snapshot;
  const items: MenuItemModel[] = [
    { type: "label", label: status.title, enabled: false },
    { type: "label", label: status.detail, enabled: false },
    { type: "separator" },
  ];

  if (!state.signedIn) {
    items.push({ type: "action", id: "open-window", label: "Set up ThreadLink…" });
  } else {
    for (const ws of snap?.workspaces ?? []) {
      items.push({
        type: "label",
        label: `${ws.name}${ws.exists ? "" : " (folder missing)"}`,
        enabled: false,
      });
      for (const c of ws.conversations) {
        items.push({
          type: "label",
          label: `   ${c.title}${c.busy ? " · in use" : ""}`,
          enabled: false,
        });
      }
    }
    if (snap?.pendingLinks.length) {
      items.push({ type: "separator" });
      items.push({
        type: "action",
        id: "open-window",
        label: `${snap.pendingLinks.length} link request${snap.pendingLinks.length === 1 ? "" : "s"} waiting…`,
      });
    }
    items.push({ type: "separator" });
    items.push({ type: "action", id: "open-window", label: "Open ThreadLink" });
    items.push({ type: "action", id: "open-dashboard", label: "Open dashboard in browser" });
    items.push({
      type: "action",
      id: "toggle-pause",
      label: state.localPaused || snap?.runtime?.paused ? "Resume Runtime" : "Pause Runtime",
      enabled: !snap?.runtime?.paused, // a pause set in ThreadLink is released there
      checked: state.localPaused,
    });
    items.push({ type: "action", id: "restart", label: "Restart Runtime" });
  }
  items.push({ type: "separator" });
  items.push({ type: "action", id: "quit", label: "Quit ThreadLink" });
  return items;
}

const TONE_RGB: Record<StatusTone, [number, number, number]> = {
  ready: [34, 160, 90],
  busy: [200, 140, 20],
  warn: [200, 140, 20],
  off: [130, 130, 140],
};

/** A small status dot as raw BGRA pixels (no binary assets needed). */
export function trayIconPixels(tone: StatusTone, size = 16): { buffer: Buffer; size: number } {
  const [r, g, b] = TONE_RGB[tone];
  const buffer = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = d <= radius ? 255 : d <= radius + 1 ? Math.round(255 * (radius + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buffer[i] = b;
      buffer[i + 1] = g;
      buffer[i + 2] = r;
      buffer[i + 3] = alpha;
    }
  }
  return { buffer, size };
}

/** Desktop notifications, filtered by the user's preference. Never includes content. */
export function notificationFor(
  event: {
    type: string;
    outcome?: string;
    title?: string;
    conversation?: string;
    reason?: string;
    link?: { from: string };
  },
  state: AppState,
): { title: string; body: string } | null {
  if (!state.settings.notifications) return null;
  if (event.type === "task" && event.outcome === "failed" && event.reason === "session_busy") {
    return {
      title: "Claude conversation is in use",
      body: `“${event.conversation}” is open elsewhere, so the request was not sent.`,
    };
  }
  if (event.type === "task" && event.outcome === "failed") {
    return { title: "Request failed", body: `${event.title} (${event.conversation})` };
  }
  if (event.type === "task" && event.outcome === "completed") {
    return { title: "Request completed", body: `${event.title} (${event.conversation})` };
  }
  if (event.type === "link-request") {
    return { title: "New link request", body: `“${event.link?.from}” wants to use Claude Code.` };
  }
  return null;
}
