import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findCodexExecutable } from "../../runtime/src/team/discovery.ts";
import { buildAgentEnv } from "../../runtime/src/team/env.ts";
import { ClaudeTeamRunner } from "../../runtime/src/team/runners/claude.ts";
import { CodexTeamRunner } from "../../runtime/src/team/runners/codex.ts";

/**
 * OPT-IN: runs the REAL Codex and Claude Code CLIs, one tiny read-only call each,
 * on the machine's included subscriptions (no API key: the env is scrubbed).
 *
 *   THREADLINK_REAL_AGENTS=1 npx vitest run tests/runtime/team-runners.real.test.ts
 */
const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const PROBE = "THREADLINK_TEAM_PROBE";

describe.runIf(REAL)("real agents: one tiny read-only call each", { timeout: 300_000 }, () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tl-real-team-")));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "probe repo\n");
  spawnSync("git", ["add", "."], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.name=probe", "-c", "user.email=probe@invalid", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );

  it("Codex: gpt-6-luna, effort low, read-only — model and sandbox verified", async () => {
    const executable = findCodexExecutable().path;
    expect(executable).toBeTruthy();
    const result = await new CodexTeamRunner({ executable: executable! }).run({
      provider: "codex",
      role: "reviewer",
      cwd: repo,
      prompt: `Reply with exactly ${PROBE}`,
      model: "gpt-6-luna",
      effort: "low",
      access: "read-only",
      timeoutMs: 240_000,
    });
    console.log("codex result", JSON.stringify(result));
    try {
      expect(result.ok).toBe(true);
      expect(result.text).toContain(PROBE);
      expect(result.observedModel).toBe("gpt-6-luna");
      expect(result.observedEffort).toBe("low");
      expect(result.accessVerified).toBe(true);
      expect(result.threadId).toBeTruthy();
    } finally {
      if (result.threadId) {
        const archived = spawnSync(executable!, ["archive", result.threadId], {
          env: buildAgentEnv().env as NodeJS.ProcessEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        });
        console.log(
          "codex archive exit",
          archived.status,
          (archived.stdout + archived.stderr).trim(),
        );
      }
    }
  });

  it("Claude: claude-haiku-4-5-20251001, read-only — model verified", async () => {
    const result = await new ClaudeTeamRunner().run({
      provider: "claude-code",
      role: "reviewer",
      cwd: repo,
      prompt: `Reply with exactly ${PROBE}`,
      model: "claude-haiku-4-5-20251001",
      access: "read-only",
      timeoutMs: 240_000,
    });
    console.log("claude result", JSON.stringify(result));
    expect(result.ok).toBe(true);
    expect(result.text).toContain(PROBE);
    expect(result.observedModel).toBe("claude-haiku-4-5-20251001");
    expect(result.threadId).toBeTruthy();
  });
});
