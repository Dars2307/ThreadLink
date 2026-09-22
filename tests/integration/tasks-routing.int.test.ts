import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/provision";
import {
  approvePairing,
  ClientOperationError,
  registerSession,
  requestPairing,
  revokePairing,
} from "@/lib/client-api/operations";
import {
  claimTask,
  completeTask,
  createTask,
  failTask,
  getTask,
  getTaskResult,
  listInbox,
  reportProgress,
  startTask,
} from "@/lib/client-api/tasks";
import { hashConnectionToken } from "@/lib/connections/credentials";
import { registerConnection } from "@/lib/connections/registration";
import { listRecentTasks } from "@/lib/tasks/queries";

import {
  admin,
  anonymousClient,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "./helpers";

/** Point-to-point routing through the real stack (app -> PostgREST -> DB functions + RLS). */

const A = uniqueClerkId("RouteA");
const B = uniqueClerkId("RouteB");
const client = anonymousClient();

type Party = { hmac: string; session: string };
let userA: ThreadLinkUser;
let userB: ThreadLinkUser;
let dbA: Awaited<ReturnType<typeof userClient>>;
let dbB: Awaited<ReturnType<typeof userClient>>;
let controller: Party;
let controller2: Party;
let agent: Party;
let agent2: Party;
let bobController: Party;
let bobAgent: Party;
let link: string;
let link2: string;
let bobLink: string;

async function party(
  db: typeof dbA,
  user: ThreadLinkUser,
  platform: "chatgpt" | "claude-code",
): Promise<Party> {
  const { credential } = await registerConnection(db, user, { platform }, TEST_CONNECTION_SECRET);
  const hmac = hashConnectionToken(credential.token, TEST_CONNECTION_SECRET);
  const { session } = await registerSession(client, hmac, {});
  return { hmac, session: session.sessionId };
}

async function pair(c: Party, g: Party): Promise<string> {
  const { linkId } = await requestPairing(client, c.hmac, {
    controllerSessionId: c.session,
    agentSessionId: g.session,
  });
  await approvePairing(client, g.hmac, { sessionId: g.session, linkId });
  return linkId;
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error instanceof ClientOperationError ? error.kind : "no-error";
}

const send = (from: Party, linkId: string, extra: Record<string, unknown> = {}) =>
  createTask(client, from.hmac, {
    originSessionId: from.session,
    threadLinkId: linkId,
    title: "Task",
    content: "Do the thing",
    ...extra,
  });

beforeAll(async () => {
  dbA = await userClient(A);
  dbB = await userClient(B);
  const none = { displayName: null, primaryEmail: null };
  userA = await provisionThreadLinkUser(identity(A), none, dbA);
  userB = await provisionThreadLinkUser(identity(B), none, dbB);
  controller = await party(dbA, userA, "chatgpt");
  controller2 = await party(dbA, userA, "chatgpt");
  agent = await party(dbA, userA, "claude-code");
  agent2 = await party(dbA, userA, "claude-code");
  bobController = await party(dbB, userB, "chatgpt");
  bobAgent = await party(dbB, userB, "claude-code");
  link = await pair(controller, agent);
  link2 = await pair(controller2, agent2);
  bobLink = await pair(bobController, bobAgent);
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("happy path: send -> inbox -> claim -> start -> progress -> complete -> result", () => {
  let taskId: string;

  it("controller sends; the link resolves the exact target", async () => {
    const { task, created } = await send(controller, link, {
      priority: "A1",
      idempotencyKey: "k-1",
    });
    taskId = task.taskId;
    expect(created).toBe(true);
    expect(task).toMatchObject({
      status: "queued",
      priority: "A1",
      targetSessionId: agent.session,
    });
  });

  it("only the exact agent session's inbox receives it", async () => {
    const inbox = await listInbox(client, agent.hmac, agent.session);
    expect(inbox.map((t) => t.taskId)).toEqual([taskId]);
    expect(inbox[0].content).toBe("Do the thing");
    expect(await listInbox(client, agent2.hmac, agent2.session)).toEqual([]);
    expect(await listInbox(client, bobAgent.hmac, bobAgent.session)).toEqual([]);
  });

  it("the agent claims, starts, reports progress and completes with an artifact", async () => {
    const claim = { sessionId: agent.session, claimRef: "worker-1" };
    expect((await claimTask(client, agent.hmac, taskId, claim)).status).toBe("claimed");
    expect((await startTask(client, agent.hmac, taskId, claim)).status).toBe("working");
    await reportProgress(client, agent.hmac, taskId, { ...claim, content: "halfway" });
    const done = await completeTask(client, agent.hmac, taskId, {
      ...claim,
      result: "Fixed in abc123",
      artifacts: [{ type: "git_commit", reference: "abc123" }],
    });
    expect(done.status).toBe("completed");
  });

  it("the result returns only to the originating controller session", async () => {
    const result = await getTaskResult(client, controller.hmac, taskId, controller.session);
    expect(result).toMatchObject({
      status: "completed",
      result: "Fixed in abc123",
      error: null,
      artifacts: [{ type: "git_commit", reference: "abc123" }],
    });
    expect(result.progress.map((p) => p.content)).toEqual(["halfway"]);
    expect(result.completedAt).not.toBeNull();

    expect(await kindOf(getTaskResult(client, controller2.hmac, taskId, controller2.session))).toBe(
      "not_found",
    );
    expect(await kindOf(getTaskResult(client, agent.hmac, taskId, agent.session))).toBe(
      "forbidden",
    );
    expect(
      await kindOf(getTaskResult(client, bobController.hmac, taskId, bobController.session)),
    ).toBe("not_found");
  });

  it("idempotency key returns the original task instead of a duplicate", async () => {
    const again = await send(controller, link, { idempotencyKey: "k-1", content: "other" });
    expect(again).toMatchObject({ created: false, task: { taskId } });
  });
});

describe("concurrency (PostgreSQL row locks, not application logic)", () => {
  it("simultaneous claims by different workers: exactly one owner", async () => {
    const { task } = await send(controller, link);
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimTask(client, agent.hmac, task.taskId, {
          sessionId: agent.session,
          claimRef: `worker-${i}`,
        }).then(
          (t) => ({ ok: true as const, claimRef: t.claimRef }),
          (e: unknown) => ({ ok: false as const, kind: (e as ClientOperationError).kind }),
        ),
      ),
    );
    const winners = attempts.filter((a) => a.ok);
    expect(winners).toHaveLength(1);
    expect(attempts.filter((a) => !a.ok).every((a) => !a.ok && a.kind === "conflict")).toBe(true);

    const winner = winners[0].ok ? winners[0].claimRef : null;
    const loser = `worker-${winner === "worker-0" ? 1 : 0}`;
    expect(
      await kindOf(
        completeTask(client, agent.hmac, task.taskId, {
          sessionId: agent.session,
          claimRef: loser,
          result: "x",
        }),
      ),
    ).toBe("conflict");
  });

  it("simultaneous creates with one idempotency key produce one task", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => send(controller, link, { idempotencyKey: "race-key" })),
    );
    expect(new Set(results.map((r) => r.task.taskId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});

describe("cross-user and cross-session denial", () => {
  it("wrong sender, wrong link and wrong role are denied without enumeration", async () => {
    expect(await kindOf(send(bobController, link))).toBe("not_found");
    expect(await kindOf(send(controller, bobLink))).toBe("not_found");
    expect(await kindOf(send(controller, link2))).toBe("not_found");
    expect(
      await kindOf(
        createTask(client, controller.hmac, {
          originSessionId: controller2.session,
          threadLinkId: link2,
          title: "t",
          content: "c",
        }),
      ),
    ).toBe("not_found");
    expect(await kindOf(send(agent, link))).toBe("forbidden");
  });

  it("other agents, other users and the controller cannot claim", async () => {
    const { task } = await send(controller, link);
    const claim = (p: Party) =>
      claimTask(client, p.hmac, task.taskId, { sessionId: p.session, claimRef: "w" });
    expect(await kindOf(claim(agent2))).toBe("not_found");
    expect(await kindOf(claim(bobAgent))).toBe("not_found");
    expect(await kindOf(claim(controller))).toBe("forbidden");
    expect(await kindOf(getTask(client, bobAgent.hmac, task.taskId, bobAgent.session))).toBe(
      "not_found",
    );
  });

  it("the dashboard shows each owner only their own tasks", async () => {
    const mine = await listRecentTasks(dbA, userA);
    expect(mine.length).toBeGreaterThan(0);
    expect(await listRecentTasks(dbB, userB)).toEqual([]);
    const messages = await dbB.from("messages").select("id");
    expect(messages.data).toEqual([]);
  });
});

describe("failure path and revocation", () => {
  it("fail returns the error to the origin", async () => {
    const { task } = await send(controller, link);
    const claim = { sessionId: agent.session, claimRef: "w-fail" };
    await claimTask(client, agent.hmac, task.taskId, claim);
    expect(
      (await failTask(client, agent.hmac, task.taskId, { ...claim, error: "boom" })).status,
    ).toBe("failed");
    const result = await getTaskResult(client, controller.hmac, task.taskId, controller.session);
    expect(result).toMatchObject({ status: "failed", error: "boom", result: null });
  });

  it("revoked before delivery: queued work is cancelled and never delivered", async () => {
    const { task: queued } = await send(controller, link);
    const { task: inFlight } = await send(controller, link);
    const claim = { sessionId: agent.session, claimRef: "w-rev" };
    await claimTask(client, agent.hmac, inFlight.taskId, claim);

    await revokePairing(client, controller.hmac, { sessionId: controller.session, linkId: link });

    expect(await listInbox(client, agent.hmac, agent.session)).toEqual([]);
    expect(
      await kindOf(
        claimTask(client, agent.hmac, queued.taskId, { sessionId: agent.session, claimRef: "w" }),
      ),
    ).toBe("conflict");
    expect(
      await kindOf(completeTask(client, agent.hmac, inFlight.taskId, { ...claim, result: "late" })),
    ).toBe("conflict");
    const status = await getTaskResult(client, controller.hmac, queued.taskId, controller.session);
    expect(status).toMatchObject({ status: "cancelled", cancelReason: "link_revoked" });
    expect(await kindOf(send(controller, link))).toBe("not_found");
  });

  it("revoked after completion: history stays readable to the origin only", async () => {
    const history = await listRecentTasks(dbA, userA);
    const completed = history.find((t) => t.status === "completed")!;
    const result = await getTaskResult(
      client,
      controller.hmac,
      completed.taskId,
      controller.session,
    );
    expect(result.result).toBe("Fixed in abc123");
    const agentView = await getTask(client, agent.hmac, completed.taskId, agent.session);
    expect(agentView.content).toBeNull();
  });
});
