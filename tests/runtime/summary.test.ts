import { describe, expect, it } from "vitest";

import { summarize, SUMMARY_MAX_CHARS } from "../../runtime/src/summary.ts";

/**
 * The mirrored feed is the one place a result's text is shown outside the
 * task itself, so what this function lets through is a security boundary, not
 * a formatting choice.
 */

describe("what a mirrored summary says", () => {
  it("uses the first real line of the result", () => {
    expect(summarize("Added the activity feed and wired it up.\n\nDetails follow.")).toBe(
      "Added the activity feed and wired it up.",
    );
  });

  it("skips markdown decoration", () => {
    expect(summarize("## Summary\n\n- Renamed the worker binding")).toBe(
      "Renamed the worker binding",
    );
  });

  it("caps a long line rather than filling the feed", () => {
    const summary = summarize(
      `Rewrote the activity feed ${"and tidied the renderer ".repeat(20)}`,
    )!;
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("has nothing to say about an empty or missing result", () => {
    expect(summarize(null)).toBeNull();
    expect(summarize("")).toBeNull();
    expect(summarize("   \n\n  ")).toBeNull();
  });
});

describe("what a mirrored summary must never say", () => {
  it("drops fenced code, where diffs and keys live", () => {
    const result = "```ts\nconst KEY = 'sk-live-abcdefghijklmnop';\n```\nDone.";
    expect(summarize(result)).toBe("Done.");
  });

  it("drops an unterminated code fence too", () => {
    expect(summarize("```\nsecret-looking content that never closes")).toBeNull();
  });

  it("redacts credentials that appear in prose", () => {
    for (const secret of [
      "sk-ant-api03-abcdefghijklmnopqrst",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "xoxb-1234567890-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "tlc_0123456789abcdef0123456789abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmno",
    ]) {
      const summary = summarize(`Used the key ${secret} to authenticate.`);
      expect(summary, secret).not.toContain(secret.slice(0, 12));
      expect(summary, secret).toContain("[redacted]");
    }
  });

  it("redacts a named secret whatever its shape", () => {
    expect(summarize("Set api_key = hunter2 in the config")).toContain("[redacted]");
    // A line that is nothing but a credential leaves nothing worth showing.
    expect(summarize("Authorization: Bearer abc123") ?? "").not.toContain("abc123");
  });

  it("redacts long high-entropy blobs", () => {
    expect(summarize(`Wrote ${"a1b2c3d4".repeat(6)} to disk`)).toContain("[redacted]");
  });

  it("redacts absolute paths, which name the person and the machine", () => {
    expect(summarize("Edited C:\\Users\\joelo\\Desktop\\secret\\plan.md")).not.toContain("joelo");
    expect(summarize("Edited /home/joel/notes.txt")).not.toContain("/home/joel");
  });

  it("says nothing at all when the line was only a secret", () => {
    expect(summarize("sk-live-abcdefghijklmnopqrstuvwx")).toBeNull();
  });

  it("strips control characters, so a summary cannot rewrite the display", () => {
    const summary = summarize("Done\u001b[31m\u0000 now")!;
    expect(summary).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
