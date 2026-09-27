# Chat API for the desktop app and the terminal (0.10)

The desktop app and the terminal (`threadlink chats | chat | new`) are clients of the same server
chat timeline as the web. They call `/api/runtime/chats/**` with the computer's stored **Runtime
credential** (`Authorization: Bearer tlc_…`, the agent credential the Runtime already holds; never
a pasted secret). Contract: [design/threadlink-0.10.md](design/threadlink-0.10.md) section 9.

## Who may call

- Only the credential of an **active, unpaused, registered Runtime**. The owner is resolved from
  the credential; nothing in a request names an owner.
- A controller (ChatGPT) credential gets `403 forbidden` before the body is read (controllers use
  [MCP](mcp.md)). A paused Runtime gets `403 runtime_paused`; an agent credential that never
  registered a Runtime gets `403 runtime_required`; a revoked or unknown credential gets `401`.
- Another account's chat, a deleted chat and a malformed id all answer `404 chat_not_found`.
- The same owner rules as the web composer apply in the database: ownership, rate limits (20 posts
  per chat per minute, 60 per account), the provider health gate, idempotency, `needs_project`.
  Reads through a credential are capped at 300 per account per minute.

## Errors

Every refusal is `{ok:false, reason, message}` with a fixed, human-safe `message` (never database
text). Statuses: 400 `invalid` / `empty` / `too_long` / `invalid_name`, 401 `unauthenticated`,
403 `forbidden` / `runtime_paused` / `runtime_required`, 404 `chat_not_found` /
`project_not_found`, 409 `needs_project` / `provider_unhealthy` / `job_active` /
`nothing_to_stop` / `agent_not_in_project` / `route_missing` / `link_paused` / `runtime_outdated` /
`room_inactive` / `idempotency_conflict` / `limit_reached` / `conflict`, 413 `too_large`,
429 `rate_limited`, 503 `unavailable`. Body caps: messages 20 KiB, create 4 KiB, read 256 B.

## Cursors

Timeline cursors are **per chat**: a chat's rows are numbered 1, 2, 3… (`chat_events.chat_seq`).
The global event sequence is never returned. Read state is `chats.last_read_chat_seq`; unread
follows the 0.10 rules (agent, controller and important ThreadLink rows).

## Routes

### `GET /api/runtime/chats?archived=0|1&search=<≤100 chars>`

```jsonc
{
  "chats": [ChatApiSummary],      // pinned first, then most recent activity; ≤ 200
  "projects": [{ "roomId": "tlrom_…", "name": "Prism", "runtimeLabel": "Nickron's PC", "thisComputer": true }],
  "runtime": {                    // the calling computer
    "label": "Nickron's PC", "online": true, "version": "0.10.0",
    "protocol": 10,               // RUNTIME_PROTOCOL it reported (else its minor version)
    "minProtocol": 10,            // needed for the 0.10 features (runs, choices, job control)
    "currentProtocol": 10,
    "updateRequired": false       // protocol < minProtocol: "ThreadLink on <host> needs an update"
  }
}
```

`ChatApiSummary`:

```jsonc
{
  "chatId": "tlcht_…",
  "name": "Auth review",
  "mode": "team",
  "settings": {
    "mode": "team",
    "soloProvider": null,
    "builderProvider": null,
    "reviewerProvider": null,
  },
  "roomId": "tlrom_…",
  "projectName": "Prism", // null when the chat has no project yet
  "runtimeLabel": "Nickron's PC",
  "runtimeOnline": true,
  "thisComputer": true,
  "groupName": null,
  "pinned": false,
  "archived": false,
  "isRoomDefault": false,
  "lastActivityAt": "…",
  "lastMessage": "…(≤200 chars)",
  "unread": true,
  "unreadCount": 3,
  "lastReadCursor": 12,
  "needsAttention": false,
  "activeJob": { "jobId": "tljob_…", "mode": "team", "status": "building" }, // or null
  "participants": [
    {
      "kind": "agent",
      "provider": "claude-code",
      "name": "Claude Code",
      "shortName": "Claude",
      "health": "ready",
    },
    {
      "kind": "controller",
      "provider": null,
      "name": "ChatGPT",
      "shortName": "ChatGPT",
      "health": null,
    },
    { "kind": "owner", "provider": null, "name": "You", "shortName": "You", "health": null },
  ],
}
```

### `POST /api/runtime/chats` `{name, roomId?: tlrom_|null, mode?: "solo"|"pair"|"team"}`

→ `{ok:true, chat: ChatApiSummary}`. Same rules as the web: name 1–100 characters on one line,
the project must be the owner's and active, 20 new chats per minute, 2,000 live chats.

### `GET /api/runtime/chats/<chatId>` → `ChatApiSummary & {activity: LiveActivity[]}`

### `GET /api/runtime/chats/<chatId>/events?after=|before=&limit=1..200&technical=0|1`

Neither `after` nor `before`: the latest page. `after`: the rows after that cursor (poll).
`before`: the page just before that cursor (scroll back). Not both. Default limit 100; visible
rows only unless `technical=1`.

```jsonc
{
  "chatId": "tlcht_…",
  "events": [ChatApiEvent],       // oldest first
  "cursor": 14,                   // poll next with after=14
  "oldestCursor": 3,              // scroll back with before=3 (null on an empty page)
  "hasMore": false,               // more rows in the direction of travel
  "activeJob": { "jobId": "tljob_…", "mode": "team", "status": "reviewing" },  // or null
  // Runs working now that have not produced their message yet (show a live row; no text is invented).
  "activity": [{ "runId": "tlarn_…", "provider": "codex", "providerName": "Codex", "role": "reviewer",
                 "activity": "reviewing", "startedAt": "…", "lastActivityAt": "…" }],
  // Delivery of the chat's newest ≤50 owner notes, on EVERY page (a poll with nothing new still
  // shows queued -> seen): replace the delivery of the row with that cursor.
  "deliveries": [{ "cursor": 9, "delivery": { "state": "seen", "by": ["codex"] } }]
}
```

`ChatApiEvent`: `{id, cursor, createdAt, authorKind: "controller"|"owner"|"threadlink"|"agent",
authorLabel, authorProvider (agent rows only), authorRole, audience, eventType, messageType,
round, modelRequested, modelObserved, body (plain text, redacted; never render as HTML),
visibility, jobId, runId, replyToEventId, ref: {kind, id}|null, payload (structured card data,
e.g. code_change / finding / choice / job_summary), delivery (owner notes to running work:
{state:"sent"} | {state:"queued", for:[provider]} | {state:"seen", by:[provider]} |
{state:"not_delivered"}), client: "web"|"desktop"|"terminal"|null (owner rows only; null = web)}`.

### `POST /api/runtime/chats/<chatId>/messages`

Body `{body (≤4000 chars), idempotencyKey?: [A-Za-z0-9._:-]{1,128}, client?: "desktop"|"terminal"}`
and/or header `X-ThreadLink-Client: desktop|terminal` (at least one; both must agree). The author
is the owner ("You"); the row records the client.

- `200 {ok:true, routed: "new_job"|"note_to_active_job"|"stop_requested", jobId, eventId, replayed}`
- `409 {ok:false, reason:"provider_unhealthy", message, health:[{provider, health}], stored:true, eventId}`:
  the message and a ThreadLink row naming who is not ready ARE in the chat; no work started.
- The same `idempotencyKey` returns the first answer with `replayed:true` and stores nothing new.

### `POST /api/runtime/chats/<chatId>/read` `{cursor}` → `{ok:true, lastReadCursor}`

Never past the chat's newest row, never backwards.

## Owner export

`GET /api/dashboard/chats/<chatId>/export?format=md|json` (Clerk session, the owner only) downloads
one chat: its name, project and mode, its visible messages (who, when, what) and its jobs'
outcomes. No ids, cursors, native session ids or secrets; bodies are redacted again on the way out,
and Markdown is escaped so message text never becomes markup. At most the newest 10,000 messages.

## Code

- `supabase/migrations/20260927000300_chat_api.sql`: `runtime_*` and `controller_*` chat functions.
- `lib/client-api/chats.ts`: input bounds, row → wire mapping, error reasons.
- `lib/client-api/chat-routes.ts`: authentication, credential kind, body caps, client header.
- `app/api/runtime/chats/**`: the routes. `lib/mcp/*`: the MCP chat tools.
- `lib/export/chat-export.ts`, `app/api/dashboard/chats/[chatId]/export`: the export.
