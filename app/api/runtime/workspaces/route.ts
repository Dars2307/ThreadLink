import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { upsertWorkspace } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";

/** Runtime reports a workspace (runtime-local identity). */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    upsertWorkspace(db, credentialHash, await readJsonBody(request)),
  );
}
