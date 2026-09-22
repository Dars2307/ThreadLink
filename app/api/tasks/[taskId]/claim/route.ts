import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { claimTask } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/** Exact target agent: atomically claim a queued task (`{ sessionId, claimRef }`). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/claim">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    claimTask(db, credentialHash, (await ctx.params).taskId, await readJsonBody(request)),
  );
}
