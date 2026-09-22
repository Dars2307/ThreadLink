# ThreadLink Routing: Tasks, Messages and Results

Source of truth: [`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md) §13–§17. Phase 5 is the
backend protocol that the ChatGPT MCP server and the ThreadLink Runtime will use in Phase 6.

## Route resolution

Every route resolves inside the database, from ThreadLink IDs only:

```text
credential HMAC ─> connection (active)                    threadlink_private.require_connection
  └─ origin tlses_ (caller's own, usable, controller)     require_role_session
       └─ tllnk_ (active; controller_session = origin)    create_task
            └─ target tlses_ = link.agent_session (usable) session_is_usable
                 └─ target connection (active)            session_is_usable
```

The caller sends **only** its origin session and the link. It cannot send a target session,
target connection, target user or owner (strict schemas reject them). Routing never uses display
names, platform names, emails, project names or provider session IDs.

Integrity also holds below the functions: composite foreign keys bind tasks, messages and
artifacts to one owner, and triggers require `task.origin = link.controller` and
`task.target = link.agent`, and require a message's sender and recipient to be the task's two sides.
These hold even for privileged writers.

## Task lifecycle (`tasks`, `tltask_`)

```text
queued ──claim──> claimed ──start──> working ──complete──> completed
  │                  │                  └──────fail──────> failed
  │                  ├────────complete / fail (skip start)─┘
  ├─ expires_at passes ─> expired
  └─ link revoked / route invalid (any open state) ─> cancelled
```

- Terminal: `completed`, `failed`, `cancelled`, `expired`. A trigger forbids any transition out
  of them and any illegal transition, even for privileged writers (no silent reactivation).
- Payload (`title`, `content`, `priority`, `task_type`, route columns) is immutable after
  creation.
- Priority: `A1` `A2` `A3` `A` `B` `C` `D` `E` (default `C`). It orders delivery only
  (A1 first), never authorization.
- `expires_at`: default 24 h, configurable 60 s–7 days. It is the **delivery deadline** for
  `queued` tasks.

## Messages (`messages`, `tlmsg_`)

Routing messages only; no transcript mirroring.

| Type       | Direction       | Content                                                 |
| ---------- | --------------- | ------------------------------------------------------- |
| `task`     | origin → target | none (payload lives on the task; one envelope per task) |
| `progress` | target → origin | ≤ 64 KB                                                 |
| `result`   | target → origin | ≤ 256 KB                                                |
| `error`    | target → origin | ≤ 64 KB                                                 |
| `note`     | reserved        | ≤ 64 KB                                                 |

`progress`, `result` and `error` carry `in_reply_to` = the task envelope. `delivered_at` is set
when the recipient first receives a message; `read_at` when the agent claims or the origin reads
the result. Messages are immutable except those two timestamps.

## Artifacts (`artifacts`, `tlart_`)

References only (no blobs): `git_commit`, `pull_request`, `file_path`, `deployment`,
`test_report`, `url`, `other`. `reference` ≤ 1024 chars, `metadata` a JSON object ≤ 4 KB, at most
20 per task. They are attached at completion.

## Flows

**Send** (`POST /api/tasks`, controller): the full path above is validated **at send time**,
together with the open-task cap (100 per link). The server writes the task and its `task` envelope
atomically. The link row is share-locked, so revocation cannot race with the insert.

**Inbox** (`GET /api/tasks/inbox?sessionId=`, agent): returns queued tasks for **this exact agent
session** plus open tasks it holds, ordered A1 → E, then oldest first; at most 50. Every
candidate is **re-validated at delivery time** (sweep): overdue ones become `expired`, and any
whose route is no longer valid becomes `cancelled` with `route_invalid`. Content is delivered only
through the inbox or claim of the exact target.

**Claim** (`POST /api/tasks/:id/claim`, `{ sessionId, claimRef }`): atomic. The task row is
locked (`SELECT … FOR UPDATE`), and only `queued → claimed` succeeds. The first claimer wins; any
other `claimRef` gets `409`; a retry with the **same** `claimRef` is idempotent. `claimRef` is a
worker identifier the client generates (for example per Runtime process). `start`, `progress`,
`complete` and `fail` must present the owning `claimRef`, so two workers can never own one task,
even within one agent session.

**Result** (`GET /api/tasks/:id/result?sessionId=`, controller): only the **originating**
controller session may call it. Returns status, result, error, progress, artifacts and all
timestamps. Other controller sessions (even of the same user) get `404`.

## Idempotency

`idempotencyKey` (optional, `[A-Za-z0-9._:-]{1,128}`) is unique per **(owner, origin session)**.
Repeating a create with the same key returns the **original** task (`created: false`), whatever
the new payload says; content is never the idempotency mechanism. Concurrent creates with one key
converge on one row (`ON CONFLICT`).

## Revocation handling

- **Cascade (explicit state):** link `revoked` → its `queued`/`claimed`/`working` tasks become
  `cancelled` (`link_revoked`), audited. Because Phase 4 cascades connection → sessions → links,
  revoking a connection or retiring/revoking a session also cancels the affected tasks.
- **Delivery-time check (independent of the cascade):** every inbox, claim, start, progress,
  complete, fail and get re-runs the route check. A test revokes a link with the cascade trigger
  disabled and proves the task is still refused and marked `route_invalid`.
- Failing operations roll back their transaction, so a state change they discover (expiry,
  invalid route) is persisted by the next non-failing read (inbox/get/result). Delivery is refused
  either way.
- History is never deleted. Completed results stay readable by the **origin** session (while
  that session is usable) and by the owner in the dashboard, even after the link is revoked. The
  agent no longer receives task content once the route is gone.

## Leases and retries (Phase 6)

- `claim_task` sets `claimed_until = now() + 5 minutes` and increments `attempt_count`. Every agent
  step and `POST /api/tasks/{id}/heartbeat` (`renew_task_lease`) renews the lease.
- The delivery-time sweep requeues a `claimed` or `working` task whose lease has expired (clearing
  the claim and audited as `task.requeued`). Once `attempt_count >= max_attempts` (3), it fails the
  task with `failure_reason = 'lease_exhausted'`.
- The previous worker's `claimRef` no longer matches, so it cannot start, report, complete or fail
  the task (`409`). A fresh worker claims it, which keeps results exactly once.
- The state-machine trigger allows claimed/working → queued only for an expired lease with a
  cleared claim. `attempt_count` never decreases, and `max_attempts` is immutable.
- `GET /api/tasks?sessionId=…&limit=…` (`list_origin_tasks`) lists tasks sent from a controller
  session.

## Polling model and future push

Alpha delivery is polling: a Runtime calls `GET /api/tasks/inbox` on an interval, then claims. The
protocol is push-compatible: delivery state lives in the database (`delivered_at`, claims), so a
future notifier (webhook, SSE, WebSocket) only needs to signal "inbox changed". Claiming,
validation and results stay exactly the same. No queues, Redis, WebSockets or workers are used.

## Limits (Alpha)

| Item                     | Limit                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Task title               | 255 characters                                                                                                              |
| Task content             | 64 KB (UTF-8 bytes)                                                                                                         |
| Result                   | 256 KB                                                                                                                      |
| Progress / error message | 64 KB                                                                                                                       |
| Artifacts                | 20 per task; reference 1024 chars; metadata 4 KB                                                                            |
| Request bodies           | 80 KB (create, progress, fail), 320 KB (complete), 8 KB (others); `Content-Length` checked before reading → `413 too_large` |
| Open tasks per link      | 100                                                                                                                         |
| Inbox page               | 1–50 (default 20)                                                                                                           |

## Client API

| Route                          | Caller             | Body / query                                                                                                  |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/tasks`              | controller         | `{ originSessionId, threadLinkId, title, content, priority?, taskType?, idempotencyKey?, expiresInSeconds? }` |
| `GET /api/tasks/inbox`         | agent              | `?sessionId=&limit=`                                                                                          |
| `GET /api/tasks/:id`           | participant        | `?sessionId=`: status; content only for the live target                                                       |
| `POST /api/tasks/:id/claim`    | exact target agent | `{ sessionId, claimRef }`                                                                                     |
| `POST /api/tasks/:id/start`    | claiming worker    | `{ sessionId, claimRef }`                                                                                     |
| `POST /api/tasks/:id/progress` | claiming worker    | `{ sessionId, claimRef, content }`                                                                            |
| `POST /api/tasks/:id/complete` | claiming worker    | `{ sessionId, claimRef, result, artifacts? }`                                                                 |
| `POST /api/tasks/:id/fail`     | claiming worker    | `{ sessionId, claimRef, error }`                                                                              |
| `GET /api/tasks/:id/result`    | origin controller  | `?sessionId=`                                                                                                 |

Errors: `401 unauthorized`, `403 forbidden` (your connection has the wrong role), `404 not_found`
(nonexistent **or** not yours: indistinguishable), `409 conflict` (not claimable, not your claim,
terminal), `400 invalid`, `413 too_large`, `429 limit`.

## Envelope

```json
{
  "taskId": "tltask_…",
  "messageId": "tlmsg_…",
  "threadLinkId": "tllnk_…",
  "originSessionId": "tlses_…",
  "targetSessionId": "tlses_…",
  "type": "task",
  "priority": "A1",
  "content": "…"
}
```

IDs in a client request are **never trusted because they are present**. Each operation
re-resolves the caller's connection, session and link and checks them against the stored task.
