import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  shell,
  Tray,
} from "electron";
import {
  canonicalBaseUrl,
  canonicalizeBaseUrl,
  createEngine,
  defaultConfigDir,
  loadConfig,
  migrateBaseUrl,
  RuntimeEngine,
  runtimeContext,
  saveConfig,
  signedInApi,
  signIn,
  signOut,
  ThreadLinkApi,
  validateBaseUrl,
  type EngineEvent,
  type EngineSnapshot,
} from "threadlink";

import { applyAutoStart, autoStartEnabled } from "./autostart.js";
import { NotificationRouter, type NotificationChannel } from "./notifications.js";
import { messageFor, statusLine, trayIconPixels, trayMenu, type AppState } from "./model.js";
import { loadSettings, saveSettings } from "./settings.js";

/**
 * ThreadLink desktop app (Windows first, built cross-platform):
 * runs the Runtime engine in the background, with a tray/menu-bar icon and a
 * small window for setup and day-to-day control. No terminal needed.
 *
 * Security: the renderer is sandboxed with context isolation, loads only local
 * files, and talks to the main process through a narrow, validated IPC surface.
 * Credentials never reach the renderer.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes("--smoke");
/** Dev-only: `--capture <file>` saves a PNG of the window and exits (never in packaged builds). */
const CAPTURE =
  process.argv.find((a) => a.startsWith("--capture="))?.slice("--capture=".length) ?? null;
/**
 * `--smoke-out=<file>` writes the smoke report to a file as well as stdout.
 * A packaged Windows build is a GUI executable and has no console to write to,
 * so this is the only way to read the report from an installed app.
 */
const SMOKE_OUT =
  process.argv.find((a) => a.startsWith("--smoke-out="))?.slice("--smoke-out=".length) ?? null;
const START_HIDDEN = process.argv.includes("--hidden");
/**
 * The stable hostname for the channel this build targets. Never a generated
 * Vercel deployment URL: those are frozen snapshots of one old build.
 */
const DEFAULT_URL = process.env.THREADLINK_URL ?? canonicalBaseUrl();

const ctx = runtimeContext(defaultConfigDir());
const state: AppState = {
  signedIn: false,
  baseUrl: null,
  snapshot: null,
  pendingSignIn: null,
  error: null,
  notice: null,
  localPaused: false,
  settings: loadSettings(ctx.configDir),
};

let engine: RuntimeEngine | null = null;
let engineRun: Promise<unknown> | null = null;
let abort: AbortController | null = null;
let api: ThreadLinkApi | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let signInAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// UI plumbing
// ---------------------------------------------------------------------------
function broadcast() {
  win?.webContents.send("state", state);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const status = statusLine(state);
  const { buffer, size } = trayIconPixels(status.tone);
  tray.setImage(nativeImage.createFromBitmap(buffer, { width: size, height: size }));
  tray.setToolTip(`${status.title} — ${status.detail}`);
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(state).map((item) =>
        item.type === "separator"
          ? { type: "separator" as const }
          : item.type === "label"
            ? { label: item.label, enabled: false }
            : { label: item.label, enabled: item.enabled ?? true, click: () => onMenu(item.id) },
      ),
    ),
  );
}

function onMenu(id: string) {
  if (id === "open-window") showWindow();
  else if (id === "open-dashboard") openDashboard();
  else if (id === "toggle-pause") setPaused(!state.localPaused);
  else if (id === "restart") void restartEngine();
  else if (id === "quit") quit();
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: "ThreadLink",
    backgroundColor: "#0c0c10",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.on("close", (event) => {
    // Closing hides to the tray; Quit is explicit.
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (state.baseUrl && url.startsWith(`${state.baseUrl}/`)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  void win.loadFile(join(HERE, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => {
    win?.show();
    broadcast();
  });
}

function openDashboard() {
  const url = state.baseUrl ?? DEFAULT_URL;
  void shell.openExternal(`${url}/dashboard`);
}

let quitting = false;
function quit() {
  quitting = true;
  abort?.abort();
  app.quit();
}

/**
 * Desktop is the default free channel. It carries only what the router deems
 * safe for a lock screen, and clicking it opens the relevant dashboard page.
 */
const desktopChannel: NotificationChannel = {
  id: "desktop",
  available: () => state.settings.notifications && Notification.isSupported(),
  deliver: (payload) => {
    const notification = new Notification({ title: payload.title, body: payload.body });
    notification.on("click", () => {
      const base = state.baseUrl ?? DEFAULT_URL;
      void shell.openExternal(`${base}${payload.openPath ?? "/dashboard"}`);
    });
    notification.show();
  },
};

const notifications = new NotificationRouter();
notifications.register(desktopChannel);

function notify(event: EngineEvent) {
  notifications.handle(event as never);
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------
function onEngineEvent(event: EngineEvent) {
  if (event.type === "snapshot") {
    state.snapshot = event.snapshot as EngineSnapshot;
    if (
      event.snapshot.status === "signed-out" ||
      event.snapshot.status === "revoked" ||
      event.snapshot.status === "wrong-address"
    )
      state.signedIn = false;
    broadcast();
    return;
  }
  if (event.type === "settings") {
    // Settings changed in ThreadLink (works for remote runtimes too).
    state.settings = saveSettings(ctx.configDir, {
      autoStart: event.settings.autoStart ?? state.settings.autoStart,
      notifications: event.settings.notifications ?? state.settings.notifications,
    });
    applyAutoStart(state.settings.autoStart, { api: app, execPath: process.execPath });
    broadcast();
    return;
  }
  if (event.type === "restart-requested") {
    void restartEngine();
    return;
  }
  if (event.type === "link-request") showWindow();
  notify(event);
}

async function startEngine() {
  if (!api) return;
  engine = createEngine(ctx, api, {
    kind: "desktop",
    permissionMode: "plan",
    baseUrlLabel: state.baseUrl ? new URL(state.baseUrl).host : undefined,
  });
  engine.on(onEngineEvent);
  abort = new AbortController();
  engineRun = engine.run(abort.signal).catch((error: unknown) => {
    state.error = error instanceof Error ? error.message : "Runtime error";
    broadcast();
  });
}

async function restartEngine() {
  abort?.abort();
  await engineRun?.catch(() => {});
  await new Promise((r) => setTimeout(r, 250)); // let the single-instance lock clear
  await startEngine();
}

function setPaused(paused: boolean) {
  state.localPaused = paused;
  engine?.setLocalPause(paused);
  broadcast();
}

async function connect(): Promise<void> {
  // Upgrade a stored generated deployment hostname before anything uses it.
  // The Runtime ID, its workspaces and their sessions are untouched, so the
  // same conversations and links keep working at the new address.
  const migration = await migrateBaseUrl(ctx.configDir);
  if (migration.changed && migration.previous) {
    state.notice = `ThreadLink moved to its permanent address (${new URL(migration.url).host}).`;
  }
  api = await signedInApi(ctx).catch(() => null);
  state.baseUrl = (await loadConfig(ctx.configDir)).baseUrl ?? DEFAULT_URL;
  state.signedIn = Boolean(api);
  broadcast();
  if (api) await startEngine();
}

// ---------------------------------------------------------------------------
// IPC (renderer -> main). Every argument is validated here.
// ---------------------------------------------------------------------------
const asString = (v: unknown, max = 1024) => (typeof v === "string" && v.length <= max ? v : null);

/**
 * The renderer is sandboxed but still untrusted input: only the two real
 * execution modes are accepted, and background is the default.
 */
const executionMode = (v: unknown): "worker" | "resume" =>
  v === "resume" ? "resume" : "worker";

function handlers() {
  ipcMain.handle("state:get", () => state);

  ipcMain.handle("signin:start", async (_e, rawUrl: unknown) => {
    // Whatever the box says, never store a generated deployment hostname.
    const url = validateBaseUrl(canonicalizeBaseUrl(asString(rawUrl, 512) ?? DEFAULT_URL).url);
    signInAbort = new AbortController();
    state.error = null;
    state.notice = null;
    try {
      const ok = await signIn(ctx, url, `ThreadLink on ${hostname()}`, {
        signal: signInAbort.signal,
        onCode: (start) => {
          state.pendingSignIn = { userCode: start.user_code, url: start.verification_uri_complete };
          broadcast();
          void shell.openExternal(start.verification_uri_complete);
        },
        confirmAccount: async (hint) => {
          if (!hint) return true;
          const { response } = await dialog.showMessageBox({
            type: "question",
            buttons: ["Connect", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: `Approved by ${hint}`,
            detail: "Connect this computer to that ThreadLink account?",
          });
          return response === 0;
        },
      });
      state.pendingSignIn = null;
      if (!ok) {
        state.error = "Sign-in was cancelled.";
        broadcast();
        return { ok: false };
      }
      await saveConfig(ctx.configDir, { baseUrl: url });
      await connect();
      return { ok: true };
    } catch (error) {
      state.pendingSignIn = null;
      state.error = error instanceof Error ? error.message : "Sign-in failed.";
      broadcast();
      return { ok: false, error: state.error };
    }
  });

  ipcMain.handle("signin:cancel", () => {
    signInAbort?.abort();
    state.pendingSignIn = null;
    broadcast();
  });

  ipcMain.handle("signout", async () => {
    abort?.abort();
    await signOut(ctx);
    api = null;
    state.signedIn = false;
    state.snapshot = null;
    broadcast();
  });

  ipcMain.handle("workspaces:detected", async () => {
    const found = (await engine?.discoverWorkspaces()) ?? [];
    return found.map((w) => ({ path: w.path, lastUsedAt: w.lastUsedAt.toISOString() }));
  });

  ipcMain.handle("workspace:add", async (_e, rawPath: unknown) => {
    let path = asString(rawPath);
    if (!path) {
      const picked = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose a project folder",
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false };
      path = picked.filePaths[0];
    }
    await engine?.addWorkspace(path);
    return { ok: true, path };
  });

  ipcMain.handle("conversations:list", async (_e, rawPath: unknown) => {
    const path = asString(rawPath);
    if (!path || !engine) return [];
    const list = await engine.discoverConversations(path);
    return list.map((c) => ({
      nativeSessionId: c.nativeSessionId,
      title: c.title,
      lastUsedAt: c.lastUsedAt.toISOString(),
      busy: c.busy,
      attached: c.attached,
      runtime: c.runtime,
    }));
  });

  ipcMain.handle(
    "conversation:attach",
    async (_e, rawPath: unknown, rawId: unknown, rawTitle: unknown, rawMode: unknown) => {
      const path = asString(rawPath);
      const id = rawId === null ? null : asString(rawId, 64);
      if (!path || !engine) return { ok: false, error: "No workspace." };
      const mode = executionMode(rawMode);
      try {
        await engine.attach(path, id, asString(rawTitle, 200), id ? mode : "fresh");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: messageFor(error) };
      }
    },
  );

  /**
   * Changing how an attached conversation runs. Deliberately its own operation
   * rather than detach-and-attach: the link, the workspace and this device's
   * registration all have to survive it.
   */
  ipcMain.handle(
    "conversation:mode",
    async (_e, rawPath: unknown, rawRef: unknown, rawMode: unknown) => {
      const path = asString(rawPath);
      const ref = asString(rawRef, 200);
      const mode = executionMode(rawMode);
      if (!path || !ref || !engine) return { ok: false, error: "That conversation is not here." };
      try {
        const conversation = await engine.setConversationMode(path, ref, mode);
        return { ok: true, mode: conversation.mode };
      } catch (error) {
        return { ok: false, error: messageFor(error) };
      }
    },
  );

  ipcMain.handle("conversation:detach", async (_e, rawPath: unknown, rawRef: unknown) => {
    const path = asString(rawPath);
    const ref = asString(rawRef, 200);
    if (!path || !ref || !engine) return { ok: false };
    await engine.detach(path, ref);
    return { ok: true };
  });

  ipcMain.handle("link:decide", async (_e, rawId: unknown, approve: unknown) => {
    // Always resolves with a result. A rejected invoke would surface in the
    // renderer as an unhandled promise, i.e. as a button that does nothing.
    const id = asString(rawId, 64);
    if (!id) return { ok: false, error: "That link request is not valid." };
    if (!engine) {
      return { ok: false, error: "ThreadLink is still connecting. Try again in a moment." };
    }
    try {
      if (approve === true) await engine.approveLink(id);
      else await engine.declineLink(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageFor(error) };
    }
  });

  ipcMain.handle("link:attach", async (_e, rawId: unknown) => {
    const id = asString(rawId, 64);
    if (!id) return { ok: false, error: "That link request is not valid." };
    if (!engine) {
      return { ok: false, error: "ThreadLink is still connecting. Try again in a moment." };
    }
    try {
      await engine.attachForLink(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageFor(error) };
    }
  });

  ipcMain.handle("runtime:pause", (_e, paused: unknown) => setPaused(paused === true));
  ipcMain.handle("runtime:restart", () => restartEngine());
  ipcMain.handle("open:dashboard", () => openDashboard());
  ipcMain.handle("open:external", (_e, rawUrl: unknown) => {
    const url = asString(rawUrl, 512);
    if (url && state.baseUrl && url.startsWith(`${state.baseUrl}/`)) void shell.openExternal(url);
  });

  ipcMain.handle("settings:set", (_e, patch: unknown) => {
    const p = (patch ?? {}) as Partial<{ autoStart: boolean; notifications: boolean }>;
    state.settings = saveSettings(ctx.configDir, {
      ...(typeof p.autoStart === "boolean" ? { autoStart: p.autoStart } : {}),
      ...(typeof p.notifications === "boolean" ? { notifications: p.notifications } : {}),
    });
    applyAutoStart(state.settings.autoStart, { api: app, execPath: process.execPath });
    broadcast();
    return state.settings;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(async () => {
    handlers();
    tray = new Tray(
      nativeImage.createFromBitmap(trayIconPixels("off").buffer, { width: 16, height: 16 }),
    );
    tray.on("click", () => showWindow());
    updateTray();
    applyAutoStart(state.settings.autoStart, { api: app, execPath: process.execPath });
    await connect();
    if (!START_HIDDEN && !SMOKE) showWindow();

    if (CAPTURE && !app.isPackaged && win) {
      const { writeFile } = await import("node:fs/promises");
      setTimeout(async () => {
        const image = await win!.webContents.capturePage();
        await writeFile(CAPTURE, image.toPNG());
        process.stdout.write(`CAPTURED ${CAPTURE}
`);
        quit();
      }, 2500);
    }

    // Wake from sleep / network change: nudge the engine to reconnect now.
    powerMonitor.on("resume", () => engine?.wake());

    if (SMOKE) {
      const report = {
        ok: true,
        tray: Boolean(tray),
        signedIn: state.signedIn,
        status: statusLine(state),
        menu: trayMenu(state).map((m) => ("label" in m ? m.label : "---")),
        packaged: app.isPackaged,
        autoStartEnabled: autoStartEnabled({ api: app }),
      };
      process.stdout.write(`SMOKE ${JSON.stringify(report)}\n`);
      if (SMOKE_OUT) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(SMOKE_OUT, `SMOKE ${JSON.stringify(report)}\n`, "utf8");
      }
      setTimeout(() => quit(), 500);
    }
  });
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });
  app.on("before-quit", () => {
    quitting = true;
    abort?.abort();
  });
}
