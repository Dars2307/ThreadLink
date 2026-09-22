import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import {
  approvePairing,
  ClientOperationError,
  getSession,
  listSessionLinks,
  registerSession,
  requestPairing,
  retireSession,
  revokePairing,
} from "@/lib/client-api/operations";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection, revokeConnection } from "@/lib/connections/registration";
import { listSessions, listThreadLinks, revokeThreadLinkAsOwner } from "@/lib/sessions/queries";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * Sessions + pairing through the real stack: app operations -> supabase-js
 * (anon, credential HMAC) -> PostgREST -> SECURITY DEFINER functions + RLS.
 */

const A = uniqueClerkId("PairA");
const B = uniqueClerkId("PairB");

type Client = { connectionId: string; hmac: string };
let userA: ThreadLinkUser;
let userB: ThreadLinkUser;
let dbA: Awaited<ReturnType<typeof userClient>>;
let dbB: Awaited<ReturnType<typeof userClient>>;
let controllerA: Client;
let agentA: Client;
let agentA2: Client;
let agentB: Client;

const client = anonymousClient();

async function connect(
  db: typeof dbA,
  user: ThreadLinkUser,
  platform: "chatgpt" | "claude-code",
): Promise<Client> {
  const { connection, credential } = await registerConnection(
    db,
    user,
    { platform },
    TEST_CONNECTION_SECRET,
  );
  return {
    connectionId: connection.id,
    hmac: hashConnectionToken(credential.token, TEST_CONNECTION_SECRET),
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof ClientOperationError ? error.kind : "no-error";
}

beforeAll(async () => {
  dbA = await userClient(A);
  dbB = await userClient(B);
  const none = { displayName: null, primaryEmail: null };
  userA = await provisionThreadLinkUser(identity(A), none, dbA);
  userB = await provisionThreadLinkUser(identity(B), none, dbB);
  controllerA = await connect(dbA, userA, "chatgpt");
  agentA = await connect(dbA, userA, "claude-code");
  agentA2 = await connect(dbA, userA, "claude-code");
  agentB = await connect(dbB, userB, "claude-code");
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

let chat: string;
let repo: string;
let repo2: string;
let bobRepo: string;

describe("session registration", () => {
  it("registers controller and agent sessions with role/platform from the connection", async () => {
    const c = await registerSession(client, controllerA.hmac, {
      displayName: "Planning",
      localBindingRef: "chat-1",
    });
    const g = await registerSession(client, agentA.hmac, {
      displayName: "threadlink repo",
      providerSessionRef: "claude-native-1",
      localBindingRef: "cc-1",
    });
    chat = c.session.sessionId;
    repo = g.session.sessionId;
    repo2 = (await registerSession(client, agentA2.hmac, { localBindingRef: "cc-2" })).session
      .sessionId;
    bobRepo = (await registerSession(client, agentB.hmac, {})).session.sessionId;

    expect(c).toMatchObject({
      created: true,
      session: { platform: "chatgpt", role: "controller" },
    });
    expect(g.session).toMatchObject({ platform: "claude-code", role: "agent", status: "active" });
    expect(chat).toMatch(/^tlses_[0-9a-f]{32}$/);
  });

  it("is idempotent on (connection, localBindingRef) even when metadata changes", async () => {
    const again = await registerSession(client, agentA.hmac, {
      displayName: "renamed",
      providerSessionRef: "claude-native-2",
      localBindingRef: "cc-1",
    });
    expect(again).toMatchObject({
      created: false,
      session: { sessionId: repo, displayName: "renamed" },
    });
  });

  it("concurrent reconnects with the same local ref converge on one binding", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        registerSession(client, agentA.hmac, { localBindingRef: "cc-race" }),
      ),
    );
    expect(new Set(results.map((r) => r.session.sessionId)).size).toBe(1);
  });

  it("another connection cannot read or claim the session", async () => {
    expect(await kindOf(getSession(client, agentA2.hmac, repo))).toBe("not_found");
    expect(await kindOf(getSession(client, agentB.hmac, repo))).toBe("not_found");
    const other = await registerSession(client, agentA2.hmac, { localBindingRef: "cc-1" });
    expect(other.session.sessionId).not.toBe(repo);
  });

  it("an unknown credential cannot register", async () => {
    expect(await kindOf(registerSession(client, "0".repeat(64), {}))).toBe("unauthorized");
  });
});

describe("pairing", () => {
  let link: string;

  it("controller request is pending until the exact agent approves", async () => {
    const requested = await requestPairing(client, controllerA.hmac, {
      controllerSessionId: chat,
      agentSessionId: repo,
    });
    link = requested.linkId;
    expect(requested.status).toBe("pending");

    const pending = await listSessionLinks(client, agentA.hmac, repo);
    expect(pending.map((l) => [l.linkId, l.status])).toEqual([[link, "pending"]]);

    expect(
      (
        await requestPairing(client, controllerA.hmac, {
          controllerSessionId: chat,
          agentSessionId: repo,
        })
      ).linkId,
    ).toBe(link);
  });

  it("denies self-approval, wrong agents and other users", async () => {
    expect(
      await kindOf(approvePairing(client, controllerA.hmac, { sessionId: chat, linkId: link })),
    ).toBe("forbidden");
    expect(
      await kindOf(approvePairing(client, agentA2.hmac, { sessionId: repo2, linkId: link })),
    ).toBe("not_found");
    expect(
      await kindOf(approvePairing(client, agentA2.hmac, { sessionId: repo, linkId: link })),
    ).toBe("not_found");
    expect(
      await kindOf(approvePairing(client, agentB.hmac, { sessionId: bobRepo, linkId: link })),
    ).toBe("not_found");
  });

  it("denies wrong roles and cross-user targets", async () => {
    expect(
      await kindOf(
        requestPairing(client, agentA.hmac, { controllerSessionId: repo, agentSessionId: repo2 }),
      ),
    ).toBe("forbidden");
    expect(
      await kindOf(
        requestPairing(client, controllerA.hmac, {
          controllerSessionId: chat,
          agentSessionId: bobRepo,
        }),
      ),
    ).toBe("not_found");
  });

  it("the target agent approves; the link becomes active", async () => {
    const approved = await approvePairing(client, agentA.hmac, { sessionId: repo, linkId: link });
    expect(approved.status).toBe("active");
    expect(approved.approvedAt).not.toBeNull();
  });

  it("the dashboard (RLS) shows the owner's sessions and links only", async () => {
    const sessionsA = await listSessions(dbA, userA);
    expect(sessionsA.map((s) => s.sessionId)).toEqual(expect.arrayContaining([chat, repo, repo2]));
    expect(sessionsA.map((s) => s.sessionId)).not.toContain(bobRepo);
    const linksA = await listThreadLinks(dbA, userA);
    expect(linksA.find((l) => l.linkId === link)?.status).toBe("active");
    expect(await listThreadLinks(dbB, userB)).toEqual([]);
  });

  it("User B cannot revoke User A's link from the dashboard or a client", async () => {
    await expect(revokeThreadLinkAsOwner(dbB, link)).rejects.toThrow("Thread link not found");
    expect(
      await kindOf(revokePairing(client, agentB.hmac, { sessionId: bobRepo, linkId: link })),
    ).toBe("not_found");
    expect((await listThreadLinks(dbA, userA)).find((l) => l.linkId === link)?.status).toBe(
      "active",
    );
  });

  it("revocation is terminal; re-pairing creates a new tllnk_", async () => {
    const revoked = await revokePairing(client, agentA.hmac, { sessionId: repo, linkId: link });
    expect(revoked).toMatchObject({ status: "revoked", revokedReason: "revoked_by_agent" });
    expect(
      await kindOf(approvePairing(client, agentA.hmac, { sessionId: repo, linkId: link })),
    ).toBe("conflict");
    const fresh = await requestPairing(client, controllerA.hmac, {
      controllerSessionId: chat,
      agentSessionId: repo,
    });
    expect(fresh.linkId).not.toBe(link);
    expect(fresh.status).toBe("pending");
  });
});

describe("revocation cascade", () => {
  it("retiring a session revokes its links immediately and cannot be undone", async () => {
    const pending = await requestPairing(client, controllerA.hmac, {
      controllerSessionId: chat,
      agentSessionId: repo2,
    });
    const retired = await retireSession(client, agentA2.hmac, { sessionId: repo2 });
    expect(retired.status).toBe("retired");
    const [after] = await listSessionLinks(client, controllerA.hmac, chat).then((ls) =>
      ls.filter((l) => l.linkId === pending.linkId),
    );
    expect(after).toMatchObject({ status: "revoked", revokedReason: "agent_session_ended" });
    expect(await kindOf(registerSession(client, agentA2.hmac, { localBindingRef: "cc-2" }))).toBe(
      "conflict",
    );
    expect(
      await kindOf(
        approvePairing(client, agentA2.hmac, { sessionId: repo2, linkId: pending.linkId }),
      ),
    ).toBe("conflict");
  });

  it("revoking a connection revokes its sessions and their links", async () => {
    const [live] = (await listSessionLinks(client, agentA.hmac, repo)).filter(
      (l) => l.status === "pending",
    );
    await approvePairing(client, agentA.hmac, { sessionId: repo, linkId: live.linkId });

    await revokeConnection(dbA, userA, agentA.connectionId);

    expect(await kindOf(getSession(client, agentA.hmac, repo))).toBe("unauthorized");
    expect(await kindOf(registerSession(client, agentA.hmac, {}))).toBe("unauthorized");
    const sessions = await listSessions(dbA, userA);
    expect(sessions.find((s) => s.sessionId === repo)?.status).toBe("revoked");
    const links = await listThreadLinks(dbA, userA);
    expect(links.find((l) => l.linkId === live.linkId)).toMatchObject({
      status: "revoked",
      revokedReason: "agent_session_ended",
    });
    expect(
      await kindOf(
        requestPairing(client, controllerA.hmac, {
          controllerSessionId: chat,
          agentSessionId: repo,
        }),
      ),
    ).toBe("not_found");
  });
});
