import { describe, expect, it } from "vitest";

import {
  CONNECTION_TOKEN_PATTERN,
  extractBearerToken,
  generateConnectionToken,
  hashConnectionToken,
  isWellFormedConnectionToken,
  TOKEN_HASH_PATTERN,
} from "@/lib/connections/credentials";

// Test-only key material; never a real secret.
const SECRET = "test-only-connection-secret-0123456789abcdefghij";
const OTHER_SECRET = "another-test-only-secret-zyxwvutsrqponmlkjihgfedcb";

describe("generateConnectionToken", () => {
  it("produces tlc_ + 43 base64url chars (32 random bytes)", () => {
    const { token } = generateConnectionToken();
    expect(token).toMatch(CONNECTION_TOKEN_PATTERN);
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
  });

  it("never repeats across many issuances", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateConnectionToken().token));
    expect(tokens.size).toBe(2000);
  });

  it("encodes no identity: the body is only random bytes", () => {
    const { token } = generateConnectionToken();
    expect(token).not.toMatch(/user_|tlusr_|tlcon_|@/);
  });

  it("exposes a short non-secret prefix that is not enough to reconstruct the token", () => {
    const { token, tokenPrefix } = generateConnectionToken();
    expect(tokenPrefix).toMatch(/^tlc_[A-Za-z0-9_-]{6}$/);
    expect(token.startsWith(tokenPrefix)).toBe(true);
    // 37 of 43 random characters (>= 220 bits) remain secret.
    expect(token.length - tokenPrefix.length).toBeGreaterThanOrEqual(37);
  });
});

describe("hashConnectionToken", () => {
  it("returns a 64-hex HMAC-SHA256 digest that does not contain the token", () => {
    const { token } = generateConnectionToken();
    const hash = hashConnectionToken(token, SECRET);
    expect(hash).toMatch(TOKEN_HASH_PATTERN);
    expect(hash).not.toContain(token.slice(4, 14));
  });

  it("is deterministic for the same token and secret (enables lookup)", () => {
    const { token } = generateConnectionToken();
    expect(hashConnectionToken(token, SECRET)).toBe(hashConnectionToken(token, SECRET));
  });

  it("depends on the server secret (a leaked DB cannot verify guesses)", () => {
    const { token } = generateConnectionToken();
    expect(hashConnectionToken(token, SECRET)).not.toBe(hashConnectionToken(token, OTHER_SECRET));
  });

  it("differs for different tokens", () => {
    const a = generateConnectionToken().token;
    const b = generateConnectionToken().token;
    expect(hashConnectionToken(a, SECRET)).not.toBe(hashConnectionToken(b, SECRET));
  });

  it("refuses malformed tokens and missing/short secrets", () => {
    const { token } = generateConnectionToken();
    expect(() => hashConnectionToken("tlc_short", SECRET)).toThrow();
    expect(() => hashConnectionToken(token, "")).toThrow();
    expect(() => hashConnectionToken(token, "too-short")).toThrow();
  });
});

describe("token parsing", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["wrong prefix", "tlx_" + "a".repeat(43)],
    ["too short", "tlc_" + "a".repeat(42)],
    ["too long", "tlc_" + "a".repeat(44)],
    ["bad alphabet", "tlc_" + "a".repeat(42) + "+"],
    ["whitespace", " tlc_" + "a".repeat(43)],
  ])("rejects %s tokens", (_label, value) => {
    expect(isWellFormedConnectionToken(value)).toBe(false);
  });

  it("extracts exactly one bearer token", () => {
    const token = generateConnectionToken().token;
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
    expect(extractBearerToken(`bearer ${token}`)).toBe(token);
    expect(extractBearerToken(token)).toBeNull();
    expect(extractBearerToken(`Basic ${token}`)).toBeNull();
    expect(extractBearerToken(`Bearer  ${token}`)).toBeNull();
    expect(extractBearerToken(`Bearer ${token} extra`)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(`Bearer ${"a".repeat(600)}`)).toBeNull();
  });
});
