import { handleClientRequest } from "@/lib/client-api/handler";
import { getTask } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/** Participant: task status (`?sessionId=tlses_...`). */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    getTask(
      db,
      credentialHash,
      (await ctx.params).taskId,
      new URL(request.url).searchParams.get("sessionId"),
    ),
  );
}
