import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";

import { z } from "zod";

import { generateConnectionToken, hashConnectionToken } from "@/lib/connections/credentials";
import { getServerEnv } from "@/lib/env/server";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

/**
 * Device authorization for the Claude Code bridge (RFC 8628 shape).
 *
 * 1. The bridge asks for a device code (random, 32 bytes; only its sha256 is
 *    stored) and a short user code (8 consonants, ~34 bits, 10-minute lifetime).
 * 2. The human opens /connect, signs in with Clerk and approves the code that is
 *    shown in their terminal.
 * 3. The bridge polls /device/token; on approval ThreadLink mints a fresh
 *    claude-code/agent connection credential and returns it exactly once.
 *
 * No Clerk session, API key or credential is ever copied by hand.
 */

export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_POLL_INTERVAL_SECONDS = 3;
export const DEVICE_CODE_LIFETIME_SECONDS = 600;

export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** Accepts "bcdf-ghjk", "BCDF GHJK", ... Returns the canonical 8 letters or null. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(code) ? code : null;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export class DeviceFlowError extends Error {
  constructor(
    readonly error:
      | "invalid_request"
      | "authorization_pending"
      | "access_denied"
      | "expired_token"
      | "invalid_grant"
      | "slow_down"
      | "server_error",
  ) {
    super(error);
    this.name = "DeviceFlowError";
  }
}

export const deviceStartSchema = z
  .object({ displayName: z.string().trim().min(1).max(100).optional() })
  .strict();

export async function startDeviceAuthorization(displayName: string | undefined, origin: string) {
  const deviceCode = randomBytes(32).toString("base64url");
  const db = createAnonymousSupabaseClient();
  for (let attempt = 0; attempt < 3; attempt++) {
    const userCode = newUserCode();
    const { error } = await db.rpc("start_device_authorization", {
      p_device_code_hash: sha256Hex(deviceCode),
      p_user_code: userCode,
      p_display_name: displayName ?? "Claude Code bridge",
    });
    if (!error) {
      const formatted = formatUserCode(userCode);
      return {
        device_code: deviceCode,
        user_code: formatted,
        verification_uri: `${origin}/connect`,
        verification_uri_complete: `${origin}/connect?code=${formatted}`,
        expires_in: DEVICE_CODE_LIFETIME_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      };
    }
    if (error.code === "54000") throw new DeviceFlowError("slow_down");
    if (error.code !== "23505") throw new DeviceFlowError("server_error"); // 23505: user-code collision, retry
  }
  throw new DeviceFlowError("server_error");
}

export const deviceTokenSchema = z
  .object({ device_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

const DEVICE_ERRORS: Record<string, DeviceFlowError["error"]> = {
  TLD01: "authorization_pending",
  TLD02: "access_denied",
  TLD03: "expired_token",
  "22023": "invalid_grant",
  "54000": "slow_down",
};

/** Redeems an approved device code for a new agent credential (returned once). */
export async function redeemDeviceCode(deviceCode: string) {
  const credential = generateConnectionToken();
  const { data, error } = await createAnonymousSupabaseClient().rpc("redeem_device_authorization", {
    p_device_code_hash: sha256Hex(deviceCode),
    p_token_hash: hashConnectionToken(
      credential.token,
      getServerEnv().THREADLINK_CONNECTION_SECRET,
    ),
    p_token_prefix: credential.tokenPrefix,
  });
  if (error) throw new DeviceFlowError(DEVICE_ERRORS[error.code ?? ""] ?? "server_error");
  const parsed = z
    .object({ connection_id: z.string(), account_hint: z.string().nullable() })
    .safeParse(data);
  if (!parsed.success) throw new DeviceFlowError("server_error");
  return {
    access_token: credential.token,
    token_type: "Bearer" as const,
    connection_id: parsed.data.connection_id,
    account_hint: parsed.data.account_hint,
  };
}

export const DEVICE_ERROR_STATUS: Record<DeviceFlowError["error"], number> = {
  invalid_request: 400,
  authorization_pending: 400,
  access_denied: 400,
  expired_token: 400,
  invalid_grant: 400,
  slow_down: 429,
  server_error: 500,
};
