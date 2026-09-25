import type { Metadata } from "next";

import { changeLinkConversationAction, setLinkPausedAction } from "@/app/dashboard/actions";
import { removeConversationAction } from "@/app/dashboard/team-actions";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount, loadTeam } from "@/lib/dashboard/data";
import { deriveConversations, EMPTY_TEAM } from "@/lib/dashboard/pages";
import { CONTROLLER_HINT } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Conversations · ThreadLink" };

export default async function ConversationsPage() {
  const [account, team] = await Promise.all([loadAccount(), loadTeam({ details: false })]);
  if (!account) return <LoadError what="your conversations" />;
  const { view, handles } = deriveConversations(account, team ?? EMPTY_TEAM);

  return (
    <Shell>
      <PageHeader
        title="Conversations"
        description="Your Claude Code conversations and the chats linked to them. Nothing is linked automatically."
      />

      {view.pending.length ? (
        <Card labelledBy="pending-title">
          <CardTitle
            id="pending-title"
            description="Approve these in the ThreadLink app on that computer."
          >
            Waiting for approval
          </CardTitle>
          <ul className="flex flex-col gap-2">
            {view.pending.map((p) => (
              <li
                key={p.key}
                className="border-border flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
              >
                <span>{p.text}</span>
                <span className="text-subtle text-xs">{p.when}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {view.conversations.length === 0 ? (
        <Card>
          <EmptyState title="No Claude conversations yet">
            Install the ThreadLink app on the computer where you use Claude Code, then choose a
            conversation there.
          </EmptyState>
        </Card>
      ) : null}

      {view.conversations.map((c) => {
        const sessionId = handles[c.key]!.sessionId!;
        return (
          <Card key={c.key} as="article" labelledBy={`${c.key}-title`}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={`${c.key}-title`} className="truncate text-base font-semibold">
                    {c.name}
                  </h2>
                  <p className="text-muted text-sm">
                    <span className="text-foreground font-medium">{c.mode}</span> · {c.modeDetail}
                  </p>
                  <p className="text-subtle flex flex-wrap gap-x-3 pt-1 text-xs">
                    {c.projects.length ? <span>Project: {c.projects.join(", ")}</span> : null}
                    {c.folder ? <span>Folder: {c.folder}</span> : null}
                    {c.device ? <span>Device: {c.device}</span> : null}
                    <span>{c.lastUsed}</span>
                  </p>
                </div>
                <Badge tone={c.tone}>{c.status}</Badge>
              </div>

              {c.chats.length ? (
                <ul className="flex flex-col gap-2">
                  {c.chats.map((chat) => {
                    const h = handles[chat.key]!;
                    return (
                      <li
                        key={chat.key}
                        className="bg-surface-muted/60 flex flex-col gap-3 rounded-xl p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="min-w-0 text-sm">
                            <span className="text-subtle text-xs">{chat.chatApp} · </span>
                            <span className="font-medium">{chat.chat}</span>
                          </p>
                          <Badge tone={chat.tone}>{chat.status}</Badge>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionForm action={setLinkPausedAction} className="flex flex-col gap-1">
                            <input type="hidden" name="linkId" value={h.linkId} />
                            <input
                              type="hidden"
                              name="paused"
                              value={chat.paused ? "false" : "true"}
                            />
                            <SubmitButton className={buttonStyles.ghost} pendingLabel="Working…">
                              {chat.paused ? "Resume" : "Pause"}
                            </SubmitButton>
                          </ActionForm>
                          {view.choices.length > 1 ? (
                            <details className="group">
                              <summary className={`${buttonStyles.ghost} cursor-pointer`}>
                                Use a different conversation
                              </summary>
                              <ActionForm
                                action={changeLinkConversationAction}
                                className="bg-surface mt-2 flex flex-wrap items-end gap-2 rounded-xl p-3"
                                statusClassName="w-full"
                              >
                                <input type="hidden" name="linkId" value={h.linkId} />
                                <input
                                  type="hidden"
                                  name="controllerSessionId"
                                  value={h.controllerSessionId}
                                />
                                <label className="flex flex-col gap-1 text-sm">
                                  <span className="text-subtle text-xs">Claude conversation</span>
                                  <select
                                    key={sessionId}
                                    name="agentSessionId"
                                    defaultValue={sessionId}
                                    className="border-border-strong bg-surface rounded-lg border px-3 py-2"
                                  >
                                    {view.choices.map((o) => (
                                      <option key={o.key} value={handles[o.key]!.sessionId}>
                                        {o.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <SubmitButton
                                  className={buttonStyles.primary}
                                  pendingLabel="Requesting…"
                                >
                                  Request change
                                </SubmitButton>
                                <p className="text-subtle w-full text-xs">
                                  The current link ends now; approve the new one in the ThreadLink
                                  app.
                                </p>
                              </ActionForm>
                            </details>
                          ) : null}
                          <RevokeLinkButton linkId={h.linkId!} label="Unlink" />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              <div className="border-border flex flex-wrap gap-2 border-t pt-3">
                <ConfirmAction
                  action={removeConversationAction}
                  fields={{ sessionId }}
                  label="Remove from ThreadLink"
                  title={`Remove “${c.name}” from ThreadLink?`}
                  confirmLabel="Remove from ThreadLink"
                >
                  <p>
                    This removes the conversation from ThreadLink and stops routing: its links end
                    and any work still waiting for it is cancelled.
                  </p>
                  <p className="text-foreground font-medium">
                    It does not delete your Claude or Codex conversation history.
                  </p>
                </ConfirmAction>
              </div>
            </div>
          </Card>
        );
      })}

      <Card labelledBy="modes-title">
        <CardTitle id="modes-title" description="How work reaches Claude Code on your computer.">
          Ways to run
        </CardTitle>
        <ul className="flex flex-col gap-2 text-sm">
          {view.modes.map((m) => (
            <li key={m.key} className="flex flex-col gap-0.5">
              <span className={m.available ? "font-medium" : "text-muted font-medium"}>
                {m.label}
                {m.available ? null : (
                  <span className="text-subtle font-normal"> · not available</span>
                )}
              </span>
              <span className="text-muted text-xs">{m.description}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card labelledBy="chats-title">
        <CardTitle id="chats-title" description="Chats that can send work to your conversations.">
          Your chats
        </CardTitle>
        {view.chats.length === 0 ? (
          <EmptyState title="No chats yet">
            Connect {CONTROLLER_HINT}, then start a conversation with ThreadLink enabled.
          </EmptyState>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {view.chats.map((s) => (
              <li
                key={s.key}
                className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{s.name}</span>
                <span className="text-subtle text-xs">
                  {s.app} · {s.lastUsed}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
