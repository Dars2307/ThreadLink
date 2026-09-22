import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { registerRuntime } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";

/** Runtime registers (or re-registers) itself; identity comes from its credential. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    registerRuntime(db, credentialHash, await readJsonBody(request)),
  );
}
