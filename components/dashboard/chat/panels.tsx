"use client";

import { Bot, Download, Paperclip, Wifi, type LucideIcon } from "lucide-react";
import { memo, useEffect, useState, type ReactNode } from "react";

import { cx } from "@/components/ui";
import { artifactHref, chatExportHref, chatPageUrl } from "@/lib/dashboard/chat";
import type { StatusLine } from "@/lib/dashboard/presence";
import type { Registry } from "@/lib/dashboard/registry";
import {
  activityRows,
  healthFreshness,
  parsePage,
  type TimelineEvent,
} from "@/lib/dashboard/timeline";
import {
  agentAvatar,
  agentShortName,
  resetTimeText,
  type PresenceTone,
} from "@/runtime/src/chat-presentation";

const DOT: Record<PresenceTone, string> = {
  success: "bg-success",
  accent: "bg-accent",
  warning: "bg-warning",
  neutral: "bg-subtle",
};

export function StatusDot({ tone, pulse = false }: { tone: PresenceTone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-2 shrink-0 rounded-full", DOT[tone], pulse && "tl-pulse")}
    />
  );
}

/** A status dot with a soft "ping" ring while something is live (compositor-only). */
export function PingDot({ tone, live }: { tone: PresenceTone; live: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-2 shrink-0">
      {live ? <span className={cx("tl-ping absolute inset-0 rounded-full", DOT[tone])} /> : null}
      <span className={cx("relative inline-flex size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

/** The drawer's section card (design canvas): icon + title, hairline border, card surface. */
export function DrawerCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-line-soft bg-card flex flex-col gap-2.5 rounded-xl border p-3.5">
      <h3 className="text-subtle flex items-center gap-2 text-xs font-semibold">
        <Icon aria-hidden className="size-3.5" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="flex min-w-0 items-center gap-2">{label}</span>
      <span className={cx("min-w-0 text-right", tone ?? "text-muted")}>{value}</span>
    </div>
  );
}

/** "You · Connected" → ["You", "Connected"]. */
function split(text: string): [string, string] {
  const i = text.indexOf(" · ");
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + 3)];
}

type ActivityLine = { key: string; at: string; text: string; who: string; runId: string | null };

/**
 * Activity: the orchestration rows the chat keeps quiet (§7) — loaded rows
 * plus the latest technical page, newest first. Fetched when opened.
 */
export const ActivityPanel = memo(function ActivityPanel({
  chatId,
  registry,
  events,
  onOpenRun,
}: {
  chatId: string;
  registry: Registry;
  events: TimelineEvent[];
  onOpenRun: (runId: string, who: string) => void;
}) {
  const [technical, setTechnical] = useState<ActivityLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(chatPageUrl(chatId, { limit: 200, technical: true }), {
      cache: "no-store",
      headers: { accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live) return;
        const page = parsePage(j);
        if (!page) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setTechnical(activityRows(page.events, registry));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [chatId, registry, tick]);

  const merged = new Map<string, ActivityLine>();
  for (const r of activityRows(events, registry)) merged.set(r.key, r);
  for (const r of technical ?? []) merged.set(r.key, r);
  const rows = [...merged.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 300);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted text-xs">What ThreadLink and the agents did behind the scenes.</p>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          className="text-accent shrink-0 text-xs"
        >
          Refresh
        </button>
      </div>
      {failed ? (
        <p role="status" className="text-muted text-xs">
          Could not load all activity right now.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted text-sm">{technical === null ? "Loading…" : "Nothing yet."}</p>
      ) : (
        <ol className="flex flex-col gap-1.5" aria-label="Activity">
          {rows.map((r) => (
            <li key={r.key} className="flex gap-2 text-xs">
              <time
                dateTime={r.at}
                suppressHydrationWarning
                className="text-subtle w-11 shrink-0 tabular-nums"
              >
                {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span className="min-w-0 flex-1 break-words">
                {r.who !== "ThreadLink" ? <span className="font-medium">{r.who}: </span> : null}
                <span className="text-muted">{r.text}</span>
                {r.runId ? (
                  <button
                    type="button"
                    onClick={() => onOpenRun(r.runId!, r.who)}
                    className="text-subtle hover:text-foreground pl-1"
                  >
                    Details
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

export type DrawerAgent = {
  provider: string;
  name: string;
  shortName: string | null;
  health: string | null;
  checkedAt: string | null;
  resetsAt: string | null;
};

export type DrawerArtifact = {
  artifactId: string;
  title: string;
  kind: string;
  size: string;
};

/**
 * Details (client half): You, the ThreadLink service and the execution host,
 * each on its own line (§4); the agents with health and usage reset time;
 * artifacts and export. The server half (models, runs, routing, ids) follows.
 */
export function DetailsPanel({
  chatId,
  you,
  service,
  host,
  hostOfflineNote,
  agents,
  artifacts,
  now,
  selected = null,
  children,
}: {
  chatId: string;
  you: { text: string; tone: PresenceTone };
  service: { text: string; tone: PresenceTone };
  host: StatusLine;
  hostOfflineNote: string | null;
  agents: DrawerAgent[];
  artifacts: DrawerArtifact[] | null;
  now: number;
  /** "This message" + "Where the time went" for the selected message, if any. */
  selected?: ReactNode;
  children?: ReactNode;
}) {
  const [youLabel, youValue] = split(you.text);
  const [serviceLabel, serviceValue] = split(service.text);
  const [hostLabel, hostValue] = split(host.text);
  return (
    <div className="flex flex-col gap-3.5">
      <DrawerCard icon={Wifi} title="Connection">
        <Row
          label={
            <>
              <StatusDot tone={you.tone} />
              {youLabel}
            </>
          }
          value={youValue === "Connected" ? "Connected · this browser" : youValue}
        />
        <Row
          label={
            <>
              <StatusDot tone={service.tone} />
              {serviceLabel}
            </>
          }
          value={serviceValue === "Reachable" ? "Connected" : serviceValue}
        />
        <Row
          label={
            <>
              <PingDot tone={host.tone} live={host.presence === "working"} />
              <span className="truncate">{hostLabel}</span>
            </>
          }
          value={hostValue}
        />
        {hostOfflineNote ? <p className="text-muted text-xs">{hostOfflineNote}</p> : null}
      </DrawerCard>

      <DrawerCard icon={Bot} title="Agents">
        {agents.length === 0 ? (
          <p className="text-muted text-sm">No agents in this chat yet.</p>
        ) : (
          agents.map((a) => {
            const f = healthFreshness(a.health, a.checkedAt, now);
            const exhausted = a.health === "usage_exhausted";
            const av = agentAvatar(a.provider, a.shortName);
            return (
              <Row
                key={a.provider}
                label={
                  <>
                    <span
                      aria-hidden
                      className={cx(
                        "flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
                        av.kind === "claude"
                          ? "bg-claude-bg text-claude-fg"
                          : av.kind === "codex"
                            ? "bg-codex-bg text-codex-fg"
                            : "bg-accent-soft text-accent",
                      )}
                    >
                      {av.initial}
                    </span>
                    <span className="truncate">{a.name}</span>
                  </>
                }
                tone={
                  f.state === "ready"
                    ? "text-success"
                    : f.state === "unknown"
                      ? "text-muted"
                      : "text-warning"
                }
                value={
                  exhausted ? (
                    <>
                      Usage exhausted
                      <br />
                      <span className="text-subtle text-[11px]" suppressHydrationWarning>
                        {resetTimeText(a.resetsAt, { now, locale: undefined })}
                      </span>
                    </>
                  ) : (
                    f.label
                  )
                }
              />
            );
          })
        )}
      </DrawerCard>

      {selected}

      {children}

      {artifacts ? (
        <DrawerCard icon={Paperclip} title={`Artifacts (${artifacts.length})`}>
          {artifacts.length === 0 ? (
            <p className="text-muted text-sm">
              Reports, plans, diffs and your attachments appear here.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {artifacts.map((a) => (
                <li key={a.artifactId} className="flex flex-col text-sm">
                  <a
                    href={artifactHref(chatId, a.artifactId)}
                    download
                    className="text-accent break-words"
                  >
                    {a.title}
                  </a>
                  <span className="text-subtle text-xs">
                    {a.kind}
                    {a.size ? ` · ${a.size}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DrawerCard>
      ) : null}

      <DrawerCard icon={Download} title="Export">
        <p className="flex gap-3 text-sm">
          <a href={chatExportHref(chatId, "md")} className="text-accent">
            Markdown (.md)
          </a>
          <a href={chatExportHref(chatId, "json")} className="text-accent">
            JSON (.json)
          </a>
        </p>
      </DrawerCard>
    </div>
  );
}

/** Short names for the header sub-line ("Claude · Codex"). */
export function agentNames(
  agents: readonly { provider: string; shortName: string | null }[],
): string[] {
  return [...new Set(agents.map((a) => agentShortName(a.provider, a.shortName)))];
}
