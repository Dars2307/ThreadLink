import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateConnectionToken,
  type ConnectionAuthDatabase,
} from "@/lib/connections/authenticate";
import { generateConnectionToken, hashConnectionToken } from "@/lib/connections/credentials";

const SECRET = "test-only-connection-secret-0123456789abcdefghij";
const IDENTITY_ROW = {
  connection_id: "tlcon_00112233445566778899aabbccddeeff",
  owner_user_id: "tlusr_0123456789abcdef0123456789abcdef",
  platform: "claude-code",
  role: "agent",
  status: "active",
};

/** Fake DB that recognizes exactly one hash, like authenticate_connection. */
function dbKnowing(hash: string | null, row: unknown = IDENTITY_ROW) {
  const rpc = vi.fn<ConnectionAuthDatabase["rpc"]>(async (_fn, args) => ({
    data: hash !== null && args.p_token_hash === hash ? row : null,
    error: null,
  }));
  return { db: { rpc } satisfies ConnectionAuthDatabase, rpc };
}

afterEach(() => vi.restoreAllMocks());

describe("authenticateConnectionToken", () => {
  it("valid credential resolves to a trusted identity", async () => {
    const { token } = generateConnectionToken();
    const { db } = dbKnowing(hashConnectionToken(token, SECRET));
    const result = await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    expect(result).toEqual({
      ok: true,
      credentialHash: hashConnectionToken(token, SECRET),
      identity: {
        connectionId: IDENTITY_ROW.connection_id,
        ownerUserId: IDENTITY_ROW.owner_user_id,
        platform: "claude-code",
        role: "agent",
        status: "active",
      },
    });
  });

  it("sends only the hash to the database, never the raw token", async () => {
    const { token } = generateConnectionToken();
    const { db, rpc } = dbKnowing(hashConnectionToken(token, SECRET));
    await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    const sent = JSON.stringify(rpc.mock.calls);
    expect(sent).not.toContain(token);
    expect(sent).toContain(hashConnectionToken(token, SECRET));
  });

  it("random credential fails", async () => {
    const { db } = dbKnowing(hashConnectionToken(generateConnectionToken().token, SECRET));
    const result = await authenticateConnectionToken(`Bearer ${generateConnectionToken().token}`, {
      secret: SECRET,
      db,
    });
    expect(result).toEqual({ ok: false, reason: "rejected" });
  });

  it.each([
    ["missing header", undefined, "missing"],
    ["non-bearer", "Basic abc", "missing"],
    ["malformed token", "Bearer tlc_nope", "malformed"],
    ["Clerk-style JWT", "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.sig", "malformed"],
  ])("%s fails without touching the database", async (_label, header, reason) => {
    const { db, rpc } = dbKnowing(null);
    const result = await authenticateConnectionToken(header, { secret: SECRET, db });
    expect(result).toEqual({ ok: false, reason });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("revoked credential fails (database returns no identity)", async () => {
    const { token } = generateConnectionToken();
    const { db } = dbKnowing(null); // authenticate_connection returns NULL when revoked
    const result = await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    expect(result.ok).toBe(false);
  });

  it("a token hashed under another deployment's secret does not match", async () => {
    const { token } = generateConnectionToken();
    const { db } = dbKnowing(
      hashConnectionToken(token, "some-other-deployment-secret-000000000000000"),
    );
    const result = await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    expect(result.ok).toBe(false);
  });

  it.each([
    ["database error", { data: null, error: { message: "boom" } }],
    [
      "revoked status leaking through",
      { data: { ...IDENTITY_ROW, status: "revoked" }, error: null },
    ],
    ["extra fields", { data: { ...IDENTITY_ROW, token_hash: "x" }, error: null }],
    ["bad connection id", { data: { ...IDENTITY_ROW, connection_id: "123" }, error: null }],
  ])("fails closed on %s", async (_label, response) => {
    const db: ConnectionAuthDatabase = { rpc: async () => response };
    const { token } = generateConnectionToken();
    const result = await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    expect(result.ok).toBe(false);
  });

  it("fails closed when the server secret is missing", async () => {
    const { token } = generateConnectionToken();
    const { db, rpc } = dbKnowing(null);
    const result = await authenticateConnectionToken(`Bearer ${token}`, { secret: "", db });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never writes the token to any console channel", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { token } = generateConnectionToken();
    const { db } = dbKnowing(null);
    await authenticateConnectionToken(`Bearer ${token}`, { secret: SECRET, db });
    await authenticateConnectionToken(`Bearer ${token}x`, { secret: SECRET, db });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(token);
  });
});
