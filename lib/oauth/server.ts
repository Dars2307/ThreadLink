import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { generateConnectionToken, hashConnectionToken } from "@/lib/connections/credentials";
import { getServerEnv } from "@/lib/env/server";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

/**
 * ThreadLink as an OAuth 2.1 authorization server for its own MCP resource.
 *
 * - Discovery: RFC 9728 protected-resource metadata + RFC 8414 AS metadata.
 * - Registration: RFC 7591 dynamic registration of public clients (no secret).
 * - Authorization: /oauth/authorize (Clerk session required) issues a one-time,
 *   5-minute code bound to the client's PKCE S256 challenge.
 * - Token: /oauth/token redeems code + verifier (PKCE checked in the database)
 *   for a ThreadLink connection credential (chatgpt/controller connection).
 *
 * No Clerk secret or Clerk token is ever given to the MCP client.
 */

export const OAUTH_SCOPE = "threadlink";
export const MCP_PATH = "/mcp";

export function mcpResourceUrl(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "ThreadLink",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
  "Cache-Control": "no-store",
};

export function oauthError(error: string, status = 400, description?: string): Response {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status, headers: CORS_HEADERS },
  );
}

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function newAuthorizationCode(): { code: string; codeHash: string } {
  const code = randomBytes(32).toString("base64url");
  return { code, codeHash: sha256Hex(code) };
}

// ---------------------------------------------------------------------------
// Registration (RFC 7591). Only name + redirect URIs are stored.
// ---------------------------------------------------------------------------
const redirectUriSchema = z
  .string()
  .max(512)
  .refine((uri) => {
    try {
      const u = new URL(uri);
      if (u.hash) return false;
      if (u.protocol === "https:") return true;
      return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
    } catch {
      return false;
    }
  }, "redirect_uri must be https (or http on localhost)");

export const registrationSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1).max(5),
  client_name: z.string().max(100).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

export async function registerClient(input: z.infer<typeof registrationSchema>) {
  if (input.grant_types && !input.grant_types.includes("authorization_code")) {
    throw new OAuthRequestError("invalid_client_metadata");
  }
  if (input.response_types && !input.response_types.every((t) => t === "code")) {
    throw new OAuthRequestError("invalid_client_metadata");
  }
  const { data, error } = await createAnonymousSupabaseClient().rpc("register_oauth_client", {
    p_client_name: input.client_name ?? "MCP client",
    p_redirect_uris: input.redirect_uris,
  });
  if (error) {
    throw new OAuthRequestError(
      error.code === "54000" ? "temporarily_unavailable" : "invalid_client_metadata",
    );
  }
  const { client_id } = z.object({ client_id: z.string() }).parse(data);
  return {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: input.client_name ?? "MCP client",
    redirect_uris: input.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export class OAuthRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthRequestError";
  }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------
export const tokenRequestSchema = z.object({
  grant_type: z.string(),
  code: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(512),
  client_id: z.string().regex(/^tlcli_[0-9a-f]{32}$/),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  resource: z.string().max(512).optional(),
});

/** Redeems a code; returns the access token (a ThreadLink connection credential). */
export async function exchangeCode(input: z.infer<typeof tokenRequestSchema>): Promise<string> {
  if (input.grant_type !== "authorization_code")
    throw new OAuthRequestError("unsupported_grant_type");
  const secret = getServerEnv().THREADLINK_CONNECTION_SECRET;
  const credential = generateConnectionToken();
  const { error } = await createAnonymousSupabaseClient().rpc("exchange_oauth_code", {
    p_code_hash: sha256Hex(input.code),
    p_code_verifier: input.code_verifier,
    p_client_id: input.client_id,
    p_redirect_uri: input.redirect_uri,
    p_resource: input.resource ?? null,
    p_token_hash: hashConnectionToken(credential.token, secret),
    p_token_prefix: credential.tokenPrefix,
  });
  if (error) {
    throw new OAuthRequestError(
      error.code === "54000" ? "temporarily_unavailable" : "invalid_grant",
    );
  }
  return credential.token;
}

/** Reads an OAuth request body (form-encoded per spec; JSON tolerated). Bounded. */
export async function readOAuthBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 16 * 1024) throw new OAuthRequestError("invalid_request");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new OAuthRequestError("invalid_request");
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new OAuthRequestError("invalid_request");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
