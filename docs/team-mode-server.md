# Team Mode: server surface

The contract is [`docs/design/team-mode.md`](design/team-mode.md). This page covers what the server
implements: the schema, who can call what, and the exact wire shapes the Runtime uses.

Migration: `supabase/migrations/20260925000100_team_mode.sql`. Tests:
`supabase/tests/database/011_team_mode.test.sql`, `tests/team-server.test.ts`,
`tests/integration/team-mode.int.test.ts`.

## Trust model

| Caller                    | Authenticates with                                                     | Grants               |
| ------------------------- | ---------------------------------------------------------------------- | -------------------- |
| Controller (ChatGPT, MCP) | connection credential + its own controller `tlses_`                    | `anon` only          |
| Runtime                   | agent credential + agent `tlses_` + **the carrier task's `claim_ref`** | `anon` only          |
| Owner (dashboard)         | Clerk session (`authenticated`)                                        | `authenticated` only |

Every function is revoked from `public, anon, authenticated` first and then granted to exactly one
role, because Supabase grants new `public` functions to `authenticated` by default. A signed-in
dashboard user cannot call a controller or Runtime RPC, and `anon` cannot call an owner RPC. pgTAP
checks both with `has_function_privilege`.

A team job is carried by an ordinary task (`task_type = 'team'`), so routing, the lease,
acknowledgement and notifications apply unchanged. **Every Runtime write goes through
`require_claimed_task`**: only the agent session that holds the carrier's claim, with its
`claim_ref`, may write. Another session gets "not found". A wrong or missing claim gets
"conflict". IDs from another account, room or chat all look like IDs that do not exist.

## Tables

| Table                                                                    | Holds                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rooms`                                                                  | name, workspace, agent session, policy (budgets, usage policy, cross review, final inspection, verify commands), status            |
| `room_agents`                                                            | providers in a room, friendly name, default roles                                                                                  |
| `team_jobs`                                                              | goal, controller spec, stored spec, plan and hashes, status and line, verdict, evidence, round counters and budgets                |
| `team_nodes`                                                             | DAG node: owner and reviewer (a CHECK makes them differ), `depends_on` keys, scope, files, branch, authorship, status              |
| `team_messages`, `team_findings`, `team_decisions`, `model_usage_events` | the structured log. Bodies are limited to 8 KB. Decisions are numbered per owner and shown as `TL-%05d`                            |
| `provider_profiles`                                                      | declared plan, usage policy, `paid_usage_enabled` (default **false**), `detected` jsonb. No column for email, org ID, token or key |

RLS is enabled on all of them. The owner gets `select` only. There are no client write grants.

## Controller RPCs and MCP tools

| MCP tool          | RPC               | Notes                                                                                                                                                                              |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_rooms`      | `list_rooms`      | rooms that are not deleted                                                                                                                                                         |
| `create_room`     | `create_room`     | binds to the workspace of the agent the caller's active link points at. With several links it returns `choose_link`. Calling it again with the same name returns the existing room |
| `get_room`        | `get_room`        | agents, policy, recent jobs                                                                                                                                                        |
| `start_team_job`  | `start_team_job`  | creates the carrier task (via `create_task`) and the job in one transaction. Out-of-range budgets are clamped. The idempotency key replays                                         |
| `get_team_status` | `get_team_status` | **concise**: phase, `n/max` rounds, at most 20 nodes, open finding counts                                                                                                          |
| `get_team_log`    | `get_team_log`    | full log, `offset`/`limit` (at most 100), oldest first                                                                                                                             |

Only the controller session that started a job can read that job.

### Carrier task content

`start_team_job` builds this JSON on the server and stores it as the task content:

```json
{
  "kind": "threadlink.team_job",
  "version": 1,
  "jobId": "tljob_…",
  "roomId": "tlrom_…",
  "roomName": "Prism",
  "goal": "…",
  "spec": { "requirements": ["…"] },
  "budgets": { "maxPlanningRounds": 2, "maxReviewRounds": 3, "parallelAgents": 2 },
  "policy": {
    "usagePolicy": "balanced",
    "paidUsage": false,
    "crossReview": true,
    "finalInspection": true,
    "worktreeIsolation": true,
    "overrides": []
  },
  "agents": [{ "provider": "claude-code", "displayName": "Claude", "roles": ["planner", "…"] }],
  "verifyCommands": ["npm test"]
}
```

The controller can supply `goal`, `spec` (the nine list fields), budgets and `verifyCommands`. The
limit is 10 commands, each at most 300 characters on one line. `paidUsage` is true only when
**every** enabled agent's provider profile has paid usage switched on by the owner. The controller
cannot set it.

## Runtime endpoints

`GET /api/team/providers` returns `{profiles}`: the owner's plan, policy and paid usage for each
provider.

`POST /api/team/providers` with `{provider, detected}` reports discovery results. Only these keys
are accepted: `installed`, `version`, `authenticated`, `authMethod`, `detectedPlan`, `models`,
`currentModel`, `capabilities`, `usage` and `detectedAt`. Any key at any depth that looks like
email, org, token, secret, password, API key, credential or cookie is refused. This call never
changes plan, policy or paid usage.

### `POST /api/team/jobs/[jobId]/state`

The request body is `{"sessionId": "tlses_…", "claimRef": "…", "op": "<op>", "payload": {…}}`, up
to 160 KB. The route validates it with zod (`lib/team/model.ts`), translates it to the SQL payload
and calls `team_job_write`, which validates everything again.

A successful call returns the concise status: `jobId`, `status`, `verdict`, `line`, `rounds`,
`nodes`, `openFindings`, `planHash`, `planApproved` and more. It also includes whatever the call
created: `findingId`, `decisionId` with `decisionNumber` and `decisionLabel`, `messageId`,
`usageEventId`, or `round` with `roundOpened`.

Errors are generic: `401`, `400 invalid`, `404 not_found`, `409 conflict` (a rule refused the write),
`413 too_large` or `429 limit` (a budget is exhausted).

| op                   | payload                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_spec`           | `{spec: TeamSpec}`: `goal` plus the nine list fields. **Stored once**: a different spec later is a conflict                                                                                                                                                                                                                                                                                   |
| `set_plan`           | `{plan: object ≤64 KB, planHash?: hex64, approvedBy?: provider[], round?}`. The server computes its own `plan_hash` (sha256 of the stored JSON) and returns it. The Runtime's `planHash` is kept as evidence. A non-empty `approvedBy` approves **this exact** plan, and any later edit drops the approval                                                                                    |
| `upsert_nodes`       | `{nodes: [{key, title, scope?, files?, dependsOn?, owner, reviewer?, status?, description?, worktreeBranch?}] (≤100), decisionNumber?}`. `owner ≠ reviewer` is enforced. Unknown dependencies and cycles are refused. Changing an existing node's owner needs `decisionNumber`. A node cannot be _made_ `approved`/`integrated` here, but a snapshot may repeat the status a node already has |
| `set_node_status`    | `{key, status, authorship?: single\|mixed, worktreeBranch?}`. `approved`/`integrated` need a reviewer and no open blocking/important finding on the node. `running` moves the job to `building`                                                                                                                                                                                               |
| `add_message`        | `{sender: provider\|threadlink, receiver?, senderRole?, node?, type, round?, body ≤8 KB}`                                                                                                                                                                                                                                                                                                     |
| `add_finding`        | `{node?, round?, phase?: planning\|review\|inspection, severity, category, summary ≤200, detail?, file?, line?, raisedBy}` returns `findingId`                                                                                                                                                                                                                                                |
| `set_finding_status` | `{findingId, status: open\|resolved\|wont_fix, round?, resolution?, decisionNumber?}`. The finding must belong to this job. **`wont_fix` on a blocking or important finding requires `decisionNumber`**                                                                                                                                                                                       |
| `add_decision`       | `{topic, resolution?, approvedBy?, evidence?, proposals?, basis?, needsUser?}` returns `decisionNumber` and `decisionLabel`                                                                                                                                                                                                                                                                   |
| `open_round`         | `{kind: planning\|review, round?, node?}`. Refused past the budget (`429`). A `round` that is already open is a no-op, so retries are safe                                                                                                                                                                                                                                                    |
| `record_usage`       | `{provider, role, node?, requestedModel, observedModel?, effort?, modelClass, reason, escalatedFrom?, escalationReason?, outcome, inputTokens?, outputTokens?}`                                                                                                                                                                                                                               |
| `set_status`         | `{status, line? ≤200 chars, one line}`. Only `normalising`…`inspecting` and `cancelled` are allowed. Verdict statuses are refused                                                                                                                                                                                                                                                             |
| `set_final`          | `{verdict, summary?, evidence: object ≤32 KB}`. **PASS is refused** if any blocking or important finding is open, any node failed, any node is unfinished, the plan changed after approval, or a decision is waiting for the user                                                                                                                                                             |

After a verdict or a cancel, a job accepts no more writes. If the carrier task fails, expires or is
cancelled (for example because its link was revoked), the job becomes `failed` or `cancelled`.
Writes to a job in a deleted room are refused.

## Owner operations (`lib/rooms`, `lib/providers`, `lib/team/owner.ts`)

- `rename_room`, `archive_room(p_archived)`, `update_room_policy`.
- `delete_room`: sets the status to `deleted` and detaches the room from its agent. It cancels the
  room's open jobs. It **never** touches repository files or carrier tasks.
- `set_provider_profile(provider, plan?, policy?, paidUsageEnabled?)`: `null` leaves a field
  unchanged. This is the only way to turn paid usage on.
- `remove_conversation(session)`: retires the binding, which revokes its links and cancels their
  open tasks. It returns `native_history_deleted: false` because ThreadLink never had that history
  and cannot delete it.

The dashboard read functions (`lib/rooms/queries.ts` `listRoomsFor` and `lib/team/queries.ts`
`listRoomJobsFor`/`getJobDetailFor`) return names, labels ("Round 2 of 3", "Needs your decision",
`TL-00042`) and counts. They use RLS and re-check the owner on every row.
