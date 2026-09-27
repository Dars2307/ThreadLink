/**
 * The Runtime's own memory of what it started (docs/design/threadlink-0.10.md §5, §6).
 *
 *   - ProcessRegistry: every provider process ThreadLink launched, in memory
 *     (with the handle needed to stop it) and in configDir (pid, provider,
 *     run, job, start time -- for crash classification only). Stopping only
 *     ever goes through the in-memory handles of processes this Runtime
 *     started now. A pid read back from the file is never killed: after a
 *     crash that pid may belong to anything.
 *
 *   - JobJournal: one small file per team job this Runtime is running,
 *     rewritten at every step boundary: which step is running and whether it
 *     can write files, whether any write step has started, and the final
 *     verdict once computed and whether the server has it.
 *
 *   - classifyRecovery: what a journal left behind by a Runtime that is no
 *     longer running means (§6): completed_unsynced (resend the verdict),
 *     resumable (nothing that writes was running or has run: continue),
 *     interrupted (a write step was running, or has run: never re-run it
 *     automatically; the owner decides).
 *
 * Journals and the registry hold ids, step kinds and verdict payloads only:
 * never prompts, agent output or credentials.
 */

import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { StepKind } from "./activity.ts";
import { killTree } from "./runner.ts";

const JOB_ID = /^tljob_[0-9a-f]{32}$/;

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process registry
// ---------------------------------------------------------------------------

export type ProcessEntry = {
  pid: number;
  provider: string;
  runId: string | null;
  jobId: string;
  startedAt: string;
};

type LiveEntry = ProcessEntry & { child: ChildProcess };

export const PROCESS_REGISTRY_FILE = "team-processes.json";

export class ProcessRegistry {
  readonly #file: string | null;
  readonly #live = new Map<number, LiveEntry>();

  /** `configDir` null: memory only (tests, embedded engines). */
  constructor(configDir: string | null) {
    this.#file = configDir ? join(configDir, PROCESS_REGISTRY_FILE) : null;
  }

  /**
   * Entries a previous Runtime left behind (it did not exit cleanly), for
   * classification only. Reading them clears the file: they are never acted
   * on as processes.
   */
  takeStale(): ProcessEntry[] {
    if (!this.#file) return [];
    const raw = readJson(this.#file) as { runtimePid?: unknown; entries?: unknown } | null;
    const stale: ProcessEntry[] = [];
    if (raw && raw.runtimePid !== process.pid && Array.isArray(raw.entries)) {
      for (const e of raw.entries) stale.push(...parseEntry(e));
    }
    this.#persist();
    return stale;
  }

  started(entry: ProcessEntry, child: ChildProcess): void {
    this.#live.set(entry.pid, { ...entry, child });
    this.#persist();
  }

  exited(pid: number): void {
    if (this.#live.delete(pid)) this.#persist();
  }

  /** What is running now, without the process handles. */
  list(jobId?: string): ProcessEntry[] {
    return [...this.#live.values()]
      .filter((e) => !jobId || e.jobId === jobId)
      .map((e) => ({
        pid: e.pid,
        provider: e.provider,
        runId: e.runId,
        jobId: e.jobId,
        startedAt: e.startedAt,
      }));
  }

  /**
   * Kills the process trees of one job that THIS Runtime started and that are
   * still running. Nothing else is ever killed.
   */
  async killJob(jobId: string): Promise<number> {
    const targets = [...this.#live.values()].filter((e) => e.jobId === jobId);
    await Promise.all(targets.map((e) => killTree(e.child)));
    for (const e of targets) this.#live.delete(e.pid);
    if (targets.length) this.#persist();
    return targets.length;
  }

  #persist(): void {
    if (!this.#file) return;
    try {
      mkdirSync(join(this.#file, ".."), { recursive: true });
      writeJson(this.#file, { runtimePid: process.pid, entries: this.list() });
    } catch {
      /* the registry file is advisory; the in-memory handles are what stop processes */
    }
  }
}

function parseEntry(value: unknown): ProcessEntry[] {
  if (!value || typeof value !== "object") return [];
  const e = value as Record<string, unknown>;
  if (typeof e.pid !== "number" || typeof e.jobId !== "string" || !JOB_ID.test(e.jobId)) return [];
  return [
    {
      pid: e.pid,
      provider: typeof e.provider === "string" ? e.provider.slice(0, 40) : "unknown",
      runId: typeof e.runId === "string" ? e.runId.slice(0, 80) : null,
      jobId: e.jobId,
      startedAt: typeof e.startedAt === "string" ? e.startedAt.slice(0, 40) : "",
    },
  ];
}

// ---------------------------------------------------------------------------
// Job journal
// ---------------------------------------------------------------------------

export type JournalStep = {
  runKey: string;
  kind: StepKind;
  /** The step can change files (a build or fix). */
  write: boolean;
  provider: string;
  startedAt: string;
};

export type JobJournalState = {
  version: 1;
  jobId: string;
  /** The Runtime process that wrote it. */
  runtimePid: number;
  /** How many times this job has been (re)started on this computer. */
  attempt: number;
  phase: string;
  activeSteps: JournalStep[];
  /** A write step has started at some point in this job. */
  writeStarted: boolean;
  /** The last read-only step that finished, for "resume from last safe step". */
  lastSafeStep: string | null;
  /** set_final payload once the verdict is known. */
  final: Record<string, unknown> | null;
  finalSynced: boolean;
  /** The controller's report, kept so a synced job is never run again. */
  report: string | null;
  updatedAt: string;
  /**
   * The journal file exists but could not be read. Nothing it said can be
   * trusted, so it is treated as the worst case: interrupted (fail closed).
   */
  unreadable?: boolean;
};

export type JobJournal = {
  readonly state: JobJournalState;
  phase(phase: string): void;
  stepStarted(step: JournalStep): void;
  stepFinished(runKey: string, safe: boolean): void;
  finalComputed(payload: Record<string, unknown>): void;
  finalSynced(report: string | null): void;
  /** The job is fully done and synced: the journal can go. */
  close(): void;
};

export const JOURNAL_DIR = "team-jobs";

function emptyState(jobId: string, attempt: number): JobJournalState {
  return {
    version: 1,
    jobId,
    runtimePid: process.pid,
    attempt,
    phase: "queued",
    activeSteps: [],
    writeStarted: false,
    lastSafeStep: null,
    final: null,
    finalSynced: false,
    report: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Parses a journal file strictly; anything malformed is treated as absent. */
export function parseJournal(value: unknown): JobJournalState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.jobId !== "string" || !JOB_ID.test(v.jobId)) return null;
  const steps = Array.isArray(v.activeSteps)
    ? v.activeSteps.flatMap((s): JournalStep[] => {
        if (!s || typeof s !== "object") return [];
        const st = s as Record<string, unknown>;
        if (typeof st.runKey !== "string" || typeof st.kind !== "string") return [];
        return [
          {
            runKey: st.runKey,
            kind: st.kind as StepKind,
            write: st.write === true,
            provider: typeof st.provider === "string" ? st.provider : "unknown",
            startedAt: typeof st.startedAt === "string" ? st.startedAt : "",
          },
        ];
      })
    : [];
  return {
    version: 1,
    jobId: v.jobId,
    runtimePid: typeof v.runtimePid === "number" ? v.runtimePid : -1,
    attempt: typeof v.attempt === "number" && v.attempt >= 1 ? Math.floor(v.attempt) : 1,
    phase: typeof v.phase === "string" ? v.phase : "queued",
    activeSteps: steps,
    writeStarted: v.writeStarted === true || steps.some((s) => s.write),
    lastSafeStep: typeof v.lastSafeStep === "string" ? v.lastSafeStep : null,
    final:
      v.final && typeof v.final === "object" && !Array.isArray(v.final)
        ? (v.final as Record<string, unknown>)
        : null,
    finalSynced: v.finalSynced === true,
    report: typeof v.report === "string" ? v.report : null,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

/** Journals in configDir (or memory). */
export class JournalStore {
  readonly #dir: string | null;
  readonly #memory = new Map<string, JobJournalState>();

  constructor(configDir: string | null) {
    this.#dir = configDir ? join(configDir, JOURNAL_DIR) : null;
  }

  /**
   * The journal for a job: null only when there is none. A file that exists
   * but cannot be read or parsed is returned as an `unreadable` journal,
   * never as "no journal": that would let a crashed job start over (§6).
   */
  read(jobId: string): JobJournalState | null {
    if (!JOB_ID.test(jobId)) return null;
    if (!this.#dir) return this.#memory.get(jobId) ?? null;
    const file = join(this.#dir, `${jobId}.json`);
    if (!existsSync(file)) return null;
    return parseJournal(readJson(file)) ?? unreadableJournal(jobId);
  }

  list(): JobJournalState[] {
    if (!this.#dir) return [...this.#memory.values()];
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .filter((n) => /^tljob_[0-9a-f]{32}\.json$/.test(n))
      .map(
        (n) =>
          parseJournal(readJson(join(this.#dir!, n))) ??
          unreadableJournal(n.replace(/\.json$/, "")),
      );
  }

  #save(state: JobJournalState): void {
    state.updatedAt = new Date().toISOString();
    if (!this.#dir) {
      this.#memory.set(state.jobId, structuredClone(state));
      return;
    }
    mkdirSync(this.#dir, { recursive: true });
    writeJson(join(this.#dir, `${state.jobId}.json`), state);
  }

  #remove(jobId: string): void {
    if (!this.#dir) {
      this.#memory.delete(jobId);
      return;
    }
    rmSync(join(this.#dir, `${jobId}.json`), { force: true });
  }

  /** Opens (or re-opens, with the next attempt number) this job's journal for this process. */
  open(jobId: string, previous: JobJournalState | null = null): JobJournal {
    // A write step that ever ran in this job stays on record across attempts:
    // a later crash is then still an interruption, never a fresh start.
    const state: JobJournalState = previous
      ? {
          ...emptyState(jobId, previous.attempt + 1),
          writeStarted: previous.writeStarted || previous.unreadable === true,
        }
      : emptyState(jobId, 1);
    const save = () => this.#save(state);
    save();
    return {
      state,
      phase: (phase) => {
        state.phase = phase;
        save();
      },
      stepStarted: (step) => {
        state.activeSteps.push(step);
        if (step.write) state.writeStarted = true;
        save();
      },
      stepFinished: (runKey, safe) => {
        state.activeSteps = state.activeSteps.filter((s) => s.runKey !== runKey);
        if (safe) state.lastSafeStep = runKey;
        save();
      },
      finalComputed: (payload) => {
        state.final = payload;
        state.finalSynced = false;
        save();
      },
      finalSynced: (report) => {
        state.finalSynced = true;
        state.report = report;
        save();
      },
      close: () => this.#remove(jobId),
    };
  }
}

// ---------------------------------------------------------------------------
// Recovery classification
// ---------------------------------------------------------------------------

export type RecoveryClass =
  /** The verdict was computed but the server may not have it: resend it. */
  | "completed_unsynced"
  /** The verdict reached the server: nothing to run. The job is not run twice. */
  | "completed"
  /** Nothing that writes was running or had run: continue (re-run read-only steps). */
  | "resumable"
  /** A write step was running, or had run: never re-run automatically. */
  | "interrupted";

export type RecoveryReport = {
  jobId: string;
  classification: RecoveryClass;
  phase: string;
  attempt: number;
  /** The write step that was running, when there was one. */
  runningWriteStep: { kind: StepKind; provider: string } | null;
  lastSafeStep: string | null;
  /** Provider processes the dead Runtime had registered for this job (not touched). */
  orphanedProcesses: number;
};

/**
 * Pure. `journal` is what a Runtime that is no longer running left behind;
 * `stale` is its process registry. A journal written by THIS process is not a
 * crash and must not be passed here.
 */
export function classifyRecovery(
  journal: JobJournalState,
  stale: readonly ProcessEntry[] = [],
): RecoveryReport {
  const orphaned = stale.filter((p) => p.jobId === journal.jobId).length;
  const runningWrite = journal.activeSteps.find((s) => s.write) ?? null;
  let classification: RecoveryClass;
  if (journal.final && journal.finalSynced) classification = "completed";
  else if (journal.final) classification = "completed_unsynced";
  else if (runningWrite || journal.writeStarted || journal.unreadable) {
    classification = "interrupted";
  } else classification = "resumable";
  return {
    jobId: journal.jobId,
    classification,
    phase: journal.phase,
    attempt: journal.attempt,
    runningWriteStep: runningWrite
      ? { kind: runningWrite.kind, provider: runningWrite.provider }
      : null,
    lastSafeStep: journal.lastSafeStep,
    orphanedProcesses: orphaned,
  };
}

function unreadableJournal(jobId: string): JobJournalState {
  return {
    ...emptyState(jobId, 1),
    runtimePid: -1,
    phase: "unknown",
    writeStarted: true,
    unreadable: true,
    updatedAt: "",
  };
}

/** How long a journal counts as live while its process exists (the longest step, 120 min). */
export const JOURNAL_LIVE_MS = 125 * 60_000;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when a journal was left by a Runtime process that is gone: a crash to
 * recover from. A journal of THIS process, or of another Runtime process that
 * is still running and wrote it recently (two Runtimes sharing a config
 * directory), is not a crash.
 */
export function leftByAnotherProcess(
  journal: JobJournalState,
  alive: (pid: number) => boolean = processAlive,
  now: number = Date.now(),
): boolean {
  if (journal.unreadable) return true;
  if (journal.runtimePid === process.pid) return false;
  const recent = now - Date.parse(journal.updatedAt) < JOURNAL_LIVE_MS;
  return !(recent && alive(journal.runtimePid));
}
