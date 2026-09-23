import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  BUILD_CHANNEL,
  canonicalizeBaseUrl,
  type CanonicalizeResult,
  type ThreadLinkChannel,
} from "./endpoints.ts";

/**
 * Non-secret local Runtime state, stored OUTSIDE any repository:
 *   Windows  %APPDATA%\ThreadLink\runtime
 *   macOS    ~/Library/Application Support/ThreadLink/runtime
 *   Linux    $XDG_CONFIG_HOME/threadlink/runtime (default ~/.config)
 * (Phase 6/6.5 used ".../bridge"; that directory is reused if it exists so
 * existing sign-ins, sessions and links survive the rename.)
 *
 * One Runtime (this machine/environment) -> many workspaces -> many attached
 * provider conversations. Each conversation has its own stable local binding
 * ref, so it always maps to the same ThreadLink tlses_. Paths are local display
 * metadata; the server-side workspace identity is (runtime, workspace key).
 */

export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.THREADLINK_CONFIG_DIR) return env.THREADLINK_CONFIG_DIR;
  const base =
    platform === "win32"
      ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "ThreadLink")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "ThreadLink")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "threadlink");
  const current = join(base, "runtime");
  const legacy = join(base, "bridge");
  return !exists(current) && exists(legacy) ? legacy : current;
}

export type RuntimeConfig = {
  baseUrl?: string;
  runtimeId?: string;
  label?: string;
  lastRestartHandled?: string;
};

export type AttachedConversation = {
  provider: "claude-code";
  /**
   * How ThreadLink runs work for this conversation:
   *   "resume" - the exact provider conversation, refused while it is open;
   *   "worker" - ThreadLink's own background conversation for this workspace,
   *              so delegation works while the user's stays open;
   *   "fresh"  - a new provider conversation for every task.
   */
  mode: "resume" | "worker" | "fresh";
  nativeSessionId: string | null;
  /**
   * Worker mode only: the background conversation ThreadLink created, learned
   * from the first run and reused afterwards so forks do not pile up.
   */
  workerNativeSessionId?: string | null;
  title: string | null;
  /** Stable handle that maps this conversation to its ThreadLink tlses_. */
  localBindingRef: string;
  sessionId?: string;
  attachedAt: string;
};

export type WorkspaceState = {
  workspace: string;
  workspaceKey: string;
  workspaceId?: string;
  conversations: AttachedConversation[];
};

/**
 * null means "there is no such file". Anything else - unreadable, locked by
 * another process, half-written, not JSON - throws.
 *
 * This distinction matters more than it looks: callers fall back to empty
 * state when this returns null, and then save that state back. Swallowing a
 * read error here silently detached every conversation in a workspace and
 * wrote the emptiness to disk.
 */
async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not valid JSON. ThreadLink will not overwrite it.`);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file); // atomic replace: a crash never leaves half-written state
}

export async function loadConfig(configDir: string): Promise<RuntimeConfig> {
  return (await readJson<RuntimeConfig>(join(configDir, "config.json"))) ?? {};
}

/**
 * Upgrades a stored generated deployment hostname to the canonical address for
 * this build, and writes it back so it is fixed once and for all. Everything
 * else in the configuration - the Runtime ID, its label, its workspaces and
 * their sessions - is left untouched, so identity survives the move.
 */
export async function migrateBaseUrl(
  configDir: string,
  channel: ThreadLinkChannel = BUILD_CHANNEL,
): Promise<CanonicalizeResult> {
  const config = await loadConfig(configDir);
  const result = canonicalizeBaseUrl(config.baseUrl, channel);
  if (result.changed || config.baseUrl !== result.url) {
    await saveConfig(configDir, { baseUrl: result.url });
  }
  return result;
}

export async function saveConfig(configDir: string, patch: RuntimeConfig): Promise<RuntimeConfig> {
  const next = { ...(await loadConfig(configDir)), ...patch };
  await writeJson(join(configDir, "config.json"), next);
  return next;
}

/** Case-insensitive on Windows/macOS default filesystems; exact elsewhere. */
export function normalizeWorkspacePath(path: string, platform: NodeJS.Platform = process.platform) {
  const r = resolve(path).replace(/[\\/]+$/, "");
  return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
}

/** Local file key (16 hex) and server workspace key (64 hex); neither is a global ID. */
export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(normalizeWorkspacePath(workspace)).digest("hex").slice(0, 16);
}
export function serverWorkspaceKey(workspace: string): string {
  return createHash("sha256")
    .update(`threadlink:workspace:v1:${normalizeWorkspacePath(workspace)}`)
    .digest("hex");
}

export function workspaceDisplayName(workspace: string): string {
  return (basename(resolve(workspace)) || "Workspace").slice(0, 100);
}

type LegacyWorkspaceState = {
  workspace: string;
  localBindingRef: string;
  sessionId?: string;
  native?:
    | { mode: "fresh" | "continue"; attachedAt: string }
    | { mode: "resume"; sessionId: string; title: string | null; attachedAt: string };
};

function migrate(value: unknown, workspace: string): WorkspaceState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<WorkspaceState & LegacyWorkspaceState>;
  if (Array.isArray(v.conversations)) {
    return {
      workspace: v.workspace ?? resolve(workspace),
      workspaceKey: v.workspaceKey ?? serverWorkspaceKey(workspace),
      workspaceId: v.workspaceId,
      conversations: v.conversations,
    };
  }
  // Phase 6.5 file: one binding per workspace. Keep its localBindingRef so the
  // existing tlses_ (and any active links) is reused, now placed on the runtime.
  if (typeof v.localBindingRef === "string") {
    const native = v.native;
    const resumed = native && native.mode === "resume" ? native : null;
    return {
      workspace: v.workspace ?? resolve(workspace),
      workspaceKey: serverWorkspaceKey(workspace),
      conversations: [
        {
          provider: "claude-code",
          mode: resumed ? "resume" : "fresh",
          nativeSessionId: resumed ? resumed.sessionId : null,
          title: resumed ? resumed.title : null,
          localBindingRef: v.localBindingRef,
          sessionId: v.sessionId,
          attachedAt: native?.attachedAt ?? new Date(0).toISOString(),
        },
      ],
    };
  }
  return null;
}

export async function loadWorkspaceState(
  configDir: string,
  workspace: string,
): Promise<WorkspaceState> {
  const file = join(configDir, "workspaces", `${workspaceKey(workspace)}.json`);
  return (
    migrate(await readJson(file), workspace) ?? {
      workspace: resolve(workspace),
      workspaceKey: serverWorkspaceKey(workspace),
      conversations: [],
    }
  );
}

export async function saveWorkspaceState(configDir: string, state: WorkspaceState): Promise<void> {
  const file = join(configDir, "workspaces", `${workspaceKey(state.workspace)}.json`);
  const next = `${JSON.stringify(state, null, 2)}
`;
  // An unchanged write is pointless, and every write is a chance for two
  // processes (the app and the CLI) to race over the same file.
  try {
    if ((await readFile(file, "utf8")) === next) return;
  } catch {
    /* no readable file yet: write it */
  }
  await writeJson(file, state);
}

export async function listWorkspaceStates(configDir: string): Promise<WorkspaceState[]> {
  let names: string[] = [];
  try {
    names = (await readdir(join(configDir, "workspaces"))).filter((n) =>
      /^[0-9a-f]{16}\.json$/.test(n),
    );
  } catch {
    return [];
  }
  const out: WorkspaceState[] = [];
  for (const name of names) {
    const raw = await readJson<{ workspace?: string }>(join(configDir, "workspaces", name));
    if (raw?.workspace) {
      const state = migrate(raw, raw.workspace);
      if (state) out.push(state);
    }
  }
  return out;
}

export function newLocalBindingRef(nativeSessionId: string | null): string {
  return nativeSessionId ? `cc:${nativeSessionId}` : `cc-fresh:${randomUUID()}`;
}
