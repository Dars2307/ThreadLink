import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import { authenticateConnectionToken } from "@/lib/connections/authenticate";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { listConnections } from "@/lib/connections/queries";
import {
  ConnectionNotFoundError,
  registerConnection,
  revokeConnection,
  rotateConnectionCredential,
} from "@/lib/connections/registration";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * Connection credential lifecycle through the real stack:
 * app code -> supabase-js -> PostgREST -> SECURITY DEFINER functions + RLS.
 */

const A = uniqueClerkId("CredA");
const B = uniqueClerkId("CredB");
const issuedTokens: string[] = [];

let userA: ThreadLinkUser;
let userB: ThreadLinkUser;
let dbA: Awaited<ReturnType<typeof userClient>>;
let dbB: Awaited<ReturnType<typeof userClient>>;

const authenticate = (token: string) =>
  authenticateConnectionToken(`Bearer ${token}`, {
    secret: TEST_CONNECTION_SECRET,
    db: anonymousClient(),
  });

beforeAll(async () => {
  dbA = await userClient(A);
  dbB = await userClient(B);
  const none = { displayName: null, primaryEmail: null };
  userA = await provisionThreadLinkUser(identity(A), none, dbA);
  userB = await provisionThreadLinkUser(identity(B), none, dbB);
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("registration", () => {
  it("registers a ChatGPT controller and a Claude Code agent with distinct credentials", async () => {
    const gpt = await registerConnection(
      dbA,
      userA,
      { platform: "chatgpt" },
      TEST_CONNECTION_SECRET,
    );
    const cc = await registerConnection(
      dbA,
      userA,
      { platform: "claude-code", displayName: "Laptop" },
      TEST_CONNECTION_SECRET,
    );
    issuedTokens.push(gpt.credential.token, cc.credential.token);

    expect(gpt.connection).toMatchObject({
      platform: "chatgpt",
      role: "controller",
      status: "active",
    });
    expect(cc.connection).toMatchObject({
      platform: "claude-code",
      role: "agent",
      status: "active",
    });
    expect(gpt.credential.token).not.toBe(cc.credential.token);
    expect(cc.connection.credential?.tokenPrefix).toBe(cc.credential.tokenPrefix);
  });

  it("stores only the keyed hash; the raw token appears in no row of any table", async () => {
    const tables = ["users", "connections", "connection_credentials", "audit_events"] as const;
    const dump = JSON.stringify(
      await Promise.all(tables.map(async (t) => (await admin.from(t).select("*")).data)),
    );
    for (const token of issuedTokens) {
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(token.slice(10)); // the secret part
      expect(dump).toContain(hashConnectionToken(token, TEST_CONNECTION_SECRET));
    }
  });

  it("the credential hash is not readable by its owner through the API", async () => {
    const result = await dbA.from("connection_credentials").select("token_hash");
    expect(result.error?.code).toBe("42501");
  });

  it("subsequent reads return metadata only", async () => {
    const mine = await listConnections(dbA, userA);
    expect(mine).toHaveLength(2);
    const serialized = JSON.stringify(mine);
    for (const token of issuedTokens) expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("connection authentication", () => {
  it("valid credential authenticates without any Clerk session", async () => {
    const result = await authenticate(issuedTokens[1]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toMatchObject({
        ownerUserId: userA.id,
        platform: "claude-code",
        role: "agent",
        status: "active",
      });
    }
  });

  it("updates last-used metadata through the trusted path", async () => {
    const mine = await listConnections(dbA, userA);
    const agent = mine.find((c) => c.platform === "claude-code")!;
    expect(agent.lastSeenAt).not.toBeNull();
    expect(agent.credential?.lastUsedAt).not.toBeNull();
  });

  it("random and malformed credentials fail", async () => {
    const random = "tlc_" + Buffer.alloc(32, 7).toString("base64url");
    expect((await authenticate(random)).ok).toBe(false);
    expect((await authenticate("tlc_short")).ok).toBe(false);
  });

  it("a hash computed under a different secret cannot authenticate", async () => {
    const result = await authenticateConnectionToken(`Bearer ${issuedTokens[1]}`, {
      secret: "a-different-deployment-secret-0123456789abcdefgh",
      db: anonymousClient(),
    });
    expect(result.ok).toBe(false);
  });

  it("User A cannot claim User B's credential, nor B claim A's connection", async () => {
    const b = await registerConnection(
      dbB,
      userB,
      { platform: "claude-code" },
      TEST_CONNECTION_SECRET,
    );
    const result = await authenticate(b.credential.token);
    expect(result.ok && result.identity.ownerUserId).toBe(userB.id);
    // B's credential never maps to A, and A cannot revoke/rotate B's connection.
    await expect(revokeConnection(dbA, userA, b.connection.id)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    await expect(
      rotateConnectionCredential(dbA, userA, b.connection.id, TEST_CONNECTION_SECRET),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect((await authenticate(b.credential.token)).ok).toBe(true);
  });
});

describe("rotation and revocation", () => {
  it("rotation invalidates the old credential and issues a working new one", async () => {
    const [gpt] = (await listConnections(dbA, userA)).filter((c) => c.platform === "chatgpt");
    const rotated = await rotateConnectionCredential(dbA, userA, gpt.id, TEST_CONNECTION_SECRET);
    expect((await authenticate(issuedTokens[0])).ok).toBe(false);
    expect((await authenticate(rotated.credential.token)).ok).toBe(true);
    issuedTokens[0] = rotated.credential.token;
  });

  it("revocation takes effect immediately and is idempotent", async () => {
    const agent = (await listConnections(dbA, userA)).find((c) => c.platform === "claude-code")!;
    expect((await authenticate(issuedTokens[1])).ok).toBe(true);

    const revoked = await revokeConnection(dbA, userA, agent.id);
    expect(revoked.status).toBe("revoked");
    expect((await authenticate(issuedTokens[1])).ok).toBe(false);

    const again = await revokeConnection(dbA, userA, agent.id);
    expect(again.status).toBe("revoked");
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("a revoked connection stays in history and cannot be reissued", async () => {
    const agent = (await listConnections(dbA, userA)).find((c) => c.platform === "claude-code")!;
    expect(agent.status).toBe("revoked");
    await expect(
      rotateConnectionCredential(dbA, userA, agent.id, TEST_CONNECTION_SECRET),
    ).rejects.toThrow();
  });

  it("audit events record lifecycle without secrets", async () => {
    const { data } = await dbA.from("audit_events").select("action, outcome, metadata");
    const actions = (data ?? []).map((e) => e.action).sort();
    expect(actions).toEqual(
      expect.arrayContaining([
        "connection.auth_failed",
        "connection.created",
        "connection.credential_rotated",
        "connection.revoked",
      ]),
    );
    const serialized = JSON.stringify(data);
    for (const token of issuedTokens) expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("anonymous access", () => {
  it("anonymous callers cannot register, revoke or read credentials", async () => {
    const anon = anonymousClient();
    expect((await anon.from("connection_credentials").select("id")).error?.code).toBe("42501");
    expect((await anon.from("audit_events").select("id")).error?.code).toBe("42501");
    const reg = await anon.rpc("register_connection", {
      p_platform: "chatgpt",
      p_role: "controller",
      p_display_name: null,
      p_token_hash: "0".repeat(64),
      p_token_prefix: "tlc_anon01",
    });
    expect(reg.error).not.toBeNull();
    const rev = await anon.rpc("revoke_connection", {
      p_connection_id: "tlcon_00000000000000000000000000000000",
    });
    expect(rev.error).not.toBeNull();
  });
});
