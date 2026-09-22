import { z } from "zod";

import { idPattern } from "@/lib/ids";
import { sessionIdSchema } from "@/lib/sessions/model";

/**
 * ThreadLinks (tllnk_): one exact controller session paired with one exact
 * agent session. A routing relationship only: no conversation data.
 */

export const LINK_STATUSES = ["pending", "active", "revoked"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const LINK_REVOKED_REASONS = [
  "revoked_by_controller",
  "revoked_by_agent",
  "revoked_by_owner",
  "controller_session_ended",
  "agent_session_ended",
] as const;

export const linkIdSchema = z.string().regex(idPattern("threadLink"));

export const requestPairingInputSchema = z
  .object({ controllerSessionId: sessionIdSchema, agentSessionId: sessionIdSchema })
  .strict()
  .refine((v) => v.controllerSessionId !== v.agentSessionId, "sessions must differ");

/** `sessionId` is the caller's own session acting on the link (approver/revoker). */
export const linkActionInputSchema = z
  .object({ sessionId: sessionIdSchema, linkId: linkIdSchema })
  .strict();

export const linkRowSchema = z.object({
  id: linkIdSchema,
  controller_session_id: sessionIdSchema,
  agent_session_id: sessionIdSchema,
  controller_display_name: z.string().nullable().optional(),
  agent_display_name: z.string().nullable().optional(),
  status: z.enum(LINK_STATUSES),
  revoked_reason: z.enum(LINK_REVOKED_REASONS).nullable(),
  requested_at: z.string(),
  approved_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export type ThreadLinkView = {
  linkId: string;
  controllerSessionId: string;
  agentSessionId: string;
  controllerDisplayName: string | null;
  agentDisplayName: string | null;
  status: LinkStatus;
  revokedReason: (typeof LINK_REVOKED_REASONS)[number] | null;
  requestedAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
};

export function toThreadLinkView(row: z.infer<typeof linkRowSchema>): ThreadLinkView {
  return {
    linkId: row.id,
    controllerSessionId: row.controller_session_id,
    agentSessionId: row.agent_session_id,
    controllerDisplayName: row.controller_display_name ?? null,
    agentDisplayName: row.agent_display_name ?? null,
    status: row.status,
    revokedReason: row.revoked_reason,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
  };
}
