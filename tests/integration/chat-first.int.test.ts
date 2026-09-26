import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import {
  ChatActionError,
  createChatAs,
  createChatGroupAs,
  deleteChatGroupAs,
  getChatFor,
  listChatGroupsFor,
  listChatsFor,
  markChatReadAs,
  renameChatGroupAs,
  retryJobWithRolesAs,
  updateChatAs,
} from "@/lib/chat/chats";
import { ChatNotFoundError, listChatFor, postChatMessageAs } from "@/lib/chat/queries";
import {
  approvePairing,
  ClientOperationError,
  registerSession,
  requestPairing,
} from "@/lib/client-api/operations";
import {
  registerConversation,
  registerRuntime,
  runtimeHeartbeat,
  upsertWorkspace,
} from "@/lib/client-api/runtime";
import { claimTask } from "@/lib/client-api/tasks";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { listProviderProfilesFor } from "@/lib/providers/queries";
import {
  createChatTask,
  createRoom,
  ProviderUnhealthyError,
  reportProviderDetection,
  startTeamJob,
  writeTeamState,
} from "@/lib/team/client-api";
import { listChatJobsFor } from "@/lib/team/queries";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * Chat-first through the real stack (app code -> PostgREST -> DB functions,
 * triggers and RLS): chats and groups, chat-keyed posting and routing, the
 * provider health gate on the owner and controller paths, controller chatId,
 * the explicit retry, and cross-account isolation.
 */

const A = uniqueClerkId("CfA");
const B = uniqueClerkId("CfB");
const client = anonymousClient();

type Account = {
  user: ThreadLinkUser;
  db: Awaited<ReturnType<typeof userClient>>;
  chat: { hmac: string; session: string; linkId: string };
  runtime: { hmac: string; session: string };
  roomId: string;
};
let alice: Account;
let bob: Account;

async function report(acct: Account, provider: "claude-code" | "codex", health: string) {
  await reportProviderDetection(client, acct.runtime.hmac, {
    provider,
    detected: {
      installed: true,
      authenticated: true,
      authMethod: provider === "claude-code" ? "claude.ai" : "chatgpt",
      health,
      healthCheckedAt: new Date().toISOString(),
      healthDetail:
        health === "ready"
          ? "Signed in and answering."
          : "Needs you to sign in again on this computer.",
    },
  });
}

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
    version: "0.9.0",
  });
  const { workspaceId } = await upsertWorkspace(client, rtHmac, {
    workspaceKey: "e".repeat(63) + (label === "A" ? "a" : "b"),
    displayName: `${label} project`,
    path: `C:\\work\\cf-${label}`,
    repoRemote: null,
    repoFingerprint: null,
    branch: "main",
  });
  await runtimeHeartbeat(client, rtHmac, {
    version: "0.9.0",
    capabilities: { "claude-code": "available" },
    busySessionIds: [],
  });
  const { sessionId: agentSession } = await registerConversation(client, rtHmac, {
    workspaceId,
    localBindingRef: `cf-worker-${label}`,
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
  const acct: Account = {
    user,
    db,
    chat: { hmac: chatHmac, session: chat.sessionId, linkId },
    runtime: { hmac: rtHmac, session: agentSession },
    roomId: "",
  };
  await report(acct, "claude-code", "ready");
  await report(acct, "codex", "ready");
  const { room } = await createRoom(client, chatHmac, {
    sessionId: chat.sessionId,
    name: `CF ${label}`,
  });
  acct.roomId = room.roomId;
  return acct;
}

beforeAll(async () => {
  alice = await account(A, "A");
  bob = await account(B, "B");
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

const jobCount = async (userId: string) =>
  (
    await admin
      .from("team_jobs")
      .select("id", { count: "exact", head: true })
      .eq("owner_user_id", userId)
  ).count;

describe("chat-first end to end", () => {
  let soloChat: string;
  let teamChat: string;
  let soloJob: string;

  it("every project has a default chat, with its agents and their health", async () => {
    const chats = await listChatsFor(alice.db, alice.user);
    const def = chats.find((c) => c.roomId === alice.roomId && c.isRoomDefault);
    expect(def).toMatchObject({ name: "CF A", mode: "team", projectName: "CF A", unread: false });
    expect(def!.participants.map((p) => `${p.kind}:${p.name}:${p.health ?? "-"}`)).toEqual([
      "agent:Claude Code:ready",
      "agent:Codex:ready",
      "owner:You:-",
    ]);
    const profiles = await listProviderProfilesFor(alice.db, alice.user);
    expect(profiles.map((p) => p.detected.health)).toEqual(["ready", "ready"]);
  });

  it("a solo chat runs its chosen agent; the mode change is in the chat", async () => {
    soloChat = (await createChatAs(alice.db, { name: "Docs", roomId: alice.roomId, mode: "solo" }))
      .chatId;
    const updated = await updateChatAs(alice.db, soloChat, { soloProvider: "codex" });
    expect(updated.settings.soloProvider).toBe("codex");

    const out = await postChatMessageAs(alice.db, {
      chatId: soloChat,
      body: "Write the README",
      idempotencyKey: "cf-1",
    });
    expect(out).toMatchObject({ ok: true, routed: "new_job" });
    soloJob = (out as { jobId: string }).jobId;

    const page = await listChatFor(alice.db, alice.user, { chatId: soloChat });
    expect(page.activeJob).toMatchObject({ jobId: soloJob, mode: "solo" });
    expect(page.events.map((e) => `${e.authorKind}:${e.eventType}`)).toEqual([
      "threadlink:mode_changed",
      "owner:request",
      "threadlink:job_started",
    ]);
    expect(page.events[0].body).toBe("Mode changed to Solo: Codex works alone.");
    expect(page.events.every((e) => e.chatId === soloChat)).toBe(true);

    const jobs = await listChatJobsFor(alice.db, alice.user, soloChat);
    expect(
      jobs.map((j) => [j.jobId, j.mode, j.builder, j.chatId, j.lastPhase, j.planPersisted]),
    ).toEqual([[soloJob, "solo", "codex", soloChat, "queued", false]]);
  });

  it("the health gate: a Team post while Claude Code needs sign-in starts nothing", async () => {
    teamChat = (await createChatAs(alice.db, { name: "Refactor", roomId: alice.roomId })).chatId;
    await report(alice, "claude-code", "needs_sign_in");
    const before = await jobCount(alice.user.id);
    const out = await postChatMessageAs(alice.db, {
      chatId: teamChat,
      body: "Refactor the router",
    });
    expect(out).toEqual({
      ok: false,
      reason: "provider_unhealthy",
      message:
        "Claude Code — Needs sign-in · Codex — Ready. Claude Code needs you to sign in again on this computer.",
      health: [
        { provider: "claude-code", health: "needs_sign_in" },
        { provider: "codex", health: "ready" },
      ],
      stored: true,
    });
    expect(await jobCount(alice.user.id)).toBe(before);
    const page = await listChatFor(alice.db, alice.user, { chatId: teamChat });
    expect(page.events.map((e) => `${e.authorKind}:${e.eventType}:${e.body}`)).toEqual([
      "owner:request:Refactor the router",
      "threadlink:provider_blocked:Claude Code needs you to sign in again on this computer. Codex is ready.",
    ]);

    // The controller path refuses too, and says who is not ready.
    const err = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      goal: "Also refused",
      chatId: teamChat,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnhealthyError);
    expect((err as ProviderUnhealthyError).userMessage).toContain("Claude Code — Needs sign-in");
    expect(await jobCount(alice.user.id)).toBe(before);
    await report(alice, "claude-code", "ready");
  });

  it("a controller may name the chat; another account's chat is not found", async () => {
    const { job } = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      goal: "Plan the next release",
      chatId: teamChat,
    });
    expect(job.chatId).toBe(teamChat);
    const page = await listChatFor(alice.db, alice.user, { chatId: teamChat });
    expect(
      page.events.some((e) => e.authorKind === "controller" && e.authorLabel === "ChatGPT"),
    ).toBe(true);

    const foreign = await startTeamJob(client, bob.chat.hmac, {
      sessionId: bob.chat.session,
      roomId: bob.roomId,
      goal: "Into Alice's chat",
      chatId: teamChat,
    }).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(ClientOperationError);
    expect((foreign as ClientOperationError).kind).toBe("not_found");

    const task = await createChatTask(client, bob.chat.hmac, {
      originSessionId: bob.chat.session,
      threadLinkId: bob.chat.linkId,
      chatId: teamChat,
      title: "t",
      content: "c",
    }).catch((e: unknown) => e);
    expect((task as ClientOperationError).kind).toBe("not_found");

    // Clean up: the Runtime cancels it so the chat is free.
    const { data } = await admin.from("team_jobs").select("task_id").eq("id", job.jobId).single();
    await claimTask(client, alice.runtime.hmac, (data as { task_id: string }).task_id, {
      sessionId: alice.runtime.session,
      claimRef: "cf-cancel",
    });
    await writeTeamState(client, alice.runtime.hmac, job.jobId, {
      sessionId: alice.runtime.session,
      claimRef: "cf-cancel",
      op: "set_status",
      payload: { status: "cancelled" },
    });
  });

  it("a job blocked before its plan offers an explicit retry with another coordinator", async () => {
    const { job } = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      goal: "Blocked early",
      chatId: teamChat,
    });
    const { data } = await admin.from("team_jobs").select("task_id").eq("id", job.jobId).single();
    await claimTask(client, alice.runtime.hmac, (data as { task_id: string }).task_id, {
      sessionId: alice.runtime.session,
      claimRef: "cf-block",
    });
    const final = await writeTeamState(client, alice.runtime.hmac, job.jobId, {
      sessionId: alice.runtime.session,
      claimRef: "cf-block",
      op: "set_final",
      payload: {
        verdict: "BLOCKED",
        reason: "agent_needs_sign_in",
        provider: "claude-code",
        evidence: {},
      },
    });
    expect(final).toMatchObject({
      verdictReason: "agent_needs_sign_in",
      verdictProvider: "claude-code",
    });

    const detail = await getChatFor(alice.db, alice.user, teamChat);
    expect(detail?.needsAttention).toBe(true);
    expect(detail?.retry?.jobId).toBe(job.jobId);
    expect(detail?.retry?.coordinators.map((c) => `${c.provider}:${c.health}`).sort()).toEqual([
      "claude-code:ready",
      "codex:ready",
    ]);
    const verdict = (await listChatFor(alice.db, alice.user, { chatId: teamChat })).events.find(
      (e) => e.eventType === "job_verdict",
    );
    expect(verdict?.body).toContain("Claude Code needs you to sign in again on this computer.");

    // Bob cannot retry Alice's job.
    const bobs = await retryJobWithRolesAs(bob.db, job.jobId, "codex").catch((e: unknown) => e);
    expect((bobs as ChatActionError).reason).toBe("job_not_found");

    const retry = await retryJobWithRolesAs(alice.db, job.jobId, "codex");
    expect(retry).toMatchObject({ chatId: teamChat, replayed: false });
    const again = await retryJobWithRolesAs(alice.db, job.jobId, "codex");
    expect(again).toMatchObject({ jobId: retry.jobId, replayed: true });
    const { data: row } = await admin
      .from("team_jobs")
      .select("role_overrides, retried_from_job_id, chat_id")
      .eq("id", retry.jobId)
      .single();
    expect(row).toEqual({
      role_overrides: { coordinator: "codex" },
      retried_from_job_id: job.jobId,
      chat_id: teamChat,
    });
    expect((await getChatFor(alice.db, alice.user, teamChat))?.retry).toBeNull();
  });

  it("chats keep unread state, groups and isolation", async () => {
    const before = (await listChatsFor(alice.db, alice.user)).find((c) => c.chatId === teamChat)!;
    expect(before.unread).toBe(true);
    const page = await listChatFor(alice.db, alice.user, { chatId: teamChat });
    await markChatReadAs(alice.db, teamChat, page.cursor);
    const after = (await listChatsFor(alice.db, alice.user)).find((c) => c.chatId === teamChat)!;
    expect(after.unread).toBe(false);

    const group = await createChatGroupAs(alice.db, "Client work");
    await updateChatAs(alice.db, teamChat, { groupId: group.groupId });
    expect(
      (await listChatsFor(alice.db, alice.user, { groupId: group.groupId })).map((c) => c.chatId),
    ).toEqual([teamChat]);
    expect((await renameChatGroupAs(alice.db, group.groupId, "Clients")).name).toBe("Clients");
    expect((await listChatGroupsFor(alice.db, alice.user)).map((g) => g.name)).toEqual(["Clients"]);

    // Bob sees none of it, and cannot touch it.
    expect(await listChatsFor(bob.db, bob.user)).toSatisfy((cs: { chatId: string }[]) =>
      cs.every((c) => c.chatId !== teamChat && c.chatId !== soloChat),
    );
    expect(await getChatFor(bob.db, bob.user, teamChat)).toBeNull();
    await expect(listChatFor(bob.db, bob.user, { chatId: teamChat })).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(updateChatAs(bob.db, teamChat, { name: "mine" })).rejects.toMatchObject({
      reason: "chat_not_found",
    });
    await expect(deleteChatGroupAs(bob.db, group.groupId)).rejects.toMatchObject({
      reason: "group_not_found",
    });
    expect(await listChatGroupsFor(bob.db, bob.user)).toEqual([]);
    expect(await postChatMessageAs(bob.db, { chatId: teamChat, body: "hello" })).toMatchObject({
      ok: false,
      reason: "chat_not_found",
    });

    await deleteChatGroupAs(alice.db, group.groupId);
    const still = await getChatFor(alice.db, alice.user, teamChat);
    expect(still?.groupId).toBeNull();
  });

  it("the 0.8 room-keyed post still works, into the project's default chat", async () => {
    const out = await postChatMessageAs(alice.db, { roomId: bob.roomId, body: "not mine" });
    expect(out).toMatchObject({ ok: false, reason: "not_found" });
    // Alice's default chat is busy with nothing; @claude starts solo there.
    const mine = await postChatMessageAs(alice.db, {
      roomId: alice.roomId,
      body: "@claude tidy up",
    });
    expect(mine).toMatchObject({ ok: true, routed: "new_job" });
    const def = (await listChatsFor(alice.db, alice.user)).find(
      (c) => c.roomId === alice.roomId && c.isRoomDefault,
    )!;
    expect(def.activeJob?.jobId).toBe((mine as { jobId: string }).jobId);
  });
});
