import { z } from "zod";

import { AuthenticationRequiredError } from "@/lib/auth/resolve-identity";
import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { ThreadLinkUser } from "@/lib/auth/provision";
import { chatIdSchema } from "@/lib/chat/model";
import { getMyChat, listMyChatJobs } from "@/lib/chat/owner";
import { chatErrorResponse, chatFailure } from "@/lib/chat/route-helpers";
import {
  buildChatExport,
  CHAT_EXPORT_FORMATS,
  CHAT_EXPORT_MAX_MESSAGES,
  chatExportFileName,
  chatExportMarkdown,
  type ChatExportFormat,
} from "@/lib/export/chat-export";
import { createUserSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET ?format=md|json -> a download of one chat (owner Clerk session only).
 *
 * The user-scoped client keeps RLS enforcing, and every row is re-checked
 * against the signed-in owner. Visible messages only; no ids, cursors, native
 * session ids or secrets (bodies are redacted again on the way out).
 * Another account's chat answers exactly like a missing one (404).
 */

type Ctx = { params: Promise<{ chatId: string }> };

const PAGE = 1000;

const rowSchema = z.object({
  seq: z.coerce.number(),
  owner_user_id: z.string(),
  chat_id: z.string().nullable(),
  created_at: z.string(),
  author_label: z.string(),
  author_role: z.string().nullable(),
  event_type: z.string(),
  body: z.string(),
});

/** The chat's visible rows, newest CHAT_EXPORT_MAX_MESSAGES, oldest first. */
async function visibleRows(user: ThreadLinkUser, chatId: string) {
  const db = createUserSupabaseClient();
  const rows: z.infer<typeof rowSchema>[] = [];
  for (let from = 0; from < CHAT_EXPORT_MAX_MESSAGES + 1; from += PAGE) {
    const to = Math.min(from + PAGE, CHAT_EXPORT_MAX_MESSAGES + 1) - 1;
    const { data, error } = await db
      .from("chat_events")
      .select(
        "seq, owner_user_id, chat_id, created_at, author_label, author_role, event_type, body",
      )
      .eq("chat_id", chatId)
      .eq("visibility", "visible")
      .order("seq", { ascending: false })
      .range(from, to);
    if (error) throw new Error("Failed to load the chat");
    const page = z.array(rowSchema).parse(data);
    // Defence in depth: RLS already limits rows to the owner's own.
    if (page.some((r) => r.owner_user_id !== user.id || r.chat_id !== chatId)) {
      throw new Error("Chat export ownership check failed");
    }
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }
  const truncated = rows.length > CHAT_EXPORT_MAX_MESSAGES;
  return { rows: rows.slice(0, CHAT_EXPORT_MAX_MESSAGES).reverse(), truncated };
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  let user: ThreadLinkUser;
  try {
    user = await requireThreadLinkUser();
  } catch (error) {
    return chatFailure(
      error instanceof AuthenticationRequiredError ? "unauthenticated" : "unavailable",
    );
  }
  const chatId = chatIdSchema.safeParse((await ctx.params).chatId);
  if (!chatId.success) return chatFailure("chat_not_found");
  const format = new URL(request.url).searchParams.get("format") ?? "md";
  if (!(CHAT_EXPORT_FORMATS as readonly string[]).includes(format)) return chatFailure("invalid");

  try {
    const chat = await getMyChat(chatId.data);
    if (!chat) return chatFailure("chat_not_found");
    const [{ rows, truncated }, jobs] = await Promise.all([
      visibleRows(user, chatId.data),
      listMyChatJobs(chatId.data),
    ]);
    const exported = buildChatExport({
      exportedAt: new Date().toISOString(),
      chat: { name: chat.name, projectName: chat.projectName, mode: chat.mode },
      messages: rows.map((r) => ({
        at: r.created_at,
        from: r.author_label,
        role: r.author_role,
        kind: r.event_type,
        text: r.body,
      })),
      jobs: jobs.map((j) => ({
        goal: j.goal,
        mode: j.mode ?? null,
        status: j.statusLabel,
        verdict: j.verdict,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
      })),
      truncated,
    });
    const f = format as ChatExportFormat;
    const body =
      f === "json" ? `${JSON.stringify(exported, null, 2)}\n` : chatExportMarkdown(exported);
    return new Response(body, {
      headers: {
        "Content-Type":
          f === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${chatExportFileName(chat.name, f)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return chatErrorResponse(error, "chat export");
  }
}
