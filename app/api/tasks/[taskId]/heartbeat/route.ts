import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { renewTaskLease } from "@/lib/client-api/tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Claiming worker: renew the claim lease (`{ sessionId, claimRef }`). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/heartbeat">,
): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    renewTaskLease(db, credentialHash, (await ctx.params).taskId, await readJsonBody(request)),
  );
}
