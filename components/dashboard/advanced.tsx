import type { ReactNode } from "react";

import { RegisterConnectionForm } from "@/components/connections/register-connection-form";
import { RevokeConnectionButton } from "@/components/connections/revoke-connection-button";
import { RevokeLinkButton } from "@/components/connections/revoke-link-button";
import { CopyId } from "@/components/dashboard/copy-id";
import { Badge } from "@/components/ui";
import { PLATFORM_LABELS, type Connection } from "@/lib/connections/model";
import type { TeamData } from "@/lib/dashboard/pages";
import { bridgeOnline, relativeTime } from "@/lib/dashboard/view-model";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { runtimeOnline, type OwnerRuntime, type OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import type { RecentTask } from "@/lib/tasks/queries";

/**
 * Settings → Advanced → Technical details. The ONLY place raw ThreadLink
 * identifiers are rendered, each with a Copy button. Credentials appear only as
 * prefixes and dates; provider-native session ids stay masked.
 */
export function TechnicalDetails({
  userId,
  connections,
  sessions,
  links,
  tasks,
  runtimes,
  workspaces,
  team,
  now,
}: {
  userId: string;
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  tasks: RecentTask[];
  runtimes: OwnerRuntime[];
  workspaces: OwnerWorkspace[];
  team: TeamData | null;
  now: number;
}) {
  const date = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "—");
  return (
    <div className="flex flex-col gap-4">
      <Section title="Account">
        <Row label="ThreadLink user">
          <CopyId value={userId} label="ThreadLink user id" />
        </Row>
        <Row label="Identity provider">Clerk</Row>
      </Section>

      <Section title="Connections and credentials">
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <Item key={c.id}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {c.displayName ?? PLATFORM_LABELS[c.platform]}
                  <Badge tone={c.status === "revoked" ? "danger" : "neutral"}>
                    {PLATFORM_LABELS[c.platform]} · {c.role} · {c.status}
                  </Badge>
                </span>
                <CopyId value={c.id} label="connection id" />
                {c.credential ? (
                  <span className="text-muted text-xs">
                    Credential <span className="font-mono">{c.credential.tokenPrefix}…</span> ·
                    created {date(c.credential.createdAt)} · last used{" "}
                    {date(c.credential.lastUsedAt)}
                    {c.credential.revokedAt ? ` · revoked ${date(c.credential.revokedAt)}` : ""}
                  </span>
                ) : null}
                <span className="text-muted text-xs">
                  Last seen {relativeTime(c.lastSeenAt, now)}
                </span>
              </div>
              {c.status === "active" || c.status === "idle" ? (
                <RevokeConnectionButton connectionId={c.id} />
              ) : null}
            </Item>
          ))}
        </ul>
        <div className="pt-2">
          <p className="text-subtle pb-2 text-xs">
            Manual credential (fallback; the ThreadLink app normally signs in through the browser):
          </p>
          <RegisterConnectionForm />
        </div>
      </Section>

      <Section title="Sessions">
        {sessions.length === 0 ? <p className="text-muted text-sm">No sessions yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <Item key={s.sessionId}>
              <div className="flex min-w-0 flex-col gap-1">
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
                <CopyId value={s.sessionId} label="session id" />
                <span className="text-muted flex flex-wrap gap-x-3 text-xs">
                  <span>heartbeat {relativeTime(s.lastSeenAt, now)}</span>
                  {s.role === "agent" ? (
                    <span>
                      native: {s.nativeSessionMode}
                      {s.nativeSessionId ? (
                        <span className="font-mono"> · {s.nativeSessionId.slice(0, 8)}…</span>
                      ) : null}
                    </span>
                  ) : null}
                  {s.workspacePath ? <span className="break-all">{s.workspacePath}</span> : null}
                </span>
              </div>
            </Item>
          ))}
        </ul>
      </Section>

      <Section title="Links">
        {links.length === 0 ? <p className="text-muted text-sm">No links yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {links.map((l) => (
            <Item key={l.linkId}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <CopyId value={l.linkId} label="link id" />
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
                    {l.paused ? " · paused" : ""}
                  </Badge>
                </span>
                <span className="text-muted flex flex-wrap items-center gap-1 text-xs">
                  <CopyId value={l.controllerSessionId} label="controller session id" /> →
                  <CopyId value={l.agentSessionId} label="agent session id" />
                </span>
              </div>
              {l.status !== "revoked" ? <RevokeLinkButton linkId={l.linkId} /> : null}
            </Item>
          ))}
        </ul>
      </Section>

      <Section title="Recent tasks">
        {tasks.length === 0 ? <p className="text-muted text-sm">No tasks yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {tasks.map((t) => (
            <Item key={t.taskId}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-medium">{t.title}</span>
                <CopyId value={t.taskId} label="task id" />
                <span className="text-muted text-xs">
                  {t.status}
                  {t.failureReason ? ` · ${t.failureReason}` : ""} · priority {t.priority} · created{" "}
                  {relativeTime(t.createdAt, now)}
                </span>
              </div>
            </Item>
          ))}
        </ul>
      </Section>

      <Section title="Devices and folders">
        {runtimes.length === 0 ? <p className="text-muted text-sm">No devices.</p> : null}
        <ul className="flex flex-col gap-2">
          {runtimes.map((r) => (
            <Item key={r.runtimeId}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium">{r.label}</span>
                <CopyId value={r.runtimeId} label="device id" />
                <span className="text-muted text-xs">
                  {r.platform} · {r.kind} · v{r.version ?? "?"} · {r.status}
                  {r.paused ? " · paused" : ""} · heartbeat {relativeTime(r.lastSeenAt, now)} (
                  {runtimeOnline(r, now) ? "online" : "offline"})
                </span>
                <code className="text-muted font-mono text-xs break-all">
                  capabilities: {JSON.stringify(r.capabilities)}
                </code>
                <ul className="flex flex-col gap-1 pt-1">
                  {workspaces
                    .filter((w) => w.runtimeId === r.runtimeId)
                    .map((w) => (
                      <li key={w.workspaceId} className="text-muted flex flex-col gap-0.5 text-xs">
                        <CopyId value={w.workspaceId} label="workspace id" />
                        <span className="break-all">
                          {w.path}
                          {w.repoRemote ? ` · ${w.repoRemote}` : ""}
                          {w.branch ? `#${w.branch}` : ""}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </Item>
          ))}
        </ul>
      </Section>

      <Section title="Projects and team jobs">
        {team === null ? (
          <p className="text-muted text-sm">Could not load projects.</p>
        ) : team.rooms.length === 0 ? (
          <p className="text-muted text-sm">No projects.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {team.rooms.map((room) => (
              <Item key={room.roomId}>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">
                    {room.name} <span className="text-subtle font-normal">· {room.status}</span>
                  </span>
                  <CopyId value={room.roomId} label="project id" />
                  <ul className="flex flex-col gap-1 pt-1">
                    {(team.jobsByRoom[room.roomId] ?? []).slice(0, 10).map((j) => (
                      <li key={j.jobId} className="text-muted flex flex-col gap-0.5 text-xs">
                        <CopyId value={j.jobId} label="job id" />
                        <span>
                          {j.status}
                          {j.verdict ? ` · ${j.verdict}` : ""} · {j.goal.slice(0, 80)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Item>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-subtle text-xs">
        Masked for your safety: native provider session ids show only their first characters, and
        credentials only their prefix. Secrets are never shown.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-border bg-surface shadow-card flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="border-border flex flex-col gap-2 rounded-xl border p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      {children}
    </li>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
