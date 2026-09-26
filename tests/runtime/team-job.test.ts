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

describe("a job's mode and builder", () => {
  it("defaults to Team Mode when the document does not say", () => {
    expect(parseTeamJob(JSON.stringify(valid()))).toMatchObject({ mode: "team", builder: null });
  });

  it("parses solo and pair with a named builder", () => {
    expect(parse({ mode: "solo", builder: "codex" })).toMatchObject({
      mode: "solo",
      builder: "codex",
    });
    expect(parse({ mode: "pair", builder: "claude-code" })).toMatchObject({
      mode: "pair",
      builder: "claude-code",
    });
  });

  it("leaves an unnamed builder to role assignment: no provider is a default", () => {
    const one = [{ provider: "codex", displayName: "Codex", roles: ["builder"] }];
    expect(parse({ mode: "solo", agents: one })).toMatchObject({ builder: null });
    // Builder + Reviewer used to default to Claude Code building. It no longer does.
    expect(parse({ mode: "pair" })).toMatchObject({ builder: null, reviewer: null });
    expect(parse({ mode: "solo" })).toMatchObject({ mode: "solo", builder: null });
  });

  it("refuses an unknown mode, an unknown builder, or a builder not in the room", () => {
    expect(() => parse({ mode: "swarm" })).toThrow(/mode/);
    expect(() => parse({ mode: "solo", builder: "cursor" })).toThrow(/builder/);
    const one = [{ provider: "codex", displayName: "Codex", roles: ["builder"] }];
    expect(() => parse({ mode: "solo", builder: "claude-code", agents: one })).toThrow(/room/);
  });

  it("parses an explicit pair reviewer, and refuses one that would review itself", () => {
    expect(parse({ mode: "pair", builder: "codex", reviewer: "claude-code" })).toMatchObject({
      builder: "codex",
      reviewer: "claude-code",
    });
    expect(() => parse({ mode: "pair", builder: "codex", reviewer: "codex" })).toThrow(
      /its own work/,
    );
    expect(() => parse({ mode: "pair", reviewer: "cursor" })).toThrow(/reviewer/);
  });
});

describe("0.9 carrier fields", () => {
  it("are optional: an older carrier parses as before", () => {
    expect(parseTeamJob(JSON.stringify(valid()))).toMatchObject({
      roleOverrides: {},
      participants: null,
      chatId: null,
    });
  });

  it("parses roleOverrides, participants and chatId", () => {
    const chatId = `tlcht_${"c".repeat(32)}`;
    expect(
      parse({
        roleOverrides: { coordinator: "codex", reviewer: null },
        participants: ["codex", "claude-code", "codex"],
        chatId,
      }),
    ).toMatchObject({
      roleOverrides: { coordinator: "codex" },
      participants: ["codex", "claude-code"],
      chatId,
    });
  });

  it("fails closed on a malformed value rather than guessing", () => {
    expect(() => parse({ roleOverrides: { coordinator: "cursor" } })).toThrow(/provider/);
    expect(() => parse({ roleOverrides: { boss: "codex" } })).toThrow(/role/);
    expect(() => parse({ roleOverrides: ["codex"] })).toThrow(/object/);
    expect(() => parse({ participants: ["gemini"] })).toThrow(/participants/);
    expect(() => parse({ participants: [] })).toThrow(/participants/);
    expect(() => parse({ chatId: "tlcht_nope" })).toThrow(/chatId/);
    expect(() =>
      parse({ mode: "pair", builder: "codex", roleOverrides: { builder: "claude-code" } }),
    ).toThrow(/different agents/);
  });
});
