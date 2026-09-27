import { spawn } from "node:child_process";

import { parseClaudeOutput } from "../../executor.ts";
import { buildAgentEnv, type EnvLike } from "../env.ts";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  classifyFailureText,
  failResult,
  forbiddenArg,
  isPlainObject,
  parseStructured,
  processFailure,
  runProcess,
  tail,
  validateRequest,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type SpawnFn,
} from "../runner.ts";

/**
 * Claude Code as a Team agent (official headless print mode only).
 *
 *   claude -p [--resume <session>] --output-format json --model <id> [--effort <e>]
 *          --safe-mode --permission-mode plan|acceptEdits --permission-prompts none
 *          [--disallowed-tools Edit,Write,NotebookEdit]           (read-only only)
 *
 * The prompt goes on stdin, which is then closed. Why each flag:
 *   --safe-mode           no user CLAUDE.md, hooks, plugins, skills or MCP servers: the
 *                         run's capabilities are ThreadLink's choice, not inherited. Auth
 *                         and model selection still work (verified on 2.1.266). Project
 *                         rules are therefore passed through the prompt instead.
 *   --permission-mode     plan for read-only, acceptEdits for workspace-write.
 *   --permission-prompts none
 *                         nobody is there to answer; a prompt is a denial, reported in
 *                         `permission_denials` (→ permissionDenials).
 *   --disallowed-tools    belt and braces on read-only runs. Bash is not listed: plan
 *                         mode already refuses non-read-only commands and a partial
 *                         denylist of shell patterns would only suggest false safety.
 * Never: --bare (forces API-key billing), --fallback-model (silent substitution),
 * --dangerously-skip-permissions, bypassPermissions.
 *
 * Model: `modelUsage` names the model(s) that actually ran. `--model haiku` has been
 * seen to run claude-sonnet-5 without complaint, so the primary observed model (most
 * output tokens) must match the request or the run fails with model_mismatch.
 *
 * Access: Claude's JSON result does not echo the permission mode, so
 * `accessVerified` is always false for Claude. Enforcement rests on the flags above.
 */

/**
 * Aliases ThreadLink has itself observed resolving (docs/design/team-mode.md §0).
 * Deliberately tiny: `haiku` is NOT here because it was observed running Sonnet.
 * Callers should pass exact ids anyway.
 */
export const CLAUDE_VERIFIED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  sonnet: ["claude-sonnet-5"],
};

const READ_ONLY_DISALLOWED = ["Edit", "Write", "NotebookEdit"] as const;

/** Removes a context-window marker such as `[1m]` that some ids carry. */
function baseModelId(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

export function claudeModelMatches(requested: string, observed: string): boolean {
  const want = baseModelId(requested);
  const got = baseModelId(observed);
  if (want === got) return true;
  // A dated snapshot of exactly the requested undated id is the same model.
  if (got.startsWith(`${want}-`) && /^\d{8}$/.test(got.slice(want.length + 1))) return true;
  return CLAUDE_VERIFIED_ALIASES[want]?.includes(got) ?? false;
}

export function buildClaudeArgs(request: AgentRunRequest): string[] {
  const args = ["-p"];
  if (request.resumeThreadId) args.push("--resume", request.resumeThreadId);
  args.push("--output-format", "json", "--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  args.push("--safe-mode");
  if (request.access === "read-only") {
    args.push("--permission-mode", "plan", "--permission-prompts", "none");
    args.push("--disallowed-tools", READ_ONLY_DISALLOWED.join(","));
  } else {
    args.push("--permission-mode", "acceptEdits", "--permission-prompts", "none");
  }
  // Verified against Claude Code 2.1.266: --json-schema makes Claude validate
  // its own final answer and return it as `structured_output`. Asking for JSON
  // in the prompt alone was not reliable -- a real run got prose back.
  if (request.outputSchema) args.push("--json-schema", JSON.stringify(request.outputSchema));
  return args;
}

export function buildClaudePrompt(request: AgentRunRequest): string {
  const lines = [
    `[ThreadLink Team Mode] You are the ${request.role} in a ThreadLink team run (Claude Code, headless).`,
    request.access === "read-only"
      ? "Access: READ-ONLY. Do not modify any file."
      : "Access: you may edit files inside this working directory only.",
    "Project rules are not loaded automatically in this run: before you start, read CLAUDE.md and",
    "AGENTS.md in the working directory (and their imports) if they exist, and follow them.",
    "",
    request.prompt,
  ];
  if (request.outputSchema) {
    lines.push(
      "",
      "Your FINAL message must be exactly one JSON object that conforms to this JSON Schema,",
      "with no prose before or after it (a single ```json fenced block is acceptable):",
      JSON.stringify(request.outputSchema),
    );
  }
  return lines.join("\n");
}

type ModelUsageEntry = { outputTokens?: unknown };

/** Primary = most output tokens; all = every key, primary first. */
export function observedClaudeModels(modelUsage: unknown): {
  primary: string | null;
  all: string[];
} {
  if (!isPlainObject(modelUsage)) return { primary: null, all: [] };
  const entries = Object.entries(modelUsage).map(([id, entry]) => {
    const out = isPlainObject(entry) ? (entry as ModelUsageEntry).outputTokens : undefined;
    return { id, out: typeof out === "number" ? out : 0 };
  });
  entries.sort((a, b) => b.out - a.out || a.id.localeCompare(b.id));
  return { primary: entries[0]?.id ?? null, all: entries.map((e) => e.id) };
}

export type ClaudeRunnerOptions = {
  /** Executable; defaults to `claude` on PATH. */
  command?: string;
  spawnFn?: SpawnFn;
  /** Parent environment to scrub (defaults to process.env). */
  env?: EnvLike;
  defaultTimeoutMs?: number;
};

type ClaudeJson = {
  result?: unknown;
  /** Present when --json-schema was given: validated by Claude Code itself. */
  structured_output?: unknown;
  is_error?: unknown;
  session_id?: unknown;
  modelUsage?: unknown;
  permission_denials?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
};

export class ClaudeTeamRunner implements AgentRunner {
  readonly provider = "claude-code" as const;
  /** Claude Code's output does not report the permission mode it ran with. */
  readonly verifiesAccess = false;
  readonly #command: string;
  readonly #spawn: SpawnFn;
  readonly #env?: EnvLike;
  readonly #timeoutMs: number;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#spawn = options.spawnFn ?? spawn;
    this.#env = options.env;
    this.#timeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const invalid = validateRequest(request, "claude-code");
    if (invalid) return invalid;
    const args = buildClaudeArgs(request);
    const bad = forbiddenArg(args);
    if (bad) return failResult(request, `Refusing to run with ${bad}.`, "provider_error");

    const timeoutMs = request.timeoutMs ?? this.#timeoutMs;
    const outcome = await runProcess({
      spawnFn: this.#spawn,
      command: this.#command,
      args,
      cwd: request.cwd,
      env: buildAgentEnv(this.#env ?? process.env).env,
      stdinText: buildClaudePrompt(request),
      timeoutMs,
      signal: request.signal,
      hooks: request.onProcess,
    });
    const processError = processFailure(request, outcome, "Claude Code", timeoutMs);
    if (processError) return processError;

    const parsed = parseClaudeOutput(outcome.stdout) as ClaudeJson | null;
    if (!parsed) {
      const diagnostics = `${outcome.stderr}\n${outcome.stdout}`;
      return failResult(
        request,
        `Claude Code exited with code ${outcome.code ?? "?"} without a JSON result: ${tail(diagnostics) || "no output"}`,
        classifyFailureText(diagnostics) ?? "provider_error",
      );
    }

    const text = typeof parsed.result === "string" ? parsed.result : "";
    const threadId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    const { primary, all } = observedClaudeModels(parsed.modelUsage);
    const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0;
    const inputTokens = parsed.usage?.input_tokens;
    const outputTokens = parsed.usage?.output_tokens;
    const base: AgentRunResult = {
      ok: false,
      text,
      threadId,
      requestedModel: request.model,
      observedModel: primary,
      observedModels: all,
      observedEffort: null,
      accessVerified: false,
      permissionDenials: denials,
      usage: {
        inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
        outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
      },
    };

    if (parsed.is_error === true || outcome.code !== 0) {
      const diagnostics = `${text}\n${outcome.stderr}`;
      return {
        ...base,
        error: `Claude Code reported an error (exit ${outcome.code ?? "?"}): ${tail(diagnostics) || "no detail"}`,
        failure: classifyFailureText(diagnostics) ?? "provider_error",
      };
    }
    if (!primary) {
      return {
        ...base,
        error: "Claude Code did not report which model ran; the result cannot be verified.",
        failure: "model_mismatch",
      };
    }
    if (!claudeModelMatches(request.model, primary)) {
      return {
        ...base,
        error: `Requested model ${request.model} but Claude Code ran ${primary}.`,
        failure: "model_mismatch",
      };
    }
    // From here on the model that ran is the one asked for.
    const verified: AgentRunResult = { ...base, modelVerified: true };
    if (request.resumeThreadId && threadId !== request.resumeThreadId) {
      return {
        ...verified,
        error: "Claude Code answered from a different session than the one resumed.",
        failure: "provider_error",
      };
    }
    if (request.outputSchema) {
      // Prefer the answer Claude Code validated against the schema; fall back
      // to parsing the final message only if it did not provide one.
      if (isPlainObject(parsed.structured_output)) {
        return { ...verified, ok: true, structured: parsed.structured_output };
      }
      const structured = parseStructured(text, request.outputSchema);
      if (!structured.ok)
        return { ...verified, error: structured.error, failure: "provider_error" };
      return { ...verified, ok: true, structured: structured.value };
    }
    return { ...verified, ok: true };
  }
}
