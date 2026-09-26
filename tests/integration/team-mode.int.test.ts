import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
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
import { claimTask, getTask, listInbox } from "@/lib/client-api/tasks";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { listProviderProfilesFor, setProviderProfileAs } from "@/lib/providers/queries";
import { deleteRoomAs, listRoomsFor, updateRoomPolicyAs } from "@/lib/rooms/queries";
import {
  createRoom,
  getProviderProfiles,
  getRoom,
  getTeamLog,
  getTeamStatus,
  listRooms,
  reportProviderDetection,
  startTeamJob,
  writeTeamState,
} from "@/lib/team/client-api";
import { getJobDetailFor, listRoomJobsFor } from "@/lib/team/queries";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/**
 * Team Mode through the real stack (app code -> PostgREST -> DB functions + RLS):
 * controller start_team_job -> Runtime claims the carrier -> team_job_write ops
 * -> get_team_status, and cross-account isolation at every step.
 */

const A = uniqueClerkId("TeamA");
const B = uniqueClerkId("TeamB");
const client = anonymousClient();

type Account = {
  user: ThreadLinkUser;
  db: Awaited<ReturnType<typeof userClient>>;
  chat: { hmac: string; session: string };
  runtime: { hmac: string; session: string };
  linkId: string;
};
let alice: Account;
let bob: Account;

async function hmacFor(
  db: Account["db"],
  user: ThreadLinkUser,
  platform: "chatgpt" | "claude-code",
): Promise<string> {
  const { credential } = await registerConnection(db, user, { platform }, TEST_CONNECTION_SECRET);
  return hashConnectionToken(credential.token, TEST_CONNECTION_SECRET);
}

async function account(sub: string, label: string): Promise<Account> {
  const db = await userClient(sub);
  const user = await provisionThreadLinkUser(
    identity(sub),
    { displayName: null, primaryEmail: null },
    db,
  );
  const chatHmac = await hmacFor(db, user, "chatgpt");
  const rtHmac = await hmacFor(db, user, "claude-code");

  await registerRuntime(client, rtHmac, {
    label: `${label} PC`,
    platform: "windows",
    kind: "desktop",
    version: "0.7.0",
  });
  const { workspaceId } = await upsertWorkspace(client, rtHmac, {
    workspaceKey: "c".repeat(63) + (label === "A" ? "a" : "b"),
    displayName: `${label} project`,
    path: `C:\\work\\${label}`,
    repoRemote: null,
    repoFingerprint: null,
    branch: "main",
  });
  await runtimeHeartbeat(client, rtHmac, {
    version: "0.7.0",
    capabilities: { "claude-code": "available" },
    busySessionIds: [],
  });
  const { sessionId: agentSession } = await registerConversation(client, rtHmac, {
    workspaceId,
    localBindingRef: `team-worker-${label}`,
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
  // A Team-capable Runtime reports both agents ready; without that, the server
  // refuses to start a team job (an older Runtime would mis-run it).
  for (const provider of ["claude-code", "codex"] as const) {
    await reportProviderDetection(client, rtHmac, {
      provider,
      detected: {
        installed: true,
        authenticated: true,
        // Signed in with the subscription: an API-key sign-in is refused.
        authMethod: provider === "claude-code" ? "claude.ai" : "chatgpt",
        // 0.9: a recent, real authenticated check (the health gate needs it).
        health: "ready",
        healthCheckedAt: new Date().toISOString(),
      },
    });
  }
  return {
    user,
    db,
    chat: { hmac: chatHmac, session: chat.sessionId },
    runtime: { hmac: rtHmac, session: agentSession },
    linkId,
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
  alice = await account(A, "A");
  bob = await account(B, "B");
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("Team Mode end to end", () => {
  let roomId: string;
  let jobId: string;
  let taskId: string;
  const claimRef = "team-claim-1";
  const write = (op: string, payload: unknown, who: Account = alice, ref = claimRef) =>
    writeTeamState(client, who.runtime.hmac, jobId, {
      sessionId: who.runtime.session,
      claimRef: ref,
      op,
      payload,
    });

  it("the controller creates a room bound to its linked workspace", async () => {
    const { room, created } = await createRoom(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      name: "Prism",
    });
    expect(created).toBe(true);
    expect(room.workspace).toBe("A project");
    expect(room.agent).toBe("A worker");
    expect(room.agents.map((a) => a.provider).sort()).toEqual(["claude-code", "codex"]);
    roomId = room.roomId;
    expect((await listRooms(client, alice.chat.hmac, alice.chat.session)).length).toBe(1);
  });

  it("start_team_job creates the carrier task and the job atomically", async () => {
    // ThreadLink runs test commands itself, outside any agent sandbox, so the
    // project's owner sets them -- never the chat.
    await updateRoomPolicyAs(alice.db, roomId, { verifyCommands: ["npm test"] });
    const { job, created } = await startTeamJob(client, alice.chat.hmac, {
      sessionId: alice.chat.session,
      roomId,
      goal: "Add a /health endpoint",
      spec: { requirements: ["GET /health returns 200"], testsRequired: ["npm test"] },
      maxReviewRounds: 2,
      idempotencyKey: "team-job-1",
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.rounds.review.max).toBe(2);
    jobId = job.jobId;
    taskId = job.taskId;

    const carrier = await getTask(client, alice.chat.hmac, taskId, alice.chat.session);
    expect(carrier.status).toBe("queued");
  });

  it("the Runtime receives a team task whose content describes the whole job", async () => {
    const inbox = await listInbox(client, alice.runtime.hmac, alice.runtime.session);
    const carrier = inbox.find((t) => t.taskId === taskId);
    expect(carrier).toBeDefined();
    const content = JSON.parse(carrier!.content ?? "{}") as Record<string, unknown>;
    expect(content).toMatchObject({
      kind: "threadlink.team_job",
      version: 1,
      jobId,
      roomId,
      roomName: "Prism",
      goal: "Add a /health endpoint",
      budgets: { maxPlanningRounds: 2, maxReviewRounds: 2, parallelAgents: 2 },
      policy: { usagePolicy: "balanced", paidUsage: false, crossReview: true },
      verifyCommands: ["npm test"],
    });
    expect((content.agents as unknown[]).length).toBe(2);
  });

  it("nobody writes team state before the claim; only the claim holder after it", async () => {
    expect(await kindOf(write("set_status", { status: "normalising" }))).toBe("conflict");
    await claimTask(client, alice.runtime.hmac, taskId, {
      sessionId: alice.runtime.session,
      claimRef,
    });
    const s = await write("set_status", { status: "normalising", line: "Reading the goal" });
    expect(s.status).toBe("normalising");
    expect(s.line).toBe("Reading the goal");
    expect(await kindOf(write("set_status", { status: "planning" }, alice, "other-claim"))).toBe(
      "conflict",
    );
  });

  it("runs a whole job through the write endpoint's operations", async () => {
    await write("set_spec", {
      spec: { goal: "Add a /health endpoint", requirements: ["GET /health returns 200"] },
    });
    await write("open_round", { kind: "planning", round: 1 });
    const planned = await write("set_plan", {
      plan: { summary: "One node", nodes: [{ key: "api" }], risks: [] },
      approvedBy: ["codex"],
      round: 1,
    });
    expect(planned.planApproved).toBe(true);
    await write("upsert_nodes", {
      nodes: [
        {
          key: "api",
          title: "Health endpoint",
          scope: "app/api/health",
          files: ["app/api/health/route.ts"],
          dependsOn: [],
          owner: "codex",
          reviewer: "claude-code",
          status: "ready",
        },
      ],
    });
    await write("set_node_status", { key: "api", status: "running" });
    await write("record_usage", {
      provider: "codex",
      role: "builder",
      requestedModel: "gpt-5.5-codex",
      observedModel: "gpt-5.5-codex",
      effort: "medium",
      modelClass: "STRONG",
      reason: "builder default for medium complexity",
      escalatedFrom: null,
      escalationReason: null,
      outcome: "ok",
    });
    await write("open_round", { kind: "review", round: 1 });
    const flagged = await write("add_finding", {
      node: "api",
      round: 1,
      phase: "review",
      severity: "blocking",
      category: "security",
      summary: "Leaks the version header",
      detail: "The response includes x-powered-by.",
      file: "app/api/health/route.ts",
      line: 4,
      raisedBy: "claude-code",
    });
    expect(flagged.findingId).toMatch(/^tlfnd_/);
    expect(flagged.openFindings.blocking).toBe(1);

    // The hard rule: no PASS while a blocking finding is open.
    expect(await kindOf(write("set_final", { verdict: "PASS", evidence: { tests: [] } }))).toBe(
      "conflict",
    );

    await write("add_message", {
      sender: "codex",
      receiver: "claude-code",
      type: "response",
      round: 1,
      body: "Removed the header.",
    });
    await write("set_finding_status", {
      findingId: flagged.findingId,
      status: "resolved",
      round: 1,
    });
    const decided = await write("add_decision", {
      topic: "Keep the endpoint unauthenticated",
      resolution: "Health checks must work without a session.",
      approvedBy: ["codex", "claude-code"],
      evidence: { reason: "load balancer" },
      needsUser: false,
    });
    expect(decided.decisionLabel).toMatch(/^TL-\d{5}$/);
    await write("set_node_status", { key: "api", status: "approved" });
    await write("set_status", { status: "inspecting", line: "Final inspection" });

    const status = await getTeamStatus(client, alice.chat.hmac, alice.chat.session, jobId, roomId);
    expect(status).toMatchObject({
      status: "inspecting",
      rounds: { planning: { n: 1, max: 2 }, review: { n: 1, max: 2 } },
      openFindings: { blocking: 0, important: 0, nonBlocking: 0 },
      nodes: [{ key: "api", owner: "codex", reviewer: "claude-code", status: "approved" }],
    });

    const done = await write("set_final", {
      verdict: "PASS",
      summary: "Health endpoint added and reviewed.",
      evidence: {
        base: "abc123",
        baseExcludedUncommittedChanges: false,
        commits: ["def456"],
        tests: [{ command: "npm test", ok: true, exitCode: 0, output: "ok" }],
        uncertainty: [],
      },
    });
    expect(done.verdict).toBe("PASS");
    expect(done.status).toBe("completed");
  });

  it("the full log is paginated and carries every entry kind", async () => {
    const first = await getTeamLog(client, alice.chat.hmac, alice.chat.session, jobId, {
      limit: 2,
    });
    expect(first.total).toBe(4);
    expect(first.entries).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    const rest = await getTeamLog(client, alice.chat.hmac, alice.chat.session, jobId, {
      offset: 2,
      limit: 50,
    });
    expect(rest.nextOffset).toBeNull();
    const kinds = [...first.entries, ...rest.entries].map((e) => e.kind).sort();
    expect(kinds).toEqual(["decision", "finding", "message", "usage"]);
    expect(first.evidence).toMatchObject({ commits: ["def456"] });
  });

  it("the dashboard reads human-friendly shapes under RLS", async () => {
    const rooms = await listRoomsFor(alice.db, alice.user);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      name: "Prism",
      workspaceName: "A project",
      agentName: "A worker",
      jobs: { total: 1, open: 0, passed: 1 },
    });
    const jobs = await listRoomJobsFor(alice.db, alice.user, roomId);
    expect(jobs[0]).toMatchObject({ statusLabel: "Passed", review: "Round 1 of 2" });
    const detail = await getJobDetailFor(alice.db, alice.user, jobId);
    expect(detail?.nodes[0]).toMatchObject({ owner: "Codex", reviewer: "Claude" });
    expect(detail?.decisions[0].label).toMatch(/^TL-\d{5}$/);
  });

  describe("cross-account isolation", () => {
    it("another account's controller cannot see or use the room or job", async () => {
      expect(await listRooms(client, bob.chat.hmac, bob.chat.session)).toEqual([]);
      expect(await kindOf(getRoom(client, bob.chat.hmac, bob.chat.session, roomId))).toBe(
        "not_found",
      );
      expect(await kindOf(getTeamStatus(client, bob.chat.hmac, bob.chat.session, jobId))).toBe(
        "not_found",
      );
      expect(await kindOf(getTeamLog(client, bob.chat.hmac, bob.chat.session, jobId))).toBe(
        "not_found",
      );
      expect(
        await kindOf(
          startTeamJob(client, bob.chat.hmac, { sessionId: bob.chat.session, roomId, goal: "x" }),
        ),
      ).toBe("not_found");
    });

    it("another account's Runtime cannot write, even with the right claim ref", async () => {
      const job2 = await startTeamJob(client, alice.chat.hmac, {
        sessionId: alice.chat.session,
        roomId,
        goal: "Second goal",
      });
      jobId = job2.job.jobId;
      await claimTask(client, alice.runtime.hmac, job2.job.taskId, {
        sessionId: alice.runtime.session,
        claimRef,
      });
      expect(
        await kindOf(write("add_message", { sender: "codex", type: "proposal", body: "hi" }, bob)),
      ).toBe("not_found");
      // Bob's credential naming Alice's session: still not found.
      expect(
        await kindOf(
          writeTeamState(client, bob.runtime.hmac, jobId, {
            sessionId: alice.runtime.session,
            claimRef,
            op: "add_message",
            payload: { sender: "codex", type: "proposal", body: "hi" },
          }),
        ),
      ).toBe("not_found");
      // A controller credential cannot write team state at all.
      expect(
        await kindOf(
          writeTeamState(client, alice.chat.hmac, jobId, {
            sessionId: alice.chat.session,
            claimRef,
            op: "add_message",
            payload: { sender: "codex", type: "proposal", body: "hi" },
          }),
        ),
      ).toBe("forbidden");
    });

    it("RLS: the other account's dashboard sees none of it", async () => {
      expect(await listRoomsFor(bob.db, bob.user)).toEqual([]);
      expect(await getJobDetailFor(bob.db, bob.user, jobId)).toBeNull();
      const { data } = await bob.db.from("team_findings").select("id");
      expect(data).toEqual([]);
    });

    it("anon cannot read team tables directly", async () => {
      const { data, error } = await client.from("team_jobs").select("id");
      expect(error ?? data?.length === 0).toBeTruthy();
    });
  });

  describe("provider profiles", () => {
    it("paid usage is off by default and only the owner turns it on", async () => {
      await reportProviderDetection(client, alice.runtime.hmac, {
        provider: "codex",
        detected: { installed: true, authenticated: true, detectedPlan: "plus", version: "0.155" },
      });
      let profiles = await getProviderProfiles(client, alice.runtime.hmac);
      expect(profiles.find((p) => p.provider === "codex")?.paidUsageEnabled).toBe(false);
      expect(
        await kindOf(
          reportProviderDetection(client, alice.runtime.hmac, {
            provider: "codex",
            detected: { usage: { email: "alice@example.com" } },
          }),
        ),
      ).toBe("invalid");

      const owner = await setProviderProfileAs(alice.db, {
        provider: "codex",
        declaredPlan: "plus",
        paidUsageEnabled: true,
      });
      expect(owner.paidUsageEnabled).toBe(true);
      profiles = await getProviderProfiles(client, alice.runtime.hmac);
      expect(profiles.find((p) => p.provider === "codex")?.paidUsageEnabled).toBe(true);
      expect(
        (await listProviderProfilesFor(bob.db, bob.user)).every((p) => !p.paidUsageEnabled),
      ).toBe(true);
    });
  });

  it("deleting a room keeps the carrier task history", async () => {
    await expect(deleteRoomAs(bob.db, roomId)).rejects.toThrow();
    await deleteRoomAs(alice.db, roomId);
    expect(await listRooms(client, alice.chat.hmac, alice.chat.session)).toEqual([]);
    const carrier = await getTask(client, alice.chat.hmac, taskId, alice.chat.session);
    expect(carrier.status).toBe("claimed");
  });
});
