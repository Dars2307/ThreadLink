/**
 * Guards against server-only secrets leaking into browser-exposed variables.
 *
 * Next.js inlines every `NEXT_PUBLIC_*` variable into the client bundle, so a
 * secret placed there is effectively published. These checks inspect variable
 * NAMES and key PREFIXES only; they never log or return secret values.
 */

const SECRET_NAME_PATTERN =
  /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|TOKEN|DATABASE_URL|HMAC|ENCRYPTION/i;

/** Returns the names of `NEXT_PUBLIC_*` variables whose name suggests a secret. */
export function findSecretLookingPublicVarNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("NEXT_PUBLIC_"))
    .filter((name) => SECRET_NAME_PATTERN.test(name.slice("NEXT_PUBLIC_".length)))
    .sort();
}

/** True when the value is a server-only Clerk or Supabase key by its well-known prefix/claims. */
export function looksLikeServerOnlyKey(value: string): boolean {
  if (value.startsWith("sk_") || value.startsWith("sb_secret_")) return true;
  return isLegacySupabaseServiceRoleJwt(value);
}

function isLegacySupabaseServiceRoleJwt(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as unknown;
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { role?: unknown }).role === "service_role"
    );
  } catch {
    return false;
  }
}
