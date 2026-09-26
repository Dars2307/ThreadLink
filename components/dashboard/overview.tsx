import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, Card, CardTitle, EmptyState, type Tone } from "@/components/ui";
import type { deriveDashboard, LinkActivity, LinkCard } from "@/lib/dashboard/view-model";

type View = ReturnType<typeof deriveDashboard>;

const LINK_TONE: Record<LinkCard["status"], Tone> = {
  ready: "success",
  busy: "warning",
  paused: "neutral",
  offline: "warning",
};

export function ConnectedApps({ apps }: { apps: View["apps"] }) {
  return (
    <Card labelledBy="apps-title">
      <CardTitle
        id="apps-title"
        action={
          <Link href="/dashboard/settings/apps" className="text-accent text-sm">
            Manage
          </Link>
        }
      >
        Connected apps
      </CardTitle>
      <ul className="divide-border flex flex-col divide-y">
        {apps.map((app) => (
          <li
            key={app.platform}
            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <AppMark platform={app.platform} />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {app.label}
                  {app.count > 1 ? <span className="text-subtle"> · {app.count}</span> : null}
                </p>
                <p className="text-muted truncate text-xs">{app.detail}</p>
              </div>
            </div>
            <Badge tone={app.connected ? "success" : "neutral"}>
              {app.connected ? "Connected" : "Not connected"}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AppMark({ platform }: { platform: string }) {
  const letter = platform === "chatgpt" ? "G" : platform === "generic-mcp" ? "M" : "C";
  return (
    <span
      aria-hidden
      className="bg-surface-muted text-muted flex size-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
    >
      {letter}
    </span>
  );
}

/** One link: which chat, which Claude conversation, on which Runtime. */
export function LinkRow({ link, actions }: { link: LinkCard; actions?: ReactNode }) {
  return (
    <li className="border-border rounded-xl border p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-subtle text-xs">{link.chatApp}</p>
            <p className="truncate text-sm font-medium">{link.chat}</p>
          </div>
          <Badge tone={LINK_TONE[link.status]}>{link.statusLabel}</Badge>
        </div>
        <div aria-hidden className="text-subtle flex items-center gap-2 pl-1">
          <span className="text-lg leading-none">↕</span>
          <span className="bg-border h-px flex-1" />
        </div>
        <div className="min-w-0">
          <p className="text-subtle text-xs">
            Claude Code{link.workspace ? ` · ${link.workspace}` : ""}
            {link.runtime ? ` · ${link.runtime}` : ""}
          </p>
          <p className="truncate text-sm font-medium">{link.conversation}</p>
          <p className="text-muted text-xs">
            <span className="font-medium">{link.modeLabel}</span> · {link.conversationDetail}
          </p>
          {link.status === "offline" ? (
            <p className="text-warning pt-1 text-xs">
              Start the ThreadLink app on {link.runtime ?? "that computer"} to deliver requests.
            </p>
          ) : null}
          {/* Only an exact-conversation link is actually blocked by this. A
              background worker runs alongside the open conversation. */}
          {link.status === "busy" ? (
            <p className="text-warning pt-1 text-xs">
              That Claude conversation is open right now. Close it and send again, or switch this
              link to a background worker in the ThreadLink app.
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="border-border flex flex-wrap items-center gap-2 border-t pt-3">
            {actions}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function CurrentLinks({ links }: { links: View["links"] }) {
  return (
    <Card labelledBy="links-title">
      <CardTitle
        id="links-title"
        description="Say “send this to Claude” in a linked chat. The answer comes back there."
        action={
          <Link href="/dashboard/agents" className="text-accent text-sm">
            Manage
          </Link>
        }
      >
        Linked conversations
      </CardTitle>
      {links.length === 0 ? (
        <EmptyState title="Nothing is linked yet">
          Finish the setup steps to link a chat to a Claude conversation.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {links.slice(0, 3).map((link) => (
            <LinkRow key={link.linkId} link={link} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RecentActivity({
  activity,
  limit = 8,
}: {
  activity: View["activity"];
  limit?: number;
}) {
  return (
    <Card labelledBy="activity-title">
      <CardTitle
        id="activity-title"
        action={
          <Link href="/dashboard/tasks" className="text-accent text-sm">
            All activity
          </Link>
        }
      >
        Recent activity
      </CardTitle>
      {activity.length === 0 ? (
        <EmptyState title="Nothing sent yet">Requests you send to Claude appear here.</EmptyState>
      ) : (
        <ul className="divide-border flex flex-col divide-y">
          {activity.slice(0, limit).map((item) => (
            <li
              key={item.taskId}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-muted text-xs">
                  {item.route} · {item.when}
                </p>
              </div>
              <Badge tone={item.tone}>{item.statusLabel}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const MODE_TONE: Record<LinkActivity["mode"], Tone> = {
  worker: "accent",
  resume: "neutral",
  fresh: "neutral",
};

/**
 * Activity grouped by the Claude conversation it ran against. A background
 * worker runs out of sight, so its group still names the Claude conversation
 * and workspace it belongs to.
 */
export function ConversationActivity({
  groups,
  limit = 5,
}: {
  groups: View["linkActivity"];
  limit?: number;
}) {
  return (
    <Card labelledBy="link-activity-title">
      <CardTitle
        id="link-activity-title"
        description="What ran in each of your Claude conversations."
      >
        Activity by conversation
      </CardTitle>
      {groups.length === 0 ? (
        <EmptyState title="Nothing is linked yet">
          Link a chat to a Claude conversation to see its activity here.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4">
          {groups.map((group) => (
            <li key={group.linkId} className="border-border rounded-xl border p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-subtle text-xs">
                    {group.chatApp} · {group.chat}
                  </p>
                  <p className="truncate text-sm font-medium">{group.conversation}</p>
                  <p className="text-muted text-xs">{group.attribution}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={MODE_TONE[group.mode]}>{group.modeLabel}</Badge>
                  <Badge tone={LINK_TONE[group.status]}>{group.statusLabel}</Badge>
                </div>
              </div>
              {group.tasks.length === 0 ? (
                <p className="text-muted pt-3 text-xs">{group.emptyHint}</p>
              ) : (
                <>
                  <ul className="divide-border mt-3 flex flex-col divide-y border-t pt-1">
                    {group.tasks.slice(0, limit).map((task) => (
                      <li
                        key={task.taskId}
                        className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{task.title}</p>
                          <p className="text-muted text-xs">{task.when}</p>
                        </div>
                        <Badge tone={task.tone}>{task.statusLabel}</Badge>
                      </li>
                    ))}
                  </ul>
                  {group.taskCount > limit ? (
                    <p className="text-subtle pt-2 text-xs">
                      {group.taskCount - limit} more in this conversation
                    </p>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Runtime health summary for the Overview. */
export function RuntimeSummary({ runtimes }: { runtimes: View["runtimeTree"] }) {
  return (
    <Card labelledBy="runtimes-title">
      <CardTitle
        id="runtimes-title"
        description="Where your Claude conversations actually run."
        action={
          <Link href="/dashboard/devices" className="text-accent text-sm">
            Manage
          </Link>
        }
      >
        Runtimes
      </CardTitle>
      {runtimes.length === 0 ? (
        <EmptyState title="No Runtime yet">
          Install the ThreadLink app on the computer where you use Claude Code.
        </EmptyState>
      ) : (
        <ul className="divide-border flex flex-col divide-y">
          {runtimes.map((r) => (
            <li
              key={r.runtimeId}
              className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.label}</p>
                <p className="text-muted text-xs">
                  {r.workspaces.length} workspace{r.workspaces.length === 1 ? "" : "s"} ·{" "}
                  {r.online ? "online" : `last seen ${r.lastSeen}`}
                </p>
              </div>
              <Badge tone={r.paused ? "neutral" : r.online ? "success" : "warning"}>
                {r.paused ? "Paused" : r.online ? "Online" : "Offline"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
