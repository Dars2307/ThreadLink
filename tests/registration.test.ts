import { describe, expect, it, vi } from "vitest";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { hashConnectionToken } from "@/lib/connections/credentials";
import {
  ConnectionLimitError,
  ConnectionNotFoundError,
  registerConnection,
  revokeConnection,
  rotateConnectionCredential,
  type RegistrationDatabase,
} from "@/lib/connections/registration";

const SECRET = "test-only-connection-secret-0123456789abcdefghij";
const USER: ThreadLinkUser = {
  id: "tlusr_0123456789abcdef0123456789abcdef",
  clerkUserId: "user_AliceTest01",
  displayName: "Alice",
  primaryEmail: null,
  createdAt: "2026-09-22T00:00:00Z",
};
const CONNECTION_ID = "tlcon_00112233445566778899aabbccddeeff";

function connectionJson(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    owner_user_id: USER.id,
    platform: "claude-code",
    role: "agent",
    status: "active",
    display_name: "Laptop",
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    last_seen_at: null,
    revoked_at: null,
    credential: {
      id: "tlcrd_00112233445566778899aabbccddeeff",
      token_prefix: "tlc_abcdef",
      created_at: "2026-09-22T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
    },
    ...overrides,
  };
}

function fakeDb(response: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn<RegistrationDatabase["rpc"]>(async () => response);
  return { db: { rpc } satisfies RegistrationDatabase, rpc };
}

describe("registerConnection", () => {
  it("issues a credential and sends only its hash + prefix", async () => {
    const { db, rpc } = fakeDb({ data: connectionJson(), error: null });
    const { credential, connection } = await registerConnection(
      db,
      USER,
      { platform: "claude-code", displayName: "Laptop" },
      SECRET,
    );
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("register_connection");
    expect(args).toEqual({
      p_platform: "claude-code",
      p_role: "agent",
      p_display_name: "Laptop",
      p_token_hash: hashConnectionToken(credential.token, SECRET),
      p_token_prefix: credential.tokenPrefix,
    });
    expect(JSON.stringify(args)).not.toContain(credential.token);
    expect(connection.ownerUserId).toBe(USER.id);
  });

  it("derives controller role for ChatGPT", async () => {
    const { db, rpc } = fakeDb({
      data: connectionJson({ platform: "chatgpt", role: "controller" }),
      error: null,
    });
    await registerConnection(db, USER, { platform: "chatgpt" }, SECRET);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_platform: "chatgpt", p_role: "controller" });
  });

  it("repeated registration produces different credentials", async () => {
    const { db } = fakeDb({ data: connectionJson(), error: null });
    const a = await registerConnection(db, USER, { platform: "claude-code" }, SECRET);
    const b = await registerConnection(db, USER, { platform: "claude-code" }, SECRET);
    expect(a.credential.token).not.toBe(b.credential.token);
  });

  it.each([
    { platform: "claude-code", owner_user_id: "tlusr_fedcba9876543210fedcba9876543210" },
    { platform: "claude-code", clerk_user_id: "user_BobTest02" },
    { platform: "claude-code", role: "controller" },
    { platform: "claude-code", token: "tlc_" + "a".repeat(43) },
    { platform: "codex" },
  ])("rejects untrusted input %o before calling the database", async (input) => {
    const { db, rpc } = fakeDb({ data: connectionJson(), error: null });
    await expect(registerConnection(db, USER, input, SECRET)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the database cap to ConnectionLimitError", async () => {
    const { db } = fakeDb({ data: null, error: { message: "limit", code: "54000" } });
    await expect(
      registerConnection(db, USER, { platform: "chatgpt" }, SECRET),
    ).rejects.toBeInstanceOf(ConnectionLimitError);
  });

  it("fails closed if the database returns another user's connection", async () => {
    const { db } = fakeDb({
      data: connectionJson({ owner_user_id: "tlusr_fedcba9876543210fedcba9876543210" }),
      error: null,
    });
    await expect(registerConnection(db, USER, { platform: "chatgpt" }, SECRET)).rejects.toThrow(
      "Resource ownership check failed",
    );
  });
});

describe("revokeConnection / rotateConnectionCredential", () => {
  it("rejects malformed IDs without calling the database", async () => {
    const { db, rpc } = fakeDb({ data: connectionJson(), error: null });
    await expect(revokeConnection(db, USER, "user_BobTest02")).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    await expect(rotateConnectionCredential(db, USER, 42, SECRET)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps another user's or a nonexistent connection to the same not-found error", async () => {
    const { db } = fakeDb({
      data: null,
      error: { message: "connection not found", code: "P0002" },
    });
    await expect(revokeConnection(db, USER, CONNECTION_ID)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it("rotation issues a fresh credential and sends only its hash", async () => {
    const { db, rpc } = fakeDb({ data: connectionJson(), error: null });
    const { credential } = await rotateConnectionCredential(db, USER, CONNECTION_ID, SECRET);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("rotate_connection_credential");
    expect(args.p_token_hash).toBe(hashConnectionToken(credential.token, SECRET));
    expect(JSON.stringify(args)).not.toContain(credential.token);
  });
});
