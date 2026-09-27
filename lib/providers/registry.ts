import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ProviderInfo } from "@/lib/chat/types";

/**
 * The provider registry (public.agent_providers, docs/design/threadlink-0.10.md
 * section 1): public metadata read through agent_providers_list(). The UI
 * renders providers from this, never from a per-provider switch.
 */

const rowSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  display_name: z.string().min(1).max(60),
  short_name: z.string().min(1).max(30),
  mention_aliases: z.array(z.string()).max(10),
  supported: z.boolean(),
});

export function toProviderInfo(r: z.infer<typeof rowSchema>): ProviderInfo {
  return {
    id: r.id,
    displayName: r.display_name,
    shortName: r.short_name,
    mentionAliases: r.mention_aliases,
    supported: r.supported,
  };
}

export async function listAgentProviders(db: SupabaseClient): Promise<ProviderInfo[]> {
  const { data, error } = await db.rpc("agent_providers_list");
  if (error) throw new Error("Failed to load providers");
  return z.array(rowSchema).max(100).parse(data).map(toProviderInfo);
}
