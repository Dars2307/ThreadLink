/**
 * Provider certification (docs/design/threadlink-0.10.md §10).
 *
 * One table of required checks, run against every adapter: against the fake
 * CLIs (tests/runtime/fake-*.mjs) always, and against the real CLIs on this
 * computer when THREADLINK_REAL_AGENTS=1. A provider is "Supported" only if
 * every check that applies to its mode passes.
 *
 * Adding a provider: give it a CertAdapter (how to discover it, how to build
 * its runner, how to make its fake misbehave) and it is held to the same
 * table. A check that cannot be exercised against a real CLI without harm or
 * cost (quota, API-key sign-in, a wrong model) is fake-only.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capabilitiesOf } from "../../../runtime/src/team/capabilities.ts";
import {
  discoverClaude,
  discoverCodex,
  type ProviderDiscovery,
} from "../../../runtime/src/team/discovery.ts";
import { lightestModel } from "../../../runtime/src/team/health.ts";
import { usableForTeam } from "../../../runtime/src/team/providers.ts";
import {
  forbiddenArg,
  type AgentRunRequest,
  type AgentRunResult,
  type SpawnFn,
} from "../../../runtime/src/team/runner.ts";
import {
  ClaudeTeamRunner,
  buildClaudeArgs,
  claudeModelMatches,
} from "../../../runtime/src/team/runners/claude.ts";
import { CodexTeamRunner, buildCodexArgs } from "../../../runtime/src/team/runners/codex.ts";

const HERE = join(__dirname, "..");
const FAKE_CLAUDE = join(HERE, "fake-claude-team.mjs");
const FAKE_CODEX = join(HERE, "fake-codex.mjs");

/** Env that must never reach an agent. */
export const LEAKY_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-LEAK",
  ANTHROPIC_AUTH_TOKEN: "LEAK",
  OPENAI_API_KEY: "sk-LEAK",
  CODEX_API_KEY: "LEAK",
  SOME_SERVICE_API_KEY: "LEAK",
};

export type SpawnCall = { command: string; args: string[]; options: SpawnOptions };

export type CertRunner = {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  calls: SpawnCall[];
};

export type CertAdapter = {
  id: "claude-code" | "codex";
  real: boolean;
  /** A working directory for runs (an empty git-free folder). */
  workdir: string;
  discover(auth?: "subscription" | "apikey" | "none"): Promise<ProviderDiscovery>;
  /** `behaviour` selects the fake's mode; ignored for a real CLI. */
  runner(behaviour?: string, extraEnv?: Record<string, string>): CertRunner;
  /** The model a run asks for. */
  model(): Promise<string>;
  argv(request: AgentRunRequest): string[];
  modelMatches(requested: string, observed: string): boolean;
};

function recordingSpawn(script: string | null, calls: SpawnCall[]): SpawnFn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args: [...args], options });
    return script
      ? spawn(process.execPath, [script, ...args], options)
      : spawn(command, args, options);
  }) as unknown as SpawnFn;
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function claudeAdapter(real: boolean): CertAdapter {
  const workdir = tempDir("tl-cert-claude-");
  let discovered: ProviderDiscovery | null = null;
  const discover = async (auth: "subscription" | "apikey" | "none" = "subscription") => {
    const d = await discoverClaude(
      real
        ? {}
        : {
            claudeCommand: "claude",
            spawnFn: recordingSpawn(FAKE_CLAUDE, []),
            env: {
              ...process.env,
              FAKE_CT_AUTH: auth === "subscription" ? "max" : auth,
            },
          },
    );
    if (auth === "subscription") discovered = d;
    return d;
  };
  return {
    id: "claude-code",
    real,
    workdir,
    discover,
    runner(behaviour = "ok", extraEnv = {}) {
      const calls: SpawnCall[] = [];
      const runner = new ClaudeTeamRunner({
        command: real ? (discovered?.executable ?? "claude") : "claude",
        spawnFn: recordingSpawn(real ? null : FAKE_CLAUDE, calls),
        env: real
          ? { ...process.env, ...LEAKY_ENV, ...extraEnv }
          : { ...process.env, ...LEAKY_ENV, FAKE_CT_MODE: behaviour, ...extraEnv },
      });
      return { run: (r) => runner.run(r), calls };
    },
    async model() {
      if (!real) return "claude-sonnet-5";
      const found = discovered ?? (await discover());
      const pick = lightestModel(found);
      if (!pick) throw new Error("No selectable Claude model was found on this computer.");
      return pick.id;
    },
    argv: (r) => buildClaudeArgs(r),
    modelMatches: claudeModelMatches,
  };
}

export function codexAdapter(real: boolean): CertAdapter {
  const workdir = tempDir("tl-cert-codex-");
  const codexHome = join(tempDir("tl-cert-codexhome-"), "codex-home");
  mkdirSync(codexHome, { recursive: true });
  let discovered: ProviderDiscovery | null = null;
  const executable = join(workdir, "..", "codex.exe"); // never executed in fake mode
  const discover = async (auth: "subscription" | "apikey" | "none" = "subscription") => {
    const d = await discoverCodex(
      real
        ? {}
        : {
            codexExecutable: executable,
            codexHome,
            spawnFn: recordingSpawn(FAKE_CODEX, []),
            env: {
              ...process.env,
              FAKE_CODEX_AUTH: auth === "subscription" ? "chatgpt" : auth,
            },
          },
    );
    if (auth === "subscription") discovered = d;
    return d;
  };
  return {
    id: "codex",
    real,
    workdir,
    discover,
    runner(behaviour = "ok", extraEnv = {}) {
      const calls: SpawnCall[] = [];
      const runner = new CodexTeamRunner(
        real
          ? {
              executable: discovered?.executable ?? undefined,
              spawnFn: recordingSpawn(null, calls),
              env: { ...process.env, ...LEAKY_ENV, ...extraEnv },
            }
          : {
              executable,
              spawnFn: recordingSpawn(FAKE_CODEX, calls),
              env: {
                ...process.env,
                ...LEAKY_ENV,
                CODEX_HOME: codexHome,
                FAKE_CODEX_MODE: behaviour,
                ...extraEnv,
              },
              rolloutWaitMs: 500,
            },
      );
      return { run: (r) => runner.run(r), calls };
    },
    async model() {
      if (!real) return "gpt-6-luna";
      const found = discovered ?? (await discover());
      const pick = lightestModel(found);
      if (!pick) throw new Error("No selectable Codex model was found on this computer.");
      return pick.id;
    },
    argv: (r) => buildCodexArgs(r),
    modelMatches: (a, b) => a === b,
  };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export type CheckContext = {
  adapter: CertAdapter;
  request(overrides?: Partial<AgentRunRequest>): Promise<AgentRunRequest>;
};

export type Check = {
  id: string;
  title: string;
  /** Can be run against the real CLI without cost beyond one small run, or harm. */
  real: boolean;
  run(ctx: CheckContext): Promise<void>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" } },
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pids: number[], ms = 8_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !isAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.every((p) => !isAlive(p));
}

export const CHECKS: Check[] = [
  {
    id: "install_discovery",
    title: "Install discovery",
    real: true,
    async run({ adapter }) {
      const d = await adapter.discover();
      assert(d.installed, `${adapter.id} was not discovered as installed.`);
      assert(d.version, `${adapter.id} reported no version.`);
    },
  },
  {
    id: "subscription_auth",
    title: "Subscription sign-in accepted",
    real: true,
    async run({ adapter }) {
      const d = await adapter.discover();
      assert(usableForTeam(d), `${adapter.id} is not signed in with a subscription.`);
      const caps = capabilitiesOf(adapter.id);
      assert(
        caps && d.authMethod && caps.subscriptionAuth.includes(d.authMethod),
        "auth method not in the registry",
      );
    },
  },
  {
    id: "api_key_detection",
    title: "API-key sign-in refused",
    real: false,
    async run({ adapter }) {
      const d = await adapter.discover("apikey");
      assert(d.authMethod === "api_key", `API-key sign-in not detected (got ${d.authMethod}).`);
      assert(!usableForTeam(d), "An API-key sign-in was accepted for Team work.");
      const none = await adapter.discover("none");
      assert(!usableForTeam(none), "A signed-out provider was accepted.");
    },
  },
  {
    id: "model_selection",
    title: "Model selection and observed-model verification",
    real: true,
    async run({ adapter, request }) {
      const req = await request();
      const r = await adapter.runner().run(req);
      assert(r.ok, `run failed: ${r.error}`);
      assert(
        r.observedModel && adapter.modelMatches(req.model, r.observedModel),
        "observed model not verified",
      );
      assert(adapter.argv(req).includes(req.model), "the model was not passed explicitly");
      assert(r.modelVerified === true, "the runner did not mark the model verified");
    },
  },
  {
    id: "model_mismatch",
    title: "A different model is refused",
    real: false,
    async run({ adapter, request }) {
      const r = await adapter.runner("wrong_model").run(await request());
      assert(!r.ok && r.failure === "model_mismatch", `expected model_mismatch, got ${r.failure}`);
      assert(r.modelVerified !== true, "a mismatched model was marked verified");
    },
  },
  {
    id: "read_only",
    title: "Read-only enforcement",
    real: true,
    async run({ adapter, request }) {
      const req = await request({ role: "reviewer", access: "read-only" });
      const args = adapter.argv(req);
      const caps = capabilitiesOf(adapter.id)!;
      if (adapter.id === "claude-code") {
        assert(
          args.join(" ").includes("--permission-mode plan"),
          "no plan mode on a read-only run",
        );
      } else {
        assert(args.includes("read-only"), "no read-only sandbox on a read-only run");
      }
      const r = await adapter.runner().run(req);
      assert(r.ok, `run failed: ${r.error}`);
      if (caps.accessVerification === "provider_reported") {
        assert(r.accessVerified, "the provider did not confirm the read-only sandbox");
      }
      if (!adapter.real && adapter.id === "codex") {
        const bad = await adapter.runner("wrong_sandbox").run(req);
        assert(!bad.ok && bad.failure === "access_mismatch", "a wrong sandbox was not detected");
      }
      // A read-only review role can never ask for write access.
      const refused = await adapter.runner().run({ ...req, access: "workspace-write" });
      assert(
        !refused.ok && refused.failure === "access_mismatch",
        "a reviewer was allowed to write",
      );
    },
  },
  {
    id: "workspace_write",
    title: "Workspace-write enforcement",
    real: false,
    async run({ adapter, request }) {
      const req = await request({ role: "builder", access: "workspace-write" });
      const args = adapter.argv(req).join(" ");
      if (adapter.id === "claude-code") {
        assert(args.includes("--permission-mode acceptEdits"), "no acceptEdits on a write run");
      } else assert(args.includes("-s workspace-write"), "no workspace-write sandbox");
      const r = await adapter.runner().run(req);
      assert(r.ok, `run failed: ${r.error}`);
    },
  },
  {
    id: "cancellation",
    title: "Cancellation kills only the run's own process tree",
    real: false,
    async run({ adapter, request }) {
      const pidFile = join(adapter.workdir, `pids-${Date.now()}.txt`);
      const controller = new AbortController();
      const started: number[] = [];
      const pending = adapter.runner("hang", { FAKE_PID_FILE: pidFile }).run(
        await request({
          signal: controller.signal,
          onProcess: { started: (c) => started.push(c.pid!), exited: () => undefined },
        }),
      );
      const deadline = Date.now() + 8_000;
      while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      const r = await pending;
      assert(!r.ok && r.failure === "cancelled", `expected cancelled, got ${r.failure}`);
      assert(started.length === 1, "the process registry did not see the run's process");
      const pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
      assert(await waitDead(pids), "the run's process tree survived cancellation");
    },
  },
  {
    id: "timeout",
    title: "Timeout",
    real: false,
    async run({ adapter, request }) {
      const r = await adapter.runner("hang").run(await request({ timeoutMs: 1_500 }));
      assert(!r.ok && r.failure === "timeout", `expected timeout, got ${r.failure}`);
    },
  },
  {
    id: "structured_output",
    title: "Structured output",
    real: true,
    async run({ adapter, request }) {
      const req = await request({
        outputSchema: SMALL_SCHEMA,
        prompt: 'Reply with the JSON object {"verdict":"PASS"} and nothing else.',
      });
      const r = await adapter.runner("structured").run(req);
      assert(r.ok, `run failed: ${r.error}`);
      assert(
        r.structured && typeof (r.structured as { verdict?: unknown }).verdict === "string",
        "no structured answer",
      );
      if (!adapter.real) {
        const bad = await adapter.runner("structured_bad").run(req);
        assert(!bad.ok, "prose was accepted as a structured answer");
      }
    },
  },
  {
    id: "native_session_id",
    title: "Native session id",
    real: true,
    async run({ adapter, request }) {
      const caps = capabilitiesOf(adapter.id)!;
      const r = await adapter.runner().run(await request());
      assert(r.ok, `run failed: ${r.error}`);
      if (caps.nativeSession.exposed) {
        assert(r.threadId && UUIDISH.test(r.threadId), "no native session id");
      }
    },
  },
  {
    id: "resume",
    title: "Resume the same native session",
    real: true,
    async run({ adapter, request }) {
      const caps = capabilitiesOf(adapter.id)!;
      if (!caps.nativeSession.resume) return;
      const first = await adapter.runner().run(await request());
      assert(first.ok && first.threadId, `first run failed: ${first.error}`);
      const again = await adapter.runner().run(await request({ resumeThreadId: first.threadId! }));
      assert(again.ok, `resume failed: ${again.error}`);
      assert(again.threadId === first.threadId, "resume answered from another session");
    },
  },
  {
    id: "wrong_session",
    title: "Wrong-session detection",
    real: false,
    async run({ adapter, request }) {
      const id = "11111111-2222-4333-8444-555555555555";
      const r =
        adapter.id === "claude-code"
          ? await adapter.runner("wrong_session").run(await request({ resumeThreadId: id }))
          : await adapter.runner().run(await request({ resumeThreadId: id }));
      assert(!r.ok, "an answer from a different or unknown session was accepted");
    },
  },
  {
    id: "secret_stripping",
    title: "Secrets stripped from the agent environment",
    real: false,
    async run({ adapter, request }) {
      const runner = adapter.runner();
      const r = await runner.run(await request());
      assert(r.ok, `run failed: ${r.error}`);
      assert(/env=\[\]/.test(r.text), `secrets reached the agent: ${r.text.slice(0, 200)}`);
      for (const call of runner.calls) {
        const env = (call.options.env ?? {}) as Record<string, string | undefined>;
        for (const key of Object.keys(LEAKY_ENV))
          assert(env[key] === undefined, `${key} was passed`);
      }
    },
  },
  {
    id: "quota",
    title: "Quota exhaustion",
    real: false,
    async run({ adapter, request }) {
      const r = await adapter.runner("quota").run(await request());
      assert(
        !r.ok && r.failure === "quota_exhausted",
        `expected quota_exhausted, got ${r.failure}`,
      );
      // An error answer is never evidence of the model that ran.
      assert(r.modelVerified !== true, "an error answer was marked model-verified");
    },
  },
  {
    id: "not_authenticated",
    title: "Sign-in failure",
    real: false,
    async run({ adapter, request }) {
      const r = await adapter.runner("unauth").run(await request());
      assert(
        !r.ok && r.failure === "not_authenticated",
        `expected not_authenticated, got ${r.failure}`,
      );
    },
  },
  {
    id: "crash",
    title: "Crash is a provider error, never a result",
    real: false,
    async run({ adapter, request }) {
      const mode = adapter.id === "claude-code" ? "garbage" : "exit_nonzero";
      const r = await adapter.runner(mode).run(await request());
      assert(!r.ok && r.failure === "provider_error", `expected provider_error, got ${r.failure}`);
    },
  },
  {
    id: "concurrency",
    title: "Concurrent runs",
    real: false,
    async run({ adapter, request }) {
      const [a, b] = await Promise.all([
        adapter.runner().run(await request()),
        adapter.runner().run(await request()),
      ]);
      assert(a.ok && b.ok, `concurrent runs failed: ${a.error ?? ""} ${b.error ?? ""}`);
    },
  },
  {
    id: "terminal_safe_argv",
    title: "Terminal-safe argv",
    real: true,
    async run({ adapter, request }) {
      const req = await request();
      const args = adapter.argv(req);
      assert(forbiddenArg(args) === null, `forbidden flag ${forbiddenArg(args)}`);
      const runner = adapter.runner();
      const bad = await runner.run({ ...req, model: "--bare" });
      assert(!bad.ok && runner.calls.length === 0, "an unsafe model id reached argv");
      const ok = adapter.runner();
      const r = await ok.run(req);
      assert(r.ok, `run failed: ${r.error}`);
      for (const call of ok.calls) {
        assert(call.options.shell === false, "a run was started through a shell");
        assert(forbiddenArg(call.args) === null, "a forbidden flag reached the process");
      }
    },
  },
  {
    id: "worktree_isolation",
    title: "Runs in the requested worktree only",
    real: true,
    async run({ adapter, request }) {
      const req = await request();
      const runner = adapter.runner();
      const r = await runner.run(req);
      assert(r.ok, `run failed: ${r.error}`);
      assert(
        runner.calls.every((c) => String(c.options.cwd) === req.cwd),
        "a run was started outside its worktree",
      );
      if (!adapter.real && adapter.id === "codex") {
        const bad = await adapter.runner("wrong_cwd").run(req);
        assert(
          !bad.ok && bad.failure === "access_mismatch",
          "a run in another directory was accepted",
        );
      }
      const rel = await adapter.runner().run({ ...req, cwd: "relative/dir" });
      assert(!rel.ok, "a relative working directory was accepted");
    },
  },
];

/** Builds a request for this adapter: a small prompt in its workdir, with its model. */
export function contextFor(adapter: CertAdapter): CheckContext {
  return {
    adapter,
    async request(overrides = {}) {
      return {
        provider: adapter.id,
        role: "builder",
        cwd: adapter.workdir,
        prompt: "Reply with the single word OK.",
        model: await adapter.model(),
        access: "read-only",
        ...overrides,
      };
    },
  };
}

/** Runs every applicable check and returns the table (id → error or null). */
export async function certify(adapter: CertAdapter): Promise<Record<string, string | null>> {
  const table: Record<string, string | null> = {};
  const ctx = contextFor(adapter);
  for (const check of CHECKS) {
    if (adapter.real && !check.real) continue;
    try {
      await check.run(ctx);
      table[check.id] = null;
    } catch (error) {
      table[check.id] = (error as Error).message;
    }
  }
  return table;
}
