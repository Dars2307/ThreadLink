import { RegisterConnectionForm } from "@/components/connections/register-connection-form";
import { RevokeConnectionButton } from "@/components/connections/revoke-connection-button";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { Badge, Mono } from "@/components/ui";
import { PLATFORM_LABELS, type Connection } from "@/lib/connections/model";
import { bridgeOnline, relativeTime } from "@/lib/dashboard/view-model";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { maskIdentifier } from "@/lib/security/mask";
import type { OwnerSession } from "@/lib/sessions/queries";

/**
 * Technical details for debugging and revocation. Collapsed by default so the
 * main dashboard never shows raw identifiers. Native provider session IDs are
 * masked; credentials are only ever shown by prefix.
 */
export function AdvancedPanel({
  defaultOpen = false,
  userId,
  connections,
  sessions,
  links,
  now,
}: {
  defaultOpen?: boolean;
  userId: string;
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  now: number;
}) {
  return (
    <details
      open={defaultOpen}
      className="group border-border bg-surface shadow-card rounded-2xl border"
    >
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <span>
          <span className="block text-base font-semibold tracking-tight">Advanced</span>
          <span className="text-muted block text-sm">
            IDs, credentials, heartbeats and manual controls
          </span>
        </span>
        <span aria-hidden className="text-subtle transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="border-border flex flex-col gap-8 border-t px-5 py-5 sm:px-6">
        <Section title="Account">
          <Row label="ThreadLink user">
            <Mono>{maskIdentifier(userId, 6)}</Mono>
          </Row>
          <Row label="Identity provider">Clerk</Row>
        </Section>

        <Section title="Connections">
          <ul className="flex flex-col gap-2">
            {connections.map((c) => (
              <li
                key={c.id}
                className="border-border flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {c.displayName ?? PLATFORM_LABELS[c.platform]}
                    <Badge tone={c.status === "revoked" ? "danger" : "neutral"}>
                      {PLATFORM_LABELS[c.platform]} · {c.role} · {c.status}
                    </Badge>
                  </span>
                  <span className="text-muted flex flex-wrap gap-x-3 text-xs">
                    <Mono>{c.id}</Mono>
                    {c.credential ? (
                      <Mono title="Token fingerprint (prefix only)">
                        {c.credential.tokenPrefix}…
                      </Mono>
                    ) : null}
                    <span>last used {relativeTime(c.lastSeenAt, now)}</span>
                  </span>
                </div>
                {c.status === "active" || c.status === "idle" ? (
                  <RevokeConnectionButton connectionId={c.id} />
                ) : null}
              </li>
            ))}
          </ul>
          <div className="pt-2">
            <p className="text-subtle pb-2 text-xs">
              Manual credential (fallback; normally the bridge signs in through the browser):
            </p>
            <RegisterConnectionForm />
          </div>
        </Section>

        <Section title="Sessions">
          {sessions.length === 0 ? <p className="text-muted text-sm">No sessions yet.</p> : null}
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li
                key={s.sessionId}
                className="border-border flex flex-col gap-1 rounded-xl border p-3 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.displayName ?? "Unnamed session"}
                  <Badge tone="neutral">
                    {PLATFORM_LABELS[s.platform]} · {s.role} · {s.status}
                  </Badge>
                  {s.role === "agent" ? (
                    <Badge tone={bridgeOnline(s, now) ? "success" : "neutral"}>
                      {bridgeOnline(s, now) ? "online" : "offline"}
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted flex flex-wrap gap-x-3 text-xs">
                  <Mono>{s.sessionId}</Mono>
                  <span>last heartbeat {relativeTime(s.lastSeenAt, now)}</span>
                  {s.role === "agent" ? (
                    <span>
                      native: {s.nativeSessionMode}
                      {s.nativeSessionId ? (
                        <>
                          {" "}
                          · <Mono>{s.nativeSessionId.slice(0, 8)}…</Mono>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                  {s.workspacePath ? <span className="break-all">{s.workspacePath}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Links">
          {links.length === 0 ? <p className="text-muted text-sm">No links yet.</p> : null}
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li
                key={l.linkId}
                className="border-border flex flex-col gap-2 rounded-xl border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Mono>{l.linkId}</Mono>
                    <Badge
                      tone={
                        l.status === "active"
                          ? "success"
                          : l.status === "pending"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {l.status}
                    </Badge>
                  </span>
                  <span className="text-muted text-xs">
                    <Mono>{maskIdentifier(l.controllerSessionId, 6)}</Mono> →{" "}
                    <Mono>{maskIdentifier(l.agentSessionId, 6)}</Mono>
                  </span>
                </div>
                {l.status !== "revoked" ? <RevokeLinkButton linkId={l.linkId} /> : null}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}
