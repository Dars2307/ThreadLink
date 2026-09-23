import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { reportTaskBlocked } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";

/**
 * Agent only: "I am alive but cannot proceed" — the Claude session is in Plan
 * Mode, or the task needs approval or input. The task keeps its claim and
 * lease; it simply stops claiming to be working.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/blocked">,
): Promise<Response> {
  const body = (await readJsonBody(request)) as Record<string, unknown>;
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    reportTaskBlocked(db, credentialHash, { ...body, taskId: (await ctx.params).taskId }),
  );
}
