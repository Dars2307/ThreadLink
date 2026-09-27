# ThreadLink 0.10 — the real ThreadLink experience

Status: design contract for the 0.10.0 phase (runtime, desktop, web, server).
Builds on `chat-first.md` (0.9), `collaboration-chat.md` (0.8), `team-mode.md`.
Shared types: `lib/chat/types.ts` (0.10 additions at the end).

> One chat. One project context. One AI team. Every agent's real work visible.
> Every result attributable. One verified outcome.

## 0. Ground rules (unchanged, restated)

- The ThreadLink chat is the source of truth. Web, desktop and terminal are
  clients of the same server timeline. Providers own only their worker-side
  native sessions.
- Three distinct things: **Chat** (long-lived), **Job** (one request inside a
  chat), **Agent run** (one provider execution, with its native session/thread).
- Every row authored "ThreadLink" is written by the database from trusted
  state. Every row authored by an agent is tied to a recorded agent run.
  Provider output can never become a ThreadLink row, approval, decision
  verdict or model identity.
- No private chain-of-thought is requested, stored or shown. Visible planning is
  deliberate collaboration artifacts only (proposal, review, objection,
  revision, task split, finding, response, decision, summary, handoff).
- Subscription usage only; API/paid paths never used silently.
- Migrations are additive. The new migrations are named after the already
  applied `20260927000100_chat_first.sql` so they sort after it (Supabase applies
  in filename order): `20260927000200_…`, `20260927000300_…`.

## 1. Provider-neutral identity

- New table `public.agent_providers(id text pk check '^[a-z][a-z0-9-]{1,39}$',
display_name, short_name, mention_aliases text[], supported boolean,
sort int)`; seeded with `claude-code` (Claude Code, "Claude", aliases
  {claude, claudecode}), `codex` (Codex, aliases {codex}), and unsupported rows
  `cursor`, `windsurf`, `gemini-cli` (supported=false). Readable by
  `authenticated`/`anon` (public metadata), writable by no client.
- New columns/constraints use `references public.agent_providers(id)` instead of
  `check (… in ('claude-code','codex'))`. Existing hard-coded checks on
  **chat_events.author_provider / audience**, **room_agents.provider**,
  **agent_runs** and new tables are replaced with FK/pattern checks. Older team
  tables (team_nodes, team_messages, …) may keep their checks in 0.10 if
  replacing them is risky; list which remain in §12.
- `audience` = a provider id or `team` (validated against the registry).
- **Participants** are identified by `participant_key` (e.g. `codex:coordinator`,
  `claude-code:reviewer:2`), provider + role, so two agents from one provider
  are possible later. `lib/chat/types.ts`: `CHAT_AUDIENCES` becomes a
  runtime-validated `string` (provider id | "team"); UI renders provider
  metadata from the registry, never `switch (provider)`.

## 2. Agent runs and message provenance (the core)

```
public.agent_runs
  id text pk (tlarn_…), owner_user_id, chat_id, job_id, node_id null,
  runtime_id (execution host) -> runtimes, provider -> agent_providers,
  participant_key text, role text,
  requested_model, observed_model, model_verified boolean,
  effort text null, access text check (read-only, workspace-write),
  access_verified boolean,
  native_session_id text null      -- Claude `session_id`, Codex `thread_id`
  native_session_kind text null    -- 'claude_session' | 'codex_thread' | …
  native_session_continuity text   -- 'fresh' | 'resumed' | 'forked'
  resumed_from_run_id text null,
  worktree_label text null          -- friendly, e.g. "Prism / auth-review"
  status text check (queued, running, completed, failed, cancelled, timed_out, interrupted)
  activity text null check (queued, reading, planning, building, reviewing,
                            testing, waiting, responding, integrating)
  last_activity_at, started_at, finished_at, timeout_ms int,
  failure text null (fixed category: not_authenticated, quota_exhausted, timeout,
                     model_mismatch, access_mismatch, cancelled, crashed, provider_error)
  verification jsonb  -- {model:bool, access:bool, nativeSession:bool, exitClean:bool}
```

- Written only by the Runtime through `team_job_write` ops (claim-gated):
  `run_started {runKey, provider, participantKey, role, requestedModel, effort,
access, nodeKey?, worktreeLabel?, timeoutMs, continuity, resumedFromRunKey?}` →
  `{runId}`; `run_activity {runId, activity}` (rate-limited, ≤1/5 s per run);
  `run_finished {runId, status, observedModel, modelVerified, accessVerified,
nativeSessionId, nativeSessionKind, failure?}`. `runKey` makes them idempotent.
- `team_messages.run_id` and `chat_events.run_id` (nullable for old rows).
  `add_message` accepts `runId` and the server **requires** that the run
  belongs to the same job, has the same provider as `sender`, and is completed
  or running. Agent chat rows without a run are only legacy rows.
- **Verified** (UI trust badge) = run completed, `model_verified` and
  `access_verified` true, native session id present, run on the room's runtime.
  Anything missing → "Partially verified" with the reason. Never "Verified" on
  incomplete evidence.
- Native session id is **never** shown in normal UI; Details/Provenance shows
  "Available" plus a copy button for the owner. If the provider exposes none:
  "Persistent native session: not exposed by this provider".

### Native session continuity policy (Runtime)

- A native session is never reused across ThreadLink chats or projects.
- Within one job, a participant may resume its own session for fix rounds of the
  same unit (Codex already resumes by thread id); reviews and inspections use
  fresh sessions (independence). Planning revisions resume the planner's
  session. Everything else is fresh.
- The server enforces: `native_session_id` may not appear on runs of two
  different chats (unique (owner, provider, native_session_id) → chat check).
- "Open in provider": offered only if the capability registry marks it
  supported and verified (0.10: Claude `claude --resume <id>` in the project
  folder is documented; the UI shows the command to copy, never automates it).
  Codex: `codex resume <thread>` if verified by the runtime engineer; else not
  offered.

## 3. Visible collaboration (no fake dialogue)

- Every structured schema the orchestrator asks an agent for gains a required
  field `teamMessage` (1–1200 chars): "A short message to your teammates and the
  user about what you propose/found/changed. Not your private reasoning." The
  orchestrator posts it as that agent's chat message (tied to the run).
  Message types: proposal (coordinator task split, planner plan), review (plan
  review / code review), response (revision, fix reply, finding reply),
  finding (as card), handoff, completion, question.
- Replies: `chat_events.reply_to_event_id` and `ref_kind/ref_id`
  (finding | decision | node | artifact | message). A plan review replies to the
  plan proposal; a fix response replies to the finding(s) it addresses; a
  re-review replies to the fix.
- While a run is active and has not yet produced its message, the UI shows a
  live activity row from `agent_runs` (provider · role · activity · elapsed ·
  last activity). No interim text is invented.
- Phases are chat separators derived from job status changes: Planning,
  Build, Review, Integration, Final check (collapsible).
- Noise control: technical events stay `technical`; model_used, job_status,
  run lifecycle never appear as normal chat messages.

## 4. Findings, decisions, approvals, code changes, artifacts

- **Findings**: `team_findings.status` extends to open, accepted, disputed,
  fixed, resolved, dismissed (keep wont_fix readable as dismissed); add
  `owner_participant`, `file_path`, `line`, `raised_run_id`,
  `resolved_run_id`. Runtime ops `set_finding_status {findingId, status, runId?}`.
  Chat shows a finding card (category · severity · title (agent text, attributed
  to the raising agent) · raised by · owner · status · file:line). Blocking /
  important open findings still block PASS; disputed counts as open.
- **Decisions**: chat shows "Decision" + a human title. Title source is
  recorded: `title_source 'threadlink'` (fixed runtime text, e.g. "Roles chosen")
  or `'agent'` (then the card is attributed to that agent's run). IDs
  (TL-00001) only in Details.
- **User choices / approvals**: `public.user_choices(id tlchc_, owner, chat_id,
job_id, kind check (provider_failure, timeout, plan_disagreement,
migration, production_deploy, destructive_action, security_action,
paid_usage, permission_expansion, secret_change), title (fixed per kind +
trusted params), options jsonb [{key, label}] from a per-kind allow-list,
status (pending, chosen, expired, cancelled), chosen_key, decided_at,
decided_by)`. Created by the Runtime (op `request_choice`) or server; decided
  by the owner (`decide_choice`, Clerk). The Runtime reads the decision with
  op `read_choices`. Durable, audited. 0.10 real uses: provider failure
  (Retry same agent · Use <other> instead · Stop), timeout (Retry step ·
  Retry with <other> · Increase timeout · Stop), plan disagreement beyond
  budget. Other kinds exist for future flows (no fake uses).
- **Code change cards**: after a unit build, op `add_change {nodeKey, runId,
filesChanged int, insertions int, deletions int, files text[] (≤200, repo-
relative, redacted), branch, commit, tests [{command, ok}]}` → chat row
  `code_change` (agent-attributed to the builder run) + a diff artifact.
- **Artifacts**: `public.chat_artifacts(id tlart_, owner, chat_id, job_id null,
run_id null, kind check (report, plan, diff, test_report, notes, export,
user_attachment), title, mime, content text ≤ 512 KiB (redacted), bytes,
created_by 'runtime'|'owner', created_at, deleted_at)`. Runtime op
  `add_artifact`; owner RPC for text attachments (≤ 64 KiB, kind
  user_attachment; never forwarded to providers unless the user mentions it in
  a message to that job — then only as a delimited excerpt ≤ 8 KiB).
  Final report artifact (markdown) is generated by the Runtime from job data.
- **Final summary**: at the end the database posts a ThreadLink `job_summary`
  row built from job data only: verdict, counts of findings by severity/state,
  units done, tests run/passed (from evidence), agents who took part, final
  verifier, remaining open items count; plus links to report/findings/changes.

## 5. User control and delivery states

- Owner messages get `delivery`: sent → queued (for <participant>) → seen
  (consumed by <participant>'s run, with run id) | not_delivered (job ended).
  `read_owner_notes` records which run consumed each note.
- Controls (owner RPC `control_job(job, action)`): `pause_after_step`,
  `stop_after_review`, `stop_before_integration`, `stop_now`, `cancel_queued`,
  `resume`. Stored on `team_jobs.control` + `control_requested_at`; Runtime
  honours at the named boundary; `stop_now` aborts running provider
  processes (supported cancellation = process kill of processes ThreadLink
  started, never others). Each is a ThreadLink row "Stop requested: after the
  current review." etc.

## 6. Timeouts, stalls, crash recovery

- Timeout policy per step kind (defaults, project-overridable within bounds):
  normalise 10 min, plan 15, plan review 15, build 30, review 30, security
  review 40, inspection 30, verify (tests) 30. Bounds 2–120 min.
- A timeout ends the run `timed_out`, writes a `timeout` choice (§4) and a
  ThreadLink row "Claude Code timed out after 30 min while reviewing
  auth-module." (provider, step, duration from trusted state). The job waits
  (status `needs_user_decision`) up to 24 h, then ends NEEDS_FIX.
- Stall: run `last_activity_at` older than 3 min while running → UI "No output
  for 4 min" (not failure). Runtime heartbeat/lease already exists; runtime
  offline → "Nickron's PC is offline. Work continues when it reconnects." for
  queued work; running work shows "Interrupted" once the lease expires.
- Crash recovery: on Runtime start, for each job it held (claim lease), classify
  from durable state + worktrees + its process registry:
  `completed_unsynced` (set_final pending → resend idempotently),
  `resumable` (between steps, nothing running) → continue,
  `interrupted` (a write step was running) → never re-run automatically; post
  an `interrupted` choice (Resume from last safe step · Stop), job status
  `interrupted` (new). Idempotency keys on every op that starts work.
- Process registry: Runtime keeps `{pid, provider, runId, jobId, startedAt}`
  for processes it launched (in memory + configDir file); never kills others.

## 7. Chat cursor, pagination, search, unread

- Per-chat sequence: `chat_events.chat_seq bigint`, unique (chat_id, chat_seq),
  assigned by trigger from `chats.last_event_seq` (row lock). Poll API uses
  `after=<chat_seq>` scoped to the chat; the global `seq` is no longer exposed
  to clients (kept internally). Rows without chat (legacy room-less) keep
  global paging only through the old room route.
- `before=<chat_seq>&limit` for older pages; default page = latest 100.
- Search: `search_my_chats(query, filters)` over chat names, project names,
  visible message bodies, finding titles, decision titles, artifact titles
  (owner-scoped, trigram or ILIKE with limits).
- Unread counts only `visibility='visible'` rows authored by agents/controller/
  ThreadLink-important types (job_summary, job_verdict, choice, finding
  blocking/important, provider_blocked). Needs-attention stays separate.

## 8. Health, execution host, protocol version

- One freshness calculation (server `effective_health`): Ready (checked ≤ 2 h)
  shows "Ready · checked 23 s ago"; older → "Stale · last checked 2 h ago"
  (never "Ready" + stale text). Plus runtime presence: Online / Offline (last
  heartbeat), Working (a run active).
- Chat header: "Runs on <runtime label>" + online state + agents' health.
- Protocol: `RUNTIME_PROTOCOL = 10` (runtime sends in heartbeat/register);
  server `min_protocol_for(feature)`; outdated → friendly "ThreadLink on
  <host> needs an update before Team work can start" + installer link.

## 9. Clients

- **Web**: redesigned chat (§3, §4, §5), sidebar (Pinned · Projects (chats) ·
  Groups · Recent), onboarding (connect agents → first chat), Agents = provider
  control centre (provider-specific execution settings, native sessions),
  project hub, provenance drawer, artifacts panel, search, keyboard shortcuts,
  mobile-safe, virtualised/paginated timeline.
- **Desktop**: nav Home · Chats · Agents · This computer · Notifications ·
  Settings. Chats list + the same chat timeline (read + post) through a
  runtime-credential chat API. Provider-specific concepts (background worker,
  exact conversation, headless session, native sessions) only under Agents →
  Claude Code. No global "Claude is open" badge.
- **Terminal**: `threadlink chats | chat <name|id> | new --project P --mode team |
agents | status`, using the Runtime's stored device credential (no pasted
  secrets). Same server chat API; posts as the owner with client "terminal".
- **Runtime-credential chat API** (server): `GET /api/runtime/chats`,
  `GET /api/runtime/chats/<id>/events?after|before`, `POST /api/runtime/chats/<id>/messages`,
  `POST /api/runtime/chats` (create), `POST /api/runtime/chats/<id>/read`. Allowed
  only for an active Runtime credential of the same owner; rate-limited;
  message author = owner, `client` = desktop|terminal recorded.
- **MCP chat-first tools** (keep old ones): `list_chats`, `get_chat`,
  `create_chat`, `send_message` (routes like the owner composer but authored as
  the controller), `get_chat_status`, `get_job_result`. Friendly names in
  responses; IDs only as opaque handles.

## 10. Provider capabilities and certification

- Runtime `ProviderCapabilities` (see brief §22) per adapter, consumed by the
  orchestrator/UI instead of provider switches. Reported to the server with
  detection (`detected.capabilities`).
- `tests/runtime/provider-certification/` harness: a table of required checks
  (install discovery, subscription auth, API-key detection, model selection +
  observed verification, read-only and workspace-write enforcement,
  cancellation, timeout, structured output, native session id, resume,
  wrong-session detection, secret stripping, quota, crash, concurrency,
  terminal-safe argv, worktree isolation) run against fake CLIs for every
  adapter and optionally the real CLIs (`THREADLINK_REAL_AGENTS=1`). A provider
  is "Supported" only if it passes.
- Research: `docs/research/provider-matrix.md` (Cursor, Windsurf, Gemini CLI,
  others) — documented automation only.

## 11. Versions

Runtime and desktop 0.10.0; `RUNTIME_PROTOCOL = 10`.

## 12. Deviations and limitations

(Filled in by each engineer with anything not done exactly as above.)

### API engineer (credential chat API, MCP chat tools, export)

- **Names.** Runtime SQL: `public.runtime_list_chats / runtime_get_chat / runtime_chat_events /
runtime_create_chat / runtime_post_chat_message / runtime_mark_chat_read`; controller SQL:
  `public.controller_list_chats / controller_get_chat / controller_create_chat /
controller_post_chat_message / controller_chat_status / controller_job_result`
  (migration `20260927000300_chat_api.sql`, anon-only grants, credential-authenticated). Wire
  shapes: `docs/chat-api.md`.
- **Cursor naming.** The per-chat cursor is exposed as `cursor` / `lastReadCursor` /
  `oldestCursor` (values are `chat_seq` / `last_read_chat_seq`), never `seq`, so no client can
  confuse it with the global sequence. `POST …/read` takes `{cursor}`.
- **Client recorded** in a new nullable column `chat_events.client` (`web|desktop|terminal`, owner
  rows only), set by a BEFORE INSERT trigger from a transaction-local setting written only by
  `runtime_post_chat_message`. Web posts leave it null (the owner RPCs were not changed).
- **Runtime scope.** Any active, unpaused Runtime of the owner sees all of the owner's chats (not
  only chats whose project runs on that computer); `thisComputer` tells the client which do.
- **Controller `send_message` is stricter than the owner composer:** it starts a job only when
  nothing runs in the chat. It cannot add notes to, or stop, running work (`job_active`) because a
  controller row may only be a `request` (chat_events_author_event); allowing notes would need a
  new author/event pairing and Runtime support. A failed health gate stores nothing (the owner path
  stores the message + a `provider_blocked` row). Solo in a review-required project is refused.
- **Controller reachability** = an active (not deleted/archived) project whose agent session is
  the target of one of the calling session's own `active` links (a paused link still reads; posting
  is then refused `link_paused`). Chats with no project are never reachable by a controller.
  `get_job_result` also accepts a job this session started even if its chat is no longer reachable.
- **Unread / delivery** follow migration 0200 (`chat_counts_unread`, `queued_for`,
  `consumed_by_run_id`); `unreadCount` is capped at 100. Live run activity rows (`agent_runs`) are
  not yet in the runtime events response (the web reads them through the owner path).
- **Export** (`/api/dashboard/chats/<id>/export?format=md|json`): visible messages + job outcomes
  only, newest 10,000 messages; no ids of any kind; bodies re-redacted in TS (mirrors
  `redact_text`); Markdown escaped. Artifacts and findings detail are not included in 0.10.
- **Reads are rate-limited** per owner (300/min across credential chat reads, bucket
  `chat_api_read` in `owner_action_log`), which means credential reads write a small log row.

### Desktop + terminal engineer

- **One client for both.** `runtime/src/chat-client.ts` (`ChatClient`, `chatClientFor(ctx, client)`)
  holds every path/field name of the runtime chat API (docs/chat-api.md) and reuses the stored
  Runtime credential (`loadConfig` + `loadToken`); the token only goes into `Authorization`.
  Exported from `runtime/src/index.ts` so the desktop app embeds the same code.
- **Health freshness** is computed in two places with the same rule (≤ 2 h Ready, else "Stale ·
  last checked …"): `desktop/src/health.ts` (`freshnessOf`, main derives it and the renderer only
  displays it; main re-broadcasts every 30 s while the window is visible) and
  `runtime/src/tui/format.ts` (`freshness`). Neither shows Ready beside stale words.
- **Live activity rows** are rendered when the events page carries `live` / `liveActivity` /
  `runs`; the runtime events route does not include them yet, so none show today.
- **Delivery states** are shown on the owner's rows as they were when the row was fetched; a row
  already on screen is not re-fetched when it moves from queued to seen (the cursor only returns
  new rows).
- **"Update needed"** reads `runtime.updateRequired` / `runtime.minProtocol` from the
  register/heartbeat answer (and the protocol from `RUNTIME_PROTOCOL` once exported); the
  download button opens `<baseUrl>/download`.
- **Per-binding wording.** An exact-conversation binding whose Claude conversation is open says
  "Waiting: open in Claude Code" under Agents → Claude Code only; there is no global "Claude is
  open" status anywhere (tray, status pill, Home).

### Runtime engineer

- **Wire.** Every 0.10 payload is built and every answer field read in `runtime/src/team/wire.ts`
  (checked against `lib/team/model.ts` `teamWriteOpSchema` in tests). Ids are read strictly
  (`tlarn_`/`tlchc_` + 32 hex); anything malformed is null and the Runtime fails closed. A server
  that refuses `run_started` stops the job: a 0.10 Runtime needs a 0.10 server.
- **Messages.** The posted body is the run's `teamMessage`; if a run omits it, that same run's
  own `summary` is used; if neither exists nothing is posted. The 0.9 "X should own Y: reason"
  rows (ThreadLink-composed text attributed to the reviewer) are gone; objections reach the
  planner only inside the review. Types: normalise → `proposal` (coordinator), plan →
  `proposal`, revision → `response`, reviews and the final inspection → `review`, build →
  `completion`, fix → `response`. Replies: review → build/plan message; fix → first finding
  (`replyTo {kind:"finding"}`, all findings in `refs`); re-review → fix message.
- **Activity.** Claude runs with `--output-format json` (unchanged), so its activity is
  phase-level only (sent in `run_started.activity`). Codex item types map to the fixed enum
  (`activity.ts`); a command's text is only tested locally for "looks like tests". Updates are
  sent ≤ 1 per 5 s per run and only after a real event, never on a timer, so a silent run shows as
  stalled.
- **Findings.** Runtime transitions: open → fixed | disputed (builder's `findingResponses`) →
  resolved | open | dismissed (re-review's `priorFindings`). A prior finding a re-review does not
  mention is resolved (0.9 rule). `accepted` is never set by the Runtime. Planning objections
  are resolved when the reviewer approves the plan.
- **Decisions.** All Runtime decisions are `titleSource: "threadlink"`, titled with the server's
  `decision_fixed_titles()` exactly (unit names moved into the resolution): Roles chosen, Plan
  agreed (also Solo/Pair "plan recorded"), Unit owner changed, Integration order chosen (units
  serialised because they touch the same files), Work split into units. Six Runtime decisions
  have **no honest fixed title** and are therefore not sent as decisions; they go to the job's
  evidence (`uncertainty`, shown in the final report and summary) instead: plan not agreed,
  agents disagree, out-of-scope changes undone, unit cannot start from its dependency, merge
  conflict, no model to use. The server list should gain titles for these (lead to reconcile;
  map in `wire.ts` `DECISION_TITLE_FOR`). No agent-titled decisions in 0.10.
- **Choices.** `provider_failure` for quota / sign-in / provider errors, `timeout` for timeouts;
  model or sandbox mismatch and "not installed" still stop BLOCKED (no choice). "Use other" /
  "Retry with other" is offered only when an eligible participant exists (never the unit's
  reviewer for a build, never an author for its review, never the integrator for the
  inspection) — with two providers a build failure never offers it. The Runtime polls
  `read_choices` every 15 s for up to 24 h, then ends NEEDS_FIX. The waiting status is set by
  the server when the choice is created (`paused`, per the migration, not
  `needs_user_decision`); the Runtime sends the phase again after a decision. Without
  `request_choice` the job stops exactly as in 0.9. `plan_disagreement` offers `extra_round` /
  `stop`; an extra round needs the server to accept `open_round` past the budget after the
  owner decided.
- **Controls.** Read from every write answer, and during a run polled through
  `read_choices {choiceIds: []}` every 15 s (there is no read-only state op). The 0.9
  `stopRequestedAt` is read as `cancel_queued`. `pause_after_step` sends `set_status paused`, then
  the phase again on `resume`. `ack_control` is sent (best effort) when each control takes
  effect. `stop_now` aborts every run of the job (process-tree kill of the child ThreadLink
  spawned) and kills the job's entries in the in-memory process registry; pids read back from
  `configDir/team-processes.json` are never killed.
- **Timeouts.** Read from the job document's `timeouts` (or `policy.timeouts`), minutes per step
  kind, 2–120, refused otherwise; the server must put the project's overrides there. Fix rounds
  use `build`; `verify` applies to ThreadLink's own test commands.
- **Crash recovery.** Journals live in `configDir/team-jobs/<job>.json`. `resumable` is narrower
  than §6: only when no write step ever started (there is no checkpoint to continue from, and
  re-running a finished build would be a blind re-run). A job with a finished build and nothing
  running is `interrupted`. "Resume from last safe step" re-runs the job as a new attempt (new
  `-rN` branches and run keys; read-only steps are run again, for real, and post new messages).
  Recovery acts when the carrier task is redelivered after its lease expires (writes are
  claim-gated); the engine classifies at start (`recoverTeamJobs()`, `teamRecovery()`) for
  display only. With no choice support an interrupted job ends NEEDS_USER_DECISION
  (`unexpected_error`). Synced journals are removed after 7 days. A job already running in this
  process is refused, never run twice.
- **Continuity.** Sessions are remembered per job in memory, keyed by participant and step
  (never across jobs or chats); planner revisions and unit fix rounds resume, everything else is
  fresh. Codex "open in provider" is not offered (unverified).
- **Changes and artifacts.** `add_change` carries the unit's diff (`diff`), which the server stores
  as the diff artifact, instead of a separate `add_artifact`; `tests` is `[]` per unit (ThreadLink
  runs the owner's tests at integration; an agent's own claim is not evidence). No change card
  without a run id. The final report is `add_artifact {kind: "report"}` sent before `set_final`
  (idempotent `requestKey`); a failure to store it never blocks the verdict.
- **Capabilities** go to the server as booleans merged into `detected.capabilities` (the server
  accepts a boolean record); the full registry is exported for the desktop app
  (`capabilitiesReport`). `AgentProvider` is still the two supported ids; participant keys are
  `<provider>:<role>` and Team Mode schedules over any number of builders and reviewers.
- **Certification** (`tests/runtime/provider-certification/`): real mode
  (`THREADLINK_REAL_AGENTS=1`) runs only the real-safe checks (discovery, subscription auth,
  model, read-only, structured output, session id, resume, argv, working directory); API-key,
  mismatch, write, cancellation, timeout, wrong session, secret stripping, quota, sign-in
  failure, crash and concurrency are fake-only.
- `record_usage` reports a cancelled run as `provider_error` (`USAGE_OUTCOMES` has no
  `cancelled`). `run_finished.exitClean` is "the run completed".
- **Security review (runtime).** Agent environments drop every `THREADLINK_*` variable (the
  Runtime credential `THREADLINK_BRIDGE_TOKEN` included; applies to Team runs, the single-task
  executor, git and verify commands). A generic `*_TOKEN` rule is not used because it would
  strip `CLAUDE_CODE_OAUTH_TOKEN` (subscription sign-in). Recovery fails closed: an unreadable
  journal is `interrupted`; a write step on record survives new attempts; a journal of another
  live Runtime process (pid alive and journal written in the last 125 min) makes the task
  refused, not recovered; a server refusal of a write-role `run_started` (matched in
  `wire.ts isInterruptedRefusal` on `interrupted|resume_required|awaiting_resume|needs_resume`
  in the error kind/message — reconcile with the server's exact code) becomes the owner's
  `interrupted` choice, at most twice per task. Shared diffs (`add_change.diff`) exclude
  `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`, `.npmrc`, `.pypirc`,
  `credentials*`, `secrets*` at any depth via git pathspecs and name them only ("1 file not
  shown: .env"); reviewer prompts still see the full unit diff locally. `modelVerified` is set
  only by a runner after its own model check. `killTree` never signals an exited child.
  Idempotency keys are sent as-is when already valid, else `k:` + first 32 hex of SHA-256
  (`wire.ts wireKey`). Solo/pair post no "Plan agreed"/"Work split into units" decision and
  their choices name no unit.

### Database + core server engineer

Migration `20260927000200_threadlink_0_10.sql`, `lib/chat/**` (`work.ts` is new), `lib/team/**`,
`lib/providers/**`, owner routes under `/api/dashboard/**`; details in `docs/team-mode-server.md`.

- **Protocol gate kept at the 0.9 rule for job starts.** `min_protocol_for`: team 7, solo/pair 8
  (as before), `job_control` / `choices` / `runs` 10. A Runtime that reports no protocol counts as
  its minor version (0.9.x = 9; 1.x = 10). So 0.9 Runtimes keep running work during the rollout;
  what protocol 10 changes is that its agent messages and findings MUST carry a run
  (`run_required`) and its decisions a `title_source` (`title_source_required`). Raise the
  start minimum later by replacing `min_protocol_for`. Every register/heartbeat answer carries
  `protocol`, `protocol_reported`, `min_protocol` (10) and `update_required`; a heartbeat without
  a protocol clears the stored one (a downgraded Runtime is judged by its version again).
- **Registry reads** go through `public.agent_providers_list()` (anon + authenticated): the
  table has RLS on and no policy, because the schema keeps its rule "no permissive
  `USING (true)` policy on any table" (001_tenant_isolation).
- **Provider checks replaced**: `chat_events.author_provider` (FK), `chat_events.audience`
  (pattern + registry check in the `chat_events_v10_prepare` trigger), `room_agents.provider`
  (FK), `agent_runs.provider` (FK). **Kept** (fixed `claude-code|codex` checks or
  `team_providers()` validation): `team_nodes` owner/reviewer, `team_messages` sender/receiver,
  `team_findings.raised_by`, `plan_approved_by` / `approved_by`, `model_usage_events.provider`,
  `provider_profiles`, `runtime_provider_health`, `chats` solo/builder/reviewer, `team_jobs`
  builder/verdict_provider, and the job-start / post routing (`team_providers()`).
  `ChatEvent.authorProvider` / `audience` keep their 0.9 unions (null for any other id); the raw
  registry ids are in the new `authorProviderId` / `audienceId`.
- **Native session id** is not a readable column for `authenticated` (column grants);
  `reveal_run_native_session` returns it (audited `team.native_session_revealed`, 30/min) with
  `resume_command` only for a `claude_session` (`claude --resume <id>`). Uniqueness: the same
  (owner, provider, native_session_id) may only appear on runs of ONE chat and ONE project
  (trigger, `42501` hint `native_session_reused`); another account may coincide.
- **Verified** is computed from `verification.nativeSession` (set by `run_finished`), never from
  the id itself, plus completed + model + access verified + the run's Runtime = the project's
  Runtime. Everything else is `partial` with fixed notes; rows without a run are `legacy`.
- **Finding cards reuse `finding`** (with a payload); a status change writes no new row (the UI
  reads `/findings`). Open for PASS and node approval = open, accepted, disputed, **fixed** (a
  fix stays open until a reviewer resolves it). Dismissing (or `wont_fix`) a blocking/important
  finding needs a decision, as `wont_fix` did.
- **Decision titles.** `title_source 'threadlink'` accepts only the fixed titles in
  `decision_fixed_titles()` (Roles chosen, Plan agreed, Plan changed, Work split into units,
  Unit owner changed, Reviewer chosen, Finding dismissed, Finding disputed, Disagreement settled,
  Integration order chosen, Merge conflict resolved, Model chosen, Timeout extended, Retry
  chosen, Agent replaced, Stopped by you, Resumed after interruption); anything else must be
  `agent` with the author's run. Decisions without a title source keep the 0.9 row.
- **Choices.** Option keys per kind: provider_failure {retry, use_other, stop}; timeout {retry,
  retry_other, increase_timeout, stop}; plan_disagreement {accept_proposal, accept_other,
  extra_round, stop}; interrupted {resume, stop}; the approval kinds {approve, deny}. `use_other`
  / `retry_other` / `accept_other` exist only when `other_provider` is given. Params are
  participants, a fixed step word (`choice_steps()`; the TS layer maps the Runtime's step kinds),
  minutes and a node key. `request_choice` sets the job to `paused` (`needs_user_decision` is a
  terminal verdict status in the schema, so it cannot be the wait); the Runtime sets the phase
  again after the answer. A pending choice past 24 h reads as expired and `read_choices` marks
  it; a pending choice blocks PASS; a finished job cancels its pending choices. Each
  `plan_disagreement` answered `extra_round` lets `open_round {kind: planning}` open ONE round past
  the budget (`team_jobs.extra_planning_rounds`; the status's planning `max` includes it).
- **Step timeouts.** `rooms.step_timeouts` (minutes per step kind: normalise, plan, plan_review,
  build, review, security_review, inspection, verify; 2-120), set by the owner with
  `set_room_step_timeouts(room, jsonb)` (`lib/rooms` `setMyRoomStepTimeouts`); a new job's
  carrier carries them as `timeouts` (a trigger on the carrier insert). No UI for it yet.
- **Search filters.** `search_my_chats(q, limit, filters)` overload: projectId, provider (the
  chat's project has that agent enabled), mode, status (`running` | `idle`), from/to (the hit's
  time); applied to the newest 50 hits per kind.
- **Project hub** (`getMyProjectHub`): verification commands, repository (workspace remote and
  branch) and execution host (label, online = heartbeat within 2 min, version, reported
  protocol). `detectedTooling` is always `[]`: no Runtime report of tooling exists in 0.10.
- **Code changes.** `add_change` needs a builder/integrator run; the diff artifact exists only
  when the Runtime sends `diff` (≤ 512 KiB, redacted). Files must be repo-relative (no `/`,
  drive, backslash or `..`).
- **Job control.** Stored on `team_jobs.control`; the Runtime clears it with `ack_control
{control}` once honoured (only if unchanged). On a Runtime before protocol 10 only `stop_now` is
  accepted, and it also sets `stop_requested_at` (the 0.9 stop). A finished job answers
  `job_finished`; `resume` with nothing paused/interrupted answers `nothing_to_resume`.
- **Delivery.** `queued_for` is set by trigger on an owner note to a running job (the audience,
  or every participant for `team`); `consumed_by_run_id` by `read_owner_notes {run_id}` or
  `{note_ids, run_id}`. A note delivered before 0.10 (no `queued_for`) reads as `sent`, not
  `seen`.
- **Summary.** `job_summary` is written by the `team_jobs` update trigger with the verdict (job
  data only: findings by severity/state, units, tests from `evidence.tests[].ok`, agents that
  ran, the last completed reviewer/integrator as final verifier, open items, pending choices,
  the newest report artifact, code-change count). Open runs of a finished job become `cancelled`.
- **Per-chat cursor.** `chat_seq` = the chat row's `last_event_seq` (row lock) or the chat's
  highest existing `chat_seq` + 1, whichever is larger. The 0.9 global `seq` stays in
  `/api/dashboard/chat` and `mark_chat_read` (deprecated, working; both cursors kept in step).
  On `/events` every event's `seq` equals its `chatSeq`.
- **Unread** also counts `timeout` and `interrupted` rows; capped at 100 (`chat_list_extras_v2`).
  The chat list falls back to the 0.9 rule when v2 is absent.
- **Search** is ILIKE (wildcards escaped), 2-100 chars, ≤ 50 results, a 5 s statement timeout;
  no trigram index in 0.10.
- **Attachments** are never forwarded to a provider by the server (the "mention it, send an
  ≤ 8 KiB excerpt" flow is not implemented server-side). Downloads are attachments with
  nosniff, a sandbox CSP and no-store; a diff is served as text/plain.
- **Long idempotency keys** from the Runtime (run keys, choice keys over 128 chars or with other
  characters) are stored as `k:<64-bit FNV pair>:<length>` (`wireKeyToSql`, deterministic).
- **Timeouts** per run are bounded 1 s-120 min server-side (the 2-120 min policy bounds belong
  to the Runtime).
- **Security review fixes (server).**
  - I1: `runtime_post_chat_message` and `runtime_create_chat` (with a project) refuse unless the
    project runs on the calling Runtime (`room_runtime(room) = caller`): `42501` hint
    `other_computer`, DETAIL = that computer's label; the API answers 409 "This chat runs on
    <label>. Send from that computer or from the web." Reads stay broad. A chat with no
    project, or a deleted/detached one, is left to the post path's own refusals.
  - I3: a carrier re-claimed (attempt > 1, new claim ref) while its job had a builder/integrator
    run or a run still going: open runs become `interrupted`, the job `interrupted`, and an
    `interrupted` choice (request key `server:reclaim:<attempt>`) is posted; `run_started` for
    builder/integrator answers `55000 interrupted_needs_owner` until the latest such choice is
    chosen `resume`.
  - I4: `redact_text` (and the export's TS mirror) also redacts env/shell/YAML/JSON assignments
    to names ending in KEY/PASS/CREDS/CREDENTIALS (upper case or after `_`), plus
    `credentials`/`creds`/`pass` in any case. The Runtime's own redaction
    (`runtime/src/summary.ts`) was not changed.
  - M1: the stored protocol is the highest ever reported (calls without one never clear it) and
    the protocol that counts is max(reported, version-derived). A Runtime that once reported 10
    can no longer write runless agent messages even after a downgrade.
  - M2: a message with a run carries the run's observed model; a different `model_observed`
    is refused (`model_mismatch`).
  - M4: native session ids start alphanumeric; a `claude_session` id must be a UUID.
  - M5: search is limited to 30 per owner per minute and scans the owner's newest 5000
    visible rows (no trigram index); both search functions are VOLATILE now.
  - M6: long idempotency keys are "k:" + the first 32 hex of SHA-256, the same as the
    Runtime's `wireKey`.
  - M8: owner and credential chat routes stream request bodies with a byte cap
    (`lib/http/body.ts`).
  - M12: `decide_choice` / `control_job` answer "not found" for a deleted chat or project.
  - Solo and Builder + Reviewer jobs write no "Planning" phase separator.
