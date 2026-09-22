/**
 * Pure identity resolution. Kept free of framework imports so the fail-closed
 * rules can be unit tested; `identity.ts` wires it to Clerk's verified session.
 */

/**
 * The only identity ThreadLink server code may use for ownership decisions.
 *
 * `clerkUserId` is the canonical external human identity. Display names and
 * email addresses are NEVER authorization identifiers.
 */
export type AuthenticatedIdentity = {
  readonly clerkUserId: string;
  readonly sessionId: string;
};

/** Minimal shape of Clerk's server-side auth state that we depend on. */
export type ServerAuthState = {
  isAuthenticated: boolean;
  userId: string | null;
  sessionId: string | null;
};

export class AuthenticationRequiredError extends Error {
  constructor() {
    // Deliberately generic: never reveal why authentication failed.
    super("Authentication required");
    this.name = "AuthenticationRequiredError";
  }
}

const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;
const CLERK_SESSION_ID = /^sess_[A-Za-z0-9]+$/;

/**
 * Returns the verified identity, or null if the auth state is anything other
 * than a fully authenticated user session with well-formed identifiers.
 */
export function resolveIdentity(
  state: ServerAuthState | null | undefined,
): AuthenticatedIdentity | null {
  if (!state || state.isAuthenticated !== true) return null;
  const { userId, sessionId } = state;
  if (typeof userId !== "string" || !CLERK_USER_ID.test(userId)) return null;
  if (typeof sessionId !== "string" || !CLERK_SESSION_ID.test(sessionId)) return null;
  return Object.freeze({ clerkUserId: userId, sessionId });
}
