import {
  hostOfflineNote,
  hostPresence,
  hostPresenceLabel,
  parsePresence,
  resetsAtOf,
  serviceLabel,
  youPresence,
  youPresenceLabel,
  type Presence,
  type PresenceTone,
} from "@/runtime/src/chat-presentation";

/**
 * 0.11 presence for the web chat (§4). Three separate things: You (this
 * browser's own requests), the ThreadLink service, and the execution host.
 * Pure; parsing is defensive against both the 0.10 and 0.11 host status.
 */

export type ChatHost = {
  label: string | null;
  /** Server presence v2 (online/working/reconnecting/offline), or null from an older server. */
  presence: Presence | null;
  /** 0.10 compatibility: true online/working, false offline, null unknown. */
  online: boolean | null;
  lastSeenAt: string | null;
  /** The server clock when it judged presence (ISO). */
  serverNow: string | null;
  working: boolean;
  protocolOutdated: boolean;
};

export type HostAgent = {
  health: string;
  checkedAt: string | null;
  /** usage_exhausted only, when the provider reported it. */
  resetsAt: string | null;
  name: string | null;
};

export type HostStatus = {
  host: ChatHost | null;
  /** provider id → health, check time and (usage_exhausted) reset time. */
  agents: Record<string, HostAgent>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The host status from getMyHostStatus or the activity route's `host`. Null when unusable. */
export function parseHostStatus(raw: unknown): HostStatus | null {
  const r = rec(raw);
  if (!r) return null;
  const rt = rec(r.runtime);
  const presence = rt ? parsePresence(rt.presence) : null;
  const label = rt ? str(rt.label) : null;
  const host: ChatHost | null =
    rt && label
      ? {
          label: label.slice(0, 60),
          presence,
          online:
            presence === "online" || presence === "working"
              ? true
              : presence === "offline"
                ? false
                : null,
          lastSeenAt: str(rt.lastSeenAt) ?? str(rt.last_seen_at),
          serverNow: str(r.serverNow) ?? str(r.server_now) ?? str(r.now),
          working: presence === "working",
          protocolOutdated: rt.needsUpdate === true,
        }
      : null;
  const agents: Record<string, HostAgent> = {};
  for (const a of Array.isArray(r.agents) ? r.agents : []) {
    const x = rec(a);
    if (!x) continue;
    const provider = str(x.provider);
    const health = str(x.health);
    if (!provider || !health) continue;
    agents[provider] = {
      health,
      checkedAt: str(x.checkedAt),
      resetsAt: health === "usage_exhausted" ? resetsAtOf(x) : null,
      name: str(x.name),
    };
  }
  return { host, agents };
}

export type StatusLine = {
  presence: Presence | null;
  /** "Nickron PC · Working" / "No computer connected". */
  text: string;
  tone: PresenceTone;
  /** The §4 offline sentence, only while the host is offline. */
  offlineNote: string | null;
};

/**
 * The header status line: the execution HOST, never the viewer. Fresh live
 * activity (< 3 min) or a server "working" means Working — never "Offline"
 * beside it.
 */
export function headerStatus(input: {
  host: ChatHost | null;
  now: number;
  /** Newest live-activity time in this chat (ISO), if any. */
  lastLiveAt: string | null;
}): StatusLine {
  if (!input.host) {
    return {
      presence: null,
      text: "No computer connected",
      tone: "neutral",
      offlineNote: null,
    };
  }
  const presence = hostPresence({
    presence: input.host.presence ?? (input.host.working ? "working" : null),
    lastSeenAt: input.host.lastSeenAt,
    serverNow: input.host.serverNow,
    now: input.now,
    lastActivityAt: input.lastLiveAt,
  });
  // An old server without presence v2 but with online=true: trust it.
  const p =
    input.host.presence === null && input.host.online === true && presence !== "working"
      ? "online"
      : presence;
  const view = hostPresenceLabel(input.host.label, p);
  return {
    presence: p,
    text: view.text,
    tone: view.tone,
    offlineNote: hostOfflineNote(input.host.label, p),
  };
}

/** Details drawer: You, ThreadLink service (from this browser's own requests). */
export function clientLines(input: { failures: number; browserOnline: boolean }): {
  you: { text: string; tone: PresenceTone };
  service: { text: string; tone: PresenceTone };
} {
  const state = youPresence({
    consecutiveFailures: input.failures,
    browserOnline: input.browserOnline,
  });
  return {
    you: youPresenceLabel(state),
    service: serviceLabel({
      consecutiveFailures: input.failures,
      browserOnline: input.browserOnline,
    }),
  };
}

/** The newest live-activity time among live runs (ISO), or null. */
export function newestLiveAt(
  live: readonly { lastActivityAt: string | null; startedAt: string | null }[],
): string | null {
  let best = NaN;
  let iso: string | null = null;
  for (const l of live) {
    const v = l.lastActivityAt ?? l.startedAt;
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && !(t <= best)) {
      best = t;
      iso = v;
    }
  }
  return iso;
}
