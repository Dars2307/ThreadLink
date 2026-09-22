import {
  DEVICE_ERROR_STATUS,
  DeviceFlowError,
  deviceTokenSchema,
  redeemDeviceCode,
} from "@/lib/device/server";
import { OAuthRequestError, readOAuthBody } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * Bridge sign-in, step 2 (polled): once the human approves the user code, the
 * device code is redeemed exactly once for a new Claude Code agent credential.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = deviceTokenSchema.safeParse(await readOAuthBody(request));
    if (!parsed.success) throw new DeviceFlowError("invalid_request");
    return Response.json(await redeemDeviceCode(parsed.data.device_code), { headers: NO_STORE });
  } catch (error) {
    const code =
      error instanceof DeviceFlowError
        ? error.error
        : error instanceof OAuthRequestError
          ? "invalid_request"
          : "server_error";
    if (code === "server_error") console.error("[threadlink] device token redemption failed");
    return Response.json({ error: code }, { status: DEVICE_ERROR_STATUS[code], headers: NO_STORE });
  }
}
