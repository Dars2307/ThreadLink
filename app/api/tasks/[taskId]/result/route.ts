import { handleClientRequest } from "@/lib/client-api/handler";
import { getTaskResult } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/** Originating controller only: status, result, errors, progress, artifacts (`?sessionId=`). */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/result">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    getTaskResult(
      db,
      credentialHash,
      (await ctx.params).taskId,
      new URL(request.url).searchParams.get("sessionId"),
    ),
  );
}
