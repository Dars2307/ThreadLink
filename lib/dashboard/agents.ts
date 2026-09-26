import { PROVIDER_HEALTH, type ProviderHealth } from "@/lib/chat/types";
import type { OwnerProviderProfile } from "@/lib/providers/queries";
import { AGENT_PROVIDERS, type AgentProvider } from "@/lib/team/model";

import type { Tone } from "./labels";
import { declaredPlanView, type PageModel } from "./pages";
import {
  healthCallout,
  healthText,
  healthTone,
  KNOWN_PROVIDER_IDS,
  providerDisplay,
} from "./providers-display";
import { relativeTime } from "./view-model";

/**
 * The Agents page: every provider ThreadLink knows, with its health, the plan
 * you chose and what it can do. Pure. Health comes only from the Runtime's
 * probe (a real authenticated call); "signed in" in a status report is never
 * taken as Ready (docs/design/chat-first.md §2).
 */

export type AgentCard = {
  key: string;
  name: string;
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

export function deriveAgents(profiles: OwnerProviderProfile[], now: number): PageModel<AgentsView> {
  const agents = KNOWN_PROVIDER_IDS.map((id, i): AgentCard => {
    const d = providerDisplay(id);
    const profile = profiles.find((p) => p.provider === id);
    const { health, checkedAt } = d.supported
      ? profileHealth(profile)
      : { health: "unknown" as const, checkedAt: null };
    const known = (AGENT_PROVIDERS as readonly string[]).includes(id);
    return {
      key: `a${i}`,
      name: d.name,
      supported: d.supported,
      health: d.supported
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
      capabilities: d.supported ? d.capabilities.join(" · ") : "Not supported yet",
    };
  });
  return { view: { agents }, handles: {} };
}
