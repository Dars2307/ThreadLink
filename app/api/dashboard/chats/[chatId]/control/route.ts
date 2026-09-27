import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { controlMyJob } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, json, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/** Fail closed before reading anything from the request (the signed-in ThreadLink user). */
async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

/**
 * 0.10: steer a running job of this chat (section 5).
 * POST {jobId, action} -> {ok:true, control:{jobId, control, controlRequestedAt, status}}
 *   action: pause_after_step | stop_after_review | stop_before_integration |
 *           stop_now | cancel_queued | resume
 * Refusals: 404 job_not_found, 409 job_finished / nothing_to_resume /
 * runtime_outdated (a Runtime before protocol 10 knows only stop_now).
 */

type Ctx = { params: Promise<{ chatId: string }> };

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  const read = await readSmallJson(request, 512);
  if (!read.ok) return read.response;
  try {
    return json({ ok: true, control: await controlMyJob(chatId.data, read.body) });
  } catch (error) {
    return chatErrorResponse(error, "job control");
  }
}
