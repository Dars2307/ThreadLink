import { z } from "zod";

import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { groupIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { deleteMyChatGroup, renameMyChatGroup } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, NO_STORE, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson, sameOriginRequest } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * One chat group.
 * PATCH  {name} -> {ok:true, group: ChatGroup}
 * DELETE        -> {ok:true}   (the group goes; its chats stay, ungrouped)
 * Another account's group answers exactly like a missing one (404 group_not_found).
 */

type Ctx = { params: Promise<{ groupId: string }> };

async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

const bodySchema = z.object({ name: z.string() }).strict();

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const groupId = groupIdSchema.safeParse((await ctx.params).groupId);
  if (!groupId.success) return chatFailure("group_not_found");
  const read = await readSmallJson(request);
  if (!read.ok) return read.response;
  const body = bodySchema.safeParse(read.body);
  if (!body.success) return chatFailure("invalid");
  try {
    const group = await renameMyChatGroup(groupId.data, body.data.name);
    return Response.json({ ok: true, group }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat group rename");
  }
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  if (!sameOriginRequest(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const groupId = groupIdSchema.safeParse((await ctx.params).groupId);
  if (!groupId.success) return chatFailure("group_not_found");
  try {
    await deleteMyChatGroup(groupId.data);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat group delete");
  }
}
