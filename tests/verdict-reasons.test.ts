import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERDICT_REASONS as SERVER } from "@/lib/team/model";

import { VERDICT_REASONS as RUNTIME } from "../runtime/src/team/verdict-reasons.ts";

/**
 * A verdict's reason is a fixed code, turned into a fixed sentence by the
 * database, so agent text never reaches ThreadLink's verdict line. The three
 * copies of the list (Runtime, server schema, SQL) must be identical.
 */
describe("verdict reason codes", () => {
  const sql = readFileSync("supabase/migrations/20260926000100_collaboration_chat.sql", "utf8");

  it("are the same in the Runtime, the server schema and the database check", () => {
    expect([...RUNTIME]).toEqual([...SERVER]);
    const check = /verdict_reason in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect(check.split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...RUNTIME]);
  });

  it("each has a fixed sentence in the database", () => {
    for (const code of RUNTIME) expect(sql).toContain(`when '${code}' then '`);
  });

  it("the orchestrator gives every stop a reason", () => {
    const src = readFileSync("runtime/src/team/orchestrator.ts", "utf8");
    const stops = src.match(/new Stop\(/g)?.length ?? 0;
    const tagged =
      src.match(new RegExp(String.raw`"(${RUNTIME.join("|")})",?\s*\)`, "g"))?.length ?? 0;
    expect(stops).toBeGreaterThan(20);
    expect(tagged).toBeGreaterThanOrEqual(stops);
  });
});
