import { describeEnvIssues, publicEnvSchema, type PublicEnv } from "./schema";

/**
 * Browser-safe environment. Only NEXT_PUBLIC_* variables may appear here.
 *
 * Each variable is referenced by its literal name because Next.js only inlines
 * `process.env.NEXT_PUBLIC_*` accesses it can see statically.
 */
function loadPublicEnv(): PublicEnv {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || undefined,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public environment:\n${describeEnvIssues(parsed.error)}`);
  }
  return parsed.data;
}

let cached: PublicEnv | undefined;

export function getPublicEnv(): PublicEnv {
  cached ??= loadPublicEnv();
  return cached;
}
