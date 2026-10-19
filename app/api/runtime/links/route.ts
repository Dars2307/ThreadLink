import { handleClientRequest } from "@/lib/client-api/handler";
import { listRuntimeLinks } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Link requests for the calling Runtime's own sessions. Scoped to the Runtime,
 * so a request survives its conversation being detached on that computer.
 */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => ({
    links: await listRuntimeLinks(db, credentialHash),
  }));
}
