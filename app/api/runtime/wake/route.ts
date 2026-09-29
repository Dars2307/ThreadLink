import { handleClientRequest } from "@/lib/client-api/handler";
import { waitForWork } from "@/lib/client-api/runtime";

export const dynamic = "force-dynamic";
// The request is held up to 25 s (wait <= 25) plus one database round trip.
export const maxDuration = 30;

/**
 * 0.11 wake long-poll (docs/design/threadlink-0.11.md section 3.2). Runtime
 * credential only.
 *
 * GET ?wait=<0..25 s, default 20> -> {pending: number, paused?: true}
 *
 * Answers as soon as a task for one of this Runtime's sessions can be claimed
 * (checked about every 750 ms), or {pending: 0} when the wait runs out or the
 * client goes away. 429 {error:"limit", reason:"rate_limited"} past 120 wake
 * requests per minute per owner. The Runtime keeps one wake request in flight
 * while idle and falls back to its idle backoff when this fails.
 */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) =>
    waitForWork(db, credentialHash, new URL(request.url).searchParams.get("wait"), request.signal),
  );
}
