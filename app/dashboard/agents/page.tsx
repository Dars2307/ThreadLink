import type { Metadata } from "next";
import Link from "next/link";

import { changeLinkConversationAction, setLinkPausedAction } from "@/app/dashboard/actions";
import { removeConversationAction } from "@/app/dashboard/team-actions";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { ResetTime } from "@/components/dashboard/local-time";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { deriveAgents, type AgentCard } from "@/lib/dashboard/agents";
import { loadProviderRegistryRows } from "@/lib/dashboard/chats-data";
import { loadAccount, loadProviders, loadTeam } from "@/lib/dashboard/data";
import { buildRegistry } from "@/lib/dashboard/registry";
import { deriveConversations, EMPTY_TEAM } from "@/lib/dashboard/pages";
import { CONTROLLER_HINT } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Agents · ThreadLink" };

/**
 * Linked conversations, the background worker and headless sessions are how
 * the Claude Code bridge runs work; they are shown only inside that provider's
 * execution settings (brief §64), never as a global status.
 */
const SESSION_BRIDGE_PROVIDER = "claude-code";

function ProviderFacts({ a }: { a: AgentCard }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted">Status</dt>
      <dd>{a.freshness.text}</dd>
      <dt className="text-muted">Sign-in</dt>
      <dd>{a.signIn}</dd>
      {a.plan ? (
        <>
          <dt className="text-muted">Plan</dt>
          <dd>{a.plan}</dd>
        </>
      ) : null}
      <dt className="text-muted">Models</dt>
      <dd>{a.models}</dd>
      <dt className="text-muted">Native sessions</dt>
      <dd>{a.nativeSessions}</dd>
      <dt className="text-muted">Can do</dt>
      <dd>{a.capabilities}</dd>
    </dl>
  );
}

export default async function AgentsPage() {
  const [account, team, providers, registryRows] = await Promise.all([
    loadAccount(),
    loadTeam({ details: false }),
    loadProviders(),
    loadProviderRegistryRows(),
  ]);
  if (!account) return <LoadError what="your agents" />;
  const { view, handles } = deriveConversations(account, team ?? EMPTY_TEAM);
  const registry = buildRegistry(registryRows);
  const all = providers
    ? deriveAgents(providers.profiles, providers.now, registry).view.agents
    : null;
  const agents = all ? all.filter((a) => a.supported) : null;
  const future = all ? all.filter((a) => !a.supported) : [];

  return (
    <Shell>
      <PageHeader
        title="Agents"
        description="Your coding agents' control centre: whether each is ready, how it is signed in, its models and native sessions, and how it runs on your computer."
      />

      <section aria-labelledby="providers-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="providers-title" className="text-sm font-semibold">
            Providers
          </h2>
          <Link href="/dashboard/settings/providers" className="text-accent text-sm">
            Plans &amp; usage settings
          </Link>
        </div>
        {agents === null ? (
          <p className="text-muted text-sm">Provider details could not be loaded right now.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {agents.map((a) => (
              <Card key={a.key} as="article" labelledBy={`${a.key}-title`}>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id={`${a.key}-title`} className="text-base font-semibold tracking-tight">
                      {a.name}
                    </h3>
                    <Badge tone={a.freshness.tone}>{a.freshness.label}</Badge>
                  </div>
                  {a.callout ? (
                    <p
                      role="status"
                      className="border-warning/40 bg-warning-soft text-warning rounded-xl border px-3 py-2 text-sm"
                    >
                      {a.callout}
                    </p>
                  ) : null}
                  {a.usageExhausted ? (
                    <p className="text-muted text-sm">
                      Included usage is used up. <ResetTime at={a.usageResetsAt} />
                    </p>
                  ) : null}
                  <ProviderFacts a={a} />
                  <p className="text-subtle text-xs">{a.checked}</p>
                  <details className="border-border rounded-xl border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      Execution settings
                    </summary>
                    {a.id === SESSION_BRIDGE_PROVIDER ? (
                      <div className="flex flex-col gap-2 pt-2 text-sm">
                        <p className="text-muted text-xs">
                          How work reaches {a.name} on your computer. Chats run each step headless
                          in its own worktree unless a project uses a linked conversation.
                        </p>
                        <ul className="flex flex-col gap-2">
                          {view.modes.map((m) => (
                            <li key={m.key} className="flex flex-col gap-0.5">
                              <span
                                className={m.available ? "font-medium" : "text-muted font-medium"}
                              >
                                {m.label}
                                {m.available ? null : (
                                  <span className="text-subtle font-normal"> · not available</span>
                                )}
                              </span>
                              <span className="text-muted text-xs">{m.description}</span>
                            </li>
                          ))}
                        </ul>
                        <a href="#conversations-title" className="text-accent text-xs">
                          Linked {a.name} conversations ({view.conversations.length})
                        </a>
                      </div>
                    ) : (
                      <p className="text-muted pt-2 text-xs">
                        {a.name} runs each step as a fresh headless session in its own worktree on
                        your computer. Nothing to configure.
                      </p>
                    )}
                  </details>
                </div>
              </Card>
            ))}
          </div>
        )}
        {future.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Coming later</h3>
            <ul className="flex flex-wrap gap-2">
              {future.map((a) => (
                <li key={a.key}>
                  <Badge tone="neutral">{a.name} · Not supported yet</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-subtle text-xs">
          The computers that run your agents are under{" "}
          <Link href="/dashboard/devices" className="text-accent">
            Devices
          </Link>
          .
        </p>
      </section>

      <h2 id="conversations-title" className="scroll-mt-8 pt-2 text-sm font-semibold">
        Claude Code · linked conversations
      </h2>
      <p className="text-muted -mt-4 text-xs">
        Only needed when a project should continue one exact Claude Code conversation. Chats do not
        need one.
      </p>

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

      <Card labelledBy="chats-title">
        <CardTitle
          id="chats-title"
          description="Conversations in your controller app that can send work to ThreadLink."
        >
          Controller conversations
        </CardTitle>
        {view.chats.length === 0 ? (
          <EmptyState title="No controller conversations yet">
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
