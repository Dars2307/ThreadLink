import { spawn } from "node:child_process";
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { codexEventActivity } from "../activity.ts";
import { findCodexExecutable } from "../discovery.ts";
import { buildAgentEnv, type EnvLike } from "../env.ts";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  classifyFailureText,
  failResult,
  forbiddenArg,
  isPlainObject,
  parseResetTime,
  parseStructured,
  processFailure,
  runProcess,
  tail,
  validateRequest,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type RunAccess,
  type SpawnFn,
} from "../runner.ts";

/**
 * Codex CLI as a Team agent.
 *
 *   codex exec --json --ignore-user-config --ignore-rules -s <access>
 *              -c approval_policy="never" -m <model> [-c model_reasoning_effort="<e>"]
 *              [--output-schema <tmp file>] -C <cwd> <prompt | ->
 *   codex exec resume <thread> --json --ignore-user-config --ignore-rules
 *              -c sandbox_mode="<access>" -c approval_policy="never" -m <model>
 *              [-c model_reasoning_effort="<e>"] [--output-schema <f>] <prompt | ->
 *
 * (`exec resume` has no -s / -C: the sandbox is set through `-c sandbox_mode` and the
 * working directory through the process cwd — verified against `codex exec resume
 * --help` on 0.155.0-alpha.16.4. Both are verified afterwards from the rollout.)
 *
 * Why:
 *   --ignore-user-config  the user's config.toml sets danger-full-access and may define
 *                         MCP servers; neither may leak into a Team run.
 *   --ignore-rules        the user's execpolicy allow-rules are not ThreadLink's profile.
 *   -s / sandbox_mode     explicit, always; approval never (nobody is there to answer).
 *   no --ephemeral        the persisted rollout is how the model and sandbox are verified.
 * Never: --dangerously-bypass-*, danger-full-access, --oss.
 *
 * stdin is never opened (`codex exec` otherwise waits for it). The prompt travels in
 * argv; only when it is too long for a Windows command line is it sent as `-` on a
 * stdin that is written and closed at once. The prompt always starts with "[" so it can
 * never be mistaken for a flag.
 *
 * Verification: `--json` events do not name the model. After the run the rollout
 * `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` is scanned for its `session_meta` and
 * `turn_context` lines ONLY (the line's own `type` is checked before it is parsed;
 * message lines are never parsed). The last turn_context gives model, effort,
 * sandbox_policy.type, approval_policy and cwd.
 */

/** Past this many UTF-16 units the prompt goes through stdin instead of argv. */
export const CODEX_ARGV_PROMPT_LIMIT = 16_000;

export type CodexArgsOptions = {
  schemaFile?: string;
  /** Defaults to the current platform; injectable for tests. */
  platform?: NodeJS.Platform;
};

/** Everything except the prompt argument. */
export function buildCodexArgs(request: AgentRunRequest, options: CodexArgsOptions = {}): string[] {
  const args = ["exec"];
  if (request.resumeThreadId) args.push("resume", request.resumeThreadId);
  args.push("--json", "--ignore-user-config", "--ignore-rules");
  if (request.resumeThreadId) args.push("-c", `sandbox_mode="${request.access}"`);
  else args.push("-s", request.access);
  args.push("-c", 'approval_policy="never"', "-m", request.model);
  // On Windows, Codex's sandbox needs a backend. The user's own config names
  // one, but ThreadLink ignores that config (it also sets danger-full-access),
  // and without a backend Codex quietly ran a workspace-write request as
  // read-only -- caught by the rollout check in a real run. "unelevated" is the
  // restricted-token sandbox that needs no administrator rights: verified to
  // give a real workspace-write sandbox with network access off.
  if ((options.platform ?? process.platform) === "win32") {
    args.push("-c", 'windows.sandbox="unelevated"');
  }
  if (request.effort) args.push("-c", `model_reasoning_effort="${request.effort}"`);
  if (options.schemaFile) args.push("--output-schema", options.schemaFile);
  if (!request.resumeThreadId) args.push("-C", request.cwd);
  return args;
}

export function buildCodexPrompt(request: AgentRunRequest): string {
  if (request.purpose === "chat") {
    // Fast Chat (0.11 §3.4); starts with "[" like every prompt, never a flag.
    return [
      "[ThreadLink Fast Chat] You are answering in a ThreadLink chat (Codex, non-interactive).",
      "Access: READ-ONLY. Do not modify any file.",
      "",
      request.prompt,
    ].join("\n");
  }
  return [
    `[ThreadLink Team Mode] You are the ${request.role} in a ThreadLink team run (Codex, non-interactive).`,
    request.access === "read-only"
      ? "Access: READ-ONLY. Do not modify any file."
      : "Access: you may edit files inside this working directory only.",
    "Follow the repository's AGENTS.md and CLAUDE.md if they exist.",
    "",
    request.prompt,
  ].join("\n");
}

// --- rollout metadata ------------------------------------------------------------

export type RolloutMetadata = {
  file: string;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
  cwd: string | null;
};

/** Matches only a line whose top-level `type` is metadata, before any nested object. */
const METADATA_LINE = /^\{[^{]{0,300}?"type":"(session_meta|turn_context)"/;

/** Finds `rollout-*-<threadId>.jsonl`, newest day first. */
export function findRolloutFile(codexHome: string, threadId: string): string | null {
  const root = join(codexHome, "sessions");
  const suffix = `-${threadId}.jsonl`;
  const dirs = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of dirs(root)) {
    for (const m of dirs(join(root, y))) {
      for (const d of dirs(join(root, y, m))) {
        const day = join(root, y, m, d);
        let names: string[] = [];
        try {
          names = readdirSync(day);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
        if (hit) return join(day, hit);
      }
    }
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Reads ONLY session_meta / turn_context lines; returns the last turn's settings. */
export async function readRolloutMetadata(file: string): Promise<RolloutMetadata> {
  const meta: RolloutMetadata = {
    file,
    model: null,
    effort: null,
    sandbox: null,
    approvalPolicy: null,
    cwd: null,
  };
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const kind = METADATA_LINE.exec(line)?.[1];
    if (!kind) continue; // message content: never parsed
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed) || parsed.type !== kind || !isPlainObject(parsed.payload)) continue;
    const p = parsed.payload;
    if (kind === "session_meta") {
      meta.cwd = str(p.cwd) ?? meta.cwd;
      continue;
    }
    meta.model = str(p.model);
    meta.effort = str(p.effort);
    meta.approvalPolicy = str(p.approval_policy);
    meta.sandbox = isPlainObject(p.sandbox_policy) ? str(p.sandbox_policy.type) : null;
    meta.cwd = str(p.cwd) ?? meta.cwd;
  }
  return meta;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let out = p.replace(/^\\\\\?\\/, "");
    try {
      out = realpathSync.native(out);
    } catch {
      out = resolve(out);
    }
    return process.platform === "win32" ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

export function accessMatches(
  meta: RolloutMetadata,
  access: RunAccess,
  cwd: string,
): { ok: true } | { ok: false; why: string } {
  if (meta.sandbox !== access) {
    return {
      ok: false,
      why: `requested sandbox ${access}, Codex applied ${meta.sandbox ?? "unknown"}`,
    };
  }
  if (meta.approvalPolicy !== "never") {
    return { ok: false, why: `approval policy was ${meta.approvalPolicy ?? "unknown"}, not never` };
  }
  if (!meta.cwd || !samePath(meta.cwd, cwd)) {
    return { ok: false, why: "Codex ran in a different working directory than requested" };
  }
  return { ok: true };
}

// --- event stream ------------------------------------------------------------------

export type CodexEventState = {
  threadId: string | null;
  lastMessage: string | null;
  turnCompleted: boolean;
  turnFailed: string | null;
  errors: string[];
  inputTokens: number;
  outputTokens: number;
  sawUsage: boolean;
};

/** A fresh state for onCodexEvent. */
export function newCodexEventState(): CodexEventState {
  return {
    threadId: null,
    lastMessage: null,
    turnCompleted: false,
    turnFailed: null,
    errors: [],
    inputTokens: 0,
    outputTokens: 0,
    sawUsage: false,
  };
}

/** Folds one `codex exec --json` stdout line into `state`. Unknown lines are ignored. */
export function onCodexEvent(state: CodexEventState, line: string): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return; // not an event (a stray log line): ignored
  }
  if (!isPlainObject(event)) return;
  switch (event.type) {
    case "thread.started":
      state.threadId = str(event.thread_id) ?? state.threadId;
      return;
    case "item.completed": {
      const item = event.item;
      if (isPlainObject(item) && item.type === "agent_message" && typeof item.text === "string") {
        state.lastMessage = item.text;
      }
      return;
    }
    case "turn.completed": {
      state.turnCompleted = true;
      const usage = event.usage;
      if (isPlainObject(usage)) {
        if (typeof usage.input_tokens === "number") state.inputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === "number") state.outputTokens += usage.output_tokens;
        state.sawUsage = true;
      }
      return;
    }
    case "turn.failed": {
      const error = event.error;
      state.turnFailed =
        (isPlainObject(error) ? str(error.message) : null) ?? "Codex reported a failed turn.";
      return;
    }
    case "error":
      state.errors.push(str(event.message) ?? "Codex reported an error.");
      return;
    default:
      return; // unknown or future event types are tolerated
  }
}

// --- runner ------------------------------------------------------------------------

export type CodexRunnerOptions = {
  /** Absolute path to codex(.exe). Discovered when omitted. */
  executable?: string;
  /** Overrides CODEX_HOME / ~/.codex for locating the rollout. */
  codexHome?: string;
  spawnFn?: SpawnFn;
  /** Parent environment to scrub (defaults to process.env). */
  env?: EnvLike;
  defaultTimeoutMs?: number;
  /** How long to wait for the rollout file to appear after exit. */
  rolloutWaitMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CodexTeamRunner implements AgentRunner {
  readonly provider = "codex" as const;
  /** The rollout's turn_context records the sandbox Codex actually applied. */
  readonly verifiesAccess = true;
  readonly #options: CodexRunnerOptions;

  constructor(options: CodexRunnerOptions = {}) {
    this.#options = options;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const invalid = validateRequest(request, "codex");
    if (invalid) return invalid;

    const parentEnv = this.#options.env ?? process.env;
    const { env } = buildAgentEnv(parentEnv);
    const executable = this.#options.executable ?? findCodexExecutable({ env: parentEnv }).path;
    if (!executable) {
      return failResult(request, "The Codex CLI was not found on this machine.", "not_installed");
    }
    const codexHome = this.#options.codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");

    let tempDir: string | null = null;
    try {
      let schemaFile: string | undefined;
      if (request.outputSchema) {
        tempDir = mkdtempSync(join(tmpdir(), "threadlink-codex-"));
        schemaFile = join(tempDir, "output-schema.json");
        writeFileSync(schemaFile, JSON.stringify(request.outputSchema), { mode: 0o600 });
      }
      const args = buildCodexArgs(request, { schemaFile });
      const bad = forbiddenArg(args);
      if (bad) return failResult(request, `Refusing to run with ${bad}.`, "provider_error");

      const prompt = buildCodexPrompt(request);
      const viaStdin = prompt.length > CODEX_ARGV_PROMPT_LIMIT;
      args.push(viaStdin ? "-" : prompt);

      const state = newCodexEventState();
      const timeoutMs =
        request.timeoutMs ?? this.#options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      const outcome = await runProcess({
        spawnFn: this.#options.spawnFn ?? spawn,
        command: executable,
        args,
        cwd: request.cwd,
        env,
        stdinText: viaStdin ? prompt : null,
        timeoutMs,
        signal: request.signal,
        onStdoutLine: (line) => {
          onCodexEvent(state, line);
          if (request.onActivity) {
            // Only the event and item types are read (activity.ts), never text.
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            const activity = codexEventActivity(event, request.role);
            if (activity) request.onActivity(activity);
          }
        },
        hooks: request.onProcess,
      });
      const processError = processFailure(request, outcome, "Codex", timeoutMs);
      if (processError)
        return { ...processError, threadId: state.threadId, timings: outcome.timing };

      const text = state.lastMessage ?? "";
      const base: AgentRunResult = {
        ok: false,
        text,
        threadId: state.threadId,
        requestedModel: request.model,
        observedModel: null,
        observedEffort: null,
        accessVerified: false,
        permissionDenials: 0,
        usage: state.sawUsage
          ? { inputTokens: state.inputTokens, outputTokens: state.outputTokens }
          : undefined,
        timings: outcome.timing,
      };

      const failedTurn = state.turnFailed ?? (state.turnCompleted ? null : state.errors.at(-1));
      if (failedTurn || outcome.code !== 0 || !state.turnCompleted) {
        const diagnostics = [failedTurn, ...state.errors, outcome.stderr]
          .filter(Boolean)
          .join("\n");
        const failure = classifyFailureText(diagnostics) ?? "provider_error";
        return {
          ...base,
          error: `Codex failed (exit ${outcome.code ?? "?"}): ${tail(diagnostics) || "no detail"}`,
          failure,
          resetsAt: failure === "quota_exhausted" ? parseResetTime(diagnostics) : null,
        };
      }
      if (!state.threadId) {
        return { ...base, error: "Codex did not report a thread id.", failure: "provider_error" };
      }
      if (request.resumeThreadId && state.threadId !== request.resumeThreadId) {
        return {
          ...base,
          error: "Codex answered from a different thread than the one resumed.",
          failure: "provider_error",
        };
      }

      // Verify model and sandbox from the rollout's metadata lines.
      let rollout: string | null = null;
      const deadline = Date.now() + (this.#options.rolloutWaitMs ?? 3_000);
      for (;;) {
        rollout = findRolloutFile(codexHome, state.threadId);
        if (rollout || Date.now() >= deadline) break;
        await sleep(100);
      }
      if (!rollout) {
        return {
          ...base,
          error: "Codex's session record was not found, so the model that ran cannot be verified.",
          failure: "model_mismatch",
        };
      }
      let meta: RolloutMetadata;
      try {
        meta = await readRolloutMetadata(rollout);
      } catch {
        return {
          ...base,
          error: "Codex's session record could not be read; the run cannot be verified.",
          failure: "model_mismatch",
        };
      }
      const access = accessMatches(meta, request.access, request.cwd);
      const verified: AgentRunResult = {
        ...base,
        observedModel: meta.model,
        observedModels: meta.model ? [meta.model] : [],
        observedEffort: meta.effort,
        accessVerified: access.ok,
      };
      if (meta.model !== request.model) {
        return {
          ...verified,
          error: `Requested model ${request.model} but Codex ran ${meta.model ?? "an unreported model"}.`,
          failure: "model_mismatch",
        };
      }
      // The session record names exactly the model asked for.
      verified.modelVerified = true;
      if (!access.ok) {
        return {
          ...verified,
          error: `Access not as requested: ${access.why}.`,
          failure: "access_mismatch",
        };
      }
      if (request.outputSchema) {
        const structured = parseStructured(text, request.outputSchema);
        if (!structured.ok) {
          return { ...verified, error: structured.error, failure: "provider_error" };
        }
        return { ...verified, ok: true, structured: structured.value };
      }
      return { ...verified, ok: true };
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
