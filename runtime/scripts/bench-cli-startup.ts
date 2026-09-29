/**
 * ThreadLink 0.11 §3.6: how much of a Fast Chat turn is the provider CLI
 * itself? Measures, for each installed and signed-in provider, one after the
 * other (never in parallel -- this is meant to run on a busy laptop):
 *
 *   - `--version`: the bare process start-up cost of the CLI;
 *   - one real read-only Fast Chat turn with a trivial prompt, through the same
 *     runner, flags, stripped environment and subscription sign-in as a real
 *     turn: spawn, first output, total provider time, and whether the model
 *     was verified.
 *
 * Uses a little of the owner's included usage (one tiny turn per provider).
 * Never API keys (the runner strips them). Prints numbers only, no prompt text.
 *
 *   npx tsx runtime/scripts/bench-cli-startup.ts [--only claude-code|codex]
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { discoverProviders } from "../src/team/discovery.ts";
import { buildAgentEnv } from "../src/team/env.ts";
import { CHAT_SCHEMA } from "../src/team/fast-chat.ts";
import { lightestModel } from "../src/team/health.ts";
import { createRunners, usableForTeam } from "../src/team/providers.ts";

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

function timeVersion(command: string): Promise<{ ms: number; ok: boolean }> {
  const start = performance.now();
  return new Promise((done) => {
    const child = spawn(command, ["--version"], {
      env: buildAgentEnv(process.env).env as NodeJS.ProcessEnv,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      shell: false,
    });
    child.on("error", () => done({ ms: Math.round(performance.now() - start), ok: false }));
    child.on("close", (code) =>
      done({ ms: Math.round(performance.now() - start), ok: code === 0 }),
    );
  });
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const t0 = performance.now();
  const found = await discoverProviders();
  const discoveryMs = Math.round(performance.now() - t0);
  console.log(
    `discovery (every CLI, done once per Runtime, cached for Fast Chat): ${discoveryMs} ms`,
  );

  for (const p of found) {
    if (only && p.provider !== only) continue;
    if (!p.installed || !p.executable) {
      console.log(`${p.provider}: not installed`);
      continue;
    }
    const version = await timeVersion(p.executable);
    console.log(`${p.provider}: --version ${version.ms} ms${version.ok ? "" : " (failed)"}`);
    if (!usableForTeam(p)) {
      console.log(`${p.provider}: not signed in with a subscription; turn skipped`);
      continue;
    }
    const runner = createRunners([p])[p.provider];
    const model = lightestModel(p);
    if (!runner || !model) {
      console.log(`${p.provider}: no runner or model; turn skipped`);
      continue;
    }
    const wall = performance.now();
    const result = await runner.run({
      provider: p.provider,
      role: "investigator",
      cwd,
      prompt:
        'Benchmark turn. Do not read any files. Reply with message "ready", needsWork false, workReason empty.',
      model: model.id,
      access: "read-only",
      outputSchema: CHAT_SCHEMA,
      purpose: "chat",
      timeoutMs: 180_000,
    });
    const t = result.timings;
    console.log(
      `${p.provider} (${model.id}): turn ${result.ok ? "ok" : `failed (${result.failure})`}; ` +
        `spawn ${t?.spawnMs ?? "?"} ms, first output ${t?.firstEventMs ?? "?"} ms after spawn, ` +
        `provider total ${t?.providerMs ?? "?"} ms, wall ${Math.round(performance.now() - wall)} ms; ` +
        `model verified: ${result.modelVerified === true}` +
        (result.ok ? "" : `; error: ${(result.error ?? "").slice(0, 300)}`),
    );
  }
}

main().catch((error: unknown) => {
  console.error(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
