import "server-only";

import { currentUser } from "@clerk/nextjs/server";
import { cache } from "react";

import { createUserSupabaseClient } from "@/lib/supabase/server";

import { requireIdentity } from "./identity";
import {
  provisionThreadLinkUser,
  ThreadLinkUserUnavailableError,
  type ProfileMetadata,
  type ThreadLinkUser,
} from "./provision";

export { ThreadLinkUserUnavailableError, type ThreadLinkUser };

/**
 * Returns the caller's ThreadLink user, provisioning it on first use.
 *
 * This is the entry point for any server code that needs ThreadLink ownership.
 * It takes no arguments on purpose: identity comes only from the verified
 * Clerk session. Deduplicated per request via React `cache`.
 *
 * Throws `AuthenticationRequiredError` if unauthenticated, or
 * `ThreadLinkUserUnavailableError` if the database mapping cannot be established.
 */
export const requireThreadLinkUser = cache(async (): Promise<ThreadLinkUser> => {
  const identity = await requireIdentity();
  const profile = await loadProfileMetadata(identity.clerkUserId);
  return provisionThreadLinkUser(identity, profile, createUserSupabaseClient());
});

async function loadProfileMetadata(clerkUserId: string): Promise<ProfileMetadata> {
  try {
    const user = await currentUser();
    if (!user || user.id !== clerkUserId) return { displayName: null, primaryEmail: null };
    return {
      displayName: user.fullName ?? user.username ?? null,
      primaryEmail: user.primaryEmailAddress?.emailAddress ?? null,
    };
  } catch {
    // Metadata is optional; identity does not depend on it.
    return { displayName: null, primaryEmail: null };
  }
}
