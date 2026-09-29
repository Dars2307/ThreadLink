# ThreadLink 0.11 — UX reset, Fast Chat, presence, quota failover

Status: contract for the 0.11 phase. Baseline 0.10.2 (main `9b20ffd`, protocol 10).
Every engineer reads sections 0–3 and their own section. Deviations go in §12, never silently.

## 0. Ground rules (unchanged)

All 0.10 rules stand (docs/design/threadlink-0.10.md §0). In particular: no fabricated dialogue,
no private reasoning, ThreadLink-owned IDs are canonical, fail closed, RLS, no paid/API usage
(never buy credits, never switch to API-key billing, never hide a provider change), secret
stripping, provider identity + model provenance, worktree isolation for edits, no forged
ThreadLink rows, no cross-user access, no cross-chat/cross-project native session reuse.
Schema changes are additive. New migration file: `supabase/migrations/20260929000100_threadlink_0_11.sql`.
Version: **0.11.0**. Runtime protocol: **11** current, minimum stays **10** (a 0.10 Runtime keeps
working; it just never receives Fast Chat work — see §2.4).

## 1. Root causes (measured / confirmed in code)

1. **Presence "offline while working"**: `RuntimeEngine.run()` sends the Runtime heartbeat from the
   same loop that awaits `deliverOnce()`. A Team job holds `deliverOnce()` for its whole duration,
   so no heartbeat is sent; after 2 min `chat_host_status` says `offline` (the offline test is
   evaluated _before_ the "runs active" test).
2. **Pickup latency**: idle polling backs off 2 s → 32 s (`nextDelay(min(idle,4))`). A message
   sent after a quiet minute waits up to ~32 s before the Runtime even sees it.
3. **Head-of-line blocking**: `deliverOnce()` awaits each task to completion, sequentially. While a
   Team job runs, nothing else in any chat can run (no mid-job questions).
4. **Every message is engineering work**: `chat_post` turns any message without an active job into a
   `team_start_job_v2` job → normalise/plan/plan_review/build/review/integrate/inspect. "@team hi"
   runs the whole DAG.
5. **Sequential provider turns** inside the orchestrator where no dependency exists.
6. **ThreadLink narration**: routine rows (job started, phases, rounds, roles, run start/finish,
   decision ids) are `visible` and dominate the chat.
7. **Quota rigidity**: `usage_exhausted` blocks the job / offers "Retry Codex", which retries the
   same exhausted provider; typed "@Claude continue" becomes a queued note and the choice stays open.

## 2. Execution lanes (the core change)

### 2.1 Concepts

- **Mode** (existing, per chat): solo / pair / team — _who_ participates.
- **Lane** (new, per job): `chat` (Fast Chat) or `work` (Engineering Work) — _how_ it runs.
- Owner-facing execution setting per message: **Auto** (default), **Chat only**, **Run work**.

### 2.2 Data

`team_jobs.lane text not null default 'work' check (lane in ('chat','work'))`. All existing rows are
`work`. A chat-lane job is a lightweight container that reuses tasks/claims/runs/provenance/
`team_job_write`; it never has plan units, worktrees, integration, verification or a verdict
(`verdict` stays null; finished status `completed` or `failed`/`cancelled`).

`team_jobs.failover_policy text` snapshot of the owner's preference at job creation (§5).

### 2.3 Routing (server, `chat_post`)

The TS layer classifies (`lib/chat/intent.ts`, pure, unit-tested) and passes `p_lane` in
(`'chat' | 'work'`) to a new overload of each post RPC (owner `post_chat_message`,
`runtime_post_chat_message`, `controller_post_chat_message`). Old overloads keep 0.10 behaviour
(`work`). Order of precedence inside `chat_post`:

1. Stop pattern → stop requested (stops the active work job AND any active chat jobs in this chat).
2. Open choice in this chat + message clearly answers it (§6) → resolve the choice, store the
   message, no new job.
3. `p_lane = 'work'` and an active **work** job exists → note to that job (0.10 behaviour).
4. `p_lane = 'work'`, no active work job → new work job (0.10 path).
5. `p_lane = 'chat'` → new chat-lane job, **even while a work job is running** (mid-job questions).
   Chat-lane jobs of one chat are processed FIFO by the Runtime.

If the chat's execution Runtime reports protocol < 11, `chat` is downgraded to `work` (a 0.10
Runtime would run the full pipeline otherwise) — and the owner row's payload records `lane: 'work',
laneReason: 'runtime_outdated'`.

The owner row's `payload` records `{ lane, laneReason }` (reason codes below) for Details.

### 2.4 Intent classifier (`lib/chat/intent.ts`)

`classifyIntent({ body, explicit?: 'chat'|'work'|null, activeWorkJob: boolean, mode }) →
{ lane: 'chat'|'work', reason: LaneReason, smallTalk: boolean }`.

Rules, in order (documented, deterministic, not a keyword list alone):

- explicit override (composer toggle or leading `/chat` / `/work`, stripped from the stored body) →
  `explicit_chat` / `explicit_work`.
- `smallTalk`: greeting/thanks/ack only (≤ 6 words, no imperative verb on a code object) → chat.
- **Work** when the message asks for a repository _action_: an imperative/request verb from the
  action set (fix, implement, add, build, create, write, change, edit, refactor, remove, delete,
  rename, migrate, upgrade, deploy, release, run, test, lint, commit, merge, integrate, patch,
  make … pass/work, set up, audit (+ repo/codebase), security review of the repo …) whose object
  refers to code/repo/tests/files/feature/bug (or is an unqualified task clause), including polite
  forms ("can you fix", "please run", "go ahead and implement", "okay, inspect the repo and fix").
  → `edit_requested` / `tests_requested` / `repo_action`.
- "Review/inspect/audit the whole repo / codebase / <project>" → `repo_review` (work).
- Questions, opinions, explanations, discussion, status, "continue", "what do you think",
  "explain finding 3", "review this finding", "@Claude check this idea" → chat
  (`question` / `discussion` / `status` / `continuation`).
- Default when unsure → **chat** (`default_chat`). Agents can escalate (§3.5).
- Negations ("don't change anything", "without editing", "do not run") force chat.

### 2.5 Fast Chat escalation

A Fast Chat agent answer may set `needsWork: true` with a one-line reason. ThreadLink then opens a
choice of kind `start_work` (options `run_work` "Run this as work", `keep_chatting` "Keep
chatting"). `run_work` starts a work-lane job whose goal is the original owner message (by event id,
stored in choice params). Typing "run it" / "go ahead" / "do it" resolves it (§6).

## 3. Runtime

### 3.1 Liveness, independent of work

- The Runtime heartbeat runs on **its own timer** (every 30 s), never blocked by delivery.
- Server: every authenticated runtime-credential call (inbox/wake, claim, task heartbeat,
  `team_job_write`) refreshes `runtimes.last_seen_at` (throttled ≥ 10 s) — work is liveness.

### 3.2 Wake-up latency

- New long-poll: `GET /api/runtime/wake?wait=<≤25s>` returns as soon as any task for this Runtime's
  sessions is queued (DB checked every ~750 ms server-side), or `{pending:0}` at timeout. The Runtime
  keeps one wake request in flight while idle; idle backoff remains the fallback if wake fails.
- Target: Runtime claims a Fast Chat task < 1.5 s after the owner's post is accepted.

### 3.3 Concurrency

- Claimed tasks run **in the background**; the loop keeps polling.
- Limits: work lane ≤ 1 concurrent job per workspace; chat lane ≤ 3 concurrent jobs overall,
  FIFO per chat. A chat-lane task can run while a work job runs in the same workspace.
- Each background task keeps its own lease heartbeat (existing worker behaviour).

### 3.4 FastChatCoordinator (`runtime/src/team/fast-chat.ts`)

No normalise/plan/review/integrate/inspect, no worktree, no DAG. Per chat-lane job:

1. Load scoped context: this chat's recent visible messages (owner + agents, last ~20, redacted,
   capped), participants, project name. Nothing from other chats.
2. Responders: mention → that agent; `@team` / team / pair → every **available** participant;
   solo → the solo agent. Unavailable (usage_exhausted/needs sign-in) agents are skipped with at most
   one quiet ThreadLink notice per chat per exhaustion (§5).
3. **First turns run concurrently.** Each agent's message is posted the moment it returns
   (`run_started` → `add_message` with runId → `run_finished`). Never wait for both.
4. Follow-up (bounded): when ≥ 2 agents answered and it is not small talk, one follow-up round,
   concurrent, where each agent sees the others' first answers and may reply only if it disagrees or
   adds something materially new (else it returns no message and nothing is posted). Max one
   follow-up round by default (config `FAST_CHAT_MAX_FOLLOWUPS`, hard cap 2). Replies set `replyTo`.
5. Providers run in the project folder, **read-only** (Claude `--permission-mode plan`, Codex
   `--sandbox read-only`), subscription auth, stripped env, identity/model verified as 0.10.
6. Native session continuity: one native session per (chat, provider, workspace), resumed on the
   next turn (Claude `--resume`, Codex `exec resume`), rotated after 30 turns or 24 h or on any
   resume failure; never shared across chats/projects. Run provenance records
   `sessionReason: 'resumed' | 'fresh_first_turn' | 'fresh_rotated' | 'fresh_resume_failed'`.
   The server's native-session reuse guard must allow reuse within the same chat and still refuse it
   across chats.
7. Output: concise conversational text (plus optional `needsWork`, `workReason`). Placeholder guard
   from 0.10.1 still applies.

### 3.5 Engineering lane changes

- Remove avoidable serialisation: independent provider calls start concurrently (e.g. team planning
  drafts/critiques, independent review units, reviews of finished units while other units build).
  Only serialise real dependencies (review after build, integration after units).
- Planning-round policy: minor technical disagreement resolves by bounded automatic negotiation
  (max 2 exchanges) then arbitration (coordinator's plan wins; objections recorded as findings).
  Ask the owner **only** for: product direction, security policy, data-loss risk, billing,
  irreversible architecture, unresolved requirement (agent must label the category).
- Human system text: never raw ids/reason codes in chat bodies.

### 3.6 Timing telemetry

Per run (stored in `agent_runs.timings jsonb`, sent with `run_finished`): `queueMs` (job created →
runtime claimed), `spawnMs`, `contextMs`, `firstEventMs`, `providerMs`, `persistMs`. No prompt text.
The owner row keeps `created_at` (accepted). UI measures "visible".

## 4. Presence

`chat_host_status` returns `presence ∈ online | working | reconnecting | offline`:

- `working`: the Runtime has queued/running agent runs whose last activity/heartbeat is < 3 min old
  (work is proof of life — never "offline" while this holds).
- `online`: last_seen < 75 s.
- `reconnecting`: 75 s ≤ last_seen < 3 min.
- `offline`: ≥ 3 min, or revoked/disabled.
  It also returns `last_seen_at` and `server_now` so clients can age it.
  Clients show **three separate things**: _You_ (this client's own connection to ThreadLink, from its
  own request success — never from the Runtime), _ThreadLink service_ (reachable / reconnecting), and
  _the execution host_ ("Nickron PC · Online/Working/Reconnecting/Offline"). Copy when the host is
  offline: "You're connected. Nickron PC is offline — repository work and agent replies will resume when
  it reconnects." Terminal/browser/other laptops never register or heartbeat as the execution Runtime
  (`threadlink status` stays read-only).

## 5. Usage exhaustion and failover

- Usage exhaustion is persisted as provider health `usage_exhausted` with optional `resetsAt`
  (ISO, only when the provider actually reported it; never invented) in `runtime_provider_health`.
- Router: `usage_exhausted` = unavailable. No new work is assigned to it.
- Owner preference (`public.user_settings.failover_policy`, `auto` | `ask` | `wait`, default
  **auto**), snapshotted onto each job:
  - `auto`: continue with another _included-usage_ healthy agent. ThreadLink says once:
    "Codex usage is exhausted. Continuing with Claude." + " Independent review will wait for Codex."
    when an independent review was required.
  - `ask`: choice `usage_exhausted`.
  - `wait`: the step waits; choice still offered.
- New choice kind `usage_exhausted`, options: `continue_other` ("Continue with Claude"),
  `check_again` ("Check Codex again"), `wait` ("Wait for Codex"), `stop`. **No `retry`**:
  `check_again` rechecks health; only if the recheck is ready does the step retry.
- `provider_failure` with a provider currently `usage_exhausted` never offers `retry`.
- Review integrity: if the required independent reviewer is unavailable, the job may finish the
  work but its verdict is **`REVIEW_PENDING`** ("Work complete · review pending"), never PASS.
- Recheck: at `resetsAt` + 1 min when known; otherwise at most every 15 min while a job waits on it;
  or on "Check again". When it becomes available: "Codex is available again. Resume the pending
  review?" (choice) — never auto-resume unless the job was explicitly waiting (`wait`).
- Never paid fallback, never API-key billing (0.9 rules unchanged).
- Setting UI: Settings → Agents: "When an agent's included usage runs out: Continue with another
  included agent (default) / Ask me first / Wait for the same agent".

## 6. Natural choice resolution (server, `lib/chat/choice-intent.ts`)

When a chat has exactly one open choice (or the newest open one), an owner message (web/desktop/
terminal — not controller) that clearly answers it resolves it via `decide_choice`, and the message
is stored normally (no new job). Mapping (case-insensitive, after @mention):

- `@Claude continue` / "use Claude" / "continue with Claude" / "switch to Claude" / "let Claude do
  it" → the option naming Claude (`use_other` / `retry_other` / `continue_other`).
- "stop" / "cancel" / "stop the job" → `stop`.
- "retry" / "retry Codex" / "try again" → `retry` if offered; for `usage_exhausted` →
  `check_again`.
- "wait" / "wait for Codex" → `wait`.
- "continue" / "resume" (interrupted) → `resume`; "run it" / "go ahead" / "do it" (start_work) →
  `run_work`; "keep chatting" / "no" (start_work) → `keep_chatting`.
- **Never** from natural language: approval kinds (migration, production_deploy,
  destructive_action, security_action, paid_usage, permission_expansion, secret_change). Those need
  the card.
- Ambiguous → not resolved; the message routes normally and ThreadLink adds nothing.
  The API response says `routed: 'choice_resolved'` with the chosen label.

## 7. Quiet ThreadLink (`runtime/src/chat-presentation.ts`, shared by web + desktop + terminal)

Pure module, no imports beyond types. `chatPlacement(event) → 'chat' | 'activity'`:

- **chat**: owner/controller/agent messages; ThreadLink rows that matter: provider_blocked/usage
  notices, choice (open or just decided), approval required, timeout, interrupted, job_summary /
  job_verdict (result), plan_agreed (one line), code_change cards, findings that are blocking or
  important and open, mode_changed, failover notices, errors that stop work.
- **activity** (drawer only): job_started, job_status, phase, unit_status, task_* rows, run
  start/finish, model_used/model_mismatch, roles/round rows, decision rows other than titles that
  matter, owner_routed, stop_requested echoes, control_requested, minor/dismissed findings,
  everything `technical`.
- `agentShortName(providerId)` → "Claude" / "Codex" / registry short name; full name only on the
  Agents page and provenance drawer.
- `humanSystemText(event)` never exposes ids/reason codes.
  Old 0.10 heavy jobs render through the same function (their routine rows fall into Activity).

## 8. Web (Next.js)

- Shell: sidebar (quiet: New chat, Chats, Projects, Agents, Notifications, Settings) + centre.
- Centre = **one scroll surface**: sticky compact header, the timeline as the only scrolling element,
  sticky composer. `html/body` do not scroll on the chat route (`h-dvh overflow-hidden` shell).
- Header: `Chat name · [MODE ▾] · •••`, sub-line `Project · Claude · Codex`, a status dot line
  ("● Working", "● Nickron PC offline"). Clicking status or ••• opens the **right drawer**.
- Drawer tabs: Activity, Progress, Findings, Details (host, agents, models, timings), Provenance.
  Chat/Progress/Details big tabs and provider health cards are removed from above the chat.
- Messages: no big cards. Owner right-aligned light bubble; agents left with small initial avatar,
  name + role, text, subtle timestamp on hover. Consecutive messages from one author group.
  Cards only for choices, approvals, code changes, results.
- Live indicators: one compact row per working agent ("● Claude · Reviewing authentication ·
  42 s ago"), shown at the bottom of the timeline, not in the header.
- Scrolling: stick-to-bottom only when within 120 px of bottom; otherwise show "Jump to latest"
  pill with unread count; preserve anchor when older events load (scrollHeight delta); no smooth-
  scroll hijacking of wheel input; no nested overflow.
- Composer: multiline autosize, Enter sends / Shift+Enter newline (current convention), @mention
  autocomplete, subtle `Auto ▾ | Chat only | Run work` control, Stop button while work is active.
- Performance: memoised rows, polling that does not re-render unchanged rows, content-visibility
  kept, no layout thrash on each poll; typing stays responsive (measure INP in the browser).

## 9. Desktop

Same IA: Home, Chats, Projects, Agents, Notifications, This computer, Settings. Opening a chat shows
the same layout as web (sidebar list, compact header, one scroll, sticky composer, right drawer),
the same timeline via the shared presentation module, the same unread state. Runtime version,
protocol, heartbeat, workspace bindings, logs, updates, execution-host details live under **This
computer**; provider setup under **Agents**. The old operations-console pages are folded into those.

## 10. Terminal

`threadlink chat` prints only `chat` placement rows by default (`--all` for activity), shows
presence as You / host, supports `/chat` and `/work` prefixes and natural choice answers (server
side). No registration or heartbeat from terminal commands.

## 11. Tests (minimum, beyond existing suites)

Fast chat routing (§2.4 table of examples), no worktree/DAG for chat lane, concurrent first turns,
bounded follow-up, session continuity + no cross-chat reuse, quota state + router + no retry offer +
check_again + REVIEW_PENDING, natural choice resolution, presence thresholds + activity-as-liveness,
UI scroll behaviour, placement function, real Production acceptance A–G (phase brief §66).

## 12. Deviations and limitations

(Engineers append here.)

### Database + server engineer — wire (published early for the Runtime / UI engineers)

Final details and deviations follow at the end of this section when the phase closes.

- **Carrier** (`tasks.content` of a team job, unchanged `version: 1`) gains `lane: "chat"|"work"`,
  `failoverPolicy: "auto"|"ask"|"wait"` (always) and, for chat lane only, `sourceEventId` (the
  owner's `tlcev_` message) and `responders: string[]` (provider ids: mention → that agent;
  @team / team / pair → every enabled participant of that mode; solo → the solo provider).
  Every `team_job_write` answer (team status) also carries `lane` and `failover_policy`
  (TS `TeamStatus.lane`, `TeamStatus.failoverPolicy`).
- **Chat-lane runs** use role `investigator` (no new role); access should be `read-only`.
- **Chat-lane ops**: allowed `add_message`, `run_started|run_activity|run_finished`,
  `read_chat_context`, `read_owner_notes`, `request_choice` (`start_work`, `usage_exhausted`,
  `provider_failure`), `read_choices`, `failover_notice`, `record_usage`, `add_artifact`,
  `ack_control`, `set_status`. Everything plan/DAG shaped (`set_spec`, `set_plan`, `upsert_nodes`,
  `set_node_status`, `open_round`, `add_change`, `add_finding`, `add_decision`, `set_final`) is
  refused `22023` hint `chat_lane`.
- `set_status` (chat lane): `completed | failed | cancelled` from any unfinished state (no
  verdict; `line` optional). The Runtime still completes the carrier task as for work jobs.
- `run_started` + optional `sessionReason`: `resumed | fresh_first_turn | fresh_rotated |
fresh_resume_failed`. `continuity: "resumed"` WITHOUT `resumedFromRunKey` is accepted (resuming
  a native session of an earlier job of the SAME chat); it is stored as continuity `resumed`
  with no resumed-from run.
- `run_finished` + optional `timings: {queueMs?, spawnMs?, contextMs?, firstEventMs?,
providerMs?, persistMs?}` (integers 0..86 400 000), stored in `agent_runs.timings`.
- `read_chat_context {limit?: 1..40, default 20}` → `result.chatContext` (TS
  `TeamWriteResult.chatContext`): `[{id, chatSeq, authorKind: "owner"|"controller"|"agent",
authorProviderId, authorLabel, replyTo, body, createdAt}]`, oldest first, visible
  owner/controller/agent message rows of THIS job's chat only, bodies re-redacted.
- `failover_notice {from, to: string|null, reviewPending: boolean, resetsAt: string|null}` →
  `result {eventId, created}`; `created:false` = deduped (same chat, same from/to, since `from`'s
  health last changed, at most 24 h). `from` must be a job participant that is really exhausted
  (a run of this job by `from` finished with failure `quota_exhausted`, or the project Runtime's
  health for `from` is `usage_exhausted`), else `22023` hint `not_exhausted`. Row: event type
  `failover`, ThreadLink, visible, fixed body "Codex usage is exhausted. Continuing with Claude."
  (+ " Independent review will wait for Codex."), or "Codex usage is exhausted." when `to` is
  null; payload `{from, to, reviewPending, resetsAt}` (clients localise the reset time).
- `set_final` accepts verdict `REVIEW_PENDING` (work lane): job status `review_pending`
  (terminal). From protocol 11, `PASS` is refused (`55000` hint `review_missing`) unless every
  unit with a reviewer has a COMPLETED run of that reviewer provider in a reviewer role.
- `request_choice` new kinds: `start_work` (params `sourceEventId` required = an owner message of
  this chat; options `run_work` "Run this as work", `keep_chatting` "Keep chatting"; the job is
  NOT paused; the choice survives the chat job finishing) and `usage_exhausted` (params
  `provider`, optional `otherProvider`, optional `resetsAt`; options `continue_other` "Continue
  with <other>" (only with otherProvider), `check_again` "Check <provider> again", `wait` "Wait for
  <provider>", `stop`). `provider_failure` never offers `retry` while that provider's health is
  `usage_exhausted` (silently dropped; if nothing is left, `stop`).
- Provider detection (`/api/team/providers` report) accepts `resetsAt` (ISO, only with health
  `usage_exhausted`, kept only within now−1 h … now+8 days; otherwise stored as null).
- `GET /api/runtime/wake?wait=<0..25>` (default 20) → `{pending: number}`; answers as soon as
  pending > 0 (checked every ~750 ms), `{pending: 0}` at timeout. 429 when rate-limited
  (120 wake requests/min per owner).

### Web engineer

Shared module `runtime/src/chat-presentation.ts` (pure, no imports; the web imports it as
`@/runtime/src/chat-presentation`; `runtime/src/index.ts` should re-export it for desktop/terminal).
Exports: `chatPlacement`, `CHAT_THREADLINK_TYPES`, `ACTIVITY_THREADLINK_TYPES`, `isApprovalKind`,
`agentShortName`, `agentFullName`, `scrubSystemText`, `failoverText`, `humanSystemText`,
`visibleChoiceOptions`, `resetsAtOf`, `resetTimeText`, `durationText`, `parseRunTimings`,
`runTimingsText`, `PRESENCE_ONLINE_MS`, `PRESENCE_OFFLINE_MS`, `PRESENCE_WORK_FRESH_MS`,
`parsePresence`, `hostPresence`, `hostPresenceLabel`, `hostOfflineNote`, `youPresence`,
`youPresenceLabel`, `serviceLabel`; types `ChatPlacement`, `PresentationEvent`,
`PlacementContext`, `ChoiceOption`, `RunTimings`, `Presence`, `PresenceTone`, `PresenceView`,
`ClientConnection`.

Placement decisions beyond the §7 list (all pinned in tests/chat-presentation-0-11.test.ts):

- Unknown ThreadLink event types default to **activity** (quiet by default). `job_status` is chat
  only when it says the work stopped (payload `status` failed/cancelled, or the 0.10 bodies "The
  job failed." / "The job was cancelled."). `task_failed` stays activity (the job-level row speaks).
- Findings: chat only when blocking/important AND open/accepted/disputed (latest state from the
  findings list wins); a later status-update row of the same finding is activity. Without payload
  (terminal client) the trusted body prefix "Blocking/Important/Minor finding" decides.
- Decisions (`decision`, `decision_card`): chat only when they need the owner (`requiresUser` or
  "needs your decision"); agent-titled decisions that do not need the owner are activity.
- `job_verdict` and `job_summary` are both chat (the contract lists both); this can show two
  result rows for one 0.10 job.

Web deviations / limitations:

- Composer: **Enter sends, Shift+Enter is a new line** (the contract's convention; 0.10 actually
  used Ctrl+Enter, which still sends). On touch keyboards (`pointer: coarse`) Enter is a new line
  and the Send button sends. Never sends while an IME is composing.
- `•••` is the chat menu (rename, pin, archive, project, group, delete) as before; the drawer
  opens from the status line and a "Details" button in the header (and from any message's
  Details). Export moved into Details.
- Drawer tabs are client state; `?panel=activity|progress|findings|details` and the 0.10
  `?tab=progress|details` (Alt+2/Alt+3) open it on load. Job links inside Progress navigate with
  `?panel=progress&job=…`.
- Activity loads the latest 200 technical rows when opened (plus the loaded visible rows that
  placement moved out of the chat). It is not paged further.
- One-click answers for `usage_exhausted` and `start_work` only (reversible). Every other kind,
  including approvals and 0.10 `provider_failure`/`timeout`, keeps pick-then-confirm.
  `visibleChoiceOptions` also drops any `retry` option on `usage_exhausted` client-side.
- Presence: the header shows the host (`hostPresence`), with the client guard that live activity
  < 3 min means Working. Host/agents refresh from the existing activity route every ~20 s while
  idle (every poll while work runs). "You" and "ThreadLink service" come from this browser's own
  event-poll results plus `navigator.onLine`.
- Live indicator subject ("Reviewing **authentication**") reads an optional `subject` (or
  `unitTitle`/`detail`) on live rows; the server does not send one yet, so rows read
  "Claude · Reviewing · 42 s ago" until it does.
- Settings: the failover preference lives on Settings → Providers & plans (the existing providers
  settings page); it calls `GET/PUT /api/dashboard/settings/failover` with `{policy}` (also reads
  `failoverPolicy`). Until that route exists the control says it is not available on this server.
  The Agents page shows "Included usage is used up. Resets around …" from the provider profile's
  `detected.resetsAt` (or top-level `resetsAt`) when present, else "Reset time not reported.".
- Run timings show in Provenance and in Details → Runs when the run list / run provenance carries
  `timings` (and `sessionReason`); "Startup" = spawnMs + contextMs, plus "Pickup" (queueMs) and
  "First output" (firstEventMs) when present.
- Only the chat route is `h-dvh overflow-hidden` (a route-aware frame + `:has(#tl-timeline)` CSS);
  other pages keep normal document scrolling. The sidebar drops "Home" (the logo links home).
- Not verified in a browser by this engineer (≈0.7 GB free RAM; no dev server started). The lead
  should check: one scroll surface, stick-to-bottom within 120 px, anchor on older pages, drawer
  focus/Escape, mobile sheet, and INP while typing. When checking rendered rows, use
  `textContent` (rows use `content-visibility:auto`, so `innerText` misses off-screen rows).
- **For the Web UI engineer (tsc):** `lib/team/model.ts` now has `JOB_VERDICTS += "REVIEW_PENDING"` and
  `JOB_STATUSES += "review_pending"` (terminal), so `lib/dashboard/labels.ts` `VERDICT_LABELS`,
  `VERDICT_TONES`, `JOB_LABELS`, `JOB_TONES` need entries (suggested: "Work complete · review
  pending", tone warning). `CHOICE_KINDS += start_work, usage_exhausted`; `CHAT_EVENT_TYPES +=
failover`; `ChatHostStatus.runtime.presence` is `HostPresence` (adds `reconnecting`) plus
  `serverNow`, `updateAvailable`, `fastChat`, `agents[].resetsAt`.

### Desktop + terminal engineer

**Design canvas (desktop look), applied after the route update.**

- Layout = shadcn/ui "inset" sidebar: one 256px sidebar on the animated backdrop (team switcher,
  Ctrl K chat search, New chat, Workspace: Home · Chats (collapsible sub-list with active row,
  status dot with ring, unread pill) · Agents · Notifications (count) · This computer (ping dot);
  Projects; footer Settings + account block) and the content as a frosted inset card with a
  sidebar toggle · separator · breadcrumb header. The 72px rail and 248px chat-list column of the
  first brief were replaced as instructed. The Chats page lists chats in the inset until one is
  opened; an open chat fills the inset (header, one scrolling 720px column, floating composer
  card with @, Auto ▾ lane menu, Stop work, Send; drawer with section labels).
- Tokens: the canvas's light and dark sets; theme follows the OS (`prefers-color-scheme`) unless
  Settings → Appearance says Light/Dark. Backdrop Aurora/Dusk (default)/Grid/Plain; "Animate
  background" (default on). Stored in the device-local `desktop.json` through `settings:set`, now
  allow-listed by `validSettingsPatch` (theme/backdrop/animate/autoStart/notifications only).
- Motion: three radial-gradient layers per backdrop drifting 30–44 s alternate, transform and
  opacity only (no filter), `will-change: transform`, `contain: strict`, fixed layer with
  `pointer-events: none`; ping dots, the floating Jump pill, the live-row shimmer and the Status
  beat line are transform/opacity too. All pause while the window is hidden (`visibilitychange`
  → `.bg-paused`), stop with Animate off (`.bg-still`) and under `prefers-reduced-motion`.
- Icons: Lucide (ISC, `desktop/renderer/LUCIDE-LICENSE.txt`), an in-file icon map built with
  `createElementNS`; static template icons are inline SVG markup in index.html.
- Deviations from the canvas: no custom 36px title bar (the app keeps the native window frame);
  system fonts instead of Geist (the CSP allows no remote fonts and nothing is bundled); project
  folder paths stay under Advanced (an existing privacy test) — the page shows names and a
  Linked pill; the account block says "Signed in · <ThreadLink host>" because the desktop does not
  know the account's display name; the drawer's "where the time went" bar is styled but not shown
  (the runtime-credential API carries no run timings); Codex avatars read "X", Claude "C".

**Update after the lead's route additions (supersedes the two "gap" paragraphs below).**

- Choice buttons now call `POST /api/runtime/chats/<chat>/choices/<choice> {key}`
  (`ChatClient.decideChoice`). Main still only answers a pending, non-approval choice this chat
  showed, by option key; every option of such a card is a button. A 409 refusal (e.g.
  `other_computer`) comes back as the server's fixed sentence. Approvals still open the web card.
  Phrase posting remains only as a fallback for a client without `decideChoice`. The terminal keeps
  natural typed answers (server-side §6); it has no card to click.
- Settings → failover is editable when the chat list says so (`failover.editable`, true when the
  client has `setFailoverPolicy`): radios call IPC `settings:failover` → `ChatService.setFailover`
  (allow-listed `auto|ask|wait`, 3 per 10 s) → `PUT /api/runtime/settings/failover`; the page shows
  what the server stored ("Saved" / "Couldn't save — nothing changed"). `settings.failoverPolicy`
  from `GET /api/runtime/chats` fills the initial state.
- Presence: `host {label, presence, lastSeenAt}` on chat reads and event pages is parsed; every poll
  of an open chat (desktop and terminal) updates the host presence, the status line and the
  offline sentence. `serverNow` is not needed client-side (the server computes presence).
- Live rows show `subject` (fixed words) in place of the raw activity when present.

**Desktop IA (0.11).** Nav: Home · Chats · Projects · Agents · Notifications · This computer ·
Settings (Chats shows the unread count, Notifications the needs-you count, Home pending link
requests). Folded, not duplicated:

- _Home_: presence strip (You · Connected / This computer · Online), link requests, four summary
  tiles, recent chats + New chat. Per-provider health lines, the mixed request feed and "Connect
  ChatGPT" left Home.
- _Chats_: chat list sidebar (New chat, Recent / By project, unread dots) + the open chat in the
  web layout: compact header (name, mode badge, •••, "Project · Claude · Codex", status dot line
  that opens the drawer), ONE scrolling timeline (`.shell.chat-route` hides the page header/footer
  and makes `.view` `overflow:hidden`; stick-to-bottom only within 120 px; "Jump to latest · N new"
  pill; anchor kept when older rows load), sticky autosizing composer (Enter / Shift+Enter,
  @mention autocomplete from the chat's agents + @team, `Auto | Chat only | Run work` sent as
  `lane`, resets to Auto after a send; Stop while work runs), right drawer with Activity /
  Progress / Findings / Details / Provenance. Owner right bubble; agents left with an initial
  avatar and "Claude"/"Codex"; consecutive rows of one author within 5 min are grouped.
- _Projects_: each project, "Runs on This computer / <host>", its chats.
- _Agents_: health (incl. "Usage limit reached" + "Resets …" only when the provider reported
  `resetsAt`), plans, Claude Code attached conversations (unchanged).
- _Notifications_: the desktop-notification toggle, Needs you, Unread.
- _This computer_: presence, execution host (version, protocol, heartbeat, pause/restart/logs,
  update card), **work running on this computer** (the old "Running on this computer" job cards
  with honest stages moved here from Chats), project folders, requests from linked controller
  conversations (the old Home feed), Advanced ids.
- _Settings_: start at login, failover preference, Agents & plans links, Connect ChatGPT,
  Advanced, sign out.

**Placement.** `runtime/src/index.ts` now re-exports `chatPlacement`, `agentShortName`,
`humanSystemText` from the shared module (one additive line in a Runtime-owned file, needed
because the desktop embeds the package through its `.` export). Main injects them into
`ChatService`; `desktop/src/chats.ts` keeps a same-contract fallback (a test pins parity with the
shared function on a table of rows). Routine rows never enter the timeline; they go to the
drawer's Activity. The renderer never decides placement.

**Choice cards are answered by message.** There is no runtime-credential route to decide a
choice, so a desktop card button posts a fixed §6 phrase through the chat post route (the server
resolves it, `routed: "choice_resolved"`): continue_other/use_other/retry_other → "continue with
<Claude|Codex>" (agent read from the option label, fixed names only), check_again → "try again",
wait → "wait", stop → "stop", retry → "retry", resume → "resume", run_work → "run it",
keep_chatting → "keep chatting". The renderer names only choice id + option key; main answers
only pending, non-approval choices that this chat's pages actually showed. Approval kinds show
"Decide in ThreadLink on the web" (opens `/dashboard/chats/<id>`). Only the newest open card has
live buttons (older ones say "A newer question replaced this one"), because §6 resolves the
newest open choice. `usage_exhausted` never shows Retry (key or "Retry …" label dropped).
**Gap:** a dedicated runtime-credential `POST …/choices/<id>` would be more exact than phrases.

**Failover preference is read-only on the desktop and the terminal.** There is no
runtime-credential route for `GET/PUT /api/dashboard/settings/failover`. Settings shows the three
options with nothing selected unless the chat list answer carries `settings.failoverPolicy` (or
`failoverPolicy`) — parsed tolerantly, not yet sent by the server — and a "Change in ThreadLink
web settings" button (`/dashboard/settings`). **API gap** for the DB engineer: add the policy to
`GET /api/runtime/chats` (read) and, if wanted, a runtime-credential PUT.

**Presence.** "You" is this client's own request outcome (last chat request ok → Connected; a
failed one → Reconnecting). The host comes from the server: `hostPresence`/`presence` on the chat
summary, `host.presence` on an events page, `runtime.presence` on the list; an older server's
`runtimeOnline` is read as Online/Offline. "This computer" only when the server says
`thisComputer: true` (never from a display name). The offline sentence is §4's. Tolerant field
names because the server shape for presence on the runtime chat API was not published when this
was written (the DB engineer's summary now sends `hostPresence`/`hostLastSeenAt` and `runtime.presence`,
which match). The events route carries no presence, so an open chat refreshes its host presence
only when reopened (or when a page adds `host.presence`).

**Client parsing (runtime/src/chat-client.ts).** Events now carry `payload` (JSON, ≤ 16 KiB,
else null), `jobId`, `runId`, `replyToEventId`, `ref`; pages read live runs from `activity` (the
0.10 server's name — the 0.10 client missed it, so live rows now show), `deliveries` (owner rows
update in place) and `hostPresence`; chat items read `thisComputer`, `hostPresence`,
`hostLastSeenAt`, `unreadCount`; `overview()` returns chats + projects + this computer +
failover in ONE request; `post(…, {lane})` sends `lane` only for `chat`/`work` (Auto sends
nothing, so a server whose body schema is strict and predates `lane` still accepts Auto posts);
a post answer may carry `chosenLabel` (also read from `choice.label`) and `lane`.

**Terminal.** `threadlink chat` prints only chat-placement rows (`--all` adds Activity), header
"ThreadLink — <name> TEAM" / "Project · Claude · Codex" / "You · Connected <host> · <presence>"
(+ the offline sentence), prints "You · Reconnecting"/"You · Connected" when its own polling
fails/recovers and a line when the host's presence changes. `/chat …` and `/work …` are sent as
typed (the server strips the prefix and picks the lane; they are no longer "unknown command").
Open choices print "Reply with: …" (never Retry for usage_exhausted; approvals point to the web);
an answer the server resolved prints "ThreadLink: Answered — <label>." ThreadLink rows go
through `humanSystemText` plus a `tl…_<hex>` id scrub.

**No terminal command registers or heartbeats.** `readOnlyEngine()` (tui/commands.ts) wraps the
engine so `register`/`heartbeat`/`run`/`deliverOnce` reject; cli.ts uses it for every command
except `run` and `attach` (and `setup`, which builds its own engine). `sessions`, `links`,
`approve`, `decline` no longer call `register()` (approve/decline still `sync()` attached
conversations). A test pins that `.register()`/`.heartbeat()` only appear in the setup/run/attach
branches and that `chatCommand` never touches them.

**Found in the shared module (web engineer):** `scrubSystemText` does not remove ThreadLink ids
of the form `tljob_<hex>` / `tlrun_<hex>` (its opaque-id pattern needs a word boundary before
`job_`). Desktop and terminal scrub `\btl[a-z]{2,4}_[0-9a-f]{6,}\b` after it.

**Other.** Default window 1120×760 (min 720 wide) for the two-pane chat. `[hidden]` now always
wins over a component's display in styles.css; the shell grid has one `minmax(0,1fr)` row so only
`.view` (or, on Chats, the timeline) scrolls. desktop/package.json 0.11.0. Not done: model
timings (§3.6) in the desktop drawer (the runtime events route does not carry `timings`), live
run "last activity" ages, and choice cards embedded in `timeout`/`interrupted` rows are parsed but
decided only by message like any other.

### Runtime engineer

- **Heartbeat (§3.1).** `RuntimeEngine.heartbeat()` is single-flight. The loop sends one when it
  is due, and a separate `setInterval` (heartbeatMs, 30 s) sends one whenever the loop has not.
  Jobs run in the background, so delivery never holds the loop either. Tested with a job that
  never ends: at least 4 beats in 400 ms at 30 ms per beat. A 401/403 seen by the timer stops
  the loop.
- **Wake (§3.2).** `ThreadLinkApi.wake(wait)` calls `GET /api/runtime/wake?wait=N` (N ≤ 25; the
  request times out at N+15 s). While idle, the loop keeps exactly one wake in flight; an
  interrupted wait is re-joined, not duplicated. `pending>0` dispatches at once. A 404/405/HTML
  answer marks the server as older for 10 min (other errors: 30 s), and the 0.10 idle back-off
  takes over. Spin guard: if a wake said `pending` but nothing here could be claimed, the next
  wait is a real back-off. The server counts queued tasks of all of this Runtime's sessions,
  including ones waiting for a lane slot. Test: the claim happens < 1.5 s after the wake answers
  (fake API). Real end-to-end latency also depends on the server's 750 ms poll.
- **Concurrency (§3.3).** `#dispatch()` claims what may start and runs each claimed task in the
  background (`worker.ts` `claimTask` + `runClaimedTask`), each with its own lease heartbeat.
  The loop keeps polling. The lane is read BEFORE claiming, from the envelope's job document
  (`taskLane()`: `lane`, `chatId`). Non-team tasks and unreadable documents count as `work`.
  - Limits: work ≤ 1 per workspace. Legacy ChatGPT→Claude single tasks count as work, so a
    bridge task and a team work job in the same folder still never overlap. Chat ≤ 3 overall
    (`chatConcurrency`), one at a time per chat, oldest first.
  - The inbox scan continues past a queued work task that must wait, so a chat task behind it is
    still claimed. No server change was needed; the inbox limit went up to 20.
  - A finishing task wakes the loop.
  - `deliverOnce()` is kept for callers and tests: it dispatches and waits (bounded passes).
  - On stop, `run()` waits for running jobs before it releases the lock, as in 0.10, where the
    loop ran them inline.
- **Fast Chat (§3.4)** lives in `runtime/src/team/fast-chat.ts`. `TeamExecutor` dispatches to it
  on `job.lane === "chat"`. There is no journal, worktree, DAG or verdict.
  - Runs use role `investigator`, access `read-only` and `purpose: "chat"`. The runner prompt
    header is "[ThreadLink Fast Chat]", without the "read CLAUDE.md first" instruction.
  - CLI flags: Claude `-p … --permission-mode plan --disallowed-tools Edit,Write,…`. Codex
    `exec … -s read-only`, and `exec resume <id> … -c sandbox_mode="read-only"` for a resumed
    session. Checked against `claude --help` (2.1.266) and `codex exec resume --help` (the
    installed Codex is 0.158.0-alpha.2.1, not 0.155).
  - Structured answer: `{message, needsWork, workReason}` (`--json-schema` / `--output-schema`).
  - Model verification is exactly as in 0.10 (the runner's own check). Claude cannot report its
    sandbox, so its `accessVerified` means `git status --porcelain -uall` + HEAD were identical
    before and after the turn. It is false outside a repository, or if the owner edited files
    meanwhile.
  - A chat turn uses the Runtime's cached discovery and cached health (`peek`). It never spawns
    discovery CLIs and never waits on a probe.
  - Order per turn, as the contract says: `run_started` → provider → `add_message` (with runId) →
    `run_finished`. The message row is therefore written while its run is still `running`, so
    `model_observed` comes from the run once it finishes, not from the message.
  - Placeholder guard: a first answer that is empty or only "Test"/"Done"/"OK"/… posts nothing,
    and its run ends `failed` (`provider_error`). An empty follow-up is a decline: the run is
    `completed` and nothing is posted.
  - Small talk is decided locally (≤ 6 words of greetings, thanks or acknowledgements); the
    server's `smallTalk` flag is not on the job document.
  - `needsWork` → one `request_choice start_work {sourceEventId}` per job. The Runtime does not
    wait for the answer.
  - Stop: `stop_now` or `cancel_queued`, seen in any write answer or in the `read_choices` poll
    (every 5 s during a chat turn), aborts every run, kills the job's processes and ends the job
    with `set_status cancelled`.
  - Unavailable responders are skipped. `usage_exhausted` (health or governor) gets one
    `failover_notice` per chat and exhaustion (deduplicated in-process; the server dedupes too).
    needs_sign_in, api_key_auth and not_installed are skipped silently. `unknown` is attempted.
  - When no one else answers, the job's policy decides: auto substitutes another participant;
    ask and wait use the `usage_exhausted` choice, which holds that chat slot while waiting.
- **Prompt inputs are not re-redacted.** The owner's message and the server's chat context
  (already redacted server-side) stay on this computer, so they are only length-capped. Running
  `redactText` on them turned "when the token has expired?" into "[redacted]".
  Posted agent messages are still redacted with the 0.10 `redactText`, which is deliberately
  broad: any line containing "token", "password", "secret", "bearer" or "credential" is cut from
  that word on. **Fast Chat answers about authentication will often show "[redacted]".** A
  narrower rule for chat bodies (require `:`/`=` or a credential-shaped value) would fix this.
  That is a security decision for the lead, so it is not changed here.
- **Sessions (§3.4.6)** live in `team/chat-sessions.ts`, file `configDir/fast-chat-sessions.json`.
  It stores ids, counters and times only. Keys are rebuilt on load from each entry's own chatId,
  provider and workspace hash, so a hand-edited file cannot point one chat at another chat's
  session.
  - A session rotates after 30 turns, after 24 h, or when a resume fails. A resume that fails
    with provider_error or model_mismatch is recorded as a failed run, forgotten, and retried once
    fresh (`fresh_resume_failed`).
  - Resuming a session from an earlier job sends `continuity: "resumed"` without
    `resumedFromRunKey`, which the DB notes say is accepted. Follow-ups inside the same job pass
    the first turn's run key.
- **Engineering lane (§3.5).**
  - Finding: the 0.10 orchestrator already runs independent units concurrently, and reviews each
    finished unit while others build (each unit is its own build→review→fix promise). The
    remaining sequential provider calls are real dependencies: normalise → plan → plan review →
    build, and integrate → inspect (which needs the test evidence).
  - Serialisation removed: a unit's change card (`add_change`, diffstat + shared diff) is now
    recorded while its review runs.
  - Not parallelised: concurrent plan drafts. They would add usage without removing a dependency.
  - Planning policy: `reviewSchema` has a new required field, `disagreementCategory` (none |
    technical | product_direction | security_policy | data_loss | billing |
    irreversible_architecture | unresolved_requirement; absent = technical).
  - A technical REVISE is negotiated for `min(maxPlanningRounds, 2)` rounds, then arbitrated. The
    plan on the table is stored with `approvedBy` planner + coordinator, the decision "Disagreement
    settled" is recorded (fixed title, mapped in `wire.ts`), and the objections stay open as
    findings.
  - Only owner-level categories reach `plan_disagreement`, at the end of the budget as before.
    Existing tests that expected an owner question for an unlabelled REVISE now label it
    owner-level.
- **Failover (§5)** lives in `team/failover.ts`, shared by both lanes.
  - `parseResetTime` reads only what the CLI printed. Claude: `limit reached|<epoch>`,
    `resets 3pm (Europe/London)`, `resets Oct 3, 5pm`. Codex: `try again at 3:45 PM`,
    `try again at Oct 3rd, 2026 5:12 PM`, `try again in 2 hours 5 minutes`. Anything else is null
    (fixture tests).
  - Where the reset time goes: the runner sets `resetsAt`, health stores it
    (`HealthRecord.resetsAt`) and reports it in `detected.resetsAt` only together with
    `usage_exhausted`.
  - The governor marks the whole provider exhausted until the reset time, because subscription
    usage is per account. The router then refuses it.
  - auto: another ready participant takes the step, and `failover_notice` is sent. A review goes
    only to another independent reviewer; a build or plan may go to any ready agent.
  - A review that no one else may do is skipped (`reviewPending: true`). The job then ends
    `REVIEW_PENDING` (reason `usage_exhausted`, provider = the pending reviewer), never PASS.
  - Independence guard: after a build failover, the agent that built the unit never reviews it;
    the review becomes pending instead.
  - ask: choice `usage_exhausted`. It offers continue_other only when someone can continue, and
    never `retry`. check_again runs `health.confirm()` and retries only if the result is `ready`;
    otherwise it asks again with a new choice.
  - wait: rechecks at `resetsAt + 1 min` when known, otherwise every 15 min. The choice can still
    be answered. After 24 h the step stops.
  - `provider_failure` drops `retry` for a provider whose health is `usage_exhausted`.
  - **Default when a work job has no `failoverPolicy`** (a job from a pre-0.11 server): `ask`, not
    `auto`. An older server has no `failover_notice`, so an automatic switch would be hidden.
    Without choice support the job stops `NEEDS_USER_DECISION usage_exhausted`, exactly as in
    0.10. Chat jobs default to `auto`.
  - Not implemented: re-probing an exhausted reviewer while an auto job is still running, to offer
    "Codex is available again. Resume the pending review?". Nothing auto-resumes, so the rule
    holds, but the offer needs a choice kind (e.g. `review_resume`) the server does not have yet.
    The REVIEW_PENDING job is the natural place to offer it (lead / server).
  - Preflight still stops a work job BLOCKED `usage_exhausted` when a _required_ participant is
    already exhausted before any run, because 0.10 role assignment needs both agents. Only
    exhaustion during a run fails over.
- **Real finding from the benchmark.** Codex 0.158 reports an exhausted ChatGPT workspace as "Your
  workspace is out of credits. Add credits to continue." 0.10 classified that as
  `provider_error`: no exhaustion recorded, no failover, and a "retry" offer. `/out of credits/i`
  is now one of the quota patterns. ThreadLink never adds credits.
- **Timings (§3.6).**
  - `runProcess` measures spawn (until the child's `spawn` event), the first stdout byte, and the
    total. Runners attach these as `timings`, and both lanes send `run_finished.timings`.
  - `queueMs` comes from the envelope's server `createdAt`/`claimedAt`. `contextMs` is the
    context read (chat) or note collection (work). `persistMs` is `add_message` (chat) or
    `run_started` (work).
  - One local log line per chat turn: provider, sessionReason, the six numbers and the outcome;
    no text.
  - Benchmark: `npx tsx runtime/scripts/bench-cli-startup.ts [--only <provider>]` runs one tiny
    read-only chat turn per provider, sequentially.
  - Measured on this machine (memory-starved, ~0.7 GB free):
    - discovery: 3.3–3.7 s, now once per Runtime and cached for chat;
    - `--version`: claude 237 ms, codex 140–258 ms;
    - Claude chat turn (claude-haiku-4-5): spawn 71 ms, first output 9.2 s, total 9.8 s, model
      verified;
    - Codex chat turn (gpt-6-luna): spawn 1.2–1.4 s, first output 3.9–6.7 s after spawn, total
      11.9–14.5 s, failed "out of credits" (quota). There is no successful Codex turn number.
  - The CLI's own start-up plus the first model output dominates a Fast Chat turn (≈ 10 s).
    ThreadLink's own steps around it (context read, run_started/finished, message) were not
    measured on the real server; locally they are single requests.
- **Server mismatch to reconcile (lead).** The server rule "from protocol 11, PASS is refused
  unless every unit with a reviewer has a completed reviewer run" breaks rooms with
  `crossReview: false`. There, units still get a reviewer assigned but are never reviewed, so a
  0.11 Runtime's PASS would be refused. Either the server requires the review only when the job's
  policy has cross-review on, or the Runtime stops assigning reviewers when cross-review is off.
  The Runtime is unchanged pending that decision.
- **Versions.** `RUNTIME_VERSION` and runtime/package.json are 0.11.0; `RUNTIME_PROTOCOL` is 11
  (engine and 0.10 tests updated). The desktop version is untouched.

- **Fix after acceptance: an agent already out of usage when the job starts.** This replaces the
  earlier "Preflight still stops a work job BLOCKED" limitation.
  - `#preflight` still stops the job for needs_sign_in, api_key_auth, not_installed and unknown.
    `usage_exhausted` also still stops it, but only for a job without `failoverPolicy` (a job
    from a 0.10 server).
  - With a policy, `#rolesWithExhausted` goes through the same `handleExhausted` as a failover
    during a run. The reset time comes from the health port (`HealthPort.resetsAt`).
  - Pair, reviewer out: the builder builds. The review is pending unless another independent
    reviewer is ready. The notice is `{from: reviewer, to: builder, reviewPending: true}`.
  - Pair, builder out: a ready agent builds. If that agent was the only possible reviewer, the
    review waits for the exhausted builder and the notice has `reviewPending: true`.
  - Solo, builder out: another ready participant builds (notice `reviewPending: false`); with
    none, the job stops BLOCKED as before.
  - Team: with two or more ready participants, the exhausted one is simply left out. With one
    ready participant, it coordinates, plans and builds; every review the exhausted agent would
    have done (plan review, unit reviews, final inspection) is pending.
  - A pending reviewer is never run in the job, and the job ends REVIEW_PENDING.
  - ask: `usage_exhausted` choice. continue_other goes on as auto. check_again runs a fresh check:
    if ready, the job runs normally (the reviewer reviews); if not, the owner is asked again.
    wait waits and rechecks. stop ends the job `stopped_by_owner`, and no agent runs.
  - Summaries claim only what happened: the one-unit plan says "…'s review is pending", and its
    rationale no longer says "the owner asked X" when a failover picked X.
  - **Not fixed (DB engineer's file):** the misleading result line "Builder + Reviewer: Claude Code
    built it, Codex reviewed it" comes from the `job_verdict` text in the jobs trigger,
    `supabase/migrations/20260929000100_threadlink_0_11.sql` (around line 1167). It is built from
    `mode`/`builder_provider` and guesses the reviewer as "the other provider", whatever runs
    happened. It should say who built and reviewed only from completed `agent_runs` of this job
    (builder role / reviewer role), and say nothing when nobody ran (e.g. a BLOCKED preflight).
    After a Runtime failover, `builder_provider` can also be the wrong agent.

### Database + server engineer — final (deviations and limitations)

Migration `supabase/migrations/20260929000100_threadlink_0_11.sql`; pgTAP
`supabase/tests/database/020_threadlink_0_11.test.sql` (the CLI's test folder, not `supabase/tests/`).

- **team_job_write is wrapped, not copied.** The 0.10 function moved to
  `threadlink_private.team_job_write_v10` (unchanged, private); `public.team_job_write` (same
  signature, anon-only as before) authenticates identically, handles the 0.11 ops itself and
  delegates the rest. Wire as published above; `set_status` `completed|failed` is refused for work
  jobs by the 0.10 path (`22023`).
- **Routing.** New overloads (all args required): `post_chat_message(chat, body, key, lane,
lane_reason, choice_id, choice_key)`, `runtime_post_chat_message(token, chat, body, key, client,
lane, lane_reason, choice_id, choice_key)`, `controller_post_chat_message(token, session, chat,
body, key, lane, lane_reason)`. `routed` adds `chat_job` and `choice_resolved` (+ `choice_id`,
  `chosen_key`, `chosen_label`, `started`); every answer carries `lane` and `lane_reason`. The owner
  row payload is `{lane, laneReason[, choiceId]}` (`laneReason` `choice_answer` for an answer).
  The TS layer reads `chat_compose_context(chat)` / `runtime_chat_compose_context(token, chat)`
  (mode, running work, up to 5 open non-approval choices with the provider's health) before posting.
  A choice the database cannot resolve (closed, other chat, approval) is ignored and the message
  routes normally.
- **Old overloads are exactly 0.10.** Edge: a 0.10 client posting (3-arg) into a chat where only a
  Fast Chat job is running treats that job as "the active job" (note / stop), as 0.10 did for any job.
- **Stop.** `@team stop` sets the work job's `stop_requested_at` (0.10) and, on every unfinished
  Fast Chat job of the chat, `stop_requested_at` + `control = stop_now` (no chat rows for those).
  The stop message's `job_id` is the work job, else the oldest running chat job.
- **Fast Chat jobs.** At most 5 unfinished per chat (`54000 rate_limited`); carrier priority `B`,
  1-day expiry, `verifyCommands: []`; the owner's own chat posts skip the controller task window
  (30/10 min; the 20/min/chat owner post limit still applies); controllers keep the window. No
  `job_started`/phase/verdict/summary rows; a failed chat job writes one visible `job_status` row
  "The agents could not reply." A `start_work` choice is not cancelled when its chat job finishes.
  Controllers may start Fast Chat while work runs (their request row is written first and named by
  the carrier); controller work while work runs is still `job_active`; controllers never answer
  choices by typing. Solo chat from a controller in a review-required project is allowed (it
  changes nothing); solo WORK is still `review_required`.
- **Health gate.** `health_gate_ok`: chat lane = any responder ready; work lane = all ready, or (the
  project's Runtime at protocol >= 11 and owner policy `auto`) >= 1 ready and every other one only
  `usage_exhausted`. Nobody ready → message + one `provider_blocked` row (0.9). A 0.10 Runtime keeps
  the strict gate (it cannot fail over).
- **REVIEW_PENDING.** New terminal job status `review_pending` (TS `JOB_STATUSES`,
  `TERMINAL_JOB_STATUSES`) with verdict `REVIEW_PENDING`; refused with open blocking/important
  findings (`open_findings`) or a failed unit (`node_failed`). Verdict row/summary say "Work
  complete · review pending". **PASS check (lead decision):** from protocol 11, in a non-solo job
  whose carrier snapshot has `policy.crossReview = true` (the room's setting for an older carrier),
  every non-skipped unit with a reviewer needs a completed run of that reviewer provider in a
  reviewer role, else `55000 review_missing`. `crossReview:false` projects PASS as before.
- **Failover notice.** Requires real exhaustion (`not_exhausted` otherwise). Dedupe = same chat,
  same `from`/`to`, since `runtime_provider_health.health_changed_at` (new column, moved by
  `report_provider_detection` when the health changes), at most 24 h. Body never includes the reset
  time (payload `resetsAt` only). `failover` rows count as unread.
- **resetsAt** (detection): kept only with health `usage_exhausted` and inside now−1 h … now+8 d,
  normalised to `YYYY-MM-DDTHH:MM:SSZ`; otherwise stored as null. Choice/notice `resets_at` use the
  same window (outside → null). The server classifies no provider text: "Your workspace is out of
  credits" (Codex CLI 0.158) must be mapped to `usage_exhausted` by the Runtime.
- **Native sessions.** The 0.10 guard already allowed reuse across jobs of the same chat+project; the
  0.11 change is that `continuity: "resumed"` without `resumedFromRunKey` is accepted (stored
  `resumed`, no resumed-from run; `agent_runs_resumed_consistency` relaxed accordingly). Cross-chat
  reuse is still `42501 native_session_reused` (tested).
- **Liveness.** `require_role_session(..., 'agent')` now refreshes `runtimes.last_seen_at`
  (≥ 10 s apart): every agent-session worker call (inbox, claim, start, task heartbeat, progress,
  complete/fail/blocked, team_job_write) plus the wake count. Runtime-credential chat reads
  (desktop/terminal), whoami and links do not count.
- **Presence v2.** `threadlink_private.runtime_presence(runtime)`: offline if revoked or paused;
  working if a run of this Runtime is queued/running in an unfinished job and (the run's activity or
  the Runtime's last_seen) < 3 min; else online < 75 s, reconnecting < 3 min, offline. Used by
  `chat_host_status` (+ `server_now`, `update_available`, `fast_chat`, agents' `resets_at`;
  `needs_update` is now "below the minimum 10"), the runtime chat API summary
  (`project.runtime_presence`, `runtime_last_seen_at` → TS `hostPresence`, `hostLastSeenAt`), and
  `runtime_json` (`min_protocol` 10, `current_protocol` 11, `update_available`).
- **Wake.** `runtime_pending_count(p_token_hash, p_begin boolean)` (two args: `p_begin` = the
  rate-limited first check, 120/min/owner). Paused Runtime → `{pending: 0, paused: true}` at once.
  Counts queued, unexpired tasks and lapsed leases of this Runtime's own active sessions (≤ 100).
  Route `GET /api/runtime/wake?wait=0..25` (`maxDuration` 30, honours abort, 429 `rate_limited`).
- **Lead additions (desktop/terminal).** `GET/PUT /api/runtime/settings/failover`
  (`runtime_get_settings`, `runtime_set_failover_policy`); `GET /api/runtime/chats` carries
  `settings.failoverPolicy`; `POST /api/runtime/chats/<chat>/choices/<choice> {key}`
  (`runtime_decide_choice`: dashboard parity incl. approval cards, choice of THAT chat, only from the
  computer the project runs on — `other_computer` otherwise) → `{choiceId, kind, status, chosenKey,
chosenLabel, decidedAt, replayed, startedJobId}`; `runtime_get_chat` / `runtime_chat_events` add
  `host {label, presence, lastSeenAt}` and `serverNow`; `active_job` prefers the work job and carries
  `lane`. Live rows (owner and runtime) gain `subject` = fixed step words ("Reviewing",
  "Investigating") and, runtime API, `lane`. **Skipped:** unit titles in `subject` (agent text), and
  timings/sessionReason on the runtime-credential API (no runs route there; the owner run
  provenance has `timings` and `nativeSession.reason`).
- **Owner settings.** `GET/PUT /api/dashboard/settings/failover` (`get_my_settings`,
  `set_failover_policy`, 30 changes/min, audited `settings.updated`); `user_settings` RLS read-own,
  no client writes.
- **decide_choice** keeps its signature; its answer gains `chosen_label` and `started` (run_work).
  `choice_options` for `provider_failure` drops `retry` while that provider's effective health is
  `usage_exhausted` (for 0.10 ops too); if nothing is left, `stop`.
- **Redaction (lead decision).** `redact_text`: "the <password|secret|token|api key…> is/was X"
  only when X has a digit or is ≥ 16 chars (optionally quoted); key[:=]value rules unchanged. The
  export mirror (`lib/export/chat-export.ts`) matches.
- **Classifier notes** (`lib/chat/intent.ts`): default chat; "don't forget to …" is a polite prefix,
  not a negation; "how's it going" reads as small talk; bare "go ahead" / "continue" are
  continuation (chat) unless they answer an open choice.
- **Pending on other owners:** `lib/dashboard/labels.ts` needs `REVIEW_PENDING` / `review_pending`
  entries (the only `tsc` errors left); `runtime/src` `JOB_STATUSES` / `JOB_VERDICTS` should add
  them (tests/team-server.test.ts tolerates their absence until then).

#### Web engineer — design canvas pass (tokens, backdrops, inset shell, icons)

- Tokens: `app/globals.css` now carries the canvas token set (light `:root`, dark for both the
  system and the explicit `data-theme="dark"` path) as CSS variables and Tailwind colours
  (`bg-bubble`, `bg-card`, `bg-claude-bg`, `text-notice-ink`, `bg-send-bg`, `bg-tabs`, …).
  Deviation: `--subtle` is `#585863` (light) / `#a2a2ae` (dark) instead of the canvas
  `#6b6b76` / `#8e8e9b`, because sidebar text sits straight on the backdrop and the canvas
  values drop to ~4.2:1 over the brightest indigo tint. `tests/web-appearance-0-11.test.ts`
  checks ≥ 4.5:1 for subtle/muted/foreground over every backdrop tint, bare and under the
  inset/side surfaces, in both themes.
- Shell (shadcn "sidebar inset"): 256 px sidebar on the backdrop (no panel), content in a frosted
  inset card (8 px margin, 14 px radius). Glass surfaces (`.tl-side/.tl-head/.tl-glass/.tl-panel/
.tl-inset`) fall back to solid colours without `backdrop-filter` and under
  `prefers-reduced-transparency`. They live in `@layer components` so utilities can override them.
- Backdrops: aurora / dusk / grid / plain behind the whole signed-in app. The colour fields are
  radial-gradient circles animated with transform (+ a slow opacity breath) only; the grid moves
  one dot period over 90 s with a drifting spotlight. The layer is fixed, `contain: strict`,
  `pointer-events: none`, `aria-hidden`; animation is paused while the tab is hidden and removed
  under reduced motion or when the owner turns it off. Cost note: the frosted surfaces re-blur
  while the backdrop moves (GPU work, not main-thread; INP is unaffected); "Animate background"
  off removes it entirely.
- Settings → Appearance: Theme + Background (Aurora/Dusk/Grid/Plain) + "Animate background",
  stored in `tl-backdrop` / `tl-motion` cookies (read by the dashboard layout: no flash).
- Effects (all compositor-only, none under reduced motion): ping dots on live status, a shimmer on
  the first live row (a masked window moved by transform with a counter-moving copy; no
  background-position animation), the timing bar grows once, the Jump pill floats.
- Icons: `lucide-react` (ISC) added to `package.json`. `npm install` timed out on this machine, so
  the package was unpacked into `node_modules` by hand and `package-lock.json` was regenerated with
  `npm install --package-lock-only` (it also normalised a few optional wasm entries of
  `@tailwindcss/oxide-wasm32-wasi`). The lead should run a normal `npm install` once.
- Drawer tabs follow the canvas: a segmented control; the provenance tab is labelled **Sources**.
  A message's "Details" now opens the **Details** tab with that message selected ("This message"
  - "Where the time went" cards, message highlighted in the timeline); Sources shows the full run
    record and the native-session reveal.
- The sidebar's "switcher" is the ThreadLink logo (there are no teams to switch); its sub-line is
  "Web". The NavUser block shows name + email (the canvas' "Subscription agents · paid usage off"
  is not known client-side, so it is not claimed). Chat groups show under Projects.
- On phones the chat menu (•••, rename/pin/archive…) is not in the chat header (the canvas has only
  the details button); it stays reachable from the chat list.
