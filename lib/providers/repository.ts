import "server-only";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { createUserSupabaseClient } from "@/lib/supabase/server";

import {
  listProviderProfilesFor,
  setProviderProfileAs,
  type OwnerProviderProfile,
} from "./queries";

/**
 * Signed-in (dashboard) provider profiles. This is the ONLY path that can turn
 * paid usage on, and only with an explicit value from the signed-in owner.
 */

export type { OwnerProviderProfile } from "./queries";

export async function setMyProviderProfile(input: unknown): Promise<OwnerProviderProfile> {
  await requireThreadLinkUser();
  return setProviderProfileAs(createUserSupabaseClient(), input);
}

export async function listMyProviderProfiles(): Promise<OwnerProviderProfile[]> {
  const user = await requireThreadLinkUser();
  return listProviderProfilesFor(createUserSupabaseClient(), user);
}
