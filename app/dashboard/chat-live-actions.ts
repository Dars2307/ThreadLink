"use server";

import { revalidatePath } from "next/cache";

import type { RunProvenance } from "@/lib/chat/types";
import { failed, saved, type ActionResult } from "@/lib/dashboard/action-result";
import { ATTACHMENT_MAX_BYTES, checkAttachment, decodeText } from "@/lib/dashboard/attachments";
import {
  addChatAttachment,
  ChatServerUnavailableError,
  controlJob,
  decideChoice,
  loadRunProvenance,
  revealNativeSession,
} from "@/lib/dashboard/chats-data";
import { CONTROL_TEXT, isJobControl, parseProvenance } from "@/lib/dashboard/timeline";

/**
 * 0.10 owner actions used from the chat view: decide a choice, control a job,
 * read a run's provenance, reveal a native session (owner only), attach a text
 * file. Every one goes through lib/dashboard/chats-data → the server's owner
 * function (Clerk identity + RLS); the database re-checks ownership. Only the
 * named fields are read, and every answer is a fixed sentence.
 */

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,39}$/;

const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : null;
};

function refreshChat(chatId: string | null) {
  if (chatId && ID.test(chatId)) revalidatePath(`/dashboard/chats/${chatId}`);
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
    console.error("chat live action failed", error instanceof Error ? error.name : "unknown");
    if (error instanceof ChatServerUnavailableError)
      return failed(`${fail} This isn't available yet.`);
    return failed(fail);
  }
}

/** Pick one of a choice's allowed options. The server checks the key against the per-kind allow-list. */
export async function decideChoiceAction(formData: FormData): Promise<ActionResult> {
  const choiceId = field(formData, "choiceId");
  const key = field(formData, "option");
  const chatId = field(formData, "chatId");
  if (
    !chatId ||
    !ID.test(chatId) ||
    !choiceId ||
    !ID.test(choiceId) ||
    !key ||
    !OPTION_KEY.test(key)
  ) {
    return failed("Nothing was chosen: that option is not allowed.");
  }
  if (field(formData, "confirmed") !== key)
    return failed("Nothing was chosen: it needs your confirmation.");
  const result = await attempt(
    () => decideChoice(chatId, choiceId, key),
    "Choice sent. ThreadLink continues.",
    "Could not send your choice.",
  );
  refreshChat(chatId);
  return result;
}

export async function controlJobAction(formData: FormData): Promise<ActionResult> {
  const jobId = field(formData, "jobId");
  const action = field(formData, "action");
  const chatId = field(formData, "chatId");
  if (!chatId || !ID.test(chatId) || !jobId || !ID.test(jobId) || !isJobControl(action))
    return failed("That control is not available.");
  if (CONTROL_TEXT[action].confirm && field(formData, "confirmed") !== action) {
    return failed("Nothing was stopped: it needs your confirmation.");
  }
  const result = await attempt(
    () => controlJob(chatId, jobId, action),
    action === "resume" ? "Resuming." : `Requested: ${CONTROL_TEXT[action].label.toLowerCase()}.`,
    "Could not send that request.",
  );
  refreshChat(chatId);
  return result;
}

export async function provenanceAction(
  chatId: unknown,
  runId: unknown,
): Promise<RunProvenance | null> {
  if (typeof chatId !== "string" || !ID.test(chatId)) return null;
  if (typeof runId !== "string" || !ID.test(runId)) return null;
  return parseProvenance(await loadRunProvenance(chatId, runId));
}

/** Owner-only: the native session id and the documented resume command, if the provider offers one. */
export async function revealSessionAction(
  chatId: unknown,
  runId: unknown,
): Promise<
  { ok: true; sessionId: string; command: string | null } | { ok: false; message: string }
> {
  if (
    typeof chatId !== "string" ||
    !ID.test(chatId) ||
    typeof runId !== "string" ||
    !ID.test(runId)
  ) {
    return { ok: false, message: "Not available." };
  }
  try {
    const r = (await revealNativeSession(chatId, runId)) as Record<string, unknown> | null;
    const sessionId = r && typeof r.nativeSessionId === "string" ? r.nativeSessionId : null;
    if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sessionId)) {
      return { ok: false, message: "This provider does not expose a persistent native session." };
    }
    const command =
      r &&
      typeof r.resumeCommand === "string" &&
      /^[A-Za-z0-9 _.:/@=-]{1,200}$/.test(r.resumeCommand)
        ? r.resumeCommand
        : null;
    return { ok: true, sessionId, command };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ChatServerUnavailableError
          ? "Revealing native sessions isn't available yet."
          : "Could not reveal the session.",
    };
  }
}

export async function uploadAttachmentAction(
  formData: FormData,
): Promise<ActionResult & { artifactId?: string; title?: string }> {
  const chatId = field(formData, "chatId");
  const file = formData.get("file");
  if (!chatId || !ID.test(chatId) || !(file instanceof File))
    return failed("Choose a text file to attach.");
  const check = checkAttachment({ name: file.name, size: file.size, type: file.type });
  if (!check.ok) return failed(check.message);
  if (file.size > ATTACHMENT_MAX_BYTES) return failed("Attachments can be up to 64 KB of text.");
  const content = decodeText(new Uint8Array(await file.arrayBuffer()));
  if (content === null) return failed("Only text files can be attached.");
  let artifactId: string | undefined;
  const result = await attempt(
    async () => {
      const r = (await addChatAttachment(chatId, {
        title: check.title,
        mime: check.mime,
        content,
      })) as { artifactId?: unknown } | null;
      if (r && typeof r.artifactId === "string" && ID.test(r.artifactId)) artifactId = r.artifactId;
    },
    `Saved to this chat's artifacts. Agents don't receive attachments yet.`,
    "Could not attach the file.",
  );
  refreshChat(chatId);
  return result.ok ? { ...result, artifactId, title: check.title } : result;
}
