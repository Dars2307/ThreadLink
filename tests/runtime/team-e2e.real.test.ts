import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverProviders } from "../../runtime/src/team/discovery.ts";
import { TeamExecutor, teamReport } from "../../runtime/src/team/executor.ts";
import { parseTeamJob } from "../../runtime/src/team/job.ts";
import type { TeamOp } from "../../runtime/src/team/orchestrator.ts";
import { UsageGovernor } from "../../runtime/src/team/usage.ts";

/**
 * Team Mode with the real agents. Skipped unless THREADLINK_REAL_AGENTS=1,
 * because it runs Claude Code and Codex for real on the owner's subscription.
 *
 * It is the acceptance path in miniature: a two-unit job where Claude Code and
 * Codex plan together, each builds one unit in its own worktree at the same
 * time, each reviews the other's, ThreadLink integrates and runs the tests
 * itself, and the provider that did not integrate inspects the result.
 *
 * Every step is pinned to the lightest models ("never use anything heavier")
 * so the run proves the pipeline, not model quality, and costs little.
 */

const REAL = process.env.THREADLINK_REAL_AGENTS === "1";
const suite = REAL ? describe : describe.skip;

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

const JOB = {
  kind: "threadlink.team_job",
  version: 1,
  jobId: `tljob_${"e".repeat(32)}`,
  roomId: `tlrom_${"e".repeat(32)}`,
  roomName: "Arithmetic",
  goal:
    "Add two small modules to this Node project: math.js exporting add(a, b), and mul.js " +
    "exporting mul(a, b). Keep them to plain CommonJS with module.exports. Nothing else.",
  spec: {
    requirements: ["math.js exports add(a, b)", "mul.js exports mul(a, b)"],
    doNotChange: ["test.js", "package.json"],
    testsRequired: ["node test.js passes"],
  },
  budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 2 },
  policy: {
    usagePolicy: "manual",
    paidUsage: false,
    crossReview: true,
    finalInspection: true,
    worktreeIsolation: true,
    // "Always use the lightest model": pins every role to FAST models.
    overrides: [
      {
        match: { provider: "claude-code" },
        use: "claude-haiku-4-5-20251001",
        label: "lightest Claude",
      },
      { match: { provider: "codex" }, use: "gpt-6-luna", label: "lightest Codex" },
    ],
  },
  agents: [
    { provider: "claude-code", displayName: "Claude", roles: ["planner", "builder", "integrator"] },
    { provider: "codex", displayName: "Codex", roles: ["builder", "reviewer"] },
  ],
  verifyCommands: ["node test.js"],
};

suite("Team Mode with the real agents", () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tl-team-real-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "owner@example.com");
    git("config", "user.name", "Owner");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "package.json"), '{ "name": "arith", "private": true }\n');
    writeFileSync(
      join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const { add } = require('./math.js');",
        "const { mul } = require('./mul.js');",
        "assert.strictEqual(add(2, 3), 5);",
        "assert.strictEqual(mul(4, 5), 20);",
        "console.log('arith tests passed');",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repo, "AGENTS.md"), "Plain CommonJS. No dependencies.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it(
    "plans, builds in parallel, cross-reviews, integrates, tests and inspects",
    async () => {
      const found = await discoverProviders();
      for (const p of found) {
        expect(p.installed, `${p.provider} installed`).toBe(true);
        expect(p.authenticated, `${p.provider} signed in`).toBe(true);
      }

      const ops: { op: TeamOp; payload: Record<string, unknown> }[] = [];
      let findings = 0;
      const executor = new TeamExecutor({
        workspace: repo,
        sessionId: "tlses_real",
        claimRef: "real",
        governor: new UsageGovernor(),
        discover: async () => found,
        write: async (_job, _session, _claim, op, payload) => {
          ops.push({ op, payload });
          return op === "add_finding"
            ? { findingId: `tlfnd_${String(++findings).padStart(32, "0")}` }
            : {};
        },
        log: (m) => console.log(`[team] ${m}`),
        onProgress: (p) => console.log(`[team] ${p.status}: ${p.line}`),
      });

      const result = await executor.execute(
        {
          taskId: "tltask_real",
          title: "Arithmetic",
          content: JSON.stringify(JOB),
          priority: "C",
          taskType: "team",
        },
        new AbortController().signal,
      );

      const report =
        (result as { result?: string }).result ?? (result as { error?: string }).error ?? "";
      console.log("\n===== REPORT =====\n" + report + "\n==================\n");
      const usage = ops.filter((o) => o.op === "record_usage").map((o) => o.payload);
      console.log(
        "Models used:\n" +
          usage
            .map(
              (u) =>
                `  ${u.provider} ${u.role}: requested ${u.requestedModel}, observed ${u.observedModel} (${u.outcome})`,
            )
            .join("\n"),
      );
      // The review conversation, so a failed run explains itself.
      console.log(
        "Team log:\n" +
          ops
            .filter((o) => ["add_message", "add_finding", "add_decision"].includes(o.op))
            .map((o) => {
              const p = o.payload as Record<string, unknown>;
              if (o.op === "add_finding")
                return `  FINDING [${p.severity}] (${p.raisedBy} on ${p.node}): ${p.summary} — ${String(p.detail).slice(0, 300)}`;
              if (o.op === "add_decision")
                return `  DECISION ${p.topic}: ${String(p.resolution).slice(0, 200)}`;
              return `  ${p.sender} -> ${p.receiver} (${p.type}): ${String(p.body).slice(0, 300)}`;
            })
            .join("\n"),
      );
      const final = ops.find((o) => o.op === "set_final")?.payload as
        { verdict: string } | undefined;

      expect(result.ok).toBe(true);
      // Every model that ran was the one ThreadLink chose.
      for (const u of usage)
        expect(u.observedModel, `${u.provider} ${u.role}`).toBe(u.requestedModel);
      // Nobody reviewed their own work.
      const nodes = ops.find((o) => o.op === "upsert_nodes")?.payload.nodes as
        { owner: string; reviewer: string }[] | undefined;
      for (const n of nodes ?? []) expect(n.reviewer).not.toBe(n.owner);

      expect(final?.verdict, report).toBe("PASS");
      const job = parseTeamJob(JSON.stringify(JOB));
      const branch = /Result branch: (\S+)/.exec(report)?.[1];
      expect(branch).toBeTruthy();
      // The integrated result really works: run the tests on that branch ourselves.
      git("checkout", "-q", branch!);
      expect(execFileSync("node", ["test.js"], { cwd: repo, encoding: "utf8" })).toContain(
        "arith tests passed",
      );
      git("checkout", "-q", "main");
      // And the owner's own branch was left exactly as it was.
      expect(readFileSync(join(repo, "test.js"), "utf8")).toContain("arith tests passed");
      expect(job.roomName).toBe("Arithmetic");
      void teamReport;
    },
    45 * 60_000,
  );
});
