"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { failed, saved, type ActionResult } from "@/lib/dashboard/action-result";
import { chatHref } from "@/lib/dashboard/chats";
import {
  ChatServerUnavailableError,
  createChat,
  createChatGroup,
  deleteChat,
  deleteChatGroup,
  renameChatGroup,
  retryJobWithRoles,
  setChatArchived,
  setChatPinned,
  updateChat,
  type ChatPatch,
} from "@/lib/dashboard/chats-data";

/**
 * Owner actions for chats and chat groups. Each goes through lib/dashboard/
 * chats-data → the server's owner function, which resolves the signed-in user
 * and lets the database re-check ownership. Only the named form fields are
 * read. Every action says what happened, in plain words, never database text.
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
    console.error("chat action failed", error instanceof Error ? error.name : "unknown");
    if (error instanceof ChatServerUnavailableError) {
      return failed(`${fail} This isn't available yet.`);
    }
    return failed(error instanceof ZodError ? `${fail} That value is not allowed.` : fail);
  } finally {
    refresh();
  }
}

const text = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : null;
};

/** "" in a picker means "none" / "Auto": sent as null (clear), never as an empty id. */
const optional = (f: FormData, name: string) => {
  const v = text(f, name);
  return v === null ? undefined : v.trim() === "" ? null : v;
};

// --- Chats ------------------------------------------------------------------

export async function createChatAction(formData: FormData): Promise<ActionResult> {
  const created: { chatId: string | null } = { chatId: null };
  const result = await attempt(
    async () => {
      created.chatId = await createChat({
        name: (text(formData, "name") ?? "").trim(),
        roomId: optional(formData, "roomId") ?? null,
        groupId: optional(formData, "groupId") ?? null,
        mode: text(formData, "mode") ?? undefined,
      });
    },
    "Chat created.",
    "Could not create the chat.",
  );
  // Say where the new chat is; the status line links to it.
  return result.ok && created.chatId ? { ...result, href: chatHref(created.chatId) } : result;
}

export async function renameChatAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => updateChat(formData.get("chatId"), { name: (text(formData, "name") ?? "").trim() }),
    "Renamed.",
    "Could not rename the chat.",
  );
}

export async function pinChatAction(formData: FormData): Promise<ActionResult> {
  const pinned = formData.get("pinned") === "true";
  return attempt(
    () => setChatPinned(formData.get("chatId"), pinned),
    pinned ? "Pinned." : "Unpinned.",
    pinned ? "Could not pin the chat." : "Could not unpin the chat.",
  );
}

export async function archiveChatAction(formData: FormData): Promise<ActionResult> {
  const archived = formData.get("archived") === "true";
  return attempt(
    () => setChatArchived(formData.get("chatId"), archived),
    archived ? "Chat archived." : "Chat restored.",
    archived ? "Could not archive the chat." : "Could not restore the chat.",
  );
}

/** Removes the chat from ThreadLink only. Never touches files or provider history. */
export async function deleteChatAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => deleteChat(formData.get("chatId")),
    "Chat deleted from ThreadLink.",
    "Could not delete the chat.",
  );
}

/** Add to, move to, or remove from a project ("" = no project). Future work only. */
export async function setChatProjectAction(formData: FormData): Promise<ActionResult> {
  const roomId = optional(formData, "roomId");
  if (roomId === undefined) return failed("Choose a project first.");
  return attempt(
    () => updateChat(formData.get("chatId"), { roomId }),
    roomId ? "Project saved. New work uses its folder." : "Removed from the project.",
    "Could not change the chat's project.",
  );
}

/** Set or clear the chat's group ("" = no group). */
export async function setChatGroupAction(formData: FormData): Promise<ActionResult> {
  const groupId = optional(formData, "groupId");
  if (groupId === undefined) return failed("Choose a group first.");
  return attempt(
    () => updateChat(formData.get("chatId"), { groupId }),
    groupId ? "Group saved." : "Removed from the group.",
    "Could not change the chat's group.",
  );
}

/**
 * The chat's mode and who does what. Affects future work only; the server
 * writes "Mode changed to …" into the chat. Empty picks mean Auto.
 */
export async function setChatModeAction(formData: FormData): Promise<ActionResult> {
  const mode = text(formData, "mode");
  const patch: ChatPatch = { mode };
  if (mode === "solo") patch.soloProvider = optional(formData, "soloProvider") ?? null;
  if (mode === "pair") {
    patch.builderProvider = optional(formData, "builderProvider") ?? null;
    patch.reviewerProvider = optional(formData, "reviewerProvider") ?? null;
  }
  return attempt(
    () => updateChat(formData.get("chatId"), patch),
    "Mode saved. It applies to new work.",
    "Could not change the mode.",
  );
}

/**
 * "Retry with <provider> as coordinator": explicit, from the confirm dialog
 * only. The server refuses it unless the job is eligible and that provider is
 * Ready; a refusal is shown as a failure.
 */
export async function retryJobAction(formData: FormData): Promise<ActionResult> {
  if (formData.get("confirmed") !== "retry") {
    refresh();
    return failed("Nothing was retried: it needs your confirmation.");
  }
  return attempt(
    () => retryJobWithRoles(formData.get("jobId"), formData.get("coordinator")),
    "Started again as new work in this chat.",
    "Could not retry. Check that the other agent is ready, then try again.",
  );
}

// --- Groups -----------------------------------------------------------------

export async function createGroupAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => createChatGroup((text(formData, "name") ?? "").trim()),
    "Group created.",
    "Could not create the group.",
  );
}

export async function renameGroupAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => renameChatGroup(formData.get("groupId"), (text(formData, "name") ?? "").trim()),
    "Group renamed.",
    "Could not rename the group.",
  );
}

/** Deletes the group only; its chats stay, without a group. */
export async function deleteGroupAction(formData: FormData): Promise<ActionResult> {
  return attempt(
    () => deleteChatGroup(formData.get("groupId")),
    "Group deleted. Its chats are kept.",
    "Could not delete the group.",
  );
}
