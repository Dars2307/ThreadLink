import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommand, runVerify, verifyEnv } from "../../runtime/src/team/verify.ts";

/**
 * ThreadLink runs the owner's tests itself rather than trusting an agent's
 * report. These pin what that means: a real exit code, a bounded tail of the
 * output, a time limit, and none of ThreadLink's own secrets in the process.
 */

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tl-verify-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const node = (code: string) => `node -e "${code}"`;

describe("running the owner's test commands", () => {
  it("reports a passing command as passing, with its output", async () => {
    const r = await runCommand(dir, node("console.log('3 passed')"));
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.output).toContain("3 passed");
  });

  it("reports the real exit code of a failing command", async () => {
    const r = await runCommand(dir, node("console.error('1 failed'); process.exit(3)"));
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    expect(r.output).toContain("1 failed");
  });

  it("stops at the first failure: later commands depend on earlier ones", async () => {
    const results = await runVerify(dir, [
      node("process.exit(0)"),
      node("process.exit(1)"),
      node("console.log('never')"),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });

  it("stops a command that runs too long, and says so", async () => {
    const r = await runCommand(dir, node("setTimeout(()=>{}, 60000)"), { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/took longer than/);
  });

  it("keeps only the end of a very long output, where the failures are", async () => {
    const r = await runCommand(dir, node("for(let i=0;i<5000;i++)console.log('line '+i)"));
    expect(Buffer.byteLength(r.output)).toBeLessThan(20_000);
    expect(r.output).toContain("line 4999");
  });

  it("runs in the directory it was given", async () => {
    const r = await runCommand(dir, node("console.log(process.cwd())"));
    expect(r.output.toLowerCase()).toContain(dir.toLowerCase().split(/[\\/]/).pop()!);
  });
});

describe("what a test command can see", () => {
  it("does not see ThreadLink's own variables", () => {
    const env = verifyEnv({ PATH: "/bin", THREADLINK_CONNECTION_TOKEN: "tlc_secret", HOME: "/h" });
    expect(env.THREADLINK_CONNECTION_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
  });

  it("really is run without them", async () => {
    const r = await runCommand(
      dir,
      node("console.log('token=' + (process.env.THREADLINK_CONNECTION_TOKEN||'none'))"),
      {
        env: verifyEnv({ ...process.env, THREADLINK_CONNECTION_TOKEN: "tlc_secret" }),
      },
    );
    expect(r.output).toContain("token=none");
  });
});
