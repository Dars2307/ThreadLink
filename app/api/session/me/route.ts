import { handleClientRequest } from "@/lib/client-api/handler";
import { getSession } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Safe metadata for one of the authenticated connection's sessions (`?sessionId=tlses_...`). */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, ({ db, credentialHash }) =>
    getSession(db, credentialHash, new URL(request.url).searchParams.get("sessionId")),
  );
}
