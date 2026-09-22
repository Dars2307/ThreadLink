import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Non-secret local bridge state, stored OUTSIDE the repository:
 *   Windows  %APPDATA%\ThreadLink\bridge
 *   macOS    ~/Library/Application Support/ThreadLink/bridge
 *   Linux    $XDG_CONFIG_HOME/threadlink/bridge (default ~/.config)
 *
 * Each workspace directory gets its own stable localBindingRef (a random UUID
 * generated once), so reconnecting reuses the same tlses_ and a new
 * workspace/installation gets a new binding. Display names never matter.
 */

export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32")
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "ThreadLink", "bridge");
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "ThreadLink", "bridge");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "threadlink", "bridge");
}

export type BridgeConfig = { baseUrl?: string };

export type WorkspaceState = {
  workspace: string;
  localBindingRef: string;
  sessionId?: string;
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadConfig(configDir: string): Promise<BridgeConfig> {
  return (await readJson<BridgeConfig>(join(configDir, "config.json"))) ?? {};
}

export async function saveConfig(configDir: string, config: BridgeConfig): Promise<void> {
  await writeJson(join(configDir, "config.json"), config);
}

export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 16);
}

export function workspaceDisplayName(workspace: string): string {
  return `Claude Code · ${basename(resolve(workspace)) || "workspace"}`.slice(0, 100);
}

/** Loads (or creates once) the stable binding for a workspace. */
export async function loadWorkspaceState(
  configDir: string,
  workspace: string,
): Promise<WorkspaceState> {
  const file = join(configDir, "workspaces", `${workspaceKey(workspace)}.json`);
  const existing = await readJson<WorkspaceState>(file);
  if (existing?.localBindingRef && /^[A-Za-z0-9._:-]{1,128}$/.test(existing.localBindingRef)) {
    return existing;
  }
  const state: WorkspaceState = {
    workspace: resolve(workspace),
    localBindingRef: `cc-${randomUUID()}`,
  };
  await writeJson(file, state);
  return state;
}

export async function saveWorkspaceState(configDir: string, state: WorkspaceState): Promise<void> {
  await writeJson(join(configDir, "workspaces", `${workspaceKey(state.workspace)}.json`), state);
}
