import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { revokePairing } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Either participant session revokes a link. Idempotent and terminal. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    revokePairing(db, credentialHash, await readJsonBody(request)),
  );
}
