import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { failTask } from "@/lib/client-api/tasks";
import { TASK_LIMITS } from "@/lib/tasks/model";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Claiming worker: fail with an error message; routed to the origin. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/fail">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    failTask(
      db,
      credentialHash,
      (await ctx.params).taskId,
      await readJsonBody(request, TASK_LIMITS.smallBodyBytes),
    ),
  );
}
