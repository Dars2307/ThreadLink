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

## Collaboration chat (migration `20260926000100_collaboration_chat.sql`)

Contract: `docs/design/collaboration-chat.md`. Shared types: `lib/chat/types.ts`.

### The timeline: `public.chat_events`

No client role can insert, update or delete a row. Rows come only from `SECURITY DEFINER`
triggers on `tasks`, `messages`, `team_jobs`, `team_nodes`, `team_messages`, `team_findings`,
`team_decisions` and `model_usage_events`, and from `post_chat_message` and `read_owner_notes`.
The author fields come from the parent row. Table constraints also enforce provenance, even for
a privileged writer:

- `author_provider` is set exactly on `agent` rows.
- The label `You` is used only by `owner` rows, and `ThreadLink` only by `threadlink` rows.
- Each author kind writes only its own event types.
- A body is 1 to 8192 bytes, and newline and tab are the only control characters allowed.

Every body passes through `threadlink_private.redact_text` before it is stored. It redacts
provider keys, bearer tokens, JWTs, `password=`/`token=`/`secret=`/`api_key=` assignments,
cookie headers, PEM private keys and `scheme://user:pass@` URLs.

A trigger never raises into its parent write. If a chat row cannot be written, the trigger emits
a warning with no content and skips the row.

### Owner RPC: `post_chat_message(p_room_id, p_body, p_mode?, p_builder?, p_idempotency_key?)`

- Callable by `authenticated` only.
- Returns `{routed, job_id, event_id, replayed?, mode?, builder?}`.
- Every failure carries a stable reason code in the error's `HINT`. `lib/chat/model.ts` maps the
  code to a sentence; database text is never shown.

### Owner route: `/api/dashboard/chat`

This route requires a Clerk session. It is not a connection route, and `proxy.ts` does not bypass
it.

- `GET ?room=&after=&technical=` returns a `ChatPage`.
- `POST {roomId, body, mode?, builder?, idempotencyKey?}` returns a `PostChatMessageResult`.

### Runtime additions

- **Start RPC:** `start_team_job` gains a 12-argument overload with `p_mode` and `p_builder` and no
  defaults. The original 10-argument signature is a wrapper that always starts Team Mode. Both
  overloads share `threadlink_private.team_start_job`, which the owner path also uses.
- **Carrier content:** the carrier gains `mode`, `builder`, `reviewer` and `origin`, and
  `version` stays `1`. `agents` lists only the job's participants.
- **Runtime versions:** solo and pair jobs need Runtime 0.8 or later. Team Mode needs 0.7 or
  later.
- **`team_job_write`:**
  - `add_message` accepts `model_observed`.
  - The new `read_owner_notes {limit?≤20}` op returns `result.notes`.
  - Every response includes `mode`, `builder`, `origin` and `stop_requested_at`.
- **`PATCH /api/team/providers {provider, declaredPlan}`:** calls `set_runtime_provider_plan`.
  This changes the declared plan only; the owner still controls policy and paid usage. Detection
  never changes `declared_plan`.

## Chat-first (migration `20260927000100_chat_first.sql`)

Contract: `docs/design/chat-first.md` (section 10 lists where the server is stricter).

- **Tables.** `chats` (`tlcht_`) and `chat_groups` (`tlgrp_`): RLS select-own, no client
  writes. `team_jobs` gains `chat_id`, `last_phase`, `role_overrides`, `verdict_provider` and
  `retried_from_job_id`; `tasks` and `chat_events` gain `chat_id` (copied by trigger from the
  job, else the task, else the project's default chat).
- **Owner RPCs** (`authenticated`): `create_chat`, `update_chat`, `set_chat_pinned`,
  `set_chat_archived`, `delete_chat`, `mark_chat_read`, `create_chat_group`,
  `rename_chat_group`, `delete_chat_group`,
  `post_chat_message(p_chat_id, p_body, p_idempotency_key)`, `retry_job_with_roles` and
  `chat_list_extras` (invoker, read-only).
- **Controller RPCs** (`anon` + credential): the 13-argument `start_team_job` overload with
  `p_chat_id`, and `create_chat_task` (send_to_agent in a chat).
- **Health gate.** Every job start needs each participant `ready` (a recent, authenticated,
  subscription check) as reported by the Runtime that owns the project's agent session
  (`public.runtime_provider_health`, per computer); refusals carry hint `provider_unhealthy`.
- **Runtime.** `report_provider_detection` accepts `health`, `healthCheckedAt` and
  `healthDetail`; `set_final` accepts `provider`; new verdict reasons `agent_needs_sign_in`
  and `api_key_auth`; the status JSON adds `chat_id`, `last_phase`, `role_overrides`,
  `verdict_reason`, `verdict_provider` and `retried_from_job_id`.
- **Routes.** `/api/dashboard/chat?chat=` (timeline by chat) and
  `POST {chatId, body, idempotencyKey?}`; `/api/dashboard/chats` (GET list, POST create);
  `/api/dashboard/chats/[chatId]` (GET, PATCH, DELETE); `/api/dashboard/chats/[chatId]/read`
  (POST); `/api/dashboard/chats/groups` (GET, POST); `/api/dashboard/chats/groups/[groupId]`
  (PATCH, DELETE). Errors are `{ok:false, reason, message}` with fixed sentences.

## ThreadLink 0.10 (migration `20260927000200_threadlink_0_10.sql`)

Contract: `docs/design/threadlink-0.10.md` (section 12 lists where the server differs).

- **Tables.** `agent_providers` (registry; RLS on, no policy: read through
  `agent_providers_list()` by anon and authenticated), `agent_runs` (`tlarn_`; select-own, every
  column except `native_session_id`), `user_choices` (`tlchc_`), `chat_artifacts` (`tlart_`).
  `chat_events` gains `chat_seq` (per chat, trigger-assigned), `run_id`, `reply_to_event_id`,
  `ref_kind`/`ref_id`, `payload` (≤ 16 KiB, shape-checked per event type), `team_message_id`,
  `queued_for`, `consumed_by_run_id`; `chats` gains `last_event_seq`, `last_read_chat_seq`;
  `team_jobs` gains `control`, `control_requested_at` and the statuses `interrupted`, `paused`;
  `team_findings` gains the states accepted/disputed/fixed/dismissed, `owner_participant`,
  `file_path`, `line`, `raised_run_id`, `resolved_run_id`; `team_decisions` gains
  `title_source`, `author_run_id`; `team_messages` gains `run_id`, `reply_to_event_id`,
  `ref_kind`, `ref_id`; `runtimes` gains `protocol`.
- **Runtime protocol.** `register_runtime(…, p_protocol)` and `runtime_heartbeat(…, p_protocol)`
  overloads record it; the old calls clear it (judged by version: 0.9.x = 9). Every answer
  (`runtime_json`) carries `protocol`, `protocol_reported`, `min_protocol` (10) and
  `update_required`. `min_protocol_for(feature)`: team 7, solo/pair 8 (unchanged), job control,
  choices and runs 10. From protocol 10, `add_message` / `add_finding` by an agent need a run and
  `add_decision` needs `title_source` (a 0.9 Runtime keeps writing legacy runless rows).
- **Runtime ops** (`team_job_write`, claim-gated, camelCase in `lib/team/model.ts`):
  `run_started` (idempotent by run key), `run_activity` (≤ 1 per 5 s, extra reports are ignored
  with `throttled: true`), `run_finished` (verification, native session; a timeout writes the
  ThreadLink `timeout` row), `request_choice` / `read_choices`, `add_change` (the builder run's
  card, plus a diff artifact when `diff` is sent), `add_artifact` (≤ 512 KiB, redacted),
  `ack_control`; `add_message` (runId, replyTo, refs), `add_finding` (runId,
  ownerParticipant, file, line), `set_finding_status` (new states, runId), `add_decision`
  (titleSource, runId), `read_owner_notes` (runId, or `{consumedByRunId, noteIds}`),
  `set_status` (`interrupted`, `paused`). Every answer carries `control`,
  `control_requested_at` and `pending_choices`.
- **Owner RPCs** (`authenticated`): `decide_choice`, `control_job`, `add_chat_attachment`,
  `delete_chat_artifact`, `reveal_run_native_session` (audited), `mark_chat_read_seq`,
  `chat_list_extras_v2`, `search_my_chats`, `chat_host_status`; `mark_chat_read` keeps both
  cursors in step.
- **Triggers.** Agent messages carry their run, reply and reference; finding rows carry a
  payload card; decisions with a title source become `decision_card`; job updates add `phase`
  separators, the `interrupted` row and, with the verdict, the `job_summary` card (job data
  only); a finished job cancels its open runs and pending choices.
- **Routes** (Clerk owner, user-scoped client): `GET /api/dashboard/chats/[chatId]/events`
  (per-chat cursor), `/activity`, `/runs/[runId]` (+ `POST /reveal`), `/findings`,
  `/decisions`, `/choices` (+ `POST /choices/[choiceId]`), `POST /control`, `/artifacts`
  (GET, POST attach; `GET|DELETE /artifacts/[artifactId]`), `POST /read {chatSeq}`;
  `GET /api/dashboard/search?q=`, `GET /api/dashboard/providers`. Library:
  `lib/chat/work.ts`, wrappers in `lib/chat/owner.ts`.
