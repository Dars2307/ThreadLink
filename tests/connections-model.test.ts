import { describe, expect, it } from "vitest";

import {
  ALPHA_ROLE_FOR_PLATFORM,
  registerConnectionInputSchema,
  OwnershipViolationError,
  parseOwnedConnections,
} from "@/lib/connections/model";
import { idPattern, isThreadLinkId } from "@/lib/ids";

const OWNER = "tlusr_0123456789abcdef0123456789abcdef";
const OTHER = "tlusr_fedcba9876543210fedcba9876543210";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "tlcon_00112233445566778899aabbccddeeff",
    owner_user_id: OWNER,
    platform: "claude-code",
    role: "agent",
    status: "active",
    display_name: null,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("registerConnectionInputSchema", () => {
  it.each([{ platform: "chatgpt" }, { platform: "claude-code", displayName: "Laptop" }])(
    "accepts %o",
    (input) => {
      expect(registerConnectionInputSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each(["codex", "nova", "ChatGPT", "claude_code", "", null])(
    "rejects platform %o",
    (platform) => {
      expect(registerConnectionInputSchema.safeParse({ platform }).success).toBe(false);
    },
  );

  it.each(["controller", "agent", "admin"])(
    "rejects caller-chosen role %o (derived server-side)",
    (role) => {
      expect(registerConnectionInputSchema.safeParse({ platform: "chatgpt", role }).success).toBe(
        false,
      );
    },
  );

  it("derives the Alpha role from the platform", () => {
    expect(ALPHA_ROLE_FOR_PLATFORM).toEqual({ chatgpt: "controller", "claude-code": "agent" });
  });

  it.each([
    "owner_user_id",
    "ownerUserId",
    "clerkUserId",
    "clerk_user_id",
    "id",
    "status",
    "revoked_at",
    "token",
    "token_hash",
    "tokenHash",
  ])("rejects client-supplied %s (ownership/lifecycle cannot be passed in)", (key) => {
    const result = registerConnectionInputSchema.safeParse({
      platform: "chatgpt",
      role: "controller",
      [key]: key === "status" ? "active" : OTHER,
    });
    expect(result.success).toBe(false);
  });

  it("rejects over-long display names", () => {
    const result = registerConnectionInputSchema.safeParse({
      platform: "chatgpt",
      displayName: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe("parseOwnedConnections", () => {
  it("returns rows owned by the caller", () => {
    expect(parseOwnedConnections([row()], OWNER)).toHaveLength(1);
  });

  it("fails closed if any row belongs to another user", () => {
    expect(() => parseOwnedConnections([row(), row({ owner_user_id: OTHER })], OWNER)).toThrow(
      OwnershipViolationError,
    );
  });

  it.each([
    ["status", { status: "hacked" }],
    ["platform", { platform: "codex" }],
    ["role", { role: "admin" }],
    ["id", { id: "tlusr_00112233445566778899aabbccddeeff" }],
  ])("rejects rows with invalid %s", (_label, overrides) => {
    expect(() => parseOwnedConnections([row(overrides)], OWNER)).toThrow();
  });
});

describe("ThreadLink IDs", () => {
  it("validates prefix and body", () => {
    expect(isThreadLinkId("user", OWNER)).toBe(true);
    expect(isThreadLinkId("connection", OWNER)).toBe(false);
    expect(isThreadLinkId("user", "tlusr_123")).toBe(false);
    expect(isThreadLinkId("user", "user_2abc")).toBe(false);
    expect(isThreadLinkId("user", `${OWNER} `)).toBe(false);
    expect(idPattern("connection").test("tlcon_00112233445566778899AABBCCDDEEFF")).toBe(false);
  });
});
