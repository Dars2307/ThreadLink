import type { ParticipantView, ProviderHealth } from "@/lib/chat/types";

import { humanize, modelDisplayName, type Tone } from "./labels";

/**
 * How any provider is shown. The UI renders this metadata instead of
 * switching on provider ids, so a provider ThreadLink has never heard of
 * ("gemini-cli") still renders, with a generic fallback. Pure.
 */

export type ProviderDisplay = {
  id: string;
  name: string;
  shortName: string;
  tone: Tone;
  /** The terminal command that signs this provider in again, when known. */
  signInCommand: string | null;
  /** False for providers the data model allows but ThreadLink does not run yet. */
  supported: boolean;
  /** What it can do, in words, for the Agents page. */
  capabilities: string[];
};

const REGISTRY: Readonly<Record<string, Omit<ProviderDisplay, "id">>> = {
  "claude-code": {
    name: "Claude Code",
    shortName: "Claude",
    tone: "accent",
    signInCommand: "claude",
    supported: true,
    capabilities: ["Plans", "Builds", "Reviews", "Integrates"],
  },
  codex: {
    name: "Codex",
    shortName: "Codex",
    tone: "success",
    signInCommand: "codex login",
    supported: true,
    capabilities: ["Plans", "Builds", "Reviews", "Integrates"],
  },
  cursor: {
    name: "Cursor",
    shortName: "Cursor",
    tone: "neutral",
    signInCommand: null,
    supported: false,
    capabilities: [],
  },
};

/** Old short spellings the server has used for the same providers. */
const ALIASES: Readonly<Record<string, string>> = { claude: "claude-code" };

/** Every provider ThreadLink can show on the Agents page, in display order. */
export const KNOWN_PROVIDER_IDS = Object.keys(REGISTRY);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * Display metadata for a provider id. Unknown ids get a generic entry built
 * from the id itself (or the server-provided name), never a crash and never
 * another provider's name.
 */
export function providerDisplay(
  id: string | null | undefined,
  fallbackName?: string | null,
): ProviderDisplay {
  const raw = (id ?? "").trim().toLowerCase();
  const key = ALIASES[raw] ?? raw;
  const known = Object.hasOwn(REGISTRY, key) ? REGISTRY[key] : undefined;
  if (known) return { id: key, ...known };
  const name =
    (fallbackName && fallbackName.trim().slice(0, 40)) ||
    (SAFE_ID.test(key) ? humanize(key.replace(/[._-]+/g, " ")) : "Agent");
  return {
    id: SAFE_ID.test(key) ? key : "agent",
    name,
    shortName: name,
    tone: "neutral",
    signInCommand: null,
    supported: false,
    capabilities: [],
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Fixed user text per health value (docs/design/chat-first.md §2). */
export const HEALTH_TEXT: Readonly<Record<ProviderHealth, string>> = {
  ready: "Ready",
  needs_sign_in: "Needs sign-in",
  not_installed: "Not installed",
  api_key_auth: "Uses an API key — sign in with your subscription",
  usage_exhausted: "Usage limit reached",
  unknown: "Not checked yet",
};

export const HEALTH_TONE: Readonly<Record<ProviderHealth, Tone>> = {
  ready: "success",
  needs_sign_in: "warning",
  not_installed: "neutral",
  api_key_auth: "warning",
  usage_exhausted: "warning",
  unknown: "neutral",
};

export function healthText(health: ProviderHealth | null | undefined): string {
  return health && Object.hasOwn(HEALTH_TEXT, health) ? HEALTH_TEXT[health] : HEALTH_TEXT.unknown;
}

export function healthTone(health: ProviderHealth | null | undefined): Tone {
  return health && Object.hasOwn(HEALTH_TONE, health) ? HEALTH_TONE[health] : "neutral";
}

/** "Claude Code — Needs sign-in". */
export function healthLine(provider: string, health: ProviderHealth | null | undefined): string {
  return `${providerDisplay(provider).name} — ${healthText(health)}`;
}

/**
 * What to do when a provider needs attention, in fixed words. Built from the
 * provider id and the health value only; never from provider output.
 */
export function healthCallout(
  provider: string,
  health: ProviderHealth | null | undefined,
): string | null {
  const p = providerDisplay(provider);
  switch (health) {
    case "needs_sign_in":
      return p.signInCommand
        ? `${p.name} needs you to sign in again on this computer. Open a terminal and run \`${p.signInCommand}\`, then press Check again on the ThreadLink app.`
        : `${p.name} needs you to sign in again on this computer. Sign in to it again, then press Check again on the ThreadLink app.`;
    case "api_key_auth":
      return `${p.name} is signed in with an API key, which would bill per use. Sign in with your subscription instead, then press Check again on the ThreadLink app.`;
    case "usage_exhausted":
      return `${p.name} has reached its usage limit. ThreadLink will not buy more; try again when your plan resets.`;
    case "not_installed":
      return `${p.name} is not installed on this computer.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export type ParticipantLine = {
  key: string;
  name: string;
  shortName: string;
  tone: Tone;
  kind: ParticipantView["kind"];
  /** Agents only. */
  health: { text: string; tone: Tone; line: string } | null;
};

/** Participants as the UI shows them. Agents take their names from the registry. */
export function participantLines(participants: ParticipantView[]): ParticipantLine[] {
  return participants.map((p, i) => {
    if (p.kind === "agent") {
      const d = providerDisplay(p.provider, p.name);
      return {
        key: `pt${i}`,
        name: d.name,
        shortName: d.shortName,
        tone: d.tone,
        kind: p.kind,
        health: {
          text: healthText(p.health),
          tone: healthTone(p.health),
          line: `${d.name} — ${healthText(p.health)}`,
        },
      };
    }
    const name = (p.name || (p.kind === "owner" ? "You" : "Controller")).slice(0, 40);
    return {
      key: `pt${i}`,
      name,
      shortName: (p.shortName || name).slice(0, 40),
      tone: "neutral",
      kind: p.kind,
      health: null,
    };
  });
}

/** "Claude Code + Codex" (agents only), or a plain fallback. */
export function participantsText(participants: ParticipantView[]): string {
  const agents = participantLines(participants.filter((p) => p.kind === "agent"));
  const names = [...new Set(agents.map((a) => a.name))];
  return names.length ? names.join(" + ") : "No agents yet";
}

/** Agent participants that need the user (anything not ready or unknown). */
export function unhealthyAgents(
  participants: ParticipantView[],
): { provider: string; name: string; health: ProviderHealth; callout: string | null }[] {
  return participants
    .filter((p) => p.kind === "agent" && p.health && p.health !== "ready" && p.health !== "unknown")
    .map((p) => {
      const d = providerDisplay(p.provider, p.name);
      return {
        provider: d.id,
        name: d.name,
        health: p.health!,
        callout: healthCallout(d.id, p.health),
      };
    });
}

// ---------------------------------------------------------------------------
// Models in chat headers
// ---------------------------------------------------------------------------

/**
 * The model as a short name for a bubble header: "Sonnet 5", "GPT-6 Sol".
 * The provider name is already beside it, so a leading "Claude " is dropped.
 */
export function shortModelName(id: string | null | undefined): string | null {
  if (!id) return null;
  const full = modelDisplayName(id);
  return full.replace(/^Claude\s+/, "");
}
