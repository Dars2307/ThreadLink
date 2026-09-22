import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import type { ConversationBinding, ProviderAdapter } from "../../runtime/src/adapters/types.ts";
import { pollDeviceToken, startDeviceLogin, ThreadLinkApi } from "../../runtime/src/api.ts";
import { RuntimeEngine } from "../../runtime/src/engine.ts";
import type { Executor } from "../../runtime/src/executor.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * Phase 6.6 over HTTP (:3200, LOCAL Supabase): one Runtime, several workspaces,
 * several Claude conversations per workspace, two chats linked to two different
 * conversations in the SAME workspace, busy handling, pause and revocation.
 */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2ERt");
const NATIVE_1 = "11111111-1111-4111-8111-111111111111";
const NATIVE_2 = "22222222-2222-4222-8222-222222222222";
const NATIVE_3 = "33333333-3333-4333-8333-333333333333";

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let api: ThreadLinkApi;
let engine: RuntimeEngine;
let configDir: string;
let wsA: string;
let wsB: string;
let root: string;
let runtimeId: string;
const running = new Set<string>();
const clients: Client[] = [];

function adapter(): ProviderAdapter {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    detect: async () => ({ available: true, version: "2.1.266" }),
    capabilities: () => ({ "claude-code": "available", "claude-resume": "available" }),
    discoverWorkspaces: async () => [],
    discoverConversations: async (workspace) => [
      { nativeSessionId: NATIVE_1, title: "Dashboard redesign", lastUsedAt: new Date(), workspace },
    ],
    conversationExists: async () => true,
    runningConversationIds: async () => new Set(running),
    createExecutor: (workspace, binding: ConversationBinding): Executor => ({
      name: "fake-claude",
      execute: async (task) =>
        binding.mode === "resume" && running.has(binding.nativeSessionId)
          ? {
              ok: false,
              reason: "session_busy",
              error: "That Claude conversation is open elsewhere.",
            }
          : {
              ok: true,
              result: `${binding.mode === "resume" ? binding.nativeSessionId : "fresh"}|${workspace}|${task.content}`,
              artifacts: [],
            },
    }),
  };
}

function newEngine(dir = configDir) {
  return new RuntimeEngine({
    api,
    configDir: dir,
    adapters: [adapter()],
    identity: { label: "E2E Laptop", platform: "windows", kind: "desktop" },
    version: "0.6.6",
    repo: async () => ({
      remote: "github.com/dars2307/threadlink",
      fingerprint: "b".repeat(64),
      branch: "main",
    }),
  });
}

async function chat(name: string) {
  const db = await userClient(A);
  const user = await provisionThreadLinkUser(
    identity(A),
    { displayName: null, primaryEmail: null },
    db,
  );
  const { credential } = await registerConnection(
    db,
    user,
    { platform: "chatgpt", displayName: name },
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
    return {
      isError: res.isError === true,
      data: res.structuredContent as Record<string, unknown>,
    };
  };
  const sessionId = (await call("ensure_session", { label: name })).data.sessionId as string;
  return { call, sessionId };
}

beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
    throw new Error("e2e must target a local server");
  }
  if (!(await fetch(BASE_URL).catch(() => null)))
    throw new Error("Start the server: npm run dev:local-db");

  root = mkdtempSync(join(tmpdir(), "tl-rt-e2e-"));
  configDir = join(root, "cfg");
  wsA = join(root, "ThreadLink");
  wsB = join(root, "Nova");
  mkdirSync(wsA);
  mkdirSync(wsB);

  ownerDb = await userClient(A);
  await provisionThreadLinkUser(
    identity(A),
    { displayName: null, primaryEmail: "rt@example.com" },
    ownerDb,
  );

  // The Runtime signs in through the browser device flow (no credential copying).
  const start = await startDeviceLogin(BASE_URL, "E2E Laptop");
  await ownerDb.rpc("decide_device_authorization", {
    p_user_code: start.user_code.replace("-", ""),
    p_approve: true,
  });
  const token = await pollDeviceToken(BASE_URL, start, { sleep: async () => {} });
  api = new ThreadLinkApi({ baseUrl: BASE_URL, token: token.access_token });
  engine = newEngine();
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
  await admin.from("users").delete().eq("clerk_user_id", A);
});

describe("one Runtime, many workspaces and conversations", () => {
  it("registers itself and reports its capabilities", async () => {
    await engine.detectProviders();
    const runtime = await engine.register();
    runtimeId = runtime.runtimeId;
    expect(runtimeId).toMatch(/^tlrun_/);
    const heartbeat = await engine.heartbeat();
    expect(heartbeat.paused).toBe(false);
    const { data } = await ownerDb
      .from("runtimes")
      .select("label, platform, kind, capabilities, status")
      .eq("id", runtimeId)
      .single();
    expect(data).toMatchObject({
      label: "E2E Laptop",
      platform: "windows",
      kind: "desktop",
      status: "active",
      capabilities: expect.objectContaining({ "claude-code": "available", filesystem: "local" }),
    });
  });

  it("attaches two conversations in one workspace and one in another", async () => {
    await engine.attach(wsA, NATIVE_1, "Dashboard redesign");
    await engine.attach(wsA, NATIVE_2, "Security review");
    await engine.attach(wsB, NATIVE_3, "Nova implementation");

    const { data: workspaces } = await ownerDb
      .from("runtime_workspaces")
      .select("id, display_name, repo_remote, branch")
      .eq("runtime_id", runtimeId);
    expect(workspaces).toHaveLength(2);
    expect(workspaces!.map((w) => w.display_name).sort()).toEqual(["Nova", "ThreadLink"]);
    expect(workspaces![0]).toMatchObject({
      repo_remote: "github.com/dars2307/threadlink",
      branch: "main",
    });

    const { data: sessions } = await ownerDb
      .from("session_bindings")
      .select("id, display_name, native_provider_session_id, workspace_id, provider")
      .eq("runtime_id", runtimeId);
    expect(sessions).toHaveLength(3);
    expect(sessions!.map((s) => s.native_provider_session_id).sort()).toEqual(
      [NATIVE_1, NATIVE_2, NATIVE_3].sort(),
    );
    const inA = sessions!.filter(
      (s) =>
        s.workspace_id ===
        sessions!.find((x) => x.native_provider_session_id === NATIVE_1)!.workspace_id,
    );
    expect(inA).toHaveLength(2); // two conversations, same workspace, distinct tlses_
  });

  it("two chats link to two different conversations in the same workspace", async () => {
    const chat1 = await chat("Dashboard chat");
    const chat2 = await chat("Security chat");

    const options = (await chat1.call("link_to_claude", { sessionId: chat1.sessionId })).data;
    expect(options.status).toBe("choose_session");
    const list = options.options as { agentSessionId: string; name: string; workspace: string }[];
    expect(list).toHaveLength(3);
    expect(list.every((o) => o.workspace === "ThreadLink" || o.workspace === "Nova")).toBe(true);

    const dash = list.find((o) => o.name === "Dashboard redesign")!;
    const sec = list.find((o) => o.name === "Security review")!;
    expect(dash.workspace).toBe("ThreadLink");
    expect(sec.workspace).toBe("ThreadLink");

    await chat1.call("link_to_claude", {
      sessionId: chat1.sessionId,
      agentSessionId: dash.agentSessionId,
    });
    await chat2.call("link_to_claude", {
      sessionId: chat2.sessionId,
      agentSessionId: sec.agentSessionId,
    });
    const pending = await engine.refreshPendingLinks();
    expect(pending).toHaveLength(2);
    for (const p of pending) await engine.approveLink(p.linkId);

    // Each chat's request reaches its own conversation.
    const t1 = (await chat1.call("send_to_agent", { sessionId: chat1.sessionId, content: "one" }))
      .data;
    const t2 = (await chat2.call("send_to_agent", { sessionId: chat2.sessionId, content: "two" }))
      .data;
    expect(await engine.deliverOnce()).toBe(2);

    const r1 = (
      await chat1.call("get_task_result", { sessionId: chat1.sessionId, taskId: t1.taskId })
    ).data;
    const r2 = (
      await chat2.call("get_task_result", { sessionId: chat2.sessionId, taskId: t2.taskId })
    ).data;
    expect(r1.result).toBe(`${NATIVE_1}|${wsA}|one`);
    expect(r2.result).toBe(`${NATIVE_2}|${wsA}|two`);

    // ...and only its own chat can read it.
    const cross = await chat2.call("get_task_result", {
      sessionId: chat2.sessionId,
      taskId: t1.taskId,
    });
    expect(cross.isError).toBe(true);
  });

  it("reports a busy conversation and refuses to write into it", async () => {
    const chat1 = await chat("Busy chat");
    const list = (await chat1.call("link_to_claude", { sessionId: chat1.sessionId })).data
      .options as {
      agentSessionId: string;
      name: string;
      busy: boolean;
    }[];
    const target = list.find((o) => o.name === "Nova implementation")!;
    await chat1.call("link_to_claude", {
      sessionId: chat1.sessionId,
      agentSessionId: target.agentSessionId,
    });
    for (const p of await engine.refreshPendingLinks()) await engine.approveLink(p.linkId);

    running.add(NATIVE_3);
    await engine.heartbeat();
    const refreshed = (await chat1.call("link_to_claude", { sessionId: chat1.sessionId })).data
      .options as {
      agentSessionId: string;
      busy: boolean;
    }[];
    expect(refreshed.find((o) => o.agentSessionId === target.agentSessionId)?.busy).toBe(true);

    const task = (
      await chat1.call("send_to_agent", { sessionId: chat1.sessionId, content: "while busy" })
    ).data;
    await engine.deliverOnce();
    const status = (
      await chat1.call("get_task_status", { sessionId: chat1.sessionId, taskId: task.taskId })
    ).data;
    expect(status).toMatchObject({ status: "failed", failureReason: "session_busy" });

    running.delete(NATIVE_3);
    await engine.heartbeat();
    const retry = (
      await chat1.call("send_to_agent", { sessionId: chat1.sessionId, content: "after" })
    ).data;
    await engine.deliverOnce();
    const ok = (
      await chat1.call("get_task_result", { sessionId: chat1.sessionId, taskId: retry.taskId })
    ).data;
    expect(ok.result).toBe(`${NATIVE_3}|${wsB}|after`);
  });

  it("a restarted Runtime keeps its identity, workspaces and conversations", async () => {
    const fresh = newEngine();
    await fresh.detectProviders();
    const again = await fresh.register();
    expect(again.runtimeId).toBe(runtimeId);
    await fresh.sync();
    const snap = fresh.snapshot();
    expect(
      snap.workspaces
        .flatMap((w) => w.conversations)
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual(
      engine
        .snapshot()
        .workspaces.flatMap((w) => w.conversations)
        .map((c) => c.sessionId)
        .sort(),
    );
  });

  it("pausing the Runtime in ThreadLink stops delivery until it is resumed", async () => {
    const chat1 = await chat("Pause chat");
    const list = (await chat1.call("link_to_claude", { sessionId: chat1.sessionId })).data
      .options as {
      agentSessionId: string;
      name: string;
    }[];
    const target = list.find((o) => o.name === "Dashboard redesign")!;
    await chat1.call("link_to_claude", {
      sessionId: chat1.sessionId,
      agentSessionId: target.agentSessionId,
    });
    for (const p of await engine.refreshPendingLinks()) await engine.approveLink(p.linkId);

    await ownerDb.rpc("update_runtime", {
      p_runtime_id: runtimeId,
      p_label: null,
      p_settings: null,
      p_paused: true,
      p_request_restart: false,
    });
    const paused = await engine.heartbeat();
    expect(paused.paused).toBe(true);
    const task = (
      await chat1.call("send_to_agent", { sessionId: chat1.sessionId, content: "paused" })
    ).data;
    expect(await engine.deliverOnce()).toBe(0); // claim refused while paused

    await ownerDb.rpc("update_runtime", {
      p_runtime_id: runtimeId,
      p_label: null,
      p_settings: { autoStart: false },
      p_paused: false,
      p_request_restart: false,
    });
    const resumed = await engine.heartbeat();
    expect(resumed.paused).toBe(false);
    expect(resumed.settings.autoStart).toBe(false); // settings reach the Runtime
    expect(await engine.deliverOnce()).toBeGreaterThan(0);
    const result = (
      await chat1.call("get_task_result", { sessionId: chat1.sessionId, taskId: task.taskId })
    ).data;
    expect(result.status).toBe("completed");
  });

  it("disconnecting the Runtime stops everything immediately", async () => {
    await ownerDb.rpc("revoke_runtime", { p_runtime_id: runtimeId });
    await expect(engine.heartbeat()).rejects.toMatchObject({ status: 401 });
    const { data } = await ownerDb.from("runtimes").select("status").eq("id", runtimeId).single();
    expect(data).toMatchObject({ status: "revoked" });
    const { data: links } = await ownerDb.from("thread_links").select("status");
    expect(links!.every((l) => l.status === "revoked")).toBe(true);
  });
});
