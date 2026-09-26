import { z } from "zod";

import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ChatErrorReason } from "@/lib/chat/model";
import { createMyChatGroup, listMyChatGroups } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure, NO_STORE, readSmallJson } from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * The owner's chat groups.
 * GET  -> {groups: ChatGroup[]}
 * POST {name} -> {ok:true, group: ChatGroup}   (name_taken / limit_reached on refusal)
 */

async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

export async function GET(): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  try {
    return Response.json({ groups: await listMyChatGroups() }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat groups read");
  }
}

const bodySchema = z.object({ name: z.string() }).strict();

export async function POST(request: Request): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const read = await readSmallJson(request);
  if (!read.ok) return read.response;
  const body = bodySchema.safeParse(read.body);
  if (!body.success) return chatFailure("invalid");
  try {
    const group = await createMyChatGroup(body.data.name);
    return Response.json({ ok: true, group }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat group create");
  }
}
