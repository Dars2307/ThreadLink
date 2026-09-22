import { describe, expect, it, vi } from "vitest";

import {
  approvePairing,
  ClientOperationError,
  getSession,
  registerSession,
  requestPairing,
  revokePairing,
  type ClientDatabase,
} from "@/lib/client-api/operations";
import { requestPairingInputSchema } from "@/lib/pairing/model";
import { registerSessionInputSchema } from "@/lib/sessions/model";

const HASH = "ab".repeat(32);
const S1 = "tlses_00112233445566778899aabbccddeeff";
const S2 = "tlses_ffeeddccbbaa99887766554433221100";
const L1 = "tllnk_00112233445566778899aabbccddeeff";

const sessionRow = {
  id: S1,
  connection_id: "tlcon_00112233445566778899aabbccddeeff",
  platform: "claude-code",
  role: "agent",
  display_name: "repo",
  provider_session_ref: null,
  local_binding_ref: "cc-1",
  status: "active",
  created_at: "2026-09-22T00:00:00Z",
  last_seen_at: null,
  retired_at: null,
  revoked_at: null,
  created: true,
};
const linkRow = {
  id: L1,
  controller_session_id: S2,
  agent_session_id: S1,
  status: "pending",
  revoked_reason: null,
  requested_at: "2026-09-22T00:00:00Z",
  approved_at: null,
  revoked_at: null,
};

function fakeDb(response: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn<ClientDatabase["rpc"]>(async () => response);
  return { db: { rpc } satisfies ClientDatabase, rpc };
}

describe("session input", () => {
  it("accepts only safe metadata", () => {
    expect(registerSessionInputSchema.safeParse({}).success).toBe(true);
    expect(
      registerSessionInputSchema.safeParse({
        displayName: "Planning",
        providerSessionRef: "native-123",
        localBindingRef: "local-1",
      }).success,
    ).toBe(true);
  });

  it.each([
    "owner_user_id",
    "ownerUserId",
    "connection_id",
    "connectionId",
    "role",
    "platform",
    "id",
    "sessionId",
    "status",
  ])("rejects client-supplied %s", (key) => {
    expect(registerSessionInputSchema.safeParse({ [key]: "x" }).success).toBe(false);
  });

  it.each(["has spaces", "", "x".repeat(129), "semi;colon"])(
    "rejects local_binding_ref %j",
    (localBindingRef) => {
      expect(registerSessionInputSchema.safeParse({ localBindingRef }).success).toBe(false);
    },
  );

  it("rejects over-long provider refs", () => {
    expect(
      registerSessionInputSchema.safeParse({ providerSessionRef: "a".repeat(256) }).success,
    ).toBe(false);
  });
});

describe("pairing input", () => {
  it("requires two distinct, well-formed session IDs", () => {
    expect(
      requestPairingInputSchema.safeParse({ controllerSessionId: S2, agentSessionId: S1 }).success,
    ).toBe(true);
    expect(
      requestPairingInputSchema.safeParse({ controllerSessionId: S1, agentSessionId: S1 }).success,
    ).toBe(false);
    expect(
      requestPairingInputSchema.safeParse({ controllerSessionId: "user_x", agentSessionId: S1 })
        .success,
    ).toBe(false);
    expect(
      requestPairingInputSchema.safeParse({
        controllerSessionId: S2,
        agentSessionId: S1,
        ownerUserId: "tlusr_00112233445566778899aabbccddeeff",
      }).success,
    ).toBe(false);
  });
});

describe("client operations", () => {
  it("registerSession sends the credential HMAC and only safe metadata", async () => {
    const { db, rpc } = fakeDb({ data: sessionRow, error: null });
    const result = await registerSession(db, HASH, {
      displayName: "repo",
      localBindingRef: "cc-1",
    });
    expect(rpc).toHaveBeenCalledWith("register_session", {
      p_token_hash: HASH,
      p_display_name: "repo",
      p_provider_session_ref: null,
      p_local_binding_ref: "cc-1",
    });
    expect(result).toEqual({
      created: true,
      session: {
        sessionId: S1,
        connectionId: sessionRow.connection_id,
        platform: "claude-code",
        role: "agent",
        displayName: "repo",
        status: "active",
      },
    });
  });

  it("safe session view exposes no owner internals or refs", async () => {
    const { db } = fakeDb({ data: sessionRow, error: null });
    const session = await getSession(db, HASH, S1);
    expect(Object.keys(session).sort()).toEqual(
      ["connectionId", "displayName", "platform", "role", "sessionId", "status"].sort(),
    );
  });

  it("invalid input never reaches the database", async () => {
    const { db, rpc } = fakeDb({ data: linkRow, error: null });
    await expect(requestPairing(db, HASH, { controllerSessionId: S1 })).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(approvePairing(db, HASH, { sessionId: S1, linkId: "nope" })).rejects.toMatchObject(
      { kind: "invalid" },
    );
    await expect(getSession(db, HASH, null)).rejects.toMatchObject({ kind: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("approve passes the approving session as the exact agent session", async () => {
    const { db, rpc } = fakeDb({
      data: { ...linkRow, status: "active", approved_at: "x" },
      error: null,
    });
    await approvePairing(db, HASH, { sessionId: S1, linkId: L1 });
    expect(rpc).toHaveBeenCalledWith("approve_pairing", {
      p_token_hash: HASH,
      p_agent_session_id: S1,
      p_link_id: L1,
    });
  });

  it.each([
    ["28000", "unauthorized"],
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["55000", "conflict"],
    ["54000", "limit"],
    ["23514", "invalid"],
    ["XX000", "unavailable"],
    [undefined, "unavailable"],
  ])("maps database error %s to %s", async (code, kind) => {
    const { db } = fakeDb({ data: null, error: { message: "secret detail", code } });
    const error = await revokePairing(db, HASH, { sessionId: S1, linkId: L1 }).catch((e) => e);
    expect(error).toBeInstanceOf(ClientOperationError);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("secret detail");
  });

  it("fails closed on malformed database rows", async () => {
    const { db } = fakeDb({ data: { ...linkRow, status: "hacked" }, error: null });
    await expect(
      requestPairing(db, HASH, { controllerSessionId: S2, agentSessionId: S1 }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
