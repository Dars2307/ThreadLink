import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeManager } from "../../runtime/src/team/worktrees.ts";

/**
 * Worktrees are how two agents build at once without trampling each other.
 * These run against a real repository, because the property that matters most
 * -- the user's own checkout is never touched -- is a property of git, not of
 * this module's bookkeeping.
 */

// Real git on Windows takes a second or two per worktree.
vi.setConfig({ testTimeout: 60_000 });

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tl-wt-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "owner@example.com");
  git("config", "user.name", "Owner");
  git("config", "commit.gpgsign", "false");
  // A global core.autocrlf would rewrite line endings on checkout; the tests
  // are about isolation, so the repository is made byte-for-byte predictable.
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "shared.ts"), "export const s = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repo, windowsHide: true });
  } catch {
    /* repo may already be gone */
  }
  rmSync(repo, { recursive: true, force: true });
});

describe("the user's own checkout", () => {
  it("is never written to, and their uncommitted work stays exactly as it was", async () => {
    // The owner is halfway through something.
    writeFileSync(join(repo, "app.ts"), "export const a = 'mine, not committed';\n");
    writeFileSync(join(repo, "notes.txt"), "untracked scratch\n");
    const branchBefore = git("rev-parse", "--abbrev-ref", "HEAD");

    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    writeFileSync(join(a.path, "app.ts"), "export const a = 'agent';\n");
    await wt.commit(a, "Agent work", { authoredBy: ["Claude Code"], job: "job1", task: "a" });
    await wt.cleanup(set);

    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe(
      "export const a = 'mine, not committed';\n",
    );
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("untracked scratch\n");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(branchBefore);
  });

  it("says when the job's base does not include the user's uncommitted changes", async () => {
    writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
    const set = await new WorktreeManager().begin(repo, "job1");
    expect(set.dirty).toBe(true);
  });

  it("keeps its worktrees out of the user's git status without editing a tracked file", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    await wt.create(set, "a");
    expect(git("status", "--porcelain")).not.toContain(".threadlink");
    // Nothing tracked was changed to achieve that.
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    await wt.cleanup(set);
  });
});

describe("parallel work", () => {
  it("gives each unit of work its own branch and its own files", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    const b = await wt.create(set, "b");
    expect(a.branch).toBe("threadlink/job1/a");
    expect(b.branch).toBe("threadlink/job1/b");

    writeFileSync(join(a.path, "app.ts"), "export const a = 'from a';\n");
    // b does not see a's uncommitted edit.
    expect(readFileSync(join(b.path, "app.ts"), "utf8")).toBe("export const a = 1;\n");
    await wt.cleanup(set);
  });

  it("records who wrote a change, so provenance survives integration", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    writeFileSync(join(a.path, "app.ts"), "export const a = 3;\n");
    await wt.commit(a, "Add a", {
      authoredBy: ["Claude Code", "Codex"],
      reviewedBy: ["Codex"],
      job: "job1",
      task: "a",
    });
    const body = execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd: a.path,
      encoding: "utf8",
    });
    expect(body).toContain("Authored-by: Claude Code");
    expect(body).toContain("Authored-by: Codex");
    expect(body).toContain("Reviewed-by: Codex");
    await wt.cleanup(set);
  });

  it("does not make an empty commit when an agent changed nothing", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    expect(
      await wt.commit(a, "Nothing", { authoredBy: ["Codex"], job: "job1", task: "a" }),
    ).toBeNull();
    await wt.cleanup(set);
  });
});

describe("what a reviewer is shown", () => {
  it("changes its fingerprint when the code changes, so a stale review is detectable", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    writeFileSync(join(a.path, "app.ts"), "export const a = 4;\n");
    await wt.commit(a, "v1", { authoredBy: ["Codex"], job: "job1", task: "a" });
    const first = await wt.fingerprint(a);
    expect(await wt.fingerprint(a)).toBe(first);

    writeFileSync(join(a.path, "app.ts"), "export const a = 5;\n");
    await wt.commit(a, "v2", { authoredBy: ["Codex"], job: "job1", task: "a" });
    expect(await wt.fingerprint(a)).not.toBe(first);
    expect(await wt.changedFiles(a)).toEqual(["app.ts"]);
    await wt.cleanup(set);
  });

  it("caps an enormous diff rather than handing it all to a model", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    writeFileSync(join(a.path, "big.txt"), "x".repeat(50_000));
    await wt.commit(a, "big", { authoredBy: ["Codex"], job: "job1", task: "a" });
    const { text, truncated } = await wt.diff(a, 1_000);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_000);
    await wt.cleanup(set);
  });
});

describe("integration", () => {
  it("merges independent work cleanly", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    const b = await wt.create(set, "b");
    writeFileSync(join(a.path, "app.ts"), "export const a = 'A';\n");
    await wt.commit(a, "A", { authoredBy: ["Claude Code"], job: "job1", task: "a" });
    writeFileSync(join(b.path, "shared.ts"), "export const s = 'B';\n");
    await wt.commit(b, "B", { authoredBy: ["Codex"], job: "job1", task: "b" });

    const integration = await wt.create(set, "integration");
    expect(await wt.merge(integration, a.branch, "Integrate a")).toMatchObject({ ok: true });
    expect(await wt.merge(integration, b.branch, "Integrate b")).toMatchObject({ ok: true });
    expect(readFileSync(join(integration.path, "app.ts"), "utf8")).toContain("'A'");
    expect(readFileSync(join(integration.path, "shared.ts"), "utf8")).toContain("'B'");
    await wt.cleanup(set);
  });

  it("stops on a conflict instead of guessing, and leaves the workspace clean", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");
    const b = await wt.create(set, "b");
    writeFileSync(join(a.path, "app.ts"), "export const a = 'A';\n");
    await wt.commit(a, "A", { authoredBy: ["Claude Code"], job: "job1", task: "a" });
    writeFileSync(join(b.path, "app.ts"), "export const a = 'B';\n");
    await wt.commit(b, "B", { authoredBy: ["Codex"], job: "job1", task: "b" });

    const integration = await wt.create(set, "integration");
    await wt.merge(integration, a.branch, "Integrate a");
    const result = await wt.merge(integration, b.branch, "Integrate b");

    expect(result).toEqual({ ok: false, conflicts: ["app.ts"] });
    // Aborted: no half-merged state left behind for the next step to trip on.
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: integration.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    await wt.cleanup(set);
  });
});

describe("cleanup", () => {
  it("removes only what this job created, never a branch it did not make", async () => {
    git("branch", "threadlink/job1/users-own-branch");
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    const a = await wt.create(set, "a");

    await wt.cleanup(set);

    expect(existsSync(a.path)).toBe(false);
    expect(git("branch", "--list", "threadlink/job1/a")).toBe("");
    expect(git("branch", "--list", "threadlink/job1/users-own-branch")).toContain(
      "users-own-branch",
    );
  });

  it("can keep the branches, so the integrated result is left for the user", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    await wt.create(set, "integration");
    await wt.cleanup(set, { keepBranches: true });
    expect(git("branch", "--list", "threadlink/job1/integration")).toContain("integration");
  });
});

describe("names that end up in paths and branches", () => {
  it("refuses anything that could escape the worktree directory", async () => {
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    for (const bad of ["../escape", "a/b", "..", "A B", "", "-rf"]) {
      await expect(wt.create(set, bad), bad).rejects.toThrow();
    }
    await expect(wt.begin(repo, "../job")).rejects.toThrow();
  });

  it("refuses to reuse a branch that already exists", async () => {
    git("branch", "threadlink/job1/a");
    const wt = new WorktreeManager();
    const set = await wt.begin(repo, "job1");
    await expect(wt.create(set, "a")).rejects.toThrow(/already exists/);
  });

  it("says plainly when there is no git repository to isolate work in", async () => {
    const plain = mkdtempSync(join(tmpdir(), "tl-plain-"));
    try {
      await expect(new WorktreeManager().repoRoot(plain)).rejects.toThrow(
        /not inside a git repository/,
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
