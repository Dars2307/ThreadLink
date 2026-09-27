#!/usr/bin/env node
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { clearLine, cursorTo, createInterface as createLineReader } from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { ApiError, ThreadLinkApi } from "./api.ts";
import { ChatApiError, chatClientFor, type ChatApi } from "./chat-client.ts";
import { maskSessionId, NATIVE_SESSION_ID } from "./claude-sessions.ts";
import type { RuntimeEngine } from "./engine.ts";
import {
  createEngine,
  runtimeContext,
  signIn,
  signOut,
  signedInApi,
  storedBaseUrl,
  canonicalBaseUrl,
  canonicalizeBaseUrl,
  validateBaseUrl,
} from "./index.ts";
import * as runtimeModule from "./index.ts";
import { saveConfig } from "./state.ts";
import { CHAT_USAGE, isChatCommand, parseChatCommand, resolveChat } from "./tui/args.ts";
import {
  agentRowsFromLocal,
  agentRowsFromProfiles,
  formatAgents,
  formatStatus,
  runChats,
  runNew,
  type AgentRow,
} from "./tui/commands.ts";
import { ChatSession, runChatSession } from "./tui/session.ts";

const USAGE = `ThreadLink Runtime (CLI)

  threadlink                 set up (first run) or show status
  threadlink setup           sign in, choose your Claude conversation, connect ChatGPT
  threadlink run             deliver ThreadLink requests until Ctrl+C
  threadlink status          Runtime, workspaces, conversations and links

Conversations:
  threadlink sessions        list Claude conversations in this workspace
  threadlink attach [<id>]   attach an existing conversation (or --fresh)
  threadlink detach <n>      stop delivering to attached conversation n

Chats:
  threadlink chats           your chats (pinned first)
  threadlink chat "<name>"   open a chat: follow it and send messages (/quit leaves)
  threadlink new --project P --mode team [--name N]
  threadlink agents          agents on this computer and their health (--check to re-check)

Links and account:
  threadlink links           link requests waiting for approval
  threadlink approve <n>     approve link request n        threadlink decline <n>
  threadlink rotate          rotate this Runtime's credential
  threadlink logout          remove the stored credential

Options: --url <https://...>  --workspace <dir>  --permission-mode <mode>
         --model <m>  --label <name>  --once  --yes  --fresh
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    workspace: { type: "string" },
    "permission-mode": { type: "string", default: "plan" },
    model: { type: "string" },
    label: { type: "string" },
    session: { type: "string" },
    project: { type: "string" },
    mode: { type: "string" },
    name: { type: "string" },
    check: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const ctx = runtimeContext();
const workspace = resolve(values.workspace ?? process.cwd());
const say = (m = "") => stdout.write(`${m}\n`);
const tty = Boolean(stdin.isTTY);

async function ask(q: string, fallback = ""): Promise<string> {
  if (!tty || values.yes) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(q)).trim() || fallback;
  } finally {
    rl.close();
  }
}
async function confirm(q: string, defaultYes = true): Promise<boolean> {
  if (values.yes) return true;
  if (!tty) return false;
  const a = (await ask(`${q} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a === "" ? defaultYes : a === "y" || a === "yes";
}

function ago(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return s < 172800 ? "yesterday" : `${Math.round(s / 86400)} days ago`;
}

/** Opens a URL in the default browser (no shell-interpreted string). Skipped on headless/SSH. */
function openBrowser(url: string, baseUrl: string) {
  if (!url.startsWith(`${baseUrl}/`) || !/^https?:[A-Za-z0-9/:.?=_-]+$/.test(url)) return;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  if (process.env.SSH_CONNECTION) return;
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

/**
 * A generated Vercel deployment hostname is a frozen snapshot of one old
 * build, so it is upgraded to the stable address for this channel wherever it
 * comes from: --url, the stored config, or the prompt.
 */
function canonical(raw: string): string {
  const result = canonicalizeBaseUrl(raw);
  if (result.changed && result.previous) {
    process.stdout.write(
      `That address is one build's temporary URL. Using ${result.url} instead.
`,
    );
  }
  return validateBaseUrl(result.url);
}

async function baseUrl(): Promise<string> {
  if (values.url) return canonical(values.url);
  const stored = await storedBaseUrl(ctx);
  if (stored) return stored;
  const typed = await ask(`ThreadLink address [${canonicalBaseUrl()}]: `);
  return canonical(typed || canonicalBaseUrl());
}

async function ensureSignedIn(url: string): Promise<ThreadLinkApi> {
  const existing = await signedInApi(ctx);
  if (existing) return existing;
  const ok = await signIn(ctx, url, values.label ?? `Runtime on ${hostname()}`, {
    onCode: (start) => {
      say("Approve this computer in your browser:");
      say(`  ${start.verification_uri_complete}`);
      say(`  Code: ${start.user_code}`);
      openBrowser(start.verification_uri_complete, url);
      say("Waiting for approval…");
    },
    confirmAccount: (hint) =>
      hint ? confirm(`Approved by ${hint}. Use this ThreadLink account?`) : Promise.resolve(true),
  });
  if (!ok) throw new Error("Not linked; the credential was discarded.");
  say("Signed in.");
  const api = await signedInApi(ctx);
  if (!api) throw new Error("Sign-in did not complete.");
  return api;
}

function engineFor(api: ThreadLinkApi): RuntimeEngine {
  return createEngine(ctx, api, {
    kind: "cli",
    label: values.label,
    permissionMode: values["permission-mode"],
    model: values.model,
    log: (m) => say(`[${new Date().toISOString()}] ${m}`),
  });
}

async function chooseConversations(engine: RuntimeEngine) {
  const list = await engine.discoverConversations(workspace);
  say(`Claude conversations in ${workspace}:`);
  if (list.length === 0)
    say(
      "  (none yet - start Claude Code in this folder, or choose a new conversation per request)",
    );
  list.forEach((c, i) =>
    say(
      `  ${String(i + 1).padStart(2)}) ${c.title ?? "Untitled conversation"}\n      Used ${ago(c.lastUsedAt)} · ${c.runtime}${c.busy ? " · in use now" : ""}${c.attached ? " · attached" : ""}`,
    ),
  );
  say("   n) Start a new Claude conversation for each request instead");
  if (values.fresh) return engine.attach(workspace, null, null).then(() => undefined);
  if (values.session) {
    if (!NATIVE_SESSION_ID.test(values.session)) throw new Error("Not a Claude conversation ID.");
    await engine.attach(
      workspace,
      values.session,
      list.find((c) => c.nativeSessionId === values.session)?.title ?? null,
    );
    return;
  }
  if (!tty && !values.yes) return;
  const answer = (
    await ask(
      list.length ? "Choose one or more (e.g. 1 or 1,3) [1]: " : "Choose [n]: ",
      list.length ? "1" : "n",
    )
  ).toLowerCase();
  if (answer === "n") {
    await engine.attach(workspace, null, null);
    say("Each request will start a new Claude conversation.");
    return;
  }
  for (const part of answer.split(",").map((s) => Number(s.trim()))) {
    const c = list[part - 1];
    if (!c) continue;
    await engine.attach(workspace, c.nativeSessionId, c.title);
    say(
      `Attached: ${c.title ?? "Untitled conversation"}${c.busy ? " (open now - requests wait until you close it)" : ""}`,
    );
  }
}

async function approveLinks(engine: RuntimeEngine, wait: boolean): Promise<number> {
  let pending = await engine.refreshPendingLinks();
  if (!pending.length && wait && tty) {
    say(
      "In ChatGPT, say “Link this chat to Claude Code”. Waiting up to 5 minutes (Ctrl+C to skip)…",
    );
    const until = Date.now() + 5 * 60_000;
    while (!pending.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      pending = await engine.refreshPendingLinks();
    }
  }
  let approved = 0;
  for (const p of pending) {
    if (await confirm(`Link “${p.from}” to “${p.conversation}”?`)) {
      await engine.approveLink(p.linkId);
      approved++;
      say("Linked.");
    }
  }
  return approved;
}

async function runForever(engine: RuntimeEngine): Promise<number> {
  const stop = new AbortController();
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  engine.on((e) => {
    if (e.type === "snapshot") return;
    if (e.type === "task")
      say(
        `${e.outcome === "completed" ? "✓" : "✗"} ${e.title} (${e.conversation})${e.reason === "session_busy" ? " - Claude conversation is in use" : ""}`,
      );
    if (e.type === "link-request")
      say(`Link request from “${e.link.from}” - run \`threadlink links\` to approve.`);
    if (e.type === "restart-requested") say("Restart requested from ThreadLink - reconnecting.");
  });
  let last = "";
  engine.on((e) => {
    if (e.type === "snapshot" && e.snapshot.status !== last) {
      last = e.snapshot.status;
      say(`Runtime ${last}${e.snapshot.detail ? `: ${e.snapshot.detail}` : ""}`);
    }
  });
  const result = await engine.run(stop.signal);
  return result === "stopped" ? 0 : 2;
}

/** RUNTIME_PROTOCOL once the runtime engineer's export lands; null until then. */
function runtimeProtocol(): number | null {
  const value = (runtimeModule as unknown as Record<string, unknown>).RUNTIME_PROTOCOL;
  return typeof value === "number" ? value : null;
}

/** The server's "this Runtime is too old" flag, under whichever name it uses. */
function updateRequired(runtime: unknown): boolean {
  const r = (runtime ?? {}) as Record<string, unknown>;
  return r.updateRequired === true || r.update_required === true || r.outdated === true;
}

/** How many distinct agents are doing something in a running team job right now. */
function workingAgents(team: unknown): number {
  const busy = new Set<string>();
  for (const job of Array.isArray(team) ? team : []) {
    const j = job as { running?: boolean; agents?: { provider?: unknown; doing?: unknown }[] };
    if (j.running === false) continue;
    for (const a of j.agents ?? [])
      if (typeof a.provider === "string" && a.doing) busy.add(a.provider);
  }
  return busy.size;
}

/** Agent health as the server last heard it from this account's Runtime (no probe). */
async function serverAgents(api: ThreadLinkApi): Promise<AgentRow[]> {
  try {
    return agentRowsFromProfiles(await api.providerProfiles());
  } catch {
    return [];
  }
}

/** The chat client for this computer's stored credential. Never asks for, or prints, a secret. */
async function chatApi(): Promise<ChatApi> {
  const client = await chatClientFor(ctx, "terminal").catch(() => null);
  if (!client) throw new Error("Not signed in on this computer. Run `threadlink setup` first.");
  return client;
}

/** Prints above the prompt without eating what the user is typing. */
function promptSafePrinter(rl: { prompt(preserve?: boolean): void }) {
  return {
    print(lines: string[]) {
      if (tty) {
        clearLine(stdout, 0);
        cursorTo(stdout, 0);
      }
      stdout.write(`${lines.join("\n")}\n`);
      if (tty) rl.prompt(true);
    },
  };
}

async function signedInOrExplain(): Promise<ThreadLinkApi> {
  const api = await signedInApi(ctx);
  if (!api) throw new Error("Not signed in on this computer. Run `threadlink setup` first.");
  return api;
}

async function chatCommand(command: string): Promise<number> {
  const parsed = parseChatCommand(command, positionals, values);
  if (!parsed.ok) {
    say(parsed.error);
    say();
    say(CHAT_USAGE);
    return 1;
  }
  const cmd = parsed.value;
  if (cmd.command === "agents") {
    const api = await signedInOrExplain();
    let rows: AgentRow[];
    if (cmd.check) {
      say("Checking each agent with a real signed-in call...");
      rows = agentRowsFromLocal(await engineFor(api).checkProviders());
    } else {
      rows = await serverAgents(api);
    }
    for (const line of formatAgents(rows)) say(line);
    return 0;
  }
  const client = await chatApi();
  if (cmd.command === "chats") return runChats(client, say);
  if (cmd.command === "new") return runNew(client, cmd, say);
  const found = resolveChat(await client.listChats(), cmd.query);
  if (!found.ok) {
    say(found.error);
    return 1;
  }
  const detail = await client.getChat(found.value.chatId).catch(() => found.value);
  const rl = createLineReader({ input: stdin, output: stdout, terminal: tty, prompt: "> " });
  const session = new ChatSession(detail, client, promptSafePrinter(rl));
  await runChatSession(session, rl);
  return 0;
}

async function main(): Promise<number> {
  let command = positionals[0];
  if (values.help) {
    say(USAGE);
    return 0;
  }
  if (!command) command = (await signedInApi(ctx).catch(() => null)) ? "status" : "setup";

  if (command === "setup") {
    say("ThreadLink setup");
    const url = await baseUrl();
    const api = await ensureSignedIn(url);
    await saveConfig(ctx.configDir, {
      baseUrl: url,
      ...(values.label ? { label: values.label } : {}),
    });
    const engine = engineFor(api);
    const providers = await engine.detectProviders();
    const claude = providers.find((p) => p.id === "claude-code");
    say(
      claude?.available
        ? `Claude Code ${claude.version} detected.`
        : "Claude Code was not found on PATH - install it, then run setup again.",
    );
    await engine.register();
    await engine.sync();
    await chooseConversations(engine);
    await engine.heartbeat();
    say();
    say(`Connect ChatGPT (once): add a connector with this URL and sign in:\n  ${url}/mcp`);
    const linked = await approveLinks(engine, true);
    say();
    say(
      linked || (await engine.refreshPendingLinks()).length === 0
        ? "Ready."
        : "Ready (link requests still pending).",
    );
    if (tty && !values.yes && (await confirm("Start delivering requests now?")))
      return runForever(engine);
    say("Start any time with: threadlink run");
    return 0;
  }

  if (isChatCommand(command)) return chatCommand(command);

  if (command === "logout") {
    await signOut(ctx);
    say("Signed out on this machine. Revoke the Runtime in ThreadLink to disable it everywhere.");
    return 0;
  }

  const api = await signedInApi(ctx);
  if (!api) throw new Error("Not signed in. Run `threadlink setup`.");
  const engine = engineFor(api);
  await engine.loadWorkspaces();

  if (command === "run") {
    if (!values.once) return runForever(engine);
    await engine.detectProviders();
    await engine.register();
    await engine.sync();
    await engine.heartbeat();
    say(`processed ${await engine.deliverOnce()} request(s)`);
    return 0;
  }

  if (command === "status") {
    await engine.detectProviders();
    const runtime = await engine.register();
    await engine.sync();
    await engine.heartbeat();
    const snap = engine.snapshot();
    for (const line of formatStatus({
      runtimeLabel: runtime.label,
      platform: runtime.platform,
      kind: runtime.kind,
      paused: runtime.paused,
      online: snap.status === "online" || snap.status === "paused",
      lastHeartbeatAt: snap.lastHeartbeatAt,
      version: runtimeModule.RUNTIME_VERSION,
      protocol: runtimeProtocol(),
      updateRequired: updateRequired(runtime),
      agents: await serverAgents(api),
      working: workingAgents(snap.team),
    }))
      say(line);
    for (const w of snap.workspaces) {
      say(`Workspace: ${w.name} (${w.path})`);
      w.conversations.forEach((c, i) => say(`  ${i + 1}) ${c.title}${c.busy ? " · in use" : ""}`));
    }
    const pending = await engine.refreshPendingLinks();
    if (pending.length)
      say(`${pending.length} link request(s) waiting - run \`threadlink links\`.`);
    return 0;
  }

  if (command === "sessions") {
    await engine.register();
    for (const c of await engine.discoverConversations(workspace)) {
      say(
        `${c.title ?? "Untitled conversation"} · used ${ago(c.lastUsedAt)} · ${maskSessionId(c.nativeSessionId)}${c.busy ? " · in use" : ""}${c.attached ? " · attached" : ""}`,
      );
    }
    return 0;
  }

  if (command === "attach") {
    await engine.register();
    const id = positionals[1] ?? values.session;
    if (values.fresh) await engine.attach(workspace, null, null);
    else if (id) {
      if (!NATIVE_SESSION_ID.test(id)) throw new Error("Not a Claude conversation ID.");
      await engine.attach(workspace, id, null);
    } else await chooseConversations(engine);
    say("Attached.");
    return 0;
  }

  if (command === "detach") {
    const ws = engine
      .snapshot()
      .workspaces.find((w) => resolve(w.path).toLowerCase() === workspace.toLowerCase());
    const c = ws?.conversations[Number(positionals[1]) - 1];
    if (!ws || !c) throw new Error("Usage: threadlink detach <n> (see `threadlink status`)");
    await engine.detach(ws.path, c.localBindingRef);
    say(
      `Stopped delivering to “${c.title}” on this machine. Unlink it in ThreadLink to end the link.`,
    );
    return 0;
  }

  if (command === "links" || command === "approve" || command === "decline") {
    await engine.register();
    await engine.sync();
    const pending = await engine.refreshPendingLinks();
    if (command === "links") {
      if (!pending.length) say("No link requests waiting.");
      pending.forEach((p, i) => say(`  ${i + 1}) “${p.from}” → “${p.conversation}”`));
      return 0;
    }
    const p = pending[Number(positionals[1]) - 1];
    if (!p) throw new Error(`Usage: threadlink ${command} <n> (see \`threadlink links\`)`);
    if (command === "approve") await engine.approveLink(p.linkId);
    else await engine.declineLink(p.linkId);
    say(command === "approve" ? "Linked." : "Declined.");
    return 0;
  }

  if (command === "rotate") {
    const { token } = await api.rotateCredential();
    await ctx.store.save(token);
    say("Credential rotated; the previous one no longer works.");
    return 0;
  }

  say(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message =
      error instanceof ChatApiError
        ? error.status === 401
          ? "This computer's ThreadLink sign-in has expired. Run `threadlink setup`."
          : error.message
        : error instanceof ApiError
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
