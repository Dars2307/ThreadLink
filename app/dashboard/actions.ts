"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { registerMyConnection, revokeMyConnection } from "@/lib/connections/repository";
import { ConnectionLimitError } from "@/lib/connections/registration";
import { MAX_ACTIVE_CONNECTIONS } from "@/lib/connections/model";
import { requestMyPairing, revokeMyThreadLink } from "@/lib/sessions/repository";

export type RegisterConnectionState =
  | { status: "idle" }
  | {
      status: "issued";
      /** Raw credential: rendered once in memory, never stored or logged. */
      token: string;
      tokenPrefix: string;
      platform: string;
      displayName: string | null;
    }
  | { status: "error"; message: string };

function optionalString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function registerConnectionAction(
  _previous: RegisterConnectionState,
  formData: FormData,
): Promise<RegisterConnectionState> {
  try {
    // Only these two fields are read; anything else in the form is ignored.
    const { connection, credential } = await registerMyConnection({
      platform: formData.get("platform"),
      displayName: optionalString(formData.get("displayName")),
    });
    revalidatePath("/dashboard");
    return {
      status: "issued",
      token: credential.token,
      tokenPrefix: credential.tokenPrefix,
      platform: connection.platform,
      displayName: connection.displayName,
    };
  } catch (error) {
    if (error instanceof ConnectionLimitError) {
      return {
        status: "error",
        message: `You already have ${MAX_ACTIVE_CONNECTIONS} active connections. Revoke one first.`,
      };
    }
    if (error instanceof ZodError) {
      return {
        status: "error",
        message: "Choose a platform and a name of at most 100 characters.",
      };
    }
    return { status: "error", message: "Could not create the connection. Try again." };
  }
}

export async function revokeConnectionAction(formData: FormData): Promise<void> {
  try {
    await revokeMyConnection(formData.get("connectionId"));
  } catch {
    // Generic by design; the list re-renders with the true state either way.
  }
  revalidatePath("/dashboard");
}

export async function revokeThreadLinkAction(formData: FormData): Promise<void> {
  try {
    await revokeMyThreadLink(formData.get("linkId"));
  } catch {
    // Generic by design; the list re-renders with the true state either way.
  }
  revalidatePath("/dashboard");
}

/** Owner-initiated pairing. Never active until the agent session approves it. */
export async function requestPairingAction(formData: FormData): Promise<void> {
  try {
    await requestMyPairing(formData.get("controllerSessionId"), formData.get("agentSessionId"));
  } catch {
    // Generic; the dashboard re-renders with the true state.
  }
  revalidatePath("/dashboard");
}
