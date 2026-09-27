import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import { ThreadLinkApi } from "../../runtime/src/api.ts";
import { EchoExecutor } from "../../runtime/src/executor.ts";
import { processNextTask } from "../../runtime/src/worker.ts";
import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * Full Phase 6 round trip against a real Next.js server (:3200, LOCAL Supabase):
 *
 *   OAuth (DCR -> consent -> PKCE code exchange) -> MCP client (ChatGPT stand-in)
 *   -> ensure_session -> owner pairs in the "dashboard" -> bridge approves
 *   -> send_to_agent -> bridge worker (echo executor) -> get_task_result.
 *
 * The consent step (Clerk-protected page) is exercised by calling the same
 * user-scoped RPC the page's server action calls, with a Clerk-like JWT.
 */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const A = uniqueClerkId("E2EMcp");
const B = uniqueClerkId("E2EMcpB");

let ownerDb: Awaited<ReturnType<typeof userClient>>;
let clientId: string;
let accessToken: string;
let mcp: Client;
let chatSessionId: string;
let chatSessionRef: string;
let bridge: ThreadLinkApi;
let bridgeToken: string;
let agentSessionId: string;
let linkId: string;

const b64url = (buf: Buffer) => buf.toString("base64url");

async function authorizeAndExchange(db: typeof ownerDb, id: string) {
  const code = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const { error } = await db.rpc("create_oauth_authorization", {
    p_client_id: id,
    p_redirect_uri: REDIRECT,
    p_code_hash: createHash("sha256").update(code).digest("hex"),
    p_code_challenge: challenge,
    p_resource: `${BASE_URL}/mcp`,
  });
  if (error) throw new Error(`authorization failed: ${error.code}`);
  return { code, verifier };
}

async function token(body: Record<string, string>) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, string> };
}

function mcpClient(bearer: string) {
  const client = new Client({ name: "threadlink-e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  return { client, transport };
}

async function tool(name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as Record<string, unknown> };
}

beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
    throw new Error("e2e must target a local server");
  }
  if (!(await fetch(BASE_URL).catch(() => null))) {
    throw new Error("Start the server first: npm run dev:local-db");
  }
  ownerDb = await userClient(A);
  const user = await provisionThreadLinkUser(
    identity(A),
    { displayName: null, primaryEmail: null },
    ownerDb,
  );
  const agent = await registerConnection(
    ownerDb,
    user,
    { platform: "claude-code", displayName: "E2E laptop" },
    TEST_CONNECTION_SECRET,
  );
  bridgeToken = agent.credential.token;
  bridge = new ThreadLinkApi({ baseUrl: BASE_URL, token: bridgeToken });
  agentSessionId = (
    await bridge.registerSession({ localBindingRef: "cc-e2e-workspace", displayName: "repo" })
  ).session.sessionId;
});

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("OAuth discovery and registration", () => {
  it("/mcp without a token returns 401 pointing at protected-resource metadata", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("publishes RFC 9728 and RFC 8414 metadata", async () => {
    const pr = await (await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr).toMatchObject({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL] });
    const as = await (await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("dynamic client registration accepts https redirects and rejects others", async () => {
    const ok = await fetch(`${BASE_URL}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT (e2e)", redirect_uris: [REDIRECT] }),
    });
    expect(ok.status).toBe(201);
    clientId = ((await ok.json()) as { client_id: string }).client_id;
    expect(clientId).toMatch(/^tlcli_[0-9a-f]{32}$/);

    const bad = await fetch(`${BASE_URL}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);
  });

  it("the consent page is behind Clerk (no anonymous authorization)", async () => {
    const res = await fetch(`${BASE_URL}/oauth/authorize?client_id=${clientId}`, {
      redirect: "manual",
    });
    expect(res.status).not.toBe(200);
  });
});

describe("PKCE code exchange", () => {
  it("rejects a wrong verifier, then issues a controller credential exactly once", async () => {
    const { code, verifier } = await authorizeAndExchange(ownerDb, clientId);
    const base = {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
    };
    const wrong = await token({ ...base, code_verifier: b64url(randomBytes(48)) });
    expect(wrong).toMatchObject({ status: 400, json: { error: "invalid_grant" } });

    // A wrong verifier is rejected without consuming the code (the whole
    // exchange is one transaction); the legitimate client can still redeem it.
    const good = await token({ ...base, code_verifier: verifier, resource: `${BASE_URL}/mcp` });
    expect(good.status).toBe(200);
    expect(good.json.token_type).toBe("Bearer");
    accessToken = good.json.access_token;
    expect(accessToken).toMatch(/^tlc_/);

    const replay = await token({ ...base, code_verifier: verifier });
    expect(replay.json.error).toBe("invalid_grant");
  });

  it("the issued credential is a chatgpt/controller connection owned by the consenting user", async () => {
    const who = await fetch(`${BASE_URL}/api/connection/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(await who.json()).toMatchObject({ platform: "chatgpt", role: "controller" });
  });

  it("re-authorizing the same client reuses the connection and rotates the credential", async () => {
    const before = (await (
      await fetch(`${BASE_URL}/api/connection/whoami`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).json()) as { connectionId: string };
    const again = await authorizeAndExchange(ownerDb, clientId);
    const res = await token({
      grant_type: "authorization_code",
      code: again.code,
      code_verifier: again.verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    });
    const rotated = res.json.access_token;
    const oldRes = await fetch(`${BASE_URL}/api/connection/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(oldRes.status).toBe(401);
    const newWho = (await (
      await fetch(`${BASE_URL}/api/connection/whoami`, {
        headers: { Authorization: `Bearer ${rotated}` },
      })
    ).json()) as { connectionId: string };
    expect(newWho.connectionId).toBe(before.connectionId);
    accessToken = rotated;
  });

  it("an agent credential cannot use /mcp", async () => {
    const { client, transport } = mcpClient(bridgeToken);
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

describe("MCP tools -> bridge -> result", () => {
  beforeAll(async () => {
    const c = mcpClient(accessToken);
    mcp = c.client;
    await mcp.connect(c.transport);
  });

  it("lists exactly the narrow ThreadLink tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "acknowledge_result",
        "ensure_session",
        "get_task_result",
        "get_task_status",
        "link_to_claude",
        "list_links",
        "list_recent_tasks",
        "send_to_agent",
        "threadlink_status",
        // Team Mode: projects (rooms) and team jobs.
        "create_room",
        "get_room",
        "get_team_log",
        "get_team_status",
        "list_rooms",
        "start_team_job",
        // Chat-first (0.10): chats reachable through this conversation's links.
        "create_chat",
        "get_chat",
        "get_chat_status",
        "get_job_result",
        "list_chats",
        "send_message",
      ].sort(),
    );
  });

  it("ensure_session creates a session and is idempotent by sessionRef", async () => {
    const first = await tool("ensure_session", { displayName: "E2E chat" });
    expect(first.isError).toBe(false);
    chatSessionId = first.data.sessionId as string;
    chatSessionRef = first.data.sessionRef as string;
    expect(chatSessionId).toMatch(/^tlses_/);
    const again = await tool("ensure_session", { sessionRef: chatSessionRef });
    expect(again.data.sessionId).toBe(chatSessionId);
  });

  it("send_to_agent with no link reports setup_required", async () => {
    const res = await tool("send_to_agent", { sessionId: chatSessionId, content: "hello" });
    expect(res.data.status).toBe("setup_required");
  });

  it("owner pairs from the dashboard; the bridge approves", async () => {
    const { data, error } = await ownerDb.rpc("owner_request_pairing", {
      p_controller_session_id: chatSessionId,
      p_agent_session_id: agentSessionId,
    });
    expect(error).toBeNull();
    linkId = (data as { id: string }).id;
    const pending = await bridge.links(agentSessionId);
    expect(pending.find((l) => l.linkId === linkId)?.status).toBe("pending");
    // Pending is not enough to route.
    expect(
      (await tool("send_to_agent", { sessionId: chatSessionId, content: "x" })).data.status,
    ).toBe("setup_required");
    expect((await bridge.approvePairing(agentSessionId, linkId)).status).toBe("active");
  });

  it("round trip: send_to_agent -> bridge worker -> get_task_result", async () => {
    const sent = await tool("send_to_agent", {
      sessionId: chatSessionId,
      content: "Summarise the README",
      priority: "B",
    });
    expect(sent.data).toMatchObject({ status: "queued", target: { linkId } });
    const taskId = sent.data.taskId as string;

    const outcome = await processNextTask({
      api: bridge,
      executor: new EchoExecutor(),
      sessionId: agentSessionId,
      claimRef: "e2e-bridge",
    });
    expect(outcome).toBe("completed");

    const status = await tool("get_task_status", { sessionId: chatSessionId, taskId });
    expect(status.data).toMatchObject({ status: "completed", attemptCount: 1 });
    const result = await tool("get_task_result", { sessionId: chatSessionId, taskId });
    expect(result.data.result).toBe("Echo: Summarise the README");
    expect((result.data.progress as unknown[]).length).toBeGreaterThan(0);

    const recent = await tool("list_recent_tasks", { sessionId: chatSessionId });
    expect((recent.data.tasks as { taskId: string }[]).map((t) => t.taskId)).toContain(taskId);
  });

  it("crash after claim: lease expires, task requeues, stale worker cannot finish, exactly once", async () => {
    const sent = await tool("send_to_agent", { sessionId: chatSessionId, content: "crash me" });
    const taskId = sent.data.taskId as string;

    // Worker 1 claims and "crashes" (never heartbeats again).
    await bridge.claim(taskId, agentSessionId, "crashed-worker");
    await bridge.start(taskId, agentSessionId, "crashed-worker");
    // Simulate time passing: expire the lease (local test DB only).
    const { error } = await admin
      .from("tasks")
      .update({ claimed_until: new Date(Date.now() - 1000).toISOString() })
      .eq("id", taskId);
    expect(error).toBeNull();

    // Worker 2 picks it up (delivery-time sweep requeues it) and completes.
    const outcome = await processNextTask({
      api: bridge,
      executor: new EchoExecutor(),
      sessionId: agentSessionId,
      claimRef: "fresh-worker",
    });
    expect(outcome).toBe("completed");

    // The stale worker's late completion is rejected.
    await expect(
      bridge.complete(taskId, agentSessionId, "crashed-worker", "late result", []),
    ).rejects.toMatchObject({ status: 409 });

    const result = await tool("get_task_result", { sessionId: chatSessionId, taskId });
    expect(result.data).toMatchObject({ status: "completed", result: "Echo: crash me" });
    const status = await tool("get_task_status", { sessionId: chatSessionId, taskId });
    expect(status.data.attemptCount).toBe(2);
  });

  it("another user's MCP credential cannot see this session or its tasks", async () => {
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
    const c = mcpClient(other.credential.token);
    await c.client.connect(c.transport);
    const res = await c.client.callTool({
      name: "list_recent_tasks",
      arguments: { sessionId: chatSessionId },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain("Summarise");
    await c.client.close();
  });

  it("revoking the link stops delivery; revoking the connection stops MCP", async () => {
    const { error } = await ownerDb.rpc("revoke_thread_link", { p_link_id: linkId });
    expect(error).toBeNull();
    expect(
      (await tool("send_to_agent", { sessionId: chatSessionId, content: "after revoke" })).data
        .status,
    ).toBe("setup_required");
    expect(await bridge.inbox(agentSessionId, 10)).toEqual([]);

    const who = (await (
      await fetch(`${BASE_URL}/api/connection/whoami`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).json()) as { connectionId: string };
    const revoked = await ownerDb.rpc("revoke_connection", { p_connection_id: who.connectionId });
    expect(revoked.error).toBeNull();
    const after = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });
});
