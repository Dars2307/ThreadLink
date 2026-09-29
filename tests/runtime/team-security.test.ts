import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { teamWriteOpSchema } from "@/lib/team/model";

import { redactText } from "../../runtime/src/summary.ts";
import type { ProviderDiscovery } from "../../runtime/src/team/discovery.ts";
import { buildAgentEnv, isScrubbedVariable } from "../../runtime/src/team/env.ts";
import { TeamExecutor } from "../../runtime/src/team/executor.ts";
import { parseTeamJob, type TeamJobDefinition } from "../../runtime/src/team/job.ts";
import {
  TeamOrchestrator,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type TeamOp,
} from "../../runtime/src/team/orchestrator.ts";
import { graphPort } from "../../runtime/src/team/ports.ts";
import type { Plan, Review } from "../../runtime/src/team/prompts.ts";
import {
  READ_ONLY_ROLES,
  forbiddenArg,
  validateRequest,
  type RunAccess,
} from "../../runtime/src/team/runner.ts";
import { buildClaudeArgs } from "../../runtime/src/team/runners/claude.ts";
import { buildCodexArgs, readRolloutMetadata } from "../../runtime/src/team/runners/codex.ts";
import { TEAM_ROLES, type AgentProvider } from "../../runtime/src/team/types.ts";
import { UsageGovernor } from "../../runtime/src/team/usage.ts";
import { verifyEnv } from "../../runtime/src/team/verify.ts";
import { WorktreeManager, type JobWorktrees } from "../../runtime/src/team/worktrees.ts";

/**
 * Adversarial security review of the Team Mode Runtime.
 *
 * `it` cases pin down behaviour that was checked and found sound.
 * `it.fails` cases document a weakness found in review that is NOT fixed yet:
 * they assert the SAFE behaviour, currently fail, and so pass as "expected to
 * fail". When the weakness is fixed, vitest reports them as unexpectedly
 * passing -- turn them into plain `it` then.
 */

// Real git worktrees are slow on a loaded machine: generous limits, never a false failure.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

const UUID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// 1. Environment of agent processes
// ---------------------------------------------------------------------------
describe("agent environment scrubbing", () => {
  const PROVIDER_VARS = [
    "ANTHROPIC_API_KEY",
    "anthropic_api_key",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "OPENAI_API_KEY",
    "OpenAI_Base_Url",
    "OPENAI_ORG_ID",
    "CODEX_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "claude_code_use_bedrock",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "SOME_VENDOR_AUTH_TOKEN",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_EFFORT",
  ];

  it("removes every API-key and third-party-provider variable, in any case", () => {
    const parent = Object.fromEntries(PROVIDER_VARS.map((n) => [n, "secret-value"]));
    const { env, removed } = buildAgentEnv({
      ...parent,
      PATH: "/usr/bin",
      HOME: "/home/u",
      USERPROFILE: "C:\\Users\\u",
      APPDATA: "x",
      LOCALAPPDATA: "y",
      CODEX_HOME: "z",
      SystemRoot: "C:\\Windows",
    });
    for (const name of PROVIDER_VARS) expect(env[name], name).toBeUndefined();
    expect(Object.values(env)).not.toContain("secret-value");
    expect(removed.sort()).toEqual([...PROVIDER_VARS].sort());
    // What the CLIs need to find their own subscription login stays.
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/u", CODEX_HOME: "z" });
  });

  it("never reports a removed variable's value, only its name", () => {
    const { removed } = buildAgentEnv({ OPENAI_API_KEY: "sk-live-abc" });
    expect(removed).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(removed)).not.toContain("sk-live");
  });

  it("does not mistake ordinary variables for secrets", () => {
    for (const name of ["PATH", "HOME", "LANG", "TERM", "NODE_ENV", "CODEX_HOME", "GIT_DIR"]) {
      expect(isScrubbedVariable(name), name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. argv: every request combination, including resume
// ---------------------------------------------------------------------------
describe("agent argv under every request combination", () => {
  const cwd = tmpdir();
  const combos: AgentRunRequest[] = [];
  for (const provider of ["claude-code", "codex"] as const)
    for (const role of TEAM_ROLES)
      for (const access of ["read-only", "workspace-write"] as RunAccess[])
        for (const resumeThreadId of [undefined, UUID])
          for (const effort of [undefined, "high"])
            for (const outputSchema of [undefined, { type: "object" }])
              combos.push({
                provider,
                role,
                cwd,
                prompt: "[x] do it",
                model: provider === "codex" ? "gpt-6-sol" : "claude-sonnet-5",
                effort,
                access,
                resumeThreadId,
                outputSchema,
              });

  it("a reviewer role can never be given write access", () => {
    for (const req of combos) {
      const invalid = validateRequest(req, req.provider);
      if (READ_ONLY_ROLES.has(req.role) && req.access !== "read-only") {
        expect(invalid?.failure, `${req.role}`).toBe("access_mismatch");
      } else {
        expect(invalid, `${req.provider} ${req.role} ${req.access}`).toBeNull();
      }
    }
  });

  it("Claude always gets --safe-mode, an explicit permission mode, and nothing forbidden", () => {
    for (const req of combos.filter((c) => c.provider === "claude-code")) {
      const args = buildClaudeArgs(req);
      expect(forbiddenArg(args)).toBeNull();
      expect(args).toContain("--safe-mode");
      expect(args).not.toContain("--bare");
      expect(args.join(" ")).not.toMatch(/dangerous|bypass|fallback-model/i);
      const mode = args[args.indexOf("--permission-mode") + 1];
      expect(mode).toBe(req.access === "read-only" ? "plan" : "acceptEdits");
      if (req.access === "read-only") expect(args).toContain("--disallowed-tools");
      expect(args.filter((a) => a === "--model")).toHaveLength(1);
    }
  });

  it("Codex always ignores user config and rules, sets the sandbox and approval explicitly, never --ephemeral", () => {
    for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
      for (const req of combos.filter((c) => c.provider === "codex")) {
        const args = buildCodexArgs(req, {
          platform,
          schemaFile: req.outputSchema ? "s.json" : undefined,
        });
        expect(forbiddenArg(args)).toBeNull();
        expect(args).toContain("--ignore-user-config");
        expect(args).toContain("--ignore-rules");
        expect(args).not.toContain("--ephemeral");
        expect(args.join(" ")).not.toMatch(
          /danger-full-access|dangerously|--full-auto|--yolo|--oss/,
        );
        expect(args).toContain('approval_policy="never"');
        if (req.resumeThreadId) {
          expect(args).toContain(`sandbox_mode="${req.access}"`);
        } else {
          expect(args[args.indexOf("-s") + 1]).toBe(req.access);
          expect(args[args.indexOf("-C") + 1]).toBe(cwd);
        }
      }
    }
  });

  it("the last-line argv check catches every spelling of a forbidden flag or value", () => {
    for (const bad of [
      ["--bare"],
      ["--fallback-model=claude-haiku"],
      ["--dangerously-skip-permissions"],
      ["--dangerously-bypass-approvals-and-sandbox=true"],
      ["-c", 'sandbox_mode="danger-full-access"'],
      ["-s", "danger-full-access"],
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=bypassPermissions"],
      ["--ephemeral"],
    ]) {
      expect(forbiddenArg(["exec", ...bad]), bad.join(" ")).not.toBeNull();
    }
  });

  it("strings that reach argv cannot smuggle a flag or a config override", () => {
    const base = combos[0]!;
    for (const model of ["-rf", "--bare", "m x", 'm"', "m\n-s", "m;rm", ""]) {
      expect(validateRequest({ ...base, model }, base.provider), model).not.toBeNull();
    }
    for (const effort of ['high" -c sandbox_mode="danger-full-access', "HIGH", "hi gh", "-x"]) {
      expect(validateRequest({ ...base, effort }, base.provider), effort).not.toBeNull();
    }
    for (const resumeThreadId of ["--last", "../x", `${UUID} --bare`]) {
      expect(validateRequest({ ...base, resumeThreadId }, base.provider)).not.toBeNull();
    }
    expect(validateRequest({ ...base, cwd: "relative/dir" }, base.provider)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The Codex rollout: metadata only
// ---------------------------------------------------------------------------
describe("Codex rollout reader", () => {
  it("reads only top-level session_meta/turn_context lines, never message content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-rollout-"));
    try {
      const file = join(dir, `rollout-x-${UUID}.jsonl`);
      const lines = [
        { type: "session_meta", payload: { cwd: "/w" } },
        {
          type: "turn_context",
          payload: {
            cwd: "/w",
            model: "gpt-6-sol",
            effort: "high",
            approval_policy: "never",
            sandbox_policy: { type: "read-only" },
          },
        },
        // Message content crafted to look like metadata: must never be parsed.
        {
          timestamp: "t",
          type: "response_item",
          payload: {
            type: "turn_context",
            model: "evil",
            sandbox_policy: { type: "danger-full-access" },
          },
        },
      ].map((l) => JSON.stringify(l));
      // A string value that spells the metadata marker, and a duplicate-key trick.
      lines.push(
        '{"note":"\\"type\\":\\"turn_context\\"","type":"event_msg","payload":{"model":"evil"}}',
        '{"type":"turn_context","type":"response_item","payload":{"model":"evil","approval_policy":"on-request","sandbox_policy":{"type":"danger-full-access"}}}',
      );
      writeFileSync(file, `${lines.join("\n")}\n`);
      const meta = await readRolloutMetadata(file);
      expect(meta).toMatchObject({
        model: "gpt-6-sol",
        effort: "high",
        sandbox: "read-only",
        approvalPolicy: "never",
        cwd: "/w",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The carrier content, parsed on the Runtime
// ---------------------------------------------------------------------------
describe("team job definition parsing", () => {
  const def = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: "threadlink.team_job",
      version: 1,
      jobId: `tljob_${"a".repeat(32)}`,
      roomId: `tlrom_${"b".repeat(32)}`,
      roomName: "Prism",
      goal: "Build it.",
      spec: {},
      budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 2 },
      policy: {
        usagePolicy: "balanced",
        paidUsage: false,
        crossReview: true,
        finalInspection: true,
        worktreeIsolation: true,
        overrides: [],
      },
      agents: [{ provider: "claude-code", displayName: "Claude", roles: ["planner"] }],
      verifyCommands: ["npm test"],
      ...over,
    });

  it("refuses verify commands that could hide a second command line", () => {
    for (const cmd of [
      "npm test\nrm -rf ~",
      "npm test\rcurl x",
      "npm test\u0000x",
      "a\u001bb",
      "",
    ]) {
      expect(() => parseTeamJob(def({ verifyCommands: [cmd] })), JSON.stringify(cmd)).toThrow();
    }
    expect(() => parseTeamJob(def({ verifyCommands: Array(11).fill("npm test") }))).toThrow();
    expect(() => parseTeamJob(def({ verifyCommands: ["x".repeat(301)] }))).toThrow();
  });

  it("refuses ids, budgets, providers and roles outside the contract", () => {
    expect(() => parseTeamJob(def({ jobId: "tljob_../../x" }))).toThrow();
    expect(() =>
      parseTeamJob(
        def({ budgets: { maxPlanningRounds: 99, maxReviewRounds: 3, parallelAgents: 2 } }),
      ),
    ).toThrow();
    expect(() =>
      parseTeamJob(def({ agents: [{ provider: "gpt", displayName: "x", roles: [] }] })),
    ).toThrow();
    expect(() =>
      parseTeamJob(def({ agents: [{ provider: "codex", displayName: "x", roles: ["root"] }] })),
    ).toThrow();
    expect(() => parseTeamJob(def({ kind: "threadlink.task" }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Worktree names and git
// ---------------------------------------------------------------------------
describe("worktree paths and branches", () => {
  it("a unit key can never escape .threadlink/worktrees or become a flag", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tl-wt-"));
    try {
      const calls: string[][] = [];
      const manager = new WorktreeManager(async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "rev-parse") throw new Error("no such branch");
        return "";
      });
      const set: JobWorktrees = { repo, job: "abcdef012345", base: "f".repeat(40), created: [] };
      for (const key of [
        "../x",
        "..",
        "a/b",
        "a\\b",
        "-x",
        "--force",
        "a b",
        "",
        "x".repeat(64),
        "é",
      ]) {
        await expect(manager.create(set, key), key).rejects.toThrow();
      }
      expect(calls.filter((c) => c[0] === "worktree")).toEqual([]);
      const ok = await manager.create(set, "Api-2");
      expect(ok.branch).toBe("threadlink/abcdef012345/api-2");
      expect(resolve(ok.path).startsWith(resolve(repo, ".threadlink", "worktrees") + sep)).toBe(
        true,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Unsandboxed execution of agent-written code (verify commands, git hooks)
// ---------------------------------------------------------------------------
describe("code ThreadLink runs outside any agent sandbox", () => {
  it("verify commands (which execute agent-written tests) do not see provider API keys", () => {
    // `npm test` runs package.json scripts and test files the builders wrote.
    const env = verifyEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-live",
      OPENAI_API_KEY: "sk-live",
      CLAUDE_CODE_USE_BEDROCK: "1",
      THREADLINK_URL: "https://x",
    });
    expect(env.THREADLINK_URL).toBeUndefined(); // this part holds today
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  describe("git hooks written by an agent", () => {
    let repo: string;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "tl-hooks-"));
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "owner@example.com");
      git(repo, "config", "user.name", "Owner");
      git(repo, "config", "commit.gpgsign", "false");
      // A relative hooksPath, as husky and similar tools configure it.
      git(repo, "config", "core.hooksPath", ".githooks");
      writeFileSync(join(repo, "README.md"), "# x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "initial");
    });
    afterEach(() => {
      try {
        git(repo, "worktree", "prune");
      } catch {
        /* gone */
      }
      rmSync(repo, { recursive: true, force: true });
    });

    it("ThreadLink's own commit never runs a hook the builder wrote into its worktree", async () => {
      const manager = new WorktreeManager();
      const set = await manager.begin(repo, "abcdef012345");
      const record = await manager.create(set, "api");
      const marker = join(repo, "hook-ran.txt").replace(/\\/g, "/");
      // What a (prompt-injected) builder can write inside its own worktree.
      mkdirSync(join(record.path, ".githooks"), { recursive: true });
      writeFileSync(
        join(record.path, ".githooks", "post-commit"),
        `#!/bin/sh\necho "ran key=\${TL_REVIEW_FAKE_API_KEY:-none}" > "${marker}"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(record.path, "api.ts"), "export const x = 1;\n");
      process.env.TL_REVIEW_FAKE_API_KEY = "sk-fake-review";
      try {
        await manager.commit(record, "Build api", { authoredBy: ["Codex"], job: "j", task: "api" });
      } finally {
        delete process.env.TL_REVIEW_FAKE_API_KEY;
        await manager.cleanup(set);
      }
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "not run").toBe("not run");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Paid usage: an API-key login must not be used silently
// ---------------------------------------------------------------------------
describe("subscription-only authentication", () => {
  const discovery = (over: Partial<ProviderDiscovery>): ProviderDiscovery => ({
    provider: "claude-code",
    installed: true,
    executable: "claude",
    version: "1.0.0",
    authenticated: true,
    authMethod: "claude.ai",
    detectedPlan: "max",
    models: [],
    currentModel: null,
    capabilities: {} as ProviderDiscovery["capabilities"],
    usage: { remaining: "unknown" },
    ...over,
  });
  const job = JSON.stringify({
    kind: "threadlink.team_job",
    version: 1,
    jobId: `tljob_${"a".repeat(32)}`,
    roomId: `tlrom_${"b".repeat(32)}`,
    roomName: "Prism",
    goal: "Build it.",
    spec: {},
    budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 2 },
    policy: {
      usagePolicy: "balanced",
      paidUsage: false,
      crossReview: true,
      finalInspection: true,
      worktreeIsolation: true,
      overrides: [],
    },
    agents: [
      { provider: "claude-code", displayName: "Claude", roles: ["planner", "builder"] },
      { provider: "codex", displayName: "Codex", roles: ["reviewer"] },
    ],
    verifyCommands: [],
  });

  // The default runner selection is what is under test, so `runners` is NOT
  // injected. `begin` is the first thing a job does once it has decided both
  // agents may run; nothing is spawned before it.
  async function startsWork(found: ProviderDiscovery[]): Promise<boolean> {
    const begin = vi.fn(async () => {
      throw new Error("stop here");
    });
    const executor = new TeamExecutor({
      workspace: tmpdir(),
      sessionId: `tlses_${"c".repeat(32)}`,
      claimRef: "r",
      write: vi.fn(async () => ({})),
      governor: new UsageGovernor(),
      discover: async () => found,
      worktrees: { begin, cleanup: vi.fn() } as unknown as WorktreeManager,
    });
    await executor.execute(
      { taskId: "tltask_x", title: "t", content: job, priority: "C", taskType: "team" },
      new AbortController().signal,
    );
    return begin.mock.calls.length > 0;
  }

  it("subscription logins on both sides start work (control)", async () => {
    expect(
      await startsWork([
        discovery({}),
        discovery({ provider: "codex", executable: "codex.exe", authMethod: "chatgpt" }),
      ]),
    ).toBe(true);
  });

  it("a Codex logged in with an API key is not used while paid usage is off", async () => {
    expect(
      await startsWork([
        discovery({}),
        discovery({ provider: "codex", executable: "codex.exe", authMethod: "api_key" }),
      ]),
    ).toBe(false);
  });

  it("a Claude Code signed in with anything but a claude.ai subscription is not used while paid usage is off", async () => {
    expect(
      await startsWork([
        discovery({ authMethod: "console" }),
        discovery({ provider: "codex", executable: "codex.exe", authMethod: "chatgpt" }),
      ]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Redaction before anything reaches the server
// ---------------------------------------------------------------------------
describe("redaction of team text", () => {
  it("removes provider keys, tokens and ordinary absolute paths", () => {
    const out = redactText(
      [
        "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and ghp_abcdefghijklmnopqrstuv",
        "Authorization: Bearer abc.def.ghi",
        "see C:\\Users\\alice\\proj\\x.ts and /home/alice/proj/x.ts",
        "ThreadLink tlc_0123456789abcdef0123",
      ].join("\n"),
    );
    expect(out).not.toMatch(/sk-ant|ghp_|Bearer abc|alice|tlc_0123/);
  });

  it("strips terminal control sequences", () => {
    expect(redactText("a\u001b[31mb\u0007c")).not.toMatch(/[\u001b\u0007]/);
  });

  it("removes absolute paths the way test runners and stack traces print them", () => {
    const out = redactText(
      [
        "    at Object.<anonymous> (/Users/alice/proj/x.test.js:3:9)",
        " FAIL  C:/Users/alice/proj/x.test.ts",
        "file:///home/alice/proj/x.js",
        "C:\\Users\\Alice Smith\\proj\\x.ts",
      ].join("\n"),
    );
    expect(out).not.toMatch(/alice|Smith/i);
  });

  it("removes secrets assigned to prefixed variable names and inside URLs", () => {
    const out = redactText(
      [
        "DB_PASSWORD=hunter2",
        "MY_API_KEY=abc123",
        "STRIPE_SECRET=s3cr3t",
        "DATABASE_URL=postgres://app:pa55word@db.internal/app",
      ].join("\n"),
    );
    expect(out).not.toMatch(/hunter2|abc123|s3cr3t|pa55word/);
  });

  it("removes email addresses", () => {
    expect(redactText("Author: Alice <alice@example.com>")).not.toContain("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// 9. What the orchestrator actually sends (contract with the server schema)
// ---------------------------------------------------------------------------
describe("orchestrator writes", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tl-sec-orch-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "# Prism\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  });
  afterEach(() => {
    try {
      git("worktree", "prune");
    } catch {
      /* gone */
    }
    rmSync(repo, { recursive: true, force: true });
  });

  const SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRET";
  const SPEC = {
    goal: "x",
    requirements: ["Reports"],
    constraints: [],
    architectureConstraints: [],
    securityConstraints: [],
    filesAndSystems: [],
    testsRequired: [],
    doNotChange: [],
    deploymentRules: [],
    definitionOfDone: [],
  };
  const plan = (over: Partial<Plan["nodes"][number]> = {}, summary = "One unit."): Plan => ({
    summary,
    nodes: [
      {
        key: "api",
        title: "Unit api",
        scope: "Build the api",
        files: ["api.ts"],
        dependsOn: [],
        suggestedOwner: "claude-code",
        rationale: "fits",
        complexity: "medium",
        risk: { security: false, database: false, architecture: false, deployment: false },
        ...over,
      },
    ],
    risks: [],
  });
  const approve: Review = {
    verdict: "APPROVED",
    summary: "ok",
    findings: [],
    ownershipObjections: [],
  };

  type Script = {
    plan?: Plan;
    planReview?: Review;
    codeReview?: Review;
    buildSummary?: string;
    fail?: (req: AgentRunRequest) => Partial<AgentRunResult> | null;
    budgets?: TeamJobDefinition["budgets"];
  };

  async function run(script: Script = {}) {
    const runner = (provider: AgentProvider): AgentRunner => ({
      provider,
      verifiesAccess: provider === "codex",
      async run(req) {
        let structured: unknown;
        if (req.prompt.includes("precise engineering specification")) structured = SPEC;
        else if (req.role === "planner") structured = script.plan ?? plan();
        else if (req.prompt.includes("Review the plan")) structured = script.planReview ?? approve;
        else if (req.role === "builder") {
          writeFileSync(join(req.cwd, "api.ts"), "export const v = 1;\n");
          structured = {
            summary: script.buildSummary ?? "Built api",
            filesChanged: ["api.ts"],
            testsRun: [],
            openQuestions: [],
          };
        } else if (req.prompt.includes("Review the change"))
          structured = script.codeReview ?? approve;
        else
          structured = {
            verdict: "PASS",
            summary: "Meets the specification.",
            findings: [],
            requirementsMet: [{ requirement: "Reports", met: true, evidence: "t" }],
            uncertainty: [],
          };
        return {
          ok: true,
          text: "",
          structured,
          threadId: UUID,
          requestedModel: req.model,
          observedModel: req.model,
          observedEffort: null,
          accessVerified: true,
          permissionDenials: 0,
          ...(script.fail?.(req) ?? {}),
        };
      },
    });
    const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
    const rejected: { op: TeamOp; issues: string }[] = [];
    let seq = 0;
    const orchestrator = new TeamOrchestrator(
      {
        jobId: `tljob_${"a".repeat(32)}`,
        roomId: `tlrom_${"b".repeat(32)}`,
        roomName: "Prism",
        goal: "Build it.",
        spec: {},
        budgets: script.budgets ?? { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 1 },
        policy: {
          usagePolicy: "balanced",
          paidUsage: false,
          crossReview: true,
          finalInspection: true,
          worktreeIsolation: true,
          overrides: [],
        },
        agents: [
          {
            provider: "claude-code",
            displayName: "Claude",
            roles: ["planner", "builder", "integrator"],
          },
          { provider: "codex", displayName: "Codex", roles: ["builder", "reviewer"] },
        ],
        verifyCommands: [],
      },
      {
        runners: { "claude-code": runner("claude-code"), codex: runner("codex") },
        route: () => ({
          ok: true,
          model: "m-1",
          effort: null,
          modelClass: "BALANCED",
          reason: "test",
        }),
        graph: graphPort(),
        worktrees: new WorktreeManager(),
        verify: async () => [],
        sink: async (op, payload) => {
          ops.push({ op, payload });
          // The server's own zod contract for this op (lib/team/model.ts).
          const parsed = teamWriteOpSchema.safeParse({ op, payload });
          if (!parsed.success) rejected.push({ op, issues: parsed.error.message });
          if (op === "add_finding")
            return { findingId: `tlfnd_${String(++seq).padStart(32, "0")}` };
          return {};
        },
      },
    );
    const outcome = await orchestrator.run(repo);
    return { outcome, ops, rejected };
  }

  it("a clean run sends only payloads the server accepts, and the reviewer is never the author", async () => {
    const { outcome, ops, rejected } = await run();
    expect(rejected).toEqual([]);
    expect(outcome.verdict).toBe("PASS");
    const nodes = ops.find((o) => o.op === "upsert_nodes")!.payload.nodes as {
      owner: string;
      reviewer: string;
    }[];
    for (const n of nodes) expect(n.reviewer).not.toBe(n.owner);
  });

  it("messages are redacted before they are written", async () => {
    const { ops } = await run({ buildSummary: `Used ${SECRET} from C:\\Users\\alice\\.env` });
    const messages = ops
      .filter((o) => o.op === "add_message")
      .map((o) => JSON.stringify(o.payload));
    expect(messages.join("\n")).not.toMatch(/sk-ant|alice/);
  });

  it("the plan, the stored spec and node text are redacted before they are written", async () => {
    const { ops } = await run({
      plan: plan({ scope: `Rotate ${SECRET}`, title: "Move /home/alice/keys" }, `Uses ${SECRET}`),
    });
    const written = ops
      .filter((o) => ["set_plan", "upsert_nodes", "set_spec"].includes(o.op))
      .map((o) => JSON.stringify(o.payload))
      .join("\n");
    expect(written).not.toMatch(/sk-ant|alice/);
  });

  it("a long finding summary is bounded to what the server accepts (else the job crashes)", async () => {
    let n = 0;
    const { rejected } = await run({
      fail: (req) =>
        req.prompt.includes("Review the change") && n++ === 0
          ? {
              structured: {
                verdict: "REVISE",
                summary: "x",
                findings: [
                  {
                    severity: "important",
                    category: "correctness",
                    summary: "S".repeat(300),
                    detail: "d",
                    file: null,
                    line: null,
                  },
                ],
                ownershipObjections: [],
              },
            }
          : null,
    });
    expect(rejected).toEqual([]);
  });

  it("a message body is bounded in bytes, not only characters (else the job crashes)", async () => {
    const { rejected } = await run({ buildSummary: "漢".repeat(3000) });
    expect(rejected).toEqual([]);
  });

  it("a failed run without a classified failure is still recorded with a valid outcome", async () => {
    const { rejected } = await run({
      fail: (req) =>
        req.role === "coordinator" ? { ok: false, error: "boom", failure: undefined } : null,
    });
    expect(rejected).toEqual([]);
  });

  it("a decision that needs the user is written so the server counts it as waiting (no resolution)", async () => {
    const revise: Review = {
      verdict: "REVISE",
      summary: "no",
      findings: [
        {
          severity: "blocking",
          category: "architecture",
          summary: "bad",
          detail: "d",
          file: null,
          line: null,
        },
      ],
      ownershipObjections: [],
      // 0.11 §3.5: an owner-level disagreement (a technical one is arbitrated).
      disagreementCategory: "unresolved_requirement",
    };
    const { ops, outcome } = await run({
      planReview: revise,
      budgets: { maxPlanningRounds: 1, maxReviewRounds: 1, parallelAgents: 1 },
    });
    expect(outcome.verdict).toBe("NEEDS_USER_DECISION");
    // 0.10: the owner's question is a plan_disagreement choice (§4); no decision
    // title fits "not agreed", so none is written with a made-up one.
    expect(ops.filter((o) => o.op === "request_choice").map((o) => o.payload.kind)).toEqual([
      "plan_disagreement",
    ]);
    const needsUser = ops.filter((o) => o.op === "add_decision" && o.payload.needsUser === true);
    // team_decisions: "waiting for the user" == requires_user AND resolution IS NULL.
    for (const d of needsUser) expect(d.payload.resolution).toBeUndefined();
  });
});
