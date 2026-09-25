import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";
import type { RoomView } from "@/lib/team/model";

import {
  archiveRoomAs,
  deleteRoomAs,
  listRoomsFor,
  renameRoomAs,
  updateRoomPolicyAs,
  type OwnerRoom,
} from "./queries";

/**
 * Signed-in (dashboard) entry points for rooms. Identity comes only from the
 * verified Clerk session; every call runs as that user under RLS and the
 * database re-checks ownership ("not found" for anything else).
 */

export { RoomNotFoundError, type OwnerRoom } from "./queries";

export async function listMyRooms(): Promise<OwnerRoom[]> {
  const user = await requireThreadLinkUser();
  return listRoomsFor(createUserSupabaseClient(), user);
}

export async function renameMyRoom(roomId: unknown, name: unknown): Promise<RoomView> {
  await requireThreadLinkUser();
  return renameRoomAs(createUserSupabaseClient(), roomId, name);
}

export async function archiveMyRoom(roomId: unknown, archived: boolean): Promise<RoomView> {
  await requireThreadLinkUser();
  return archiveRoomAs(createUserSupabaseClient(), roomId, archived);
}

export async function deleteMyRoom(roomId: unknown): Promise<void> {
  await requireThreadLinkUser();
  return deleteRoomAs(createUserSupabaseClient(), roomId);
}

export async function updateMyRoomPolicy(roomId: unknown, policy: unknown): Promise<RoomView> {
  await requireThreadLinkUser();
  return updateRoomPolicyAs(createUserSupabaseClient(), roomId, policy);
}
