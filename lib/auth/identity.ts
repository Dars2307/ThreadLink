import "server-only";

import { auth } from "@clerk/nextjs/server";

import {
  AuthenticationRequiredError,
  resolveIdentity,
  type AuthenticatedIdentity,
} from "./resolve-identity";

export { AuthenticationRequiredError, type AuthenticatedIdentity };

/**
 * Resolves the caller's identity from Clerk's verified server-side session.
 *
 * This is the single entry point for "who is calling?" in ThreadLink server
 * code. Never accept a user ID from request bodies, query strings, headers or
 * route params as a substitute; ownership must derive from this value.
 *
 * Any failure to establish identity (including Clerk errors) yields null.
 */
export async function getIdentity(): Promise<AuthenticatedIdentity | null> {
  try {
    return resolveIdentity(await auth());
  } catch {
    return null;
  }
}

/**
 * Like `getIdentity`, but fails closed by throwing `AuthenticationRequiredError`.
 * Use in route handlers, server actions and any protected server operation.
 */
export async function requireIdentity(): Promise<AuthenticatedIdentity> {
  const identity = await getIdentity();
  if (!identity) throw new AuthenticationRequiredError();
  return identity;
}
