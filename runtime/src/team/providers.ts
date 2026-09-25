/**
 * Provider adapters: what each coding agent can do, whether it is usable on
 * this computer, and how ThreadLink runs it.
 *
 * The orchestrator never names a CLI. It is handed runners keyed by provider,
 * and those come from here. A future provider (Cursor, say) is added as one
 * more entry with a `createRunner`, plus its id in AGENT_PROVIDERS once the
 * server and its prompts accept it -- the orchestrator does not change.
 *
 * Cursor is listed today as DETECT-ONLY. If its CLI is found it is reported as
 * "not supported yet". ThreadLink never runs it and never routes work to it:
 * it has no runner here, and it is not an AgentProvider, so no job can name it.
 */

import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ProviderDiscovery } from "./discovery.ts";
import type { EnvLike } from "./env.ts";
import type { AgentRunner } from "./orchestrator.ts";
import { ClaudeTeamRunner } from "./runners/claude.ts";
import { CodexTeamRunner } from "./runners/codex.ts";
import type { AgentProvider } from "./types.ts";

export type ProviderId = AgentProvider | "cursor";

export type ProviderStatus = "available" | "not_installed" | "signed_out" | "not_supported_yet";

/** What the desktop app and the server are told about each provider. */
export type ProviderCapability = {
  id: ProviderId;
  displayName: string;
  /** Can run a task with no window, from ThreadLink. */
  headless: boolean;
  /** Can continue an earlier session by id. */
  resumableSessions: boolean;
  /** ThreadLink can choose the model for a run. */
  modelSelection: boolean;
  /** Accepts MCP servers. */
  mcp: boolean;
  /**
   * ThreadLink can list the user's existing conversations. Codex has no
   * supported, machine-readable session list, and ThreadLink does not scrape
   * ~/.codex/sessions, so it is "unsupported".
   */
  conversationDiscovery: "supported" | "unsupported";
  status: ProviderStatus;
  /** Whether ThreadLink will route work to it. False for anything not "available". */
  routable: boolean;
  /** One plain sentence for the person, when there is something to say. */
  note: string | null;
};

type StaticCapabilities = Pick<
  ProviderCapability,
  | "id"
  | "displayName"
  | "headless"
  | "resumableSessions"
  | "modelSelection"
  | "mcp"
  | "conversationDiscovery"
>;

/**
 * One adapter per provider. `createRunner` is absent for a provider ThreadLink
 * can detect but does not run.
 */
export type ProviderAdapterSpec = StaticCapabilities & {
  createRunner?: (found: ProviderDiscovery) => AgentRunner | null;
};

export const PROVIDER_ADAPTERS: readonly ProviderAdapterSpec[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    headless: true,
    resumableSessions: true,
    modelSelection: true,
    mcp: true,
    conversationDiscovery: "supported",
    createRunner: () => new ClaudeTeamRunner(),
  },
  {
    id: "codex",
    displayName: "Codex",
    headless: true,
    resumableSessions: true,
    modelSelection: true,
    mcp: true,
    conversationDiscovery: "unsupported",
    createRunner: (found) =>
      found.executable ? new CodexTeamRunner({ executable: found.executable }) : null,
  },
  {
    // Its CLI (`agent -p --output-format json`, `--resume`, `--model`, MCP)
    // looks suitable, but ThreadLink has never run it. Detect-only.
    id: "cursor",
    displayName: "Cursor",
    headless: false,
    resumableSessions: false,
    modelSelection: false,
    mcp: false,
    conversationDiscovery: "unsupported",
  },
];

/**
 * Runners for the providers that are installed and signed in with a
 * subscription. Nothing else gets one, and a detect-only provider never does.
 */
export function createRunners(
  found: readonly ProviderDiscovery[],
): Partial<Record<AgentProvider, AgentRunner>> {
  const runners: Partial<Record<AgentProvider, AgentRunner>> = {};
  for (const p of found) {
    if (!usableForTeam(p)) continue;
    const adapter = PROVIDER_ADAPTERS.find((a) => a.id === p.provider);
    const runner = adapter?.createRunner?.(p) ?? null;
    if (runner) runners[p.provider] = runner;
  }
  return runners;
}

/**
 * How each provider must be signed in for ThreadLink to use it: with the
 * owner's subscription. An API-key sign-in bills that key per token, which is
 * paid usage the owner never switched on, so it is refused rather than used.
 */
export const SUBSCRIPTION_AUTH: Record<AgentProvider, readonly string[]> = {
  "claude-code": ["claude.ai"],
  codex: ["chatgpt"],
};

export function usableForTeam(p: ProviderDiscovery): boolean {
  return (
    p.installed &&
    p.authenticated &&
    p.authMethod !== null &&
    SUBSCRIPTION_AUTH[p.provider].includes(p.authMethod)
  );
}

// ---------------------------------------------------------------------------
// Cursor: detect only
// ---------------------------------------------------------------------------

export type CursorDetection = {
  found: boolean;
  /** Which command was found, for the note. The path stays on this computer. */
  command: "agent" | "cursor-agent" | "cursor" | null;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks for a Cursor CLI on PATH without running anything. On Windows the
 * usual launchers are .cmd shims; since nothing is executed, those count.
 * `agent` is a generic name, so the note says "appears".
 */
export function detectCursor(env: EnvLike = process.env): CursorDetection {
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [""];
  const candidates = ["cursor-agent", "agent", "cursor"] as const;
  for (const name of candidates) {
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) continue;
      if (exts.some((ext) => isFile(join(dir, `${name}${ext}`)))) {
        return { found: true, command: name };
      }
    }
  }
  return { found: false, command: null };
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function statusOf(p: ProviderDiscovery | undefined): {
  status: ProviderStatus;
  note: string | null;
} {
  if (!p || !p.installed) return { status: "not_installed", note: p?.detail ?? null };
  if (!usableForTeam(p)) {
    const note =
      p.authenticated && p.authMethod === "api_key"
        ? "Signed in with an API key. ThreadLink only uses your subscription, so sign in with your account instead."
        : (p.detail ?? "Not signed in.");
    return { status: "signed_out", note };
  }
  return { status: "available", note: null };
}

/**
 * Every provider ThreadLink knows, with what it can do and whether it is
 * usable here. Derived from discovery; Cursor from a PATH lookup only.
 */
export function providerCapabilities(
  found: readonly ProviderDiscovery[],
  cursor: CursorDetection,
): ProviderCapability[] {
  return PROVIDER_ADAPTERS.map((adapter) => {
    const { createRunner, ...caps } = adapter;
    if (adapter.id === "cursor") {
      return {
        ...caps,
        status: "not_supported_yet" as const,
        routable: false,
        note: cursor.found
          ? "A Cursor CLI appears to be installed. ThreadLink does not support Cursor yet, so it will not use it."
          : "ThreadLink does not support Cursor yet.",
      };
    }
    const discovered = found.find((p) => p.provider === adapter.id);
    const { status, note } = statusOf(discovered);
    return { ...caps, status, routable: status === "available" && Boolean(createRunner), note };
  });
}
