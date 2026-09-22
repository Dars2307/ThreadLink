import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { registerSession } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Register (or idempotently reconnect) a session binding for the authenticated connection. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    registerSession(db, credentialHash, await readJsonBody(request)),
  );
}
