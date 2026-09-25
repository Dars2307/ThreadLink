# Collaboration chat

Status: design contract for the "Provider fixes + real collaboration chat" phase.
Shared types: `lib/chat/types.ts`. Builds on `docs/design/team-mode.md`.

## 1. Goal

One ThreadLink-owned timeline per project (room) that shows, in order:

- what the controller (ChatGPT or any MCP client) asked for;
- what the owner typed into the project chat;
- what each agent said, with provider, role and the model it was actually
  observed to use;
- ThreadLink's own milestones (job started, plan agreed, unit built, review
  verdict, result).

It works the same for a single agent, Builder + Reviewer, and full Team Mode,
and for Claude-only or Codex-only rooms. Nothing here reads or writes a
provider's private transcript files; the chat is ThreadLink's own record.

## 2. Trusted provenance (the security core)

`public.chat_events` has no insert/update/delete grant to any client role.
Rows are written only by:

| Author kind  | Written by                                                                                                          | Author fields come from                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `controller` | trigger on `tasks` insert / `team_jobs` insert                                                                      | the origin session's connection platform (e.g. "ChatGPT"); never from request input                                                       |
| `owner`      | `public.post_chat_message` (Clerk-authenticated, `auth.uid()`)                                                      | fixed label "You"                                                                                                                         |
| `threadlink` | triggers on `tasks`, `messages`, `team_jobs`, `team_nodes`, `team_findings`, `team_decisions`, `model_usage_events` | fixed label "ThreadLink"; body built by SQL from trusted state, never from agent text                                                     |
| `agent`      | trigger on `team_messages` insert; trigger on `messages` (result) insert for single tasks                           | provider = `team_messages.sender` (validated against the room's agents) / the agent session's provider; model = what the Runtime observed |

Consequences:

- An agent writing "ThreadLink: PASS" produces an **agent** row rendered in an
  agent bubble, never a system event. Verdict events come only from the
  `team_jobs.verdict` column, which only `team_job_write` sets under the PASS
  rules.
- The controller cannot claim to be Claude or Codex: controller rows are
  `author_kind = 'controller'` and the label is derived server-side.
- Cross-room injection is impossible by construction: every row's room and
  agent session are copied from the parent row (task/job) inside the trigger,
  and owner posts are checked against `rooms.owner_user_id = auth.uid()`.
- Bodies are plain text, bounded (1..8192 bytes), stripped of control
  characters except newline/tab, and passed through `threadlink_private.redact_text`
  (API-key, bearer, token, password, cookie, private-key, connection-string
  shapes). The UI renders them as text nodes only (no `dangerouslySetInnerHTML`,
  no markdown-to-HTML).
- Duplicates/replay: owner posts carry an optional client idempotency key
  (unique per owner); triggers fire once per source row.
- Rate limit: at most 20 owner posts per room per minute, 4000 characters each.

## 3. Schema (migration `20260926000100_collaboration_chat.sql`)

```
public.chat_events
  id text pk  (tlcev_…)
  seq bigint generated always as identity  -- cursor, unique
  owner_user_id text not null
  room_id text null        -> rooms(id, owner_user_id)
  agent_session_id text not null -> session_bindings(id, owner_user_id)
  job_id text null         -> team_jobs(id, owner_user_id)
  task_id text null        -> tasks(id, owner_user_id)
  node_id text null
  author_kind text check in (controller, owner, threadlink, agent)
  author_provider text null check in (claude-code, codex); required iff agent
  author_label text 1..60
  author_role text null (TEAM_ROLES)
  audience text null check in (claude-code, codex, team)
  event_type text (CHAT_EVENT_TYPES)
  message_type text null (team message types)
  round int null 0..6
  model_requested text null, model_observed text null  (^[A-Za-z0-9._:\[\]/-]{1,100}$)
  body text 1..8192 bytes
  visibility text check in (visible, technical)
  delivered_at timestamptz null   -- owner notes: when the Runtime picked it up
  idempotency_key text null
  created_at timestamptz default now()
RLS: select own (owner_user_id = auth.uid()); no other grants.
Indexes: (room_id, seq), (agent_session_id, seq), (job_id, seq), (owner_user_id).
```

Other changes:

- `team_jobs.mode text not null default 'team' check in (solo, pair, team)`,
  `team_jobs.builder_provider text null`, `team_jobs.stop_requested_at timestamptz null`,
  `team_jobs.origin text not null default 'controller' check in (controller, owner)`.
- `team_messages.model_observed text null` (Runtime-reported, pattern-checked).
- `tasks`: nothing new. Owner-started work is always a team job (see §5), so
  plain `tasks` rows are only ever controller-originated.
- `public.set_runtime_provider_plan(p_token_hash, p_provider, p_declared_plan)`:
  a Runtime may set the owner's **declared plan only** (never usage policy or
  paid usage). Same per-provider validation as `set_provider_profile`.
  Audited as `provider.plan_set_from_device`. This is a deliberate, narrow
  widening so the desktop app can edit the plan; the server stays the only
  source of truth.
- Legacy plan values: `team`/`business` for Codex are rejected by the check
  constraint; any existing row holding one is migrated to `unknown` with an
  audit event, so the UI can say "Choose Business Standard or Business Premium".

## 4. What the triggers write

| Source                                               | Event                                                                                                       | Visibility                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `tasks` insert (task_type ≠ team)                    | controller `request`: title + first 2000 chars of content                                                   | visible                                                                              |
| `tasks` → working                                    | threadlink `task_started` "Claude Code started working"                                                     | visible                                                                              |
| `messages` progress                                  | threadlink `task_progress` (first 300 chars)                                                                | technical                                                                            |
| `messages` result                                    | agent `agent_result` (first 6000 chars), provider of the agent session                                      | visible                                                                              |
| `messages` error / task failed / expired / cancelled | threadlink `task_failed` / `task_cancelled` with a safe reason                                              | visible                                                                              |
| `team_jobs` insert                                   | controller or owner `request` (goal) + threadlink `job_started` ("Team Mode", "Builder + Reviewer", "Solo") | visible                                                                              |
| `team_jobs` status change                            | threadlink `job_status`                                                                                     | technical, except planning→building ("Plan agreed" as `plan_agreed`), and terminal   |
| `team_jobs` verdict set                              | threadlink `job_verdict` "Result: PASS" + summary (≤1000)                                                   | visible                                                                              |
| `team_nodes` status change                           | threadlink `unit_status`                                                                                    | visible for approved / changes_requested / integrated / failed; else technical       |
| `team_messages` insert                               | agent `agent_message` (sender, role, receiver→audience, round, type, model_observed)                        | visible for proposal/review/response/question/decision/completion; handoff technical |
| `team_findings` insert                               | threadlink `finding` "Blocking finding: …"                                                                  | visible if blocking/important, else technical                                        |
| `team_decisions` insert                              | threadlink `decision`                                                                                       | visible                                                                              |
| `model_usage_events` insert                          | threadlink `model_used`                                                                                     | technical; `model_mismatch` visible when requested ≠ observed                        |

## 5. Owner messages and routing (`public.post_chat_message`)

`post_chat_message(p_room_id, p_body, p_mode default null, p_builder default null, p_idempotency_key default null) returns jsonb`

1. `auth.uid()` must own the room; room must be active. Fail closed otherwise.
2. The server parses a leading mention: `@claude`, `@codex`, `@team` (case-insensitive).
   Client-supplied mode/builder are only hints and are validated.
3. If the room has an active (non-terminal) job:
   - `@team stop…` (body starts with `@team stop`) → set `stop_requested_at`,
     write threadlink `stop_requested`. The Runtime finishes the current round
     and ends the job with NEEDS_USER_DECISION ("Stopped by you").
   - anything else → stored as an owner `message` with `audience` and
     `delivered_at = null`. The Runtime reads undelivered notes with the
     `read_owner_notes` op of `team_job_write` (claim-gated) and includes them
     in the next prompt of the addressed agent(s) as an owner note, clearly
     delimited as untrusted-for-instructions user input. Reading marks them
     delivered and writes threadlink `owner_routed`.
4. If there is no active job, the message starts a new job over the room's
   route (the most recent active thread link to `rooms.agent_session_id`):
   - `@claude …` / `@codex …` → `solo` with that builder;
   - `pair` requested (composer "Builder + Reviewer") → builder from the
     mention (default claude-code), reviewer = the other provider;
   - `@team …` or no mention in a 2-agent room → `team`.
     Same gates as `start_team_job` (Runtime ≥ 0.7, subscription auth, verify
     commands from room policy only, paid usage from owner profiles only).
     If the room has no active route: fail with "This project's conversation
     isn't linked any more. Ask your controller to reconnect it."
5. Returns `{ routed, jobId }`.

Controller parity: MCP `start_team_job` gains optional `mode` (`solo` | `pair` | `team`)
and `builder`.

## 6. Runtime behaviour

- `solo`: no planning council. The builder writes a one-node plan (title =
  goal), it is recorded and approved by the builder alone, the builder builds
  in its worktree, verify commands run, result branch produced. Verdict PASS
  only if the build succeeded and verification passed. No reviewer.
- `pair`: one node, builder → reviewer (the other provider) → fix → re-review,
  bounded by `max_review_rounds`, then final verification. PASS requires the
  reviewer's approval.
- `team`: unchanged.
- Between turns the orchestrator calls `read_owner_notes` and honours
  `stop_requested_at` at round boundaries.
- Every agent message carries `modelObserved` (from Claude `modelUsage`, Codex
  rollout `turn_context`), so the chat can show the real model.

## 7. Reading the chat

- `GET /api/dashboard/chat?room=<id>&after=<seq>&technical=0|1` (Clerk owner
  session, RLS) → `ChatPage`. Max 200 events per page.
- The web chat polls every 3 s while visible, 15 s when hidden, stops after
  10 minutes idle until focus. No websockets, no new infrastructure.
- `POST /api/dashboard/chat` `{ roomId, body, mode?, builder?, idempotencyKey? }` →
  `PostChatMessageResult` with human-safe error messages.

## 8. UI

Project page `/dashboard/projects/[roomId]` with tabs:

- **Chat** – the timeline, a "Show technical details" toggle, and a composer
  with @mention hints and a mode picker (Solo · Builder + Reviewer · Team).
- **Progress** – the latest (or selected `?job=`) job: status, units,
  reviews, findings, decisions, model usage.
- **Details** – raw IDs (room, job, node, task, agent session) with copy
  buttons. IDs appear nowhere else.

Controller rows are labelled with the real client name from the connection
(`ChatGPT`, `Claude`, …) or "Controller" when unknown. Empty states never
assume ChatGPT.

## 9. Not supported (and said so)

- **Visible conversation via `claude --remote-control`**: Remote Control is
  for a person to drive a session from claude.ai or the phone; there is no
  supported programmatic input. Not offered. A headless session created with
  `--session-id` can be opened by the user with `claude --resume <id>`, but
  whether a `-p`-created session shows in the interactive picker is unverified,
  and concurrent writes are unsafe, so it is not offered as a mode yet.
- **Cursor**: its CLI (`agent -p --output-format json`, `--resume`, `--model`,
  MCP) is a suitable surface, but it is not installed on the test machine and
  has not been run. Shown as "Not available yet"; never listed as supported.
- **Codex conversation discovery**: Codex has no supported machine-readable
  session list; ThreadLink does not scrape `~/.codex/sessions`. Codex work runs
  in ThreadLink-owned sessions only.

## 10. Server implementation notes and deviations

These are the places where the server (migration `20260926000100_collaboration_chat.sql`,
`lib/chat`, `/api/dashboard/chat`) is stricter than, or more specific than, sections 2 to 7.

1. **Progress is the agent's own text.** The `messages` progress trigger writes an `agent` row
   with event `task_progress` and technical visibility, not a `threadlink` row. That text comes
   from the agent, so under section 2 it cannot speak as ThreadLink.
2. **Error text is not copied.** `messages` rows of type `error` are not mirrored.
   `task_failed` and `task_cancelled` bodies are built from `tasks.failure_reason` and
   `cancel_reason` only. A completed task also writes a technical `task_completed` row.
3. **Orchestrator text is skipped.** A `team_messages` row with `sender = 'threadlink'` is
   Runtime orchestrator text, not SQL-built text, so it gets no chat row. An agent row needs a
   sender that is one of the room's agents.
4. **Units are named by key.** `unit_status` uses the node key, which is constrained to
   `[A-Za-z0-9_.-]`, not the free-text title.
5. **Owner-started jobs.** `post_chat_message` writes the owner's `request` row itself, with the
   idempotency key, and then starts the job. The `team_jobs` insert trigger writes the
   controller `request` only when `origin = 'controller'`, and always writes `job_started`.
   - The job goal is the redacted message with the leading mention removed.
   - A `@team stop` message is stored as an owner `message` with `delivered_at` already set, so
     it is never delivered as a note. `stop_requested` is written by the `team_jobs` update
     trigger.
6. **Notes belong to one job.** A note carries the `job_id` of the job that was active when it
   was posted. `read_owner_notes` returns undelivered owner messages for that job, in that
   job's room, created at or after the job started. It returns at most 20 per call, and each
   delivered note writes one `owner_routed` row.
7. **Hints are ignored when a job is running.** While a job is active, `p_mode` and `p_builder`
   are validated but do not affect routing.
8. **Runtime version gate per mode.** Team Mode needs Runtime 0.7 or later. Solo and pair need
   0.8 or later (`team_min_runtime_minor`), because a 0.7 Runtime ignores `mode` and would run a
   solo request as a full team. This applies to both the controller and the owner path.
9. **Carrier content.** Alongside `mode` and `builder`, the carrier also has `reviewer` (pair
   only) and `origin`. `agents` lists only the job's participants, so a solo job lists its
   builder only.
10. **`start_team_job` overload.** The new overload takes 12 arguments with no defaults. A call
    that omits `p_mode`/`p_builder` resolves to the original 10-argument function, so existing
    callers are unaffected. `lib/team/client-api.ts` always sends both arguments.
11. **Controller label.** The label comes from `connections.platform`: `chatgpt` becomes
    "ChatGPT" and `claude-desktop` becomes "Claude". For any other platform, the connection's
    display name is used, but a name that imitates You, ThreadLink, Claude Code or Codex
    becomes "Controller".
12. **Paging.** `GET /api/dashboard/chat` without `after` returns the latest 200 events, oldest
    first. With `after`, it returns up to 200 events after that cursor.
13. **Failure reasons.** Each failure carries its reason code in the Postgres error `HINT`:
    `unauthenticated`, `room_inactive`, `empty`, `too_long`, `invalid`, `invalid_mode`,
    `invalid_builder`, `rate_limited`, `idempotency_conflict`, `nothing_to_stop`,
    `agent_not_in_project`, `route_missing`, `link_paused`, `runtime_outdated`,
    `agents_unavailable`. A room that is not found raises `P0002` with no hint.
    `lib/chat/model.ts` chooses the sentence the user sees.
14. **ThreadLink rows never quote agent text (security review I1).**
    - A `finding` row reads "Blocking finding from Claude Code (security) on unit limit". It is
      built from severity, provider, category and node key only.
    - A `decision` row reads "Decision TL-00042", plus "This needs your decision." when the
      owner is needed. The agent-written title is omitted.
    - `job_verdict` is "Result: VERDICT", then "Stopped by you." when the owner stopped it, then
      a sentence built from the mode, builder, reviewer and the number of project checks.
      `team_jobs.summary` is not quoted in the chat; the Progress tab shows it. This replaces
      the "+ summary (≤1000)" in section 4.
15. **Solo and review (security review B1).**
    - A controller may not start a `solo` job while the room has `cross_review = true`. That
      raises `42501` with hint `review_required` and the message "This project requires
      review; use Builder + Reviewer or Team".
    - An owner's `solo` (through `post_chat_message`) is always allowed.
    - A `solo` job whose `verify_commands` is empty can never get a `PASS`. That raises `55000`
      with hint `solo_unverified`, and the Runtime reports NEEDS_USER_DECISION instead.
16. **Limits and hardening (security review M1 to M9).**
    - **Redaction** also covers:
      - Google `AIza` keys, `glpat-` and `npm_` tokens, and Slack webhook URLs;
      - `scheme://:password@` (an empty user);
      - `aws_secret_access_key <value>`, "password is X", and `KEY: value` up to the end of
        the line;
      - home directories, shortened to `C:\Users\…\`, `/home/…/` and `/Users/…/`.
    - **Bodies** lose zero-width and bidi-control characters (U+200B–U+200F, U+202A–U+202E,
      U+2066–U+2069, U+FEFF).
    - **Controller labels** come from `threadlink_private.chat_controller_name`. The name is
      normalised with NFKC and stripped of invisible characters. Any non-ASCII name, or any
      name whose ASCII skeleton contains threadlink, claude, codex, chatgpt, openai or
      anthropic, or equals you, owner or system, becomes "Controller". Only the platform itself
      yields "ChatGPT" or "Claude".
    - **Agent messages** are mirrored only from a provider that is an enabled agent of the room
      and a participant of the job (the server-built carrier's `agents`).
    - **Stop** means `^@team\s+stop(\s|$|[.,!:;])`, and the live router and the replay
      classifier share one definition (`chat_stop_pattern`).
    - **Plan changes:** `set_runtime_provider_plan` allows 30 changes per owner per hour
      (`54000`, hint `rate_limited`).
    - **Owner posts** are capped at 60 per owner per minute across all rooms, as well as 20
      per room.

### Known limitations (accepted for alpha)

- **M5, global `seq`.** `chat_events.seq` is one identity across all tenants. Gaps in the
  cursor can hint at how busy the whole system is, but they reveal nothing about another
  owner's rows. A per-room sequence would remove this and is deferred.
- **M7. Owner-started jobs travel over the controller's link.** A job the owner starts from the
  chat is carried by a task whose origin is the room's controller session, so that controller can
  see it (and its goal) through `get_team_status`, and it counts against that link's task limits.
  It is the same account, so nothing crosses users; a separate owner origin session would remove it.
