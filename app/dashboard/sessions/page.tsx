import type { Metadata } from "next";

import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDashboard } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Conversations · ThreadLink" };

/** Claude conversations, grouped by the Runtime and workspace they live in. */
export default async function ConversationsPage() {
  const account = await loadAccount();
  if (!account) {
    return (
      <Shell>
        <Card>Could not load conversations.</Card>
      </Shell>
    );
  }
  const view = deriveDashboard(account);
  const chats = view.controllerSessions;

  return (
    <Shell>
      <PageHeader
        title="Conversations"
        description="Your Claude Code conversations, and where each one runs. Attach or change them in the ThreadLink app."
      />

      {view.runtimeTree.length === 0 ? (
        <Card>
          <EmptyState title="No Claude conversations yet">
            Install the ThreadLink app on the computer where you use Claude Code, then choose a
            conversation.
          </EmptyState>
        </Card>
      ) : null}

      {view.runtimeTree.map((runtime) => (
        <Card key={runtime.runtimeId} labelledBy={`rt-${runtime.runtimeId}`}>
          <CardTitle
            id={`rt-${runtime.runtimeId}`}
            description={runtime.online ? "Online" : `Last seen ${runtime.lastSeen}`}
            action={
              <Badge tone={runtime.paused ? "neutral" : runtime.online ? "success" : "warning"}>
                {runtime.paused ? "Paused" : runtime.online ? "Online" : "Offline"}
              </Badge>
            }
          >
            {runtime.label}
          </CardTitle>
          {runtime.workspaces.length === 0 ? (
            <EmptyState title="No workspaces yet">
              Open a project folder in the ThreadLink app.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              {runtime.workspaces.map((ws) => (
                <section key={ws.workspaceId} className="border-border rounded-xl border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium">{ws.name}</h3>
                    <p className="text-subtle text-xs">
                      {ws.repoRemote
                        ? `${ws.repoRemote}${ws.branch ? ` · ${ws.branch}` : ""}`
                        : (ws.path ?? "")}
                    </p>
                  </div>
                  {ws.conversations.length === 0 ? (
                    <p className="text-muted pt-2 text-sm">
                      No conversation attached in this folder yet.
                    </p>
                  ) : (
                    <ul className="divide-border flex flex-col divide-y pt-2">
                      {ws.conversations.map((c) => (
                        <li
                          key={c.sessionId}
                          className="flex flex-wrap items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{c.name}</p>
                            <p className="text-muted text-xs">{c.detail}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {c.linked ? <Badge tone="accent">Linked</Badge> : null}
                            <Badge tone={c.busy ? "warning" : "success"}>
                              {c.busy ? "In use" : "Available"}
                            </Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </Card>
      ))}

      <Card labelledBy="chats-title">
        <CardTitle id="chats-title" description="Chats that can send work to Claude.">
          Your chats
        </CardTitle>
        {chats.length === 0 ? (
          <EmptyState title="No chats yet">
            Connect ChatGPT, then start a conversation with ThreadLink enabled.
          </EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {chats.map((s) => (
              <li
                key={s.sessionId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="truncate">{s.displayName ?? "Conversation"}</span>
                <span className="text-subtle text-xs">
                  {s.platform === "chatgpt" ? "ChatGPT" : "Claude"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
