import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ClientOperationError, type ClientDatabase } from "@/lib/client-api/operations";
import {
  describeError,
  ensureSession,
  resolveLink,
  sendToAgent,
  toolInputs,
  type McpContext,
} from "@/lib/mcp/tools";
import type { ThreadLinkView } from "@/lib/pairing/model";

const S = "tlses_00112233445566778899aabbccddeeff";
const G = "tlses_ffeeddccbbaa99887766554433221100";
const L1 = "tllnk_00112233445566778899aabbccddeeff";
const L2 = "tllnk_ffeeddccbbaa99887766554433221100";

const link = (
  linkId: string,
  status: ThreadLinkView["status"],
  agent = "Laptop",
): ThreadLinkView => ({
  linkId,
  controllerSessionId: S,
  agentSessionId: G,
  controllerDisplayName: "Chat",
  agentDisplayName: agent,
  status,
  revokedReason: null,
  requestedAt: "2026-09-22T00:00:00Z",
  approvedAt: null,
  revokedAt: null,
});

const linkRow = (l: ThreadLinkView) => ({
  id: l.linkId,
  controller_session_id: l.controllerSessionId,
  agent_session_id: l.agentSessionId,
  controller_display_name: l.controllerDisplayName,
  agent_display_name: l.agentDisplayName,
  status: l.status,
  revoked_reason: null,
  requested_at: l.requestedAt,
  approved_at: null,
  revoked_at: null,
});

function ctxWith(responses: Record<string, unknown>) {
  const rpc = vi.fn<ClientDatabase["rpc"]>(async (fn) => ({
    data: responses[fn] ?? null,
    error: null,
  }));
  const ctx: McpContext = {
    db: { rpc },
    credentialHash: "ab".repeat(32),
    identity: {
      connectionId: "tlcon_00112233445566778899aabbccddeeff",
      ownerUserId: "tlusr_00112233445566778899aabbccddeeff",
      platform: "chatgpt",
      role: "controller",
      status: "active",
    },
  };
  return { ctx, rpc };
}

describe("resolveLink (never guesses)", () => {
  it("0 active links -> setup required", () => {
    expect(resolveLink([link(L1, "pending"), link(L2, "revoked")])).toEqual({
      kind: "setup_required",
    });
  });
  it("1 active link -> used automatically", () => {
    expect(resolveLink([link(L1, "active"), link(L2, "pending")])).toMatchObject({
      kind: "ok",
      link: { linkId: L1 },
    });
  });
  it("several active links -> disambiguation required", () => {
    expect(resolveLink([link(L1, "active", "Laptop"), link(L2, "active", "Desktop")])).toEqual({
      kind: "choose",
      options: [
        { linkId: L1, agent: "Laptop" },
        { linkId: L2, agent: "Desktop" },
      ],
    });
  });
  it("an explicit linkId must be one of the session's active links", () => {
    expect(resolveLink([link(L1, "active"), link(L2, "active")], L2)).toMatchObject({
      kind: "ok",
      link: { linkId: L2 },
    });
    expect(() => resolveLink([link(L1, "active")], L2)).toThrow();
  });
});

describe("MCP tool inputs", () => {
  const send = z.object(toolInputs.send_to_agent);
  it("send_to_agent needs no target identifiers", () => {
    expect(send.safeParse({ sessionId: S, content: "do it" }).success).toBe(true);
  });
  it("rejects malformed session IDs and priorities", () => {
    expect(send.safeParse({ sessionId: "chat-1", content: "x" }).success).toBe(false);
    expect(send.safeParse({ sessionId: S, content: "x", priority: "Z" }).success).toBe(false);
  });
  it("sessionRef must be a safe local binding ref", () => {
    const ensure = z.object(toolInputs.ensure_session);
    expect(ensure.safeParse({ sessionRef: "chat-abc" }).success).toBe(true);
    expect(ensure.safeParse({ sessionRef: "has space" }).success).toBe(false);
  });
});

describe("MCP tools", () => {
  it("ensure_session issues a random sessionRef on first use and reuses it after", async () => {
    const session = {
      id: S,
      connection_id: "tlcon_00112233445566778899aabbccddeeff",
      platform: "chatgpt",
      role: "controller",
      display_name: null,
      provider_session_ref: null,
      local_binding_ref: "x",
      status: "active",
      created_at: "t",
      last_seen_at: null,
      retired_at: null,
      revoked_at: null,
      created: true,
    };
    const { ctx, rpc } = ctxWith({ register_session: session });
    const first = await ensureSession(ctx, {});
    expect(first.sessionRef).toMatch(/^chat-[0-9a-f-]{36}$/);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_local_binding_ref: first.sessionRef });
    await ensureSession(ctx, { sessionRef: first.sessionRef });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_local_binding_ref: first.sessionRef });
  });

  it("send_to_agent returns setup_required without creating a task when nothing is linked", async () => {
    const { ctx, rpc } = ctxWith({ list_session_links: [] });
    expect(await sendToAgent(ctx, { sessionId: S, content: "hi" })).toMatchObject({
      status: "setup_required",
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["list_session_links"]);
  });

  it("send_to_agent asks to choose when several agents are linked", async () => {
    const { ctx, rpc } = ctxWith({
      list_session_links: [linkRow(link(L1, "active")), linkRow(link(L2, "active"))],
    });
    expect(await sendToAgent(ctx, { sessionId: S, content: "hi" })).toMatchObject({
      status: "choose_link",
    });
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("create_task");
  });

  it("errors are generic and never leak database details", () => {
    expect(describeError(new ClientOperationError("not_found"))).toBe(
      "Not found, or not accessible from this ThreadLink session.",
    );
    expect(describeError(new Error("relation tasks does not exist"))).toBe(
      "ThreadLink is temporarily unavailable.",
    );
  });
});
