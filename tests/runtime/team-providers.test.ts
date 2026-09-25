import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadLinkApi, parseProviderProfiles } from "../../runtime/src/api.ts";
import type { ProviderDiscovery } from "../../runtime/src/team/discovery.ts";
import {
  PROVIDER_ADAPTERS,
  createRunners,
  detectCursor,
  providerCapabilities,
} from "../../runtime/src/team/providers.ts";
import { ownerNotesSection, withOwnerNotes } from "../../runtime/src/team/prompts.ts";
import { modelObserved, parseOwnerNotes, stopRequested } from "../../runtime/src/team/wire.ts";

/**
 * The provider adapter registry (including Cursor, detect-only), the wire
 * format the Runtime reads back from team_job_write, and the plan endpoint.
 */

const discovered = (over: Partial<ProviderDiscovery>): ProviderDiscovery => ({
  provider: "claude-code",
  installed: true,
  executable: "/bin/claude",
  version: "2.1.266",
  authenticated: true,
  authMethod: "claude.ai",
  detectedPlan: "max",
  models: [],
  currentModel: null,
  capabilities: {} as never,
  usage: { remaining: "unknown" },
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-prov-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("provider capabilities", () => {
  it("lists Claude Code, Codex and Cursor, with Codex conversation discovery unsupported", () => {
    const caps = providerCapabilities(
      [
        discovered({}),
        discovered({ provider: "codex", authMethod: "chatgpt", executable: "/bin/codex" }),
      ],
      { found: false, command: null },
    );
    expect(caps.map((c) => c.id)).toEqual(["claude-code", "codex", "cursor"]);
    expect(caps.find((c) => c.id === "claude-code")).toMatchObject({
      status: "available",
      routable: true,
      headless: true,
      conversationDiscovery: "supported",
    });
    expect(caps.find((c) => c.id === "codex")).toMatchObject({
      status: "available",
      routable: true,
      conversationDiscovery: "unsupported",
    });
  });

  it("says why a provider cannot be used", () => {
    const caps = providerCapabilities(
      [
        discovered({
          installed: false,
          authenticated: false,
          authMethod: null,
          detail: "not found",
        }),
        discovered({ provider: "codex", authMethod: "api_key", executable: "/bin/codex" }),
      ],
      { found: false, command: null },
    );
    expect(caps[0]).toMatchObject({ status: "not_installed", routable: false });
    // An API-key sign-in would bill per token: not usable, and it says so.
    expect(caps[1]).toMatchObject({ status: "signed_out", routable: false });
    expect(caps[1]!.note).toMatch(/API key/);
  });

  it("reports Cursor as not supported yet, found or not, and never routable", () => {
    for (const cursor of [
      { found: true, command: "cursor-agent" as const },
      { found: false, command: null },
    ]) {
      const c = providerCapabilities([], cursor).find((x) => x.id === "cursor")!;
      expect(c.status).toBe("not_supported_yet");
      expect(c.routable).toBe(false);
      expect(c.note).toMatch(
        cursor.found ? /appears to be installed/ : /does not support Cursor yet/,
      );
    }
  });

  it("has no runner for Cursor, and makes runners only for subscription sign-ins", () => {
    expect(PROVIDER_ADAPTERS.find((a) => a.id === "cursor")!.createRunner).toBeUndefined();
    const runners = createRunners([
      discovered({}),
      discovered({ provider: "codex", authMethod: "api_key", executable: "/bin/codex" }),
    ]);
    expect(Object.keys(runners)).toEqual(["claude-code"]);
    expect(runners["claude-code"]!.provider).toBe("claude-code");
  });

  it("finds a Cursor CLI on PATH without running it", () => {
    const name = process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
    // A file that would fail loudly if it were ever executed.
    writeFileSync(join(dir, name), "exit 99\n");
    expect(detectCursor({ PATH: dir })).toEqual({ found: true, command: "cursor-agent" });
    expect(detectCursor({ PATH: ["", join(dir, "missing")].join(delimiter) })).toEqual({
      found: false,
      command: null,
    });
  });
});

describe("what the Runtime reads back from team_job_write", () => {
  it("parses owner notes and drops anything malformed", () => {
    const notes = parseOwnerNotes({
      ownerNotes: [
        { id: "tlcev_1", seq: 3, audience: "codex", body: "hi", createdAt: "2026-09-25T10:00:00Z" },
        { id: "tlcev_2", audience: null, body: "all", createdAt: 5 },
        { id: "tlcev_3", audience: "cursor", body: "x" },
        { id: "bad id!", audience: "team", body: "x" },
        { id: "tlcev_4", audience: "team", body: "" },
        "nonsense",
      ],
    });
    expect(notes).toEqual([
      { id: "tlcev_1", audience: "codex", body: "hi", createdAt: "2026-09-25T10:00:00Z" },
      { id: "tlcev_2", audience: "team", body: "all", createdAt: null },
    ]);
    expect(parseOwnerNotes({})).toEqual([]);
    expect(parseOwnerNotes(null)).toEqual([]);
  });

  it("reads a stop request only from a timestamp", () => {
    expect(stopRequested({ stopRequestedAt: "2026-09-25T10:00:00Z" })).toBe(true);
    expect(stopRequested({ stopRequestedAt: null })).toBe(false);
    expect(stopRequested({ stopRequestedAt: true })).toBe(false);
    expect(stopRequested({})).toBe(false);
  });

  it("reports a model name only when it matches what the server accepts", () => {
    expect(modelObserved("claude-opus-5-5[1m]")).toBe("claude-opus-5-5[1m]");
    expect(modelObserved("gpt-6-sol")).toBe("gpt-6-sol");
    expect(modelObserved("bad model; x")).toBeUndefined();
    expect(modelObserved("x".repeat(101))).toBeUndefined();
    expect(modelObserved(null)).toBeUndefined();
  });
});

describe("owner notes in a prompt", () => {
  it("are redacted, fenced with a fresh nonce, and placed before the closing instruction", () => {
    const redact = (t: string) => t.replace(/sk-\w+/g, "[redacted]");
    const prompt = withOwnerNotes(
      "Intro.\n\nAnswer with JSON.",
      [{ body: "use sk-abc", createdAt: null }],
      redact,
    );
    expect(prompt).not.toContain("sk-abc");
    expect(prompt.endsWith("\n\nAnswer with JSON.")).toBe(true);
    const a = /BEGIN NOTE FROM THE PROJECT OWNER \[([0-9a-f]+)\]/.exec(
      ownerNotesSection([{ body: "x", createdAt: null }], redact),
    )![1];
    const b = /BEGIN NOTE FROM THE PROJECT OWNER \[([0-9a-f]+)\]/.exec(
      ownerNotesSection([{ body: "x", createdAt: null }], redact),
    )![1];
    expect(a).not.toBe(b);
  });

  it("leave a prompt unchanged when there are none", () => {
    expect(withOwnerNotes("A\n\nB", [], (t) => t)).toBe("A\n\nB");
  });
});

describe("the declared-plan endpoint", () => {
  const profile = (provider: string, declaredPlan: string) => ({
    provider,
    declaredPlan,
    usagePolicy: "balanced",
    paidUsageEnabled: false,
    detected: {},
    detectedAt: null,
  });

  it("PATCHes only provider and plan, then returns every profile", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body =
        init?.method === "PATCH"
          ? profile("codex", "business_premium")
          : { profiles: [profile("claude-code", "max_5x"), profile("codex", "business_premium")] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const api = new ThreadLinkApi({
      baseUrl: "https://threadlink.example",
      token: "tl_agent_x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { profiles } = await api.setDeclaredPlan("codex", "business_premium");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://threadlink.example/api/team/providers");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(String(init!.body))).toEqual({
      provider: "codex",
      declaredPlan: "business_premium",
    });
    expect(profiles.map((p) => `${p.provider}:${p.declaredPlan}`)).toEqual([
      "claude-code:max_5x",
      "codex:business_premium",
    ]);
  });

  it("drops malformed profiles instead of guessing", () => {
    expect(
      parseProviderProfiles({
        profiles: [
          profile("claude-code", "pro"),
          profile("cursor", "pro"),
          profile("codex", "Team Plan!"),
          profile("claude-code", "max_20x"),
        ],
      }).map((p) => p.declaredPlan),
    ).toEqual(["pro"]);
    expect(parseProviderProfiles("nope")).toEqual([]);
  });
});
