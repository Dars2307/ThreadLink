import type { Executor } from "../executor.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import type { Detection, ProviderAdapter, ProviderId } from "./types.ts";

export { ClaudeCodeAdapter } from "./claude-code.ts";
export type * from "./types.ts";

/** Placeholder adapter: reports unavailable so ThreadLink never routes to it. */
export class UnavailableAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  constructor(id: ProviderId, displayName: string) {
    this.id = id;
    this.displayName = displayName;
  }
  async detect(): Promise<Detection> {
    return {
      available: false,
      version: null,
      detail: `${this.displayName} support is not built yet.`,
    };
  }
  capabilities(): Record<string, string> {
    return { [this.id]: "unavailable" };
  }
  async discoverWorkspaces() {
    return [];
  }
  async discoverConversations() {
    return [];
  }
  async conversationExists() {
    return false;
  }
  async runningConversationIds() {
    return new Set<string>();
  }
  createExecutor(): Executor {
    throw new Error(`${this.displayName} is not supported yet.`);
  }
}

export function defaultAdapters(): ProviderAdapter[] {
  return [
    new ClaudeCodeAdapter(),
    new UnavailableAdapter("codex", "Codex"),
    new UnavailableAdapter("nova", "Nova"),
  ];
}
