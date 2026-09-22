import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Deny by default: every route requires an authenticated Clerk session unless
 * it is explicitly listed here. New routes are protected automatically.
 *
 * This is the first gate only. Protected pages and handlers must still call
 * `requireIdentity()` and perform their own authorization checks.
 */
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
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
