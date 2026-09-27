import { describe, expect, it } from "vitest";

import { call, ClientOperationError, type ClientDatabase } from "@/lib/client-api/operations";

import { isInterruptedRefusal } from "../runtime/src/team/wire.ts";

/**
 * A credential client (the Runtime) must be able to act on a few fixed
 * refusals, such as "this job waits for the owner's resume". Only those fixed
 * codes pass through from the database hint; nothing else, and never text.
 */
const dbFailing = (code: string, hint: string | null, message = "internal detail") =>
  ({
    rpc: async () => ({ data: null, error: { code, hint, message } }),
  }) as unknown as ClientDatabase;

async function caught(db: ClientDatabase) {
  try {
    await call(db, "team_job_write", {}, (d) => d);
  } catch (error) {
    return error as ClientOperationError;
  }
  throw new Error("expected a refusal");
}

describe("refusal reasons a Runtime may see", () => {
  it("passes a fixed, known hint through as the reason", async () => {
    const e = await caught(dbFailing("55000", "interrupted_needs_owner"));
    expect(e.kind).toBe("conflict");
    expect(e.reason).toBe("interrupted_needs_owner");
  });

  it("drops any other hint and never carries database text", async () => {
    const e = await caught(dbFailing("55000", "some internal hint", "relation secret_table"));
    expect(e.kind).toBe("conflict");
    expect(e.reason).toBeUndefined();
    expect(e.message).toBe("conflict");
  });

  it("the Runtime recognises the refusal and hands the job to the owner", () => {
    expect(isInterruptedRefusal({ kind: "conflict", reason: "interrupted_needs_owner" })).toBe(
      true,
    );
    expect(isInterruptedRefusal({ kind: "conflict", reason: null })).toBe(false);
    expect(isInterruptedRefusal({ kind: "conflict" })).toBe(false);
  });
});
