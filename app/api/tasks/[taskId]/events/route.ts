import "server-only";

import { z } from "zod";

import { handleClientRequest, readJsonBody } from "@/lib/client-api/handler";
import { ClientOperationError } from "@/lib/client-api/operations";
import { createPrivilegedSupabaseClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const eventBodySchema = z
  .object({
    speaker: z.enum(["user", "chatgpt", "claude_code", "system"]),
    event_type: z.string().min(1).max(80),
    content: z.string().max(4096).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Runtime: append one lifecycle event to a task the connection owns. */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/tasks/[taskId]/events">,
): Promise<Response> {
  return handleClientRequest(request, async ({ identity }) => {
    const taskId = (await ctx.params).taskId;
    const raw = await readJsonBody(request);
    const parsed = eventBodySchema.safeParse(raw);
    if (!parsed.success) throw new ClientOperationError("invalid");

    const admin = createPrivilegedSupabaseClient();

    // Verify the task exists and belongs to this connection's owner before
    // inserting. Using the privileged client but scoping by ownerUserId
    // (derived from the verified credential, never supplied by the caller).
    const { data: task } = await admin
      .from("tasks")
      .select("id")
      .eq("id", taskId)
      .eq("owner_user_id", identity.ownerUserId)
      .maybeSingle();
    if (!task) throw new ClientOperationError("not_found");

    const { error } = await admin.from("task_events").insert({
      task_id: taskId,
      owner_user_id: identity.ownerUserId,
      speaker: parsed.data.speaker,
      event_type: parsed.data.event_type,
      content: parsed.data.content ?? null,
      payload: parsed.data.payload ?? null,
    });
    if (error) throw new ClientOperationError("unavailable");

    return { ok: true };
  });
}
