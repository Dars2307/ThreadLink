import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApiError, ThreadLinkApi } from "../../runtime/src/api.ts";
import {
  BUILD_CHANNEL,
  CANONICAL_BASE_URL,
  canonicalBaseUrl,
  canonicalizeBaseUrl,
  isGeneratedDeploymentHost,
} from "../../runtime/src/endpoints.ts";
import {
  loadConfig,
  migrateBaseUrl,
  saveConfig,
  saveWorkspaceState,
  loadWorkspaceState,
  workspaceKey,
} from "../../runtime/src/state.ts";

/**
 * Vercel gives every build its own hostname. Storing one pins this computer to
 * an old deployment forever, which is exactly how an installed app ends up
 * talking to a ThreadLink that predates half its API.
 */
const GENERATED = "https://threadlink-iz4qemadi-ash-murrays-projects.vercel.app";

describe("canonical ThreadLink addresses", () => {
  it("recognises a generated deployment hostname", () => {
    expect(isGeneratedDeploymentHost("threadlink-iz4qemadi-ash-murrays-projects.vercel.app")).toBe(
      true,
    );
    expect(isGeneratedDeploymentHost("threadlink-84fhkdayj-ash-murrays-projects.vercel.app")).toBe(
      true,
    );
    // Our own stable hostnames are not generated.
    expect(isGeneratedDeploymentHost("threadlink-mcp-preview.vercel.app")).toBe(false);
    expect(isGeneratedDeploymentHost("threadlink-one.vercel.app")).toBe(false);
    // Deliberate choices are left alone.
    expect(isGeneratedDeploymentHost("threadlink.example.com")).toBe(false);
    expect(isGeneratedDeploymentHost("localhost")).toBe(false);
  });

  it("upgrades a generated hostname to the channel's stable one", () => {
    const preview = canonicalizeBaseUrl(GENERATED, "preview");
    expect(preview).toEqual({
      url: CANONICAL_BASE_URL.preview,
      changed: true,
      previous: GENERATED,
    });
    expect(canonicalizeBaseUrl(GENERATED, "production").url).toBe(CANONICAL_BASE_URL.production);
  });

  it("leaves this channel's own address, custom domains and localhost untouched", () => {
    for (const url of [
      CANONICAL_BASE_URL.preview,
      "https://threadlink.example.com",
      "http://localhost:3200",
    ]) {
      expect(canonicalizeBaseUrl(url, "preview")).toEqual({
        url,
        changed: false,
        previous: null,
      });
    }
    expect(canonicalizeBaseUrl(CANONICAL_BASE_URL.production, "production")).toEqual({
      url: CANONICAL_BASE_URL.production,
      changed: false,
      previous: null,
    });
  });

  it("follows the build to the other channel's address", () => {
    // An installed Runtime pointed at Preview must move to Production when the
    // build it is running targets Production, or it keeps talking to a
    // deployment nobody is maintaining.
    expect(canonicalizeBaseUrl(CANONICAL_BASE_URL.preview, "production")).toEqual({
      url: CANONICAL_BASE_URL.production,
      changed: true,
      previous: CANONICAL_BASE_URL.preview,
    });
    expect(canonicalizeBaseUrl(CANONICAL_BASE_URL.production, "preview")).toEqual({
      url: CANONICAL_BASE_URL.preview,
      changed: true,
      previous: CANONICAL_BASE_URL.production,
    });
    // A custom domain is still a deliberate choice, whatever the channel.
    expect(canonicalizeBaseUrl("https://threadlink.example.com", "production").changed).toBe(false);
  });

  it("defaults to Production, the one canonical address", () => {
    expect(BUILD_CHANNEL).toBe("production");
    expect(canonicalBaseUrl()).toBe(CANONICAL_BASE_URL.production);
  });

  it("falls back to the stable address for nothing or nonsense", () => {
    expect(canonicalizeBaseUrl(null, "preview").url).toBe(CANONICAL_BASE_URL.preview);
    expect(canonicalizeBaseUrl("not a url", "preview")).toMatchObject({ changed: true });
  });
});

describe("migrating an installed Runtime to the stable address", () => {
  let dir: string;
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  it("rewrites the stored address and keeps Runtime, workspace and session identity", async () => {
    dir = await mkdtemp(join(tmpdir(), "tl-endpoints-"));
    await saveConfig(dir, {
      baseUrl: GENERATED,
      runtimeId: "tlrun_0123456789abcdef0123456789abcdef",
      label: "Joel's Laptop",
    });
    const workspace = join(dir, "project");
    await saveWorkspaceState(dir, {
      workspace,
      workspaceKey: workspaceKey(workspace),
      workspaceId: "tlwsp_0123456789abcdef0123456789abcdef",
      conversations: [
        {
          provider: "claude-code",
          mode: "resume",
          nativeSessionId: "00e80100-473a-4bc6-a74f-736e12681586",
          title: "Dashboard redesign",
          localBindingRef: "cc:00e80100-473a-4bc6-a74f-736e12681586",
          sessionId: "tlses_2665b254903b48ea80eda71c2bc65440",
          attachedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await migrateBaseUrl(dir, "preview");
    expect(result).toMatchObject({ url: CANONICAL_BASE_URL.preview, changed: true });

    const config = await loadConfig(dir);
    expect(config.baseUrl).toBe(CANONICAL_BASE_URL.preview);
    // Identity is what makes the move safe: none of it may be disturbed.
    expect(config.runtimeId).toBe("tlrun_0123456789abcdef0123456789abcdef");
    expect(config.label).toBe("Joel's Laptop");
    const state = await loadWorkspaceState(dir, workspace);
    expect(state?.workspaceId).toBe("tlwsp_0123456789abcdef0123456789abcdef");
    expect(state?.conversations[0]).toMatchObject({
      sessionId: "tlses_2665b254903b48ea80eda71c2bc65440",
      localBindingRef: "cc:00e80100-473a-4bc6-a74f-736e12681586",
    });
  });

  it("is a no-op that still writes nothing new for an already-correct address", async () => {
    dir = await mkdtemp(join(tmpdir(), "tl-endpoints-"));
    await saveConfig(dir, { baseUrl: CANONICAL_BASE_URL.preview, runtimeId: "tlrun_abc" });
    const before = await readFile(join(dir, "config.json"), "utf8");
    expect((await migrateBaseUrl(dir, "preview")).changed).toBe(false);
    expect(await readFile(join(dir, "config.json"), "utf8")).toBe(before);
  });
});

describe("an address that is not ThreadLink", () => {
  it("is reported as such instead of being read as an empty answer", async () => {
    // An old deployment answers an unknown API path with its not-found PAGE,
    // and Next.js serves that with 200. Treating it as JSON would hand the
    // engine an empty object and it would fail somewhere far away from here.
    const api = new ThreadLinkApi({
      baseUrl: "https://threadlink-iz4qemadi-ash-murrays-projects.vercel.app",
      token: "tlc_" + "a".repeat(43),
      fetchImpl: async () =>
        new Response("<!DOCTYPE html><html><body>Not found</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    await expect(api.whoami()).rejects.toMatchObject({
      name: "ApiError",
      kind: "not-threadlink",
    });
    await expect(api.whoami()).rejects.toBeInstanceOf(ApiError);
  });
});
