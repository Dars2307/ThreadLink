import { describe, expect, it } from "vitest";

import { matchChoiceAnswer, matchOpenChoices } from "@/lib/chat/choice-intent";
import type { ChoiceForMatch } from "@/lib/chat/types";

/** docs/design/threadlink-0.11.md section 6. Options/labels as the server builds them. */
const failureCodex = (exhausted: boolean): ChoiceForMatch => ({
  choiceId: "tlchc_" + "1".repeat(32),
  kind: "provider_failure",
  provider: "codex",
  otherProvider: "claude-code",
  providerHealth: exhausted ? "usage_exhausted" : "ready",
  options: [
    ...(exhausted ? [] : [{ key: "retry", label: "Retry Codex" }]),
    { key: "use_other", label: "Use Claude Code instead" },
    { key: "stop", label: "Stop" },
  ],
});
const exhaustedCodex: ChoiceForMatch = {
  choiceId: "tlchc_" + "2".repeat(32),
  kind: "usage_exhausted",
  provider: "codex",
  otherProvider: "claude-code",
  providerHealth: "usage_exhausted",
  options: [
    { key: "continue_other", label: "Continue with Claude" },
    { key: "check_again", label: "Check Codex again" },
    { key: "wait", label: "Wait for Codex" },
    { key: "stop", label: "Stop" },
  ],
};
const timeoutClaude: ChoiceForMatch = {
  choiceId: "tlchc_" + "3".repeat(32),
  kind: "timeout",
  provider: "claude-code",
  otherProvider: "codex",
  options: [
    { key: "retry", label: "Retry this step" },
    { key: "retry_other", label: "Retry with Codex" },
    { key: "increase_timeout", label: "Give it more time" },
    { key: "stop", label: "Stop" },
  ],
};
const interrupted: ChoiceForMatch = {
  choiceId: "tlchc_" + "4".repeat(32),
  kind: "interrupted",
  options: [
    { key: "resume", label: "Resume from the last safe step" },
    { key: "stop", label: "Stop" },
  ],
};
const startWork: ChoiceForMatch = {
  choiceId: "tlchc_" + "5".repeat(32),
  kind: "start_work",
  options: [
    { key: "run_work", label: "Run this as work" },
    { key: "keep_chatting", label: "Keep chatting" },
  ],
};
const migration: ChoiceForMatch = {
  choiceId: "tlchc_" + "6".repeat(32),
  kind: "migration",
  options: [
    { key: "approve", label: "Approve" },
    { key: "deny", label: "Don't approve" },
  ],
};
const plan: ChoiceForMatch = {
  choiceId: "tlchc_" + "7".repeat(32),
  kind: "plan_disagreement",
  provider: "codex",
  otherProvider: "claude-code",
  options: [
    { key: "accept_proposal", label: "Go with Codex's plan" },
    { key: "accept_other", label: "Go with Claude Code's plan" },
    { key: "extra_round", label: "Allow one more planning round" },
    { key: "stop", label: "Stop" },
  ],
};

const key = (body: string, c: ChoiceForMatch) => matchChoiceAnswer(body, c)?.key ?? null;

describe("matchChoiceAnswer: the phase brief", () => {
  it("@Claude continue picks the option naming Claude (provider_failure and usage_exhausted for Codex)", () => {
    expect(matchChoiceAnswer("@Claude continue", failureCodex(true))).toEqual({
      choiceId: failureCodex(true).choiceId,
      key: "use_other",
      label: "Use Claude Code instead",
    });
    expect(key("@Claude continue", failureCodex(false))).toBe("use_other");
    expect(matchChoiceAnswer("@Claude continue", exhaustedCodex)?.label).toBe(
      "Continue with Claude",
    );
  });

  it.each([
    "use Claude",
    "continue with Claude",
    "switch to Claude",
    "let Claude do it",
    "Claude instead",
    "use claude code",
    "@claude-code take over",
  ])("%s -> the Claude option", (body) => {
    expect(key(body, exhaustedCodex)).toBe("continue_other");
    expect(key(body, failureCodex(true))).toBe("use_other");
  });

  it("stop", () => {
    for (const body of ["stop", "Stop.", "cancel", "stop the job", "abort"]) {
      expect(key(body, exhaustedCodex)).toBe("stop");
      expect(key(body, interrupted)).toBe("stop");
    }
  });

  it("wait for Codex", () => {
    expect(key("wait for Codex", exhaustedCodex)).toBe("wait");
    expect(key("wait", exhaustedCodex)).toBe("wait");
    expect(key("let's wait", exhaustedCodex)).toBe("wait");
  });

  it("retry Codex when Codex is exhausted -> check_again, never a blind retry", () => {
    expect(key("retry Codex", exhaustedCodex)).toBe("check_again");
    expect(key("retry", exhaustedCodex)).toBe("check_again");
    expect(key("try again", exhaustedCodex)).toBe("check_again");
    expect(key("check Codex again", exhaustedCodex)).toBe("check_again");
    // provider_failure while exhausted: retry is not offered and nothing else is meant.
    expect(key("retry Codex", failureCodex(true))).toBeNull();
    expect(key("retry", failureCodex(true))).toBeNull();
    // ...and when Codex is fine, retry means retry.
    expect(key("retry Codex", failureCodex(false))).toBe("retry");
    expect(key("try again", failureCodex(false))).toBe("retry");
  });

  it("naming the exhausted agent itself rechecks it, never retries blindly", () => {
    expect(key("@Codex continue", exhaustedCodex)).toBe("check_again");
    expect(key("@Codex continue", failureCodex(true))).toBeNull();
    expect(key("@Codex continue", failureCodex(false))).toBe("retry");
  });

  it("continue / resume an interrupted job", () => {
    expect(key("continue", interrupted)).toBe("resume");
    expect(key("resume", interrupted)).toBe("resume");
    // "continue" alone does not pick an agent.
    expect(key("continue", exhaustedCodex)).toBeNull();
  });

  it("start_work: run it / go ahead / do it; keep chatting / no", () => {
    for (const body of [
      "run it",
      "go ahead",
      "do it",
      "yes",
      "Yes, do it",
      "ok do it",
      "run this as work",
    ]) {
      expect(key(body, startWork)).toBe("run_work");
    }
    for (const body of ["keep chatting", "no", "not now", "no thanks"]) {
      expect(key(body, startWork)).toBe("keep_chatting");
    }
  });

  it("timeouts and plan disagreements", () => {
    expect(key("retry with Codex", timeoutClaude)).toBe("retry_other");
    expect(key("give it more time", timeoutClaude)).toBe("increase_timeout");
    expect(key("retry", timeoutClaude)).toBe("retry");
    expect(key("go with Claude's plan", plan)).toBe("accept_other");
    expect(key("Codex's plan", plan)).toBe("accept_proposal");
    expect(key("one more round", plan)).toBe("extra_round");
  });
});

describe("matchChoiceAnswer: never approvals, never ambiguous", () => {
  it("approval kinds are never answered by typing", () => {
    for (const body of ["approve", "yes", "do it", "go ahead", "deny", "stop"]) {
      expect(matchChoiceAnswer(body, migration)).toBeNull();
    }
    for (const kind of [
      "production_deploy",
      "destructive_action",
      "security_action",
      "paid_usage",
      "permission_expansion",
      "secret_change",
    ] as const) {
      expect(matchChoiceAnswer("approve", { ...migration, kind })).toBeNull();
    }
  });

  it.each([
    "what do you think we should do?",
    "Claude, can you explain what happened with Codex before we decide anything here?",
    "hmm",
    "fix the login bug",
    "use Gemini",
    "",
  ])("%s -> null", (body) => {
    expect(matchChoiceAnswer(body, exhaustedCodex)).toBeNull();
  });

  it("an option that is not offered is never returned", () => {
    const noOther: ChoiceForMatch = {
      ...exhaustedCodex,
      otherProvider: null,
      options: exhaustedCodex.options.slice(1),
    };
    expect(matchChoiceAnswer("use Claude", noOther)).toBeNull();
    expect(
      key("wait", { ...exhaustedCodex, options: [{ key: "stop", label: "Stop" }] }),
    ).toBeNull();
  });

  it("long messages are not answers", () => {
    expect(
      matchChoiceAnswer("stop stop stop stop stop stop stop stop stop stop stop", exhaustedCodex),
    ).toBeNull();
  });
});

describe("matchOpenChoices", () => {
  it("tries the chat's open choices newest first", () => {
    const m = matchOpenChoices("run it", [exhaustedCodex, startWork]);
    expect(m?.choiceId).toBe(startWork.choiceId);
    expect(matchOpenChoices("stop", [exhaustedCodex, interrupted])?.choiceId).toBe(
      exhaustedCodex.choiceId,
    );
    expect(matchOpenChoices("approve", [migration])).toBeNull();
    expect(matchOpenChoices("anything", [])).toBeNull();
  });
});
