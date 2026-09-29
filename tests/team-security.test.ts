import { describe, expect, it } from "vitest";

import { providerDetectionSchema } from "@/lib/team/client-api";
import {
  startTeamJobInputSchema,
  teamStatusRowSchema,
  teamWriteOpSchema,
  teamWriteRequestSchema,
  toSqlPayload,
} from "@/lib/team/model";
import { createTaskInputSchema } from "@/lib/tasks/model";

/**
 * Adversarial review of the Team Mode server boundary (zod layer).
 *
 * `it` pins down what was checked and found sound; `it.fails` documents a
 * weakness that is not fixed yet (it asserts the safe behaviour and currently
 * fails). The SQL layer is reviewed in supabase/tests/database/012_team_security.test.sql.
 */

const SESSION = `tlses_${"a".repeat(32)}`;
const ROOM = `tlrom_${"b".repeat(32)}`;

describe("runtime write envelope", () => {
  it("refuses unknown envelope keys, a malformed session or claim ref, and unknown ops", () => {
    const ok = { sessionId: SESSION, claimRef: "runtime-1", op: "set_status", payload: {} };
    expect(teamWriteRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, ownerUserId: "x" },
      { ...ok, sessionId: "tlses_../../x" },
      { ...ok, claimRef: "a b" },
      { ...ok, claimRef: "" },
      { ...ok, claimRef: "x".repeat(129) },
    ]) {
      expect(teamWriteRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(teamWriteOpSchema.safeParse({ op: "drop_tables", payload: {} }).success).toBe(false);
  });

  it("never lets a node be reviewed by its own author, nor a status claim a verdict", () => {
    expect(
      teamWriteOpSchema.safeParse({
        op: "upsert_nodes",
        payload: { nodes: [{ key: "a", title: "A", owner: "codex", reviewer: "codex" }] },
      }).success,
    ).toBe(false);
    // 0.11: "completed" / "failed" pass the wire for a Fast Chat job (no verdict);
    // the database refuses them for a work job (pgTAP 020). Verdict statuses never pass.
    for (const status of ["needs_fix", "blocked", "needs_user_decision", "review_pending"]) {
      expect(
        teamWriteOpSchema.safeParse({ op: "set_status", payload: { status } }).success,
        status,
      ).toBe(false);
    }
  });

  it("refuses path-like node keys and oversized bodies", () => {
    for (const key of ["../x", "a/b", "-rf", "", "x".repeat(65)]) {
      expect(
        teamWriteOpSchema.safeParse({ op: "set_node_status", payload: { key, status: "running" } })
          .success,
        key,
      ).toBe(false);
    }
    expect(
      teamWriteOpSchema.safeParse({
        op: "add_message",
        payload: { sender: "codex", type: "review", body: "é".repeat(4097) },
      }).success,
    ).toBe(false);
  });

  it("a snapshot upsert that omits the reviewer sends NO reviewer (the SQL then clears it)", () => {
    // Documents the mechanism behind the approved-node finding in 012 (8c).
    const op = teamWriteOpSchema.parse({
      op: "upsert_nodes",
      payload: { nodes: [{ key: "a", title: "A", owner: "codex", status: "approved" }] },
    });
    const sql = toSqlPayload(op) as { nodes: Record<string, unknown>[] };
    expect(sql.nodes[0]).not.toHaveProperty("reviewer_provider");
    expect(sql.nodes[0]!.status).toBe("approved");
  });
});

describe("provider detection reports", () => {
  const report = (detected: Record<string, unknown>) =>
    providerDetectionSchema.safeParse({ provider: "codex", detected });

  it("accepts exactly the documented keys and refuses credential-shaped ones", () => {
    expect(report({ installed: true, authenticated: true, authMethod: "chatgpt" }).success).toBe(
      true,
    );
    expect(report({ installed: true, executable: "C:\\Users\\alice\\codex.exe" }).success).toBe(
      false,
    );
    expect(report({ usage: { accessToken: "x" } }).success).toBe(false);
    expect(report({ models: [{ id: "m", email: "a@b.c" }] }).success).toBe(false);
    expect(report({ capabilities: { supportsFork: "yes" } }).success).toBe(false);
  });

  it("refuses a credential-shaped key at ANY depth (the JS check stops at depth 8; only SQL catches deeper)", () => {
    let deep: Record<string, unknown> = { apiKey: "sk-x" };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    expect(report({ usage: deep }).success).toBe(false);
  });

  it("refuses identity data that is not in the key blocklist (orgName, accountUuid, e-mail values)", () => {
    expect(report({ usage: { orgName: "Acme Corp" } }).success).toBe(false);
    expect(report({ models: [{ id: "m", owner: "alice@example.com" }] }).success).toBe(false);
    expect(report({ authMethod: "alice@example.com" }).success).toBe(false);
  });
});

describe("controller inputs", () => {
  it("bounds verify commands to 10 single lines of at most 300 characters", () => {
    const base = { sessionId: SESSION, roomId: ROOM, goal: "Do it" };
    for (const cmds of [
      ["npm test\nrm -rf ~"],
      ["npm test\r"],
      ["a\u0000b"],
      Array(11).fill("npm test"),
      ["x".repeat(301)],
      [""],
    ]) {
      expect(startTeamJobInputSchema.safeParse({ ...base, verifyCommands: cmds }).success).toBe(
        false,
      );
    }
  });

  it("a controller cannot create a task typed as a team job through the ordinary task API", () => {
    const parsed = createTaskInputSchema.safeParse({
      originSessionId: SESSION,
      threadLinkId: `tllnk_${"c".repeat(32)}`,
      title: "forged",
      content: JSON.stringify({ kind: "threadlink.team_job", version: 1 }),
      taskType: "team",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("status rows", () => {
  const row = {
    job_id: `tljob_${"d".repeat(32)}`,
    room_id: ROOM,
    room_name: "Prism",
    task_id: "tltsk_x",
    task_status: "working",
    status: "planning",
    verdict: null,
    line: null,
    summary: null,
    goal: "g",
    rounds: { planning: { n: 1, max: 2 }, review: { n: 0, max: 3 } },
    parallel_agents: 2,
    plan_hash: "f".repeat(64),
    nodes_total: 0,
    nodes: [],
    open_findings: { blocking: 0, important: 0, non_blocking: 0 },
    decisions_needing_user: 0,
    created_at: "t",
    updated_at: "t",
    finished_at: null,
  };

  it("parses the row the database returns for a plan that is stored but not approved", () => {
    // team_status_json: `plan_hash is not null and plan_approved_hash = plan_hash`
    // is SQL NULL (JSON null), not false, when plan_approved_hash is null.
    expect(teamStatusRowSchema.safeParse({ ...row, plan_approved: null }).success).toBe(true);
  });
});
