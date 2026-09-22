import { CORS_HEADERS, protectedResourceMetadata } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

/** RFC 9728 protected-resource metadata (also served at the /mcp path suffix). */
export function GET(request: Request): Response {
  return Response.json(protectedResourceMetadata(new URL(request.url).origin), {
    headers: CORS_HEADERS,
  });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
