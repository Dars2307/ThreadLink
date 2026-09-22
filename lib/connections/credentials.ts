import { createHmac, randomBytes } from "node:crypto";

/**
 * ThreadLink connection credentials.
 *
 * Format:  tlc_<43 base64url chars>   (32 bytes from the Node CSPRNG = 256 bits)
 *
 * - The token is opaque: it encodes no user, connection, email or name.
 * - The server stores only HMAC-SHA256(THREADLINK_CONNECTION_SECRET, token)
 *   as hex, plus `tokenPrefix` (first 10 chars) as a non-secret fingerprint.
 * - The raw token is returned once at issuance and never persisted or logged.
 *
 * Why a keyed hash: tokens already have 256 bits of entropy, so a plain
 * SHA-256 would resist guessing. The HMAC key ("pepper") is defence in depth:
 * a leaked database alone cannot be used to test candidate tokens, and hashes
 * are bound to this deployment. No custom cryptography: Node's HMAC-SHA256.
 */

export const CONNECTION_TOKEN_PREFIX = "tlc_";
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PREFIX_DISPLAY_LENGTH = 10; // "tlc_" + 6 chars (36 bits; 220 bits stay secret)
const HMAC_CONTEXT = "threadlink:connection-token:v1:";

export const CONNECTION_TOKEN_PATTERN = /^tlc_[A-Za-z0-9_-]{43}$/;
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type IssuedCredential = {
  /** Raw bearer token. Show once; never store, log or put in a URL. */
  readonly token: string;
  /** Non-secret display fingerprint, e.g. `tlc_Ab3xYz`. */
  readonly tokenPrefix: string;
};

export function generateConnectionToken(): IssuedCredential {
  const token = CONNECTION_TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  return { token, tokenPrefix: token.slice(0, TOKEN_PREFIX_DISPLAY_LENGTH) };
}

export function isWellFormedConnectionToken(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_TOKEN_PATTERN.test(value);
}

export function hashConnectionToken(token: string, secret: string): string {
  if (!isWellFormedConnectionToken(token)) throw new Error("Malformed connection token");
  if (typeof secret !== "string" || secret.length < 43) {
    throw new Error("Connection secret is not configured");
  }
  return createHmac("sha256", secret)
    .update(HMAC_CONTEXT + token, "utf8")
    .digest("hex");
}

/**
 * Extracts a bearer token from an Authorization header value.
 * Accepts exactly `Bearer <token>` (scheme case-insensitive, one space).
 */
export function extractBearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string" || authorization.length > 512) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match ? match[1] : null;
}
