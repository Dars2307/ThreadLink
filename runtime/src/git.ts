import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Optional repository metadata for a workspace, so the same repo on two
 * machines (C:\Users\me\ThreadLink and /workspaces/ThreadLink) can be grouped
 * without treating paths as global IDs.
 *
 * Remotes are normalised to "host/owner/repo": credentials, user names,
 * schemes, ports and ".git" are stripped, so no secret embedded in a remote
 * URL (https://token@github.com/...) is ever sent to ThreadLink.
 */

export type RepoInfo = { remote: string | null; fingerprint: string | null; branch: string | null };

export function normalizeRemote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // scp-like: git@github.com:owner/repo.git
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const u = new URL(s);
      s = `${u.hostname}${u.pathname}`; // drops user:password@, port, query, hash
    } catch {
      return null;
    }
  }
  s = s
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return /^[a-z0-9._~/-]{3,300}$/.test(s) && s.includes("/") ? s : null;
}

export function safeBranch(raw: string | null | undefined): string | null {
  const b = raw?.trim();
  return b && b !== "HEAD" && /^[A-Za-z0-9._/+-]{1,200}$/.test(b) ? b : null;
}

type Git = (args: string[]) => Promise<string | null>;

export function gitRunner(cwd: string, command = "git"): Git {
  return (args) =>
    new Promise((resolve) => {
      let out = "";
      let child;
      try {
        child = spawn(command, ["-C", cwd, ...args], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => child.kill(), 5000);
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < 4096) out += d.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out.trim() : null);
      });
    });
}

export async function repoInfo(cwd: string, git: Git = gitRunner(cwd)): Promise<RepoInfo> {
  const remote = normalizeRemote(await git(["config", "--get", "remote.origin.url"]));
  const branch = safeBranch(await git(["rev-parse", "--abbrev-ref", "HEAD"]));
  return {
    remote,
    fingerprint: remote
      ? createHash("sha256").update(`threadlink:repo:v1:${remote}`).digest("hex")
      : null,
    branch,
  };
}
