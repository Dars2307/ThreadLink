import Link from "next/link";

import { Callout, ModeControl } from "@/components/dashboard/chats";
import { Badge, cx, type Tone } from "@/components/ui";
import { chatExportHref } from "@/lib/dashboard/chat";
import type { ChatHeader10 } from "@/lib/dashboard/chat-header";
import type { ModeControlView } from "@/lib/dashboard/chats";

const DOT: Record<string, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  neutral: "bg-subtle",
};

/**
 * Chat header: name, [TEAM ▾] mode control, project, execution host with
 * presence, agents with health freshness, export. Status is always text
 * (never colour alone).
 */
export function ChatHeaderBar({
  header,
  chatId,
  control,
  projectHref,
}: {
  header: ChatHeader10;
  chatId: string;
  control: ModeControlView;
  projectHref: string | null;
}) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words sm:text-2xl">
          {header.name}
        </h1>
        <ModeControl chatId={chatId} control={control} compact />
        {header.archived ? <Badge tone="neutral">Archived</Badge> : null}
        <details className="relative ml-auto">
          <summary className="text-muted hover:text-foreground cursor-pointer list-none rounded-lg px-2 py-1 text-xs">
            Export ▾
          </summary>
          <div className="border-border bg-surface shadow-card absolute right-0 z-30 mt-1 flex w-44 flex-col rounded-xl border p-1 text-sm">
            <a
              href={chatExportHref(chatId, "md")}
              className="hover:bg-surface-muted rounded-lg px-2 py-1.5"
            >
              Markdown (.md)
            </a>
            <a
              href={chatExportHref(chatId, "json")}
              className="hover:bg-surface-muted rounded-lg px-2 py-1.5"
            >
              JSON (.json)
            </a>
          </div>
        </details>
      </div>
      <p className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={cx(!header.project && "text-warning")}>
          {header.project && projectHref ? (
            <>
              Project:{" "}
              <Link href={projectHref} className="text-accent">
                {header.project}
              </Link>
            </>
          ) : (
            header.projectText
          )}
        </span>
        {header.host ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx("size-2 rounded-full", DOT[header.host.tone])} />
            {header.host.text}
          </span>
        ) : null}
      </p>
      {header.agents.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Agents in this chat">
          {header.agents.map((a) => (
            <li key={a.key}>
              <Badge tone={a.freshness.tone as Tone}>
                {a.name} · {a.freshness.text}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted text-sm">No agents in this chat yet.</p>
      )}
      {header.callouts.map((c) => (
        <Callout key={c.key} text={c.text} />
      ))}
    </header>
  );
}
