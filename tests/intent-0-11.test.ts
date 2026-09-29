import { describe, expect, it } from "vitest";

import { classifyIntent, stripLanePrefix } from "@/lib/chat/intent";
import { LANE_REASONS, type LaneReason } from "@/lib/chat/types";

/**
 * docs/design/threadlink-0.11.md section 2.4: every example from the phase
 * brief, plus the edges (polite forms, negations, prefixes, defaults).
 */
const cls = (body: string, extra: Partial<Parameters<typeof classifyIntent>[0]> = {}) =>
  classifyIntent({ body, activeWorkJob: false, mode: "team", ...extra });

type Row = [body: string, lane: "chat" | "work", reason?: LaneReason];

const CHAT: Row[] = [
  ["hi team", "chat", "small_talk"],
  ["@team hi", "chat", "small_talk"],
  ["Hello!", "chat", "small_talk"],
  ["thanks!", "chat", "small_talk"],
  ["thank you so much", "chat", "small_talk"],
  ["ok cool", "chat", "small_talk"],
  ["what do you think about the plan?", "chat", "question"],
  ["@Claude continue", "chat", "continuation"],
  ["continue", "chat", "continuation"],
  ["go on", "chat", "continuation"],
  ["review this finding", "chat", "discussion"],
  ["@Claude check this idea", "chat", "discussion"],
  ["explain finding 3", "chat", "discussion"],
  ["can you explain why the build fails?", "chat", "question"],
  ["why is the lexer slow?", "chat", "question"],
  ["is the login bug fixed?", "chat", "question"],
  ["what's the status?", "chat", "status"],
  ["status", "chat", "status"],
  ["how's it going", "chat"],
  ["Hey Claude, can you look at the failing test?", "chat", "question"],
  ["write a poem about queues", "chat", "default_chat"],
  ["interesting, tell me more about the tradeoffs", "chat"],
  ["I think the second approach is cleaner", "chat", "discussion"],
  ["hmm", "chat", "default_chat"],
];

const WORK: Row[] = [
  ["review the whole Prism repo for security", "work", "repo_review"],
  ["fix the login bug", "work", "edit_requested"],
  ["run the tests", "work", "tests_requested"],
  [
    "@team inspect Prism authentication, identify issues, fix them, run tests and review each other's changes.",
    "work",
    "edit_requested",
  ],
  ["Okay, inspect the repo and fix the auth issue.", "work", "edit_requested"],
  ["can you fix the login bug?", "work", "edit_requested"],
  ["Please run the tests", "work", "tests_requested"],
  ["go ahead and implement it", "work", "edit_requested"],
  ["implement the export button", "work", "edit_requested"],
  ["add rate limiting to the API", "work", "edit_requested"],
  ["refactor the parser", "work", "edit_requested"],
  ["make the tests pass", "work", "tests_requested"],
  ["make it work", "work", "edit_requested"],
  ["set up CI for the repo", "work", "edit_requested"],
  ["lint", "work", "tests_requested"],
  ["deploy it", "work", "repo_action"],
  ["commit and push", "work", "repo_action"],
  ["audit the codebase", "work", "repo_review"],
  ["do a security review of the repo", "work", "repo_review"],
  ["inspect the repo", "work", "repo_review"],
  ["@Codex could you update the README with the new flags", "work", "edit_requested"],
  ["delete src/old/legacy.ts", "work", "edit_requested"],
];

describe("classifyIntent: the phase brief's table", () => {
  it.each([...CHAT, ...WORK])("%s -> %s (%s)", (body, lane, reason) => {
    const r = cls(body);
    expect(r.lane).toBe(lane);
    if (reason) expect(r.reason).toBe(reason);
    expect(LANE_REASONS).toContain(r.reason);
  });
});

describe("classifyIntent: negations force chat", () => {
  it.each([
    "don't change anything, just review the repo",
    "review the whole repo without editing anything",
    "look at the tests but do not run them",
    "fix nothing, read-only please: what is wrong with auth?",
    "Do not modify the code; explain the login bug",
  ])("%s", (body) => {
    const r = cls(body);
    expect(r.lane).toBe("chat");
    expect(r.reason).toBe("negated");
  });

  it("a negation of something else is not a negation of acting", () => {
    expect(cls("fix the bug without breaking the API").lane).toBe("work");
    expect(cls("don't forget to run the tests").lane).toBe("work");
  });
});

describe("classifyIntent: explicit lanes", () => {
  it("/chat and /work prefixes win and are stripped from the stored body", () => {
    const a = cls("/chat fix the login bug");
    expect(a).toMatchObject({ lane: "chat", reason: "explicit_chat", body: "fix the login bug" });
    const b = cls("/work hi team");
    expect(b).toMatchObject({ lane: "work", reason: "explicit_work", body: "hi team" });
    expect(cls("/WORK   run the tests").body).toBe("run the tests");
  });

  it("the composer toggle forces the lane; auto classifies", () => {
    expect(cls("fix the login bug", { explicit: "chat" })).toMatchObject({
      lane: "chat",
      reason: "explicit_chat",
    });
    expect(cls("hi", { explicit: "work" })).toMatchObject({
      lane: "work",
      reason: "explicit_work",
    });
    expect(cls("fix the login bug", { explicit: "auto" }).lane).toBe("work");
    expect(cls("fix the login bug", { explicit: null }).lane).toBe("work");
  });

  it("a typed prefix beats the toggle", () => {
    expect(cls("/chat fix it", { explicit: "work" }).lane).toBe("chat");
  });

  it("only a leading, whole-word prefix counts", () => {
    expect(stripLanePrefix("/chatty fix it")).toEqual({ body: "/chatty fix it", explicit: null });
    expect(stripLanePrefix("please /work")).toEqual({ body: "please /work", explicit: null });
    expect(stripLanePrefix("/work")).toEqual({ body: "", explicit: "work" });
  });

  it("keeps the body unchanged without a prefix", () => {
    expect(cls("@Claude fix the bug").body).toBe("@Claude fix the bug");
  });
});

describe("classifyIntent: small talk and defaults", () => {
  it("flags small talk only for short greetings and acknowledgements", () => {
    expect(cls("hi team").smallTalk).toBe(true);
    expect(cls("thanks Claude").smallTalk).toBe(true);
    expect(cls("hi team, fix the login bug").smallTalk).toBe(false);
    expect(cls("hi team, fix the login bug").lane).toBe("work");
    expect(cls("hello hello hello hello hello hello hello").smallTalk).toBe(false);
  });

  it("defaults to chat when unsure, whatever runs or the mode", () => {
    for (const mode of ["solo", "pair", "team"] as const) {
      for (const activeWorkJob of [true, false]) {
        expect(classifyIntent({ body: "hmm, interesting", activeWorkJob, mode }).lane).toBe("chat");
        expect(classifyIntent({ body: "fix the login bug", activeWorkJob, mode }).lane).toBe(
          "work",
        );
      }
    }
  });

  it("an empty body is chat", () => {
    expect(cls("").lane).toBe("chat");
    expect(cls("   ").lane).toBe("chat");
  });

  it("is deterministic", () => {
    const body = "Okay, inspect the repo and fix the auth issue.";
    expect(cls(body)).toEqual(cls(body));
  });
});
