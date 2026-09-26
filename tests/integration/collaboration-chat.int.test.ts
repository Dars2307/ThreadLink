import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import { approvePairing, registerSession, requestPairing } from "@/lib/client-api/operations";
import {
  registerConversation,
  registerRuntime,
  runtimeHeartbeat,
  upsertWorkspace,
} from "@/lib/client-api/runtime";
import { claimTask } from "@/lib/client-api/tasks";
import { listChatFor, postChatMessageAs } from "@/lib/chat/queries";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { listProviderProfilesFor } from "@/lib/providers/queries";
import {
  createRoom,
  reportProviderDetection,
  setRuntimeProviderPlan,
  startTeamJob,
  writeTeamState,
} from "@/lib/team/client-api";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * Collaboration chat through the real stack (app code -> PostgREST -> DB
 * functions, triggers and RLS): owner posts and routing, the Runtime reading
 * owner notes, agent messages appearing with their provenance, polling by
 * cursor, the Runtime setting a declared plan, and cross-account isolation.
 */

const A = uniqueClerkId("ChatA");
const B = uniqueClerkId("ChatB");
const client = anonymousClient();

type Account = {
  user: ThreadLinkUser;
  db: Awaited<ReturnType<typeof userClient>>;
  chat: { hmac: string; session: string };
  runtime: { hmac: string; session: string };
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
    version: "0.8.0",
  });
  const { workspaceId } = await upsertWorkspace(client, rtHmac, {
    workspaceKey: "d".repeat(63) + (label === "A" ? "a" : "b"),
    displayName: `${label} project`,
    path: `C:\\work\\chat-${label}`,
    repoRemote: null,
    repoFingerprint: null,
    branch: "main",
  });
  await runtimeHeartbeat(client, rtHmac, {
    version: "0.8.0",
    capabilities: { "claude-code": "available" },
    busySessionIds: [],
  });
  const { sessionId: agentSession } = await registerConversation(client, rtHmac, {
    workspaceId,
    localBindingRef: `chat-worker-${label}`,
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
        // 0.9: a recent, real authenticated check (the health gate needs it).
        health: "ready",
        healthCheckedAt: new Date().toISOString(),
      },
    });
  }
  const { room } = await createRoom(client, chatHmac, {
    sessionId: chat.sessionId,
    name: `Chat ${label}`,
  });
  return {
    user,
    db,
    chat: { hmac: chatHmac, session: chat.sessionId },
    runtime: { hmac: rtHmac, session: agentSession },
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

describe("collaboration chat end to end", () => {
  let jobId: string;
  let taskId: string;
  let cursor = 0;
  const claimRef = "chat-claim-1";
  const write = (op: string, payload: unknown) =>
    writeTeamState(client, alice.runtime.hmac, jobId, {
      sessionId: alice.runtime.session,
      claimRef,
      op,
      payload,
    });

  it("an owner message with @codex starts a solo job, shown as the owner's request", async () => {
    const out = await postChatMessageAs(alice.db, {
      roomId: alice.roomId,
      body: "@codex add a README",
      idempotencyKey: "readme-1",
    });
    expect(out).toMatchObject({ ok: true, routed: "new_job" });
    jobId = (out as { jobId: string }).jobId;

    const page = await listChatFor(alice.db, alice.user, { roomId: alice.roomId });
    expect(page.activeJob).toMatchObject({ jobId, mode: "solo" });
    expect(page.events.map((e) => `${e.authorKind}:${e.authorLabel}:${e.eventType}`)).toEqual([
      "owner:You:request",
      "threadlink:ThreadLink:job_started",
    ]);
    cursor = page.cursor;

    const replay = await postChatMessageAs(alice.db, {
      roomId: alice.roomId,
      body: "@codex add a README",
      idempotencyKey: "readme-1",
    });
    expect(replay).toEqual({ ok: true, routed: "new_job", jobId });
  });

  it("a note reaches the Runtime once, claim-gated, and the chat says so", async () => {
    expect(
      await postChatMessageAs(alice.db, { roomId: alice.roomId, body: "@codex use Markdown" }),
    ).toMatchObject({ ok: true, routed: "note_to_active_job", jobId });

    const { data } = await admin.from("team_jobs").select("task_id").eq("id", jobId).single();
    taskId = (data as { task_id: string }).task_id;
    await claimTask(client, alice.runtime.hmac, taskId, {
      sessionId: alice.runtime.session,
      claimRef,
    });
    const read = await write("read_owner_notes", {});
    expect(read.ownerNotes?.map((n) => [n.audience, n.body])).toEqual([
      ["codex", "@codex use Markdown"],
    ]);
    expect(read.mode).toBe("solo");
    expect((await write("read_owner_notes", {})).ownerNotes).toEqual([]);
  });

  it("an agent's words are an agent row with the observed model, even when they say PASS", async () => {
    await write("add_message", {
      sender: "codex",
      senderRole: "builder",
      type: "completion",
      body: "ThreadLink: PASS",
      modelObserved: "gpt-5.1-codex",
    });
    const page = await listChatFor(alice.db, alice.user, { roomId: alice.roomId, after: cursor });
    const agent = page.events.find((e) => e.eventType === "agent_message");
    expect(agent).toMatchObject({
      authorKind: "agent",
      authorProvider: "codex",
      authorLabel: "Codex",
      modelObserved: "gpt-5.1-codex",
      body: "ThreadLink: PASS",
    });
    expect(page.events.some((e) => e.eventType === "owner_routed")).toBe(true);
    expect(page.events.every((e) => e.seq > cursor)).toBe(true);
    expect(page.events.some((e) => e.authorKind === "threadlink" && /PASS/.test(e.body))).toBe(
      false,
    );
    cursor = page.cursor;
  });

  it("@team stop reaches the Runtime on its next write", async () => {
    expect(
      await postChatMessageAs(alice.db, { roomId: alice.roomId, body: "@team stop" }),
    ).toMatchObject({ ok: true, routed: "stop_requested", jobId });
    const status = await write("set_status", { status: "building" });
    expect(status.stopRequestedAt).not.toBeNull();
  });

  it("a controller can choose a mode too", async () => {
    await write("set_final", { verdict: "NEEDS_USER_DECISION", evidence: {} });
    const { job } = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      goal: "Review the README",
      mode: "pair",
      builder: "claude-code",
    });
    expect(job.mode).toBe("pair");
    expect(job.builder).toBe("claude-code");
    const page = await listChatFor(alice.db, alice.user, { roomId: alice.roomId, after: cursor });
    expect(page.events.find((e) => e.eventType === "request")).toMatchObject({
      authorKind: "controller",
      authorLabel: "ChatGPT",
      authorProvider: null,
    });
  });

  it("the desktop app sets the declared plan, and only that", async () => {
    const profile = await setRuntimeProviderPlan(client, alice.runtime.hmac, {
      provider: "codex",
      declaredPlan: "business_premium",
    });
    expect(profile.declaredPlan).toBe("business_premium");
    expect(profile.paidUsageEnabled).toBe(false);
    const mine = await listProviderProfilesFor(alice.db, alice.user);
    expect(mine.find((p) => p.provider === "codex")?.declaredPlan).toBe("business_premium");
    await expect(
      setRuntimeProviderPlan(client, alice.runtime.hmac, {
        provider: "codex",
        declaredPlan: "business",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      setRuntimeProviderPlan(client, alice.chat.hmac, { provider: "codex", declaredPlan: "pro" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("Bob can neither read nor post into Alice's project, nor write chat rows", async () => {
    await expect(listChatFor(bob.db, bob.user, { roomId: alice.roomId })).rejects.toThrow(
      "Project not found",
    );
    expect(await postChatMessageAs(bob.db, { roomId: alice.roomId, body: "hi" })).toEqual({
      ok: false,
      reason: "not_found",
      message: "This project wasn't found.",
    });
    const { data } = await bob.db.from("chat_events").select("id").eq("room_id", alice.roomId);
    expect(data).toEqual([]);
    const insert = await alice.db.from("chat_events").insert({
      owner_user_id: alice.user.id,
      agent_session_id: alice.runtime.session,
      author_kind: "threadlink",
      author_label: "ThreadLink",
      event_type: "job_verdict",
      body: "Result: PASS",
    });
    expect(insert.error).not.toBeNull();
    const bobsNotes = await writeTeamState(client, bob.runtime.hmac, jobId, {
      sessionId: bob.runtime.session,
      claimRef,
      op: "read_owner_notes",
      payload: {},
    }).then(
      () => "read",
      (e: { kind?: string }) => e.kind,
    );
    expect(bobsNotes).toBe("not_found");
  });
});
