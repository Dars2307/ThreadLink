import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { startTask } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/** Claiming worker: mark the task as working (`{ sessionId, claimRef }`). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/start">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    startTask(db, credentialHash, (await ctx.params).taskId, await readJsonBody(request)),
  );
}
