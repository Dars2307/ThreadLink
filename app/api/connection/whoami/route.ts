import {
  connectionUnauthorizedResponse,
  ConnectionAuthenticationError,
  requireConnection,
} from "@/lib/connections/require-connection";

export const dynamic = "force-dynamic";

/**
 * Minimal connection-authenticated endpoint used to prove a client credential
 * works. Returns the connection's own identity only (no owner/user IDs).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const connection = await requireConnection(request);
    return Response.json(
      {
        connectionId: connection.connectionId,
        platform: connection.platform,
        role: connection.role,
        status: connection.status,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (!(error instanceof ConnectionAuthenticationError)) {
      console.error("[threadlink] connection whoami failed");
    }
    return connectionUnauthorizedResponse();
  }
}
