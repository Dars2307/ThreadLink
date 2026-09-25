import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import {
  getProviderProfiles,
  reportProviderDetection,
  setRuntimeProviderPlan,
} from "@/lib/team/client-api";

export const dynamic = "force-dynamic";

/**
 * Runtime only (agent credential of a registered Runtime).
 *
 * GET: the owner's provider profiles (declared plan, usage policy, paid usage).
 * POST {provider, detected}: report what discovery found. Detection never
 * changes plan, policy or paid usage, and a detection carrying an email, org id
 * or token-shaped key is refused.
 * PATCH {provider, declaredPlan}: the owner, in the desktop app, sets the
 * DECLARED plan. Only the plan: usage policy and paid usage stay dashboard-only.
 */
export async function GET(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => ({
    profiles: await getProviderProfiles(db, credentialHash),
  }));
}

export async function POST(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const body = await readJsonBody(request, 32 * 1024);
    return reportProviderDetection(db, credentialHash, body);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return handleClientRequest(request, async ({ db, credentialHash }) => {
    const body = await readJsonBody(request, 1024);
    return setRuntimeProviderPlan(db, credentialHash, body);
  });
}
