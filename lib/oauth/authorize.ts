import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import { mcpResourceUrl, newAuthorizationCode, OAUTH_SCOPE } from "./server";

/** Parameters of an authorization request (RFC 6749 + PKCE + RFC 8707). */
export const authorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().regex(/^tlcli_[0-9a-f]{32}$/),
  redirect_uri: z.string().min(1).max(512),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(1024).optional(),
  resource: z.string().max(512).optional(),
  scope: z.string().max(256).optional(),
});

export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

type ClientInfo = { clientId: string; clientName: string; redirectUris: string[] };

export type ValidatedAuthorization = {
  request: AuthorizeRequest;
  client: ClientInfo;
};

/**
 * Validates a request against the registered client. Only after this succeeds
 * may we redirect anywhere (prevents open redirects to unregistered URIs).
 */
export async function validateAuthorization(
  raw: Record<string, unknown>,
): Promise<ValidatedAuthorization | { error: string }> {
  const parsed = authorizeRequestSchema.safeParse(raw);
  if (!parsed.success) return { error: "The authorization request is invalid or incomplete." };
  const request = parsed.data;
  if (request.scope && !request.scope.split(" ").every((s) => s === OAUTH_SCOPE)) {
    return { error: "Unsupported scope requested." };
  }
  const origin = await requestOrigin();
  if (request.resource && request.resource !== mcpResourceUrl(origin)) {
    return { error: "The requested resource is not this ThreadLink server." };
  }

  await requireThreadLinkUser();
  const { data, error } = await createUserSupabaseClient().rpc("get_oauth_client", {
    p_client_id: request.client_id,
  });
  const client = z
    .object({ client_id: z.string(), client_name: z.string(), redirect_uris: z.array(z.string()) })
    .nullable()
    .safeParse(error ? null : data);
  if (
    !client.success ||
    !client.data ||
    !client.data.redirect_uris.includes(request.redirect_uri)
  ) {
    return { error: "Unknown client or unregistered redirect URI." };
  }
  return {
    request,
    client: {
      clientId: client.data.client_id,
      clientName: client.data.client_name,
      redirectUris: client.data.redirect_uris,
    },
  };
}

function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Issues a one-time code for the signed-in user and returns the client redirect URL. */
export async function approve(validated: ValidatedAuthorization): Promise<string> {
  const { code, codeHash } = newAuthorizationCode();
  const { request } = validated;
  const { error } = await createUserSupabaseClient().rpc("create_oauth_authorization", {
    p_client_id: request.client_id,
    p_redirect_uri: request.redirect_uri,
    p_code_hash: codeHash,
    p_code_challenge: request.code_challenge,
    p_resource: request.resource ?? null,
  });
  if (error) {
    return redirectWith(request.redirect_uri, {
      error: error.code === "54000" ? "temporarily_unavailable" : "server_error",
      state: request.state,
    });
  }
  return redirectWith(request.redirect_uri, {
    code,
    state: request.state,
    iss: await requestOrigin(),
  });
}

export function denyUrl(validated: ValidatedAuthorization): string {
  return redirectWith(validated.request.redirect_uri, {
    error: "access_denied",
    state: validated.request.state,
  });
}
