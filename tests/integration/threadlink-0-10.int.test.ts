import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import { ChatActionError } from "@/lib/chat/chats";
import { ChatNotFoundError } from "@/lib/chat/queries";
import {
  addAttachmentAs,
  controlJobAs,
  decideChoiceAs,
  getHostStatusAs,
  getRunProvenanceFor,
  listArtifactsFor,
  listChoicesFor,
  listDecisionsFor,
  listFindingsFor,
  listLiveActivityFor,
  listRunsFor,
  listTimelineFor,
  markChatReadSeqAs,
  readArtifactFor,
  revealRunNativeSessionAs,
  searchChatsAs,
} from "@/lib/chat/work";
import { approvePairing, registerSession, requestPairing } from "@/lib/client-api/operations";
import {
  registerConversation,
  registerRuntime,
  runtimeHeartbeat,
  upsertWorkspace,
} from "@/lib/client-api/runtime";
import { claimTask } from "@/lib/client-api/tasks";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { listAgentProviders } from "@/lib/providers/registry";
import {
  createRoom,
  reportProviderDetection,
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
 * ThreadLink 0.10 through the real stack (app code -> PostgREST -> DB
 * functions, triggers and RLS): a protocol-10 Runtime's run lifecycle,
 * run-tied messages, a user choice decided by the owner, the per-chat
 * timeline, provenance, artifacts, search, host status and job control, and
 * cross-account isolation of all of it.
 */

const A = uniqueClerkId("V10A");
const B = uniqueClerkId("V10B");
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
    version: "0.10.0",
    protocol: 10,
  });
  const { workspaceId } = await upsertWorkspace(client, rtHmac, {
    workspaceKey: "d".repeat(63) + (label === "A" ? "a" : "b"),
    displayName: `${label} project`,
    path: `C:\\work\\v10-${label}`,
    repoRemote: null,
    repoFingerprint: null,
    branch: "main",
  });
  await runtimeHeartbeat(client, rtHmac, {
    version: "0.10.0",
    capabilities: { "claude-code": "available" },
    busySessionIds: [],
    protocol: 10,
  });
  const { sessionId: agentSession } = await registerConversation(client, rtHmac, {
    workspaceId,
    localBindingRef: `v10-worker-${label}`,
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
    name: `V10 ${label}`,
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

describe("ThreadLink 0.10 end to end", () => {
  let jobId: string;
  let chatId: string;
  let runId: string;
  let reviewRun: string;
  let choiceId: string;
  const claimRef = "v10-claim";
  const write = (op: string, payload: unknown) =>
    writeTeamState(client, alice.runtime.hmac, jobId, {
      sessionId: alice.runtime.session,
      claimRef,
      op,
      payload,
    });

  it("the registry is public metadata", async () => {
    const providers = await listAgentProviders(alice.db);
    expect(providers.filter((p) => p.supported).map((p) => p.id)).toEqual(["claude-code", "codex"]);
  });

  it("a protocol-10 Runtime runs a Team job with recorded runs", async () => {
    const { job } = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId: alice.roomId,
      goal: "Add rate limiting",
    });
    jobId = job.jobId;
    chatId = job.chatId!;
    const { data } = await admin.from("team_jobs").select("task_id").eq("id", jobId).single();
    await claimTask(client, alice.runtime.hmac, (data as { task_id: string }).task_id, {
      sessionId: alice.runtime.session,
      claimRef,
    });
    const started = await write("run_started", {
      runKey: "plan:1",
      provider: "claude-code",
      participantKey: "claude-code:planner",
      role: "planner",
      requestedModel: "claude-opus-4-1",
      effort: null,
      access: "read-only",
      timeoutMs: 900_000,
      continuity: "fresh",
    });
    expect(started.created).toBe(true);
    runId = started.runId!;
    const again = await write("run_started", {
      runKey: "plan:1",
      provider: "claude-code",
      participantKey: "claude-code:planner",
      role: "planner",
    });
    expect(again).toMatchObject({ runId, created: false });

    const live = await listLiveActivityFor(alice.db, alice.user, chatId);
    expect(live.map((l) => `${l.providerName}:${l.role}`)).toEqual(["Claude Code:planner"]);

    const msg = await write("add_message", {
      sender: "claude-code",
      type: "proposal",
      body: "Plan: API first, then tests.",
      runId,
    });
    expect(msg.eventId).toMatch(/^tlcev_/);
    await expect(
      write("add_message", { sender: "claude-code", type: "proposal", body: "No run" }),
    ).rejects.toThrow();

    const finished = await write("run_finished", {
      runId,
      status: "completed",
      observedModel: "claude-opus-4-1",
      modelVerified: true,
      accessVerified: true,
      nativeSessionId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      nativeSessionKind: "claude_session",
    });
    expect(finished.verified).toBe(true);

    reviewRun = (
      await write("run_started", {
        runKey: "plan-review:1",
        provider: "codex",
        participantKey: "codex:reviewer",
        role: "reviewer",
      })
    ).runId!;
    await write("add_message", {
      sender: "codex",
      type: "review",
      body: "Agree; one concern.",
      runId: reviewRun,
      replyTo: { kind: "message", id: msg.eventId },
    });
    await write("add_finding", {
      severity: "important",
      category: "security",
      summary: "Limit by account too",
      raisedBy: "codex",
      file: "app/api/limit.ts",
      line: 12,
      runId: reviewRun,
    });
    await write("add_decision", { topic: "Roles chosen", titleSource: "threadlink" });
  });

  it("the owner reads the timeline by its own cursor, with provenance", async () => {
    const page = await listTimelineFor(alice.db, alice.user, chatId, {});
    expect(page.events.every((e) => e.seq === e.chatSeq)).toBe(true);
    const seqs = page.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const review = page.events.find((e) => e.body === "Agree; one concern.")!;
    const proposal = page.events.find((e) => e.body === "Plan: API first, then tests.")!;
    expect(review).toMatchObject({ runId: reviewRun, provenance: "run", replyTo: proposal.id });
    expect(
      page.events.some((e) => e.eventType === "decision_card" && e.body === "Roles chosen"),
    ).toBe(true);
    const older = await listTimelineFor(alice.db, alice.user, chatId, {
      before: seqs[1]!,
      limit: 5,
    });
    expect(older.events.map((e) => e.seq)).toEqual([seqs[0]]);

    const prov = await getRunProvenanceFor(alice.db, alice.user, chatId, runId);
    expect(prov).toMatchObject({
      verified: "verified",
      executionHost: "A PC",
      nativeSession: { available: true },
    });
    expect(JSON.stringify(prov)).not.toContain("0f0e0d0c-0b0a-4908-8706-050403020100");
    const runs = await listRunsFor(alice.db, alice.user, chatId);
    expect(runs.map((r) => r.runId)).toEqual([reviewRun, runId]);
    const findings = await listFindingsFor(alice.db, alice.user, chatId);
    expect(findings[0]).toMatchObject({ status: "open", filePath: "app/api/limit.ts", line: 12 });
    const decisions = await listDecisionsFor(alice.db, alice.user, chatId);
    expect(decisions[0]).toMatchObject({ title: "Roles chosen", titleSource: "threadlink" });

    const revealed = await revealRunNativeSessionAs(alice.db, alice.user, chatId, runId);
    expect(revealed).toMatchObject({
      nativeSessionId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      resumeCommand: "claude --resume 0f0e0d0c-0b0a-4908-8706-050403020100",
    });
  });

  it("a choice is asked by the Runtime and answered only by its owner", async () => {
    const asked = await write("request_choice", {
      kind: "timeout",
      params: {
        provider: "codex",
        otherProvider: "claude-code",
        step: "review",
        unit: null,
        minutes: 30,
      },
      options: [{ key: "retry" }, { key: "retry_other" }, { key: "stop" }],
      idempotencyKey: "timeout:review:1",
    });
    choiceId = asked.choiceId!;
    const choices = await listChoicesFor(alice.db, alice.user, chatId);
    expect(choices[0]).toMatchObject({
      title: "Codex timed out after 30 min while reviewing. What should ThreadLink do?",
      status: "pending",
    });
    await expect(
      decideChoiceAs(bob.db, bob.user, chatId, choiceId, { key: "stop" }),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
    const err = await decideChoiceAs(alice.db, alice.user, chatId, choiceId, {
      key: "deploy",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatActionError);
    const chosen = await decideChoiceAs(alice.db, alice.user, chatId, choiceId, {
      key: "retry_other",
    });
    expect(chosen).toMatchObject({ status: "chosen", chosenKey: "retry_other" });
    const read = await write("read_choices", { choiceIds: [choiceId] });
    expect(read.choices?.[0]).toMatchObject({
      choiceId,
      status: "chosen",
      chosenKey: "retry_other",
    });
  });

  it("controls, attachments, artifacts, search, host status and the read cursor", async () => {
    const control = await controlJobAs(alice.db, alice.user, chatId, {
      jobId,
      action: "stop_after_review",
    });
    expect(control.control).toBe("stop_after_review");
    const status = await write("ack_control", { control: "stop_after_review" });
    expect(status).toMatchObject({ cleared: true, control: null });

    const att = await addAttachmentAs(alice.db, alice.user, chatId, {
      title: "Context",
      content: "Notes. password: hunter2-secret",
    });
    const file = await readArtifactFor(alice.db, alice.user, chatId, att.artifactId);
    expect(file?.content).not.toContain("hunter2");
    await write("add_artifact", {
      kind: "report",
      title: "Final report",
      mime: "text/markdown",
      content: "# Report",
      runId,
    });
    const arts = await listArtifactsFor(alice.db, alice.user, chatId);
    expect(arts.map((a) => a.kind).sort()).toEqual(["report", "user_attachment"]);

    const found = await searchChatsAs(alice.db, { q: "API first" });
    expect(found.map((r) => r.kind)).toContain("message");
    expect(await searchChatsAs(bob.db, { q: "API first" })).toEqual([]);

    const host = await getHostStatusAs(alice.db, chatId);
    expect(host.runtime).toMatchObject({ label: "A PC", needsUpdate: false });
    expect(host.agents.map((a) => a.state)).toEqual(["ready", "ready"]);
    expect(host.agents[0]!.label).toMatch(/^Ready · checked \d+ s ago$/);

    const marked = await markChatReadSeqAs(alice.db, chatId, 1_000_000);
    const page = await listTimelineFor(alice.db, alice.user, chatId, { technical: true });
    expect(marked.lastReadChatSeq).toBe(page.cursor);
  });

  it("another account sees none of it", async () => {
    await expect(listTimelineFor(bob.db, bob.user, chatId, {})).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(getRunProvenanceFor(bob.db, bob.user, chatId, runId)).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    await expect(revealRunNativeSessionAs(bob.db, bob.user, chatId, runId)).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
    const { data } = await bob.db.from("agent_runs").select("id").eq("id", runId);
    expect(data).toEqual([]);
    const choices = await bob.db.from("user_choices").select("id").eq("id", choiceId);
    expect(choices.data).toEqual([]);
    const err = await getHostStatusAs(bob.db, chatId).catch((e) => e);
    expect(err).toBeInstanceOf(ChatActionError);
    expect((err as ChatActionError).reason).toBe("chat_not_found");
  });
});
