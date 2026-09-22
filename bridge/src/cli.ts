#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";

import { ApiError, ThreadLinkApi, validateBaseUrl } from "./api.ts";
import { createCredentialStore, ENV_TOKEN, loadToken, TOKEN_PATTERN } from "./credentials.ts";
import {
  ClaudeCodeExecutor,
  EchoExecutor,
  PERMISSION_MODES,
  type Executor,
  type PermissionMode,
} from "./executor.ts";
import {
  defaultConfigDir,
  loadConfig,
  loadWorkspaceState,
  saveConfig,
  saveWorkspaceState,
  workspaceDisplayName,
} from "./state.ts";
import { processNextTask, runLoop } from "./worker.ts";

const USAGE = `ThreadLink Claude Code bridge

Usage: node bridge/src/cli.ts <command> [options]

Commands:
  login --url <https://your-threadlink>   store the connection credential (read from stdin)
  logout                                  remove the stored credential
  status                                  show connection + this workspace's session
  pending                                 list pairing requests waiting for approval
  approve <linkId>                        approve a pairing request for this workspace session
  run [--once]                            poll for tasks and run them with Claude Code

Options:
  --workspace <dir>          workspace directory (default: current directory)
  --executor claude|echo     execution backend (default: claude)
  --permission-mode <mode>   Claude Code permission mode (default: plan = read-only)
  --model <model>            Claude Code model (optional)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    workspace: { type: "string" },
    executor: { type: "string", default: "claude" },
    "permission-mode": { type: "string", default: "plan" },
    model: { type: "string" },
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const configDir = defaultConfigDir();
const store = createCredentialStore({ configDir });
const workspace = values.workspace ?? process.cwd();
const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);
const say = (message: string) => stdout.write(`${message}\n`);

async function readSecretFromStdin(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value.trim());
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

async function client(): Promise<ThreadLinkApi> {
  const config = await loadConfig(configDir);
  const baseUrl = process.env.THREADLINK_URL ?? config.baseUrl;
  if (!baseUrl) throw new Error("No ThreadLink URL configured. Run `login --url <url>` first.");
  const loaded = await loadToken(store);
  if (!loaded)
    throw new Error("No credential stored. Run `login` (or set THREADLINK_BRIDGE_TOKEN).");
  if (loaded.source === "env")
    say(`warning: using ${ENV_TOKEN} from the environment (Alpha fallback).`);
  return new ThreadLinkApi({ baseUrl, token: loaded.token });
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

function buildExecutor(): Executor {
  if (values.executor === "echo") return new EchoExecutor();
  if (values.executor !== "claude") throw new Error("--executor must be claude or echo");
  const mode = values["permission-mode"] as PermissionMode;
  if (!PERMISSION_MODES.includes(mode))
    throw new Error(`--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
  return new ClaudeCodeExecutor({ cwd: workspace, permissionMode: mode, model: values.model });
}

async function main(): Promise<number> {
  const command = positionals[0];
  if (values.help || !command) {
    say(USAGE);
    return command ? 0 : 1;
  }

  if (command === "login") {
    const baseUrl = validateBaseUrl(values.url ?? process.env.THREADLINK_URL ?? "");
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
    say(
      `Stored credential in ${store.description}. Connection ${who.connectionId} (${who.platform}).`,
    );
    return 0;
  }

  if (command === "logout") {
    await store.clear();
    say(
      "Stored credential removed. Revoke the connection in the dashboard to disable it everywhere.",
    );
    return 0;
  }

  const api = await client();
  const sessionId = await ensureSession(api);

  if (command === "status") {
    const who = await api.whoami();
    say(`connection: ${who.connectionId} (${who.platform}/${who.role}, ${who.status})`);
    say(`workspace:  ${workspace}`);
    say(`session:    ${sessionId}`);
    const links = await api.links(sessionId);
    for (const l of links.filter((x) => x.status !== "revoked")) {
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

  if (command === "run") {
    const executor = buildExecutor();
    const claimRef = `bridge-${randomUUID()}`;
    const log = (m: string) => say(`[${new Date().toISOString()}] ${m}`);
    log(
      `session ${sessionId}; executor ${executor.name}; polling ${values.once ? "once" : "until Ctrl+C"}`,
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

  say(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message =
      error instanceof ApiError
        ? `ThreadLink request failed (${error.status} ${error.kind})`
        : String((error as Error)?.message ?? error);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  },
);
