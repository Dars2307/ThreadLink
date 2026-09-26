import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProviderDiscovery } from "../../runtime/src/team/discovery.ts";
import {
  HEALTH_DETAIL,
  ProviderHealthMonitor,
  buildClaudeProbeArgs,
  buildCodexProbeArgs,
  healthFromProbe,
  lightestModel,
  probeClaude,
  probeProvider,
  probeCodex,
  staticHealth,
  type ProbeFn,
  type ProbeResult,
} from "../../runtime/src/team/health.ts";
import {
  classifyFailureText,
  forbiddenArg,
  type AgentRunRequest,
  type SpawnFn,
} from "../../runtime/src/team/runner.ts";
import { ClaudeTeamRunner } from "../../runtime/src/team/runners/claude.ts";
import { CodexTeamRunner } from "../../runtime/src/team/runners/codex.ts";
import { VERDICT_REASONS } from "../../runtime/src/team/verdict-reasons.ts";

/**
 * Provider health: "status output is not proof of a working sign-in". A real
 * run failed with "Failed to refresh OAuth token" while `claude auth status`
 * said loggedIn: true. No real CLI is run here.
 */

vi.setConfig({ testTimeout: 60_000 });

const PRODUCTION_STDERR = "Claude Code reported an error (exit 1): Failed to refresh OAuth token";
const FAKE_CLAUDE = join(__dirname, "fake-claude-team.mjs");
const FAKE_CODEX = join(__dirname, "fake-codex.mjs");
const workdir = realpathSync(mkdtempSync(join(tmpdir(), "tl-health-")));

type Call = { args: string[]; options: SpawnOptions };
function fakeSpawn(script: string, calls: Call[]): SpawnFn {
  return ((_command: string, args: string[], options: SpawnOptions) => {
    calls.push({ args: [...args], options });
    return spawn(process.execPath, [script, ...args], options);
  }) as unknown as SpawnFn;
}

const discovery = (over: Partial<ProviderDiscovery> = {}): ProviderDiscovery => ({
  provider: "claude-code",
  installed: true,
  executable: "claude",
  version: "2.1.266",
  authenticated: true,
  authMethod: "claude.ai",
  detectedPlan: "max",
  models: [
    {
      id: "claude-sonnet-5",
      displayName: "Sonnet",
      description: null,
      efforts: [],
      defaultEffort: null,
      source: "configured",
    },
    {
      id: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: null,
      efforts: [],
      defaultEffort: null,
      source: "configured",
    },
    {
      id: "claude-opus-5-5",
      displayName: "Opus",
      description: null,
      efforts: [],
      defaultEffort: null,
      source: "configured",
    },
  ],
  currentModel: null,
  capabilities: {} as ProviderDiscovery["capabilities"],
  usage: { remaining: "unknown" },
  ...over,
});

const codexDiscovery = (over: Partial<ProviderDiscovery> = {}): ProviderDiscovery =>
  discovery({
    provider: "codex",
    executable: "codex.exe",
    authMethod: "chatgpt",
    models: [
      {
        id: "gpt-6-sol",
        displayName: "Sol",
        description: "Frontier model for the most demanding work",
        efforts: ["low", "high"],
        defaultEffort: "high",
        source: "catalog",
      },
      {
        id: "gpt-6-mini",
        displayName: "Mini",
        description: "Fast and affordable",
        efforts: ["low", "medium"],
        defaultEffort: "low",
        source: "catalog",
      },
    ],
    ...over,
  });

// ---------------------------------------------------------------------------
describe("classifying a failed run", () => {
  it("treats the literal production error as a sign-in problem, not a provider error", () => {
    expect(classifyFailureText(PRODUCTION_STDERR)).toBe("not_authenticated");
    expect(healthFromProbe(classifyFailureText(PRODUCTION_STDERR)!)).toBe("needs_sign_in");
  });

  it("recognises the other sign-in failures of both CLIs", () => {
    for (const t of [
      "Failed to refresh OAuth token",
      "error: invalid refresh token",
      "OAuth token has been revoked",
      "OAuth access is invalid for this account",
      "Please run claude /login",
      "Your session expired. Log in again.",
      "Please re-authenticate to continue",
      "Please reauthenticate",
      "Not logged in. Please run `codex login`",
      "You are not signed in",
      "401 Unauthorized",
      "access token has expired",
    ]) {
      expect(classifyFailureText(t), t).toBe("not_authenticated");
    }
    // Usage still wins over auth, and ordinary failures stay unclassified.
    expect(classifyFailureText("429 Too Many Requests")).toBe("quota_exhausted");
    expect(classifyFailureText("stream disconnected before completion")).toBeNull();
  });

  it("has the Claude runner report the production failure as not_authenticated", async () => {
    const calls: Call[] = [];
    const runner = new ClaudeTeamRunner({
      spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
      env: { ...process.env, FAKE_CT_MODE: "oauth_refresh" },
    });
    const req: AgentRunRequest = {
      provider: "claude-code",
      role: "coordinator",
      cwd: workdir,
      prompt: "Normalise.",
      model: "claude-sonnet-5",
      access: "read-only",
    };
    const result = await runner.run(req);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_STDERR);
    expect(result.failure).toBe("not_authenticated");

    const stderrOnly = await new ClaudeTeamRunner({
      spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
      env: { ...process.env, FAKE_CT_MODE: "oauth_stderr" },
    }).run(req);
    expect(stderrOnly.failure).toBe("not_authenticated");
  });

  it("has the Codex runner report a login-required failure as not_authenticated", async () => {
    const home = mkdtempSync(join(tmpdir(), "tl-health-codex-"));
    const runner = new CodexTeamRunner({
      executable: "codex.exe",
      codexHome: home,
      spawnFn: fakeSpawn(FAKE_CODEX, []),
      env: { ...process.env, CODEX_HOME: home, FAKE_CODEX_MODE: "login_required" },
    });
    const result = await runner.run({
      provider: "codex",
      role: "reviewer",
      cwd: workdir,
      prompt: "Review.",
      model: "gpt-6-sol",
      access: "read-only",
    });
    expect(result.failure).toBe("not_authenticated");
  });

  it("adds the two new verdict reasons at the end, in the agreed order", () => {
    expect(VERDICT_REASONS.slice(-2)).toEqual(["agent_needs_sign_in", "api_key_auth"]);
  });
});

// ---------------------------------------------------------------------------
describe("what discovery alone settles", () => {
  it("never probes a provider that is missing, signed out or on an API key", () => {
    expect(staticHealth(undefined)).toBe("not_installed");
    expect(staticHealth(discovery({ installed: false }))).toBe("not_installed");
    expect(staticHealth(discovery({ authenticated: false }))).toBe("needs_sign_in");
    expect(staticHealth(discovery({ authMethod: "api_key" }))).toBe("api_key_auth");
    expect(staticHealth(codexDiscovery({ authMethod: "unknown" }))).toBe("api_key_auth");
    // Signed in with the subscription: only a real call can say more.
    expect(staticHealth(discovery())).toBeNull();
    expect(staticHealth(codexDiscovery())).toBeNull();
  });

  it("maps probe results to health, with fixed text only", () => {
    const cases: [ProbeResult, string][] = [
      ["ok", "ready"],
      ["not_authenticated", "needs_sign_in"],
      ["quota_exhausted", "usage_exhausted"],
      ["not_installed", "not_installed"],
      ["timeout", "unknown"],
      ["provider_error", "unknown"],
    ];
    for (const [result, health] of cases) expect(healthFromProbe(result)).toBe(health);
    for (const text of Object.values(HEALTH_DETAIL)) expect(text.length).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
describe("the probe call", () => {
  it("is a tiny, tool-less, never-bare call on the lightest model", () => {
    expect(lightestModel(discovery())?.id).toBe("claude-haiku-4-5-20251001");
    expect(lightestModel(codexDiscovery())?.id).toBe("gpt-6-mini");

    const claude = buildClaudeProbeArgs("claude-haiku-4-5-20251001");
    expect(forbiddenArg(claude)).toBeNull();
    expect(claude).not.toContain("--bare");
    expect(claude.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    const tools = claude.indexOf("--tools");
    expect(claude[tools + 1]).toBe("");
    expect(claude).toContain("--safe-mode");
    expect(claude).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));

    const codex = buildCodexProbeArgs(lightestModel(codexDiscovery()), workdir, "linux");
    expect(forbiddenArg(codex)).toBeNull();
    expect(codex.slice(0, 5)).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
    ]);
    expect(codex).toEqual(expect.arrayContaining(["-s", "read-only", "-m", "gpt-6-mini"]));
    expect(codex).toContain('approval_policy="never"');
    expect(codex).toContain('model_reasoning_effort="low"');
    expect(codex.at(-1)!.startsWith("[")).toBe(true);
    expect(buildCodexProbeArgs(null, workdir, "win32")).toContain('windows.sandbox="unelevated"');
  });

  it("runs Claude with a scrubbed environment and reads the answer", async () => {
    const calls: Call[] = [];
    const ok = await probeClaude(discovery(), {
      spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-LEAK", FAKE_CT_MODE: "ok" },
    });
    expect(ok).toBe("ok");
    const env = calls[0]!.options.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FAKE_CT_MODE).toBe("ok");

    const signedOut = await probeClaude(discovery(), {
      spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
      env: { ...process.env, FAKE_CT_MODE: "oauth_refresh" },
    });
    expect(signedOut).toBe("not_authenticated");
    expect(
      await probeClaude(discovery(), {
        spawnFn: fakeSpawn(FAKE_CLAUDE, calls),
        env: { ...process.env, FAKE_CT_MODE: "quota" },
      }),
    ).toBe("quota_exhausted");
  });

  it("confirms a sign-in failure with a second call before believing it", async () => {
    // Seen for real: one failed OAuth refresh, then the next call worked.
    const modes = (seq: string[]) => {
      let i = 0;
      return ((_c: string, args: string[], options: SpawnOptions) =>
        spawn(process.execPath, [FAKE_CLAUDE, ...args], {
          ...options,
          env: {
            ...options.env,
            FAKE_CT_MODE: seq[Math.min(i++, seq.length - 1)],
          } as NodeJS.ProcessEnv,
        })) as unknown as SpawnFn;
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const once = probeProvider({ spawnFn: modes(["oauth_refresh", "ok"]), sleep });
    expect(await once("claude-code", discovery())).toBe("ok");
    expect(sleeps).toEqual([5_000]);

    const twice = probeProvider({ spawnFn: modes(["oauth_refresh", "oauth_refresh"]), sleep });
    expect(await twice("claude-code", discovery())).toBe("not_authenticated");

    // Anything else is believed at once: no second call.
    sleeps.length = 0;
    const ok = probeProvider({ spawnFn: modes(["ok"]), sleep });
    expect(await ok("claude-code", discovery())).toBe("ok");
    expect(sleeps).toEqual([]);
  });

  it("runs Codex read-only with stdin closed and reads the events", async () => {
    const home = mkdtempSync(join(tmpdir(), "tl-health-codex-"));
    const calls: Call[] = [];
    const run = (mode: string) =>
      probeCodex(codexDiscovery(), {
        spawnFn: fakeSpawn(FAKE_CODEX, calls),
        env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "sk-LEAK", FAKE_CODEX_MODE: mode },
      });
    expect(await run("ok")).toBe("ok");
    expect(calls[0]!.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect((calls[0]!.options.env as Record<string, string>).OPENAI_API_KEY).toBeUndefined();
    expect(await run("login_required")).toBe("not_authenticated");
    expect(await run("quota")).toBe("quota_exhausted");
    expect(await run("turn_failed")).toBe("provider_error");
  });
});

// ---------------------------------------------------------------------------
describe("when health is checked", () => {
  const MIN = 60_000;

  function monitor(results: Partial<Record<string, ProbeResult>> = {}) {
    let now = Date.parse("2026-09-26T10:00:00Z");
    const found = [discovery(), codexDiscovery()];
    const discover = vi.fn(async () => found);
    const probe = vi.fn<ProbeFn>(async (provider) => results[provider] ?? "ok");
    const changes: string[][] = [];
    const m = new ProviderHealthMonitor({
      discover,
      probe,
      now: () => now,
      onChange: (changed) => changes.push(changed),
    });
    return {
      m,
      probe,
      discover,
      changes,
      found,
      results,
      advance: (ms: number) => {
        now += ms;
      },
      probes: (provider: string) => probe.mock.calls.filter((c) => c[0] === provider).length,
    };
  }

  it("checks every provider at start and reports ready with a check time", async () => {
    const t = monitor();
    const records = await t.m.checkAll();
    expect(records.map((r) => [r.provider, r.health])).toEqual([
      ["claude-code", "ready"],
      ["codex", "ready"],
    ]);
    expect(records[0]!.checkedAt).toBe("2026-09-26T10:00:00.000Z");
    expect(records[0]!.detail).toBe(HEALTH_DETAIL.ready);
    expect(t.probe).toHaveBeenCalledTimes(2);
  });

  it("re-checks at most every 30 minutes while idle", async () => {
    const t = monitor();
    await t.m.tick();
    expect(t.probe).toHaveBeenCalledTimes(2);
    t.advance(29 * MIN);
    expect(await t.m.tick()).toBe(false);
    expect(t.probe).toHaveBeenCalledTimes(2);
    t.advance(2 * MIN);
    expect(await t.m.tick()).toBe(true);
    expect(t.probe).toHaveBeenCalledTimes(4);
  });

  it("re-checks at a claim only when the cached result is older than 10 minutes", async () => {
    const t = monitor();
    await t.m.checkAll();
    t.advance(9 * MIN);
    await t.m.ensureFresh(["claude-code"]);
    expect(t.probes("claude-code")).toBe(1);
    t.advance(2 * MIN);
    const fresh = await t.m.ensureFresh(["claude-code"]);
    expect(t.probes("claude-code")).toBe(2);
    expect(t.probes("codex")).toBe(1);
    expect(fresh["claude-code"].health).toBe("ready");
    expect(t.changes).toEqual([["claude-code"]]);
  });

  it("backs off for at least 10 minutes while a provider needs sign-in; Check again ignores that", async () => {
    const t = monitor({ "claude-code": "not_authenticated" });
    await t.m.checkAll();
    expect(t.m.get("claude-code").health).toBe("needs_sign_in");
    // A claim 11 minutes later is "stale", but the backoff is from the last probe.
    t.advance(5 * MIN);
    await t.m.ensureFresh(["claude-code"]);
    await t.m.checkAll();
    expect(t.probes("claude-code")).toBe(1);
    // The person clicks "Check again": probed now, whatever the backoff.
    t.results["claude-code"] = "ok";
    await t.m.checkAll({ force: true });
    expect(t.probes("claude-code")).toBe(2);
    expect(t.m.get("claude-code").health).toBe("ready");
  });

  it("probes again after the backoff has passed", async () => {
    const t = monitor({ "claude-code": "not_authenticated" });
    await t.m.checkAll();
    t.advance(10 * MIN + 1);
    await t.m.ensureFresh(["claude-code"]);
    expect(t.probes("claude-code")).toBe(2);
  });

  it("marks a provider at once after an auth failure in a real run, without a call", async () => {
    const t = monitor();
    await t.m.checkAll();
    t.advance(MIN);
    t.m.noteFailure("claude-code", "not_authenticated");
    expect(t.m.get("claude-code")).toMatchObject({
      health: "needs_sign_in",
      checkedAt: "2026-09-26T10:01:00.000Z",
    });
    expect(t.changes).toEqual([["claude-code"]]);
    expect(t.probes("claude-code")).toBe(1);
    // And the backoff applies from then: no probe loop while it lasts.
    t.advance(5 * MIN);
    await t.m.checkAll();
    expect(t.probes("claude-code")).toBe(1);
    t.advance(6 * MIN);
    await t.m.ensureFresh(["claude-code"]);
    expect(t.probes("claude-code")).toBe(2);
    expect(t.m.recentFailures()).toEqual({ "claude-code": 1 });
  });

  it("does not probe what discovery already settled", async () => {
    const t = monitor();
    t.found[0] = discovery({ authMethod: "api_key" });
    t.found[1] = codexDiscovery({ installed: false, executable: null });
    const records = await t.m.checkAll();
    expect(records.map((r) => r.health)).toEqual(["api_key_auth", "not_installed"]);
    expect(t.probe).not.toHaveBeenCalled();
  });

  it("shares one probe between callers that ask at the same time", async () => {
    const t = monitor();
    t.probe.mockImplementation(
      () => new Promise<ProbeResult>((resolve) => setTimeout(() => resolve("ok"), 30)),
    );
    await Promise.all([t.m.checkAll(), t.m.checkAll(), t.m.ensureFresh(["claude-code", "codex"])]);
    expect(t.probes("claude-code")).toBe(1);
    expect(t.probes("codex")).toBe(1);
  });

  it("treats a probe that throws as unknown, never as ready", async () => {
    const t = monitor();
    t.probe.mockImplementation(async () => {
      throw new Error("boom");
    });
    await t.m.checkAll();
    expect(t.m.get("codex").health).toBe("unknown");
  });
});
