import { authorizationServerMetadata, CORS_HEADERS } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization-server metadata. */
export function GET(request: Request): Response {
  return Response.json(authorizationServerMetadata(new URL(request.url).origin), {
    headers: CORS_HEADERS,
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
