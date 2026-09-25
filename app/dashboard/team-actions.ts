"use server";

import { revalidatePath } from "next/cache";

import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { cleanupCandidates, EMPTY_TEAM } from "@/lib/dashboard/pages";
import { setMyProviderProfile } from "@/lib/providers/repository";
import {
  archiveMyRoom,
  deleteMyRoom,
  renameMyRoom,
  updateMyRoomPolicy,
} from "@/lib/rooms/repository";
import { revokeMyRuntime, updateMyRuntime } from "@/lib/runtimes/repository";
import { removeMyConversation } from "@/lib/team/owner";

/**
 * Owner actions for projects, provider profiles, conversations and cleanup.
 * Each goes through the lib/* owner function, which resolves the signed-in
 * user and lets the database re-check ownership. Failures are generic by
 * design: the page re-renders with the true state either way.
 */

function refresh() {
  revalidatePath("/dashboard", "layout");
}

async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Generic by design.
  }
  refresh();
}

// --- Projects ---------------------------------------------------------------

export async function renameProjectAction(formData: FormData): Promise<void> {
  await attempt(() => renameMyRoom(formData.get("roomId"), formData.get("name")));
}

export async function archiveProjectAction(formData: FormData): Promise<void> {
  await attempt(() => archiveMyRoom(formData.get("roomId"), formData.get("archived") === "true"));
}

/** Removes the project from ThreadLink. Never touches repository files. */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  await attempt(() => deleteMyRoom(formData.get("roomId")));
}

const int = (v: FormDataEntryValue | null) =>
  typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : undefined;

export async function updateProjectPolicyAction(formData: FormData): Promise<void> {
  const usage = formData.get("usagePolicy");
  await attempt(() =>
    // The owner function validates every bound (zod) and the database again.
    updateMyRoomPolicy(formData.get("roomId"), {
      parallelAgents: int(formData.get("parallelAgents")),
      maxPlanningRounds: int(formData.get("maxPlanningRounds")),
      maxReviewRounds: int(formData.get("maxReviewRounds")),
      usagePolicy: typeof usage === "string" && usage ? usage : undefined,
    }),
  );
}

// --- Providers & plans ------------------------------------------------------

export async function setProviderPlanAction(formData: FormData): Promise<void> {
  await attempt(() =>
    setMyProviderProfile({
      provider: formData.get("provider"),
      declaredPlan: formData.get("declaredPlan"),
    }),
  );
}

export async function setUsagePolicyAction(formData: FormData): Promise<void> {
  await attempt(() =>
    setMyProviderProfile({
      provider: formData.get("provider"),
      usagePolicy: formData.get("usagePolicy"),
    }),
  );
}

/**
 * Paid usage. Turning it ON needs the explicit confirmation field that only
 * the confirmation dialog sends; anything else is ignored. Turning it off
 * never needs confirming.
 */
export async function setPaidUsageAction(formData: FormData): Promise<void> {
  const enable = formData.get("paidUsage") === "on";
  if (enable && formData.get("confirmed") !== "I understand") {
    refresh();
    return;
  }
  await attempt(() =>
    setMyProviderProfile({ provider: formData.get("provider"), paidUsageEnabled: enable }),
  );
}

// --- Conversations ----------------------------------------------------------

/** "Remove from ThreadLink": stops routing; never deletes Claude or Codex history. */
export async function removeConversationAction(formData: FormData): Promise<void> {
  await attempt(() => removeMyConversation(formData.get("sessionId")));
}

// --- Devices ----------------------------------------------------------------

export async function renameDeviceAction(formData: FormData): Promise<void> {
  await attempt(() => updateMyRuntime(formData.get("runtimeId"), { label: formData.get("label") }));
}

/** Revokes the device's credential. The record is kept (shown under disconnected devices). */
export async function disconnectDeviceAction(formData: FormData): Promise<void> {
  await attempt(() => revokeMyRuntime(formData.get("runtimeId")));
}

// --- Cleanup ----------------------------------------------------------------
// Candidates are recomputed here from fresh, owner-scoped data. A list posted
// by the browser is never trusted.

export async function archiveInactiveProjectsAction(): Promise<void> {
  await attempt(async () => {
    const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
    if (!account || !team) return;
    const { inactiveProjects } = cleanupCandidates(account, team);
    for (const room of inactiveProjects) {
      await archiveMyRoom(room.roomId, true).catch(() => undefined);
    }
  });
}

export async function disconnectOfflineDevicesAction(): Promise<void> {
  await attempt(async () => {
    const account = await loadAccount();
    if (!account) return;
    const { offlineDevices } = cleanupCandidates(account, EMPTY_TEAM);
    for (const device of offlineDevices) {
      await revokeMyRuntime(device.runtimeId).catch(() => undefined);
    }
  });
}
