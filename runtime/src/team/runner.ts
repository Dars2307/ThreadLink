import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";

import type { RunActivity } from "./activity.ts";
import type { AgentProvider, TeamRole } from "./types.ts";

export type { AgentProvider } from "./types.ts";

/**
 * Agent runners (docs/design/team-mode.md §3.1).
 *
 * Team work is not "resume the user's conversation"; it is "run an agent in a
 * role, in a directory, with a model and a sandbox, and report exactly what
 * happened". Every runner satisfies, and is tested for, these invariants:
 *
 *   1. stdin is closed (EOF) — Codex blocks on an open stdin;
 *   2. the environment is scrubbed (./env.ts);
 *   3. access is explicit (never inherited from user config);
 *   4. never --bare, --fallback-model, a bypass or danger-full-access flag;
 *   5. observed model is compared to requested; mismatch → model_mismatch;
 *   6. observed access is compared to requested where the provider reports it;
 *   7. only metadata of a Codex rollout is read, never message content;
 *   8. quota exhaustion → quota_exhausted; nothing retries on another provider.
 */

export type RunAccess = "read-only" | "workspace-write";

export type AgentRunRequest = {
  provider: AgentProvider;
  role: TeamRole;
  /** A worktree; never the user's main checkout for writes. Absolute path. */
  cwd: string;
  prompt: string;
  /** Exact model id, never an unverified alias. */
  model: string;
  /** Provider effort / reasoning level. */
  effort?: string;
  access: RunAccess;
  /** JSON schema for a structured final answer. */
  outputSchema?: object;
  /** Continue this agent's own thread. */
  resumeThreadId?: string;
  /**
   * 0.11: "chat" is a Fast Chat turn (§3.4): the prompt wrapper says so and
   * does not ask the agent to go and read the project's rule files first.
   */
  purpose?: "team" | "chat";
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Real activity signals from the provider's own event stream, mapped to the
   * fixed enum in activity.ts. Never carries text. Called for every event, so
   * the caller rate-limits (ActivityReporter).
   */
  onActivity?: (activity: RunActivity) => void;
  /** The provider process this run started, and its exit: for the process registry. */
  onProcess?: ProcessHooks;
};

export type ProcessHooks = {
  started(child: ChildProcess): void;
  exited(pid: number): void;
};

export type AgentRunFailure =
  | "model_mismatch"
  | "access_mismatch"
  | "quota_exhausted"
  | "not_authenticated"
  | "not_installed"
  | "timeout"
  /** Stopped by ThreadLink (the owner's stop, or the job ending): not a provider failure. */
  | "cancelled"
  | "provider_error";

export type AgentRunResult = {
  ok: boolean;
  /** Final message. */
  text: string;
  /** Parsed per outputSchema, if requested and valid. */
  structured?: unknown;
  /** Provider-native id: metadata only, never a ThreadLink identity. */
  threadId: string | null;
  requestedModel: string;
  /** The model that did the work (for Claude: the one with most output tokens). */
  observedModel: string | null;
  /** Every model the provider reported using in this run, if it reports several. */
  observedModels?: string[];
  /**
   * Set by the runner only after it compared the observed model with the
   * requested one and they matched. Absent or false: not verified.
   */
  modelVerified?: boolean;
  observedEffort: string | null;
  /** The provider itself confirmed the sandbox we asked for. */
  accessVerified: boolean;
  /** Structured "needed approval" signal. */
  permissionDenials: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
  failure?: AgentRunFailure;
  /**
   * 0.11 (§5): when a quota failure's own output states when the limit resets,
   * that time (ISO). Null or absent when the provider did not say: never guessed.
   */
  resetsAt?: string | null;
  /** 0.11 (§3.6): process timings measured by ThreadLink. No prompt text. */
  timings?: ProcessTimings;
};

/** Milliseconds, measured around the provider process (§3.6). */
export type ProcessTimings = {
  /** spawn() called → the OS reported the child started. */
  spawnMs: number;
  /** Child started → its first byte on stdout (null when it printed nothing). */
  firstEventMs: number | null;
  /** spawn() called → the process exited (or was stopped). */
  providerMs: number;
};

export interface AgentRunner {
  readonly provider: AgentProvider;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;

/**
 * Roles that review someone else's work. They are always read-only: a reviewer
 * that wants a change files a finding (design §3.7 step 5).
 */
export const READ_ONLY_ROLES: ReadonlySet<TeamRole> = new Set([
  "reviewer",
  "security_reviewer",
  "test_reviewer",
]);

/**
 * Flags no Team run may ever carry, for either CLI. Checked on the final argv
 * as a last line of defence, independent of how the argv was built.
 */
const FORBIDDEN_FLAGS = new Set([
  "--bare",
  "--fallback-model",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--oss",
  "--ephemeral",
  "--yolo",
  "--full-auto",
  "--approve-for-me",
]);
const FORBIDDEN_VALUES = new Set(["danger-full-access", "bypassPermissions"]);

/** The forbidden element of `args`, or null when the argv is clean. */
export function forbiddenArg(args: readonly string[]): string | null {
  for (const arg of args) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (FORBIDDEN_FLAGS.has(flag)) return flag;
    for (const value of FORBIDDEN_VALUES) if (arg.includes(value)) return value;
  }
  return null;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;
const EFFORT = /^[a-z]{1,16}$/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejects a request before anything is spawned. Model, effort and thread id
 * go into argv, so they are validated strictly (no leading dash, no spaces).
 */
export function validateRequest(
  request: AgentRunRequest,
  provider: AgentProvider,
): AgentRunResult | null {
  const fail = (error: string, failure: AgentRunFailure = "provider_error") =>
    failResult(request, error, failure);
  if (request.provider !== provider) return fail(`This runner only runs ${provider}.`);
  if (!MODEL_ID.test(request.model)) return fail("Invalid model id.");
  if (request.effort !== undefined && !EFFORT.test(request.effort)) {
    return fail("Invalid effort level.");
  }
  if (request.access !== "read-only" && request.access !== "workspace-write") {
    return fail("Invalid access mode.", "access_mismatch");
  }
  if (READ_ONLY_ROLES.has(request.role) && request.access !== "read-only") {
    return fail(`The ${request.role} role is read-only.`, "access_mismatch");
  }
  if (request.resumeThreadId !== undefined && !THREAD_ID.test(request.resumeThreadId)) {
    return fail("Invalid thread id to resume.");
  }
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    return fail("Empty prompt.");
  }
  if (!isAbsolute(request.cwd)) return fail("The working directory must be an absolute path.");
  try {
    if (!statSync(request.cwd).isDirectory()) return fail("The working directory does not exist.");
  } catch {
    return fail("The working directory does not exist.");
  }
  if (request.outputSchema !== undefined && !isPlainObject(request.outputSchema)) {
    return fail("The output schema must be a JSON object.");
  }
  return null;
}

export function failResult(
  request: Pick<AgentRunRequest, "model">,
  error: string,
  failure: AgentRunFailure,
  extra: Partial<AgentRunResult> = {},
): AgentRunResult {
  return {
    ok: false,
    text: "",
    threadId: null,
    requestedModel: request.model,
    observedModel: null,
    observedEffort: null,
    accessVerified: false,
    permissionDenials: 0,
    ...extra,
    error,
    failure,
  };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- failure classification -------------------------------------------------

const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate[ -]?limit/i,
  /limit reached/i,
  /exceeded your/i,
  /hit your (?:usage )?limit/i,
  /\b429\b/,
  /too many requests/i,
  /insufficient[_ ]quota/i,
  // Seen for real on Codex 0.158 (0.11 benchmark): a ChatGPT workspace with no
  // credits left. Included usage is spent; ThreadLink never adds credits.
  /out of credits/i,
];
const AUTH_PATTERNS = [
  /not logged in/i,
  /please (?:run \/login|log ?in|sign in)/i,
  /\blogin required\b/i,
  /invalid api key/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /authentication (?:failed|required|error)/i,
  /oauth token (?:has )?expired/i,
  // 0.9 (docs/design/chat-first.md §2). A real run failed with "Failed to refresh
  // OAuth token" while `claude auth status` still said loggedIn: true.
  /failed to refresh oauth/i,
  /refresh[ _-]?token/i,
  /oauth\b.{0,80}\b(?:expired|invalid|revoked)/i,
  /please run .{0,40}login/i,
  /session (?:has )?expired/i,
  /\bre-?authenticate\b/i,
  // Codex's sign-in failures.
  /\bcodex login\b/i,
  /not signed in/i,
  /\btoken\b.{0,40}\bexpired\b/i,
];

/**
 * Classifies FAILURE output only. Never call this on a successful answer: an
 * agent reviewing rate-limit code would otherwise "exhaust" its own quota.
 */
export function classifyFailureText(text: string): "quota_exhausted" | "not_authenticated" | null {
  if (QUOTA_PATTERNS.some((p) => p.test(text))) return "quota_exhausted";
  if (AUTH_PATTERNS.some((p) => p.test(text))) return "not_authenticated";
  return null;
}

// --- reset time (0.11 §5) -----------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset (ms) of an IANA zone from UTC at `utcMs`, or null when the zone is unknown. */
function zoneOffsetMs(zone: string, utcMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The UTC instant of a wall-clock time in `zone` (null zone = this computer's local time). */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  zone: string | null,
): number | null {
  if (!zone) return new Date(y, mo, d, h, mi, 0, 0).getTime();
  const guess = Date.UTC(y, mo, d, h, mi, 0, 0);
  const off1 = zoneOffsetMs(zone, guess);
  if (off1 === null) return null;
  const first = guess - off1;
  const off2 = zoneOffsetMs(zone, first);
  return off2 === null ? first : guess - off2;
}

/** "3pm", "3:45 PM", "15:00" → [hour, minute], or null. */
function parseClock(text: string): [number, number] | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (!m[2] || hour > 23) {
    return null; // a bare number is not a time
  }
  return [hour, minute];
}

/** The calendar date of `utcMs` as seen in `zone` (or locally). */
function dateIn(utcMs: number, zone: string | null): [number, number, number] {
  if (!zone) {
    const d = new Date(utcMs);
    return [d.getFullYear(), d.getMonth(), d.getDate()];
  }
  const off = zoneOffsetMs(zone, utcMs) ?? 0;
  const d = new Date(utcMs + off);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/**
 * When a quota failure message says the limit resets, that instant (ISO).
 * Only what the provider actually printed is used; anything that cannot be
 * read exactly is null, never an estimate. Understood forms:
 *   Claude Code  "… limit reached|1767225600" (epoch seconds),
 *                "… · resets 3pm (Europe/London)", "resets Oct 3, 5pm", "resets 5:30am"
 *   Codex        "… try again at 3:45 PM.", "try again at Oct 3rd, 2026 5:12 PM",
 *                "try again in 2 hours 5 minutes" / "in 3 days"
 * A time without a date is the next occurrence of that time.
 */
export function parseResetTime(text: string, now: number = Date.now()): string | null {
  if (!text) return null;
  const iso = (ms: number | null) =>
    ms !== null && Number.isFinite(ms) && ms > now - 60_000 && ms < now + 60 * 86_400_000
      ? new Date(ms).toISOString()
      : null;

  // Claude Code's machine-readable form: "limit reached|<epoch seconds>".
  const epoch = /limit reached\s*\|\s*(\d{10})\b/i.exec(text);
  if (epoch) return iso(Number(epoch[1]) * 1000);

  // Relative: "try again in 2 hours 5 minutes", "resets in 45 minutes".
  const relative =
    /(?:try again|resets?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(
      text,
    );
  if (relative) {
    let ms = 0;
    for (const part of relative[1]!.matchAll(
      /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
    )) {
      const n = Number(part[1]);
      const unit = part[2]!.toLowerCase();
      ms +=
        n *
        (unit.startsWith("d")
          ? 86_400_000
          : unit.startsWith("h")
            ? 3_600_000
            : unit.startsWith("m")
              ? 60_000
              : 1_000);
    }
    return ms > 0 ? iso(now + ms) : null;
  }

  // Absolute: "resets <when> (<zone>)" or "try again at <when>".
  const absolute =
    /\bresets?\s+(?:at\s+)?([A-Za-z0-9 ,:.]+?)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?(?=[.;\n|·]|$)/i.exec(
      text,
    ) ??
    /\btry again at\s+([A-Za-z0-9 ,:.]+?)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?(?=\.(?:\s|$)|[;\n|·]|$)/i.exec(
      text,
    );
  if (!absolute) return null;
  const when = absolute[1]!.trim().replace(/\.$/, "");
  const zone = absolute[2] ?? null;
  if (zone && zoneOffsetMs(zone, now) === null) return null;

  // "<Mon> <day>[st|nd|rd|th][,] [<year>][,] <clock>" or just "<clock>".
  const dated =
    /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?(.+)$/i.exec(
      when,
    );
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    const clock = parseClock(dated[4]!);
    if (month < 0 || !clock) return null;
    const day = Number(dated[2]);
    let year = dated[3] ? Number(dated[3]) : dateIn(now, zone)[0];
    let at = wallClockToUtc(year, month, day, clock[0], clock[1], zone);
    if (!dated[3] && at !== null && at < now - 60_000) {
      year += 1;
      at = wallClockToUtc(year, month, day, clock[0], clock[1], zone);
    }
    return iso(at);
  }
  const clock = parseClock(when);
  if (!clock) return null;
  const [y, mo, d] = dateIn(now, zone);
  let at = wallClockToUtc(y, mo, d, clock[0], clock[1], zone);
  if (at !== null && at <= now) at = wallClockToUtc(y, mo, d + 1, clock[0], clock[1], zone);
  return iso(at);
}

// --- structured output --------------------------------------------------------

/**
 * Parses a final answer as the JSON object a schema asked for. Tolerates one
 * fenced ```json block around it. Never invents a structure: anything that is
 * not a JSON object, or lacks a key the schema marks `required`, is an error.
 */
export function parseStructured(
  text: string,
  schema: object,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(body);
  if (fenced?.[1] !== undefined) body = fenced[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: "The agent's final answer was not valid JSON." };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: "The agent's final answer was not a JSON object." };
  }
  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const missing = required.filter((k) => typeof k === "string" && !(k in value));
    if (missing.length) {
      return {
        ok: false,
        error: `The agent's final answer is missing required keys: ${missing.join(", ")}.`,
      };
    }
  }
  return { ok: true, value };
}

// --- process handling ---------------------------------------------------------

export type SpawnFn = typeof spawn;

/**
 * Kills a child and everything it started. Windows: `taskkill /T /F` (the
 * agents spawn shells and tools of their own). Elsewhere the child is started
 * in its own process group, which is killed as a whole.
 */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  // Already gone: its pid may belong to something else by now. Never kill it.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        const timer = setTimeout(() => resolve(), 10_000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish();
        });
        killer.on("close", finish);
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

export type ProcessOutcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** ENOENT and friends: the executable could not be started. */
  spawnError: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** 0.11 (§3.6): measured around the process. */
  timing?: ProcessTimings;
};

export type RunProcessOptions = {
  spawnFn: SpawnFn;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, which is then closed. null → stdin is never opened. */
  stdinText: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called per complete stdout line; stdout is then not accumulated. */
  onStdoutLine?: (line: string) => void;
  /** The process ThreadLink started, and its exit (process registry). */
  hooks?: ProcessHooks;
};

const MAX_CAPTURE = 8 * 1024 * 1024;

/** Spawns without a shell, captures output, enforces timeout/abort by killing the tree. */
export function runProcess(options: RunProcessOptions): Promise<ProcessOutcome> {
  const { spawnFn, command, args, cwd, env, stdinText, timeoutMs, signal, onStdoutLine, hooks } =
    options;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let partial = "";
    let timedOut = false;
    let aborted = false;
    const timers: { timeout?: ReturnType<typeof setTimeout> } = {};
    let child: ChildProcess;
    const t0 = performance.now();
    let tSpawned: number | null = null;
    let tFirst: number | null = null;
    const timing = (): ProcessTimings => {
      const end = performance.now();
      const spawned = tSpawned ?? end;
      return {
        spawnMs: Math.max(0, Math.round(spawned - t0)),
        firstEventMs: tFirst === null ? null : Math.max(0, Math.round(tFirst - spawned)),
        providerMs: Math.max(0, Math.round(end - t0)),
      };
    };

    const finish = (
      outcome: Omit<ProcessOutcome, "stdout" | "stderr" | "timedOut" | "aborted">,
    ) => {
      if (settled) return;
      settled = true;
      if (child?.pid) {
        try {
          hooks?.exited(child.pid);
        } catch {
          /* the registry is advisory */
        }
      }
      if (timers.timeout) clearTimeout(timers.timeout);
      signal?.removeEventListener("abort", onAbort);
      if (onStdoutLine && partial.trim()) onStdoutLine(partial);
      resolve({ ...outcome, stdout, stderr, timedOut, aborted, timing: timing() });
    };
    const stop = (why: "timeout" | "abort") => {
      if (settled) return;
      if (why === "timeout") timedOut = true;
      else aborted = true;
      void killTree(child).then(() => finish({ code: null, spawnError: null }));
    };
    const onAbort = () => stop("abort");

    if (signal?.aborted) {
      aborted = true;
      finish({ code: null, spawnError: null });
      return;
    }

    const spawnOptions: SpawnOptions = {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== "win32",
    };
    try {
      child = spawnFn(command, args, spawnOptions);
    } catch (error) {
      finish({ code: null, spawnError: error instanceof Error ? error.message : "spawn failed" });
      return;
    }
    child.once?.("spawn", () => {
      tSpawned ??= performance.now();
    });
    if (child.pid) {
      try {
        hooks?.started(child);
      } catch {
        /* the registry is advisory; stopping still goes through this function */
      }
    }

    child.stdout?.on("data", (d: Buffer) => {
      if (tFirst === null) {
        tFirst = performance.now();
        tSpawned ??= tFirst;
      }
      const chunk = d.toString("utf8");
      if (onStdoutLine) {
        partial += chunk;
        let nl = partial.indexOf("\n");
        while (nl >= 0) {
          const line = partial.slice(0, nl);
          partial = partial.slice(nl + 1);
          if (line.trim()) onStdoutLine(line);
          nl = partial.indexOf("\n");
        }
        if (partial.length > MAX_CAPTURE) partial = "";
      } else if (stdout.length < MAX_CAPTURE) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      // Keep the tail: errors come last.
      if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE / 2);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, spawnError: error.code ?? error.message });
    });
    child.on("close", (code) => {
      if (timedOut || aborted) return; // stop() settles after the tree is gone
      finish({ code, spawnError: null });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    timers.timeout = setTimeout(() => stop("timeout"), timeoutMs);

    if (child.stdin) {
      child.stdin.on("error", () => {
        /* the child exited before reading; its exit code tells the story */
      });
      child.stdin.end(stdinText ?? "");
    }
  });
}

/** Common mapping of a process-level failure (not a provider answer). */
export function processFailure(
  request: Pick<AgentRunRequest, "model">,
  outcome: ProcessOutcome,
  label: string,
  timeoutMs: number,
): AgentRunResult | null {
  if (outcome.spawnError) {
    return failResult(
      request,
      `${label} could not be started (${outcome.spawnError}). Is it installed?`,
      outcome.spawnError === "ENOENT" || outcome.spawnError === "EACCES"
        ? "not_installed"
        : "provider_error",
    );
  }
  if (outcome.aborted) return failResult(request, `${label} run was stopped.`, "cancelled");
  if (outcome.timedOut) {
    return failResult(
      request,
      `${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds; it was stopped.`,
      "timeout",
    );
  }
  return null;
}

/** A short, single-line tail of provider diagnostics for an error message. */
export function tail(text: string, max = 400): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `…${t.slice(-max)}` : t;
}
