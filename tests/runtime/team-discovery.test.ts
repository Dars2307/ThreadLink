import { spawn, type SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KNOWN_CLAUDE_MODELS,
  discoverClaude,
  discoverCodex,
  discoverProviders,
  findCodexExecutable,
  findOnPath,
  readCodexConfiguredModel,
  readCodexModelCatalog,
  type ProviderDiscovery,
} from "../../runtime/src/team/discovery.ts";
import type { SpawnFn } from "../../runtime/src/team/runner.ts";

const FAKE_CLAUDE = join(__dirname, "fake-claude-team.mjs");
const FAKE_CODEX = join(__dirname, "fake-codex.mjs");
const IDENTITY_SECRET = "IDENTITY_SECRET_acct_9x8y7z";
const exe = process.platform === "win32" ? ".exe" : "";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tl-team-discovery-")));

function fakeSpawn(script: string): SpawnFn {
  return ((_command: string, args: string[], options: SpawnOptions) =>
    spawn(process.execPath, [script, ...args], options)) as unknown as SpawnFn;
}

function codexHomeFixture(): string {
  const home = mkdtempSync(join(root, "codex-home-"));
  const model = (slug: string, visibility: string, priority: number, extra: object = {}) => ({
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} description`,
    visibility,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "fast" },
      { effort: "medium", description: "default" },
      { effort: "high", description: "deep" },
    ],
    priority,
    // Unrelated catalog payload that must not be copied through.
    model_messages: { instructions: "ignore me" },
    ...extra,
  });
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-09-25T00:00:00Z",
      etag: "W/1",
      client_version: "0.155.0",
      identity: { email: `${IDENTITY_SECRET}@example.com`, account_id: IDENTITY_SECRET },
      models: [
        model("gpt-6-luna", "list", 3),
        model("gpt-6-sol", "list", 1),
        model("gpt-reserve", "hide", 2),
        model("codex-auto-review", "hide", 9),
        model("gpt-6-astra", "list", 2, { identity: IDENTITY_SECRET }),
        model("--evil", "list", 5),
      ],
    }),
  );
  writeFileSync(
    join(home, "config.toml"),
    [
      "# comment",
      'model = "gpt-5.6-terra"',
      'model_reasoning_effort = "medium"',
      'sandbox_mode = "danger-full-access"',
      "",
      "[profiles.other]",
      'model = "gpt-should-not-be-read"',
    ].join("\n"),
  );
  return home;
}

function expectNoLeak(result: ProviderDiscovery | ProviderDiscovery[]) {
  const text = JSON.stringify(result);
  for (const secret of [
    IDENTITY_SECRET,
    "secret.person@example.com",
    "org-SECRET-0000",
    "Secret Org Name",
    "ignore me",
  ]) {
    expect(text).not.toContain(secret);
  }
}

const CAPABILITY_KEYS = [
  "supportsBackgroundWorker",
  "supportsExactResume",
  "supportsOpenConversation",
  "supportsFork",
  "supportsModelSelection",
  "supportsUsageStatus",
  "supportsParallelWorker",
  "supportsReadOnlyReview",
].sort();

describe("Codex model catalog and config", () => {
  it("lists only visible models, in priority order, without identity", () => {
    const home = codexHomeFixture();
    const models = readCodexModelCatalog(home);
    expect(models.map((m) => m.id)).toEqual(["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]);
    expect(models[0]).toEqual({
      id: "gpt-6-sol",
      displayName: "GPT-6-SOL",
      description: "gpt-6-sol description",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      source: "catalog",
    });
    expect(JSON.stringify(models)).not.toContain(IDENTITY_SECRET);
  });

  it("reads only the top-level model key of config.toml", () => {
    expect(readCodexConfiguredModel(codexHomeFixture())).toBe("gpt-5.6-terra");
    const home = mkdtempSync(join(root, "cfg-"));
    writeFileSync(join(home, "config.toml"), '[profiles.x]\nmodel = "nested"\n');
    expect(readCodexConfiguredModel(home)).toBeNull();
    expect(readCodexConfiguredModel(join(root, "missing"))).toBeNull();
  });

  it("returns nothing for a missing or corrupt catalog", () => {
    expect(readCodexModelCatalog(join(root, "missing"))).toEqual([]);
    const home = mkdtempSync(join(root, "bad-"));
    writeFileSync(join(home, "models_cache.json"), "{not json");
    expect(readCodexModelCatalog(home)).toEqual([]);
  });
});

describe("Codex executable lookup", () => {
  it("prefers an explicit override and refuses a bad one without falling back", () => {
    const dir = mkdtempSync(join(root, "override-"));
    const file = join(dir, `codex${exe}`);
    writeFileSync(file, "");
    expect(findCodexExecutable({ env: { THREADLINK_CODEX_PATH: file, PATH: "" } })).toMatchObject({
      path: file,
      source: "override",
    });
    const bad = findCodexExecutable({
      env: { THREADLINK_CODEX_PATH: join(dir, "nope.exe"), PATH: dir },
    });
    expect(bad.path).toBeNull();
    expect(bad.detail).toContain("THREADLINK_CODEX_PATH");
  });

  it("uses PATH, then the newest bundled Codex app binary", () => {
    const pathDir = mkdtempSync(join(root, "path-"));
    writeFileSync(join(pathDir, `codex${exe}`), "");
    expect(findCodexExecutable({ env: { PATH: pathDir } })).toMatchObject({ source: "path" });
    expect(findOnPath("codex", { PATH: pathDir })).toBe(join(pathDir, `codex${exe}`));

    const local = mkdtempSync(join(root, "localappdata-"));
    const bin = join(local, "OpenAI", "Codex", "bin");
    mkdirSync(join(bin, "aaaa"), { recursive: true }); // only other tools
    writeFileSync(join(bin, "aaaa", "rg.exe"), "");
    mkdirSync(join(bin, "old1"), { recursive: true });
    mkdirSync(join(bin, "new2"), { recursive: true });
    mkdirSync(join(bin, "empty"), { recursive: true });
    writeFileSync(join(bin, "old1", "codex.exe"), "");
    writeFileSync(join(bin, "new2", "codex.exe"), "");
    utimesSync(join(bin, "old1", "codex.exe"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    utimesSync(join(bin, "new2", "codex.exe"), new Date(2026, 1, 1), new Date(2026, 1, 1));
    expect(findCodexExecutable({ env: { PATH: "", LOCALAPPDATA: local } })).toEqual({
      path: join(bin, "new2", "codex.exe"),
      source: "codex-app",
    });
    expect(findCodexExecutable({ env: { PATH: "" } }).path).toBeNull();
  });
});

describe("Codex discovery", { timeout: 30_000 }, () => {
  const discover = (auth: string, home = codexHomeFixture()) =>
    discoverCodex({
      codexExecutable: join(root, "codex.exe"),
      codexHome: home,
      spawnFn: fakeSpawn(FAKE_CODEX),
      env: { ...process.env, FAKE_CODEX_AUTH: auth },
    });

  it("reports install, ChatGPT login, catalog models and honest capabilities", async () => {
    const d = await discover("chatgpt");
    expect(d).toMatchObject({
      provider: "codex",
      installed: true,
      version: "0.155.0-alpha.16.4",
      authenticated: true,
      authMethod: "chatgpt",
      detectedPlan: null,
      currentModel: "gpt-5.6-terra",
      usage: { remaining: "unknown" },
    });
    expect(d.models.map((m) => m.id)).toEqual(["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]);
    expect(Object.keys(d.capabilities).sort()).toEqual(CAPABILITY_KEYS);
    expect(d.capabilities).toMatchObject({
      supportsReadOnlyReview: true,
      supportsUsageStatus: false,
      supportsFork: false,
    });
    expectNoLeak(d);
  });

  it("flags API-key login and reports logged-out", async () => {
    const api = await discover("apikey");
    expect(api).toMatchObject({ authenticated: true, authMethod: "api_key" });
    expect(api.detail).toMatch(/API key/);
    expect(JSON.stringify(api)).not.toContain("sk-");
    const none = await discover("none");
    expect(none).toMatchObject({ installed: true, authenticated: false, authMethod: null });
    expect(none.detail).toMatch(/not logged in/i);
  });

  it("never throws: missing binary, hanging binary, throwing spawn", async () => {
    const missing = await discoverCodex({
      codexExecutable: join(root, "no-such-codex.exe"),
      codexHome: codexHomeFixture(),
    });
    expect(missing).toMatchObject({ installed: false, authenticated: false, models: [] });

    const hanging = ((_c: string, _a: string[], options: SpawnOptions) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 60000)"],
        options,
      )) as unknown as SpawnFn;
    const slow = await discoverCodex({
      codexExecutable: join(root, "codex.exe"),
      spawnFn: hanging,
      timeoutMs: 500,
    });
    expect(slow).toMatchObject({ installed: false });
    expect(slow.detail).toMatch(/timed out/);

    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as SpawnFn;
    const all = await discoverProviders({
      codexExecutable: join(root, "codex.exe"),
      claudeCommand: "claude",
      spawnFn: throwing,
    });
    expect(all.map((p) => p.installed)).toEqual([false, false]);
    for (const p of all) expect(p.usage).toEqual({ remaining: "unknown" });
  });
});

describe("Claude discovery", { timeout: 30_000 }, () => {
  const discover = (auth: string, extra: object = {}) =>
    discoverClaude({
      claudeCommand: "claude",
      spawnFn: fakeSpawn(FAKE_CLAUDE),
      env: { ...process.env, FAKE_CT_AUTH: auth },
      ...extra,
    });

  it("keeps loggedIn, authMethod and plan; drops email and organisation", async () => {
    const d = await discover("max");
    expect(d).toMatchObject({
      provider: "claude-code",
      installed: true,
      version: "2.1.266",
      authenticated: true,
      authMethod: "claude.ai",
      detectedPlan: "max",
      currentModel: null,
      usage: { remaining: "unknown" },
    });
    expect(Object.keys(d.capabilities).sort()).toEqual(CAPABILITY_KEYS);
    expect(d.capabilities).toMatchObject({
      supportsReadOnlyReview: true,
      supportsUsageStatus: false,
    });
    expectNoLeak(d);
    expect(Object.keys(d)).not.toContain("email");
  });

  it("lists configured ids and marks observed ones", async () => {
    const d = await discover("max", {
      claudeConfiguredModels: ["claude-custom-1", "--bad"],
      claudeObservedModels: ["claude-sonnet-5", "claude-observed-9"],
    });
    const byId = Object.fromEntries(d.models.map((m) => [m.id, m.source]));
    for (const m of KNOWN_CLAUDE_MODELS) expect(byId).toHaveProperty(m.id);
    expect(byId["claude-sonnet-5"]).toBe("observed");
    expect(byId["claude-haiku-4-5-20251001"]).toBe("configured");
    expect(byId["claude-custom-1"]).toBe("configured");
    expect(byId["claude-observed-9"]).toBe("observed");
    expect(byId).not.toHaveProperty("--bad");
  });

  it("reports logged-out without a plan", async () => {
    const d = await discover("none");
    expect(d).toMatchObject({ installed: true, authenticated: false, detectedPlan: null });
    expectNoLeak(d);
  });

  it("reports not installed when claude is not on PATH", async () => {
    const d = await discoverClaude({ env: { PATH: mkdtempSync(join(root, "empty-path-")) } });
    expect(d).toMatchObject({ installed: false, executable: null, authenticated: false });
  });
});
