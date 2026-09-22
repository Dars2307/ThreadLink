import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { inject } from "vitest";

/** Local-stack helpers. Tokens are signed with the LOCAL JWT secret only. */
export const env = inject("supabase");

// Test-only HMAC key; never a real secret.
export const TEST_CONNECTION_SECRET = "integration-test-connection-secret-0123456789abcdef";

export function uniqueClerkId(label: string): string {
  return `user_itest${label}${randomBytes(6).toString("hex")}`;
}

export async function clerkLikeToken(sub: string): Promise<string> {
  return new SignJWT({ sub, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(env.jwtSecret));
}

export async function userClient(sub: string): Promise<SupabaseClient> {
  const token = await clerkLikeToken(sub);
  return createClient(env.url, env.publishableKey, { accessToken: async () => token });
}

/** No identity at all: how a connection-token client reaches the database. */
export function anonymousClient(): SupabaseClient {
  return createClient(env.url, env.publishableKey, { auth: { persistSession: false } });
}

/** Local-only privileged client for fixture cleanup and verification. */
export const admin = createClient(env.url, env.secretKey, { auth: { persistSession: false } });

export function identity(sub: string) {
  return { clerkUserId: sub, sessionId: "sess_integration" };
}
