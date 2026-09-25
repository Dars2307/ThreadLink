"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { failed, saved, type ActionResult } from "@/lib/dashboard/action-result";

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
 * user and lets the database re-check ownership.
 *
 * Every action says what happened. A failure is reported in plain words and
 * never carries database text; the page also re-renders with the true state.
 */

function refresh() {
  revalidatePath("/dashboard", "layout");
}

async function attempt(
  run: () => Promise<unknown>,
  ok: string,
  fail: string,
): Promise<ActionResult> {
  try {
    await run();
    return saved(ok);
  } catch (error) {
    // Only the error's kind is logged: never its message, which can carry data.
    console.error("owner action failed", error instanceof Error ? error.name : "unknown");
    return failed(error instanceof ZodError ? `${fail} That value is not allowed.` : fail);
  } finally {
    refresh();
  }
}

// --- Projects ---------------------------------------------------------------

export async function renameProjectAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => renameMyRoom(formData.get("roomId"), formData.get("name")),
    "Renamed.",
    "Could not rename the project.",
  );
}

export async function archiveProjectAction(formData: FormData): Promise<ActionResult> {
  const archived = formData.get("archived") === "true";
  return attempt(
    () => archiveMyRoom(formData.get("roomId"), archived),
    archived ? "Project archived." : "Project restored.",
    archived ? "Could not archive the project." : "Could not restore the project.",
  );
}

/** Removes the project from ThreadLink. Never touches repository files. */
export async function deleteProjectAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => deleteMyRoom(formData.get("roomId")),
    "Project removed from ThreadLink.",
    "Could not remove the project.",
  );
}

const int = (v: FormDataEntryValue | null) =>
  typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : undefined;

export async function updateProjectPolicyAction(formData: FormData): Promise<ActionResult> {
  const usage = formData.get("usagePolicy");
  return attempt(
    () =>
      // The owner function validates every bound (zod) and the database again.
      updateMyRoomPolicy(formData.get("roomId"), {
        parallelAgents: int(formData.get("parallelAgents")),
        maxPlanningRounds: int(formData.get("maxPlanningRounds")),
        maxReviewRounds: int(formData.get("maxReviewRounds")),
        usagePolicy: typeof usage === "string" && usage ? usage : undefined,
      }),
    "Project settings saved.",
    "Could not save the project settings.",
  );
}

// --- Providers & plans ------------------------------------------------------

export async function setProviderPlanAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () =>
      setMyProviderProfile({
        provider: formData.get("provider"),
        declaredPlan: formData.get("declaredPlan"),
      }),
    "Plan saved.",
    "Could not save your plan. Your previous plan is unchanged.",
  );
}

export async function setUsagePolicyAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () =>
      setMyProviderProfile({
        provider: formData.get("provider"),
        usagePolicy: formData.get("usagePolicy"),
      }),
    "Usage policy saved.",
    "Could not save the usage policy.",
  );
}

/**
 * Paid usage. Turning it ON needs the explicit confirmation field that only
 * the confirmation dialog sends; anything else is ignored. Turning it off
 * never needs confirming.
 */
export async function setPaidUsageAction(formData: FormData): Promise<ActionResult> {
  const enable = formData.get("paidUsage") === "on";
  if (enable && formData.get("confirmed") !== "I understand") {
    refresh();
    return failed("Paid usage was not changed: it needs your confirmation.");
  }
  return attempt(
    () => setMyProviderProfile({ provider: formData.get("provider"), paidUsageEnabled: enable }),
    enable ? "Paid usage allowed." : "Paid usage turned off.",
    "Could not change paid usage.",
  );
}

// --- Conversations ----------------------------------------------------------

/** "Remove from ThreadLink": stops routing; never deletes Claude or Codex history. */
export async function removeConversationAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => removeMyConversation(formData.get("sessionId")),
    "Conversation removed from ThreadLink.",
    "Could not remove the conversation.",
  );
}

// --- Devices ----------------------------------------------------------------

export async function renameDeviceAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => updateMyRuntime(formData.get("runtimeId"), { label: formData.get("label") }),
    "Device renamed.",
    "Could not rename the device.",
  );
}

/** Revokes the device's credential. The record is kept (shown under disconnected devices). */
export async function disconnectDeviceAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => revokeMyRuntime(formData.get("runtimeId")),
    "Device disconnected.",
    "Could not disconnect the device.",
  );
}

// --- Cleanup ----------------------------------------------------------------
// Candidates are recomputed here from fresh, owner-scoped data. A list posted
// by the browser is never trusted.

export async function archiveInactiveProjectsAction(): Promise<ActionResult> {
  try {
    const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
    if (!account || !team) return failed("Could not load your projects. Nothing was archived.");
    const { inactiveProjects } = cleanupCandidates(account, team);
    const results = await Promise.allSettled(
      inactiveProjects.map((room) => archiveMyRoom(room.roomId, true)),
    );
    return summarise(results, "project", "archived");
  } finally {
    refresh();
  }
}

export async function disconnectOfflineDevicesAction(): Promise<ActionResult> {
  try {
    const account = await loadAccount();
    if (!account) return failed("Could not load your devices. Nothing was disconnected.");
    const { offlineDevices } = cleanupCandidates(account, EMPTY_TEAM);
    const results = await Promise.allSettled(
      offlineDevices.map((device) => revokeMyRuntime(device.runtimeId)),
    );
    return summarise(results, "device", "disconnected");
  } finally {
    refresh();
  }
}

/** "3 projects archived." or, with failures, how many could not be. */
function summarise(
  results: PromiseSettledResult<unknown>[],
  noun: string,
  verb: string,
): ActionResult {
  const done = results.filter((r) => r.status === "fulfilled").length;
  const bad = results.length - done;
  const n = (k: number) => `${k} ${noun}${k === 1 ? "" : "s"}`;
  if (results.length === 0) return saved("Nothing to clean up.");
  if (bad === 0) return saved(`${n(done)} ${verb}.`);
  return failed(`${n(done)} ${verb}. ${n(bad)} could not be ${verb}; try again.`);
}
