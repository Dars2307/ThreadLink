import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { buildAgentEnv, type EnvLike } from "./env.ts";
import { isPlainObject, killTree, type SpawnFn } from "./runner.ts";
import type { AgentProvider } from "./types.ts";

/**
 * Provider discovery (docs/design/team-mode.md §3.2): what is installed, who is
 * logged in, which models exist, and what ThreadLink can honestly do with each.
 *
 * Rules:
 *   - every external call has a timeout, and nothing here throws: a failure is
 *     reported as installed/authenticated false with a `detail`;
 *   - `claude auth status` also returns email, org id and org name. Only
 *     loggedIn, authMethod and subscriptionType cross this boundary;
 *   - `~/.codex/models_cache.json` has an `identity` key. It is dropped while
 *     parsing and never read or returned;
 *   - no CLI exposes remaining usage as a number, so usage is always "unknown".
 */

export type DiscoveredModel = {
  id: string;
  displayName: string;
  description: string | null;
  efforts: string[];
  defaultEffort: string | null;
  source: "catalog" | "observed" | "configured";
};

export type TeamCapabilities = {
  supportsBackgroundWorker: boolean;
  supportsExactResume: boolean;
  supportsOpenConversation: boolean;
  supportsFork: boolean;
  supportsModelSelection: boolean;
  supportsUsageStatus: boolean;
  supportsParallelWorker: boolean;
  supportsReadOnlyReview: boolean;
};

export type ProviderDiscovery = {
  provider: AgentProvider;
  installed: boolean;
  /** Local only: never sent to the server. */
  executable: string | null;
  version: string | null;
  authenticated: boolean;
  /** "claude.ai" / "chatgpt" / "api_key"; never a token. */
  authMethod: string | null;
  /** e.g. "max"; null when the provider does not expose it. */
  detectedPlan: string | null;
  models: DiscoveredModel[];
  currentModel: string | null;
  capabilities: TeamCapabilities;
  usage: { remaining: "unknown" };
  /** Human-readable reason when something could not be determined. */
  detail?: string;
};

/**
 * What ThreadLink can do with each provider, as verified on this machine:
 *   Claude: --resume and --fork-session (runtime/src/executor.ts), plan mode for
 *           read-only review. It will not write into a conversation that is open.
 *   Codex:  `codex exec` / `exec resume` headless with an explicit sandbox that the
 *           rollout confirms. `exec fork` exists in --help but ThreadLink has not
 *           verified or used it, so it is not claimed.
 * Neither CLI reports remaining usage.
 */
export const CLAUDE_CAPABILITIES: TeamCapabilities = {
  supportsBackgroundWorker: true,
  supportsExactResume: true,
  supportsOpenConversation: false,
  supportsFork: true,
  supportsModelSelection: true,
  supportsUsageStatus: false,
  supportsParallelWorker: true,
  supportsReadOnlyReview: true,
};

export const CODEX_CAPABILITIES: TeamCapabilities = {
  supportsBackgroundWorker: true,
  supportsExactResume: true,
  supportsOpenConversation: false,
  supportsFork: false,
  supportsModelSelection: true,
  supportsUsageStatus: false,
  supportsParallelWorker: true,
  supportsReadOnlyReview: true,
};

const NO_CAPABILITIES: TeamCapabilities = {
  supportsBackgroundWorker: false,
  supportsExactResume: false,
  supportsOpenConversation: false,
  supportsFork: false,
  supportsModelSelection: false,
  supportsUsageStatus: false,
  supportsParallelWorker: false,
  supportsReadOnlyReview: false,
};

/** The effort levels `claude --help` documents for --effort (2.1.266). */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Claude Code has NO programmatic model list. These are full ids ThreadLink knows:
 * two observed running on this machine and one documented by `claude --help`.
 * They are "configured", not "catalog": a run still verifies the model that ran.
 */
export const KNOWN_CLAUDE_MODELS: readonly { id: string; displayName: string }[] = [
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { id: "claude-fable-5", displayName: "Claude Fable 5" },
];

const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,40}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

// --- executables ----------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds `name` on PATH. On Windows only real executables are accepted: .cmd/.bat
 * shims would need cmd.exe, and ThreadLink never runs agents through a shell.
 */
export function findOnPath(name: string, env: EnvLike = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  const names = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export type ExecutableLookup = { path: string | null; source: string | null; detail?: string };

/**
 * Codex: THREADLINK_CODEX_PATH (explicit override; if set it must be valid — no
 * fallback), then PATH, then the Codex desktop app's bundled CLI at
 * %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (newest by mtime; some <hash>
 * folders hold other tools only).
 */
export function findCodexExecutable(options: { env?: EnvLike } = {}): ExecutableLookup {
  const env = options.env ?? process.env;
  const override = env.THREADLINK_CODEX_PATH;
  if (override) {
    if (isAbsolute(override) && isFile(override)) return { path: override, source: "override" };
    return {
      path: null,
      source: null,
      detail: "THREADLINK_CODEX_PATH is set but is not an absolute path to an existing file.",
    };
  }
  const onPath = findOnPath("codex", env);
  if (onPath) return { path: onPath, source: "path" };

  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const bin = join(localAppData, "OpenAI", "Codex", "bin");
    let best: { path: string; mtime: number } | null = null;
    let entries: string[] = [];
    try {
      entries = readdirSync(bin);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const candidate = join(bin, entry, "codex.exe");
      try {
        const st = statSync(candidate);
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) {
          best = { path: candidate, mtime: st.mtimeMs };
        }
      } catch {
        /* not in this folder */
      }
    }
    if (best) return { path: best.path, source: "codex-app" };
  }
  return { path: null, source: null, detail: "The Codex CLI was not found." };
}

// --- bounded external calls -----------------------------------------------------

type CallResult = { code: number | null; out: string; failed: string | null };

/** Runs a short command with a timeout; never throws, never shells out. */
function call(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<CallResult> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: CallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(command, args, {
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ code: null, out: "", failed: error instanceof Error ? error.message : "spawn" });
      return;
    }
    const timer = setTimeout(() => {
      void killTree(child);
      done({ code: null, out, failed: "timed out" });
    }, timeoutMs);
    const collect = (d: Buffer) => {
      if (out.length < 256 * 1024) out += d.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e: NodeJS.ErrnoException) =>
      done({ code: null, out, failed: e.code ?? e.message }),
    );
    child.on("close", (code) => done({ code, out, failed: null }));
  });
}

// --- Codex -----------------------------------------------------------------------

type CatalogModel = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  priority?: unknown;
};

/**
 * The index just past the first complete top-level JSON object in `text`
 * (string- and escape-aware), or null if there is none.
 */
export function endOfFirstJsonObject(text: string): number | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}
/** Selectable models from models_cache.json (visibility "list" only). */
export function readCodexModelCatalog(codexHome: string): DiscoveredModel[] {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "models_cache.json"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  // The reviver drops `identity` (account data) while parsing, at any depth.
  const reviver = (key: string, value: unknown) => (key === "identity" ? undefined : value);
  try {
    parsed = JSON.parse(text, reviver);
  } catch {
    // Seen for real: Codex rewrote its cache with shorter content without
    // truncating the file, leaving the old tail after a complete document.
    // Only that case is recovered: exactly one complete JSON object first.
    const end = endOfFirstJsonObject(text);
    if (end === null) return [];
    try {
      parsed = JSON.parse(text.slice(0, end), reviver);
    } catch {
      return [];
    }
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.models)) return [];
  const models: { model: DiscoveredModel; priority: number }[] = [];
  for (const raw of parsed.models as CatalogModel[]) {
    if (!isPlainObject(raw) || raw.visibility !== "list") continue;
    if (typeof raw.slug !== "string" || !MODEL_ID.test(raw.slug)) continue;
    const efforts = Array.isArray(raw.supported_reasoning_levels)
      ? raw.supported_reasoning_levels
          .map((l: unknown) => (isPlainObject(l) ? l.effort : undefined))
          .filter((e): e is string => typeof e === "string" && SAFE_TOKEN.test(e))
      : [];
    models.push({
      priority: typeof raw.priority === "number" ? raw.priority : Number.MAX_SAFE_INTEGER,
      model: {
        id: raw.slug,
        displayName: typeof raw.display_name === "string" ? raw.display_name : raw.slug,
        description: typeof raw.description === "string" ? raw.description : null,
        efforts,
        defaultEffort:
          typeof raw.default_reasoning_level === "string" &&
          SAFE_TOKEN.test(raw.default_reasoning_level)
            ? raw.default_reasoning_level
            : null,
        source: "catalog",
      },
    });
  }
  models.sort((a, b) => a.priority - b.priority);
  return models.map((entry) => entry.model);
}

/** The top-level `model = "..."` of config.toml; no other key is read. */
export function readCodexConfiguredModel(codexHome: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) break; // first table: past the top-level keys
    const m = /^model\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) {
      const value = m[1] ?? m[2] ?? "";
      return MODEL_ID.test(value) ? value : null;
    }
  }
  return null;
}

export type DiscoveryOptions = {
  env?: EnvLike;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  /** Codex: overrides CODEX_HOME / ~/.codex. */
  codexHome?: string;
  /** Codex: skip lookup and use this executable. */
  codexExecutable?: string;
  /** Claude: executable (default `claude` resolved on PATH). */
  claudeCommand?: string;
  /** Claude: full ids the user configured. */
  claudeConfiguredModels?: string[];
  /** Claude: ids ThreadLink has seen in modelUsage of real runs. */
  claudeObservedModels?: string[];
};

function empty(provider: AgentProvider, detail: string): ProviderDiscovery {
  return {
    provider,
    installed: false,
    executable: null,
    version: null,
    authenticated: false,
    authMethod: null,
    detectedPlan: null,
    models: [],
    currentModel: null,
    capabilities: { ...NO_CAPABILITIES },
    usage: { remaining: "unknown" },
    detail,
  };
}

export async function discoverCodex(options: DiscoveryOptions = {}): Promise<ProviderDiscovery> {
  try {
    const parentEnv = options.env ?? process.env;
    const { env } = buildAgentEnv(parentEnv);
    const spawnFn = options.spawnFn ?? spawn;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lookup = options.codexExecutable
      ? { path: options.codexExecutable, source: "option" }
      : findCodexExecutable({ env: parentEnv });
    if (!lookup.path) return empty("codex", lookup.detail ?? "The Codex CLI was not found.");
    const executable = lookup.path;

    const versionCall = await call(spawnFn, executable, ["--version"], env, timeoutMs);
    const version = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(versionCall.out)?.[1] ?? null;
    if (versionCall.code !== 0 || !version) {
      return {
        ...empty(
          "codex",
          `The Codex CLI did not report a version (${versionCall.failed ?? `exit ${versionCall.code}`}).`,
        ),
        executable,
      };
    }

    const codexHome = options.codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");
    const status = await call(spawnFn, executable, ["login", "status"], env, timeoutMs);
    let authMethod: string | null = null;
    let detail: string | undefined;
    if (status.code === 0 && /logged in using chatgpt/i.test(status.out)) authMethod = "chatgpt";
    else if (status.code === 0 && /logged in using (?:an )?api key/i.test(status.out)) {
      authMethod = "api_key";
      detail = "Codex is logged in with an API key: runs would be billed to that key.";
    } else if (status.code === 0 && /logged in/i.test(status.out)) authMethod = "unknown";
    else detail = "Codex is not logged in (run `codex login`).";

    return {
      provider: "codex",
      installed: true,
      executable,
      version,
      authenticated: authMethod !== null,
      authMethod,
      // No official, safe source exposes the ChatGPT plan to a local process.
      detectedPlan: null,
      models: readCodexModelCatalog(codexHome),
      currentModel: readCodexConfiguredModel(codexHome),
      capabilities: { ...CODEX_CAPABILITIES },
      usage: { remaining: "unknown" },
      ...(detail ? { detail } : {}),
    };
  } catch {
    return empty("codex", "Codex discovery failed unexpectedly.");
  }
}

// --- Claude ----------------------------------------------------------------------

function claudeModels(options: DiscoveryOptions): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>();
  const add = (id: string, displayName: string, source: DiscoveredModel["source"]) => {
    if (!MODEL_ID.test(id)) return;
    const existing = seen.get(id);
    // "observed" is the strongest evidence and wins over "configured".
    if (existing && !(source === "observed" && existing.source !== "observed")) return;
    seen.set(id, {
      id,
      displayName: existing?.displayName ?? displayName,
      description: null,
      efforts: [...CLAUDE_EFFORTS],
      defaultEffort: null,
      source,
    });
  };
  for (const m of KNOWN_CLAUDE_MODELS) add(m.id, m.displayName, "configured");
  for (const id of options.claudeConfiguredModels ?? []) add(id, id, "configured");
  for (const id of options.claudeObservedModels ?? []) add(id, id, "observed");
  return [...seen.values()];
}

export async function discoverClaude(options: DiscoveryOptions = {}): Promise<ProviderDiscovery> {
  try {
    const parentEnv = options.env ?? process.env;
    const { env } = buildAgentEnv(parentEnv);
    const spawnFn = options.spawnFn ?? spawn;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const executable = options.claudeCommand ?? findOnPath("claude", parentEnv);
    if (!executable) return empty("claude-code", "Claude Code (`claude`) was not found on PATH.");

    const versionCall = await call(spawnFn, executable, ["--version"], env, timeoutMs);
    const version = /(\d+\.\d+\.\d+)/.exec(versionCall.out)?.[1] ?? null;
    if (versionCall.code !== 0 || !version) {
      return {
        ...empty(
          "claude-code",
          `Claude Code did not report a version (${versionCall.failed ?? `exit ${versionCall.code}`}).`,
        ),
        executable,
      };
    }

    const status = await call(spawnFn, executable, ["auth", "status", "--json"], env, timeoutMs);
    // Only three fields survive this block. email / orgId / orgName are never copied.
    let loggedIn = false;
    let authMethod: string | null = null;
    let plan: string | null = null;
    try {
      const raw: unknown = JSON.parse(status.out.trim());
      if (isPlainObject(raw)) {
        loggedIn = raw.loggedIn === true;
        authMethod =
          typeof raw.authMethod === "string" && SAFE_TOKEN.test(raw.authMethod)
            ? raw.authMethod
            : null;
        plan =
          typeof raw.subscriptionType === "string" && SAFE_TOKEN.test(raw.subscriptionType)
            ? raw.subscriptionType
            : null;
      }
    } catch {
      /* not JSON: treated as not authenticated below */
    }

    return {
      provider: "claude-code",
      installed: true,
      executable,
      version,
      authenticated: loggedIn,
      authMethod: loggedIn ? authMethod : null,
      detectedPlan: loggedIn ? plan : null,
      // Claude Code has no programmatic model list; see KNOWN_CLAUDE_MODELS.
      models: claudeModels(options),
      currentModel: null,
      capabilities: { ...CLAUDE_CAPABILITIES },
      usage: { remaining: "unknown" },
      ...(loggedIn ? {} : { detail: "Claude Code is not logged in (run `claude auth login`)." }),
    };
  } catch {
    return empty("claude-code", "Claude Code discovery failed unexpectedly.");
  }
}

/** Both providers, concurrently. Never throws. */
export async function discoverProviders(
  options: DiscoveryOptions = {},
): Promise<ProviderDiscovery[]> {
  return Promise.all([discoverClaude(options), discoverCodex(options)]);
}
