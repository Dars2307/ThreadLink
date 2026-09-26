import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { groupIdSchema, roomIdSchema, type ChatErrorReason } from "@/lib/chat/model";
import { createMyChat, listMyChatGroups, listMyChats } from "@/lib/chat/owner";
import {
  chatErrorResponse,
  chatFailure,
  isPlainObject,
  NO_STORE,
  readSmallJson,
} from "@/lib/chat/route-helpers";
import { sameOriginJson } from "@/lib/chat/same-origin";

export const dynamic = "force-dynamic";

/**
 * The owner's chats (Clerk session, user-scoped client, RLS).
 *
 * GET  ?search=&group=<tlgrp_>&room=<tlrom_>&mode=solo|pair|team&archived=0|1
 *      -> {chats: (ChatSummary & {isRoomDefault})[], groups: ChatGroup[]}
 *      pinned first, then most recent activity; deleted chats never appear.
 * POST {name, roomId?: tlrom_|null, groupId?: tlgrp_|null, mode?: solo|pair|team}
 *      -> {ok:true, chat: ChatRecord}
 * Errors: {ok:false, reason, message} (fixed sentences).
 */

async function signedIn(): Promise<ChatErrorReason | null> {
  try {
    await requireThreadLinkUser();
    return null;
  } catch (error) {
    return error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable";
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const p = new URL(request.url).searchParams;
  const archived = p.get("archived");
  const group = p.get("group");
  const room = p.get("room");
  const mode = p.get("mode");
  const search = p.get("search");
  if (
    (archived !== null && !["0", "1", "true", "false"].includes(archived)) ||
    (group !== null && !groupIdSchema.safeParse(group).success) ||
    (room !== null && !roomIdSchema.safeParse(room).success) ||
    (mode !== null && !["solo", "pair", "team"].includes(mode)) ||
    (search !== null && search.length > 100)
  ) {
    return chatFailure("invalid");
  }
  try {
    const [chats, groups] = await Promise.all([
      listMyChats({
        ...(search !== null && search.trim() !== "" ? { search } : {}),
        ...(group !== null ? { groupId: group } : {}),
        ...(room !== null ? { roomId: room } : {}),
        ...(mode !== null ? { mode: mode as "solo" | "pair" | "team" } : {}),
        includeArchived: archived === "1" || archived === "true",
      }),
      listMyChatGroups(),
    ]);
    return Response.json({ chats, groups }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat list");
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOriginJson(request)) return chatFailure("invalid");
  const denied = await signedIn();
  if (denied) return chatFailure(denied);
  const read = await readSmallJson(request);
  if (!read.ok) return read.response;
  if (!isPlainObject(read.body)) return chatFailure("invalid");
  try {
    const chat = await createMyChat(read.body);
    return Response.json({ ok: true, chat }, { headers: NO_STORE });
  } catch (error) {
    return chatErrorResponse(error, "chat create");
  }
}
