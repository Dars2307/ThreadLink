import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import {
  admin,
  clerkLikeToken,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * HTTP e2e for the session + pairing client API against a real Next.js server
 * (scripts/dev-local-supabase.mjs, :3200, LOCAL Supabase, test-only secret).
 */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2EPair");
const B = uniqueClerkId("E2EPairB");

let controllerToken: string;
let agentToken: string;
let otherUserAgentToken: string;

async function api(
  path: string,
  token: string | null,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown>, text };
}

beforeAll(async () => {
  const host = new URL(BASE_URL).hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("e2e must target a local server");
  if (!(await fetch(BASE_URL).catch(() => null))) {
    throw new Error("Start the server first: npm run dev:local-db");
  }
  const none = { displayName: null, primaryEmail: null };
  const dbA = await userClient(A);
  const userA = await provisionThreadLinkUser(identity(A), none, dbA);
  controllerToken = (
    await registerConnection(dbA, userA, { platform: "chatgpt" }, TEST_CONNECTION_SECRET)
  ).credential.token;
  agentToken = (
    await registerConnection(dbA, userA, { platform: "claude-code" }, TEST_CONNECTION_SECRET)
  ).credential.token;

  const dbB = await userClient(B);
  const userB = await provisionThreadLinkUser(identity(B), none, dbB);
  otherUserAgentToken = (
    await registerConnection(dbB, userB, { platform: "claude-code" }, TEST_CONNECTION_SECRET)
  ).credential.token;
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("client API over HTTP", () => {
  let chat: string;
  let repo: string;
  let otherRepo: string;
  let linkId: string;

  it("every client route rejects missing, random and Clerk-session credentials with a generic 401", async () => {
    const random = `tlc_${Buffer.alloc(32, 9).toString("base64url")}`;
    const clerkJwt = await clerkLikeToken(A);
    const routes: [string, "GET" | "POST"][] = [
      ["/api/session/register", "POST"],
      ["/api/session/me?sessionId=tlses_00000000000000000000000000000000", "GET"],
      ["/api/session/retire", "POST"],
      ["/api/pairing?sessionId=tlses_00000000000000000000000000000000", "GET"],
      ["/api/pairing/request", "POST"],
      ["/api/pairing/approve", "POST"],
      ["/api/pairing/revoke", "POST"],
    ];
    for (const [path, method] of routes) {
      for (const token of [null, random, clerkJwt]) {
        const res = await api(path, token, { method, body: method === "POST" ? {} : undefined });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.json).toEqual({ error: "unauthorized" });
      }
    }
  });

  it("registers sessions; identity comes from the connection", async () => {
    const c = await api("/api/session/register", controllerToken, {
      method: "POST",
      body: { displayName: "Planning", localBindingRef: "chat-1" },
    });
    expect(c.status).toBe(200);
    chat = (c.json.session as { sessionId: string }).sessionId;
    expect(c.json.session).toMatchObject({ platform: "chatgpt", role: "controller" });

    const g = await api("/api/session/register", agentToken, {
      method: "POST",
      body: { localBindingRef: "cc-1" },
    });
    repo = (g.json.session as { sessionId: string }).sessionId;

    const o = await api("/api/session/register", otherUserAgentToken, { method: "POST", body: {} });
    otherRepo = (o.json.session as { sessionId: string }).sessionId;
    expect([chat, repo, otherRepo].every((id) => /^tlses_[0-9a-f]{32}$/.test(id))).toBe(true);
  });

  it("rejects client-supplied ownership/role fields", async () => {
    const res = await api("/api/session/register", agentToken, {
      method: "POST",
      body: { role: "controller", ownerUserId: "tlusr_00000000000000000000000000000000" },
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid" });
  });

  it("GET /api/session/me returns only safe metadata for the caller's own session", async () => {
    const me = await api(`/api/session/me?sessionId=${chat}`, controllerToken);
    expect(me.status).toBe(200);
    expect(Object.keys(me.json).sort()).toEqual(
      ["connectionId", "displayName", "platform", "role", "sessionId", "status"].sort(),
    );
    const foreign = await api(`/api/session/me?sessionId=${chat}`, agentToken);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
  });

  it("pairing: request -> pending -> approve by the exact agent -> active", async () => {
    const req = await api("/api/pairing/request", controllerToken, {
      method: "POST",
      body: { controllerSessionId: chat, agentSessionId: repo },
    });
    expect(req.status).toBe(200);
    expect(req.json.status).toBe("pending");
    linkId = req.json.linkId as string;

    const selfApprove = await api("/api/pairing/approve", controllerToken, {
      method: "POST",
      body: { sessionId: chat, linkId },
    });
    expect(selfApprove.status).toBe(403);

    const otherUser = await api("/api/pairing/approve", otherUserAgentToken, {
      method: "POST",
      body: { sessionId: otherRepo, linkId },
    });
    expect(otherUser.status).toBe(404);

    const pending = await api(`/api/pairing?sessionId=${repo}`, agentToken);
    expect((pending.json.links as { linkId: string; status: string }[])[0]).toMatchObject({
      linkId,
      status: "pending",
    });

    const approve = await api("/api/pairing/approve", agentToken, {
      method: "POST",
      body: { sessionId: repo, linkId },
    });
    expect(approve.status).toBe(200);
    expect(approve.json.status).toBe("active");
  });

  it("cross-user pairing is denied without revealing the target", async () => {
    const res = await api("/api/pairing/request", controllerToken, {
      method: "POST",
      body: { controllerSessionId: chat, agentSessionId: otherRepo },
    });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "not_found" });
  });

  it("revoke is terminal; retiring a session cascades", async () => {
    const revoke = await api("/api/pairing/revoke", controllerToken, {
      method: "POST",
      body: { sessionId: chat, linkId },
    });
    expect(revoke.json).toMatchObject({
      status: "revoked",
      revokedReason: "revoked_by_controller",
    });
    const reapprove = await api("/api/pairing/approve", agentToken, {
      method: "POST",
      body: { sessionId: repo, linkId },
    });
    expect(reapprove.status).toBe(409);

    const fresh = await api("/api/pairing/request", controllerToken, {
      method: "POST",
      body: { controllerSessionId: chat, agentSessionId: repo },
    });
    expect(fresh.json.linkId).not.toBe(linkId);

    const retire = await api("/api/session/retire", agentToken, {
      method: "POST",
      body: { sessionId: repo },
    });
    expect(retire.json.status).toBe("retired");
    const links = await api(`/api/pairing?sessionId=${chat}`, controllerToken);
    const cascaded = (links.json.links as { linkId: string; revokedReason: string | null }[]).find(
      (l) => l.linkId === fresh.json.linkId,
    );
    expect(cascaded?.revokedReason).toBe("agent_session_ended");
  });

  it("rejects oversized and malformed bodies", async () => {
    const big = await api("/api/session/register", agentToken, {
      method: "POST",
      body: { displayName: "x".repeat(9000) },
    });
    expect(big.status).toBe(400);
    const res = await fetch(`${BASE_URL}/api/pairing/request`, {
      method: "POST",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
