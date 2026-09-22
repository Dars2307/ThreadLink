import {
  CORS_HEADERS,
  oauthError,
  OAuthRequestError,
  readOAuthBody,
  registerClient,
  registrationSchema,
} from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

/** RFC 7591 dynamic client registration (public clients only; rate-limited in the DB). */
export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = registrationSchema.safeParse(await readOAuthBody(request));
    if (!parsed.success) return oauthError("invalid_redirect_uri");
    return Response.json(await registerClient(parsed.data), { status: 201, headers: CORS_HEADERS });
  } catch (error) {
    if (error instanceof OAuthRequestError) {
      return oauthError(error.code, error.code === "temporarily_unavailable" ? 503 : 400);
    }
    console.error("[threadlink] oauth registration failed");
    return oauthError("server_error", 500);
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
