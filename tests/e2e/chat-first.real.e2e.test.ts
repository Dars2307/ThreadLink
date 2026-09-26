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
import { probeProvider, type ProbeFn } from "../../runtime/src/team/health.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * Chat-first acceptance, end to end with the REAL agents (0.9).
 *
 * Local Supabase + the local server (:3200) + the real Runtime engine (with
 * the real health probe) + the real Claude Code and Codex CLIs on the owner's
 * subscription. Skipped unless THREADLINK_REAL_AGENTS=1.
 *
 * ONE chat, "Prism Review", carries every request:
 *   A  chat list: create, rename, pin/unpin, project assign/move, archive/restore
 *   E  provider failure: Claude "needs sign-in" is caught BEFORE any job exists
 *   B  the user reassigns: Solo Codex in the same chat
 *   C  Builder + Reviewer in the same chat: Claude builds, Codex reviews
 *   D  Team in the same chat: roles chosen and recorded, two parallel units, PASS
 *   F  restart + reload: name, project, pin, mode and history remain
 */
const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const suite = REAL ? describe : describe.skip;
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2EChatFirst");
const MIN = 60_000;

type Row = {
  seq: number;
  job_id: string | null;
  chat_id: string | null;
  author_kind: string;
  author_provider: string | null;
  author_label: string;
  author_role: string | null;
  event_type: string;
  model_observed: string | null;
  body: string;
  visibility: string;
};

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let api: ThreadLinkApi;
let engine: RuntimeEngine;
let root: string;
let repo: string;
let configDir: string;
let prism: string;
let other: string;
let chatId: string;
const clients: Client[] = [];

// The probe is real, except while E simulates Claude Code losing its sign-in.
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
    identity: { label: "Chat-first acceptance", platform: "windows", kind: "desktop" },
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

async function chat() {
  const { data, error } = await (
    await fresh()
  )
    .from("chats")
    .select(
      "id, name, room_id, mode, solo_provider, builder_provider, reviewer_provider, pinned_at, archived_at",
    )
    .eq("id", chatId)
    .single();
  if (error) throw new Error(error.message);
  return data!;
}

async function rows(job?: string): Promise<Row[]> {
  let q = (await fresh())
    .from("chat_events")
    .select(
      "seq, job_id, chat_id, author_kind, author_provider, author_label, author_role, event_type, model_observed, body, visibility",
    )
    .eq("chat_id", chatId)
    .order("seq");
  if (job) q = q.eq("job_id", job);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as Row[];
}

function show(title: string, list: Row[]) {
  console.log(
    `\n===== ${title} =====\n` +
      list
        .map(
          (r) =>
            `[${r.visibility === "technical" ? "tech" : "    "}] ${r.author_label}${r.author_role ? ` (${r.author_role})` : ""}${r.model_observed ? ` [${r.model_observed}]` : ""} ${r.event_type}: ${r.body.slice(0, 200).replace(/\n/g, " ⏎ ")}`,
        )
        .join("\n"),
  );
}

async function post(body: string) {
  return rpc<{ routed: string; job_id: string | null }>("post_chat_message", {
    p_chat_id: chatId,
    p_body: body,
    p_idempotency_key: null,
  });
}

async function runJob(jobId: string) {
  for (let i = 0; i < 5; i++) {
    await engine.deliverOnce();
    const { data } = await (
      await fresh()
    )
      .from("team_jobs")
      .select("status, verdict, verdict_reason, summary, mode, chat_id")
      .eq("id", jobId)
      .single();
    if (data?.verdict || ["failed", "cancelled"].includes(data?.status)) return data!;
  }
  throw new Error("the job never finished");
}

const verdictOf = (list: Row[]) =>
  list.find((r) => r.event_type === "job_verdict")?.body ?? "(no verdict)";

suite("chat-first ThreadLink with the real agents", () => {
  beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
      throw new Error("e2e must target a local server");
    }
    if (!(await fetch(BASE_URL).catch(() => null)))
      throw new Error("Start the server: npm run dev:local-db");

    root = mkdtempSync(join(tmpdir(), "tl-chatfirst-real-"));
    configDir = join(root, "cfg");
    repo = join(root, "Prism");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { windowsHide: true });
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "package.json"), '{ "name": "prism", "private": true }\n');
    writeFileSync(
      join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const fs = require('node:fs');",
        "for (const [file, fn, args, want] of [",
        "  ['./mul.js', 'mul', [4, 5], 20], ['./sub.js', 'sub', [9, 4], 5],",
        "  ['./div.js', 'div', [8, 2], 4], ['./neg.js', 'neg', [3], -3]]) {",
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
    const start = await startDeviceLogin(BASE_URL, "Chat-first acceptance");
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
    other = ((await call("create_room", { sessionId, name: "Other" })).room as { roomId: string })
      .roomId;
    for (const room of [prism, other]) {
      await rpc("update_room_policy", {
        p_room_id: room,
        p_usage_policy: "conservative",
        p_max_review_rounds: 3,
        p_verify_commands: ["node test.js"],
      });
    }
  }, 5 * MIN);

  beforeEach(async () => {
    await fresh();
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    await admin.from("users").delete().eq("clerk_user_id", A);
  });

  it("A: the chat list — create, rename, pin, project, archive", async () => {
    const created = await rpc<{ chat_id: string }>("create_chat", {
      p_name: "Prism review draft",
      p_room_id: prism,
      p_mode: "team",
    });
    chatId = created.chat_id;
    expect(chatId).toMatch(/^tlcht_/);
    await rpc("update_chat", { p_chat_id: chatId, p_name: "Prism Review" });
    await rpc("set_chat_pinned", { p_chat_id: chatId, p_pinned: true });
    expect((await chat()).pinned_at).not.toBeNull();
    await rpc("set_chat_pinned", { p_chat_id: chatId, p_pinned: false });
    expect((await chat()).pinned_at).toBeNull();
    await rpc("update_chat", { p_chat_id: chatId, p_room_id: other });
    expect((await chat()).room_id).toBe(other);
    await rpc("update_chat", { p_chat_id: chatId, p_room_id: prism });
    await rpc("set_chat_archived", { p_chat_id: chatId, p_archived: true });
    expect((await chat()).archived_at).not.toBeNull();
    await rpc("set_chat_archived", { p_chat_id: chatId, p_archived: false });
    await rpc("set_chat_pinned", { p_chat_id: chatId, p_pinned: true });
    expect(await chat()).toMatchObject({
      name: "Prism Review",
      room_id: prism,
      mode: "team",
      archived_at: null,
    });
  });

  it("E: Claude Code needs sign-in — caught before any job exists, plainly said", async () => {
    simulateClaudeSignedOut = true;
    await engine.checkProviders();
    const { count: before } = await (
      await fresh()
    )
      .from("team_jobs")
      .select("id", { count: "exact", head: true });
    const sent = await post("@team Please review Prism carefully.");
    const { count: after } = await (
      await fresh()
    )
      .from("team_jobs")
      .select("id", { count: "exact", head: true });
    const list = await rows();
    show("E provider blocked", list);
    expect(sent.routed).toBe("provider_blocked");
    expect(sent.job_id).toBeNull();
    expect(after).toBe(before);
    const blocked = list.find((r) => r.event_type === "provider_blocked");
    expect(blocked?.author_kind).toBe("threadlink");
    expect(blocked?.body).toMatch(/Claude Code needs you to sign in again on this computer/);
    expect(blocked?.body).toMatch(/Codex is ready/);
    // Health is back once the user signs in again (here: the simulation ends).
    simulateClaudeSignedOut = false;
    await engine.checkProviders();
  });

  it(
    "B: the user reassigns explicitly — Solo Codex in the same chat",
    async () => {
      await rpc("update_chat", { p_chat_id: chatId, p_mode: "solo", p_solo_provider: "codex" });
      const sent = await post("Create mul.js exporting mul(a, b) (CommonJS).");
      expect(sent.routed).toBe("new_job");
      const job = await runJob(sent.job_id!);
      const list = await rows(sent.job_id!);
      show("B solo Codex", list);
      expect(job).toMatchObject({ mode: "solo", chat_id: chatId });
      const agents = list.filter((r) => r.author_kind === "agent");
      expect(new Set(agents.map((r) => r.author_provider))).toEqual(new Set(["codex"]));
      expect(verdictOf(list), `${job.summary}`).toMatch(/^Result: PASS/);
    },
    30 * MIN,
  );

  it(
    "C: Builder + Reviewer in the same chat — Claude builds, Codex reviews",
    async () => {
      await rpc("update_chat", {
        p_chat_id: chatId,
        p_mode: "pair",
        p_builder_provider: "claude-code",
        p_reviewer_provider: "codex",
      });
      const sent = await post("Create sub.js exporting sub(a, b) returning a - b (CommonJS).");
      const job = await runJob(sent.job_id!);
      const list = await rows(sent.job_id!);
      show("C Builder + Reviewer", list);
      expect(job).toMatchObject({ mode: "pair", chat_id: chatId });
      const agents = list.filter((r) => r.author_kind === "agent");
      expect(
        agents.some((r) => r.author_provider === "claude-code" && r.author_role === "builder"),
      ).toBe(true);
      expect(
        agents.some((r) => r.author_provider === "codex" && r.author_role === "reviewer"),
      ).toBe(true);
      expect(verdictOf(list), `${job.summary}`).toMatch(/^Result: PASS/);
    },
    45 * MIN,
  );

  it(
    "D: Team in the same chat — roles chosen explicitly, two parallel units, cross-review, PASS",
    async () => {
      await rpc("update_chat", { p_chat_id: chatId, p_mode: "team" });
      const sent = await post(
        "Add two independent CommonJS modules: div.js exporting div(a, b) returning a / b, and " +
          "neg.js exporting neg(a) returning -a. They do not depend on each other.",
      );
      const jobId = sent.job_id!;
      const job = await runJob(jobId);
      const list = await rows(jobId);
      show("D Team", list);
      const { data: decisions } = await (
        await fresh()
      )
        .from("team_decisions")
        .select("title, resolution, evidence")
        .eq("job_id", jobId);
      const roles = decisions!.find((d) => d.title === "Roles");
      console.log("Roles decision:", JSON.stringify(roles));
      const { data: nodes } = await (
        await fresh()
      )
        .from("team_nodes")
        .select("node_key, owner_provider, reviewer_provider, depends_on, status")
        .eq("job_id", jobId);
      console.log("Units:", JSON.stringify(nodes));
      expect(job).toMatchObject({ mode: "team", chat_id: chatId });
      expect(roles).toBeTruthy();
      expect((roles!.evidence as { coordinator?: string }).coordinator).toMatch(
        /^(claude-code|codex)$/,
      );
      expect(job.verdict, job.summary ?? "").toBe("PASS");
      expect(nodes!.length).toBeGreaterThanOrEqual(2);
      // At least two independent units, built by different providers (the planner
      // may add more, e.g. a final "verify" unit that depends on both).
      const independent = nodes!.filter((n) => (n.depends_on as string[]).length === 0);
      expect(independent.length).toBeGreaterThanOrEqual(2);
      expect(new Set(independent.map((n) => n.owner_provider)).size).toBe(2);
      for (const n of nodes!) expect(n.reviewer_provider).not.toBe(n.owner_provider);
      const all = await rows(jobId);
      const firstReview = all.find(
        (r) =>
          r.event_type === "unit_status" && /in review|approved|changes requested/.test(r.body),
      );
      // The independent units both start before any unit is reviewed (a unit
      // that depends on them correctly waits).
      const indepKeys = independent.map((n) => n.node_key);
      const starts = all.filter(
        (r) =>
          r.event_type === "unit_status" &&
          /in progress/.test(r.body) &&
          indepKeys.some((k) => r.body.startsWith(`Unit ${k}:`)),
      );
      console.log(
        "Parallel evidence:",
        starts.map((s) => `${s.body}@${s.seq}`),
        "first review @",
        firstReview?.seq,
      );
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(starts.every((s) => s.seq < (firstReview?.seq ?? Infinity))).toBe(true);
    },
    60 * MIN,
  );

  it("F: after a Runtime restart and a reload, the chat is exactly as it was", async () => {
    const before = await rows();
    engine = newEngine();
    await engine.heartbeat();
    const after = await rows();
    expect(after.map((r) => r.seq)).toEqual(before.map((r) => r.seq));
    expect(await chat()).toMatchObject({ name: "Prism Review", room_id: prism, mode: "team" });
    expect((await chat()).pinned_at).not.toBeNull();
    // Every job of the session lives in this one chat.
    const jobs = new Set(after.map((r) => r.job_id).filter(Boolean));
    expect(jobs.size).toBeGreaterThanOrEqual(3);
    // Mode changes are in the history, not rewriting it.
    expect(after.filter((r) => r.event_type === "mode_changed").length).toBeGreaterThanOrEqual(3);
  });
});
