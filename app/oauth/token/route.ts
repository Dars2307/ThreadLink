import {
  CORS_HEADERS,
  exchangeCode,
  oauthError,
  OAuthRequestError,
  OAUTH_SCOPE,
  readOAuthBody,
  tokenRequestSchema,
} from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

/**
 * Authorization-code + PKCE token endpoint. The access token is a ThreadLink
 * connection credential; it is returned once and never logged or stored raw.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readOAuthBody(request);
    if (body.grant_type !== "authorization_code") return oauthError("unsupported_grant_type");
    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) return oauthError("invalid_request");
    const accessToken = await exchangeCode(parsed.data);
    return Response.json(
      { access_token: accessToken, token_type: "Bearer", scope: OAUTH_SCOPE },
      { headers: { ...CORS_HEADERS, Pragma: "no-cache" } },
    );
  } catch (error) {
    if (error instanceof OAuthRequestError) {
      return oauthError(error.code, error.code === "temporarily_unavailable" ? 503 : 400);
    }
    console.error("[threadlink] oauth token exchange failed");
    return oauthError("server_error", 500);
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
