import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VERDICT_REASONS as SERVER } from "@/lib/team/model";

import { VERDICT_REASONS as RUNTIME } from "../runtime/src/team/verdict-reasons.ts";

/**
 * A verdict's reason is a fixed code, turned into a fixed sentence by the
 * database, so agent text never reaches ThreadLink's verdict line. The three
 * copies of the list (Runtime, server schema, SQL) must be identical.
 */
describe("verdict reason codes", () => {
  // Migrations are additive: the check constraint and chat_reason_text are
  // re-stated as supersets, so the LAST migration that defines each one counts.
  const migrations = readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join("supabase/migrations", f), "utf8"));
  const last = (needle: string) =>
    [...migrations].reverse().find((sql) => sql.includes(needle)) ?? "";
  const checkSql = last("team_jobs_verdict_reason_check check (verdict_reason in (");
  const reasonSql = last("function threadlink_private.chat_reason_text(p_code text)");

  it("are the same in the Runtime, the server schema and the database check", () => {
    expect([...RUNTIME]).toEqual([...SERVER]);
    const check = /verdict_reason in \(([^)]*)\)/.exec(checkSql)?.[1] ?? "";
    expect(check.split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...RUNTIME]);
  });

  it("each has a fixed sentence in the database", () => {
    expect(reasonSql).not.toBe("");
    const fn = reasonSql.slice(
      reasonSql.indexOf("function threadlink_private.chat_reason_text(p_code text)"),
    );
    for (const code of RUNTIME) expect(fn).toContain(`when '${code}' then '`);
  });

  it("the orchestrator gives every stop a reason", () => {
    const src = readFileSync("runtime/src/team/orchestrator.ts", "utf8");
    const stops = src.match(/new Stop\(/g)?.length ?? 0;
    const tagged =
      // The reason may be followed by the provider it is about (0.9).
      src.match(new RegExp(String.raw`"(${RUNTIME.join("|")})",?\s*(?:[\w.]+,?\s*)?\)`, "g"))
        ?.length ?? 0;
    expect(stops).toBeGreaterThan(20);
    expect(tagged).toBeGreaterThanOrEqual(stops);
  });
});
