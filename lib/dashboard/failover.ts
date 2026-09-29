/**
 * 0.11 §5: what happens when an agent's included usage runs out. The owner's
 * preference, stored server-side (GET/PUT /api/dashboard/settings/failover).
 */

export const FAILOVER_URL = "/api/dashboard/settings/failover";

export const FAILOVER_POLICIES = ["auto", "ask", "wait"] as const;
export type FailoverPolicy = (typeof FAILOVER_POLICIES)[number];

export const FAILOVER_OPTIONS: readonly {
  value: FailoverPolicy;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    label: "Continue with another included agent",
    description:
      "Recommended. Work moves to another agent your plan already includes, and ThreadLink says so once. Independent review waits for the original agent.",
  },
  {
    value: "ask",
    label: "Ask me first",
    description: "Work pauses and the chat asks you what to do.",
  },
  {
    value: "wait",
    label: "Wait for the same agent",
    description: "Work waits until that agent's usage resets. You can still switch from the chat.",
  },
];

export const DEFAULT_FAILOVER: FailoverPolicy = "auto";

export function parseFailoverPolicy(v: unknown): FailoverPolicy | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const x = o ? (o.policy ?? o.failoverPolicy ?? o.failover_policy) : v;
  return typeof x === "string" && (FAILOVER_POLICIES as readonly string[]).includes(x)
    ? (x as FailoverPolicy)
    : null;
}
