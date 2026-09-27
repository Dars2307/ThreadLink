import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import {
  ChatApiError,
  controllerChatStatus,
  controllerJobResult,
  createControllerChat,
  createRuntimeChat,
  getControllerChat,
  getRuntimeChat,
  listControllerChats,
  listRuntimeChats,
  markRuntimeChatRead,
  postControllerChatMessage,
  postRuntimeChatMessage,
  runtimeChatEvents,
} from "@/lib/client-api/chats";
import { approvePairing, registerSession, requestPairing } from "@/lib/client-api/operations";
import {
  registerConversation,
  registerRuntime,
  runtimeHeartbeat,
  upsertWorkspace,
} from "@/lib/client-api/runtime";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { createRoom, reportProviderDetection } from "@/lib/team/client-api";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * The 0.10 credential chat API through the real stack (app code -> PostgREST
 * -> the database functions): the Runtime (desktop/terminal) path and the
 * controller (MCP) path, cross-account isolation, and wrong credential kinds.
 */

const A = uniqueClerkId("CaA");
const B = uniqueClerkId("CaB");
const client = anonymousClient();

type Account = {
  chat: { hmac: string; session: string };
  runtime: { hmac: string };
  roomId: string;
};
let alice: Account;
let bob: Account;

async function account(sub: string, label: string): Promise<Account> {
  const db = await userClient(sub);
  const user = await provisionThreadLinkUser(
    identity(sub),
    { displayName: null, primaryEmail: null },
    db,
  );
  const hmacFor = async (platform: "chatgpt" | "claude-code") => {
    const { credential } = await registerConnection(db, user, { platform }, TEST_CONNECTION_SECRET);
    return hashConnectionToken(credential.token, TEST_CONNECTION_SECRET);
  };
  const chatHmac = await hmacFor("chatgpt");
  const rtHmac = await hmacFor("claude-code");
  await registerRuntime(client, rtHmac, {
    label: `${label} PC`,
    platform: "windows",
    kind: "desktop",
    version: "0.10.0",
  });
  const { workspaceId } = await upsertWorkspace(client, rtHmac, {
    workspaceKey: "c".repeat(63) + (label === "A" ? "a" : "b"),
    displayName: `${label} project`,
    path: `C:\\work\\ca-${label}`,
    repoRemote: null,
    repoFingerprint: null,
    branch: "main",
  });
  await runtimeHeartbeat(client, rtHmac, {
    version: "0.10.0",
    capabilities: { "claude-code": "available" },
    busySessionIds: [],
  });
  const { sessionId: agentSession } = await registerConversation(client, rtHmac, {
    workspaceId,
    localBindingRef: `ca-worker-${label}`,
    displayName: `${label} worker`,
    provider: "claude-code",
    mode: "fresh",
    nativeSessionId: null,
  });
  const { session: chat } = await registerSession(client, chatHmac, {});
  const { linkId } = await requestPairing(client, chatHmac, {
    controllerSessionId: chat.sessionId,
    agentSessionId: agentSession,
  });
  await approvePairing(client, rtHmac, { sessionId: agentSession, linkId });
  for (const provider of ["claude-code", "codex"] as const) {
    await reportProviderDetection(client, rtHmac, {
      provider,
      detected: {
        installed: true,
        authenticated: true,
        authMethod: provider === "claude-code" ? "claude.ai" : "chatgpt",
        health: "ready",
        healthCheckedAt: new Date().toISOString(),
        healthDetail: "Signed in and answering.",
      },
    });
  }
  const { room } = await createRoom(client, chatHmac, {
    sessionId: chat.sessionId,
    name: `CA ${label}`,
  });
  return {
    chat: { hmac: chatHmac, session: chat.sessionId },
    runtime: { hmac: rtHmac },
    roomId: room.roomId,
  };
}

beforeAll(async () => {
  alice = await account(A, "A");
  bob = await account(B, "B");
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ChatApiError ? e.reason : "other";
  }
};

describe("credential chat API end to end", () => {
  let chatId: string;
  let bobChat: string;

  it("the Runtime lists, creates and reads the owner's chats", async () => {
    const created = await createRuntimeChat(client, alice.runtime.hmac, {
      name: "From the terminal",
      roomId: alice.roomId,
      mode: "team",
    });
    chatId = created.chatId;
    expect(created).toMatchObject({
      projectName: "CA A",
      runtimeLabel: "A PC",
      thisComputer: true,
    });
    const { chats, projects, runtime } = await listRuntimeChats(client, alice.runtime.hmac, {});
    expect(runtime).toMatchObject({ label: "A PC", version: "0.10.0", updateRequired: false });
    expect(chats.map((c) => c.chatId)).toContain(chatId);
    expect(projects).toEqual([
      { roomId: alice.roomId, name: "CA A", runtimeLabel: "A PC", thisComputer: true },
    ]);
    bobChat = (
      await createRuntimeChat(client, bob.runtime.hmac, { name: "Bob's", roomId: bob.roomId })
    ).chatId;
  });

  it("posts as the owner from the terminal, idempotently, with a per-chat cursor", async () => {
    const first = await postRuntimeChatMessage(
      client,
      alice.runtime.hmac,
      chatId,
      { body: "Build it", idempotencyKey: "ca-1" },
      "terminal",
    );
    expect(first).toMatchObject({ ok: true, routed: "new_job", replayed: false });
    const again = await postRuntimeChatMessage(
      client,
      alice.runtime.hmac,
      chatId,
      { body: "Build it", idempotencyKey: "ca-1" },
      "terminal",
    );
    expect(again).toMatchObject({ ok: true, replayed: true });
    const page = await runtimeChatEvents(client, alice.runtime.hmac, chatId, {});
    const mine = page.events.find((e) => e.authorKind === "owner");
    expect(mine).toMatchObject({ authorLabel: "You", client: "terminal", body: "Build it" });
    expect(page.events[0]!.cursor).toBe(1);
    expect(page.activeJob).not.toBeNull();
    const read = await markRuntimeChatRead(client, alice.runtime.hmac, chatId, {
      cursor: page.cursor,
    });
    expect(read.lastReadCursor).toBe(page.cursor);
    expect((await getRuntimeChat(client, alice.runtime.hmac, chatId)).lastReadCursor).toBe(
      page.cursor,
    );
  });

  it("another account's chat is not found; a controller credential is refused", async () => {
    expect(await reason(getRuntimeChat(client, alice.runtime.hmac, bobChat))).toBe(
      "chat_not_found",
    );
    expect(
      await reason(
        postRuntimeChatMessage(client, alice.runtime.hmac, bobChat, { body: "x" }, "desktop"),
      ),
    ).toBe("chat_not_found");
    expect(await reason(listRuntimeChats(client, alice.chat.hmac, {}))).toBe("forbidden");
    expect(await reason(listRuntimeChats(client, "0".repeat(64), {}))).toBe("unauthenticated");
  });

  it("the controller reaches only chats of its own links, and posts as itself", async () => {
    const { chats } = await listControllerChats(client, alice.chat.hmac, alice.chat.session);
    expect(chats.map((c) => c.chatId)).toContain(chatId);
    expect(chats.map((c) => c.chatId)).not.toContain(bobChat);
    const created = await createControllerChat(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      name: "From GPT",
      mode: "pair",
    });
    const { job, created: isNew } = await postControllerChatMessage(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      chatId: created.chatId,
      body: "Add rate limiting",
      idempotencyKey: "ca-gpt-1",
    });
    expect(isNew).toBe(true);
    expect(job.origin).toBe("controller");
    const read = await getControllerChat(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      chatId: created.chatId,
    });
    expect(
      read.messages.events.some(
        (e) => e.authorKind === "controller" && e.authorLabel === "ChatGPT",
      ),
    ).toBe(true);
    expect(
      (
        await controllerChatStatus(client, alice.chat.hmac, {
          sessionId: alice.chat.session,
          chatId: created.chatId,
        })
      ).job?.jobId,
    ).toBe(job.jobId);
    expect(
      (
        await controllerJobResult(client, alice.chat.hmac, {
          sessionId: alice.chat.session,
          jobId: job.jobId,
        })
      ).chatName,
    ).toBe("From GPT");
    expect(
      await reason(
        postControllerChatMessage(client, alice.chat.hmac, {
          sessionId: alice.chat.session,
          chatId: created.chatId,
          body: "more",
        }),
      ),
    ).toBe("job_active");
    expect(
      await reason(
        getControllerChat(client, alice.chat.hmac, {
          sessionId: alice.chat.session,
          chatId: bobChat,
        }),
      ),
    ).toBe("chat_not_found");
    expect(
      await reason(
        getControllerChat(client, alice.runtime.hmac, { sessionId: alice.chat.session, chatId }),
      ),
    ).toBe("forbidden");
  });
});
