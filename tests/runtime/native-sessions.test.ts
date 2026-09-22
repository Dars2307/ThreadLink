import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claudeAgentsLister,
  discoverClaudeSessions,
  encodeProjectDir,
  sessionExistsInWorkspace,
} from "../../runtime/src/claude-sessions.ts";
import {
  acquireSessionLock,
  ClaudeCodeExecutor,
  type NativeSession,
} from "../../runtime/src/executor.ts";
import { processNextTask, type WorkerDeps } from "../../runtime/src/worker.ts";

const FAKE = join(__dirname, "fake-claude.mjs");
const spawnFake = ((_command: string, args: string[], options: object) =>
  spawn(process.execPath, [FAKE, ...args], options as never)) as unknown as typeof spawn;
const task = (content: string) => ({
  taskId: "tltask_00112233445566778899aabbccddeeff",
  title: "t",
  content,
  priority: "C",
});
const signal = () => new AbortController().signal;
const UUID_A = "04158991-0630-4b8b-b461-58c86ee35453";
const UUID_B = "9c192eb6-1111-4222-8333-944455556666";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-native-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_CLAUDE_STATE;
  delete process.env.FAKE_CLAUDE_MODE;
});

function transcript(home: string, workspace: string, id: string, lines: object[], mtime?: Date) {
  const projectDir = join(home, "projects", encodeProjectDir(workspace));
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

describe("Claude Code session discovery (local metadata only)", () => {
  it("lists this workspace's sessions with titles, newest first", async () => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    transcript(
      home,
      ws,
      UUID_A,
      [
        { type: "user", cwd: ws, message: { content: "secret prompt text" } },
        { type: "ai-title", aiTitle: "AI title", sessionId: UUID_A },
        { type: "custom-title", customTitle: "ThreadLink Development", sessionId: UUID_A },
      ],
      new Date("2026-09-20T10:00:00Z"),
    );
    transcript(
      home,
      ws,
      UUID_B,
      [
        { type: "user", cwd: ws },
        { type: "ai-title", aiTitle: "Fix login bug", sessionId: UUID_B },
      ],
      new Date("2026-09-21T10:00:00Z"),
    );

    const sessions = await discoverClaudeSessions(ws, { home });
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_B, UUID_A]);
    expect(sessions[1].title).toBe("ThreadLink Development"); // custom title wins
    expect(sessions[0].title).toBe("Fix login bug");
    expect(JSON.stringify(sessions)).not.toContain("secret prompt text");
  });

  it("ignores transcripts whose recorded cwd is a different folder (lossy dir encoding)", async () => {
    const home = join(dir, "home");
    const ws = join(dir, "my-ws");
    // "my_ws" encodes to the same directory name as "my-ws".
    transcript(home, ws, UUID_A, [{ type: "user", cwd: join(dir, "my_ws") }]);
    expect(await discoverClaudeSessions(ws, { home })).toEqual([]);
    expect(await sessionExistsInWorkspace(ws, UUID_A, home)).toBe(false);
  });

  it("ignores non-session files and unknown IDs", async () => {
    const home = join(dir, "home");
    const ws = join(dir, "ws");
    transcript(home, ws, UUID_A, [{ type: "user", cwd: ws }]);
    writeFileSync(join(home, "projects", encodeProjectDir(ws), "notes.jsonl"), "{}\n");
    mkdirSync(join(home, "projects", encodeProjectDir(ws), UUID_A));
    expect((await discoverClaudeSessions(ws, { home })).map((s) => s.sessionId)).toEqual([UUID_A]);
    expect(await sessionExistsInWorkspace(ws, UUID_B, home)).toBe(false);
    expect(await sessionExistsInWorkspace(ws, "../../etc/passwd", home)).toBe(false);
    expect(await discoverClaudeSessions(join(dir, "nothing-here"), { home })).toEqual([]);
  });

  it("lists running sessions via the official `claude agents --json`", async () => {
    process.env.FAKE_CLAUDE_RUNNING = `${UUID_A},${UUID_B}`;
    const running = await claudeAgentsLister("claude", spawnFake)();
    expect(running.map((r) => r.sessionId)).toEqual([UUID_A, UUID_B]);
    delete process.env.FAKE_CLAUDE_RUNNING;
  });
});

describe("resuming an attached Claude Code session", { timeout: 30_000 }, () => {
  const notRunning = async () => [];
  const executor = (native: NativeSession, extra: object = {}) =>
    new ClaudeCodeExecutor({
      cwd: dir,
      spawnFn: spawnFake,
      native,
      listRunning: notRunning,
      lockDir: join(dir, "cfg"),
      ...extra,
    });

  async function freshSession(): Promise<string> {
    const r = await executor({ mode: "fresh" }).execute(
      task("Remember the codeword BLUEFIN-42"),
      signal(),
    );
    if (!r.ok) throw new Error(r.error);
    return r.artifacts[0].reference.replace("claude-code-session:", "");
  }

  beforeEach(() => {
    process.env.FAKE_CLAUDE_STATE = join(dir, "state");
    mkdirSync(process.env.FAKE_CLAUDE_STATE, { recursive: true });
  });

  it("passes --resume <id> and the prompt on stdin", () => {
    expect(executor({ mode: "resume", sessionId: UUID_A }).args()).toEqual([
      "-p",
      "--resume",
      UUID_A,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
    ]);
    expect(executor({ mode: "continue" }).args().slice(0, 2)).toEqual(["-p", "--continue"]);
  });

  it("two tasks resume the same session, with prior context, and the ID stays stable", async () => {
    const sid = await freshSession();
    const attached = executor({ mode: "resume", sessionId: sid });
    const first = await attached.execute(task("What is the codeword?"), signal());
    const second = await attached.execute(task("And again?"), signal());
    expect(first).toMatchObject({ ok: true, result: "turns=2 remembered=BLUEFIN-42" });
    expect(second).toMatchObject({ ok: true, result: "turns=3 remembered=BLUEFIN-42" });
    for (const r of [first, second]) {
      if (r.ok)
        expect(r.artifacts).toEqual([{ type: "other", reference: `claude-code-session:${sid}` }]);
    }
    expect(readdirSync(process.env.FAKE_CLAUDE_STATE!)).toEqual([`${sid}.json`]); // no new sessions
  });

  it("a wrong native session ID fails and never falls back to a new session", async () => {
    const r = await executor({ mode: "resume", sessionId: UUID_B }).execute(task("x"), signal());
    expect(r).toMatchObject({ ok: false, reason: "native_session_unavailable" });
    expect(readdirSync(process.env.FAKE_CLAUDE_STATE!)).toEqual([]);
  });

  it("refuses when the session is open elsewhere (session_busy), without running Claude", async () => {
    const sid = await freshSession();
    const r = await executor(
      { mode: "resume", sessionId: sid },
      {
        listRunning: async () => [
          { sessionId: sid, pid: 1, kind: "interactive", status: "idle", name: null, cwd: null },
        ],
      },
    ).execute(task("x"), signal());
    expect(r).toMatchObject({ ok: false, reason: "session_busy" });
    const again = await executor({ mode: "resume", sessionId: sid }).execute(task("y"), signal());
    expect(again).toMatchObject({ ok: true, result: "turns=2 remembered=BLUEFIN-42" }); // untouched
  });

  it("fails closed when running sessions cannot be listed", async () => {
    const r = await executor(
      { mode: "resume", sessionId: UUID_A },
      { listRunning: async () => Promise.reject(new Error("no claude")) },
    ).execute(task("x"), signal());
    expect(r).toMatchObject({ ok: false, reason: "session_busy" });
  });

  it("maps Claude Code's own 'already running' refusal to session_busy", async () => {
    process.env.FAKE_CLAUDE_MODE = "busy";
    const r = await executor({ mode: "resume", sessionId: UUID_A }).execute(task("x"), signal());
    expect(r).toMatchObject({ ok: false, reason: "session_busy" });
  });

  it("discards a result that came from a different (forked) session", async () => {
    const sid = await freshSession();
    process.env.FAKE_CLAUDE_MODE = "fork";
    const r = await executor({ mode: "resume", sessionId: sid }).execute(task("x"), signal());
    expect(r).toMatchObject({ ok: false, reason: "native_session_unavailable" });
  });

  it("serialises bridge processes with a per-session lock (stale locks reclaimed)", () => {
    const lockDir = join(dir, "locks");
    const release = acquireSessionLock(lockDir, UUID_A);
    expect(release).not.toBeNull();
    expect(acquireSessionLock(lockDir, UUID_A)).toBeNull();
    release!();
    const again = acquireSessionLock(lockDir, UUID_A);
    expect(again).not.toBeNull();
    again!();
    writeFileSync(join(lockDir, `${UUID_A}.lock`), "999999999");
    const reclaimed = acquireSessionLock(lockDir, UUID_A);
    expect(reclaimed).not.toBeNull();
    reclaimed!();
  });

  it("rejects malformed native IDs up front", () => {
    expect(() => executor({ mode: "resume", sessionId: "--dangerous-flag" })).toThrow();
  });
});

describe("worker reports native failures with a reason", () => {
  it("passes session_busy to fail()", async () => {
    const api = {
      inbox: vi.fn(async () => [
        { taskId: "tltask_1", title: "t", content: "c", priority: "C", status: "queued" },
      ]),
      claim: vi.fn(async () => ({
        taskId: "tltask_1",
        title: "t",
        content: "c",
        priority: "C",
        status: "claimed",
      })),
      start: vi.fn(async () => ({})),
      heartbeat: vi.fn(async () => ({})),
      progress: vi.fn(async () => ({})),
      complete: vi.fn(async () => ({})),
      fail: vi.fn(async () => ({})),
    } as unknown as WorkerDeps["api"] & Record<string, ReturnType<typeof vi.fn>>;
    const outcome = await processNextTask({
      api,
      executor: {
        name: "x",
        execute: async () => ({ ok: false, error: "busy", reason: "session_busy" }),
      },
      sessionId: "tlses_00112233445566778899aabbccddeeff",
      claimRef: "w",
      heartbeatMs: 1000,
    });
    expect(outcome).toBe("failed");
    expect(api.fail).toHaveBeenCalledWith(
      "tltask_1",
      "tlses_00112233445566778899aabbccddeeff",
      "w",
      "busy",
      "session_busy",
    );
    expect(api.complete).not.toHaveBeenCalled();
  });
});
