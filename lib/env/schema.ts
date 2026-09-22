import { z } from "zod";

import { looksLikeServerOnlyKey } from "@/lib/security/public-env-guard";

/**
 * Environment schemas. Pure (no `server-only`) so they can be unit tested.
 *
 * Error messages name the variable and the rule that failed. They must never
 * include the value itself.
 */

const nonEmpty = z.string().trim().min(1, "is required");

const publicKey = nonEmpty.refine((value) => !looksLikeServerOnlyKey(value), {
  message: "contains a server-only secret key; it must never be exposed to the browser",
});

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
  ),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicKey.refine((value) => value.startsWith("pk_"), {
    message: "must be a Clerk publishable key (pk_...)",
  }),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
});

export const serverEnvSchema = publicEnvSchema
  .extend({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CLERK_SECRET_KEY: nonEmpty.refine((value) => value.startsWith("sk_"), {
      message: "must be a Clerk secret key (sk_...)",
    }),
    SUPABASE_SECRET_KEY: nonEmpty,
    DATABASE_URL: nonEmpty.refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: "must be a postgres:// or postgresql:// connection string",
    }),
    // Server-side HMAC key ("pepper") for connection-credential hashes. At least
    // 32 bytes of CSPRNG output; rotating it invalidates every issued credential.
    THREADLINK_CONNECTION_SECRET: nonEmpty.refine((value) => value.length >= 43, {
      message: "must be at least 32 random bytes (43+ base64url characters)",
    }),
    THREADLINK_ENV: z.string().trim().optional(),
    THREADLINK_ALLOW_INSECURE_DEV: z
      .enum(["true", "false", ""])
      .optional()
      .transform((value) => value === "true"),
  })
  .superRefine((env, ctx) => {
    if (
      env.THREADLINK_CONNECTION_SECRET === env.CLERK_SECRET_KEY ||
      env.THREADLINK_CONNECTION_SECRET === env.SUPABASE_SECRET_KEY
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["THREADLINK_CONNECTION_SECRET"],
        message: "must be a dedicated secret, not a reused Clerk/Supabase key",
      });
    }
    if (env.NODE_ENV === "production" && env.THREADLINK_ALLOW_INSECURE_DEV) {
      ctx.addIssue({
        code: "custom",
        path: ["THREADLINK_ALLOW_INSECURE_DEV"],
        message: "must not be enabled in production",
      });
    }
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Formats a ZodError as "VAR_NAME: rule" lines without echoing any input values. */
export function describeEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
