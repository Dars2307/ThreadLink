import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeAgentsLister,
  discoverClaudeSessions,
  sessionExistsInWorkspace,
} from "../../runtime/src/claude-sessions.ts";
import { ClaudeCodeExecutor } from "../../runtime/src/executor.ts";

/**
 * OPT-IN: runs the REAL Claude Code CLI (uses the machine's Claude login and a few
 * small, read-only turns in plan mode, in a throwaway temp workspace).
 *
 *   THREADLINK_REAL_CLAUDE=1 npx vitest run tests/bridge/claude-real.test.ts
 */
const REAL = process.env.THREADLINK_REAL_CLAUDE === "1";
const task = (content: string) => ({
  taskId: "tltask_00000000000000000000000000000000",
  title: "real claude check",
  content,
  priority: "C",
});
const signal = () => new AbortController().signal;

describe.runIf(REAL)("real Claude Code: attach, resume, busy", { timeout: 600_000 }, () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "tl-real-claude-")));
  const listRunning = claudeAgentsLister();
  let sessionId = "";

  it("a fresh run creates a session that discovery finds in this workspace", async () => {
    const fresh = new ClaudeCodeExecutor({ cwd: workspace });
    const r = await fresh.execute(
      task("Remember this codeword for later: PELICAN-77. Reply with only OK."),
      signal(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    sessionId = r.artifacts[0].reference.replace("claude-code-session:", "");
    expect(await sessionExistsInWorkspace(workspace, sessionId)).toBe(true);
    expect((await discoverClaudeSessions(workspace)).map((s) => s.sessionId)).toContain(sessionId);
  });

  it("two ThreadLink tasks resume the same session with prior context", async () => {
    const attached = new ClaudeCodeExecutor({
      cwd: workspace,
      native: { mode: "resume", sessionId },
      listRunning,
      lockDir: join(workspace, ".tl"),
    });
    const first = await attached.execute(
      task("What codeword did I ask you to remember? Reply with only the codeword."),
      signal(),
    );
    const second = await attached.execute(
      task("Reply with the word SECOND followed by the codeword."),
      signal(),
    );
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) {
      expect(first.result).toContain("PELICAN-77");
      expect(second.result).toContain("PELICAN-77");
      expect(first.artifacts[0].reference).toBe(`claude-code-session:${sessionId}`);
      expect(second.artifacts[0].reference).toBe(`claude-code-session:${sessionId}`);
    }
  });

  it("a wrong native session ID fails without creating a new session", async () => {
    const before = (await discoverClaudeSessions(workspace)).length;
    const r = await new ClaudeCodeExecutor({
      cwd: workspace,
      native: { mode: "resume", sessionId: "11111111-2222-4333-8444-555555555555" },
      listRunning,
    }).execute(task("hello"), signal());
    expect(r).toMatchObject({ ok: false, reason: "native_session_unavailable" });
    expect((await discoverClaudeSessions(workspace)).length).toBe(before);
  });

  it("refuses with session_busy while the session is open as a background session", async () => {
    const bg = spawnSync("claude", ["--bg", "--resume", sessionId, "--permission-mode", "plan"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(bg.status).toBe(0);
    try {
      const r = await new ClaudeCodeExecutor({
        cwd: workspace,
        native: { mode: "resume", sessionId },
        listRunning,
      }).execute(task("This must not run."), signal());
      expect(r).toMatchObject({ ok: false, reason: "session_busy" });
    } finally {
      spawnSync("claude", ["stop", sessionId.slice(0, 8)], { cwd: workspace, timeout: 60_000 });
    }
  });
});
