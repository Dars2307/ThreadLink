import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ClientOperationError, type ClientDatabase } from "@/lib/client-api/operations";
import {
  conciseTeamStatus,
  createRoomTool,
  getTeamStatusTool,
  startTeamJobTool,
  toolInputs,
  type McpContext,
} from "@/lib/mcp/tools";
import { providerDetectionSchema, writeTeamState } from "@/lib/team/client-api";
import * as model from "@/lib/team/model";
import {
  decisionLabel,
  startTeamJobInputSchema,
  teamWriteOpSchema,
  toSqlPayload,
  toTeamStatus,
  type TeamStatusRow,
} from "@/lib/team/model";

import * as runtimeTypes from "../runtime/src/team/types";

const S = "tlses_00112233445566778899aabbccddeeff";
const JOB = "tljob_00112233445566778899aabbccddeeff";
const ROOM = "tlrom_00112233445566778899aabbccddeeff";
const L1 = "tllnk_00112233445566778899aabbccddeeff";
const L2 = "tllnk_ffeeddccbbaa99887766554433221100";
const HASH = "ab".repeat(32);

const statusRow = (over: Partial<TeamStatusRow> = {}): TeamStatusRow => ({
  job_id: JOB,
  room_id: ROOM,
  room_name: "Prism",
  task_id: "tltask_00112233445566778899aabbccddeeff",
  task_status: "claimed",
  status: "building",
  verdict: null,
  line: "Building api",
  summary: null,
  goal: "Add a health endpoint",
  rounds: { planning: { n: 1, max: 2 }, review: { n: 0, max: 3 } },
  parallel_agents: 2,
  plan_hash: null,
  plan_approved: false,
  nodes_total: 1,
  nodes: [{ key: "api", owner: "codex", reviewer: "claude-code", status: "running" }],
  open_findings: { blocking: 0, important: 1, non_blocking: 0 },
  decisions_needing_user: 0,
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
  finished_at: null,
  ...over,
});

function dbWith(responses: Record<string, unknown>) {
  const rpc = vi.fn<ClientDatabase["rpc"]>(async (fn) => ({
    data: responses[fn] ?? null,
    error: null,
  }));
  return { db: { rpc } as ClientDatabase, rpc };
}

function ctxWith(responses: Record<string, unknown>) {
  const { db, rpc } = dbWith(responses);
  const ctx: McpContext = {
    db,
    credentialHash: HASH,
    identity: {
      connectionId: "tlcon_00112233445566778899aabbccddeeff",
      ownerUserId: "tlusr_00112233445566778899aabbccddeeff",
      platform: "chatgpt",
      role: "controller",
      status: "active",
    },
  };
  return { ctx, rpc };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  return e instanceof ClientOperationError ? e.kind : "no-error";
}

// ---------------------------------------------------------------------------
describe("the server's enums are the Runtime's enums", () => {
  const pairs = [
    ["AGENT_PROVIDERS", model.AGENT_PROVIDERS, runtimeTypes.AGENT_PROVIDERS],
    ["TEAM_ROLES", model.TEAM_ROLES, runtimeTypes.TEAM_ROLES],
    ["ROOM_STATUSES", model.ROOM_STATUSES, runtimeTypes.ROOM_STATUSES],
    ["JOB_STATUSES", model.JOB_STATUSES, runtimeTypes.JOB_STATUSES],
    ["JOB_VERDICTS", model.JOB_VERDICTS, runtimeTypes.JOB_VERDICTS],
    ["NODE_STATUSES", model.NODE_STATUSES, runtimeTypes.NODE_STATUSES],
    ["MESSAGE_TYPES", model.MESSAGE_TYPES, runtimeTypes.MESSAGE_TYPES],
    ["FINDING_SEVERITIES", model.FINDING_SEVERITIES, runtimeTypes.FINDING_SEVERITIES],
    ["FINDING_CATEGORIES", model.FINDING_CATEGORIES, runtimeTypes.FINDING_CATEGORIES],
    ["FINDING_STATUSES", model.FINDING_STATUSES, runtimeTypes.FINDING_STATUSES],
    ["MODEL_CLASSES", model.MODEL_CLASSES, runtimeTypes.MODEL_CLASSES],
    ["USAGE_POLICIES", model.USAGE_POLICIES, runtimeTypes.USAGE_POLICIES],
    ["CLAUDE_PLANS", model.CLAUDE_PLANS, runtimeTypes.CLAUDE_PLANS],
    ["CHATGPT_PLANS", model.CHATGPT_PLANS, runtimeTypes.CHATGPT_PLANS],
    ["ARBITRATION_ORDER", model.ARBITRATION_ORDER, runtimeTypes.ARBITRATION_ORDER],
  ] as const;

  it.each(pairs)("%s", (_name, server, runtime) => {
    expect([...server]).toEqual([...runtime]);
  });

  it("budgets", () => {
    expect(model.TEAM_LIMITS).toEqual(runtimeTypes.TEAM_LIMITS);
  });

  // The migration's vocabulary functions and CHECK lists must say the same.
  const sql = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/20260925000100_team_mode.sql", import.meta.url)),
    "utf8",
  );
  const sqlList = (fn: string) => {
    const m = new RegExp(
      `function threadlink_private\\.${fn}\\(\\) returns text\\[\\][\\s\\S]*?select array\\[([\\s\\S]*?)\\]`,
    ).exec(sql);
    if (!m) throw new Error(`no ${fn} in migration`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  it.each([
    ["team_providers", model.AGENT_PROVIDERS],
    ["team_roles", model.TEAM_ROLES],
    ["team_job_statuses", model.JOB_STATUSES],
    ["team_verdicts", model.JOB_VERDICTS],
    ["team_node_statuses", model.NODE_STATUSES],
    ["team_message_types", model.MESSAGE_TYPES],
    ["team_finding_severities", model.FINDING_SEVERITIES],
    ["team_finding_categories", model.FINDING_CATEGORIES],
    ["team_finding_statuses", model.FINDING_STATUSES],
    ["team_model_classes", model.MODEL_CLASSES],
    ["team_usage_policies", model.USAGE_POLICIES],
    ["team_claude_plans", model.CLAUDE_PLANS],
    ["team_chatgpt_plans", model.CHATGPT_PLANS],
    ["team_arbitration_bases", model.ARBITRATION_ORDER],
  ] as const)("migration %s", (fn, list) => {
    expect(sqlList(fn)).toEqual([...list]);
  });
});

// ---------------------------------------------------------------------------
describe("runtime write operations (the Runtime's shapes)", () => {
  const ok = (op: unknown) => teamWriteOpSchema.safeParse(op).success;

  it("accepts every documented op", () => {
    expect(ok({ op: "set_spec", payload: { spec: { goal: "g", requirements: ["r"] } } })).toBe(
      true,
    );
    expect(
      ok({
        op: "set_plan",
        payload: {
          plan: { summary: "s", nodes: [], risks: [] },
          planHash: "a".repeat(64),
          approvedBy: ["codex"],
          round: 1,
        },
      }),
    ).toBe(true);
    expect(
      ok({
        op: "upsert_nodes",
        payload: {
          nodes: [
            {
              key: "api",
              title: "API",
              scope: "app/api",
              files: ["app/api/**"],
              dependsOn: [],
              owner: "codex",
              reviewer: "claude-code",
              status: "pending",
            },
          ],
        },
      }),
    ).toBe(true);
    expect(ok({ op: "set_node_status", payload: { key: "api", status: "running" } })).toBe(true);
    expect(
      ok({
        op: "add_message",
        payload: { sender: "codex", receiver: "threadlink", type: "review", round: 1, body: "b" },
      }),
    ).toBe(true);
    expect(
      ok({
        op: "add_finding",
        payload: {
          node: null,
          round: 1,
          phase: "review",
          severity: "blocking",
          category: "security",
          summary: "s",
          detail: "d",
          file: "a.ts",
          line: 3,
          raisedBy: "claude-code",
        },
      }),
    ).toBe(true);
    expect(
      ok({
        op: "set_finding_status",
        payload: { findingId: "tlfnd_" + "0".repeat(32), status: "resolved", round: 2 },
      }),
    ).toBe(true);
    expect(
      ok({
        op: "add_decision",
        payload: {
          topic: "t",
          resolution: "r",
          approvedBy: ["codex"],
          evidence: {},
          needsUser: false,
        },
      }),
    ).toBe(true);
    expect(ok({ op: "open_round", payload: { kind: "review", round: 1, node: "api" } })).toBe(true);
    expect(
      ok({
        op: "record_usage",
        payload: {
          provider: "claude-code",
          role: "builder",
          requestedModel: "claude-sonnet-5",
          observedModel: null,
          effort: null,
          modelClass: "STRONG",
          reason: "default",
          escalatedFrom: null,
          escalationReason: null,
          outcome: "ok",
        },
      }),
    ).toBe(true);
    expect(ok({ op: "set_status", payload: { status: "building", line: "Building" } })).toBe(true);
    expect(
      ok({
        op: "set_final",
        payload: { verdict: "PASS", summary: "done", evidence: { commits: [], tests: [] } },
      }),
    ).toBe(true);
  });

  it("refuses a node reviewed by its own author", () => {
    expect(
      ok({
        op: "upsert_nodes",
        payload: { nodes: [{ key: "a", title: "A", owner: "codex", reviewer: "codex" }] },
      }),
    ).toBe(false);
  });

  it("set_status can never claim a verdict status", () => {
    for (const status of ["completed", "needs_fix", "blocked", "needs_user_decision", "failed"]) {
      expect(ok({ op: "set_status", payload: { status } })).toBe(false);
    }
  });

  it("refuses unknown ops, unknown keys, bad enums and multi-line status lines", () => {
    expect(ok({ op: "drop", payload: {} })).toBe(false);
    expect(
      ok({ op: "add_message", payload: { sender: "codex", type: "review", body: "b", x: 1 } }),
    ).toBe(false);
    expect(ok({ op: "add_message", payload: { sender: "gpt", type: "review", body: "b" } })).toBe(
      false,
    );
    expect(ok({ op: "set_status", payload: { status: "building", line: "a\nb" } })).toBe(false);
    expect(ok({ op: "set_spec", payload: { spec: { password: ["x"] } } })).toBe(false);
  });

  it("translates to the strict SQL payload", () => {
    const finding = teamWriteOpSchema.parse({
      op: "add_finding",
      payload: {
        node: "api",
        round: 1,
        phase: "review",
        severity: "important",
        category: "tests",
        summary: "No test",
        detail: "  ",
        file: "a.ts",
        line: 7,
        raisedBy: "codex",
      },
    });
    expect(toSqlPayload(finding)).toEqual({
      node_key: "api",
      severity: "important",
      category: "tests",
      title: "No test",
      body: "No test",
      location: "a.ts:7",
      raised_by: "codex",
      round: 1,
      phase: "review",
    });
    const nodes = teamWriteOpSchema.parse({
      op: "upsert_nodes",
      payload: {
        nodes: [{ key: "t", title: "T", owner: "claude-code", reviewer: null, dependsOn: ["api"] }],
      },
    });
    expect(toSqlPayload(nodes)).toEqual({
      nodes: [{ key: "t", title: "T", owner_provider: "claude-code", depends_on: ["api"] }],
    });
    const plan = teamWriteOpSchema.parse({
      op: "set_plan",
      payload: { plan: { summary: "s" }, planHash: "b".repeat(64), approvedBy: ["codex"] },
    });
    expect(toSqlPayload(plan)).toEqual({
      plan: { summary: "s" },
      client_hash: "b".repeat(64),
      approved_by: ["codex"],
    });
  });
});

// ---------------------------------------------------------------------------
describe("writeTeamState", () => {
  const body = (op: string, payload: unknown) => ({
    sessionId: S,
    claimRef: "claim-1",
    op,
    payload,
  });

  it("sends the claim and the translated payload, and returns the new finding id", async () => {
    const { db, rpc } = dbWith({
      team_job_write: {
        ...statusRow(),
        op: "add_finding",
        result: { finding_id: "tlfnd_" + "1".repeat(32) },
      },
    });
    const result = await writeTeamState(
      db,
      HASH,
      JOB,
      body("add_finding", {
        severity: "blocking",
        category: "security",
        summary: "s",
        detail: "d",
        raisedBy: "codex",
      }),
    );
    expect(rpc).toHaveBeenCalledWith("team_job_write", {
      p_token_hash: HASH,
      p_session_id: S,
      p_job_id: JOB,
      p_claim_ref: "claim-1",
      p_op: "add_finding",
      p_payload: {
        severity: "blocking",
        category: "security",
        title: "s",
        body: "d",
        raised_by: "codex",
      },
    });
    expect(result.findingId).toBe("tlfnd_" + "1".repeat(32));
    expect(result.status).toBe("building");
    expect(result.openFindings.important).toBe(1);
  });

  it("labels decisions TL-%05d", async () => {
    const { db } = dbWith({
      team_job_write: {
        ...statusRow(),
        op: "add_decision",
        result: { decision_id: "tldec_" + "2".repeat(32), number: 42 },
      },
    });
    const result = await writeTeamState(db, HASH, JOB, body("add_decision", { topic: "REST" }));
    expect(result.decisionLabel).toBe("TL-00042");
    expect(decisionLabel(7)).toBe("TL-00007");
  });

  it("rejects before the database: oversized body, bad job id, bad claim, unknown op", async () => {
    const { db, rpc } = dbWith({});
    expect(
      await kindOf(
        writeTeamState(
          db,
          HASH,
          JOB,
          body("add_message", { sender: "codex", type: "review", body: "x".repeat(8193) }),
        ),
      ),
    ).toBe("too_large");
    expect(await kindOf(writeTeamState(db, HASH, "tltask_x", body("set_status", {})))).toBe(
      "invalid",
    );
    expect(
      await kindOf(
        writeTeamState(db, HASH, JOB, {
          ...body("set_status", { status: "building" }),
          claimRef: "",
        }),
      ),
    ).toBe("invalid");
    expect(await kindOf(writeTeamState(db, HASH, JOB, body("drop_tables", {})))).toBe("invalid");
    expect(
      await kindOf(
        writeTeamState(db, HASH, JOB, {
          ...body("set_status", { status: "building" }),
          ownerUserId: "x",
        }),
      ),
    ).toBe("invalid");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps database refusals to generic kinds", async () => {
    const rpc = vi.fn<ClientDatabase["rpc"]>(async () => ({
      data: null,
      error: { message: "PASS refused: open blocking or important findings", code: "55000" },
    }));
    expect(
      await kindOf(
        writeTeamState({ rpc }, HASH, JOB, body("set_final", { verdict: "PASS", evidence: {} })),
      ),
    ).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
describe("controller inputs", () => {
  it("bounds budgets and verify commands", () => {
    const base = { sessionId: S, roomId: ROOM, goal: "g" };
    expect(startTeamJobInputSchema.safeParse({ ...base, maxReviewRounds: 7 }).success).toBe(false);
    expect(startTeamJobInputSchema.safeParse({ ...base, parallelAgents: 0 }).success).toBe(false);
    expect(startTeamJobInputSchema.safeParse({ ...base, verifyCommands: ["a\nb"] }).success).toBe(
      false,
    );
    expect(
      startTeamJobInputSchema.safeParse({ ...base, verifyCommands: Array(11).fill("npm test") })
        .success,
    ).toBe(false);
    expect(startTeamJobInputSchema.safeParse({ ...base, spec: { goal: "dup" } }).success).toBe(
      false,
    );
    expect(
      startTeamJobInputSchema.safeParse({ ...base, spec: { requirements: ["r"] } }).success,
    ).toBe(true);
  });

  it("provider detection never carries identity or credentials", () => {
    expect(
      providerDetectionSchema.safeParse({ provider: "codex", detected: { detectedPlan: "plus" } })
        .success,
    ).toBe(true);
    expect(
      providerDetectionSchema.safeParse({
        provider: "claude-code",
        detected: { usage: { email: "a@b.c" } },
      }).success,
    ).toBe(false);
    expect(
      providerDetectionSchema.safeParse({ provider: "codex", detected: { orgId: "o" } }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Team Mode MCP tools", () => {
  const linkRow = (id: string, agent: string) => ({
    id,
    controller_session_id: S,
    agent_session_id: "tlses_ffeeddccbbaa99887766554433221100",
    controller_display_name: "Chat",
    agent_display_name: agent,
    status: "active",
    revoked_reason: null,
    requested_at: "2026-09-25T00:00:00Z",
    approved_at: "2026-09-25T00:00:00Z",
    revoked_at: null,
  });

  it("create_room asks the user to choose when several agents are linked", async () => {
    const { ctx, rpc } = ctxWith({
      list_session_links: [linkRow(L1, "Laptop"), linkRow(L2, "Desktop")],
    });
    const out = await createRoomTool(ctx, { sessionId: S, name: "Prism" });
    expect(out.status).toBe("choose_link");
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["list_session_links"]);
  });

  it("create_room uses the single active link", async () => {
    const { ctx, rpc } = ctxWith({
      list_session_links: [linkRow(L1, "Laptop")],
      create_room: {
        room_id: ROOM,
        name: "Prism",
        status: "active",
        workspace_id: "tlwsp_" + "0".repeat(32),
        workspace_name: "Prism",
        agent_session_id: "tlses_ffeeddccbbaa99887766554433221100",
        agent_name: "Prism worker",
        policy: {
          parallel_agents: 2,
          max_planning_rounds: 2,
          max_review_rounds: 3,
          usage_policy: "balanced",
          cross_review: true,
          final_inspection: true,
          worktree_isolation: true,
          verify_commands: [],
        },
        agents: [],
        open_jobs: 0,
        created_at: "2026-09-25T00:00:00Z",
        updated_at: "2026-09-25T00:00:00Z",
        created: true,
      },
    });
    const out = await createRoomTool(ctx, { sessionId: S, name: "Prism" });
    expect(out).toMatchObject({ status: "created", room: { roomId: ROOM, workspace: "Prism" } });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_thread_link_id: L1, p_name: "Prism" });
  });

  it("get_team_status is concise", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      key: `n${i}`,
      owner: "codex" as const,
      reviewer: "claude-code" as const,
      status: "pending" as const,
    }));
    const { ctx } = ctxWith({
      get_team_status: statusRow({ nodes: many, nodes_total: 60 }),
    });
    const out = await getTeamStatusTool(ctx, { sessionId: S, jobId: JOB });
    expect(out.nodes).toHaveLength(20);
    expect(out.moreNodes).toBe(40);
    expect(out.review).toBe("0/3");
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    expect(out).not.toHaveProperty("evidence");
  });

  it("start_team_job passes only the controller's fields", async () => {
    const { ctx, rpc } = ctxWith({ start_team_job: { ...statusRow(), created: true } });
    const out = await startTeamJobTool(ctx, {
      sessionId: S,
      roomId: ROOM,
      goal: "Add a health endpoint",
    });
    expect(out.jobId).toBe(JOB);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_room_id: ROOM,
      p_goal: "Add a health endpoint",
      // Test commands come only from the owner's project settings: ThreadLink
      // runs them outside any sandbox, so a chat cannot supply them.
      p_verify_commands: null,
      p_spec: null,
    });
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_paid_usage");
  });

  it("tool input schemas are bounded", () => {
    const start = z.object(toolInputs.start_team_job);
    expect(
      start.safeParse({ sessionId: S, roomId: ROOM, goal: "g", maxPlanningRounds: 6 }).success,
    ).toBe(false);
    const log = z.object(toolInputs.get_team_log);
    expect(log.safeParse({ sessionId: S, jobId: JOB, limit: 101 }).success).toBe(false);
    expect(z.object(toolInputs.get_room).safeParse({ sessionId: S, roomId: JOB }).success).toBe(
      false,
    );
  });

  it("conciseTeamStatus keeps the shape small", () => {
    const s = conciseTeamStatus(toTeamStatus(statusRow()));
    expect(Object.keys(s).sort()).toEqual(
      [
        "decisionsNeedingUser",
        "finished",
        "jobId",
        "line",
        "moreNodes",
        "nodes",
        "openFindings",
        "planning",
        "review",
        "room",
        "status",
        "summary",
        "verdict",
      ].sort(),
    );
  });
});
