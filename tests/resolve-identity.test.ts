import { describe, expect, it } from "vitest";

import { resolveIdentity } from "@/lib/auth/resolve-identity";

const valid = { isAuthenticated: true, userId: "user_2abcDEF123", sessionId: "sess_2xyz789" };

describe("resolveIdentity", () => {
  it("returns the Clerk user ID for a fully authenticated session", () => {
    expect(resolveIdentity(valid)).toEqual({
      clerkUserId: "user_2abcDEF123",
      sessionId: "sess_2xyz789",
    });
  });

  it("returns a frozen object so callers cannot swap the identity", () => {
    const identity = resolveIdentity(valid)!;
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it.each([
    ["missing state", null],
    ["undefined state", undefined],
    ["unauthenticated", { ...valid, isAuthenticated: false }],
    ["null userId", { ...valid, userId: null }],
    ["null sessionId", { ...valid, sessionId: null }],
    ["empty userId", { ...valid, userId: "" }],
    ["malformed userId", { ...valid, userId: "joel@example.com" }],
    ["userId with injection", { ...valid, userId: "user_abc' OR 1=1" }],
    ["non-user principal", { ...valid, userId: "org_2abc" }],
    ["malformed sessionId", { ...valid, sessionId: "not-a-session" }],
  ])("fails closed for %s", (_label, state) => {
    expect(resolveIdentity(state as never)).toBeNull();
  });

  it("does not treat truthy non-boolean isAuthenticated as authenticated", () => {
    expect(resolveIdentity({ ...valid, isAuthenticated: "true" as never })).toBeNull();
  });
});
