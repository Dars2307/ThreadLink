/**
 * The environment a Team Mode agent process is started with.
 *
 * A child CLI that inherits an API key or a third-party-provider switch can
 * move from the user's included subscription to metered API billing without
 * saying so (docs/design/team-mode.md §0, docs/research/claudex-loop-review.md
 * §3.5.3). It would also hand that secret to every tool the agent runs. So the
 * child gets the parent environment MINUS:
 *
 *   - every ANTHROPIC_* and OPENAI_* variable (keys, tokens, base URLs, model
 *     overrides such as ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL);
 *   - every AZURE_OPENAI_* variable, CODEX_API_KEY, AWS_BEARER_TOKEN_BEDROCK;
 *   - every CLAUDE_CODE_USE_* provider switch (Bedrock, Vertex, Foundry, ...);
 *   - anything ending in _API_KEY or _AUTH_TOKEN;
 *   - the variables that tie a process to a *parent* Claude Code session
 *     (when the Runtime itself was started from inside Claude Code), plus
 *     CLAUDE_EFFORT, so that ThreadLink alone decides effort and session.
 *
 * Everything else (PATH, HOME/USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot,
 * TEMP/TMP, CODEX_HOME, ...) is kept so the CLIs can find their own login.
 *
 * Windows variable names are case-insensitive, so matching is done on the
 * upper-cased name.
 */

/** A plain environment map (not NodeJS.ProcessEnv, which frameworks augment). */
export type EnvLike = Record<string, string | undefined>;

const REMOVE_PREFIXES = ["ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "CLAUDE_CODE_USE_"] as const;

const REMOVE_SUFFIXES = ["_API_KEY", "_AUTH_TOKEN"] as const;

const REMOVE_EXACT = new Set([
  "CODEX_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Parent-session linkage: a nested run must be its own session, not a child
  // of whatever Claude Code session happened to launch the Runtime.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
]);

/** True when a variable must never reach an agent process. */
export function isScrubbedVariable(name: string): boolean {
  const upper = name.toUpperCase();
  if (REMOVE_EXACT.has(upper)) return true;
  if (REMOVE_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return REMOVE_SUFFIXES.some((s) => upper.endsWith(s));
}

export type ScrubbedEnv = {
  env: Record<string, string>;
  /** Names only (never values) of what was removed, for diagnostics. */
  removed: string[];
};

/** Builds the environment for an agent child process. Never mutates `parent`. */
export function buildAgentEnv(parent: EnvLike = process.env): ScrubbedEnv {
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isScrubbedVariable(name)) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }
  removed.sort();
  return { env, removed };
}
