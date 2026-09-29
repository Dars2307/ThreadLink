/**
 * Git worktrees for Team Mode.
 *
 * Each unit of work gets its own worktree on its own branch, so two agents can
 * build at the same time without writing into each other's files, and the
 * user's own checkout is never written to at all.
 *
 * What this module promises, and what it does not:
 *
 *   - It never runs checkout, stash, reset, clean or any other command against
 *     the user's working tree. Their uncommitted changes stay exactly where
 *     they are; a job starts from HEAD and says so.
 *   - It only removes worktrees and branches it created and recorded. A branch
 *     or directory it did not make is never deleted, even if the name matches.
 *   - Worktrees isolate git edits. They are NOT a security sandbox: an agent in
 *     a worktree can still read and write anything its own permissions allow.
 *     Nothing here, and nothing in the UI, may claim otherwise.
 *
 * Git is always invoked with execFile and an argument array, never a shell, so
 * a branch or path cannot be turned into a command.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { isScrubbedVariable } from "./env.ts";

/** Runs git in a directory and returns stdout. Injectable so tests can observe calls. */
export type Git = (cwd: string, args: string[]) => Promise<string>;

/**
 * An empty directory used as git's hooks path. With it, no hook in the
 * repository runs during ThreadLink's own commits and merges -- including one
 * an agent wrote into its worktree, which would otherwise run with the owner's
 * privileges outside any sandbox.
 */
function noHooksDir(): string {
  const dir = join(tmpdir(), "threadlink-no-git-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const defaultGit: Git = (cwd, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", `core.hooksPath=${noHooksDir()}`, ...args],
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(args, String(stderr || error.message).trim()));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });

/**
 * Git must never stop to ask a question -- there is nobody there to answer it
 * -- and it gets the same scrubbed environment as an agent.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isScrubbedVariable(key)) env[key] = value;
  }
  return {
    ...(env as NodeJS.ProcessEnv),
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: ":",
    GIT_MERGE_AUTOEDIT: "no",
  };
}

export class GitError extends Error {
  readonly args: string[];
  constructor(args: string[], detail: string) {
    super(`git ${args[0] ?? ""} failed: ${detail}`);
    this.name = "GitError";
    this.args = args;
  }
}

/** Names that end up in paths and branch names. Deliberately narrow. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

function segment(value: string, what: string): string {
  const lowered = value.toLowerCase();
  if (!SAFE_SEGMENT.test(lowered)) {
    throw new Error(`${what} "${value}" cannot be used in a worktree name.`);
  }
  return lowered;
}

export type WorktreeRecord = {
  /** Which unit of work this is for ("integration" for the merge workspace). */
  key: string;
  path: string;
  branch: string;
  /** The commit it was created from. */
  base: string;
};

export type JobWorktrees = {
  repo: string;
  job: string;
  base: string;
  /** Only these are ever removed. */
  created: WorktreeRecord[];
};

/**
 * Files whose content never leaves this computer in a shared diff: env files,
 * keys and certificates, package-manager credentials, anything named
 * credentials or secrets. Git glob pathspecs, at any depth.
 */
export const SENSITIVE_PATHSPECS = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.p12",
  "**/*.pfx",
  "**/.npmrc",
  "**/.pypirc",
  "**/credentials*",
  "**/secrets*",
] as const;

/** Where Team Mode keeps its worktrees, relative to the repository. */
export const WORKTREE_DIR = join(".threadlink", "worktrees");

export class WorktreeManager {
  readonly #git: Git;

  constructor(git: Git = defaultGit) {
    this.#git = git;
  }

  /** The repository's top level, or a clear error if this is not a git repository. */
  async repoRoot(dir: string): Promise<string> {
    try {
      return resolve((await this.#git(dir, ["rev-parse", "--show-toplevel"])).trim());
    } catch {
      throw new Error(`${dir} is not inside a git repository, so Team Mode cannot isolate work.`);
    }
  }

  /**
   * Starts a job's worktree set at the current HEAD.
   *
   * The user's uncommitted changes are deliberately NOT carried into the job:
   * copying them would mean touching their working tree, and silently dropping
   * them into an agent's branch would be worse. `dirty` says they exist, so the
   * job can tell the user its base did not include them.
   */
  async begin(dir: string, job: string): Promise<JobWorktrees & { dirty: boolean }> {
    const repo = await this.repoRoot(dir);
    const base = (await this.#git(repo, ["rev-parse", "HEAD"])).trim();
    const status = await this.#git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    await this.#excludeLocally(repo);
    return { repo, job: segment(job, "Job"), base, created: [], dirty: status.trim().length > 0 };
  }

  /**
   * Keeps .threadlink/ out of the user's `git status` without editing any file
   * they track. .git/info/exclude is local to this clone and never committed.
   */
  async #excludeLocally(repo: string): Promise<void> {
    const gitDir = resolve(repo, (await this.#git(repo, ["rev-parse", "--git-common-dir"])).trim());
    const exclude = join(gitDir, "info", "exclude");
    const line = "/.threadlink/";
    const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    if (current.split(/\r?\n/).includes(line)) return;
    await mkdir(join(gitDir, "info"), { recursive: true });
    const joiner = current.length && !current.endsWith("\n") ? "\n" : "";
    await writeFile(exclude, `${current}${joiner}# ThreadLink Team Mode worktrees\n${line}\n`);
  }

  /** Creates the worktree for one unit of work, on its own new branch. */
  async create(set: JobWorktrees, key: string): Promise<WorktreeRecord> {
    const name = segment(key, "Task");
    const branch = `threadlink/${set.job}/${name}`;
    const path = join(set.repo, WORKTREE_DIR, `${set.job}-${name}`);
    this.#assertInside(set.repo, path);
    if (existsSync(path))
      throw new Error(`A worktree already exists at ${path}; refusing to reuse it.`);
    if (await this.#branchExists(set.repo, branch)) {
      throw new Error(
        `Branch ${branch} already exists; refusing to reuse a branch ThreadLink did not create now.`,
      );
    }
    await mkdir(join(set.repo, WORKTREE_DIR), { recursive: true });
    await this.#git(set.repo, ["worktree", "add", "-b", branch, path, set.base]);
    const record = { key: name, path, branch, base: set.base };
    set.created.push(record);
    return record;
  }

  async #branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.#git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  #assertInside(repo: string, path: string): void {
    const rel = relative(resolve(repo), resolve(path));
    if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(path) === resolve(repo)) {
      throw new Error("Refusing a worktree path outside the repository's .threadlink directory.");
    }
  }

  /**
   * Commits whatever an agent changed in its worktree, with provenance.
   *
   * Authors are recorded as commit trailers, so "who wrote this" survives the
   * merge into the integration branch. Returns null when nothing changed.
   */
  async commit(
    record: WorktreeRecord,
    message: string,
    provenance: { authoredBy: string[]; reviewedBy?: string[]; job: string; task: string },
  ): Promise<string | null> {
    await this.#git(record.path, ["add", "-A"]);
    const staged = await this.#git(record.path, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return null;
    const trailers = [
      ...provenance.authoredBy.map((a) => `Authored-by: ${a}`),
      ...(provenance.reviewedBy ?? []).map((r) => `Reviewed-by: ${r}`),
      `ThreadLink-Job: ${provenance.job}`,
      `ThreadLink-Task: ${provenance.task}`,
    ];
    await this.#git(record.path, [
      "-c",
      "user.name=ThreadLink Team",
      "-c",
      "user.email=team@threadlink.invalid",
      "commit",
      "--no-verify",
      "-m",
      message,
      "-m",
      trailers.join("\n"),
    ]);
    return (await this.#git(record.path, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * True when nothing in the worktree has changed since its last commit,
   * untracked files included. After a read-only run this is the check that the
   * run really was read-only -- observed, not assumed from the flags it was given.
   */
  async isClean(record: WorktreeRecord): Promise<boolean> {
    const status = await this.#git(record.path, ["status", "--porcelain", "--untracked-files=all"]);
    return status.trim().length === 0;
  }

  /**
   * 0.11.1: throws away every uncommitted change in this worktree (tracked and
   * untracked) -- what a read-only job does if an agent wrote anyway. Only
   * ThreadLink's own worktree is touched, never the owner's checkout.
   */
  async discardChanges(record: WorktreeRecord): Promise<void> {
    await this.#git(record.path, ["reset", "--hard", "--quiet", "HEAD"]);
    await this.#git(record.path, ["clean", "-fdq"]);
  }

  /**
   * Puts the given files back as they were at the job's base, inside this
   * worktree only, and commits that. Used when a builder changed files outside
   * the unit's agreed scope: the plan decides who owns which files, and a
   * change outside it would collide with another unit at integration.
   */
  async revertPaths(
    record: WorktreeRecord,
    paths: string[],
    message: string,
  ): Promise<string | null> {
    if (!paths.length) return null;
    for (const path of paths) {
      const existedAtBase = await this.#git(record.path, [
        "cat-file",
        "-e",
        `${record.base}:${path}`,
      ])
        .then(() => true)
        .catch(() => false);
      if (existedAtBase) {
        await this.#git(record.path, ["checkout", record.base, "--", path]);
      } else {
        await this.#git(record.path, ["rm", "-f", "--quiet", "--", path]);
      }
    }
    return this.commit(record, message, {
      authoredBy: ["ThreadLink"],
      job: "scope",
      task: "revert",
    });
  }

  /** The commit a worktree is at now. */
  async head(record: WorktreeRecord): Promise<string> {
    return (await this.#git(record.path, ["rev-parse", "HEAD"])).trim();
  }

  /** Files a unit of work changed, relative to the job's base. */
  async changedFiles(record: WorktreeRecord): Promise<string[]> {
    const out = await this.#git(record.path, ["diff", "--name-only", `${record.base}..HEAD`]);
    return out.split(/\r?\n/).filter(Boolean).sort();
  }

  /**
   * The real diffstat of a unit's change against its base, from git: files
   * changed, lines inserted and deleted (binary files count as changed with
   * no lines), and the repo-relative file list.
   */
  async diffStat(
    record: WorktreeRecord,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; files: string[] }> {
    const out = await this.#git(record.path, [
      "diff",
      "--numstat",
      "--no-renames",
      `${record.base}..HEAD`,
    ]);
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
      files.push(m[3]!);
    }
    files.sort();
    return { filesChanged: files.length, insertions, deletions, files };
  }

  /**
   * The diff that may leave this computer (a code change card's diff
   * artifact): files that commonly hold secrets are left out by git itself
   * (pathspec excludes), and only their names are returned. The caller still
   * redacts the text before sending it.
   */
  async sharedDiff(
    record: WorktreeRecord,
    maxBytes = 512 * 1024,
  ): Promise<{ text: string; truncated: boolean; excluded: string[] }> {
    const range = `${record.base}..HEAD`;
    const text = await this.#git(record.path, [
      "diff",
      "--no-color",
      range,
      "--",
      ".",
      ...SENSITIVE_PATHSPECS.map((p) => `:(exclude,glob)${p}`),
    ]);
    const excluded = (
      await this.#git(record.path, [
        "diff",
        "--name-only",
        range,
        "--",
        ...SENSITIVE_PATHSPECS.map((p) => `:(glob)${p}`),
      ])
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false, excluded };
    return {
      text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
      truncated: true,
      excluded,
    };
  }

  /**
   * A fingerprint of exactly what a reviewer saw: the diff and the file list.
   * A review is only valid for the fingerprint it was given; if the code
   * changes afterwards, the review no longer covers it.
   */
  async fingerprint(record: WorktreeRecord): Promise<string> {
    const diff = await this.#git(record.path, ["diff", "--no-color", `${record.base}..HEAD`]);
    const files = (await this.changedFiles(record)).join("\n");
    return createHash("sha256").update(files).update("\0").update(diff).digest("hex");
  }

  /** The diff a reviewer reads, capped so it cannot swamp a prompt. */
  async diff(
    record: WorktreeRecord,
    maxBytes = 200_000,
  ): Promise<{ text: string; truncated: boolean }> {
    const text = await this.#git(record.path, ["diff", "--no-color", `${record.base}..HEAD`]);
    if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
    return {
      text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
      truncated: true,
    };
  }

  /**
   * Merges finished work into the integration worktree, one branch at a time.
   *
   * On a conflict the merge is aborted and reported. Resolving a conflict is a
   * judgement about intent, and ThreadLink does not make it on its own.
   */
  async merge(
    integration: WorktreeRecord,
    branch: string,
    message: string,
  ): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[] }> {
    try {
      await this.#git(integration.path, [
        "-c",
        "user.name=ThreadLink Team",
        "-c",
        "user.email=team@threadlink.invalid",
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        message,
        branch,
      ]);
      return {
        ok: true,
        commit: (await this.#git(integration.path, ["rev-parse", "HEAD"])).trim(),
      };
    } catch {
      const conflicts = (
        await this.#git(integration.path, ["diff", "--name-only", "--diff-filter=U"]).catch(
          () => "",
        )
      )
        .split(/\r?\n/)
        .filter(Boolean);
      await this.#git(integration.path, ["merge", "--abort"]).catch(() => undefined);
      return { ok: false, conflicts };
    }
  }

  /**
   * Removes what this job created, and nothing else.
   *
   * `keepBranches` leaves the branches in place: the integrated result is on
   * one, and the user decides what to do with it.
   */
  async cleanup(set: JobWorktrees, options: { keepBranches?: boolean } = {}): Promise<string[]> {
    const removed: string[] = [];
    for (const record of [...set.created].reverse()) {
      if (existsSync(record.path)) {
        await this.#git(set.repo, ["worktree", "remove", "--force", record.path]).catch(
          () => undefined,
        );
      }
      if (!options.keepBranches) {
        await this.#git(set.repo, ["branch", "-D", record.branch]).catch(() => undefined);
      }
      removed.push(record.path);
    }
    await this.#git(set.repo, ["worktree", "prune"]).catch(() => undefined);
    set.created.length = 0;
    return removed;
  }
}
