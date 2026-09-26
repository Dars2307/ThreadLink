# Chat-first ThreadLink

Status: design contract for the "Chat-first ThreadLink" phase (runtime/desktop 0.9.0).
Builds on `docs/design/collaboration-chat.md` (0.8) and `docs/design/team-mode.md`.
Shared types: `lib/chat/types.ts` (additions marked 0.9).

> "Chat with one AI, two AIs, or a team." Team is a chat mode. Projects organise
> chats. Agents power chats. Chats are the main experience.

## 1. Facts this phase starts from (verified in Production)

- Job `tljob_06c4…` ended `BLOCKED / agent_failed` at planning round 0, no plan,
  one model run: Claude Code as **coordinator**, outcome `provider_error`,
  stderr "Failed to refresh OAuth …".
- `claude auth status` reports `loggedIn: true, authMethod: claude.ai` while the
  OAuth token cannot be refreshed. **Status output is not proof of a working
  sign-in.** Only an authenticated call is.
- `runtime/src/team/runner.ts` AUTH_PATTERNS did not match "Failed to refresh
  OAuth", so it was classified `provider_error` → reason `agent_failed`.
- Web `taskGraph` (`lib/dashboard/pages.ts`) and desktop `teamSteps`
  (`desktop/renderer/app.js`) mark **Plan ✓** for any job past the planning
  statuses, including one that never produced a plan.
- Claude-first defaults: orchestrator `#roleHolder("planner"|"integrator", "claude-code")`,
  `#builder = "claude-code"`, normaliser/coordinator hard-wired to the planner,
  `room_agents.default_roles` seeded Claude = planner/builder/reviewer/integrator,
  web composer builder default `claude-code`.

## 2. Provider health (preflight)

Health values, per provider, reported by the Runtime:

| health            | meaning                                                                              | user text                                        |
| ----------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `ready`           | installed, subscription sign-in, and a trivial authenticated call succeeded recently | Ready                                            |
| `needs_sign_in`   | not signed in, token refresh failed, or auth error on the last call                  | Needs sign-in                                    |
| `not_installed`   | CLI not found                                                                        | Not installed                                    |
| `api_key_auth`    | signed in with an API key / non-subscription method (would bill per token)           | Uses an API key — sign in with your subscription |
| `usage_exhausted` | last call reported plan usage exhausted                                              | Usage limit reached                              |
| `unknown`         | never probed / probe inconclusive (network)                                          | Not checked yet                                  |

- **Probe**: a trivial authenticated call ("Reply with OK", no tools, the
  provider's lightest model, 1 turn, 60 s timeout, subscription env only).
  Claude: `claude -p` (never `--bare`). Codex: `codex exec` with the same safe
  flags the runner uses (read-only, `--ignore-user-config`, stdin closed).
  Run at Runtime start, then at most every 30 min while idle, immediately after
  any auth-classified failure, and at job claim if the cached result is older
  than 10 min. The probe's cost is one tiny call; it is never run in a loop on
  failure (backoff ≥ 10 min while `needs_sign_in`, re-probe on user "Check again").
- AUTH_PATTERNS gain: `failed to refresh oauth`, `refresh token`, `oauth.*(expired|invalid|revoked)`,
  `please run .*login`, `session expired`, `re-?authenticate`. Codex equivalents
  (`codex login`, `not logged in`, `401`, `token.*expired`).
- Detection report (`report_provider_detection`, jsonb `detected`) gains
  `health`, `healthCheckedAt`, `healthDetail` (short fixed text, no stderr).
- **Server gate**: every path that starts a job (controller `start_team_job`,
  owner chat post) refuses when any provider the job needs has
  `health <> 'ready'` or a `healthCheckedAt` older than 2 h, with hint
  `provider_unhealthy` and a structured detail listing each provider's health, e.g.
  `Claude Code — Needs sign-in · Codex — Ready`. No job row, no task, is created.
  The provider the job needs = chat/room participants required by the mode
  (solo: the builder; pair: builder + reviewer; team: all enabled participants).
- **Runtime gate**: at claim, before any agent run, the orchestrator re-checks
  health (probing if stale). A failure ends the job `BLOCKED` with the new
  verdict reason `agent_needs_sign_in` (or `agent_unavailable` /
  `usage_exhausted` / `api_key_auth`) and no agent runs. Never substitutes.
- Mid-job auth failure → `Stop("BLOCKED", "<Provider> needs you to sign in again on this computer.", "agent_needs_sign_in")`
  and an immediate health report `needs_sign_in`.
- **Explicit retry**: a BLOCKED job whose failure happened before real work
  (no plan persisted) offers **"Retry with Codex as coordinator"** (or the other
  healthy provider). This is an owner action (`retry_job_with_roles`) that starts a
  NEW job in the same chat with `roleOverrides.coordinator = <provider>`; it is
  never automatic and is refused if that provider is not `ready`.

New verdict reasons (added to all three lists: runtime `verdict-reasons.ts`,
`lib/team/model.ts`, SQL check + `chat_reason_text`):
`agent_needs_sign_in` → "An agent needs you to sign in again on this computer."
and `api_key_auth` → "An agent is signed in with an API key, which would bill per use; ThreadLink did not use it."
(The chat line names the provider from trusted state, see §6.)

## 3. Honest progress

Stages shown for every job, in order: **Understanding request · Plan · Build ·
Review · Integration** (solo: no Review). Symbols: ✓ done, ● active, ✕ failed
here, ○ not started, – skipped (never reached because an earlier stage failed).

- Plan is ✓ **only if** `team_jobs.plan` is persisted **and** approved
  (`plan_approved_hash = plan_hash`).
- The stage where a terminal job stopped is ✕; later stages are "–".
- Derivation uses `status`, `plan/plan_approved`, `nodes`, `verdict`,
  and the last non-terminal status reached (`team_jobs.last_phase`, new column,
  maintained by `team_job_write` on every status change).
- Regression tests: failure before normalisation, during normalisation, before
  the first planning round, during planning (web `taskGraph` and desktop
  `teamSteps` both).

## 4. Provider-neutral roles

New Runtime module `runtime/src/team/roles.ts`:

```
assignRoles(input: {
  mode, participants: ProviderCapability[] (with health, models),
  goal, spec, roomPrefs (room_agents roles; empty = no preference),
  overrides: { coordinator?, planner?, builder?, reviewer?, integrator? },
  history: { recentFailures: Record<provider, number> },
  seed: jobId
}) → { coordinator, planner, integrator, builders[], reviewers[], reasons: string[] }
```

- No provider is special. Scores from: health (unhealthy providers are never
  chosen; if a required role cannot be filled → NEEDS_USER_DECISION, never
  substitution), user override (absolute), room preference, strongest available
  model class for the role, recent failures (penalty), then a deterministic
  tie-break from the job id so load alternates across jobs.
- The choice and its reasons are recorded as a decision ("Roles: Codex
  coordinates (…); Claude Code plans and reviews (…)") and on the carrier's
  first `set_status`.
- Orchestrator uses the assignment everywhere (normalise, plan, build owner
  defaults, integrate, inspect). Solo builder/pair builder+reviewer come from the
  chat (explicit) or from `assignRoles` (auto).
- Team Mode keeps "two or more distinct providers" but is written over the
  participant list, not literal `["claude-code","codex"]`.
- `room_agents.default_roles`: existing rows whose value equals the old seeded
  defaults are reset to the full role set (they were never user-chosen); new
  rows get the full set. Roles become preferences only when a user sets them.

## 5. Chats (new entity)

Migration `20260927000100_chat_first.sql` (additive):

```
public.chat_groups   id tlgrp_, owner_user_id, name 1..60, sort int, created_at
                     unique (owner_user_id, lower(name))
public.chats         id tlcht_, owner_user_id, name 1..100,
                     room_id null -> rooms (the project; also the execution route)
                     group_id null -> chat_groups
                     mode text check (solo, pair, team) default 'team'
                     solo_provider, builder_provider, reviewer_provider (null = auto)
                     pinned_at, archived_at, deleted_at, last_activity_at,
                     last_read_seq bigint default 0, is_room_default boolean default false,
                     created_at, updated_at
                     unique (room_id) where is_room_default and deleted_at is null
public.team_jobs     + chat_id null -> chats, + last_phase text, + role_overrides jsonb null
public.chat_events   + chat_id null -> chats   (index (chat_id, seq))
```

- RLS: select own on both tables; all writes via security-definer owner RPCs:
  `create_chat(name, room_id?, group_id?, mode?)`, `update_chat(chat_id, name?, room_id?|clear, group_id?|clear, mode?, solo_provider?, builder_provider?, reviewer_provider?)`,
  `set_chat_pinned`, `set_chat_archived`, `delete_chat` (soft, from ThreadLink only),
  `mark_chat_read(chat_id, seq)`, `create_chat_group`, `rename_chat_group`, `delete_chat_group` (chats keep, group cleared),
  `post_chat_message(p_chat_id, p_body, p_idempotency_key)` (new overload keyed by chat; the 0.8 room-keyed
  version keeps working and routes to the room's default chat),
  `retry_job_with_roles(p_job_id, p_coordinator)`.
- Execution route: a chat runs work in its project's workspace (room route). A
  chat with no project can hold messages but a request that needs agents is
  refused with `needs_project` ("Choose a project for this chat so the agents
  know which folder to work in"). Moving a chat changes only future work.
- Mode on the chat drives routing; a leading @mention still overrides for one
  message (`@codex …` = solo Codex for that request). Changing mode never edits
  history; it writes a ThreadLink event "Mode changed to Builder + Reviewer".
- Jobs, chat_events and team work carry `chat_id`. Triggers copy it from the
  job. Controller-originated work (MCP) lands in the room's default chat unless
  the controller passes `chatId` (new optional MCP param on `start_team_job` and
  `send_to_agent`, validated to the same owner and room).
- **Backfill**: one default chat per existing room ("<room name>", is_room_default,
  mode 'team', pinned null), and `chat_id` set on that room's existing jobs and
  chat_events. No existing row is deleted or rewritten otherwise.
- Participants (for display) are derived, not stored: the room's enabled
  agents + the controller label(s) seen in the chat + "You". Rendered from
  provider metadata (name, short name, colour token), not per-provider switches.
- Unread / needs-attention: `last_read_seq` vs max visible seq; needs-attention =
  a job in NEEDS_USER_DECISION/BLOCKED or a decision requiring the user.

## 6. Chat events in the new model

Unchanged provenance rules from 0.8. Additions:

- `mode_changed` (threadlink, visible) "Mode changed to Team."
- `provider_blocked` (threadlink, visible) written when a start is refused for
  health: "Claude Code needs you to sign in again on this computer. Codex is ready."
  (built from provider ids + fixed health text only).
- Verdict line for `agent_needs_sign_in` names the provider from
  `team_jobs.verdict_provider` (new column, provider id set by the Runtime,
  checked against participants).

## 7. Navigation and routes (web)

Primary nav: **Home · Chats · Projects · Agents · Notifications · Settings**.

- `/dashboard/chats` — chat list: search, sort recent, pinned first, groups
  (custom) and projects (automatic) as filters/sections, unread and
  needs-attention badges; row = name, participants ("Claude Code + Codex"), mode
  badge, last message preview (plain text, redacted), relative time. Actions:
  rename, pin/unpin, archive/restore, delete from ThreadLink, add to/move/remove
  project, set group, new chat.
- `/dashboard/chats/[chatId]` — header: name, mode control (Solo · Builder +
  Reviewer · Team, with provider pickers), project, participants with health;
  tabs Chat / Progress / Details (0.8 components reused). Retry button on
  eligible blocked jobs.
- `/dashboard/projects/[roomId]` — project's chats first, then project settings
  (repository/workspace, verify commands, agents, usage policy, routing).
  Old `?tab=chat` links redirect to the room's default chat.
- `/dashboard/agents` — providers with health ("Claude Code — Needs sign-in"),
  plans, capabilities, and provider-native sessions (the old Conversations
  content). `/dashboard/conversations` redirects here; `/dashboard/team`
  redirects to `/dashboard/chats?mode=team`; `/dashboard/team/[jobId]` to the
  job's chat Progress tab.

## 8. Desktop (0.9.0)

- Honest stage list (§3), provider health on Home/Settings with "Check again"
  (re-probe), the Claude sign-in instruction ("Open a terminal and run
  `claude` to sign in again"), running work grouped by chat name.
- Nav wording: "Team" → "Chats" (running and recent work by chat),
  "Conversations" → "Agents".

## 9. Not in scope / honest limits

- Drag-and-drop between groups (basic actions only).
- Cursor/Windsurf/Gemini remain not supported; the data model allows them.
- A chat can belong to one project and one custom group.

## 10. Server implementation notes and deviations

Migration `20260927000100_chat_first.sql`, `lib/chat/**`, `lib/providers/health.ts`,
`/api/dashboard/chats/**`. Where the server is stricter or more specific than sections 2-6:

1. **Health is judged by the server, fail closed.** `provider_effective_health` (SQL) and
   `effectiveHealth` (`lib/providers/health.ts`) agree: no report → `unknown`;
   `installed:false` → `not_installed`; a reported failing health wins; `authenticated` not
   true → `needs_sign_in`; an `authMethod` other than `claude.ai`/`chatgpt` (including a
   missing one) → `api_key_auth`; no `health`, or not `ready` → `unknown`; `ready` whose check
   is older than 2 h → `unknown`. "Checked" is the EARLIER of the Runtime's `healthCheckedAt`
   and the server's own receipt time, so an old report of a "fresh" check is stale too.
   A Runtime older than 0.9 never reports health, so every job start on it is refused
   (`unknown`: "Open the ThreadLink app on this computer so it can check") until it updates.
   This also closes a 0.8 gap where a detection without `authMethod` passed the old check.
2. **Detection fields.** `health` must be one of the six values; `healthCheckedAt` an ISO
   timestamp or null (at most 5 min in the future). `healthDetail` is kept only when it is
   one of the Runtime's six fixed sentences (`HEALTH_DETAIL` in `runtime/src/team/health.ts`,
   `provider_health_details()` in SQL, `HEALTH_DETAILS` in `lib/providers/health.ts`);
   anything else (a URL, quotes, stderr, a credential) is stored as null, never refused.
   2a. **Health is per computer.** `report_provider_detection` writes
   `public.runtime_provider_health` (runtime_id, provider, detected, health, checked_at,
   detail, received_at) for the reporting Runtime, as well as the account-wide
   `provider_profiles.detected` (kept for display only). Every job start (owner post,
   controller start, retry) and the automatic builder pick read the health reported by the
   Runtime that owns the project's agent session (`session_bindings.runtime_id`), so computer
   A being ready never unblocks a project on computer B, and A needing sign-in never blocks
   B. The chat list's participant health is likewise the project's own computer.
3. **Refusal shapes.** The controller path (`start_team_job`) raises `55000` / hint
   `provider_unhealthy` with a machine DETAIL `claude-code=needs_sign_in,codex=ready`; the
   rollback means no row of any kind is written, so the controller path writes NO
   `provider_blocked` chat row. `lib/team/client-api.ts` turns it into
   `ProviderUnhealthyError` and the MCP tools answer "Claude Code — Needs sign-in · Codex —
   Ready. Claude Code needs you to sign in again on this computer." The owner path does not
   raise: it stores the owner's `request` (job_id null) and a `provider_blocked` row, and
   returns `routed: "provider_blocked"` with `health`; the route answers 409 with
   `stored: true`. `retry_job_with_roles` raises like the controller path (nothing stored).
4. **Only job starts are gated.** `send_to_agent` (a single task via `create_task` /
   `create_chat_task`) is not health-gated: it is not a job and may target a bridge session.
5. **Auto builder/reviewer are chosen by the server** (`team_pick_provider`), because the job
   row needs its builder: a ready provider first, then the one that built least recently in
   the project, then a stable order. The 0.8 "default claude-code" for pair/solo without a
   builder is gone (also on the room-keyed post).
6. **Carrier (still `version: 1`)** gains `chatId`, `participants` (the job's provider ids)
   and `roleOverrides` (`{}` unless an owner retry set `coordinator`). The server never emits
   an override that contradicts `builder`/`reviewer` (a retry pins only `coordinator`).
7. **`post_chat_message` overloads.** The chat-keyed
   `post_chat_message(p_chat_id, p_body, p_idempotency_key)` has no defaults; PostgREST
   resolves it by argument names. A SQL caller
   must use named arguments: a positional 3-argument call is ambiguous with the room-keyed
   function. The room-keyed call routes to the project's default chat, and its "active job"
   is the default chat's: a job a controller started in another chat of that project is not
   seen by a room-keyed post.
8. **needs_project stores nothing.** A chat with no (live) project refuses a request with
   `needs_project` and writes no row. A chat whose project was deleted behaves the same.
9. **Default chats.** Created by trigger with each new room, and lazily
   (`room_default_chat`) when needed, within the same caps as `create_chat` (20 new per
   minute, 2000 live); past a cap there is no default chat and a start refuses with
   `limit_reached`. Moving a default chat to another project (or clearing
   it) makes it an ordinary chat; the project gets a new default chat when work next needs
   one. Deleting a project hides (soft-deletes) its default chat; its other chats stay.
10. **Backfill.** `chat_first_backfill()` (idempotent) creates one default chat per room
    (deleted rooms' chats are created deleted), sets `chat_id` on existing jobs and chat rows,
    and marks existing history read (`last_read_seq` = the room's newest seq). Finished jobs'
    `last_phase` stays null (never recorded); running jobs get their status. The
    immutability triggers are bypassed for exactly that update; `updated_at` is not touched.
11. **`last_phase`** is kept by a `team_jobs` trigger on every status change, whatever the
    path (Runtime write, carrier failure, room deletion), not only by `team_job_write`.
12. **Limits.** Chats: 20 new per minute, 2000 live per owner. Groups: 50 per owner, names
    unique per owner (any case). Chat changes (`update_chat`): 60 per owner per minute. Mode
    changes: 10 per chat per minute. Retries: 10 per owner per minute. Owner posts: 20 per
    chat and 20 per project per minute, 60 per owner. A job is retried at most once (a repeat
    returns the first retry).
13. **Participants** in the list are the project's enabled agents (with health), the
    controller labels seen in the chat's last 50 controller rows, and "You".
14. **One running job per chat, under concurrency.** Every job start locks the chat row and
    re-checks it (owner, not deleted, same project) after locking, so an owner post and a
    controller start in the same chat are serialised and see each other's job. A start into
    a chat with a running job is refused (`job_active`). The one exception keeps 0.8
    behaviour: a controller that names no chat may run several jobs in parallel in the
    project's default chat.
15. **Replay first.** A controller start with an idempotency key it already used returns
    that job before any other check (health, busy chat), so a retried request is never
    refused for something that changed after it succeeded.
16. **Retry after a move.** If the chat has moved to another project since the job ran,
    `retry_job_with_roles` refuses with `project_changed` ("This chat now belongs to another
    project; start a new request instead").
17. **Atomic chat changes.** `update_chat` also takes `p_pinned` / `p_archived`; the
    `PATCH /api/dashboard/chats/[chatId]` route makes one call, so a refusal applies nothing.
18. **More limits.** Pin, archive and group create/rename/delete share 60 per owner per
    minute; moving the read cursor 240 per owner per minute (a call that does not move it is
    free). Counted in `threadlink_private.owner_action_log` (no client access).
19. **Foreign keys.** `team_jobs.chat_id`, `team_jobs.retried_from_job_id` and
    `tasks.chat_id` have no ON DELETE action (chats are only soft-deleted; SET NULL would be
    an update the job guard refuses). The check runs at statement end, so an account
    deletion still cascades.
