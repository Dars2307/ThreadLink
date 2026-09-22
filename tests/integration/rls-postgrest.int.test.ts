import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import { createConnection, listConnections } from "@/lib/connections/queries";

/**
 * End-to-end tenant isolation through the real stack:
 * app code -> supabase-js (accessToken) -> PostgREST -> Postgres RLS.
 *
 * Local tokens are signed with the local stack's JWT secret to stand in for
 * Clerk session tokens (same claims shape: sub = Clerk user ID, role = authenticated).
 */

const env = inject("supabase");
const runId = randomBytes(6).toString("hex");
const A = `user_itestA${runId}`;
const B = `user_itestB${runId}`;
const C = `user_itestC${runId}`;

async function tokenFor(sub: string | null, secret = env.jwtSecret): Promise<string> {
  const claims: Record<string, unknown> = { role: "authenticated" };
  if (sub !== null) claims.sub = sub;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

function clientWithToken(token: string | null): SupabaseClient {
  return createClient(env.url, env.publishableKey, {
    accessToken: async () => token,
  });
}

async function clientFor(sub: string): Promise<SupabaseClient> {
  return clientWithToken(await tokenFor(sub));
}

function identity(sub: string) {
  return { clerkUserId: sub, sessionId: "sess_integration" };
}

// Local-only privileged client for fixture cleanup/verification.
const admin = createClient(env.url, env.secretKey, { auth: { persistSession: false } });

let dbA: SupabaseClient;
let dbB: SupabaseClient;
let userA: ThreadLinkUser;
let userB: ThreadLinkUser;

beforeAll(async () => {
  dbA = await clientFor(A);
  dbB = await clientFor(B);
  userA = await provisionThreadLinkUser(
    identity(A),
    { displayName: "Alice", primaryEmail: null },
    dbA,
  );
  userB = await provisionThreadLinkUser(
    identity(B),
    { displayName: "Bob", primaryEmail: null },
    dbB,
  );
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B, C]);
});

describe("lazy provisioning through PostgREST", () => {
  it("maps the token subject to a new tlusr_ identity", () => {
    expect(userA.id).toMatch(/^tlusr_[0-9a-f]{32}$/);
    expect(userA.clerkUserId).toBe(A);
    expect(userB.id).not.toBe(userA.id);
  });

  it("is idempotent", async () => {
    const again = await provisionThreadLinkUser(
      identity(A),
      { displayName: null, primaryEmail: null },
      dbA,
    );
    expect(again.id).toBe(userA.id);
  });

  it("is race-safe under concurrent first requests", async () => {
    const dbC = await clientFor(C);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        provisionThreadLinkUser(identity(C), { displayName: "Carol", primaryEmail: null }, dbC),
      ),
    );
    expect(new Set(results.map((user) => user.id)).size).toBe(1);
    const { count } = await admin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("clerk_user_id", C);
    expect(count).toBe(1);
  });

  it("fails closed if the verified identity does not match the token subject", async () => {
    // Server believes the caller is B, but the token is A's: mismatch is rejected.
    await expect(
      provisionThreadLinkUser(identity(B), { displayName: null, primaryEmail: null }, dbA),
    ).rejects.toThrow("ThreadLink account unavailable");
  });
});

describe("connections isolation through PostgREST", () => {
  let connectionB: string;

  beforeAll(async () => {
    const created = await createConnection(dbB, userB, { platform: "chatgpt", role: "controller" });
    connectionB = created.id;
  });

  it("User A can create and read their own connection", async () => {
    const created = await createConnection(dbA, userA, {
      platform: "claude-code",
      role: "agent",
      displayName: "Alice laptop",
    });
    expect(created.ownerUserId).toBe(userA.id);
    expect(created.id).toMatch(/^tlcon_[0-9a-f]{32}$/);

    const mine = await listConnections(dbA, userA);
    expect(mine.map((connection) => connection.id)).toEqual([created.id]);
  });

  it("User A cannot read User B's profile or connections", async () => {
    const profiles = await dbA.from("users").select("id").eq("clerk_user_id", B);
    expect(profiles.data).toEqual([]);
    const byId = await dbA.from("connections").select("id").eq("id", connectionB);
    expect(byId.data).toEqual([]);
    const byOwner = await dbA.from("connections").select("id").eq("owner_user_id", userB.id);
    expect(byOwner.data).toEqual([]);
  });

  it("User A cannot modify or delete User B's connection", async () => {
    const updated = await dbA
      .from("connections")
      .update({ display_name: "pwned" })
      .eq("id", connectionB)
      .select("id");
    expect(updated.data).toEqual([]);

    const deleted = await dbA.from("connections").delete().eq("id", connectionB).select("id");
    expect(deleted.data).toEqual([]);

    const check = await admin
      .from("connections")
      .select("display_name, owner_user_id")
      .eq("id", connectionB)
      .single();
    expect(check.data).toEqual({ display_name: null, owner_user_id: userB.id });
  });

  it("User A cannot create a connection owned by User B", async () => {
    const result = await dbA
      .from("connections")
      .insert({ owner_user_id: userB.id, platform: "chatgpt", role: "controller" });
    expect(result.error?.code).toBe("42501");
  });

  it("application layer rejects ownership fields before reaching the database", async () => {
    await expect(
      createConnection(dbA, userA, {
        platform: "chatgpt",
        role: "controller",
        owner_user_id: userB.id,
      }),
    ).rejects.toThrow();
  });
});

describe("unauthenticated and invalid tokens", () => {
  it("anonymous requests are denied", async () => {
    const anon = clientWithToken(null);
    const users = await anon.from("users").select("id");
    expect(users.error?.code).toBe("42501");
    const connections = await anon.from("connections").select("id");
    expect(connections.error?.code).toBe("42501");
    const rpc = await anon.rpc("provision_current_user", {
      p_display_name: null,
      p_primary_email: null,
    });
    expect(rpc.error).not.toBeNull();
  });

  it("tokens signed with the wrong key are rejected", async () => {
    const forged = clientWithToken(await tokenFor(A, "x".repeat(40)));
    const result = await forged.from("users").select("id");
    expect(result.error).not.toBeNull();
    expect(result.data).toBeNull();
  });

  it("tokens without a subject cannot provision or read", async () => {
    const noSub = clientWithToken(await tokenFor(null));
    const rpc = await noSub.rpc("provision_current_user", {
      p_display_name: null,
      p_primary_email: null,
    });
    expect(rpc.error).not.toBeNull();
    const users = await noSub.from("users").select("id");
    expect(users.data).toEqual([]);
  });

  it("malformed subjects are treated as no identity", async () => {
    const bad = clientWithToken(await tokenFor("alice@example.com"));
    const users = await bad.from("users").select("id");
    expect(users.data).toEqual([]);
  });
});
