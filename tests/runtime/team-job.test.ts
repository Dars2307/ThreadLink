import { describe, expect, it } from "vitest";

import { parseTeamJob, TeamJobError } from "../../runtime/src/team/job.ts";

/**
 * A team job arrives as network input. Anything malformed fails the whole job,
 * because a guessed-at job is a job the owner did not ask for.
 */

const JOB = `tljob_${"a".repeat(32)}`;
const ROOM = `tlrom_${"b".repeat(32)}`;

const valid = () => ({
  kind: "threadlink.team_job",
  version: 1,
  jobId: JOB,
  roomId: ROOM,
  roomName: "Prism",
  goal: "Build the new Prism reporting workflow.",
  spec: { requirements: ["Reports export to PDF"], doNotChange: ["auth"] },
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
    { provider: "claude-code", displayName: "Prism Claude", roles: ["planner", "builder"] },
    { provider: "codex", displayName: "Prism Reviewer", roles: ["builder", "reviewer"] },
  ],
  verifyCommands: ["npm test"],
});

const parse = (over: Record<string, unknown>) =>
  parseTeamJob(JSON.stringify({ ...valid(), ...over }));

describe("a team job definition", () => {
  it("parses a well-formed job", () => {
    const job = parseTeamJob(JSON.stringify(valid()));
    expect(job).toMatchObject({
      jobId: JOB,
      roomName: "Prism",
      budgets: { maxReviewRounds: 3 },
      verifyCommands: ["npm test"],
    });
    expect(job.agents.map((a) => a.provider)).toEqual(["claude-code", "codex"]);
    expect(job.spec.requirements).toEqual(["Reports export to PDF"]);
  });

  it("refuses anything that is not a version 1 team job", () => {
    expect(() => parseTeamJob("not json")).toThrow(TeamJobError);
    expect(() => parse({ kind: "something.else" })).toThrow(TeamJobError);
    expect(() => parse({ version: 2 })).toThrow(TeamJobError);
    expect(() => parseTeamJob("[]")).toThrow(TeamJobError);
  });

  it("refuses malformed ThreadLink ids", () => {
    expect(() => parse({ jobId: "tljob_nope" })).toThrow(/jobId/);
    expect(() => parse({ roomId: "../etc" })).toThrow(/roomId/);
  });

  it("refuses budgets outside their bounds instead of clamping them silently", () => {
    expect(() =>
      parse({ budgets: { maxPlanningRounds: 2, maxReviewRounds: 99, parallelAgents: 2 } }),
    ).toThrow(/maxReviewRounds/);
    expect(() =>
      parse({ budgets: { maxPlanningRounds: 0, maxReviewRounds: 3, parallelAgents: 2 } }),
    ).toThrow(/maxPlanningRounds/);
    expect(() =>
      parse({ budgets: { maxPlanningRounds: 2, maxReviewRounds: 3, parallelAgents: 1.5 } }),
    ).toThrow(/parallelAgents/);
  });

  it("refuses unknown providers, roles and policies", () => {
    expect(() => parse({ agents: [{ provider: "nova", displayName: "x", roles: [] }] })).toThrow(
      /provider/,
    );
    expect(() =>
      parse({ agents: [{ provider: "codex", displayName: "x", roles: ["overlord"] }] }),
    ).toThrow(/role/);
    expect(() => parse({ policy: { ...valid().policy, usagePolicy: "yolo" } })).toThrow(
      /usagePolicy/,
    );
    expect(() => parse({ agents: [] })).toThrow(/no agents/);
  });

  it("bounds the commands ThreadLink will run itself", () => {
    expect(() => parse({ verifyCommands: Array(11).fill("npm test") })).toThrow(/at most 10/);
    expect(() => parse({ verifyCommands: ["npm test\nrm -rf /"] })).toThrow(/control characters/);
    expect(() => parse({ verifyCommands: ["x".repeat(301)] })).toThrow();
  });

  it("treats a missing optional spec as empty, not as an error", () => {
    const job = parse({ spec: undefined });
    expect(job.spec).toEqual({});
  });
});
