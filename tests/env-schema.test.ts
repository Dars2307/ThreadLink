import { describe, expect, it } from "vitest";

import { describeEnvIssues, publicEnvSchema, serverEnvSchema } from "@/lib/env/schema";
import {
  findSecretLookingPublicVarNames,
  looksLikeServerOnlyKey,
} from "@/lib/security/public-env-guard";

// Obviously fake placeholder values; no real keys.
const base = {
  NODE_ENV: "test",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
  CLERK_SECRET_KEY: "sk_test_placeholder",
  SUPABASE_SECRET_KEY: "sb_secret_placeholder",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/postgres",
  THREADLINK_CONNECTION_SECRET: "test-only-connection-secret-0123456789abcdefghij",
};

function fakeJwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

describe("serverEnvSchema", () => {
  it("accepts a complete, well-formed environment", () => {
    expect(serverEnvSchema.safeParse(base).success).toBe(true);
  });

  it.each(Object.keys(base).filter((key) => key !== "NODE_ENV"))(
    "fails when %s is missing",
    (key) => {
      const env: Record<string, string> = { ...base };
      delete env[key];
      expect(serverEnvSchema.safeParse(env).success).toBe(false);
    },
  );

  it("rejects a Clerk secret key in the publishable key slot", () => {
    const result = serverEnvSchema.safeParse({
      ...base,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_live_placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a Supabase secret key in the public Supabase key slot", () => {
    const result = serverEnvSchema.safeParse({
      ...base,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_placeholder",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a legacy service_role JWT in the public Supabase key slot", () => {
    const result = publicEnvSchema.safeParse({
      ...base,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: "service_role" }),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a legacy anon JWT in the public Supabase key slot", () => {
    const result = publicEnvSchema.safeParse({
      ...base,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: "anon" }),
    });
    expect(result.success).toBe(true);
  });

  it("requires a long THREADLINK_CONNECTION_SECRET", () => {
    expect(
      serverEnvSchema.safeParse({ ...base, THREADLINK_CONNECTION_SECRET: "short" }).success,
    ).toBe(false);
  });

  it("rejects reusing a Clerk or Supabase secret as the connection secret", () => {
    const reused = "sk_test_placeholder_that_is_long_enough_for_the_length_rule_xx";
    expect(
      serverEnvSchema.safeParse({
        ...base,
        CLERK_SECRET_KEY: reused,
        THREADLINK_CONNECTION_SECRET: reused,
      }).success,
    ).toBe(false);
  });

  it("forbids THREADLINK_ALLOW_INSECURE_DEV in production", () => {
    const result = serverEnvSchema.safeParse({
      ...base,
      NODE_ENV: "production",
      THREADLINK_ALLOW_INSECURE_DEV: "true",
    });
    expect(result.success).toBe(false);
  });

  it("never includes input values in error messages", () => {
    const secret = "sk_live_THIS_MUST_NOT_APPEAR";
    const result = serverEnvSchema.safeParse({
      ...base,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret,
      DATABASE_URL: "mysql://also-secret",
    });
    expect(result.success).toBe(false);
    const message = describeEnvIssues(result.error!);
    expect(message).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("also-secret");
  });
});

describe("public env guard", () => {
  it("flags NEXT_PUBLIC_ names that look like secrets", () => {
    expect(
      findSecretLookingPublicVarNames({
        NEXT_PUBLIC_SUPABASE_URL: "x",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "x",
        NEXT_PUBLIC_SUPABASE_SECRET_KEY: "x",
        NEXT_PUBLIC_API_TOKEN: "x",
        CLERK_SECRET_KEY: "x",
      }),
    ).toEqual(["NEXT_PUBLIC_API_TOKEN", "NEXT_PUBLIC_SUPABASE_SECRET_KEY"]);
  });

  it("recognises server-only key prefixes", () => {
    expect(looksLikeServerOnlyKey("sk_test_x")).toBe(true);
    expect(looksLikeServerOnlyKey("sb_secret_x")).toBe(true);
    expect(looksLikeServerOnlyKey("pk_test_x")).toBe(false);
    expect(looksLikeServerOnlyKey("sb_publishable_x")).toBe(false);
  });
});
