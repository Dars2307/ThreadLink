import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Deny by default: every route requires an authenticated Clerk session unless
 * it is explicitly listed here. New routes are protected automatically.
 *
 * This is the first gate only. Protected pages and handlers must still call
 * `requireIdentity()` and perform their own authorization checks.
 */
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

/**
 * Routes called by non-human clients (MCP, Claude Code bridge). They carry a
 * ThreadLink connection token, not a Clerk session, so the Clerk gate is
 * skipped here and EVERY handler under these prefixes must authenticate the
 * connection (`requireConnection()` / `handleClientRequest()`), enforced by
 * tests/client-boundary.test.ts.
 */
const isConnectionRoute = createRouteMatcher([
  "/api/connection/(.*)",
  "/api/session/(.*)",
  "/api/pairing",
  "/api/pairing/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !isConnectionRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
