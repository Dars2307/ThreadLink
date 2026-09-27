/**
 * Provider capabilities (docs/design/threadlink-0.10.md §10).
 *
 * What each supported adapter can do and how ThreadLink can verify it, in one
 * registry. The orchestrator and the UI read these facts instead of switching
 * on a provider id: "does this provider report the sandbox it ran in", "what
 * is its native session called", "can a run be resumed", "where do activity
 * signals come from". A new provider is one more entry here (plus its runner
 * in providers.ts); nothing in the orchestrator changes.
 *
 * Every value is a fact ThreadLink has verified against the real CLI or a
 * deliberate "no". Nothing is optimistic: a capability that has not been
 * verified is recorded as unsupported.
 */

import type { RunAccess } from "./runner.ts";

export type NativeSessionKind = "claude_session" | "codex_thread";

export type ProviderCapabilities = {
  /** Registry id (public.agent_providers.id). */
  id: string;
  displayName: string;
  /** The short name used in chat ("Claude"). */
  shortName: string;
  /** Runs with no window, from ThreadLink. */
  headless: boolean;
  /** How a structured final answer is requested and validated. */
  structuredOutput: "json_schema_flag" | "output_schema_file";
  /** ThreadLink chooses the model for each run. */
  modelSelection: boolean;
  /** Where the model that actually ran is read from. */
  modelVerification: "result_model_usage" | "session_record";
  /**
   * `provider_reported`: the provider records the sandbox it applied and the
   * runner checks it. `threadlink_checks_only`: nothing reported; read-only
   * runs are checked by ThreadLink (clean worktree), write runs rest on flags.
   */
  accessVerification: "provider_reported" | "threadlink_checks_only";
  accessModes: readonly RunAccess[];
  nativeSession: {
    /** The provider returns an id for the run's native session. */
    exposed: boolean;
    kind: NativeSessionKind | null;
    /** A later run can continue the same native session by id. */
    resume: boolean;
    /**
     * "Open in provider": offered only when supported AND verified. The
     * command is shown to the owner to copy; ThreadLink never runs it.
     */
    openInProvider: { supported: boolean; verified: boolean; command: string | null };
  };
  /**
   * `events`: the CLI streams typed events that map to a fixed activity enum
   * (activity.ts). `phase`: only the run's phase is known (start / finish).
   */
  activity: "events" | "phase";
  /** Cancellation is always a kill of the process tree ThreadLink started. */
  cancellation: "process_tree_kill";
  /** Sign-in methods that are the owner's subscription (never API keys). */
  subscriptionAuth: readonly string[];
  /** Several runs of this provider may run at once in separate worktrees. */
  concurrentRuns: boolean;
};

export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    shortName: "Claude",
    headless: true,
    structuredOutput: "json_schema_flag",
    modelSelection: true,
    modelVerification: "result_model_usage",
    accessVerification: "threadlink_checks_only",
    accessModes: ["read-only", "workspace-write"],
    nativeSession: {
      exposed: true,
      kind: "claude_session",
      resume: true,
      // `claude --resume <session_id>` in the project folder, documented by
      // Claude Code and verified by the runner's own resume path.
      openInProvider: { supported: true, verified: true, command: "claude --resume {id}" },
    },
    // The runner uses `--output-format json`, which reports nothing until the
    // run ends. Activity is phase-level only; no interim state is invented.
    activity: "phase",
    cancellation: "process_tree_kill",
    subscriptionAuth: ["claude.ai"],
    concurrentRuns: true,
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    shortName: "Codex",
    headless: true,
    structuredOutput: "output_schema_file",
    modelSelection: true,
    modelVerification: "session_record",
    accessVerification: "provider_reported",
    accessModes: ["read-only", "workspace-write"],
    nativeSession: {
      exposed: true,
      kind: "codex_thread",
      resume: true,
      // `codex resume <thread>` exists, but ThreadLink has not verified that it
      // reopens a thread started with --ignore-user-config in the same state.
      // Not offered until it is.
      openInProvider: { supported: false, verified: false, command: null },
    },
    activity: "events",
    cancellation: "process_tree_kill",
    subscriptionAuth: ["chatgpt"],
    concurrentRuns: true,
  },
};

/**
 * The capabilities of a provider. An id with no entry has no capabilities at
 * all: every check against it fails closed.
 */
export function capabilitiesOf(provider: string): ProviderCapabilities | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITIES, provider)
    ? PROVIDER_CAPABILITIES[provider]!
    : null;
}

/** What is reported to the server with detection (`detected.capabilities`). JSON-safe. */
export function capabilitiesReport(provider: string): Record<string, unknown> | null {
  const c = capabilitiesOf(provider);
  if (!c) return null;
  return {
    headless: c.headless,
    structuredOutput: c.structuredOutput,
    modelSelection: c.modelSelection,
    modelVerification: c.modelVerification,
    accessVerification: c.accessVerification,
    accessModes: [...c.accessModes],
    nativeSession: {
      exposed: c.nativeSession.exposed,
      kind: c.nativeSession.kind,
      resume: c.nativeSession.resume,
      openInProvider: {
        supported: c.nativeSession.openInProvider.supported,
        verified: c.nativeSession.openInProvider.verified,
      },
    },
    activity: c.activity,
    cancellation: c.cancellation,
    concurrentRuns: c.concurrentRuns,
  };
}

/**
 * The registry as flat booleans, merged into detection's `capabilities`
 * (which the server accepts as a record of booleans). Fixed keys.
 */
export function capabilityFlags(provider: string): Record<string, boolean> {
  const c = capabilitiesOf(provider);
  if (!c) return {};
  return {
    headless: c.headless,
    providerReportsAccess: c.accessVerification === "provider_reported",
    nativeSessionExposed: c.nativeSession.exposed,
    nativeSessionResume: c.nativeSession.resume,
    openInProviderSupported: c.nativeSession.openInProvider.supported,
    openInProviderVerified: c.nativeSession.openInProvider.verified,
    activityEvents: c.activity === "events",
    concurrentRuns: c.concurrentRuns,
  };
}
