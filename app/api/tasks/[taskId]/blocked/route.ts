import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { reportTaskBlocked } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Agent only: "I am alive but cannot proceed" — the Claude session is in Plan
 * Mode, or the task needs approval or input. The task keeps its claim and
 * lease; it simply stops claiming to be working.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/blocked">,
): Promise<Response> {
  // Inside the handler: see the note in the acknowledge route. A body parsed
  // before authentication is both a 500 and a distinguishable error class.
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    return reportTaskBlocked(db, credentialHash, { ...body, taskId: (await ctx.params).taskId });
  });
}
