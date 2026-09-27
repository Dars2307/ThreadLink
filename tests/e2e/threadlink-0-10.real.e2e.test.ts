import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import { pollDeviceToken, startDeviceLogin, ThreadLinkApi } from "../../runtime/src/api.ts";
import { ChatClient } from "../../runtime/src/chat-client.ts";
import { RuntimeEngine } from "../../runtime/src/engine.ts";
import {
  defaultAdapters,
  RUNTIME_VERSION,
  runtimeContext,
  saveConfig,
} from "../../runtime/src/index.ts";
import { discoverProviders } from "../../runtime/src/team/discovery.ts";
import { probeProvider, type ProbeFn } from "../../runtime/src/team/health.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * ThreadLink 0.10 acceptance with the REAL agents (brief §103).
 *
 * Local Supabase + the local server (:3200) + real Runtime engines + the real
 * Claude Code and Codex CLIs on the owner's subscription. Skipped unless
 * THREADLINK_REAL_AGENTS=1. Every check reads what the owner would see.
 *
 *   10 health: needs-sign-in refuses work; a stale check is never "ready"
 *   1  Solo Claude: activity, a real answer, native session provenance, model
 *   2  Solo Codex: the same, with the Codex thread
 *   3  Builder + Reviewer: Claude builds, Codex reviews, replies are linked
 *   4  Team: visible planning dialogue, roles, parallel units, cross-review,
 *      summary; 5 a note sent mid-job is queued then seen; 8 web, desktop and
 *      terminal read and write the same timeline; 9 provenance for every agent row
 *   6  Timeout: named provider, step and duration; the owner's choice is honoured
 *   7  Crash: a Runtime killed mid-job is recovered without a duplicate job
 */
const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const suite = REAL ? describe : describe.skip;
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2E010");
const MIN = 60_000;

type Row = {
  id: string;
  chat_seq: number;
  job_id: string | null;
  run_id: string | null;
  reply_to_event_id: string | null;
  author_kind: string;
  author_provider: string | null;
  author_label: string;
  author_role: string | null;
  event_type: string;
  message_type: string | null;
  model_observed: string | null;
  body: string;
  visibility: string;
  queued_for: string[] | null;
  consumed_by_run_id: string | null;
  client: string | null;
};

type Run = {
  id: string;
  job_id: string;
  provider: string;
  role: string;
  observed_model: string | null;
  model_verified: boolean;
  access: string | null;
  access_verified: boolean;
  native_session_id: string | null;
  native_session_kind: string | null;
  status: string;
  runtime_id: string | null;
};

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let api: ThreadLinkApi;
let token: string;
let engine: RuntimeEngine;
let root: string;
let repo: string;
let configDir: string;
let prism: string;
let ownerId: string;
const clients: Client[] = [];

const realProbe = probeProvider();
let simulateClaudeSignedOut = false;
const probe: ProbeFn = async (provider, found) =>
  simulateClaudeSignedOut && provider === "claude-code"
    ? "not_authenticated"
    : realProbe(provider, found);

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

function newEngine() {
  return new RuntimeEngine({
    api,
    configDir,
    adapters: defaultAdapters(),
    identity: { label: "Acceptance PC", platform: "windows", kind: "desktop" },
    version: RUNTIME_VERSION,
    discoverTeam: discoverProviders,
    probeProvider: probe,
    log: (m) => console.log(`[runtime] ${m}`),
  });
}

async function fresh() {
  ownerDb = await userClient(A);
  return ownerDb;
}

async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>) {
  const { data, error } = await (await fresh()).rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message} (${error.hint})`);
  return data as T;
}

async function rows(chatId: string, job?: string): Promise<Row[]> {
  let q = (await fresh())
    .from("chat_events")
    .select(
      "id, chat_seq, job_id, run_id, reply_to_event_id, author_kind, author_provider, author_label, author_role, event_type, message_type, model_observed, body, visibility, queued_for, consumed_by_run_id, client",
    )
    .eq("chat_id", chatId)
    .order("chat_seq");
  if (job) q = q.eq("job_id", job);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as Row[];
}

async function runs(job: string): Promise<Run[]> {
  // Owners cannot read agent_runs directly (native session ids are revealed
  // only through the audited owner function), so the test reads the evidence
  // with the service client, scoped to this test's owner.
  const { data, error } = await admin
    .from("agent_runs")
    .select(
      "id, job_id, provider, role, observed_model, model_verified, access, access_verified, native_session_id, native_session_kind, status, runtime_id",
    )
    .eq("job_id", job)
    .eq("owner_user_id", ownerId)
    .order("started_at");
  if (error) throw new Error(error.message);
  return data as Run[];
}

function show(title: string, list: Row[]) {
  console.log(
    `\n===== ${title} =====\n` +
      list
        .filter((r) => r.visibility !== "technical")
        .map(
          (r) =>
            `${r.author_label}${r.author_role ? ` · ${r.author_role}` : ""}${r.model_observed ? ` [${r.model_observed}]` : ""} (${r.event_type}${r.message_type ? `/${r.message_type}` : ""}${r.reply_to_event_id ? " ↩" : ""}): ${r.body.slice(0, 220).replace(/\n/g, " ⏎ ")}`,
        )
        .join("\n"),
  );
}

async function newChat(name: string, mode: string, extra: Record<string, unknown> = {}) {
  const chat = await rpc<{ chat_id: string }>("create_chat", {
    p_name: name,
    p_room_id: prism,
    p_mode: mode,
  });
  if (Object.keys(extra).length) await rpc("update_chat", { p_chat_id: chat.chat_id, ...extra });
  return chat.chat_id;
}

async function post(chatId: string, body: string) {
  return rpc<{ routed: string; job_id: string | null }>("post_chat_message", {
    p_chat_id: chatId,
    p_body: body,
    p_idempotency_key: null,
  });
}

async function job(jobId: string) {
  const { data } = await (
    await fresh()
  )
    .from("team_jobs")
    .select("status, verdict, verdict_reason, summary, mode, chat_id")
    .eq("id", jobId)
    .single();
  return data!;
}

async function runJob(jobId: string) {
  for (let i = 0; i < 5; i++) {
    await engine.deliverOnce();
    const j = await job(jobId);
    if (j.verdict || ["failed", "cancelled"].includes(j.status)) return j;
  }
  throw new Error("the job never finished");
}

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15 * MIN,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Every agent row is tied to a real, verified run of the same provider in this job. */
async function expectProvenance(list: Row[], jobId: string) {
  const byId = new Map((await runs(jobId)).map((r) => [r.id, r]));
  const agentRows = list.filter((r) => r.author_kind === "agent");
  expect(agentRows.length).toBeGreaterThan(0);
  for (const r of agentRows) {
    expect(r.run_id, `agent row without a run: ${r.body.slice(0, 80)}`).toBeTruthy();
    const run = byId.get(r.run_id!);
    expect(run, "the run belongs to this job").toBeTruthy();
    expect(run!.provider).toBe(r.author_provider);
    expect(run!.native_session_id, `${run!.provider} native session recorded`).toBeTruthy();
    expect(run!.observed_model).toBeTruthy();
    expect(run!.model_verified).toBe(true);
    expect(run!.status).toBe("completed");
  }
  return byId;
}

suite("ThreadLink 0.10 with the real agents", () => {
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
      throw new Error("e2e must target a local server");
    }
    if (!(await fetch(BASE_URL).catch(() => null)))
      throw new Error("Start the server: npm run dev:local-db");

    root = mkdtempSync(join(tmpdir(), "tl-010-real-"));
    configDir = join(root, "cfg");
    repo = join(root, "Prism");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "package.json"), '{ "name": "prism", "private": true }\n');
    writeFileSync(
      join(repo, "README.md"),
      "# Prism\n\nA tiny arithmetic library used to test ThreadLink.\n",
    );
    writeFileSync(
      join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "for (const [file, fn, args, want] of [",
        "  ['./sub.js', 'sub', [9, 4], 5], ['./div.js', 'div', [8, 2], 4],",
        "  ['./neg.js', 'neg', [3], -3], ['./sq.js', 'sq', [6], 36]]) {",
        "  if (!fs.existsSync(file)) continue;",
        "  assert.strictEqual(require(file)[fn](...args), want, file);",
        "}",
        "console.log('prism tests passed');",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, "AGENTS.md"), "Plain CommonJS. No dependencies.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");

    await fresh();
    ownerId = (
      await provisionThreadLinkUser(identity(A), { displayName: null, primaryEmail: null }, ownerDb)
    ).id;
    const start = await startDeviceLogin(BASE_URL, "Acceptance PC");
    await ownerDb.rpc("decide_device_authorization", {
      p_user_code: start.user_code.replace("-", ""),
      p_approve: true,
    });
    token = (await pollDeviceToken(BASE_URL, start, { sleep: async () => {} })).access_token;
    api = new ThreadLinkApi({ baseUrl: BASE_URL, token });
    // The stored credential lets a separate Runtime process (test 7) and the
    // terminal/desktop chat client use this device, as the real app does.
    const ctx = runtimeContext(configDir);
    await ctx.store.save(token);
    await saveConfig(configDir, { baseUrl: BASE_URL });
    engine = newEngine();
    await engine.detectProviders();
    await engine.register();
    await engine.heartbeat();
    await engine.checkProviders();
    await engine.attach(repo, null, "Prism", "fresh");

    const db = await fresh();
    const user = await provisionThreadLinkUser(
      identity(A),
      { displayName: null, primaryEmail: null },
      db,
    );
    const { credential } = await registerConnection(
      db,
      user,
      { platform: "chatgpt", displayName: "Acceptance chat" },
      TEST_CONNECTION_SECRET,
    );
    const client = new Client({ name: "threadlink-e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
      }),
    );
    clients.push(client);
    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name: tool, arguments: args });
      if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.content)}`);
      return res.structuredContent as Record<string, unknown>;
    };
    const sessionId = (await call("ensure_session", { label: "Acceptance chat" }))
      .sessionId as string;
    const options = await call("link_to_claude", { sessionId });
    const target = (options.options as { agentSessionId: string; name: string }[]).find(
      (o) => o.name === "Prism",
    )!;
    await call("link_to_claude", { sessionId, agentSessionId: target.agentSessionId });
    for (const p of await engine.refreshPendingLinks()) await engine.approveLink(p.linkId);
    prism = ((await call("create_room", { sessionId, name: "Prism" })).room as { roomId: string })
      .roomId;
    await rpc("update_room_policy", {
      p_room_id: prism,
      p_usage_policy: "conservative",
      p_max_review_rounds: 3,
      p_verify_commands: ["node test.js"],
    });
  }, 10 * MIN);

  beforeEach(async () => {
    await fresh();
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    // Windows can hold a worktree lock for a moment after git exits.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
    } catch (error) {
      console.log(`cleanup left files behind: ${(error as Error).message}`);
    }
    await admin.from("users").delete().eq("clerk_user_id", A);
  });

  it(
    "10: health — needs sign-in refuses work; a stale check is never shown as ready",
    async () => {
      const chatId = await newChat("Health check", "team");
      simulateClaudeSignedOut = true;
      try {
        await engine.checkProviders();
        const sent = await post(chatId, "@team Review Prism.");
        expect(sent.routed).toBe("provider_blocked");
        expect(sent.job_id).toBeNull();
        const blocked = (await rows(chatId)).find((r) => r.event_type === "provider_blocked");
        expect(blocked?.body).toMatch(/Claude Code needs you to sign in again/);
      } finally {
        // Never leave the simulated sign-out behind for the next test.
        simulateClaudeSignedOut = false;
      }
      await engine.checkProviders();

      // Age the stored check by three hours: the server must not call it ready.
      await admin
        .from("runtime_provider_health")
        .update({
          checked_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
          received_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        })
        .eq("provider", "codex");
      // No client role may write provider health (not even the service role),
      // so the local test database is aged directly.
      execFileSync(
        "docker",
        [
          "exec",
          "supabase_db_threadlink",
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          `update public.runtime_provider_health set checked_at = now() - interval '3 hours', received_at = now() - interval '3 hours' where owner_user_id = '${ownerId}' and provider = 'codex'`,
        ],
        { windowsHide: true },
      );
      const stale = await post(chatId, "@codex Say hello.");
      expect(stale.routed).toBe("provider_blocked");
      await engine.checkProviders();
    },
    20 * MIN,
  );

  it(
    "1: Solo Claude — a real answer with native session provenance and the observed model",
    async () => {
      const chatId = await newChat("Claude solo verification", "solo", {
        p_solo_provider: "claude-code",
      });
      const sent = await post(
        chatId,
        "Inspect README.md and explain in two sentences what this project is. Do not edit any files.",
      );
      const j = await runJob(sent.job_id!);
      const list = await rows(chatId, sent.job_id!);
      show("1 Solo Claude", list);
      expect(j.mode).toBe("solo");
      const byId = await expectProvenance(list, sent.job_id!);
      const answer = list.find(
        (r) => r.author_kind === "agent" && r.author_provider === "claude-code",
      );
      expect(answer?.body.length).toBeGreaterThan(20);
      expect(byId.get(answer!.run_id!)!.native_session_kind).toBe("claude_session");
      expect(answer!.model_observed).toMatch(/^claude-/);
    },
    30 * MIN,
  );

  it(
    "2: Solo Codex — the same, with the Codex thread",
    async () => {
      const chatId = await newChat("Codex solo verification", "solo", { p_solo_provider: "codex" });
      const sent = await post(
        chatId,
        "Inspect README.md and explain in two sentences what this project is. Do not edit any files.",
      );
      await runJob(sent.job_id!);
      const list = await rows(chatId, sent.job_id!);
      show("2 Solo Codex", list);
      const byId = await expectProvenance(list, sent.job_id!);
      const answer = list.find((r) => r.author_kind === "agent" && r.author_provider === "codex");
      expect(answer?.body.length).toBeGreaterThan(20);
      expect(byId.get(answer!.run_id!)!.native_session_kind).toBe("codex_thread");
    },
    30 * MIN,
  );

  it(
    "3: Builder + Reviewer — Claude builds, Codex reviews, the review replies to the build",
    async () => {
      const chatId = await newChat("Pair verification", "pair", {
        p_builder_provider: "claude-code",
        p_reviewer_provider: "codex",
      });
      const sent = await post(
        chatId,
        "Create sub.js exporting sub(a, b) returning a - b (CommonJS).",
      );
      const j = await runJob(sent.job_id!);
      const list = await rows(chatId, sent.job_id!);
      show("3 Builder + Reviewer", list);
      await expectProvenance(list, sent.job_id!);
      const build = list.find(
        (r) => r.author_provider === "claude-code" && r.author_role === "builder",
      );
      const review = list.find(
        (r) => r.author_provider === "codex" && r.author_role === "reviewer",
      );
      expect(build).toBeTruthy();
      expect(review).toBeTruthy();
      expect(review!.reply_to_event_id, "the review replies to the build").toBeTruthy();
      expect(list.some((r) => r.event_type === "code_change")).toBe(true);
      expect(list.some((r) => r.event_type === "job_summary")).toBe(true);
      expect(j.verdict, j.summary ?? "").toBe("PASS");
    },
    45 * MIN,
  );

  it(
    "4/5/8/9: Team — visible planning dialogue, a mid-job note, three clients, provenance",
    async () => {
      const chatId = await newChat("Prism Review", "team");
      const sent = await post(
        chatId,
        "Add two independent CommonJS modules, each exporting an object with one named function, " +
          "exactly as test.js requires: div.js with module.exports = { div } where div(a, b) returns a / b, " +
          "and neg.js with module.exports = { neg } where neg(a) returns -a. They do not depend on each other.",
      );
      const jobId = sent.job_id!;
      const running = engine.deliverOnce();

      // 5 + 8: while the team works, the owner sends a note from the TERMINAL client.
      await until("the first agent run", async () => (await runs(jobId)).length > 0);
      const terminal = new ChatClient({
        baseUrl: BASE_URL,
        token,
        client: "terminal",
        timeoutMs: 180_000,
      });
      const note = await terminal.post(
        chatId,
        "@team Please also start each new file with a one-line comment saying what it does.",
        `note-${Date.now()}`,
      );
      expect(note.ok, JSON.stringify(note)).toBe(true);

      await running;
      const j = await runJob(jobId);
      const list = await rows(chatId, jobId);
      const all = await rows(chatId);
      show("4 Team", all);

      // 4: real planning dialogue, not status lines.
      const agentMsgs = list.filter((r) => r.author_kind === "agent");
      const proposals = agentMsgs.filter((r) => r.message_type === "proposal");
      const reviews = agentMsgs.filter((r) => r.message_type === "review");
      expect(proposals.length, "a plan proposal from an agent").toBeGreaterThan(0);
      expect(
        reviews.some((r) => r.reply_to_event_id),
        "a review that replies",
      ).toBe(true);
      expect(new Set(agentMsgs.map((r) => r.author_provider))).toEqual(
        new Set(["claude-code", "codex"]),
      );
      expect(list.some((r) => r.event_type === "decision_card")).toBe(true);
      expect(list.some((r) => r.event_type === "job_summary")).toBe(true);
      expect(list.some((r) => r.event_type === "phase")).toBe(true);
      expect(j.verdict, j.summary ?? "").toBe("PASS");

      // 9: every agent row maps to a real, verified run.
      await expectProvenance(list, jobId);

      // 5: the note was queued for the team, then seen by a real run.
      const noteRow = all.find((r) => r.author_kind === "owner" && r.client === "terminal");
      expect(noteRow, "the terminal note is in the timeline").toBeTruthy();
      expect(noteRow!.consumed_by_run_id, "seen by a real agent run").toBeTruthy();

      // 8: web (owner, RLS) and desktop/terminal (Runtime chat API) see the same timeline.
      const desktop = new ChatClient({
        baseUrl: BASE_URL,
        token,
        client: "desktop",
        timeoutMs: 180_000,
      });
      const page = await desktop.events(chatId, { after: 0, limit: 200 });
      const visibleWeb = all.filter((r) => r.visibility === "visible").map((r) => r.chat_seq);
      const viaApi = page.events.map((e) => e.seq);
      for (const seq of visibleWeb.slice(0, 50)) expect(viaApi).toContain(seq);

      // The report artifact exists for the job.
      const { data: artifacts } = await (
        await fresh()
      )
        .from("chat_artifacts")
        .select("kind, title")
        .eq("job_id", jobId);
      expect(artifacts!.some((a) => a.kind === "report")).toBe(true);
    },
    75 * MIN,
  );

  it(
    "6: Timeout — named provider, step and duration; stop is honoured",
    async () => {
      await rpc("set_room_step_timeouts", { p_room_id: prism, p_timeouts: { build: 2 } });
      try {
        const chatId = await newChat("Timeout check", "solo", { p_solo_provider: "codex" });
        const sent = await post(
          chatId,
          'First run the shell command `node -e "setTimeout(()=>{},300000)"` and wait for it to ' +
            "finish. Only then create sq.js exporting sq(a) returning a * a.",
        );
        const jobId = sent.job_id!;
        const working = engine.deliverOnce();
        const choice = await until(
          "a timeout choice",
          async () => {
            const { data } = await (
              await fresh()
            )
              .from("user_choices")
              .select("id, kind, options, status")
              .eq("job_id", jobId)
              .eq("kind", "timeout");
            return data?.[0] ?? null;
          },
          20 * MIN,
        );
        const list = await rows(chatId, jobId);
        show("6 Timeout", list);
        const line = list.find((r) => r.event_type === "timeout");
        expect(line?.body).toMatch(/Codex timed out after 2 min/);
        expect((await runs(jobId)).some((r) => r.status === "timed_out")).toBe(true);
        const keys = (choice.options as { key: string }[]).map((o) => o.key);
        expect(keys).toContain("stop");
        await rpc("decide_choice", { p_choice_id: choice.id, p_key: "stop" });
        await working;
        const j = await runJob(jobId);
        expect(j.verdict).not.toBe("PASS");
      } finally {
        await rpc("set_room_step_timeouts", { p_room_id: prism, p_timeouts: {} });
      }
    },
    45 * MIN,
  );

  it(
    "7: Crash — a Runtime killed mid-job is recovered without a duplicate job",
    async () => {
      const chatId = await newChat("Crash check", "solo", { p_solo_provider: "claude-code" });
      const child: ChildProcess = spawn(
        process.execPath,
        [join(process.cwd(), "runtime", "src", "cli.ts"), "run"],
        {
          env: { ...process.env, THREADLINK_CONFIG_DIR: configDir, THREADLINK_URL: BASE_URL },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      child.stdout?.on("data", (d) => process.stdout.write(`[child] ${d}`));
      child.stderr?.on("data", (d) => process.stdout.write(`[child!] ${d}`));
      try {
        const sent = await post(chatId, "Create neg.js exporting neg(a) returning -a (CommonJS).");
        const jobId = sent.job_id!;
        await until(
          "an agent run in the child Runtime",
          async () => (await runs(jobId)).some((r) => r.status === "running"),
          10 * MIN,
        );
        // Crash: kill the Runtime process tree (it and the agent it launched).
        // taskkill reports an error for children that are already gone; what
        // matters is that the Runtime process itself is dead afterwards.
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          /* checked below */
        }
        await until(
          "the Runtime process to exit",
          async () => child.exitCode !== null || child.signalCode !== null,
          MIN,
        );

        const { count: before } = await (
          await fresh()
        )
          .from("team_jobs")
          .select("id", { count: "exact", head: true })
          .eq("chat_id", chatId);
        // A restarted Runtime starts the way the app does.
        engine = newEngine();
        await engine.detectProviders();
        await engine.register();
        await engine.sync();
        await engine.heartbeat();
        const recovery = await engine.recoverTeamJobs();
        console.log("Recovery:", JSON.stringify(recovery));
        expect(recovery.find((r) => r.jobId === jobId)?.classification).toBe("interrupted");
        // The dead Runtime's lease lapses (5 min). This Runtime keeps polling, as
        // the real app does; a poll sweeps the expired lease, claims the job
        // again, and must hand it to the owner instead of re-running the build.
        let polling = true;
        const working = (async () => {
          while (polling) {
            await engine.deliverOnce();
            if (polling) await new Promise((r) => setTimeout(r, 15_000));
          }
        })();
        const pending = await until(
          "the job to be handed to the owner",
          async () => {
            const j = await job(jobId);
            if (!["interrupted", "paused"].includes(j.status)) return null;
            const { data } = await (
              await fresh()
            )
              .from("user_choices")
              .select("id, kind, status")
              .eq("job_id", jobId)
              .eq("kind", "interrupted")
              .eq("status", "pending");
            return data?.length ? data : null;
          },
          15 * MIN,
        );
        const { count: after } = await (
          await fresh()
        )
          .from("team_jobs")
          .select("id", { count: "exact", head: true })
          .eq("chat_id", chatId);
        expect(after).toBe(before);
        // The build that was running when the Runtime died never ran again.
        const builds = (await runs(jobId)).filter((r) => r.role === "builder");
        expect(builds.filter((r) => r.status === "running")).toHaveLength(0);
        for (const c of pending) await rpc("decide_choice", { p_choice_id: c.id, p_key: "stop" });
        polling = false;
        await working;
        const j = await job(jobId);
        expect(j.verdict).not.toBe("PASS");
        const list = await rows(chatId, jobId);
        show("7 Crash", list);
        expect(list.some((r) => r.event_type === "interrupted" || r.event_type === "choice")).toBe(
          true,
        );
        // History preserved.
        expect(list.some((r) => r.author_kind === "owner")).toBe(true);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
    30 * MIN,
  );
});
