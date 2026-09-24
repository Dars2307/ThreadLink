import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionThreadLinkUser } from "@/lib/auth/provision";
import { registerConnection } from "@/lib/connections/registration";

import {
  admin,
  identity,
  TEST_CONNECTION_SECRET,
  uniqueClerkId,
  userClient,
} from "../integration/helpers";

/** HTTP e2e for task routing against a real Next.js server (:3200, LOCAL Supabase). */
const BASE_URL = process.env.THREADLINK_E2E_BASE_URL ?? "http://localhost:3200";
const A = uniqueClerkId("E2ETask");
const B = uniqueClerkId("E2ETaskB");

type Party = { token: string; session: string };
let controller: Party;
let agent: Party;
let otherAgent: Party;
let linkId: string;

async function api(
  path: string,
  token: string | null,
  init: { method?: "GET" | "POST"; body?: unknown; raw?: string } = {},
) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    redirect: "manual",
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function party(sub: string, platform: "chatgpt" | "claude-code"): Promise<Party> {
  const db = await userClient(sub);
  const user = await provisionThreadLinkUser(
    identity(sub),
    { displayName: null, primaryEmail: null },
    db,
  );
  const token = (await registerConnection(db, user, { platform }, TEST_CONNECTION_SECRET))
    .credential.token;
  const res = await api("/api/session/register", token, { method: "POST", body: {} });
  return { token, session: (res.json.session as { sessionId: string }).sessionId };
}

beforeAll(async () => {
  if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
    throw new Error("e2e must target a local server");
  }
  if (!(await fetch(BASE_URL).catch(() => null))) {
    throw new Error("Start the server first: npm run dev:local-db");
  }
  controller = await party(A, "chatgpt");
  agent = await party(A, "claude-code");
  otherAgent = await party(B, "claude-code");
  const req = await api("/api/pairing/request", controller.token, {
    method: "POST",
    body: { controllerSessionId: controller.session, agentSessionId: agent.session },
  });
  linkId = req.json.linkId as string;
  await api("/api/pairing/approve", agent.token, {
    method: "POST",
    body: { sessionId: agent.session, linkId },
  });
});

afterAll(async () => {
  await admin.from("users").delete().in("clerk_user_id", [A, B]);
});

describe("task routing over HTTP", () => {
  let taskId: string;
  const T0 = "tltask_00000000000000000000000000000000";

  it("every task route rejects missing and random credentials with a generic 401", async () => {
    const random = `tlc_${Buffer.alloc(32, 5).toString("base64url")}`;
    const routes: [string, "GET" | "POST"][] = [
      ["/api/tasks", "POST"],
      [`/api/tasks/inbox?sessionId=${agent.session}`, "GET"],
      [`/api/tasks/${T0}?sessionId=${agent.session}`, "GET"],
      [`/api/tasks/${T0}/claim`, "POST"],
      [`/api/tasks/${T0}/start`, "POST"],
      [`/api/tasks/${T0}/progress`, "POST"],
      [`/api/tasks/${T0}/complete`, "POST"],
      [`/api/tasks/${T0}/fail`, "POST"],
      [`/api/tasks/${T0}/result?sessionId=${controller.session}`, "GET"],
    ];
    for (const [path, method] of routes) {
      for (const token of [null, random]) {
        const res = await api(path, token, { method, body: method === "POST" ? {} : undefined });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.json).toEqual({ error: "unauthorized" });
      }
    }
  });

  it("controller creates a task; target comes from the link", async () => {
    const res = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "Run tests",
        content: "npm test",
        priority: "A1",
        idempotencyKey: "http-1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: true, task: { status: "queued", priority: "A1" } });
    const task = res.json.task as { taskId: string; targetSessionId: string };
    expect(task.targetSessionId).toBe(agent.session);
    taskId = task.taskId;

    const replay = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "x",
        content: "y",
        idempotencyKey: "http-1",
      },
    });
    expect(replay.json).toMatchObject({ created: false, task: { taskId } });
  });

  it("rejects caller-supplied targets and oversized payloads", async () => {
    const withTarget = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "t",
        content: "c",
        targetSessionId: otherAgent.session,
      },
    });
    expect(withTarget.status).toBe(400);
    const huge = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "t",
        content: "x".repeat(90 * 1024),
      },
    });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "too_large" });
  });

  it("agent polls, claims, works and completes; another user's agent sees nothing", async () => {
    const inbox = await api(`/api/tasks/inbox?sessionId=${agent.session}`, agent.token);
    expect((inbox.json.tasks as { taskId: string }[]).map((t) => t.taskId)).toEqual([taskId]);

    const foreign = await api(`/api/tasks/${taskId}/claim`, otherAgent.token, {
      method: "POST",
      body: { sessionId: otherAgent.session, claimRef: "w" },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });

    const controllerClaim = await api(`/api/tasks/${taskId}/claim`, controller.token, {
      method: "POST",
      body: { sessionId: controller.session, claimRef: "w" },
    });
    expect(controllerClaim.status).toBe(403);

    const claim = { sessionId: agent.session, claimRef: "bridge-1" };
    expect(
      (await api(`/api/tasks/${taskId}/claim`, agent.token, { method: "POST", body: claim })).json
        .status,
    ).toBe("claimed");
    const second = await api(`/api/tasks/${taskId}/claim`, agent.token, {
      method: "POST",
      body: { ...claim, claimRef: "bridge-2" },
    });
    expect(second.status).toBe(409);
    await api(`/api/tasks/${taskId}/start`, agent.token, { method: "POST", body: claim });
    await api(`/api/tasks/${taskId}/progress`, agent.token, {
      method: "POST",
      body: { ...claim, content: "running" },
    });
    const done = await api(`/api/tasks/${taskId}/complete`, agent.token, {
      method: "POST",
      body: {
        ...claim,
        result: "42 passed",
        artifacts: [{ type: "test_report", reference: "vitest: 42 passed" }],
      },
    });
    expect(done.json.status).toBe("completed");
  });

  it("result is returned to the origin controller only", async () => {
    const result = await api(
      `/api/tasks/${taskId}/result?sessionId=${controller.session}`,
      controller.token,
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      status: "completed",
      result: "42 passed",
      artifacts: [{ type: "test_report", reference: "vitest: 42 passed" }],
    });
    const byAgent = await api(
      `/api/tasks/${taskId}/result?sessionId=${agent.session}`,
      agent.token,
    );
    expect(byAgent.status).toBe(403);
    const byOther = await api(
      `/api/tasks/${taskId}/result?sessionId=${otherAgent.session}`,
      otherAgent.token,
    );
    expect([403, 404]).toContain(byOther.status);
  });

  /**
   * Blocked is not an outcome: the agent is saying "I am alive but cannot
   * proceed". The claim and the lease have to survive it, or the work is lost
   * the moment Claude asks the user a question. These run before revocation,
   * which tears the link down.
   */
  it("keeps its claim, and only the agent holding that claim may say so", async () => {
    const created = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "Needs permission",
        content: "edit the file",
        idempotencyKey: `blocked-${Date.now()}`,
      },
    });
    const blockedTask = (created.json.task as { taskId: string }).taskId;
    const claimRef = "worker-blocked";
    expect(
      (
        await api(`/api/tasks/${blockedTask}/claim`, agent.token, {
          method: "POST",
          body: { sessionId: agent.session, claimRef },
        })
      ).status,
    ).toBe(200);
    await api(`/api/tasks/${blockedTask}/start`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef },
    });

    // The controller cannot speak for the agent.
    const byController = await api(`/api/tasks/${blockedTask}/blocked`, controller.token, {
      method: "POST",
      body: { sessionId: controller.session, claimRef, reason: "approval_required" },
    });
    expect(byController.status).toBeGreaterThanOrEqual(400);

    // Nor can another agent that does not hold the claim.
    const byOther = await api(`/api/tasks/${blockedTask}/blocked`, otherAgent.token, {
      method: "POST",
      body: { sessionId: otherAgent.session, claimRef, reason: "approval_required" },
    });
    expect(byOther.status).toBeGreaterThanOrEqual(400);

    const reported = await api(`/api/tasks/${blockedTask}/blocked`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef, reason: "approval_required" },
    });
    expect(reported.status).toBe(200);

    // Still claimed by us: reporting a blockage must not release the work.
    const heartbeat = await api(`/api/tasks/${blockedTask}/heartbeat`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef },
    });
    expect(heartbeat.status).toBe(200);

    // And it can still be finished once the person answers.
    const done = await api(`/api/tasks/${blockedTask}/complete`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef, result: "done" },
    });
    expect(done.status).toBe(200);
  });

  it("refuses a reason it does not recognise", async () => {
    const created = await api("/api/tasks", controller.token, {
      method: "POST",
      body: {
        originSessionId: controller.session,
        threadLinkId: linkId,
        title: "Bad reason",
        content: "x",
        idempotencyKey: `bad-reason-${Date.now()}`,
      },
    });
    const id = (created.json.task as { taskId: string }).taskId;
    const claimRef = "worker-bad-reason";
    await api(`/api/tasks/${id}/claim`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef },
    });
    const res = await api(`/api/tasks/${id}/blocked`, agent.token, {
      method: "POST",
      body: { sessionId: agent.session, claimRef, reason: "because_i_said_so" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("after revocation the link cannot send and queued work is not delivered", async () => {
    const queued = await api("/api/tasks", controller.token, {
      method: "POST",
      body: { originSessionId: controller.session, threadLinkId: linkId, title: "q", content: "q" },
    });
    const queuedId = (queued.json.task as { taskId: string }).taskId;
    await api("/api/pairing/revoke", controller.token, {
      method: "POST",
      body: { sessionId: controller.session, linkId },
    });
    const inbox = await api(`/api/tasks/inbox?sessionId=${agent.session}`, agent.token);
    expect(inbox.json.tasks).toEqual([]);
    const status = await api(
      `/api/tasks/${queuedId}?sessionId=${controller.session}`,
      controller.token,
    );
    expect(status.json).toMatchObject({ status: "cancelled", cancelReason: "link_revoked" });
    const send = await api("/api/tasks", controller.token, {
      method: "POST",
      body: { originSessionId: controller.session, threadLinkId: linkId, title: "t", content: "c" },
    });
    expect(send.status).toBe(404);
  });
});

describe("every task route fails closed before it reads a body", () => {
  /**
   * A body parsed before authentication is two problems: an unauthenticated
   * caller can make the server throw (500 rather than 401), and the different
   * error tells them something the uniform 401 deliberately does not.
   */
  const SUBROUTES = [
    "claim",
    "start",
    "progress",
    "heartbeat",
    "complete",
    "fail",
    "blocked",
    "acknowledge",
  ];

  it("answers 401 for a malformed body with no credential", async () => {
    for (const route of SUBROUTES) {
      const res = await api(`/api/tasks/tltask_deadbeef/${route}`, null, {
        method: "POST",
        raw: "not-json",
      });
      expect(res.status, `${route} with a malformed body`).toBe(401);
      expect(res.json, route).toMatchObject({ error: "unauthorized" });
    }
  });

  it("answers 401 for an oversized body with no credential", async () => {
    const huge = JSON.stringify({ sessionId: "x".repeat(200_000) });
    for (const route of ["acknowledge", "blocked"]) {
      const res = await api(`/api/tasks/tltask_deadbeef/${route}`, null, {
        method: "POST",
        raw: huge,
      });
      expect(res.status, `${route} with an oversized body`).toBe(401);
    }
  });

  it("gives an unknown task the same 401 as a real one, so ids cannot be probed", async () => {
    const unknown = await api("/api/tasks/tltask_deadbeef/acknowledge", null, {
      method: "POST",
      body: {},
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json).toMatchObject({ error: "unauthorized" });
  });
});
