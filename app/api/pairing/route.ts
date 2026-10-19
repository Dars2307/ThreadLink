import { handleClientRequest } from "@/lib/client-api/handler";
import { listSessionLinks } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Links involving one of the caller's sessions (`?sessionId=tlses_...`):
 * pending requests to approve, the active pairing, and history.
 */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => ({
    links: await listSessionLinks(
      db,
      credentialHash,
      new URL(request.url).searchParams.get("sessionId"),
    ),
  }));
}
