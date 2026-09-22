import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import {
  ApiError,
  pollDeviceToken,
  startDeviceLogin,
  ThreadLinkApi,
} from "../../bridge/src/api.ts";
import { processNextTask } from "../../bridge/src/worker.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * Phase 6.5 over HTTP (:3200, LOCAL Supabase):
 *   bridge device sign-in -> native session attachment -> Claude MCP client
 *   classified as claude-desktop -> link_to_claude -> bridge approval ->
 *   send_to_agent -> session_busy surfaced to the controller.
 */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const NATIVE_ID = "04158991-0630-4b8b-b461-58c86ee35453";
const A = uniqueClerkId("E2ENative");
const B = uniqueClerkId("E2ENativeB");

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let bridge: ThreadLinkApi;
let agentSessionId: string;
let controllerToken: string;
let mcp: Client;
let chatSessionId: string;

const b64url = (buf: Buffer) => buf.toString("base64url");
const noSleep = async () => {};

async function oauthToken(db: typeof ownerDb, redirect: string): Promise<string> {
  const reg = await fetch(`${BASE_URL}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }), // name is NOT trusted
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const code = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const { error } = await db.rpc("create_oauth_authorization", {
    p_client_id: clientId,
    p_redirect_uri: redirect,
    p_code_hash: createHash("sha256").update(code).digest("hex"),
    p_code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    p_resource: `${BASE_URL}/mcp`,
  });
  if (error) throw new Error(`authorization failed: ${error.code}`);
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirect,
    }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function connectMcp(token: string) {
  const client = new Client({ name: "threadlink-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as Record<string, unknown> };
}

async function whoami(token: string) {
  const res = await fetch(`${BASE_URL}/api/connection/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
    throw new Error("e2e must target a local server");
  }
  if (!(await fetch(BASE_URL).catch(() => null))) {
    throw new Error("Start the server first: npm run dev:local-db");
  }
  ownerDb = await userClient(A);
  await provisionThreadLinkUser(
    identity(A),
    { displayName: null, primaryEmail: "native@example.com" },
    ownerDb,
  );
});

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("bridge device sign-in (no credential copying)", () => {
  it("issues a code, waits for approval, then returns an agent credential exactly once", async () => {
    const start = await startDeviceLogin(BASE_URL, "E2E laptop");
    expect(start.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(start.verification_uri_complete).toBe(`${BASE_URL}/connect?code=${start.user_code}`);

    const early = await fetch(`${BASE_URL}/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    expect(await early.json()).toEqual({ error: "authorization_pending" });

    // The signed-in human approves the code shown in the terminal (the /connect page does this).
    const approve = await ownerDb.rpc("decide_device_authorization", {
      p_user_code: start.user_code.replace("-", ""),
      p_approve: true,
    });
    expect(approve.error).toBeNull();

    const token = await pollDeviceToken(BASE_URL, start, { sleep: noSleep });
    expect(token.access_token).toMatch(/^tlc_/);
    expect(token.account_hint).toBe("n***@example.com");
    expect((await whoami(token.access_token)).body).toMatchObject({
      platform: "claude-code",
      role: "agent",
    });

    const replay = await fetch(`${BASE_URL}/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    expect(await replay.json()).toEqual({ error: "invalid_grant" });

    bridge = new ThreadLinkApi({ baseUrl: BASE_URL, token: token.access_token });
    agentSessionId = (
      await bridge.registerSession({ localBindingRef: "cc-native-e2e", displayName: "ThreadLink" })
    ).session.sessionId;
  });

  it("a denied request can never be redeemed", async () => {
    const start = await startDeviceLogin(BASE_URL, "Unknown device");
    await ownerDb.rpc("decide_device_authorization", {
      p_user_code: start.user_code.replace("-", ""),
      p_approve: false,
    });
    await expect(pollDeviceToken(BASE_URL, start, { sleep: noSleep })).rejects.toMatchObject({
      kind: "access_denied",
    });
  });

  it("the /connect approval page is behind Clerk", async () => {
    const res = await fetch(`${BASE_URL}/connect?code=BCDF-GHJK`, { redirect: "manual" });
    expect(res.status).not.toBe(200);
  });
});

describe("native Claude Code session attachment", () => {
  it("the agent attaches its native session; tlses_ is unchanged", async () => {
    const session = await bridge.setNativeSession({
      sessionId: agentSessionId,
      mode: "resume",
      nativeSessionId: NATIVE_ID,
      workspacePath: "C:\\work\\ThreadLink",
    });
    expect(session).toMatchObject({ sessionId: agentSessionId, nativeSessionMode: "resume" });
    expect(JSON.stringify(session)).not.toContain(NATIVE_ID); // not echoed back
    const { data } = await ownerDb
      .from("session_bindings")
      .select("native_provider_session_id, native_session_mode")
      .eq("id", agentSessionId)
      .single();
    expect(data).toEqual({ native_provider_session_id: NATIVE_ID, native_session_mode: "resume" });
  });

  it("rejects malformed IDs and resume without an ID", async () => {
    await expect(
      bridge.setNativeSession({ sessionId: agentSessionId, mode: "resume", nativeSessionId: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      bridge.setNativeSession({ sessionId: agentSessionId, mode: "resume" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("Claude MCP client: platform, link_to_claude, busy status", () => {
  it("an MCP client redirecting to claude.ai is stored as claude-desktop (not chatgpt)", async () => {
    controllerToken = await oauthToken(ownerDb, CLAUDE_REDIRECT);
    expect((await whoami(controllerToken)).body).toMatchObject({
      platform: "claude-desktop",
      role: "controller",
    });
  });

  it("a controller cannot attach native sessions", async () => {
    const res = await fetch(`${BASE_URL}/api/session/native`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: agentSessionId, mode: "fresh" }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it("link_to_claude lists sessions, requests a link, and the bridge must approve", async () => {
    mcp = await connectMcp(controllerToken);
    chatSessionId = (await tool(mcp, "ensure_session", {})).data.sessionId as string;

    const listed = await tool(mcp, "link_to_claude", { sessionId: chatSessionId });
    expect(listed.data).toMatchObject({
      status: "choose_session",
      options: [
        {
          agentSessionId,
          workspace: "ThreadLink",
          resumesExistingClaudeSession: true,
          linkStatus: null,
        },
      ],
    });
    expect(JSON.stringify(listed.data)).not.toMatch(/04158991|C:\\\\work/);

    const requested = await tool(mcp, "link_to_claude", {
      sessionId: chatSessionId,
      agentSessionId,
    });
    expect(requested.data.status).toBe("awaiting_approval");
    expect(
      (await tool(mcp, "send_to_agent", { sessionId: chatSessionId, content: "x" })).data.status,
    ).toBe("setup_required"); // pending never routes

    const pending = (await bridge.links(agentSessionId)).find((l) => l.status === "pending");
    expect(pending).toBeDefined();
    expect((await bridge.approvePairing(agentSessionId, pending!.linkId)).status).toBe("active");
  });

  it("a busy Claude session is reported to the controller as session_busy", async () => {
    const sent = await tool(mcp, "send_to_agent", {
      sessionId: chatSessionId,
      content: "Send this to Claude",
    });
    expect(sent.data.status).toBe("queued");
    const outcome = await processNextTask({
      api: bridge,
      executor: {
        name: "busy",
        execute: async () => ({
          ok: false,
          reason: "session_busy",
          error: "The attached Claude Code session is open elsewhere.",
        }),
      },
      sessionId: agentSessionId,
      claimRef: "e2e-native",
    });
    expect(outcome).toBe("failed");
    const status = await tool(mcp, "get_task_status", {
      sessionId: chatSessionId,
      taskId: sent.data.taskId,
    });
    expect(status.data).toMatchObject({ status: "failed", failureReason: "session_busy" });
    const result = await tool(mcp, "get_task_result", {
      sessionId: chatSessionId,
      taskId: sent.data.taskId,
    });
    expect(result.data.error).toContain("open elsewhere");
  });

  it("an agent cannot claim a system failure reason", async () => {
    const sent = await tool(mcp, "send_to_agent", { sessionId: chatSessionId, content: "y" });
    await bridge.claim(sent.data.taskId as string, agentSessionId, "w");
    const res = await fetch(`${BASE_URL}/api/tasks/${sent.data.taskId}/fail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(bridge as unknown as { token?: string }).token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: agentSessionId,
        claimRef: "w",
        error: "x",
        failureReason: "lease_exhausted",
      }),
    });
    expect([400, 401]).toContain(res.status);
    await expect(
      bridge.fail(sent.data.taskId as string, agentSessionId, "w", "done", "session_busy"),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("another user's controller sees none of these Claude sessions", async () => {
    const dbB = await userClient(B);
    const userB = await provisionThreadLinkUser(
      identity(B),
      { displayName: null, primaryEmail: null },
      dbB,
    );
    const other = await registerConnection(
      dbB,
      userB,
      { platform: "chatgpt" },
      TEST_CONNECTION_SECRET,
    );
    const clientB = await connectMcp(other.credential.token);
    const sid = (await tool(clientB, "ensure_session", {})).data.sessionId as string;
    expect((await tool(clientB, "link_to_claude", { sessionId: sid })).data.status).toBe(
      "setup_required",
    );
    const cross = await tool(clientB, "link_to_claude", { sessionId: sid, agentSessionId });
    expect(cross.isError).toBe(true);
    await clientB.close();
  });

  it("device errors never include the credential", () => {
    expect(new ApiError(400, "access_denied").message).not.toMatch(/tlc_/);
  });
});
