import { PROVIDER_HEALTH, type ProviderHealth } from "@/lib/chat/types";
import type { OwnerProviderProfile } from "@/lib/providers/queries";
import { AGENT_PROVIDERS, type AgentProvider } from "@/lib/team/model";

import { modelDisplayName, type Tone } from "./labels";
import { declaredPlanView, type PageModel } from "./pages";
import { healthCallout, healthText, healthTone, providerDisplay } from "./providers-display";
import { buildRegistry, type Registry } from "./registry";
import { healthFreshness, type Freshness } from "./timeline";
import { relativeTime } from "./view-model";

/**
 * The Agents page: every provider ThreadLink knows, with its health, the plan
 * you chose and what it can do. Pure. Health comes only from the Runtime's
 * probe (a real authenticated call); "signed in" in a status report is never
 * taken as Ready (docs/design/chat-first.md §2).
 */

export type AgentCard = {
  key: string;
  /** Provider id (used only to attach provider-specific execution settings on the Agents page). */
  id: string;
  name: string;
  /** 0.10: the one freshness rule ("Ready · checked 23 s ago" / "Stale · last checked 2 h ago"). */
  freshness: Freshness;
  /** How it is signed in, in words. */
  signIn: string;
  /** Models the ThreadLink app reported for it. */
  models: string;
  /** Whether it keeps a persistent native session ThreadLink can record. */
  nativeSessions: string;
  supported: boolean;
  health: { text: string; tone: Tone; line: string };
  checked: string;
  callout: string | null;
  plan: string | null;
  capabilities: string;
};

export type AgentsView = { agents: AgentCard[] };

const isHealth = (v: unknown): v is ProviderHealth =>
  typeof v === "string" && (PROVIDER_HEALTH as readonly string[]).includes(v);

/** What the Runtime last reported for a provider, conservatively. */
export function profileHealth(profile: OwnerProviderProfile | undefined): {
  health: ProviderHealth;
  checkedAt: string | null;
} {
  if (!profile) return { health: "unknown", checkedAt: null };
  const d = profile.detected as OwnerProviderProfile["detected"] & {
    health?: unknown;
    healthCheckedAt?: unknown;
  };
  const checkedAt = typeof d.healthCheckedAt === "string" ? d.healthCheckedAt : null;
  if (isHealth(d.health)) return { health: d.health, checkedAt };
  // Before the probe existed: only negative facts are trusted.
  if (d.installed === false) return { health: "not_installed", checkedAt: profile.detectedAt };
  if (d.authenticated === false) return { health: "needs_sign_in", checkedAt: profile.detectedAt };
  return { health: "unknown", checkedAt: null };
}

const SIGN_IN: Record<ProviderHealth, string> = {
  ready: "Signed in with your subscription",
  needs_sign_in: "Not signed in",
  not_installed: "Not installed",
  api_key_auth: "API key (would bill per use) — sign in with your subscription instead",
  usage_exhausted: "Subscription — usage limit reached",
  unknown: "Not checked yet",
};

function detectedModels(profile: OwnerProviderProfile | undefined): string {
  if (!profile) return "Reported after the first check";
  const d = profile.detected as OwnerProviderProfile["detected"] & { models?: unknown };
  const list = Array.isArray(d.models)
    ? d.models.filter((m): m is string => typeof m === "string").slice(0, 8)
    : [];
  const names = [...new Set([...(d.currentModel ? [d.currentModel] : []), ...list])].map((m) =>
    modelDisplayName(m),
  );
  return names.length ? names.join(" · ") : "Reported after the first check";
}

function nativeSessionText(profile: OwnerProviderProfile | undefined): string {
  const d = (profile?.detected ?? {}) as { capabilities?: unknown };
  const caps = (
    d.capabilities && typeof d.capabilities === "object" ? d.capabilities : {}
  ) as Record<string, unknown>;
  const native = caps.nativeSession ?? caps.nativeSessions;
  if (native === true) {
    return caps.resume === true
      ? "Keeps a native session per run; fix rounds can resume it"
      : "Keeps a native session per run";
  }
  if (native === false) return "Persistent native session: not exposed by this provider";
  return "Reported by the ThreadLink app after its next check";
}

export function deriveAgents(
  profiles: OwnerProviderProfile[],
  now: number,
  registry: Registry = buildRegistry(null),
): PageModel<AgentsView> {
  const agents = registry.entries.map((entry, i): AgentCard => {
    const id = entry.id;
    const d = { ...providerDisplay(id), name: entry.name, supported: entry.supported };
    const profile = profiles.find((p) => p.provider === id);
    const { health, checkedAt } = d.supported
      ? profileHealth(profile)
      : { health: "unknown" as const, checkedAt: null };
    const known = (AGENT_PROVIDERS as readonly string[]).includes(id);
    const fresh = d.supported
      ? healthFreshness(health, checkedAt, now)
      : ({
          state: "unknown",
          label: "Not supported yet",
          text: "Not supported yet",
          tone: "neutral",
        } as const);
    return {
      key: `a${i}`,
      id,
      name: d.name,
      freshness: fresh,
      signIn: d.supported ? SIGN_IN[health] : "—",
      models: d.supported ? detectedModels(profile) : "—",
      nativeSessions: d.supported ? nativeSessionText(profile) : "—",
      supported: d.supported,
      health:
        d.supported && fresh.state === "stale"
          ? { text: fresh.label, tone: fresh.tone, line: `${d.name} — ${fresh.text}` }
          : d.supported
            ? {
                text: healthText(health),
                tone: healthTone(health),
                line: `${d.name} — ${healthText(health)}`,
              }
            : { text: "Not supported yet", tone: "neutral", line: `${d.name} — Not supported yet` },
      checked: !d.supported
        ? "ThreadLink can't run it yet."
        : checkedAt
          ? `Checked ${relativeTime(checkedAt, now)} by the ThreadLink app`
          : "Not checked yet. Open the ThreadLink app on your computer.",
      callout: d.supported ? healthCallout(id, health) : null,
      plan:
        known && profile
          ? declaredPlanView(id as AgentProvider, profile.declaredPlan).label
          : known
            ? "Not set — choose your plan"
            : null,
      capabilities: d.supported
        ? d.capabilities.length
          ? d.capabilities.join(" · ")
          : "Plans · Builds · Reviews"
        : "Not supported yet",
    };
  });
  return { view: { agents }, handles: {} };
}
