import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { registerConversation } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Runtime registers one provider conversation as a ThreadLink session (tlses_). */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    registerConversation(db, credentialHash, await readJsonBody(request)),
  );
}
