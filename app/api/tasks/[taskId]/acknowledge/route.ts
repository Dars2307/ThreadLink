import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { acknowledgeTaskResult } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/**
 * Originating controller only: confirms it has READ the result, which cancels
 * any pending fallback notification. Idempotent, and never forwarded to the
 * agent.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/acknowledge">,
): Promise<Response> {
  const body = (await readJsonBody(request)) as { sessionId?: unknown };
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    acknowledgeTaskResult(db, credentialHash, (await ctx.params).taskId, body?.sessionId),
  );
}
