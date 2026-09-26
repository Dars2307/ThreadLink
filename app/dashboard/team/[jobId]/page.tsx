import { notFound, redirect } from "next/navigation";

import { defaultChatFor, jobRedirect } from "@/lib/dashboard/chats";
import { loadChats, locateJob } from "@/lib/dashboard/chats-data";
import { loadJob } from "@/lib/dashboard/data";
import { parseJobParam } from "@/lib/dashboard/project";

/**
 * Old address of a job's full log. A job now lives in its chat (Progress tab);
 * without a known chat it goes to its project's default chat, else to the
 * project. A job that is not yours reads exactly like one that does not exist.
 */
export default async function TeamLogRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { jobId } = await params;
  const search = await searchParams;
  const id = parseJobParam(jobId);
  if (!id) notFound();
  const located = await locateJob(id);
  if (!located) notFound();
  let { chatId, roomId } = located;
  if (!chatId) {
    const job = await loadJob(id);
    roomId = job?.roomId ?? roomId;
    if (roomId) {
      const chats = await loadChats();
      chatId = chats ? defaultChatFor(roomId, job?.project ?? null, chats) : null;
    }
  }
  const to = jobRedirect(id, { chatId, roomId }, search);
  if (!to) notFound();
  redirect(to);
}
