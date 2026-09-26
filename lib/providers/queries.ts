import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ThreadLinkUser } from "@/lib/auth/provision";
import { OwnershipViolationError } from "@/lib/connections/model";
import {
  effectiveHealth,
  fixedHealthDetail,
  PROVIDER_HEALTH_LABELS,
  type ProviderHealth,
} from "@/lib/providers/health";
import {
  AGENT_PROVIDERS,
  CHATGPT_PLANS,
  CLAUDE_PLANS,
  USAGE_POLICIES,
  type AgentProvider,
  type UsagePolicy,
} from "@/lib/team/model";

/**
 * Owner (dashboard) provider profiles: declared plan, usage policy and paid
 * usage. Paid usage is OFF by default and this module is the only path that
 * can switch it on, and only through an explicit `paidUsageEnabled` value from
 * the signed-in owner. Profiles hold no email, org id, token or key.
 */

export const setProviderProfileInputSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("claude-code"),
      declaredPlan: z.enum(CLAUDE_PLANS).optional(),
      usagePolicy: z.enum(USAGE_POLICIES).optional(),
      paidUsageEnabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("codex"),
      declaredPlan: z.enum(CHATGPT_PLANS).optional(),
      usagePolicy: z.enum(USAGE_POLICIES).optional(),
      paidUsageEnabled: z.boolean().optional(),
    })
    .strict(),
]);

const profileRow = z.object({
  provider: z.enum(AGENT_PROVIDERS),
  declared_plan: z.string(),
  usage_policy: z.enum(USAGE_POLICIES),
  paid_usage_enabled: z.boolean(),
  detected: z.record(z.string(), z.unknown()),
  detected_at: z.string().nullable(),
});

export type OwnerProviderProfile = {
  provider: AgentProvider;
  providerName: string;
  declaredPlan: string;
  usagePolicy: UsagePolicy;
  paidUsageEnabled: boolean;
  detected: {
    installed: boolean | null;
    authenticated: boolean | null;
    version: string | null;
    plan: string | null;
    currentModel: string | null;
    /** 0.9: the health that counts now (fresh, authenticated, subscription). */
    health?: ProviderHealth;
    /** "Needs sign-in" etc. */
    healthLabel?: string;
    /** When the Runtime last really checked (null: never). */
    healthCheckedAt?: string | null;
    /** The Runtime's fixed sentence about that check, if any. */
    healthDetail?: string | null;
  };
  detectedAt: string | null;
};

const NAMES: Record<AgentProvider, string> = { "claude-code": "Claude Code", codex: "Codex" };

function toOwnerProfile(r: z.infer<typeof profileRow>): OwnerProviderProfile {
  const d = r.detected;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const health = effectiveHealth(r.provider, d, r.detected_at);
  return {
    provider: r.provider,
    providerName: NAMES[r.provider],
    declaredPlan: r.declared_plan,
    usagePolicy: r.usage_policy,
    paidUsageEnabled: r.paid_usage_enabled,
    detected: {
      installed: bool(d.installed),
      authenticated: bool(d.authenticated),
      version: str(d.version),
      plan: str(d.detectedPlan),
      currentModel: str(d.currentModel),
      health,
      healthLabel: PROVIDER_HEALTH_LABELS[health],
      healthCheckedAt: str(d.healthCheckedAt),
      healthDetail: fixedHealthDetail(d.healthDetail),
    },
    detectedAt: r.detected_at,
  };
}

export async function setProviderProfileAs(
  db: SupabaseClient,
  rawInput: unknown,
): Promise<OwnerProviderProfile> {
  const input = setProviderProfileInputSchema.parse(rawInput);
  const { data, error } = await db.rpc("set_provider_profile", {
    p_provider: input.provider,
    p_declared_plan: input.declaredPlan ?? null,
    p_usage_policy: input.usagePolicy ?? null,
    // Only an explicit boolean from the owner changes paid usage.
    p_paid_usage_enabled: input.paidUsageEnabled ?? null,
  });
  if (error) throw new Error("Failed to update the provider profile");
  return toOwnerProfile(profileRow.parse(data));
}

/** Both providers, with defaults for a provider the owner never configured. */
export async function listProviderProfilesFor(
  db: SupabaseClient,
  user: ThreadLinkUser,
): Promise<OwnerProviderProfile[]> {
  const { data, error } = await db
    .from("provider_profiles")
    .select(
      "owner_user_id, provider, declared_plan, usage_policy, paid_usage_enabled, detected, detected_at",
    )
    .limit(10);
  if (error) throw new Error("Failed to load provider profiles");
  const rows = z.array(profileRow.extend({ owner_user_id: z.string() })).parse(data);
  if (rows.some((r) => r.owner_user_id !== user.id)) throw new OwnershipViolationError();
  return AGENT_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return toOwnerProfile(
      row ?? {
        provider,
        declared_plan: "unknown",
        usage_policy: "balanced",
        paid_usage_enabled: false,
        detected: {},
        detected_at: null,
      },
    );
  });
}
