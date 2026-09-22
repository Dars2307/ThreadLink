import { describe, expect, it, vi } from "vitest";

import {
  provisionThreadLinkUser,
  ThreadLinkUserUnavailableError,
  type ProvisioningDatabase,
} from "@/lib/auth/provision";
import type { AuthenticatedIdentity } from "@/lib/auth/resolve-identity";

const identity: AuthenticatedIdentity = {
  clerkUserId: "user_AliceTest01",
  sessionId: "sess_abc123",
};
const profile = { displayName: "Alice", primaryEmail: "alice@example.com" };
const row = {
  id: "tlusr_0123456789abcdef0123456789abcdef",
  clerk_user_id: "user_AliceTest01",
  display_name: "Alice",
  primary_email: "alice@example.com",
  created_at: "2026-09-22T00:00:00Z",
  updated_at: "2026-09-22T00:00:00Z",
};

function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn<ProvisioningDatabase["rpc"]>(async () => result);
  return { db: { rpc } satisfies ProvisioningDatabase, rpc };
}

describe("provisionThreadLinkUser", () => {
  it("maps the verified Clerk identity to its ThreadLink user", async () => {
    const { db } = fakeDb({ data: row, error: null });
    await expect(provisionThreadLinkUser(identity, profile, db)).resolves.toMatchObject({
      id: row.id,
      clerkUserId: "user_AliceTest01",
    });
  });

  it("never sends a Clerk or ThreadLink user ID to the database", async () => {
    const { db, rpc } = fakeDb({ data: row, error: null });
    await provisionThreadLinkUser(identity, profile, db);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("provision_current_user");
    expect(Object.keys(args).sort()).toEqual(["p_display_name", "p_primary_email"]);
    expect(JSON.stringify(args)).not.toContain("user_");
    expect(JSON.stringify(args)).not.toContain("tlusr_");
  });

  it("is stable across repeated calls (idempotent contract)", async () => {
    const { db } = fakeDb({ data: row, error: null });
    const first = await provisionThreadLinkUser(identity, profile, db);
    const second = await provisionThreadLinkUser(
      identity,
      { displayName: null, primaryEmail: null },
      db,
    );
    expect(second.id).toBe(first.id);
  });

  it("fails closed when the database returns another user's row", async () => {
    const { db } = fakeDb({ data: { ...row, clerk_user_id: "user_BobTest02" }, error: null });
    await expect(provisionThreadLinkUser(identity, profile, db)).rejects.toBeInstanceOf(
      ThreadLinkUserUnavailableError,
    );
  });

  it.each([
    ["database error", { data: null, error: { message: "permission denied" } }],
    ["no row", { data: null, error: null }],
    ["malformed ThreadLink ID", { data: { ...row, id: "123" }, error: null }],
    ["Clerk ID used as ThreadLink ID", { data: { ...row, id: "user_AliceTest01" }, error: null }],
  ])("fails closed on %s", async (_label, result) => {
    const { db } = fakeDb(result);
    await expect(provisionThreadLinkUser(identity, profile, db)).rejects.toBeInstanceOf(
      ThreadLinkUserUnavailableError,
    );
  });

  it("does not leak database error details", async () => {
    const { db } = fakeDb({ data: null, error: { message: "relation users does not exist" } });
    await expect(provisionThreadLinkUser(identity, profile, db)).rejects.toThrow(
      "ThreadLink account unavailable",
    );
  });
});
