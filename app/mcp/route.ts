import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { requireConnectionContext } from "@/lib/connections/require-connection";
import { buildThreadLinkMcpServer } from "@/lib/mcp/server";
import { CORS_HEADERS } from "@/lib/oauth/server";
import { createAnonymousSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_MCP_BODY_BYTES = 128 * 1024;

function unauthorized(origin: string): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="threadlink"`,
      },
    },
  );
}

/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses).
 * Bearer = the ThreadLink connection credential issued by /oauth/token.
 * Only controller connections may use it; every tool re-verifies in the DB.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (Number(request.headers.get("content-length") ?? "0") > MAX_MCP_BODY_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413, headers: CORS_HEADERS });
  }

  let ctx;
  try {
    ctx = await requireConnectionContext(request);
  } catch {
    return unauthorized(origin);
  }
  if (ctx.identity.role !== "controller") {
    return Response.json({ error: "forbidden" }, { status: 403, headers: CORS_HEADERS });
  }

  const server = buildThreadLinkMcpServer({ ...ctx, db: createAnonymousSupabaseClient() });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

// Stateless server: no server-initiated streams or sessions to open or delete.
export function GET(request: Request): Response {
  return request.headers.get("authorization")
    ? new Response(null, { status: 405, headers: { Allow: "POST" } })
    : unauthorized(new URL(request.url).origin);
}

export function DELETE(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
