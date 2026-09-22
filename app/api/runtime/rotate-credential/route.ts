import { handleClientRequest } from "@/lib/client-api/handler";
import { rotateOwnCredential } from "@/lib/client-api/runtime";
import { getServerEnv } from "@/lib/env/server";

export const dynamic = "force-dynamic";

/** Runtime rotates its own credential; the new one is returned exactly once. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    rotateOwnCredential(db, credentialHash, getServerEnv().THREADLINK_CONNECTION_SECRET),
  );
}
