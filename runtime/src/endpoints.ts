/**
 * Where ThreadLink lives.
 *
 * Vercel gives every build its own generated hostname, such as
 * `threadlink-iz4qemadi-ash-murrays-projects.vercel.app`. Those hostnames are
 * immutable snapshots: the deployment behind one never changes, so a Runtime
 * that stored one keeps talking to an old build of ThreadLink forever, long
 * after the API it needs has moved on. They must never be persisted as the
 * address of ThreadLink.
 *
 * Each channel therefore has one stable hostname, and a stored address that is
 * some other *.vercel.app host is upgraded to it automatically. Custom domains
 * and localhost are left exactly as they are: those are deliberate choices.
 */

export type ThreadLinkChannel = "preview" | "production";

export const CANONICAL_BASE_URL: Record<ThreadLinkChannel, string> = {
  preview: "https://threadlink-mcp-preview.vercel.app",
  production: "https://threadlink-one.vercel.app",
};

/**
 * The channel this build targets. Phase 6.6 acceptance testing runs against
 * Preview; moving testing to Production is a deliberate change here (or
 * THREADLINK_CHANNEL for a one-off).
 */
export const BUILD_CHANNEL: ThreadLinkChannel =
  process.env.THREADLINK_CHANNEL === "production" ? "production" : "preview";

export function canonicalBaseUrl(channel: ThreadLinkChannel = BUILD_CHANNEL): string {
  return CANONICAL_BASE_URL[channel];
}

const CANONICAL_HOSTS = new Set(
  Object.values(CANONICAL_BASE_URL).map((url) => new URL(url).hostname),
);

/** True for a *.vercel.app host that is not one of ours: a generated build URL. */
export function isGeneratedDeploymentHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower.endsWith(".vercel.app") && !CANONICAL_HOSTS.has(lower);
}

export type CanonicalizeResult = {
  /** The address to use from now on. */
  url: string;
  /** True when it differs from what was stored. */
  changed: boolean;
  /** The address that was replaced, for telling the user what happened. */
  previous: string | null;
};

/**
 * Upgrades a stored address to the canonical one for this channel when it is a
 * generated deployment hostname. Anything else is returned untouched.
 */
export function canonicalizeBaseUrl(
  raw: string | null | undefined,
  channel: ThreadLinkChannel = BUILD_CHANNEL,
): CanonicalizeResult {
  const canonical = canonicalBaseUrl(channel);
  if (!raw) return { url: canonical, changed: false, previous: null };

  let host: string;
  let origin: string;
  try {
    const url = new URL(raw);
    host = url.hostname;
    origin = url.origin;
  } catch {
    // Not a URL at all: fall back to the canonical address rather than keeping it.
    return { url: canonical, changed: true, previous: raw };
  }

  if (!isGeneratedDeploymentHost(host)) return { url: origin, changed: false, previous: null };
  return { url: canonical, changed: true, previous: origin };
}
