import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { retireSession } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Retire one of the authenticated connection's sessions. Terminal; revokes its links. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    retireSession(db, credentialHash, await readJsonBody(request)),
  );
}
