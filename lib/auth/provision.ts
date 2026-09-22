import { z } from "zod";

import { idPattern } from "@/lib/ids";

import type { AuthenticatedIdentity } from "./resolve-identity";

/**
 * ThreadLink user as seen by application code. `id` is the ownership key for
 * all ThreadLink resources. `displayName`/`primaryEmail` are display-only.
 */
export type ThreadLinkUser = {
  readonly id: string;
  readonly clerkUserId: string;
  readonly displayName: string | null;
  readonly primaryEmail: string | null;
  readonly createdAt: string;
};

/** Display-only profile metadata copied from Clerk. Never used for authorization. */
export type ProfileMetadata = {
  displayName: string | null;
  primaryEmail: string | null;
};

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

/** The one database capability provisioning needs (a user-scoped Supabase client). */
export type ProvisioningDatabase = {
  rpc(fn: "provision_current_user", args: ProvisionArgs): PromiseLike<RpcResult>;
};

export type ProvisionArgs = {
  p_display_name: string | null;
  p_primary_email: string | null;
};

export class ThreadLinkUserUnavailableError extends Error {
  constructor() {
    // Generic by design: do not reveal whether the failure was auth, DB or mapping.
    super("ThreadLink account unavailable");
    this.name = "ThreadLinkUserUnavailableError";
  }
}

const userRowSchema = z.object({
  id: z.string().regex(idPattern("user")),
  clerk_user_id: z.string(),
  display_name: z.string().nullable(),
  primary_email: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Resolves (and lazily creates) the ThreadLink user for a verified identity.
 *
 * The Clerk user ID is NOT sent to the database: `provision_current_user`
 * reads it from the verified JWT the client carries. We then check that the
 * row the database returned is mapped to the same Clerk identity we verified
 * server-side. Any error or mismatch fails closed.
 */
export async function provisionThreadLinkUser(
  identity: AuthenticatedIdentity,
  profile: ProfileMetadata,
  db: ProvisioningDatabase,
): Promise<ThreadLinkUser> {
  const { data, error } = await db.rpc("provision_current_user", {
    p_display_name: profile.displayName,
    p_primary_email: profile.primaryEmail,
  });
  if (error) throw new ThreadLinkUserUnavailableError();

  const parsed = userRowSchema.safeParse(data);
  if (!parsed.success) throw new ThreadLinkUserUnavailableError();

  const row = parsed.data;
  if (row.clerk_user_id !== identity.clerkUserId) throw new ThreadLinkUserUnavailableError();

  return Object.freeze({
    id: row.id,
    clerkUserId: row.clerk_user_id,
    displayName: row.display_name,
    primaryEmail: row.primary_email,
    createdAt: row.created_at,
  });
}
