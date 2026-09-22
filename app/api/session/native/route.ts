import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { setNativeSession } from "@/lib/client-api/native";

export const dynamic = "force-dynamic";

/** Agent: record which native Claude Code session this tlses_ resumes (metadata only). */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    setNativeSession(db, credentialHash, await readJsonBody(request)),
  );
}
