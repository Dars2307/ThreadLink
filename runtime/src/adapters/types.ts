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

export type ConversationBinding = { mode: "resume"; nativeSessionId: string } | { mode: "fresh" };

export type ExecutorOptions = { permissionMode?: string; model?: string; lockDir?: string };

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  detect(): Promise<Detection>;
  /** Capability flags this adapter contributes when available (validated server-side). */
  capabilities(detection: Detection): Record<string, string>;
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
