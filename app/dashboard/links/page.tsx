import type { Metadata } from "next";

import { changeLinkConversationAction, setLinkPausedAction } from "@/app/dashboard/actions";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { LinkRow } from "@/components/dashboard/overview";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { buttonStyles, Card, CardTitle, EmptyState } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { conversationName, deriveDashboard } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Links · ThreadLink" };

export default async function LinksPage() {
  const account = await loadAccount();
  if (!account)
    return (
      <Shell>
        <Card>Could not load your links.</Card>
      </Shell>
    );
  const view = deriveDashboard(account);
  const conversations = view.agentSessions;

  return (
    <Shell>
      <PageHeader
        title="Links"
        description="Each link connects one chat to one Claude conversation. Nothing is linked automatically."
      />

      {view.pendingLinks.length ? (
        <Card labelledBy="pending-title">
          <CardTitle
            id="pending-title"
            description="Approve these in the ThreadLink app on that computer."
          >
            Waiting for approval
          </CardTitle>
          <ul className="flex flex-col gap-2">
            {view.pendingLinks.map((l) => (
              <li key={l.linkId} className="border-border rounded-xl border px-4 py-3 text-sm">
                {l.controllerDisplayName ?? "A chat"} →{" "}
                {conversationName(undefined, l.agentDisplayName)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card labelledBy="active-title">
        <CardTitle id="active-title">Active links</CardTitle>
        {view.links.length === 0 ? (
          <EmptyState title="No active links">
            In a linked chat say “Link this chat to Claude Code”, then approve it in the ThreadLink
            app.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-4">
            {view.links.map((link) => (
              <LinkRow
                key={link.linkId}
                link={link}
                actions={
                  <>
                    <form action={setLinkPausedAction}>
                      <input type="hidden" name="linkId" value={link.linkId} />
                      <input type="hidden" name="paused" value={link.paused ? "false" : "true"} />
                      <button type="submit" className={buttonStyles.ghost}>
                        {link.paused ? "Resume" : "Pause"}
                      </button>
                    </form>
                    <details className="group">
                      <summary className={`${buttonStyles.ghost} cursor-pointer`}>
                        Change Claude conversation
                      </summary>
                      <form
                        action={changeLinkConversationAction}
                        className="bg-surface-muted mt-2 flex flex-wrap items-end gap-2 rounded-xl p-3"
                      >
                        <input type="hidden" name="linkId" value={link.linkId} />
                        <input
                          type="hidden"
                          name="controllerSessionId"
                          value={link.controllerSessionId}
                        />
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-subtle text-xs">New conversation</span>
                          <select
                            name="agentSessionId"
                            className="border-border-strong bg-surface rounded-lg border px-3 py-2"
                          >
                            {conversations.map((s) => (
                              <option key={s.sessionId} value={s.sessionId}>
                                {conversationName(s, null)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" className={buttonStyles.primary}>
                          Request change
                        </button>
                        <p className="text-subtle w-full text-xs">
                          The current link ends now; approve the new one in the ThreadLink app.
                        </p>
                      </form>
                    </details>
                    <RevokeLinkButton linkId={link.linkId} label="Unlink" />
                  </>
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
