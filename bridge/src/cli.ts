#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  ApiError,
  pollDeviceToken,
  startDeviceLogin,
  ThreadLinkApi,
  validateBaseUrl,
  type LinkView,
} from "./api.ts";
import {
  claudeAgentsLister,
  discoverClaudeSessions,
  maskSessionId,
  NATIVE_SESSION_ID,
  sessionExistsInWorkspace,
  type ClaudeSession,
} from "./claude-sessions.ts";
import { createCredentialStore, ENV_TOKEN, loadToken, TOKEN_PATTERN } from "./credentials.ts";
import {
  ClaudeCodeExecutor,
  EchoExecutor,
  PERMISSION_MODES,
  type Executor,
  type NativeSession,
  type PermissionMode,
} from "./executor.ts";
import {
  defaultConfigDir,
  loadConfig,
  loadWorkspaceState,
  saveConfig,
  saveWorkspaceState,
  workspaceDisplayName,
  type NativeAttachment,
} from "./state.ts";
import { processNextTask, runLoop } from "./worker.ts";

const USAGE = `ThreadLink Claude Code bridge

Everyday use:
  setup [--url <https://your-threadlink>]   one-time guided setup (sign in, pick your Claude
                                            session, confirm the ChatGPT link) - start here
  run                                       deliver ThreadLink tasks to Claude until Ctrl+C

Session:
  sessions                                  list Claude Code sessions in this workspace
  attach [<session-id> | --fresh]           choose which Claude session tasks resume

Advanced / debugging:
  login [--url <url>] [--paste]             sign in (browser approval; --paste to paste a credential)
  logout                                    remove the stored credential
  status                                    connection, session, attachment and links
  pending                                   pairing requests waiting for approval
  approve <linkId>                          approve a pairing request
  run --once                                process at most one task

Options:
  --workspace <dir>          workspace directory (default: current directory)
  --executor claude|echo     execution backend (default: claude)
  --permission-mode <mode>   Claude Code permission mode (default: plan = read-only)
  --model <model>            Claude Code model (optional)
  --session <id|fresh>       non-interactive session choice for setup/attach
  --yes                      non-interactive: confirm prompts (setup)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    workspace: { type: "string" },
    executor: { type: "string", default: "claude" },
    "permission-mode": { type: "string", default: "plan" },
    model: { type: "string" },
    session: { type: "string" },
    fresh: { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const configDir = defaultConfigDir();
const store = createCredentialStore({ configDir });
const workspace = resolve(values.workspace ?? process.cwd());
const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const say = (message = "") => stdout.write(`${message}\n`);
const interactive = Boolean(stdin.isTTY) && !values.yes;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
async function ask(question: string, fallback = ""): Promise<string> {
  if (!stdin.isTTY) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim() || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (values.yes) return true;
  if (!stdin.isTTY) return false;
  const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer === "" ? defaultYes : answer === "y" || answer === "yes";
}

async function readSecretFromStdin(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolvePromise) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolvePromise(value.trim());
          return;
        }
        if (ch === CTRL_C) process.exit(130);
        if (ch === DEL || ch === BACKSPACE) value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Opens a URL in the default browser without a shell-interpreted string. */
function openBrowser(url: string, baseUrl: string) {
  if (!url.startsWith(`${baseUrl}/`) || !/^https?:[A-Za-z0-9/:.?=_-]+$/.test(url)) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function resolveBaseUrl(): Promise<string> {
  const config = await loadConfig(configDir);
  const raw = values.url ?? process.env.THREADLINK_URL ?? config.baseUrl;
  if (raw) return validateBaseUrl(raw);
  const typed = await ask("ThreadLink address (https://...): ");
  if (!typed) throw new Error("No ThreadLink URL. Pass --url <https://your-threadlink>.");
  return validateBaseUrl(typed);
}

async function client(baseUrl?: string): Promise<ThreadLinkApi> {
  const url = baseUrl ?? (await resolveBaseUrl());
  const loaded = await loadToken(store);
  if (!loaded) throw new Error("Not signed in. Run `threadlink-bridge setup`.");
  if (loaded.source === "env")
    say(`warning: using ${ENV_TOKEN} from the environment (Alpha fallback).`);
  return new ThreadLinkApi({ baseUrl: url, token: loaded.token });
}

async function deviceLogin(baseUrl: string): Promise<void> {
  const name = `Claude Code on ${hostname()}`.slice(0, 100);
  const start = await startDeviceLogin(baseUrl, name);
  say("To connect this computer, approve it in your browser:");
  say(`  ${start.verification_uri_complete}`);
  say(`  Code: ${start.user_code}  (check it matches what the page shows)`);
  openBrowser(start.verification_uri_complete, baseUrl);
  say("Waiting for approval...");
  const token = await pollDeviceToken(baseUrl, start);
  if (!TOKEN_PATTERN.test(token.access_token)) throw new Error("Unexpected credential format.");
  const who = await new ThreadLinkApi({ baseUrl, token: token.access_token }).whoami();
  if (who.role !== "agent") throw new Error("ThreadLink did not issue a Claude Code credential.");
  if (
    token.account_hint &&
    !(await confirm(
      `Approved by ThreadLink account ${token.account_hint}. Link this computer to it?`,
      true,
    ))
  ) {
    say("Not linked. The credential was discarded.");
    process.exit(1);
  }
  await store.save(token.access_token);
  await saveConfig(configDir, { baseUrl });
  say(`Signed in. Credential stored in ${store.description}.`);
}

async function pasteLogin(baseUrl: string): Promise<void> {
  const token = await readSecretFromStdin(
    "Paste the Claude Code connection credential (input hidden): ",
  );
  if (!TOKEN_PATTERN.test(token))
    throw new Error("That is not a ThreadLink connection credential.");
  const who = await new ThreadLinkApi({ baseUrl, token }).whoami();
  if (who.role !== "agent")
    throw new Error("This credential is not a Claude Code (agent) connection.");
  await store.save(token);
  await saveConfig(configDir, { baseUrl });
  say(`Stored credential in ${store.description}.`);
}

/** Returns a working client, signing in (browser approval) if needed. */
async function ensureSignedIn(baseUrl: string): Promise<ThreadLinkApi> {
  const loaded = await loadToken(store).catch(() => null);
  if (loaded) {
    const api = new ThreadLinkApi({ baseUrl, token: loaded.token });
    try {
      const who = await api.whoami();
      if (who.role === "agent") {
        say(`Signed in (${who.platform}, connection ${maskId(who.connectionId)}).`);
        return api;
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      say("The stored credential is no longer valid; signing in again.");
    }
  }
  await deviceLogin(baseUrl);
  return client(baseUrl);
}

async function ensureSession(api: ThreadLinkApi): Promise<string> {
  const state = await loadWorkspaceState(configDir, workspace);
  const { session } = await api.registerSession({
    localBindingRef: state.localBindingRef,
    displayName: workspaceDisplayName(workspace),
  });
  if (state.sessionId !== session.sessionId) {
    await saveWorkspaceState(configDir, { ...state, sessionId: session.sessionId });
  }
  return session.sessionId;
}

const maskId = (id: string) => (id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id);

// ---------------------------------------------------------------------------
// Native session attachment
// ---------------------------------------------------------------------------
function ago(date: Date): string {
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

async function listSessionsWithState(): Promise<{ sessions: ClaudeSession[]; open: Set<string> }> {
  const sessions = await discoverClaudeSessions(workspace);
  const open = new Set<string>();
  try {
    for (const r of await claudeAgentsLister()()) open.add(r.sessionId);
  } catch {
    /* listing unavailable; shown without open markers */
  }
  return { sessions, open };
}

function printSessions(sessions: ClaudeSession[], open: Set<string>) {
  sessions.forEach((s, i) => {
    say(
      `  ${String(i + 1).padStart(2)}) ${s.title ?? "(untitled session)"}  ·  ${ago(s.lastUsedAt)}  ·  ${maskSessionId(s.sessionId)}${open.has(s.sessionId) ? "  ·  open now" : ""}`,
    );
  });
}

async function chooseAttachment(): Promise<NativeAttachment | null> {
  const now = new Date().toISOString();
  const explicit = values.fresh ? "fresh" : (values.session ?? positionals[1]);
  if (explicit === "fresh") return { mode: "fresh", attachedAt: now };
  if (explicit) {
    if (!NATIVE_SESSION_ID.test(explicit)) throw new Error("That is not a Claude Code session ID.");
    if (!(await sessionExistsInWorkspace(workspace, explicit))) {
      throw new Error("No Claude Code session with that ID exists in this workspace.");
    }
    const found = (await discoverClaudeSessions(workspace, { limit: 500 })).find(
      (s) => s.sessionId === explicit,
    );
    return { mode: "resume", sessionId: explicit, title: found?.title ?? null, attachedAt: now };
  }

  const { sessions, open } = await listSessionsWithState();
  say(`Claude Code sessions in ${workspace}:`);
  if (sessions.length === 0)
    say("  (none found - Claude Code has not been used in this folder yet)");
  printSessions(sessions, open);
  say("   0) Don't attach: run each task in a fresh Claude Code session");
  say("   m) Enter a session ID manually");
  if (!interactive) return null;
  for (;;) {
    const answer = (
      await ask(
        sessions.length ? "Choose a session [1]: " : "Choose [0]: ",
        sessions.length ? "1" : "0",
      )
    ).toLowerCase();
    if (answer === "0") return { mode: "fresh", attachedAt: now };
    if (answer === "m") {
      const id = (await ask("Session ID: ")).toLowerCase();
      if (NATIVE_SESSION_ID.test(id) && (await sessionExistsInWorkspace(workspace, id))) {
        return { mode: "resume", sessionId: id, title: null, attachedAt: now };
      }
      say("No Claude Code session with that ID exists in this workspace.");
      continue;
    }
    const n = Number(answer);
    const chosen = Number.isInteger(n) ? sessions[n - 1] : undefined;
    if (chosen) {
      return { mode: "resume", sessionId: chosen.sessionId, title: chosen.title, attachedAt: now };
    }
    say("Please choose one of the numbers above.");
  }
}

async function saveAttachment(api: ThreadLinkApi, sessionId: string, attachment: NativeAttachment) {
  const state = await loadWorkspaceState(configDir, workspace);
  await saveWorkspaceState(configDir, { ...state, sessionId, native: attachment });
  await api.setNativeSession({
    sessionId,
    mode: attachment.mode,
    nativeSessionId: attachment.mode === "resume" ? attachment.sessionId : null,
    workspacePath: workspace,
  });
  if (attachment.mode === "resume") {
    say(
      `Attached: tasks will resume "${attachment.title ?? "untitled session"}" (${maskSessionId(attachment.sessionId)}).`,
    );
    say(
      "Note: ThreadLink only delivers while that session is closed; an open window will not live-update.",
    );
  } else {
    say("Not attached: each task runs in a fresh Claude Code session.");
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
async function confirmPending(api: ThreadLinkApi, sessionId: string, pending: LinkView[]) {
  let approved = 0;
  for (const link of pending) {
    const from = link.controllerDisplayName ?? "a ChatGPT conversation";
    if (await confirm(`Link "${from}" to this Claude Code session?`)) {
      const result = await api.approvePairing(sessionId, link.linkId);
      if (result.status === "active") approved++;
      say(`Linked (${maskId(result.linkId)}).`);
    } else {
      say("Skipped (still pending; you can approve it later).");
    }
  }
  return approved;
}

async function setupPairing(api: ThreadLinkApi, sessionId: string): Promise<boolean> {
  let links = await api.links(sessionId);
  if (links.some((l) => l.status === "active")) {
    say("This Claude Code session is already linked to a ChatGPT conversation.");
    return true;
  }
  let pending = links.filter((l) => l.status === "pending");
  if (pending.length === 0) {
    if (!interactive && !values.yes) return false;
    say("Now link it from ChatGPT: in your ChatGPT conversation say");
    say('  "Link this chat to Claude Code"');
    say("(or use Link in the ThreadLink dashboard). Waiting up to 5 minutes... Ctrl+C to skip.");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && pending.length === 0) {
      await new Promise((r) => setTimeout(r, 3000));
      links = await api.links(sessionId);
      pending = links.filter((l) => l.status === "pending");
    }
    if (pending.length === 0) {
      say("No link request arrived. Run `threadlink-bridge setup` again when ready.");
      return false;
    }
  }
  return (await confirmPending(api, sessionId, pending)) > 0;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function nativeFromState(native: NativeAttachment | undefined): NativeSession {
  if (!native || native.mode === "fresh") return { mode: "fresh" };
  if (native.mode === "continue") return { mode: "continue" };
  return { mode: "resume", sessionId: native.sessionId };
}

async function buildExecutor(): Promise<Executor> {
  if (values.executor === "echo") return new EchoExecutor();
  if (values.executor !== "claude") throw new Error("--executor must be claude or echo");
  const mode = values["permission-mode"] as PermissionMode;
  if (!PERMISSION_MODES.includes(mode))
    throw new Error(`--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
  const state = await loadWorkspaceState(configDir, workspace);
  return new ClaudeCodeExecutor({
    cwd: workspace,
    permissionMode: mode,
    model: values.model,
    native: nativeFromState(state.native),
    listRunning: claudeAgentsLister(),
    lockDir: configDir,
  });
}

async function run(api: ThreadLinkApi, sessionId: string): Promise<number> {
  const executor = await buildExecutor();
  const claimRef = `bridge-${randomUUID()}`;
  const log = (m: string) => say(`[${new Date().toISOString()}] ${m}`);
  const native =
    executor instanceof ClaudeCodeExecutor ? executor.native : { mode: "fresh" as const };
  log(
    `session ${maskId(sessionId)}; ${native.mode === "resume" ? `resuming Claude session ${maskSessionId(native.sessionId)}` : `executor ${executor.name} (${native.mode})`}; ${values.once ? "once" : "Ctrl+C to stop"}`,
  );
  if (values.once) {
    log(`outcome: ${await processNextTask({ api, executor, sessionId, claimRef, log })}`);
    return 0;
  }
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  const result = await runLoop({ api, executor, sessionId, claimRef, log, signal: stop.signal });
  return result === "unauthorized" ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  const command = positionals[0];
  if (values.help || !command) {
    say(USAGE);
    return command ? 0 : 1;
  }

  if (command === "setup") {
    say("ThreadLink setup for Claude Code");
    say(`Workspace: ${workspace}`);
    say();
    const baseUrl = await resolveBaseUrl();
    say("Step 1/4 - Sign in");
    const api = await ensureSignedIn(baseUrl);
    await saveConfig(configDir, { baseUrl });
    const sessionId = await ensureSession(api);
    say();
    say("Step 2/4 - Choose your Claude Code session");
    const attachment = await chooseAttachment();
    if (attachment) await saveAttachment(api, sessionId, attachment);
    else say("Skipped (non-interactive). Use --session <id|fresh>.");
    say();
    say("Step 3/4 - Link a ChatGPT conversation");
    const linked = await setupPairing(api, sessionId);
    say();
    say("Step 4/4 - Ready");
    say(
      linked
        ? "Everything is connected."
        : "Connected. Link a ChatGPT conversation to start sending tasks.",
    );
    if (interactive && (await confirm("Start delivering tasks now?", true)))
      return run(api, sessionId);
    say("Start delivering tasks any time with: threadlink-bridge run");
    return 0;
  }

  if (command === "login") {
    const baseUrl = await resolveBaseUrl();
    if (values.paste) await pasteLogin(baseUrl);
    else await deviceLogin(baseUrl);
    return 0;
  }

  if (command === "logout") {
    await store.clear();
    say(
      "Stored credential removed. Revoke the connection in the dashboard to disable it everywhere.",
    );
    return 0;
  }

  if (command === "sessions") {
    const { sessions, open } = await listSessionsWithState();
    const state = await loadWorkspaceState(configDir, workspace);
    say(`Claude Code sessions in ${workspace}:`);
    if (sessions.length === 0) say("  (none found)");
    printSessions(sessions, open);
    const native = state.native;
    say(
      native?.mode === "resume"
        ? `Attached: ${maskSessionId(native.sessionId)}`
        : "Attached: none (fresh session per task)",
    );
    return 0;
  }

  const api = await client();
  const sessionId = await ensureSession(api);

  if (command === "attach") {
    const attachment = await chooseAttachment();
    if (!attachment) throw new Error("Choose a session: attach <session-id> or attach --fresh");
    await saveAttachment(api, sessionId, attachment);
    return 0;
  }

  if (command === "status") {
    const who = await api.whoami();
    const state = await loadWorkspaceState(configDir, workspace);
    say(`connection: ${who.connectionId} (${who.platform}/${who.role}, ${who.status})`);
    say(`workspace:  ${workspace}`);
    say(`session:    ${sessionId}`);
    say(
      `claude:     ${state.native?.mode === "resume" ? `resume ${maskSessionId(state.native.sessionId)}` : (state.native?.mode ?? "fresh")}`,
    );
    for (const l of (await api.links(sessionId)).filter((x) => x.status !== "revoked")) {
      say(
        `link:       ${l.linkId} ${l.status} <- ${l.controllerDisplayName ?? "controller session"}`,
      );
    }
    return 0;
  }

  if (command === "pending") {
    const pending = (await api.links(sessionId)).filter((l) => l.status === "pending");
    if (pending.length === 0) say("No pending pairing requests for this workspace session.");
    for (const l of pending) {
      say(
        `${l.linkId}  from ${l.controllerDisplayName ?? "controller session"} (${l.controllerSessionId})`,
      );
    }
    return 0;
  }

  if (command === "approve") {
    const linkId = positionals[1];
    if (!linkId || !/^tllnk_[0-9a-f]{32}$/.test(linkId))
      throw new Error("Usage: approve <tllnk_...>");
    const link = await api.approvePairing(sessionId, linkId);
    say(`Link ${link.linkId} is ${link.status}.`);
    return 0;
  }

  if (command === "run") return run(api, sessionId);

  say(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message =
      error instanceof ApiError
        ? error.kind === "access_denied"
          ? "The request was denied in the browser."
          : error.kind === "expired_token"
            ? "The sign-in code expired. Run the command again."
            : `ThreadLink request failed (${error.status} ${error.kind})`
        : String((error as Error)?.message ?? error);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  },
);
