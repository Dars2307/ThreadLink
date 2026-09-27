import { spawn, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CLAUDE_VERIFIED_ALIASES,
  ClaudeTeamRunner,
  buildClaudeArgs,
  claudeModelMatches,
  observedClaudeModels,
} from "../../runtime/src/team/runners/claude.ts";
import {
  CODEX_ARGV_PROMPT_LIMIT,
  CodexTeamRunner,
  buildCodexArgs,
  readRolloutMetadata,
} from "../../runtime/src/team/runners/codex.ts";
import {
  classifyFailureText,
  forbiddenArg,
  parseStructured,
  type AgentRunRequest,
  type AgentRunResult,
  type RunAccess,
  type SpawnFn,
} from "../../runtime/src/team/runner.ts";
import { TEAM_ROLES, type TeamRole } from "../../runtime/src/team/types.ts";

const FAKE_CLAUDE = join(__dirname, "fake-claude-team.mjs");
const FAKE_CODEX = join(__dirname, "fake-codex.mjs");
const ROLLOUT_SECRET = "FAKE_ROLLOUT_SECRET_MESSAGE_CONTENT_7f3a";
const READ_ONLY_ROLES = new Set<TeamRole>(["reviewer", "security_reviewer", "test_reviewer"]);
const ACCESSES: RunAccess[] = ["read-only", "workspace-write"];

const root = realpathSync(mkdtempSync(join(tmpdir(), "tl-team-runners-")));
const workdir = join(root, "worktree");
mkdirSync(workdir);
afterAll(() => {
  /* temp dirs are left to the OS: a killed child on Windows can hold them briefly */
});

/** Leaked-looking parent env: none of these may reach a child. */
const LEAKY_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-LEAK",
  ANTHROPIC_AUTH_TOKEN: "LEAK",
  ANTHROPIC_BASE_URL: "https://proxy.invalid",
  OPENAI_API_KEY: "sk-LEAK",
  OPENAI_BASE_URL: "https://proxy.invalid",
  CODEX_API_KEY: "LEAK",
  AZURE_OPENAI_API_KEY: "LEAK",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  AWS_BEARER_TOKEN_BEDROCK: "LEAK",
  SOME_SERVICE_API_KEY: "LEAK",
  CLAUDECODE: "1",
};

type Call = { command: string; args: string[]; options: SpawnOptions };

function fakeSpawn(script: string, calls: Call[]): SpawnFn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args: [...args], options });
    return spawn(process.execPath, [script, ...args], options);
  }) as unknown as SpawnFn;
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    provider: "claude-code",
    role: "builder",
    cwd: workdir,
    prompt: "Do the thing.",
    model: "claude-haiku-4-5-20251001",
    access: "read-only",
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pids: number[], ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.every((p) => !isAlive(p));
}

const SCHEMA = {
  title: "ReviewVerdict",
  type: "object",
  properties: { verdict: { type: "string" }, findings: { type: "array" } },
  required: ["verdict"],
};

// =============================================================================
describe("shared runner helpers", () => {
  it("flags every forbidden flag and value", () => {
    for (const bad of [
      "--bare",
      "--fallback-model",
      "--dangerously-skip-permissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--oss",
      "--ephemeral",
      "danger-full-access",
      'sandbox_mode="danger-full-access"',
      "bypassPermissions",
    ]) {
      expect(forbiddenArg(["-p", bad]), bad).not.toBeNull();
    }
    expect(forbiddenArg(["-p", "--model", "x"])).toBeNull();
  });

  it("classifies quota and auth failures", () => {
    for (const t of [
      "Claude AI usage limit reached|1760000000",
      "You've hit your usage limit",
      "Rate limit exceeded",
      "429 Too Many Requests",
      "You have exceeded your current quota",
      "5-hour limit reached",
    ]) {
      expect(classifyFailureText(t), t).toBe("quota_exhausted");
    }
    for (const t of ["Not logged in · Please run /login", "401 Unauthorized", "Invalid API key"]) {
      expect(classifyFailureText(t), t).toBe("not_authenticated");
    }
    expect(classifyFailureText("tool failed")).toBeNull();
  });

  it("parses structured output strictly, never inventing a structure", () => {
    expect(parseStructured('{"verdict":"PASS"}', SCHEMA)).toEqual({
      ok: true,
      value: { verdict: "PASS" },
    });
    expect(parseStructured('```json\n{"verdict":"X"}\n```', SCHEMA)).toMatchObject({ ok: true });
    expect(parseStructured("looks fine", SCHEMA)).toMatchObject({ ok: false });
    expect(parseStructured("[1,2]", SCHEMA)).toMatchObject({ ok: false });
    expect(parseStructured('{"other":1}', SCHEMA)).toMatchObject({ ok: false });
  });
});

// =============================================================================
describe("Claude team runner", { timeout: 30_000 }, () => {
  const runner = (calls: Call[], mode = "ok", extraEnv: Record<string, string> = {}) =>
    new ClaudeTeamRunner({
      command: "claude",
      spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
      env: { ...process.env, ...LEAKY_ENV, FAKE_CT_MODE: mode, ...extraEnv },
    });

  it("asks Claude Code to validate a structured answer against the schema itself", () => {
    // A real run showed that asking for JSON in the prompt alone is not
    // enough: Haiku answered a planning prompt in prose.
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const args = buildClaudeArgs(
      request({ role: "reviewer", access: "read-only", outputSchema: schema }),
    );
    const at = args.indexOf("--json-schema");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(args[at + 1]!)).toEqual(schema);
    expect(buildClaudeArgs(request({ role: "builder", access: "workspace-write" }))).not.toContain(
      "--json-schema",
    );
  });

  it("builds the exact argv for every role and access", () => {
    for (const role of TEAM_ROLES) {
      for (const access of ACCESSES) {
        const args = buildClaudeArgs(request({ role, access }));
        const expected =
          access === "read-only"
            ? [
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-haiku-4-5-20251001",
                "--safe-mode",
                "--permission-mode",
                "plan",
                "--permission-prompts",
                "none",
                "--disallowed-tools",
                "Edit,Write,NotebookEdit",
              ]
            : [
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-haiku-4-5-20251001",
                "--safe-mode",
                "--permission-mode",
                "acceptEdits",
                "--permission-prompts",
                "none",
              ];
        expect(args, `${role}/${access}`).toEqual(expected);
        expect(forbiddenArg(args)).toBeNull();
      }
    }
    expect(
      buildClaudeArgs(
        request({ effort: "high", resumeThreadId: "22222222-3333-4444-8555-666666666666" }),
      ),
    ).toEqual([
      "-p",
      "--resume",
      "22222222-3333-4444-8555-666666666666",
      "--output-format",
      "json",
      "--model",
      "claude-haiku-4-5-20251001",
      "--effort",
      "high",
      "--safe-mode",
      "--permission-mode",
      "plan",
      "--permission-prompts",
      "none",
      "--disallowed-tools",
      "Edit,Write,NotebookEdit",
    ]);
  });

  it("runs with stdin closed, a scrubbed env and the observed model verified", async () => {
    const calls: Call[] = [];
    const r = await runner(calls).run(request());
    expect(r).toMatchObject({
      ok: true,
      observedModel: "claude-haiku-4-5-20251001",
      requestedModel: "claude-haiku-4-5-20251001",
      threadId: "22222222-3333-4444-8555-666666666666",
      accessVerified: false,
      permissionDenials: 0,
      usage: { inputTokens: 100, outputTokens: 42 },
    });
    // The child saw EOF on stdin (it only answers after "end") and none of the leaky vars.
    expect(r.text).toContain("stdinEOF=true");
    expect(r.text).toContain("env=[]");
    expect(r.text).toContain("projectRules=true");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(buildClaudeArgs(request()));
    expect((call.options.stdio as string[])[0]).toBe("pipe");
    expect(call.options.shell).toBe(false);
    expect(call.options.cwd).toBe(workdir);
    const env = call.options.env as Record<string, string>;
    for (const key of Object.keys(LEAKY_ENV)) expect(env[key], key).toBeUndefined();
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it("takes the model with most output tokens as primary and records all", async () => {
    const r = await runner([], "side_model").run(request({ model: "claude-sonnet-5" }));
    expect(r.ok).toBe(true);
    expect(r.observedModel).toBe("claude-sonnet-5");
    expect(r.observedModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(observedClaudeModels({ a: { outputTokens: 1 }, b: { outputTokens: 9 } })).toEqual({
      primary: "b",
      all: ["b", "a"],
    });
  });

  it("fails closed when `haiku` silently runs Sonnet (verified behaviour)", async () => {
    const r = await runner([]).run(request({ model: "haiku" }));
    expect(r).toMatchObject({
      ok: false,
      failure: "model_mismatch",
      requestedModel: "haiku",
      observedModel: "claude-sonnet-5",
    });
  });

  it("accepts only verified aliases and dated snapshots", async () => {
    expect(CLAUDE_VERIFIED_ALIASES).not.toHaveProperty("haiku");
    const r = await runner([]).run(request({ model: "sonnet" }));
    expect(r).toMatchObject({ ok: true, observedModel: "claude-sonnet-5" });
    expect(claudeModelMatches("claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(true);
    expect(claudeModelMatches("claude-sonnet-5", "claude-sonnet-5[1m]")).toBe(true);
    expect(claudeModelMatches("claude-haiku-4-5", "claude-sonnet-5")).toBe(false);
    expect(claudeModelMatches("opus", "claude-opus-anything")).toBe(false);
  });

  it("fails closed on a different or unreported model", async () => {
    expect(await runner([], "wrong_model").run(request())).toMatchObject({
      ok: false,
      failure: "model_mismatch",
      observedModel: "claude-other-model",
    });
    expect(await runner([], "no_model_usage").run(request())).toMatchObject({
      ok: false,
      failure: "model_mismatch",
      observedModel: null,
    });
  });

  it("maps usage exhaustion, logged-out and garbage output", async () => {
    expect(await runner([], "quota").run(request())).toMatchObject({
      ok: false,
      failure: "quota_exhausted",
    });
    expect(await runner([], "unauth").run(request())).toMatchObject({
      ok: false,
      failure: "not_authenticated",
    });
    expect(await runner([], "garbage").run(request())).toMatchObject({
      ok: false,
      failure: "provider_error",
    });
  });

  it("reports a missing binary as not_installed", async () => {
    const r = await new ClaudeTeamRunner({
      command: join(root, "no-such-claude.exe"),
      env: process.env,
    }).run(request());
    expect(r).toMatchObject({ ok: false, failure: "not_installed" });
  });

  it("counts permission denials", async () => {
    const r = await runner([], "denials").run(request());
    expect(r).toMatchObject({ ok: true, permissionDenials: 2 });
  });

  it("parses and validates structured output", async () => {
    const ok = await runner([], "structured").run(request({ outputSchema: SCHEMA }));
    expect(ok).toMatchObject({ ok: true, structured: { verdict: "PASS", findings: [] } });
    const fenced = await runner([], "structured_fenced").run(request({ outputSchema: SCHEMA }));
    expect(fenced).toMatchObject({ ok: true, structured: { verdict: "NEEDS_FIX" } });
    const bad = await runner([], "structured_bad").run(request({ outputSchema: SCHEMA }));
    expect(bad).toMatchObject({ ok: false, failure: "provider_error" });
    expect(bad.structured).toBeUndefined();
    const prompt = await runner([], "ok").run(request({ outputSchema: SCHEMA }));
    expect(prompt.text).toContain("schemaInPrompt=true");
  });

  it("resumes its own thread and refuses a different answering session", async () => {
    const id = "33333333-4444-4555-8666-777777777777";
    const calls: Call[] = [];
    const r = await runner(calls).run(request({ resumeThreadId: id }));
    expect(r).toMatchObject({ ok: true, threadId: id });
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-p", "--resume", id]);
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(root, "claude-pids.txt");
    const r = await runner([], "hang", { FAKE_PID_FILE: pidFile }).run(
      request({ timeoutMs: 1_500 }),
    );
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
    const pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
    expect(pids).toHaveLength(2);
    expect(await waitDead(pids)).toBe(true);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    const pending = runner([], "hang").run(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 500);
    expect(await pending).toMatchObject({ ok: false, failure: "cancelled" });
  });

  it("rejects unsafe requests before spawning anything", async () => {
    const calls: Call[] = [];
    const r = runner(calls);
    const cases: [Partial<AgentRunRequest>, string][] = [
      [{ model: "--bare" }, "provider_error"],
      [{ model: "claude haiku" }, "provider_error"],
      [{ effort: "--max" }, "provider_error"],
      [{ resumeThreadId: "--continue" }, "provider_error"],
      [{ cwd: "relative/dir" }, "provider_error"],
      [{ cwd: join(root, "missing") }, "provider_error"],
      [{ role: "reviewer", access: "workspace-write" }, "access_mismatch"],
      [{ role: "security_reviewer", access: "workspace-write" }, "access_mismatch"],
      [{ provider: "codex" }, "provider_error"],
      [{ prompt: "   " }, "provider_error"],
    ];
    for (const [overrides, failure] of cases) {
      const result = await r.run(request(overrides));
      expect(result, JSON.stringify(overrides)).toMatchObject({ ok: false, failure });
    }
    expect(calls).toHaveLength(0);
    for (const role of READ_ONLY_ROLES) {
      expect(
        await r.run(request({ role, access: "read-only", model: "claude-sonnet-5" })),
      ).toMatchObject({
        ok: true,
      });
    }
  });
});

// =============================================================================
describe("Codex team runner", { timeout: 30_000 }, () => {
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const codexRequest = (overrides: Partial<AgentRunRequest> = {}) =>
    request({ provider: "codex", model: "gpt-6-luna", effort: "low", ...overrides });
  const runner = (calls: Call[], mode = "ok", extraEnv: Record<string, string> = {}) =>
    new CodexTeamRunner({
      executable: join(root, "codex.exe"), // never executed: the fake spawn runs node
      spawnFn: fakeSpawn(FAKE_CODEX, calls),
      env: {
        ...process.env,
        ...LEAKY_ENV,
        CODEX_HOME: codexHome,
        FAKE_CODEX_MODE: mode,
        ...extraEnv,
      },
      rolloutWaitMs: 300,
    });
  const noSecret = (r: AgentRunResult) => expect(JSON.stringify(r)).not.toContain(ROLLOUT_SECRET);

  it("builds the exact argv for every role and access", () => {
    for (const role of TEAM_ROLES) {
      for (const access of ACCESSES) {
        const args = buildCodexArgs(codexRequest({ role, access }), { platform: "linux" });
        expect(args, `${role}/${access}`).toEqual([
          "exec",
          "--json",
          "--ignore-user-config",
          "--ignore-rules",
          "-s",
          access,
          "-c",
          'approval_policy="never"',
          "-m",
          "gpt-6-luna",
          "-c",
          'model_reasoning_effort="low"',
          "-C",
          workdir,
        ]);
        expect(forbiddenArg(args)).toBeNull();
      }
    }
    // Windows: without a sandbox backend Codex silently ran workspace-write as
    // read-only in a real run. The unelevated backend is always named there.
    for (const access of ACCESSES) {
      const win = buildCodexArgs(codexRequest({ access }), { platform: "win32" });
      const at = win.indexOf('windows.sandbox="unelevated"');
      expect(at, access).toBeGreaterThan(0);
      expect(win[at - 1]).toBe("-c");
      expect(forbiddenArg(win)).toBeNull();
    }
    const resumedOnWindows = buildCodexArgs(
      codexRequest({ resumeThreadId: "019d0000-0000-7000-8000-000000000002" }),
      { platform: "win32" },
    );
    expect(resumedOnWindows).toContain('windows.sandbox="unelevated"');
    const id = "019d0000-0000-7000-8000-000000000001";
    expect(
      buildCodexArgs(codexRequest({ resumeThreadId: id, effort: undefined }), {
        schemaFile: "/tmp/s.json",
        platform: "linux",
      }),
    ).toEqual([
      "exec",
      "resume",
      id,
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "-m",
      "gpt-6-luna",
      "--output-schema",
      "/tmp/s.json",
    ]);
  });

  it("runs with stdin never opened, a scrubbed env, and model/effort/sandbox verified", async () => {
    const calls: Call[] = [];
    const r = await runner(calls).run(codexRequest());
    expect(r).toMatchObject({
      ok: true,
      requestedModel: "gpt-6-luna",
      observedModel: "gpt-6-luna",
      observedEffort: "low",
      accessVerified: true,
      permissionDenials: 0,
      usage: { inputTokens: 120, outputTokens: 7 },
    });
    expect(r.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.text).toContain("env=[]");
    expect(r.text).toContain("codexHome=set");
    expect(r.text).toContain("viaStdin=false");
    expect(r.text).toContain("rolePrompt=true");
    const call = calls[0]!;
    expect((call.options.stdio as string[])[0]).toBe("ignore");
    expect(call.options.shell).toBe(false);
    expect(call.args.slice(0, -1)).toEqual(buildCodexArgs(codexRequest()));
    expect(call.args.at(-1)!.startsWith("[ThreadLink Team Mode]")).toBe(true);
    const env = call.options.env as Record<string, string>;
    for (const key of Object.keys(LEAKY_ENV)) expect(env[key], key).toBeUndefined();
    expect(env.CODEX_HOME).toBe(codexHome);
    noSecret(r);
  });

  it("verifies workspace-write the same way", async () => {
    const r = await runner([]).run(codexRequest({ access: "workspace-write" }));
    expect(r).toMatchObject({ ok: true, accessVerified: true });
  });

  it("sends a prompt too long for argv through stdin, then closes it", async () => {
    const calls: Call[] = [];
    const long = "x".repeat(CODEX_ARGV_PROMPT_LIMIT + 10);
    const r = await runner(calls).run(codexRequest({ prompt: long }));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("viaStdin=true");
    expect(calls[0]!.args.at(-1)).toBe("-");
    expect((calls[0]!.options.stdio as string[])[0]).toBe("pipe");
  });

  it("fails closed on a model mismatch", async () => {
    const r = await runner([], "wrong_model").run(codexRequest());
    expect(r).toMatchObject({
      ok: false,
      failure: "model_mismatch",
      observedModel: "gpt-other-model",
    });
    noSecret(r);
  });

  it("fails closed on a sandbox or working-directory mismatch", async () => {
    for (const access of ACCESSES) {
      const r = await runner([], "wrong_sandbox").run(codexRequest({ access }));
      expect(r, access).toMatchObject({
        ok: false,
        failure: "access_mismatch",
        accessVerified: false,
      });
    }
    expect(await runner([], "wrong_cwd").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "access_mismatch",
    });
  });

  it("fails closed when the rollout cannot be found", async () => {
    expect(await runner([], "no_rollout").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "model_mismatch",
      observedModel: null,
    });
  });

  it("maps quota, auth and other failures; never retries elsewhere", async () => {
    const calls: Call[] = [];
    expect(await runner(calls, "quota").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "quota_exhausted",
    });
    expect(calls).toHaveLength(1);
    expect(await runner([], "unauth").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "not_authenticated",
    });
    expect(await runner([], "turn_failed").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "provider_error",
    });
    expect(await runner([], "exit_nonzero").run(codexRequest())).toMatchObject({
      ok: false,
      failure: "provider_error",
    });
  });

  it("reports a missing binary as not_installed", async () => {
    const r = await new CodexTeamRunner({
      executable: join(root, "no-such-codex.exe"),
      env: { ...process.env, CODEX_HOME: codexHome },
    }).run(codexRequest());
    expect(r).toMatchObject({ ok: false, failure: "not_installed" });
  });

  it("passes a schema file, parses the answer, and deletes the file", async () => {
    const calls: Call[] = [];
    const r = await runner(calls, "structured").run(codexRequest({ outputSchema: SCHEMA }));
    expect(r).toMatchObject({
      ok: true,
      structured: { verdict: "PASS", schemaTitle: "ReviewVerdict" },
    });
    const args = calls[0]!.args;
    const schemaFile = args[args.indexOf("--output-schema") + 1]!;
    expect(existsSync(schemaFile)).toBe(false);
    const bad = await runner([], "structured_bad").run(codexRequest({ outputSchema: SCHEMA }));
    expect(bad).toMatchObject({ ok: false, failure: "provider_error" });
  });

  it("resumes its own thread with explicit access and re-verifies it", async () => {
    const first = await runner([]).run(codexRequest());
    expect(first.ok).toBe(true);
    const calls: Call[] = [];
    const second = await runner(calls).run(
      codexRequest({ resumeThreadId: first.threadId!, prompt: "Continue." }),
    );
    expect(second).toMatchObject({ ok: true, threadId: first.threadId, accessVerified: true });
    expect(calls[0]!.args.slice(0, 3)).toEqual(["exec", "resume", first.threadId]);
    expect(calls[0]!.args).toContain('sandbox_mode="read-only"');
    expect(calls[0]!.args).not.toContain("-s");
    noSecret(second);
    // A resumed turn with the wrong sandbox is caught from the newest turn_context.
    const wrong = await runner([], "wrong_sandbox").run(
      codexRequest({ resumeThreadId: first.threadId!, prompt: "Again." }),
    );
    expect(wrong).toMatchObject({ ok: false, failure: "access_mismatch" });
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(root, "codex-pids.txt");
    const r = await runner([], "hang", { FAKE_PID_FILE: pidFile }).run(
      codexRequest({ timeoutMs: 1_500 }),
    );
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
    const pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
    expect(await waitDead(pids)).toBe(true);
  });

  it("reads only metadata lines of a rollout", async () => {
    const file = join(root, "rollout-test.jsonl");
    const lines = [
      {
        timestamp: "t",
        type: "session_meta",
        payload: { id: "x", cwd: workdir, base_instructions: { text: ROLLOUT_SECRET } },
      },
      {
        timestamp: "t",
        type: "response_item",
        payload: { type: "message", text: ROLLOUT_SECRET, model: "gpt-evil" },
      },
      {
        timestamp: "t",
        type: "turn_context",
        payload: {
          model: "gpt-6-luna",
          effort: "low",
          cwd: workdir,
          approval_policy: "never",
          sandbox_policy: { type: "read-only" },
        },
      },
      {
        timestamp: "t",
        type: "event_msg",
        payload: { type: "turn_context", model: "gpt-evil-2", sandbox_policy: { type: "danger" } },
      },
    ];
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    const meta = await readRolloutMetadata(file);
    expect(meta).toEqual({
      file,
      model: "gpt-6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd: workdir,
    });
    expect(JSON.stringify(meta)).not.toContain(ROLLOUT_SECRET);
  });
});
