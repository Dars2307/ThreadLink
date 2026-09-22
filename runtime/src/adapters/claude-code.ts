import { spawn } from "node:child_process";

import {
  claudeAgentsLister,
  discoverClaudeSessions,
  discoverClaudeWorkspaces,
  sessionExistsInWorkspace,
  type AgentsLister,
} from "../claude-sessions.ts";
import { ClaudeCodeExecutor, PERMISSION_MODES, type PermissionMode } from "../executor.ts";
import type { ConversationBinding, Detection, ExecutorOptions, ProviderAdapter } from "./types.ts";

export type ClaudeAdapterOptions = {
  command?: string;
  home?: string;
  spawnFn?: typeof spawn;
  listRunning?: AgentsLister;
};

function claudeVersion(command: string, spawnFn: typeof spawn): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawnFn(command, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      resolve(code === 0 && m?.[1] ? m[1] : null);
    });
  });
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly #command: string;
  readonly #home?: string;
  readonly #spawn: typeof spawn;
  readonly #listRunning: AgentsLister;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#home = options.home;
    this.#spawn = options.spawnFn ?? spawn;
    this.#listRunning = options.listRunning ?? claudeAgentsLister(this.#command, this.#spawn);
  }

  async detect(): Promise<Detection> {
    const version = await claudeVersion(this.#command, this.#spawn);
    return version
      ? { available: true, version }
      : {
          available: false,
          version: null,
          detail: "Claude Code (`claude`) was not found on PATH.",
        };
  }

  capabilities(detection: Detection): Record<string, string> {
    const state = detection.available ? "available" : "unavailable";
    return {
      "claude-code": state,
      "claude-resume": state,
      "interactive-session-discovery": state,
    };
  }

  discoverWorkspaces() {
    return discoverClaudeWorkspaces({ home: this.#home });
  }

  async discoverConversations(workspace: string) {
    const sessions = await discoverClaudeSessions(workspace, { home: this.#home, limit: 100 });
    return sessions.map((s) => ({
      nativeSessionId: s.sessionId,
      title: s.title,
      lastUsedAt: s.lastUsedAt,
      workspace,
    }));
  }

  conversationExists(workspace: string, nativeSessionId: string) {
    return sessionExistsInWorkspace(workspace, nativeSessionId, this.#home);
  }

  async runningConversationIds(): Promise<Set<string>> {
    return new Set((await this.#listRunning()).map((r) => r.sessionId));
  }

  createExecutor(workspace: string, binding: ConversationBinding, options: ExecutorOptions) {
    const mode = (options.permissionMode ?? "plan") as PermissionMode;
    if (!PERMISSION_MODES.includes(mode)) throw new Error("Invalid Claude Code permission mode.");
    return new ClaudeCodeExecutor({
      cwd: workspace,
      command: this.#command,
      spawnFn: this.#spawn,
      permissionMode: mode,
      model: options.model,
      native:
        binding.mode === "resume"
          ? { mode: "resume", sessionId: binding.nativeSessionId }
          : { mode: "fresh" },
      listRunning: this.#listRunning,
      lockDir: options.lockDir,
    });
  }
}
