import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { setMyProviderProfile, removeMyConversation, deleteMyRoom } = vi.hoisted(() => ({
  setMyProviderProfile: vi.fn(async (input: unknown) => ({ input })),
  removeMyConversation: vi.fn(async (id: unknown) => ({ id, status: "retired", linksRevoked: 1 })),
  deleteMyRoom: vi.fn(async (id: unknown) => void id),
}));
vi.mock("@/lib/providers/repository", () => ({ setMyProviderProfile }));
vi.mock("@/lib/team/owner", () => ({ removeMyConversation }));
vi.mock("@/lib/rooms/repository", () => ({
  archiveMyRoom: vi.fn(),
  deleteMyRoom,
  renameMyRoom: vi.fn(),
  updateMyRoomPolicy: vi.fn(),
}));
vi.mock("@/lib/runtimes/repository", () => ({
  revokeMyRuntime: vi.fn(),
  updateMyRuntime: vi.fn(),
}));
vi.mock("@/lib/dashboard/data", () => ({ loadAccount: vi.fn(), loadTeam: vi.fn() }));

import {
  deleteProjectAction,
  removeConversationAction,
  setPaidUsageAction,
} from "@/app/dashboard/team-actions";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("dashboard owner actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never turns paid usage on without the dialog's explicit confirmation", async () => {
    await setPaidUsageAction(form({ provider: "codex", paidUsage: "on" }));
    await setPaidUsageAction(form({ provider: "codex", paidUsage: "on", confirmed: "yes" }));
    expect(setMyProviderProfile).not.toHaveBeenCalled();

    await setPaidUsageAction(
      form({ provider: "codex", paidUsage: "on", confirmed: "I understand" }),
    );
    expect(setMyProviderProfile).toHaveBeenCalledWith({
      provider: "codex",
      paidUsageEnabled: true,
    });
  });

  it("turns paid usage off without a confirmation", async () => {
    await setPaidUsageAction(form({ provider: "claude-code", paidUsage: "off" }));
    expect(setMyProviderProfile).toHaveBeenCalledWith({
      provider: "claude-code",
      paidUsageEnabled: false,
    });
  });

  it("removes conversations and projects only through the owner operations", async () => {
    await removeConversationAction(form({ sessionId: "tlses_x" }));
    expect(removeMyConversation).toHaveBeenCalledWith("tlses_x");
    await deleteProjectAction(form({ roomId: "tlrom_x" }));
    expect(deleteMyRoom).toHaveBeenCalledWith("tlrom_x");
  });

  it("swallows owner-operation failures instead of leaking them", async () => {
    removeMyConversation.mockRejectedValueOnce(new Error("Conversation not found"));
    await expect(removeConversationAction(form({ sessionId: "bad" }))).resolves.toBeUndefined();
  });
});
