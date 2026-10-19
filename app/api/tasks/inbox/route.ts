import { handleClientRequest } from "@/lib/client-api/handler";
import { listInbox } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Agent: deliverable tasks for one of its sessions (`?sessionId=tlses_...&limit=`). Polling. */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const params = new URL(request.url).searchParams;
    return {
      tasks: await listInbox(db, credentialHash, params.get("sessionId"), params.get("limit")),
    };
  });
}
