"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { failed, saved, type ActionResult } from "@/lib/dashboard/action-result";

import { registerMyConnection, revokeMyConnection } from "@/lib/connections/repository";
import { ConnectionLimitError } from "@/lib/connections/registration";
import { MAX_ACTIVE_CONNECTIONS } from "@/lib/connections/model";
import { revokeMyRuntime, updateMyRuntime, setMyLinkPaused } from "@/lib/runtimes/repository";
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

/**
 * Runs an owner operation and says what happened. Never returns database text;
 * the page re-renders with the true state either way.
 */
async function attempt(
  run: () => Promise<unknown>,
  ok: string,
  fail: string,
  path: "page" | "layout" = "layout",
): Promise<ActionResult> {
  try {
    await run();
    return saved(ok);
  } catch (error) {
    console.error("owner action failed", error instanceof Error ? error.name : "unknown");
    return failed(fail);
  } finally {
    if (path === "layout") revalidatePath("/dashboard", "layout");
    else revalidatePath("/dashboard");
  }
}

export async function revokeConnectionAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => revokeMyConnection(formData.get("connectionId")),
    "Connection revoked.",
    "Could not revoke the connection.",
    "page",
  );
}

export async function revokeThreadLinkAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => revokeMyThreadLink(formData.get("linkId")),
    "Link ended.",
    "Could not end the link.",
    "page",
  );
}

/** Owner-initiated pairing. Never active until the agent session approves it. */
export async function requestPairingAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => requestMyPairing(formData.get("controllerSessionId"), formData.get("agentSessionId")),
    "Requested. Approve it on your computer.",
    "Could not request the link.",
    "page",
  );
}

/** Runtime controls (owner-only; the database re-checks ownership). */
export async function updateRuntimeAction(formData: FormData): Promise<ActionResult> {
  const runtimeId = formData.get("runtimeId");
  const intent = String(formData.get("intent") ?? "");
  const messages: Record<string, [string, string]> = {
    rename: ["Device renamed.", "Could not rename the device."],
    pause: ["Device paused.", "Could not pause the device."],
    resume: ["Device resumed.", "Could not resume the device."],
    restart: ["Restart requested.", "Could not request a restart."],
    settings: ["Settings saved.", "Could not save the settings."],
  };
  const [ok, fail] = messages[intent] ?? ["", "That action is not available."];
  if (!messages[intent]) return failed(fail);
  return attempt(
    async () => {
      if (intent === "rename") {
        await updateMyRuntime(runtimeId, { label: formData.get("label") });
      } else if (intent === "pause" || intent === "resume") {
        await updateMyRuntime(runtimeId, { paused: intent === "pause" });
      } else if (intent === "restart") {
        await updateMyRuntime(runtimeId, { requestRestart: true });
      } else {
        await updateMyRuntime(runtimeId, {
          settings: {
            autoStart: formData.get("autoStart") === "on",
            autoReconnect: formData.get("autoReconnect") === "on",
            notifications: formData.get("notifications") === "on",
          },
        });
      }
    },
    ok,
    fail,
  );
}

export async function revokeRuntimeAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => revokeMyRuntime(formData.get("runtimeId")),
    "Device disconnected.",
    "Could not disconnect the device.",
  );
}

export async function setLinkPausedAction(formData: FormData): Promise<ActionResult> {
  const paused = formData.get("paused") === "true";
  return attempt(
    () => setMyLinkPaused(formData.get("linkId"), paused),
    paused ? "Paused." : "Resumed.",
    paused ? "Could not pause." : "Could not resume.",
  );
}

/**
 * Change which Claude conversation a chat uses: the current link ends now and a
 * new one is requested. The Runtime must approve it (never auto-paired).
 */
export async function changeLinkConversationAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    async () => {
      const controllerSessionId = formData.get("controllerSessionId");
      const agentSessionId = formData.get("agentSessionId");
      await revokeMyThreadLink(formData.get("linkId"));
      await requestMyPairing(controllerSessionId, agentSessionId);
    },
    "Requested. Approve it on your computer.",
    "Could not change the conversation.",
  );
}
