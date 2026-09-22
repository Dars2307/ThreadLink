import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { approvePairing } from "@/lib/client-api/operations";

export const dynamic = "force-dynamic";

/** Agent-only: the exact target agent session approves a pending pairing. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    approvePairing(db, credentialHash, await readJsonBody(request)),
  );
}
