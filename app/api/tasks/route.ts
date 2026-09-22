import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { createTask, listOriginTasks } from "@/lib/client-api/tasks";
import { TASK_LIMITS } from "@/lib/tasks/model";

export const dynamic = "force-dynamic";

/** Controller: create a task over one active link. The link decides the target. */
export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    createTask(db, credentialHash, await readJsonBody(request, TASK_LIMITS.createBodyBytes)),
  );
}

/** Controller: its own session's recent tasks (`?sessionId=tlses_...&limit=`), metadata only. */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const params = new URL(request.url).searchParams;
    return {
      tasks: await listOriginTasks(
        db,
        credentialHash,
        params.get("sessionId"),
        params.get("limit"),
      ),
    };
  });
}
