import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import { pollDeviceToken, startDeviceLogin, ThreadLinkApi } from "../../runtime/src/api.ts";
import { RuntimeEngine } from "../../runtime/src/engine.ts";
import { defaultAdapters, RUNTIME_VERSION } from "../../runtime/src/index.ts";
import { discoverProviders } from "../../runtime/src/team/discovery.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * Collaboration chat acceptance, end to end with the REAL agents.
 *
 * Local Supabase + the local server (:3200) + the real Runtime engine + the
 * real Claude Code and Codex CLIs on the owner's subscription. Skipped unless
 * THREADLINK_REAL_AGENTS=1. Every assertion reads the chat the owner would
 * see (public.chat_events through the owner's own RLS-scoped client).
 *
 *   A  declared plan persists (browser path, device path, detection, restart)
 *   B  single Claude: a controller request and an @claude solo job
 *   C  single Codex: an @codex solo job
 *   D  Builder + Reviewer
 *   E  Team Mode with two independent units built in parallel
 *   F  everything is still there after the Runtime restarts
 */
const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const suite = REAL ? describe : describe.skip;
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2EChat");
const MIN = 60_000;

type Row = {
  seq: number;
  job_id: string | null;
  task_id: string | null;
  node_id: string | null;
  author_kind: string;
  author_provider: string | null;
  author_label: string;
  author_role: string | null;
  event_type: string;
  model_observed: string | null;
  model_requested: string | null;
  body: string;
  visibility: string;
  created_at: string;
};

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let api: ThreadLinkApi;
let engine: RuntimeEngine;
let root: string;
let repo: string;
let configDir: string;
let roomId: string;
let controller: {
  call: (t: string, a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sessionId: string;
};
const clients: Client[] = [];

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

function newEngine() {
  return new RuntimeEngine({
    api,
    configDir,
    adapters: defaultAdapters(),
    identity: { label: "Chat acceptance", platform: "windows", kind: "desktop" },
    version: RUNTIME_VERSION,
    discoverTeam: discoverProviders,
    log: (m) => console.log(`[runtime] ${m}`),
  });
}

/** The owner's signed-in client. Test tokens are short-lived, so each read gets a fresh one. */
async function fresh() {
  ownerDb = await userClient(A);
  return ownerDb;
}

async function chatRows(filter: { job?: string; task?: string } = {}): Promise<Row[]> {
  await fresh();
  let q = ownerDb
    .from("chat_events")
    .select(
      "seq, job_id, task_id, node_id, author_kind, author_provider, author_label, author_role, event_type, model_observed, model_requested, body, visibility, created_at",
    )
    .eq("room_id", roomId)
    .order("seq");
  if (filter.job) q = q.eq("job_id", filter.job);
  if (filter.task) q = q.eq("task_id", filter.task);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as Row[];
}

function show(title: string, rows: Row[]) {
  console.log(
    `\n===== ${title} =====\n` +
      rows
        .map(
          (r) =>
            `[${r.visibility === "technical" ? "tech" : "    "}] ${r.author_label}${r.author_role ? ` (${r.author_role})` : ""}${r.model_observed ? ` [${r.model_observed}]` : ""} ${r.event_type}: ${r.body.slice(0, 220).replace(/\n/g, " ⏎ ")}`,
        )
        .join("\n"),
  );
}

async function post(body: string, mode?: string, builder?: string) {
  const { data, error } = await ownerDb.rpc("post_chat_message", {
    p_room_id: roomId,
    p_body: body,
    p_mode: mode ?? null,
    p_builder: builder ?? null,
    p_idempotency_key: null,
  });
  if (error) throw new Error(`${error.message} (${error.hint})`);
  return data as { routed: string; job_id: string | null };
}

/** Runs queued work until the job has a verdict (the engine delivers one task at a time). */
async function runJob(jobId: string) {
  for (let i = 0; i < 5; i++) {
    await engine.deliverOnce();
    const { data } = await (
      await fresh()
    )
      .from("team_jobs")
      .select("status, verdict, summary, mode")
      .eq("id", jobId)
      .single();
    if (data?.verdict || ["failed", "cancelled"].includes(data?.status)) return data!;
  }
  throw new Error("the job never finished");
}

function verdictOf(rows: Row[]) {
  return rows.find((r) => r.event_type === "job_verdict")?.body ?? "(no verdict)";
}

suite("collaboration chat with the real agents", () => {
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
      throw new Error("e2e must target a local server");
    }
    if (!(await fetch(BASE_URL).catch(() => null)))
      throw new Error("Start the server: npm run dev:local-db");

    root = mkdtempSync(join(tmpdir(), "tl-chat-real-"));
    configDir = join(root, "cfg");
    repo = join(root, "Arith");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "package.json"), '{ "name": "arith", "private": true }\n');
    writeFileSync(
      join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "for (const [file, fn, args, want] of [",
        "  ['./math.js', 'add', [2, 3], 5], ['./mul.js', 'mul', [4, 5], 20],",
        "  ['./sub.js', 'sub', [9, 4], 5], ['./div.js', 'div', [8, 2], 4],",
        "  ['./neg.js', 'neg', [3], -3], ['./sq.js', 'sq', [6], 36]]) {",
        "  if (!fs.existsSync(file)) continue;",
        "  assert.strictEqual(require(file)[fn](...args), want, file);",
        "}",
        "console.log('arith tests passed');",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, "AGENTS.md"), "Plain CommonJS. No dependencies.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");

    ownerDb = await userClient(A);
    await provisionThreadLinkUser(identity(A), { displayName: null, primaryEmail: null }, ownerDb);
    const start = await startDeviceLogin(BASE_URL, "Chat acceptance");
    await ownerDb.rpc("decide_device_authorization", {
      p_user_code: start.user_code.replace("-", ""),
      p_approve: true,
    });
    const token = await pollDeviceToken(BASE_URL, start, { sleep: async () => {} });
    api = new ThreadLinkApi({ baseUrl: BASE_URL, token: token.access_token });
    engine = newEngine();
    await engine.detectProviders();
    await engine.register();
    await engine.heartbeat();
    // "New headless session": each controller request runs in a fresh Claude session.
    await engine.attach(repo, null, "Arith", "fresh");

    const db = await userClient(A);
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
    controller = { call, sessionId };
    const options = await call("link_to_claude", { sessionId });
    const target = (options.options as { agentSessionId: string; name: string }[]).find(
      (o) => o.name === "Arith",
    )!;
    await call("link_to_claude", { sessionId, agentSessionId: target.agentSessionId });
    for (const p of await engine.refreshPendingLinks()) await engine.approveLink(p.linkId);
    // Detection must have been reported before a job can start.
    await engine.heartbeat();
    const room = await call("create_room", { sessionId, name: "Arith" });
    roomId = (room.room as { roomId: string }).roomId;
    expect(roomId).toMatch(/^tlrom_/);
    const { error } = await ownerDb.rpc("update_room_policy", {
      p_room_id: roomId,
      p_usage_policy: "conservative",
      p_max_review_rounds: 3,
      p_verify_commands: ["node test.js"],
    });
    if (error) throw new Error(error.message);
  }, 5 * MIN);

  beforeEach(async () => {
    await fresh();
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    await admin.from("users").delete().eq("clerk_user_id", A);
  });

  it("A: the declared plan persists through every path", async () => {
    const setWeb = await ownerDb.rpc("set_provider_profile", {
      p_provider: "codex",
      p_declared_plan: "business_premium",
    });
    expect(setWeb.error).toBeNull();
    // A detection refresh never overwrites it.
    await engine.detectProviders();
    await engine.heartbeat();
    let { profiles } = await engine.getProviderProfiles();
    expect(profiles.find((p) => p.provider === "codex")?.declaredPlan).toBe("business_premium");
    // The desktop path writes the same server state.
    ({ profiles } = await engine.setProviderPlan("codex", "business_standard"));
    expect(profiles.find((p) => p.provider === "codex")?.declaredPlan).toBe("business_standard");
    const { data } = await ownerDb
      .from("provider_profiles")
      .select("declared_plan")
      .eq("provider", "codex")
      .single();
    expect(data?.declared_plan).toBe("business_standard");
    // The generic value is refused, visibly.
    const bad = await ownerDb.rpc("set_provider_profile", {
      p_provider: "codex",
      p_declared_plan: "business",
    });
    expect(bad.error).not.toBeNull();
    // Claude plans still work.
    await engine.setProviderPlan("claude-code", "max_20x");
    ({ profiles } = await engine.getProviderProfiles());
    expect(profiles.find((p) => p.provider === "claude-code")?.declaredPlan).toBe("max_20x");
  });

  it(
    "B1: a controller request to Claude shows in the chat with its result",
    async () => {
      const sent = await controller.call("send_to_agent", {
        sessionId: controller.sessionId,
        content: "Reply with exactly the word: pong",
      });
      await engine.deliverOnce();
      const rows = await chatRows({ task: sent.taskId as string });
      show("B1 controller → Claude", rows);
      expect(rows[0]).toMatchObject({
        author_kind: "controller",
        author_label: "ChatGPT",
        event_type: "request",
      });
      const result = rows.find((r) => r.event_type === "agent_result");
      expect(result).toMatchObject({ author_kind: "agent", author_provider: "claude-code" });
      expect(result!.body.toLowerCase()).toContain("pong");
    },
    10 * MIN,
  );

  it(
    "B2: @claude runs a solo Claude job in the chat",
    async () => {
      const sent = await post("@claude Create math.js exporting add(a, b) (CommonJS).");
      expect(sent.routed).toBe("new_job");
      const job = await runJob(sent.job_id!);
      const rows = await chatRows({ job: sent.job_id! });
      show("B2 solo Claude", rows);
      expect(job.mode).toBe("solo");
      expect(rows[0]).toMatchObject({
        author_kind: "owner",
        author_label: "You",
        event_type: "request",
      });
      const agents = rows.filter((r) => r.author_kind === "agent");
      expect(agents.length).toBeGreaterThan(0);
      expect(new Set(agents.map((r) => r.author_provider))).toEqual(new Set(["claude-code"]));
      expect(agents.some((r) => r.model_observed?.startsWith("claude-"))).toBe(true);
      expect(verdictOf(rows), `${job.summary}`).toMatch(/^Result: PASS/);
    },
    30 * MIN,
  );

  it(
    "C: @codex runs a solo Codex job in the chat",
    async () => {
      const sent = await post("@codex Create mul.js exporting mul(a, b) (CommonJS).");
      const job = await runJob(sent.job_id!);
      const rows = await chatRows({ job: sent.job_id! });
      show("C solo Codex", rows);
      expect(job.mode).toBe("solo");
      const agents = rows.filter((r) => r.author_kind === "agent");
      expect(agents.length).toBeGreaterThan(0);
      expect(new Set(agents.map((r) => r.author_provider))).toEqual(new Set(["codex"]));
      expect(agents.some((r) => !!r.model_observed)).toBe(true);
      expect(verdictOf(rows), `${job.summary}`).toMatch(/^Result: PASS/);
    },
    30 * MIN,
  );

  it(
    "D: Builder + Reviewer: Codex builds, Claude reviews",
    async () => {
      const sent = await post(
        "@codex Create sub.js exporting sub(a, b) returning a - b (CommonJS).",
        "pair",
        "codex",
      );
      const job = await runJob(sent.job_id!);
      const rows = await chatRows({ job: sent.job_id! });
      show("D Builder + Reviewer", rows);
      expect(job.mode).toBe("pair");
      const agents = rows.filter((r) => r.author_kind === "agent");
      expect(agents.some((r) => r.author_provider === "codex" && r.author_role === "builder")).toBe(
        true,
      );
      expect(
        agents.some((r) => r.author_provider === "claude-code" && r.author_role === "reviewer"),
      ).toBe(true);
      expect(verdictOf(rows), `${job.summary}`).toMatch(/^Result: PASS/);
    },
    45 * MIN,
  );

  it(
    "E: Team Mode builds two independent units in parallel, cross-reviews and passes",
    async () => {
      const started = await controller.call("start_team_job", {
        sessionId: controller.sessionId,
        roomId,
        mode: "team",
        goal:
          "Add two independent CommonJS modules: div.js exporting div(a, b) returning a / b, and " +
          "neg.js exporting neg(a) returning -a. They do not depend on each other.",
        spec: {
          requirements: ["div.js exports div(a, b)", "neg.js exports neg(a)"],
          doNotChange: ["test.js", "package.json"],
          testsRequired: ["node test.js passes"],
        },
      });
      const jobId = started.jobId as string;
      const job = await runJob(jobId);
      const rows = await chatRows({ job: jobId });
      show("E Team Mode", rows);
      const { data: nodes } = await ownerDb
        .from("team_nodes")
        .select("id, node_key, owner_provider, reviewer_provider, status, depends_on")
        .eq("job_id", jobId);
      console.log("Units:", JSON.stringify(nodes));
      expect(job.verdict, job.summary ?? "").toBe("PASS");
      expect(nodes!.length).toBeGreaterThanOrEqual(2);
      // Truly independent, owned by different providers, each reviewed by the other.
      expect(nodes!.every((n) => (n.depends_on as string[]).length === 0)).toBe(true);
      expect(new Set(nodes!.map((n) => n.owner_provider)).size).toBe(2);
      for (const n of nodes!) expect(n.reviewer_provider).not.toBe(n.owner_provider);
      // Parallel: every unit started building before any unit went to review.
      const all = await chatRows({ job: jobId });
      const firstReview = all.find(
        (r) =>
          r.event_type === "unit_status" && /in review|approved|changes requested/.test(r.body),
      );
      const starts = all.filter(
        (r) => r.event_type === "unit_status" && /in progress/.test(r.body),
      );
      console.log(
        "Parallel evidence:",
        starts.map((s) => `${s.body}@${s.seq}`),
        "first review @",
        firstReview?.seq,
      );
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(starts.every((s) => s.seq < (firstReview?.seq ?? Infinity))).toBe(true);
      // The integrated result works.
      const branch = /threadlink\/[A-Za-z0-9._/-]+integration/.exec(
        JSON.stringify(
          (await ownerDb.from("team_jobs").select("evidence").eq("id", jobId).single()).data,
        ),
      )?.[0];
      expect(branch).toBeTruthy();
      git("checkout", "-q", branch!);
      expect(execFileSync("node", ["test.js"], { cwd: repo, encoding: "utf8" })).toContain(
        "arith tests passed",
      );
      git("checkout", "-q", "main");
    },
    60 * MIN,
  );

  it("F: after a Runtime restart the chat and the plan are still there", async () => {
    const before = await chatRows();
    engine = newEngine();
    await engine.heartbeat();
    const after = await chatRows();
    expect(after.map((r) => r.seq)).toEqual(before.map((r) => r.seq));
    const { profiles } = await engine.getProviderProfiles();
    expect(profiles.find((p) => p.provider === "codex")?.declaredPlan).toBe("business_standard");
    // Agent text claiming to be ThreadLink never became a ThreadLink event.
    for (const r of after.filter((x) => x.author_kind === "threadlink"))
      expect(r.author_provider).toBeNull();
  });
});
