import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { requestPairing } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Controller-only: request a pairing with an agent session. Always starts pending. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    requestPairing(db, credentialHash, await readJsonBody(request)),
  );
}
