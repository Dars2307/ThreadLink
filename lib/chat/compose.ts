import { z } from "zod";

import { matchOpenChoices } from "./choice-intent";
import { classifyIntent } from "./intent";
import {
  CHOICE_KINDS,
  JOB_MODES,
  LANE_CHOICES,
  PROVIDER_HEALTH,
  type ChoiceForMatch,
  type ExecutionLane,
  type LaneChoice,
  type LaneReason,
} from "./types";

/**
 * 0.11 post planning shared by the owner (web), the Runtime credential
 * (desktop / terminal) and the controller (MCP) paths: classify the lane
 * (lib/chat/intent.ts) and, except for controllers, match a natural answer to
 * an open choice (lib/chat/choice-intent.ts). The database re-checks all of it.
 */

export const laneChoiceSchema = z.enum(LANE_CHOICES);

/** public.chat_compose_context / public.runtime_chat_compose_context. */
export const composeContextRowSchema = z.object({
  chat_id: z.string(),
  mode: z.enum(JOB_MODES),
  active_work_job: z.boolean(),
  fast_chat: z.boolean().optional(),
  choices: z
    .array(
      z.object({
        choice_id: z.string().regex(/^tlchc_[0-9a-f]{32}$/),
        kind: z.string(),
        options: z.array(z.object({ key: z.string(), label: z.string() })),
        provider: z.string().nullable().optional(),
        other_provider: z.string().nullable().optional(),
        provider_health: z.string().nullable().optional(),
      }),
    )
    .max(20),
});
export type ComposeContextRow = z.infer<typeof composeContextRowSchema>;

export function toChoicesForMatch(row: ComposeContextRow): ChoiceForMatch[] {
  const out: ChoiceForMatch[] = [];
  for (const c of row.choices) {
    if (!(CHOICE_KINDS as readonly string[]).includes(c.kind)) continue;
    out.push({
      choiceId: c.choice_id,
      kind: c.kind as ChoiceForMatch["kind"],
      options: c.options,
      provider: c.provider ?? null,
      otherProvider: c.other_provider ?? null,
      providerHealth: (PROVIDER_HEALTH as readonly string[]).includes(c.provider_health ?? "")
        ? (c.provider_health as ChoiceForMatch["providerHealth"])
        : null,
    });
  }
  return out;
}

export type PostPlan = {
  /** What to store (a leading /chat or /work removed). */
  body: string;
  lane: ExecutionLane;
  laneReason: LaneReason;
  smallTalk: boolean;
  /** A natural answer to an open choice (never for controllers, never an approval). */
  choice: { choiceId: string; key: string; label: string } | null;
};

export function planPost(input: {
  body: string;
  lane?: LaneChoice | null;
  context: ComposeContextRow;
  /** Controllers never answer choices. */
  allowChoiceAnswers: boolean;
}): PostPlan {
  const intent = classifyIntent({
    body: input.body,
    explicit: input.lane ?? null,
    activeWorkJob: input.context.active_work_job,
    mode: input.context.mode,
  });
  const choice = input.allowChoiceAnswers
    ? matchOpenChoices(intent.body, toChoicesForMatch(input.context))
    : null;
  return {
    body: intent.body,
    lane: intent.lane,
    laneReason: intent.reason,
    smallTalk: intent.smallTalk,
    choice,
  };
}
