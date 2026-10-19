import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { runtimeHeartbeat } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Runtime heartbeat: capabilities and busy conversations in; pause/restart/settings out. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    runtimeHeartbeat(db, credentialHash, await readJsonBody(request)),
  );
}
