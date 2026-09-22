import { spawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Discovery of existing Claude Code sessions for a workspace.
 *
 * Verified against Claude Code 2.1.x:
 *
 * - Transcripts are persisted as `<claude home>/projects/<encoded cwd>/<session-uuid>.jsonl`,
 *   where the encoded cwd replaces every non-alphanumeric character with "-".
 *   Every conversation record carries the real `cwd`, which we check (the encoding
 *   is lossy, so the directory name alone is not trusted).
 * - Titles are records `{"type":"custom-title","customTitle":...}` (user-set),
 *   `{"type":"agent-name","agentName":...}` and `{"type":"ai-title","aiTitle":...}`.
 * - Running sessions (interactive terminals, Claude desktop, background agents and
 *   in-flight `claude -p` runs) are listed by the official `claude agents --json`.
 *
 * We read metadata only (file names, times, titles, cwd). Conversation content is
 * never parsed beyond locating those records, never uploaded, and never logged.
 * No UI scraping, no keyboard automation, no guessed IDs.
 */

export const NATIVE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ClaudeSession = {
  sessionId: string;
  title: string | null;
  lastUsedAt: Date;
  cwd: string;
};

export type RunningClaudeSession = {
  sessionId: string;
  pid: number | null;
  kind: string | null;
  status: string | null;
  name: string | null;
  cwd: string | null;
};

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function encodeProjectDir(workspace: string): string {
  return resolve(workspace).replace(/[^A-Za-z0-9]/g, "-");
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform) {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function maskSessionId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

const TITLE_TYPES = ['"type":"custom-title"', '"type":"agent-name"', '"type":"ai-title"'];
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

type Scan = {
  cwd: string | null;
  customTitle: string | null;
  agentName: string | null;
  aiTitle: string | null;
};

/** Streams a transcript in chunks, extracting only cwd and title records. */
function scanTranscript(file: string): Scan {
  const out: Scan = { cwd: null, customTitle: null, agentName: null, aiTitle: null };
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let carry = "";
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      total += n;
      const text = carry + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) inspectLine(line, out);
      if (total > MAX_SCAN_BYTES) break;
    }
    if (carry) inspectLine(carry, out);
  } finally {
    closeSync(fd);
  }
  return out;
}

function inspectLine(line: string, out: Scan) {
  const wantsCwd = out.cwd === null && line.includes('"cwd":');
  const isTitle = TITLE_TYPES.some((t) => line.includes(t));
  if (!wantsCwd && !isTitle) return;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (wantsCwd && typeof record.cwd === "string") out.cwd = record.cwd;
  if (record.type === "custom-title" && typeof record.customTitle === "string")
    out.customTitle = record.customTitle;
  if (record.type === "agent-name" && typeof record.agentName === "string")
    out.agentName = record.agentName;
  if (record.type === "ai-title" && typeof record.aiTitle === "string")
    out.aiTitle = record.aiTitle;
}

function cleanTitle(value: string | null): string | null {
  if (!value) return null;
  const text = [...value]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .trim();
  return text ? text.slice(0, 80) : null;
}

/** Sessions persisted for exactly this workspace, most recently used first. */
export async function discoverClaudeSessions(
  workspace: string,
  options: { home?: string; limit?: number } = {},
): Promise<ClaudeSession[]> {
  const dir = join(options.home ?? claudeHome(), "projects", encodeProjectDir(workspace));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = basename(name, ".jsonl");
    if (!NATIVE_SESSION_ID.test(sessionId)) continue;
    const file = join(dir, name);
    let info;
    try {
      info = await stat(file);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    const scan = scanTranscript(file);
    // Only sessions provably recorded in THIS workspace (encoding is lossy).
    if (!scan.cwd || !samePath(scan.cwd, workspace)) continue;
    sessions.push({
      sessionId,
      title: cleanTitle(scan.customTitle ?? scan.agentName ?? scan.aiTitle),
      lastUsedAt: info.mtime,
      cwd: scan.cwd,
    });
  }
  sessions.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
  return sessions.slice(0, options.limit ?? 20);
}

/** True if a transcript for this exact session exists in this workspace. */
export async function sessionExistsInWorkspace(
  workspace: string,
  sessionId: string,
  home?: string,
): Promise<boolean> {
  if (!NATIVE_SESSION_ID.test(sessionId)) return false;
  const file = join(
    home ?? claudeHome(),
    "projects",
    encodeProjectDir(workspace),
    `${sessionId}.jsonl`,
  );
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  const scan = scanTranscript(file);
  return scan.cwd !== null && samePath(scan.cwd, workspace);
}

export type AgentsLister = () => Promise<RunningClaudeSession[]>;

/**
 * Running Claude Code sessions via the official `claude agents --json`.
 * Throws if the listing cannot be obtained: callers must fail closed (treat the
 * session as busy) rather than risk writing into a session that is open.
 */
export function claudeAgentsLister(
  command = "claude",
  spawnFn: typeof spawn = spawn,
): AgentsLister {
  return () =>
    new Promise((resolvePromise, reject) => {
      const child = spawnFn(command, ["agents", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < 4 * 1024 * 1024) stdout += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("claude agents timed out"));
      }, 30_000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude agents exited ${code}`));
        try {
          const value: unknown = JSON.parse(stdout);
          const list = Array.isArray(value) ? value : [];
          resolvePromise(
            list
              .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
              .filter((x) => typeof x.sessionId === "string")
              .map((x) => ({
                sessionId: String(x.sessionId),
                pid: typeof x.pid === "number" ? x.pid : null,
                kind: typeof x.kind === "string" ? x.kind : null,
                status: typeof x.status === "string" ? x.status : null,
                name: typeof x.name === "string" ? x.name : null,
                cwd: typeof x.cwd === "string" ? x.cwd : null,
              })),
          );
        } catch {
          reject(new Error("claude agents returned invalid JSON"));
        }
      });
    });
}
