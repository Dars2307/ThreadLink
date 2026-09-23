import type { Executor } from "../executor.ts";

/**
 * Provider adapters: the Runtime engine is provider-neutral. Each adapter knows
 * how to detect its tool, discover workspaces/conversations, tell whether a
 * conversation is in use, and execute a ThreadLink task in exactly one
 * conversation. Claude Code is implemented; Codex and Nova report
 * "unavailable" until they exist, so ThreadLink never routes to them.
 */

export type ProviderId = "claude-code" | "codex" | "nova";

export type Detection = { available: boolean; version: string | null; detail?: string };

export type Conversation = {
  /** Provider-native conversation ID (metadata only; never a ThreadLink identity). */
  nativeSessionId: string;
  title: string | null;
  lastUsedAt: Date;
  workspace: string;
};

export type ConversationBinding =
  /** Exact conversation: resume this native session, refusing if it is open. */
  | { mode: "resume"; nativeSessionId: string }
  /** A new provider conversation per task. */
  | { mode: "fresh" }
  /**
   * Background worker: ThreadLink's own conversation for this workspace, so
   * delegation works while the user's conversation stays open and untouched.
   */
  | {
      mode: "worker";
      sourceNativeSessionId: string | null;
      workerNativeSessionId: string | null;
    };

/**
 * What a provider can actually do. Nothing may assume every provider supports
 * every mode: an adapter that cannot fork, or cannot tell whether a
 * conversation is in use, must say so and be routed accordingly.
 */
export type ProviderCapabilities = {
  supportsExactResume: boolean;
  supportsFork: boolean;
  supportsBackgroundWorker: boolean;
  supportsBusyDetection: boolean;
};

export type ExecutorOptions = { permissionMode?: string; model?: string; lockDir?: string };

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  detect(): Promise<Detection>;
  /** Capability flags this adapter contributes when available (validated server-side). */
  capabilities(detection: Detection): Record<string, string>;
  /** What this provider supports; the engine will not route a mode it lacks. */
  supports(): ProviderCapabilities;
  discoverWorkspaces(): Promise<{ path: string; lastUsedAt: Date }[]>;
  discoverConversations(workspace: string): Promise<Conversation[]>;
  conversationExists(workspace: string, nativeSessionId: string): Promise<boolean>;
  /** Native IDs currently open/running anywhere on this machine. Throws if unknown. */
  runningConversationIds(): Promise<Set<string>>;
  createExecutor(
    workspace: string,
    binding: ConversationBinding,
    options: ExecutorOptions,
  ): Executor;
}
