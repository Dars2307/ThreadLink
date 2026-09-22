import "server-only";

import { findSecretLookingPublicVarNames } from "@/lib/security/public-env-guard";

import { describeEnvIssues, serverEnvSchema, type ServerEnv } from "./schema";

let cached: ServerEnv | undefined;

/**
 * Validated server environment. Throws (fails closed) if any required variable
 * is missing or malformed, or if a secret-looking name is exposed as NEXT_PUBLIC_*.
 *
 * Validation is lazy so that `next build` does not require production secrets,
 * but every server code path that needs configuration goes through here first.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const leaked = findSecretLookingPublicVarNames(process.env);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to start: secret-looking variables are exposed to the browser via NEXT_PUBLIC_: ${leaked.join(", ")}`,
    );
  }

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${describeEnvIssues(parsed.error)}`);
  }

  cached = parsed.data;
  return cached;
}
