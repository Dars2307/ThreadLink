import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection, revokeConnection } from "@/lib/connections/registration";

import {
  admin,
  clerkLikeToken,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/**
 * HTTP end-to-end: a real Next.js server (scripts/dev-local-supabase.mjs, :3200,
 * LOCAL Supabase, test-only secret) authenticating connection tokens at
 * /api/connection/whoami through proxy.ts -> route -> requireConnection().
 */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const WHOAMI = `${BASE_URL}/api/connection/whoami`;

const A = uniqueClerkId("E2E");
let user: ThreadLinkUser;
let db: Awaited<ReturnType<typeof userClient>>;
let token: string;
let connectionId: string;

async function whoami(authorization?: string) {
  const res = await fetch(WHOAMI, {
    headers: authorization ? { Authorization: authorization } : {},
    redirect: "manual",
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

beforeAll(async () => {
  const host = new URL(BASE_URL).hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) throw new Error("e2e must target a local server");
  const probe = await fetch(WHOAMI).catch(() => null);
  if (!probe) throw new Error("Start the server first: node scripts/dev-local-supabase.mjs");

  db = await userClient(A);
  user = await provisionThreadLinkUser(identity(A), { displayName: null, primaryEmail: null }, db);
  const registered = await registerConnection(
    db,
    user,
    { platform: "claude-code", displayName: "E2E bridge" },
    TEST_CONNECTION_SECRET,
  );
  token = registered.credential.token;
  connectionId = registered.connection.id;
});

afterAll(async () => {
  await admin.from("users").delete().eq("clerk_user_id", A);
});

describe("GET /api/connection/whoami", () => {
  it("accepts a valid connection credential without any Clerk session", async () => {
    const res = await whoami(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      connectionId,
      platform: "claude-code",
      role: "agent",
      status: "active",
    });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body).not.toContain(user.id); // owner IDs are not exposed
  });

  it.each([
    ["no header", undefined],
    ["random token", `Bearer tlc_${Buffer.alloc(32, 1).toString("base64url")}`],
    ["malformed token", "Bearer tlc_nope"],
    ["wrong scheme", `Basic ${Buffer.from("a:b").toString("base64")}`],
  ])("rejects %s with a generic 401", async (_label, header) => {
    const res = await whoami(header);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("rejects a Clerk-style session token (humans cannot impersonate connections)", async () => {
    const res = await whoami(`Bearer ${await clerkLikeToken(A)}`);
    expect(res.status).toBe(401);
  });

  it("stops accepting the credential immediately after revocation", async () => {
    await revokeConnection(db, user, connectionId);
    const res = await whoami(`Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("other protected API routes still require a Clerk session", async () => {
    const res = await fetch(`${BASE_URL}/api/not-a-connection-route`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual",
    });
    expect([401, 404, 307]).toContain(res.status);
  });
});
