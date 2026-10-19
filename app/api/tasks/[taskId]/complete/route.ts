import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { completeTask } from "@/lib/client-api/tasks";
import { TASK_LIMITS } from "@/lib/tasks/model";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Claiming worker: complete with a result and artifact references; routed to the origin. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/complete">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    completeTask(
      db,
      credentialHash,
      (await ctx.params).taskId,
      await readJsonBody(request, TASK_LIMITS.completeBodyBytes),
    ),
  );
}
