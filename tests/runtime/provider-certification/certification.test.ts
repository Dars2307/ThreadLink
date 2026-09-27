import { describe, expect, it } from "vitest";

import { PROVIDER_CAPABILITIES } from "../../../runtime/src/team/capabilities.ts";
import { PROVIDER_ADAPTERS } from "../../../runtime/src/team/providers.ts";
import { AGENT_PROVIDERS } from "../../../runtime/src/team/types.ts";
import {
  CHECKS,
  certify,
  claudeAdapter,
  codexAdapter,
  contextFor,
  type CertAdapter,
} from "./harness.ts";

/**
 * docs/design/threadlink-0.10.md §10: every adapter passes the whole table
 * against its fake CLI. With THREADLINK_REAL_AGENTS=1 the real-safe checks
 * also run against the real CLIs on this computer (small runs, subscription
 * usage); they are skipped otherwise and never run in CI.
 */

const REAL = process.env.THREADLINK_REAL_AGENTS === "1";

const ADAPTERS: Record<string, (real: boolean) => CertAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
};

describe("the certification table", () => {
  it("covers every supported provider, and every provider with a runner has capabilities", () => {
    for (const provider of AGENT_PROVIDERS) {
      expect(ADAPTERS[provider], provider).toBeTypeOf("function");
      expect(PROVIDER_CAPABILITIES[provider], provider).toBeDefined();
    }
    for (const adapter of PROVIDER_ADAPTERS) {
      if (adapter.createRunner) expect(PROVIDER_CAPABILITIES[adapter.id], adapter.id).toBeDefined();
    }
  });

  it("has every required check", () => {
    expect(CHECKS.map((c) => c.id).sort()).toEqual(
      [
        "api_key_detection",
        "cancellation",
        "concurrency",
        "crash",
        "install_discovery",
        "model_mismatch",
        "model_selection",
        "native_session_id",
        "not_authenticated",
        "quota",
        "read_only",
        "resume",
        "secret_stripping",
        "structured_output",
        "subscription_auth",
        "terminal_safe_argv",
        "timeout",
        "workspace_write",
        "worktree_isolation",
        "wrong_session",
      ].sort(),
    );
  });
});

for (const [provider, make] of Object.entries(ADAPTERS)) {
  describe(`${provider} against its fake CLI`, { timeout: 60_000 }, () => {
    const adapter = make(false);
    for (const check of CHECKS) {
      it(check.title, async () => {
        await check.run(contextFor(adapter));
      });
    }
  });

  describe.skipIf(!REAL)(`${provider} against the real CLI`, { timeout: 600_000 }, () => {
    it("passes every real-safe check", async () => {
      const table = await certify(make(true));
      const failed = Object.entries(table).filter(([, error]) => error !== null);
      expect(failed, JSON.stringify(table, null, 2)).toEqual([]);
    });
  });
}
