import { z } from "zod";

import { PROVIDER_HEALTH, type ProviderHealth, type ProviderHealthEntry } from "@/lib/chat/types";

/**
 * Provider health (docs/design/chat-first.md section 2), pure and shared by the
 * owner reads, the chat routes and the MCP tools. Mirrors, word for word,
 * threadlink_private.provider_effective_health / provider_health_sentence in
 * the chat-first migration (tests assert both).
 *
 * "Ready" needs a recent, real authenticated call reported by the Runtime.
 * Status output ("authenticated: true") alone is never proof.
 */

export { PROVIDER_HEALTH, type ProviderHealth, type ProviderHealthEntry };

/** A health check older than this proves nothing about the sign-in now. */
export const HEALTH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Display metadata for any provider. Unknown ids get a neutral label. */
export const PROVIDER_META: Record<string, { name: string; shortName: string }> = {
  "claude-code": { name: "Claude Code", shortName: "Claude" },
  codex: { name: "Codex", shortName: "Codex" },
};

export function providerName(provider: string): string {
  return PROVIDER_META[provider]?.name ?? "An agent";
}

/** The short label the UI shows ("Needs sign-in"). */
export const PROVIDER_HEALTH_LABELS: Record<ProviderHealth, string> = {
  ready: "Ready",
  needs_sign_in: "Needs sign-in",
  not_installed: "Not installed",
  api_key_auth: "Uses an API key — sign in with your subscription",
  usage_exhausted: "Usage limit reached",
  unknown: "Not checked yet",
};

const SUBSCRIPTION_AUTH: Record<string, string> = { "claude-code": "claude.ai", codex: "chatgpt" };
const FAILING: readonly ProviderHealth[] = [
  "needs_sign_in",
  "not_installed",
  "api_key_auth",
  "usage_exhausted",
];

const isHealth = (v: unknown): v is ProviderHealth =>
  typeof v === "string" && (PROVIDER_HEALTH as readonly string[]).includes(v);

/**
 * The health that counts now, from a stored detection document and the time
 * the server received it. Fails closed, exactly like the SQL.
 */
export function effectiveHealth(
  provider: string,
  detected: Record<string, unknown> | null | undefined,
  detectedAt: string | null | undefined,
  now: number = Date.now(),
): ProviderHealth {
  if (!detected || Object.keys(detected).length === 0 || !detectedAt) return "unknown";
  if (detected.installed === false) return "not_installed";
  if (isHealth(detected.health) && FAILING.includes(detected.health)) return detected.health;
  if (typeof detected.installed !== "boolean") return "unknown";
  if (detected.authenticated !== true) return "needs_sign_in";
  if (detected.authMethod !== SUBSCRIPTION_AUTH[provider]) return "api_key_auth";
  if (detected.health !== "ready") return "unknown";
  const checked =
    typeof detected.healthCheckedAt === "string" ? Date.parse(detected.healthCheckedAt) : NaN;
  const received = Date.parse(detectedAt);
  if (!Number.isFinite(checked) || !Number.isFinite(received)) return "unknown";
  if (Math.min(checked, received) < now - HEALTH_MAX_AGE_MS) return "unknown";
  return "ready";
}

/** One fixed sentence per provider and health (the chat's provider_blocked wording). */
export function healthSentence(provider: string, health: ProviderHealth): string {
  const who = providerName(provider);
  switch (health) {
    case "ready":
      return `${who} is ready.`;
    case "needs_sign_in":
      return `${who} needs you to sign in again on this computer.`;
    case "not_installed":
      return `${who} is not installed on this computer.`;
    case "api_key_auth":
      return `${who} is signed in with an API key; sign in with your subscription instead.`;
    case "usage_exhausted":
      return `${who} has reached its usage limit.`;
    default:
      return `${who} has not been checked recently. Open the ThreadLink app on this computer so it can check.`;
  }
}

/** "Claude Code — Needs sign-in · Codex — Ready" */
export function healthLine(entries: readonly ProviderHealthEntry[]): string {
  return entries
    .map((e) => `${providerName(e.provider)} — ${PROVIDER_HEALTH_LABELS[e.health]}`)
    .join(" · ");
}

/**
 * The whole refusal, for a controller or the composer:
 * "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer."
 */
export function healthMessage(entries: readonly ProviderHealthEntry[]): string {
  const failing = entries.filter((e) => e.health !== "ready");
  if (entries.length === 0 || failing.length === 0) {
    return "An agent this work needs isn't ready. Open the ThreadLink app on this computer to check.";
  }
  return `${healthLine(entries)}. ${failing.map((e) => healthSentence(e.provider, e.health)).join(" ")}`;
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Parses the database's machine-readable DETAIL ("claude-code=needs_sign_in,codex=ready").
 * Anything else is ignored (null): database text is never shown.
 */
export function parseHealthDetail(detail: unknown): ProviderHealthEntry[] | null {
  if (typeof detail !== "string" || detail.length === 0 || detail.length > 400) return null;
  const entries: ProviderHealthEntry[] = [];
  for (const part of detail.split(",")) {
    const [provider, health, extra] = part.split("=");
    if (extra !== undefined || !provider || !PROVIDER_ID.test(provider) || !isHealth(health)) {
      return null;
    }
    entries.push({ provider, health });
  }
  return entries.length > 0 && entries.length <= 10 ? entries : null;
}

export const healthEntriesSchema = z
  .array(
    z.object({
      provider: z.string().regex(PROVIDER_ID),
      health: z.enum(PROVIDER_HEALTH),
    }),
  )
  .max(10);

/**
 * The ONLY details a Runtime may attach to a health result: its fixed sentences
 * (runtime/src/team/health.ts HEALTH_DETAIL; same list as the SQL
 * provider_health_details()). Anything else is stored and shown as null.
 */
export const HEALTH_DETAILS: readonly string[] = [
  "Signed in and answering.",
  "Needs you to sign in again on this computer.",
  "Not installed on this computer.",
  "Signed in with an API key, which would bill per use. Sign in with your subscription.",
  "Usage limit reached.",
  "Not checked yet, or the check could not finish.",
];

/** A reported detail if it is one of the fixed sentences, else null. */
export function fixedHealthDetail(v: unknown): string | null {
  return typeof v === "string" && HEALTH_DETAILS.includes(v) ? v : null;
}
/** healthCheckedAt: an ISO-8601 timestamp (same rule as the SQL check). */
export const HEALTH_CHECKED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
