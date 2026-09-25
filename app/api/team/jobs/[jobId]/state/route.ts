import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { writeTeamState } from "@/lib/team/client-api";
import { TEAM_SIZE_LIMITS } from "@/lib/team/model";

export const dynamic = "force-dynamic";

/**
 * Runtime only: one write to a team job's structured state.
 *
 * Body: {sessionId, claimRef, op, payload}. The database accepts it only from
 * the agent session that holds the carrier task's claim, with that claim_ref;
 * anyone else gets the same generic error whether or not the job exists.
 * Returns the concise job status (plus any id the write created).
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/team/jobs/[jobId]/state">,
): Promise<Response> {
  // The body is read INSIDE the handler, after authentication: parsed before
  // it, a malformed or oversized body would give an unauthenticated caller a
  // 500 instead of the same 401 as every other route.
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const body = await readJsonBody(request, TEAM_SIZE_LIMITS.writeBodyBytes);
    return writeTeamState(db, credentialHash, (await ctx.params).jobId, body);
  });
}
