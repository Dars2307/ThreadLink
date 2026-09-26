import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { ChatActionError } from "@/lib/chat/chats";
import { chatIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { deleteMyChat, getMyChat, updateMyChat } from "@/lib/chat/owner";
import {
  chatErrorResponse,
  chatFailure,
  isPlainObject,
  NO_STORE,
  readSmallJson,
} from "@/lib/chat/route-helpers";
import { sameOriginJson, sameOriginRequest } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * One chat, for its owner (Clerk session, user-scoped client, RLS).
 *
 * GET    -> ChatDetail (summary + settings + groups + retry option + lastReadSeq)
 * PATCH  {name?, roomId?: tlrom_|null, groupId?: tlgrp_|null, mode?,
 *         soloProvider?: p|null, builderProvider?: p|null, reviewerProvider?: p|null,
 *         pinned?: boolean, archived?: boolean}
 *        null clears (no project / no group / provider chosen automatically).
 *        -> {ok:true, chat: ChatDetail}
 * DELETE -> {ok:true}  ("Delete from ThreadLink"; refused while work runs: job_active)
 * Another account's chat answers exactly like a missing one (404 chat_not_found).
 */

type Ctx = { params: Promise<{ chatId: string }> };

async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

async function chatIdFrom(ctx: Ctx): Promise<string | null> {
  const parsed = chatIdSchema.safeParse((await ctx.params).chatId);
  return parsed.success ? parsed.data : null;
}

export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = await chatIdFrom(ctx);
  if (!chatId) return chatFailure("chat_not_found");
  try {
    const chat = await getMyChat(chatId);
    if (!chat) return chatFailure("chat_not_found");
    return Response.json(chat, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat read");
  }
}

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = await chatIdFrom(ctx);
  if (!chatId) return chatFailure("chat_not_found");
  const read = await readSmallJson(request);
  if (!read.ok) return read.response;
  if (!isPlainObject(read.body) || Object.keys(read.body).length === 0)
    return chatFailure("invalid");
  try {
    // One atomic change (fields, pin and archive together): a refusal applies nothing.
    await updateMyChat(chatId, read.body);
    const chat = await getMyChat(chatId);
    if (!chat) throw new ChatActionError("chat_not_found");
    return Response.json({ ok: true, chat }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat update");
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  // A DELETE carries no body, but it is still an owner mutation: same-origin only.
  if (!sameOriginRequest(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const chatId = await chatIdFrom(ctx);
  if (!chatId) return chatFailure("chat_not_found");
  try {
    await deleteMyChat(chatId);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat delete");
  }
}
