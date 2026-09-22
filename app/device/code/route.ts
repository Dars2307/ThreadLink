import {
  DEVICE_ERROR_STATUS,
  DeviceFlowError,
  deviceStartSchema,
  startDeviceAuthorization,
} from "@/lib/device/server";
import { OAuthRequestError, readOAuthBody } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Bridge sign-in, step 1: returns a device code (kept by the bridge) and a user code (shown to the human). */
export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = deviceStartSchema.safeParse(await readOAuthBody(request));
    if (!parsed.success) throw new DeviceFlowError("invalid_request");
    const origin = new URL(request.url).origin;
    return Response.json(await startDeviceAuthorization(parsed.data.displayName, origin), {
      headers: NO_STORE,
    });
  } catch (error) {
    const code =
      error instanceof DeviceFlowError
        ? error.error
        : error instanceof OAuthRequestError
          ? "invalid_request"
          : "server_error";
    if (code === "server_error") console.error("[threadlink] device authorization start failed");
    return Response.json({ error: code }, { status: DEVICE_ERROR_STATUS[code], headers: NO_STORE });
  }
}
