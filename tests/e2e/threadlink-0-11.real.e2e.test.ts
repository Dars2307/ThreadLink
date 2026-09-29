import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * ThreadLink 0.11 acceptance with the REAL agents (phase brief §66, run locally).
 *
 * Local Supabase + the local server (:3200) + a real Runtime engine running its
 * own loop (heartbeat timer, wake long-poll, concurrent lanes) + the real Claude
 * Code and Codex CLIs on the owner's subscription. Skipped unless
 * THREADLINK_REAL_AGENTS=1. Codex may be out of included usage; the tests then
 * check that ThreadLink fails over honestly instead of pretending.
 *
 *   A  "@team hi" is Fast Chat: agents answer, no plan, no worktree, no verdict
 *   B  a discussion question is Fast Chat, answered from the real project
 *   C  quota failover: an exhausted reviewer is reported, work continues, never PASS
 *   D  "@Claude continue" answers an open usage choice
 *   E  presence stays online/working while work runs (never offline)
 *   F  heavy work still runs the engineering lane to a verified result
 *   G  a chat question is answered while engineering work is still running
 *
 * THREADLINK_E2E_OWNER_CLERK_ID makes a signed-in local account the owner, so
 * the chats can be looked at in the browser afterwards (that user is kept).
 */
const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const suite = REAL ? describe : describe.skip;
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const KEEP_OWNER = Boolean(process.env.THREADLINK_E2E_OWNER_CLERK_ID);
const A = process.env.THREADLINK_E2E_OWNER_CLERK_ID ?? uniqueClerkId("E2E011");
const MIN = 60_000;
// A kept owner accumulates projects across runs; each run gets its own.
const PROJECT = KEEP_OWNER ? `Prism ${new Date().toISOString().slice(11, 16)}` : "Prism";

type Row = {
  id: string;
  chat_seq: number;
  job_id: string | null;
  run_id: string | null;
  author_kind: string;
  author_provider: string | null;
  author_label: string;
  event_type: string;
  body: string;
  visibility: string;
  created_at: string;
};

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let api: ThreadLinkApi;
let engine: RuntimeEngine;
let loop: AbortController;
let loopDone: Promise<unknown>;
let chat: ChatClient;
let root: string;
let repo: string;
let configDir: string;
let prism: string;
const clients: Client[] = [];
const report: string[] = [];
let keys = 0;
const say = (chatId: string, body: string) =>
  chat.post(chatId, body, `e2e011-${Date.now()}-${++keys}`);

// Simulated exhaustion (brief §66 C: "simulate or use"): the health probe
// reports Codex out of included usage, exactly as the real CLI's quota
// failure is classified; everything after that is the real flow.
let simulateCodexExhausted = false;
const realProbe = probeProvider();
const probe: ProbeFn = async (provider, found) =>
  simulateCodexExhausted && provider === "codex" ? "quota_exhausted" : realProbe(provider, found);

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

async function fresh() {
  ownerDb = await userClient(A);
  return ownerDb;
}

async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>) {
  const { data, error } = await (await fresh()).rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message} (${error.hint})`);
  return data as T;
}

async function rows(chatId: string): Promise<Row[]> {
  const { data, error } = await (
    await fresh()
  )
    .from("chat_events")
    .select(
      "id, chat_seq, job_id, run_id, author_kind, author_provider, author_label, event_type, body, visibility, created_at",
    )
    .eq("chat_id", chatId)
    .order("chat_seq");
  if (error) throw new Error(error.message);
  return data as Row[];
}

async function job(jobId: string) {
  const { data } = await admin
    .from("team_jobs")
    .select("status, verdict, lane, mode, finished_at, created_at")
    .eq("id", jobId)
    .single();
  return data as {
    status: string;
    verdict: string | null;
    lane: string;
    mode: string;
    finished_at: string | null;
    created_at: string;
  };
}

async function runsOf(jobId: string) {
  const { data } = await admin
    .from("agent_runs")
    .select("provider, role, status, failure, started_at, finished_at, timings, model_verified")
    .eq("job_id", jobId)
    .order("started_at");
  return (data ?? []) as {
    provider: string;
    role: string;
    status: string;
    failure: string | null;
    started_at: string;
    finished_at: string | null;
    timings: Record<string, number> | null;
    model_verified: boolean;
  }[];
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
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function newChat(name: string, mode: string, extra: Record<string, unknown> = {}) {
  const c = await rpc<{ chat_id: string }>("create_chat", {
    p_name: name,
    p_room_id: prism,
    p_mode: mode,
  });
  if (Object.keys(extra).length) await rpc("update_chat", { p_chat_id: c.chat_id, ...extra });
  return c.chat_id;
}

const finished = (jobId: string, ms = 20 * MIN) =>
  until(`job ${jobId}`, async () => ((await job(jobId)).finished_at ? job(jobId) : null), ms);

const seconds = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;

function show(title: string, list: Row[]) {
  const text =
    `\n===== ${title} =====\n` +
    list
      .filter((r) => r.visibility !== "technical")
      .map(
        (r) =>
          `${r.created_at.slice(11, 19)} ${r.author_label} (${r.event_type}): ${r.body.slice(0, 200).replace(/\n/g, " ⏎ ")}`,
      )
      .join("\n");
  console.log(text);
  report.push(text);
}

suite("ThreadLink 0.11 with the real agents", () => {
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
      throw new Error("e2e must target a local server");
    }
    if (!(await fetch(BASE_URL).catch(() => null)))
      throw new Error("Start the server: npm run dev:local-db");

    root = mkdtempSync(join(tmpdir(), "tl-011-real-"));
    configDir = join(root, "cfg");
    repo = join(root, "Prism");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "package.json"), '{ "name": "prism", "private": true }\n');
    writeFileSync(
      join(repo, "README.md"),
      "# Prism\n\nA tiny arithmetic library used to test ThreadLink.\nEach operation lives in its own CommonJS file; test.js checks them.\n",
    );
    writeFileSync(
      join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "for (const [file, fn, args, want] of [",
        "  ['./sub.js', 'sub', [9, 4], 5], ['./neg.js', 'neg', [3], -3]]) {",
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
    await provisionThreadLinkUser(identity(A), { displayName: null, primaryEmail: null }, ownerDb);
    const start = await startDeviceLogin(BASE_URL, "Acceptance PC");
    await ownerDb.rpc("decide_device_authorization", {
      p_user_code: start.user_code.replace("-", ""),
      p_approve: true,
    });
    const token = (await pollDeviceToken(BASE_URL, start, { sleep: async () => {} })).access_token;
    api = new ThreadLinkApi({ baseUrl: BASE_URL, token });
    const ctx = runtimeContext(configDir);
    await ctx.store.save(token);
    await saveConfig(configDir, { baseUrl: BASE_URL });
    chat = new ChatClient({ baseUrl: BASE_URL, token, client: "terminal", timeoutMs: 180_000 });
    engine = new RuntimeEngine({
      api,
      configDir,
      adapters: defaultAdapters(),
      identity: { label: "Nickron PC", platform: "windows", kind: "desktop" },
      version: RUNTIME_VERSION,
      discoverTeam: discoverProviders,
      probeProvider: probe,
      log: (m) => console.log(`[runtime] ${m}`),
    });
    await engine.detectProviders();
    await engine.register();
    await engine.heartbeat();
    await engine.checkProviders();
    await engine.attach(repo, null, PROJECT, "fresh");

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
      (o) => o.name === PROJECT,
    )!;
    await call("link_to_claude", { sessionId, agentSessionId: target.agentSessionId });
    for (const p of await engine.refreshPendingLinks()) await engine.approveLink(p.linkId);
    prism = ((await call("create_room", { sessionId, name: PROJECT })).room as { roomId: string })
      .roomId;
    await rpc("update_room_policy", {
      p_room_id: prism,
      p_usage_policy: "conservative",
      p_max_review_rounds: 2,
      p_verify_commands: ["node test.js"],
    });
    await rpc("set_failover_policy", { p_policy: "auto" });

    // The Runtime runs its real loop from here on: heartbeat timer, wake
    // long-poll and concurrent lanes, exactly as the desktop app runs it.
    loop = new AbortController();
    loopDone = engine.run(loop.signal);
  }, 10 * MIN);

  afterAll(async () => {
    loop?.abort();
    await loopDone?.catch(() => {});
    for (const c of clients) await c.close().catch(() => {});
    console.log(report.join("\n"));
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
    } catch (error) {
      console.log(`cleanup left files behind: ${(error as Error).message}`);
    }
    if (!KEEP_OWNER) await admin.from("users").delete().eq("clerk_user_id", A);
  });

  it(
    "A: '@team hi' is Fast Chat — agents answer, no plan, no worktree, no verdict",
    async () => {
      const chatId = await newChat("Prism Review", "team");
      const worktreesBefore = git("worktree", "list").split("\n").length;
      const sent = await say(chatId, "@team hi");
      expect(sent.ok).toBe(true);
      const jobId = (sent as { jobId: string | null }).jobId!;
      const j = await finished(jobId, 10 * MIN);
      expect(j.lane).toBe("chat");
      expect(j.verdict).toBeNull();
      const list = await rows(chatId);
      show("A: @team hi", list);
      const owner = list.find((r) => r.author_kind === "owner")!;
      const agents = list.filter((r) => r.author_kind === "agent");
      const claude = agents.find((r) => r.author_provider === "claude-code");
      expect(claude, "Claude answered").toBeTruthy();
      const codexAnswered = agents.some((r) => r.author_provider === "codex");
      const codexFailover = list.some((r) => r.event_type === "failover");
      expect(codexAnswered || codexFailover, "Codex answered or its exhaustion was said").toBe(
        true,
      );
      // No engineering machinery in the chat.
      for (const t of ["phase", "unit_status", "job_verdict", "plan_agreed", "code_change"])
        expect(
          list.some((r) => r.event_type === t),
          t,
        ).toBe(false);
      const { count } = await admin
        .from("team_nodes")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId);
      expect(count ?? 0).toBe(0);
      expect(git("worktree", "list").split("\n").length).toBe(worktreesBefore);
      const first = agents[0]!;
      report.push(
        `A timings: first agent answer ${seconds(owner.created_at, first.created_at).toFixed(1)} s after the post; job total ${seconds(j.created_at, j.finished_at!).toFixed(1)} s; Codex ${codexAnswered ? "answered" : "exhausted (failover said)"}`,
      );
      const r = await runsOf(jobId);
      report.push(
        `A runs: ${JSON.stringify(r.map((x) => [x.provider, x.status, x.failure, x.timings]))}`,
      );
    },
    12 * MIN,
  );

  it(
    "B: a discussion question stays Fast Chat and is answered from the project",
    async () => {
      const chatId = await newChat("Prism architecture", "team");
      const sent = await say(
        chatId,
        "@team what do you think are the biggest risks in Prism's current architecture? Keep it to a few sentences.",
      );
      const jobId = (sent as { jobId: string | null }).jobId!;
      const j = await finished(jobId, 12 * MIN);
      expect(j.lane).toBe("chat");
      const list = await rows(chatId);
      show("B: discussion", list);
      const agents = list.filter((r) => r.author_kind === "agent");
      expect(agents.length).toBeGreaterThan(0);
      expect(agents.some((r) => /test|file|CommonJS|arithmetic|module/i.test(r.body))).toBe(true);
      const owner = list.find((r) => r.author_kind === "owner")!;
      report.push(
        `B timings: first answer ${seconds(owner.created_at, agents[0]!.created_at).toFixed(1)} s; ${agents.length} agent message(s)`,
      );
    },
    14 * MIN,
  );

  it(
    "C+E+G: pair work with an exhausted reviewer fails over honestly; presence never offline; a chat question is answered mid-work",
    async () => {
      const chatId = await newChat("Prism sub", "pair", {
        p_builder_provider: "claude-code",
        p_reviewer_provider: "codex",
      });
      const sent = await say(
        chatId,
        "Add sub.js exporting sub(a, b) that returns a - b, then run the tests.",
      );
      const jobId = (sent as { jobId: string | null }).jobId!;
      expect((await job(jobId)).lane).toBe("work");

      // G: while the work runs, a question in another chat is answered.
      const askId = await newChat("Quick question", "solo", { p_solo_provider: "claude-code" });
      await until("the work job to be running", async () => (await runsOf(jobId)).length > 0);
      const asked = await say(askId, "@claude What is 7 times 6? Answer with the number.");
      const askJob = (asked as { jobId: string | null }).jobId!;
      const aj = await finished(askJob, 8 * MIN);
      expect(aj.lane).toBe("chat");
      const workStill = await job(jobId);
      const answeredWhileWorking = !workStill.finished_at;
      report.push(
        `G: chat answer arrived while the work job was ${answeredWhileWorking ? "still running" : "already finished"}`,
      );

      // E: sample presence until the work finishes.
      const seen = new Set<string>();
      const j = await until(
        "work job",
        async () => {
          const status = await rpc<{ runtime: { presence: string } | null }>("chat_host_status", {
            p_chat_id: chatId,
          });
          if (status.runtime) seen.add(status.runtime.presence);
          const cur = await job(jobId);
          return cur.finished_at ? cur : null;
        },
        25 * MIN,
      );
      report.push(`E: presence seen while working: ${[...seen].join(", ")}`);
      expect(seen.has("offline")).toBe(false);

      const list = await rows(chatId);
      show("C: pair work", list);
      const runs = await runsOf(jobId);
      const codexReviewed = runs.some(
        (r) => r.provider === "codex" && r.role === "reviewer" && r.status === "completed",
      );
      if (!codexReviewed) {
        // Codex could not review: the chat says so, and the result is not PASS.
        expect(list.some((r) => r.event_type === "failover")).toBe(true);
        expect(j.verdict).not.toBe("PASS");
        report.push(
          `C: Codex unavailable → failover said, verdict ${j.verdict}, status ${j.status}`,
        );
      } else {
        report.push(`C: Codex reviewed → verdict ${j.verdict}`);
      }
      report.push(
        `C runs: ${JSON.stringify(runs.map((r) => [r.provider, r.role, r.status, r.failure, r.started_at.slice(11, 19), r.finished_at?.slice(11, 19)]))}`,
      );
    },
    40 * MIN,
  );

  it(
    "D: '@Claude continue' answers an open usage choice",
    async () => {
      await rpc("set_failover_policy", { p_policy: "ask" });
      try {
        const chatId = await newChat("Prism neg", "pair", {
          p_builder_provider: "claude-code",
          p_reviewer_provider: "codex",
        });
        const sent = await say(
          chatId,
          "Add neg.js exporting neg(x) that returns -x, then run the tests.",
        );
        const jobId = (sent as { jobId: string | null }).jobId!;
        const choice = await until(
          "a usage choice, or the job to end",
          async () => {
            const { data } = await admin
              .from("user_choices")
              .select("id, kind, status")
              .eq("job_id", jobId)
              .in("kind", ["usage_exhausted", "provider_failure"])
              .eq("status", "pending");
            if (data?.length) return data[0] as { id: string; kind: string };
            const cur = await job(jobId);
            return cur.finished_at ? { id: "", kind: "none" } : null;
          },
          25 * MIN,
        );
        if (choice.kind === "none") {
          report.push("D: Codex was available — no usage choice was needed (not exercised)");
          return;
        }
        const answer = await say(chatId, "@Claude continue");
        expect((answer as { routed?: string }).routed).toBe("choice_resolved");
        const { data: decided } = await admin
          .from("user_choices")
          .select("status, chosen_key")
          .eq("id", choice.id)
          .single();
        expect(decided?.status).toBe("chosen");
        report.push(`D: '@Claude continue' resolved ${choice.kind} → ${decided?.chosen_key}`);
        const j = await finished(jobId, 25 * MIN);
        expect(j.verdict).not.toBe("PASS");
        show("D: natural continue", await rows(chatId));
      } finally {
        await rpc("set_failover_policy", { p_policy: "auto" });
      }
    },
    55 * MIN,
  );

  it(
    "F: solo engineering work still runs to a verified result",
    async () => {
      const chatId = await newChat("Prism solo work", "solo", { p_solo_provider: "claude-code" });
      git("checkout", "-q", "main");
      const sent = await say(
        chatId,
        "/work Make sure neg.js exists exporting neg(x) returning -x, and run the tests.",
      );
      const jobId = (sent as { jobId: string | null }).jobId!;
      const j = await finished(jobId, 25 * MIN);
      expect(j.lane).toBe("work");
      show("F: solo work", await rows(chatId));
      report.push(
        `F: solo work verdict ${j.verdict} in ${seconds(j.created_at, j.finished_at!).toFixed(0)} s`,
      );
      expect(j.verdict).toBe("PASS");
    },
    30 * MIN,
  );
  it(
    "H: Codex exhausted (auto) — Fast Chat and work continue with Claude; the change is said once; never PASS",
    async () => {
      simulateCodexExhausted = true;
      try {
        await engine.checkProviders();
        const chatId = await newChat("Exhausted hi", "team");
        const hi = await say(chatId, "@team hi");
        const hiJob = (hi as { jobId: string | null }).jobId!;
        await finished(hiJob, 8 * MIN);
        const hiRows = await rows(chatId);
        show("H1: @team hi with Codex exhausted", hiRows);
        expect(hiRows.some((r) => r.author_provider === "claude-code")).toBe(true);
        expect(hiRows.some((r) => r.author_provider === "codex")).toBe(false);
        expect((await runsOf(hiJob)).some((r) => r.provider === "codex")).toBe(false);

        const workChat = await newChat("Exhausted pair", "pair", {
          p_builder_provider: "claude-code",
          p_reviewer_provider: "codex",
        });
        const sent = await say(
          workChat,
          "Add sq.js exporting sq(x) returning x * x, then run the tests.",
        );
        const jobId = (sent as { jobId: string | null }).jobId!;
        const j = await finished(jobId, 25 * MIN);
        const list = await rows(workChat);
        show("H2: pair work with Codex exhausted", list);
        const runs = await runsOf(jobId);
        expect(runs.some((r) => r.provider === "codex")).toBe(false);
        expect(list.filter((r) => r.event_type === "failover").length).toBe(1);
        expect(j.verdict).not.toBe("PASS");
        report.push(
          `H: exhausted pair → verdict ${j.verdict}, status ${j.status}; failover row: ${list.find((r) => r.event_type === "failover")?.body}`,
        );
      } finally {
        simulateCodexExhausted = false;
        await engine.checkProviders();
      }
    },
    35 * MIN,
  );

  it(
    "I: Codex exhausted (ask) — the usage card offers no retry, and '@Claude continue' answers it",
    async () => {
      simulateCodexExhausted = true;
      await rpc("set_failover_policy", { p_policy: "ask" });
      try {
        await engine.checkProviders();
        const chatId = await newChat("Exhausted ask", "pair", {
          p_builder_provider: "claude-code",
          p_reviewer_provider: "codex",
        });
        const sent = await say(
          chatId,
          "Add half.js exporting half(x) returning x / 2, then run the tests.",
        );
        const jobId = (sent as { jobId: string | null }).jobId!;
        const choice = await until(
          "the usage card",
          async () => {
            const { data } = await admin
              .from("user_choices")
              .select("id, kind, options, status")
              .eq("job_id", jobId)
              .eq("status", "pending");
            return (data?.[0] as { id: string; kind: string; options: { key: string }[] }) ?? null;
          },
          20 * MIN,
        );
        expect(choice.kind).toBe("usage_exhausted");
        expect(choice.options.map((o) => o.key)).not.toContain("retry");
        const answer = await say(chatId, "@Claude continue");
        expect((answer as { routed?: string }).routed).toBe("choice_resolved");
        const { data: decided } = await admin
          .from("user_choices")
          .select("status, chosen_key")
          .eq("id", choice.id)
          .single();
        expect(decided?.status).toBe("chosen");
        expect(decided?.chosen_key).toBe("continue_other");
        const j = await finished(jobId, 25 * MIN);
        show("I: '@Claude continue'", await rows(chatId));
        expect(j.verdict).not.toBe("PASS");
        report.push(
          `I: card options ${choice.options.map((o) => o.key).join("/")}; '@Claude continue' → ${decided?.chosen_key}; verdict ${j.verdict}`,
        );
      } finally {
        simulateCodexExhausted = false;
        await rpc("set_failover_policy", { p_policy: "auto" });
        await engine.checkProviders();
      }
    },
    35 * MIN,
  );
});
