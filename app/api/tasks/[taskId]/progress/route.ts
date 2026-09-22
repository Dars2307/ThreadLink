import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { reportProgress } from "@/lib/client-api/tasks";
import { TASK_LIMITS } from "@/lib/tasks/model";

export const dynamic = "force-dynamic";

/** Claiming worker: progress message routed back to the origin (`{ sessionId, claimRef, content }`). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/progress">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    reportProgress(
      db,
      credentialHash,
      (await ctx.params).taskId,
      await readJsonBody(request, TASK_LIMITS.smallBodyBytes),
    ),
  );
}
