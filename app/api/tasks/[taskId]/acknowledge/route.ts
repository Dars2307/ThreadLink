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
  // Read the body INSIDE the handler: outside it, a malformed or oversized
  // body throws where nothing catches it, so an unauthenticated caller gets a
  // 500 instead of the same 401 every other task route gives them.
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const body = (await readJsonBody(request)) as { sessionId?: unknown };
    return acknowledgeTaskResult(db, credentialHash, (await ctx.params).taskId, body?.sessionId);
  });
}
