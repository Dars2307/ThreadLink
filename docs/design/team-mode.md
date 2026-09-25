# Team Mode — design and contract

Status: implementation contract for the Team Mode phase. Every agent building a
part of this reads this file first and builds against the interfaces here.

## 0. Facts this design rests on (verified on the owner's machine, 2026-09-25)

These were measured, not assumed. The design depends on each one.

| Fact                                                                                                                                                 | Evidence                                                   | Consequence                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.155 is present, bundled with the Codex desktop app, not on PATH                                                                          | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`         | Discovery must search the app's bin folder, not just PATH                                                                                    |
| Codex is authenticated with ChatGPT, no API key                                                                                                      | `codex login status` → `Logged in using ChatGPT`           | Subscription auth works headless                                                                                                             |
| `codex exec` waits on stdin if it is not closed                                                                                                      | a run hung on "Reading additional input from stdin"        | **stdin must always be closed** (`stdio[0] = "ignore"`)                                                                                      |
| `codex exec --json` emits `thread.started{thread_id}`, `item.completed{item:{type:"agent_message",text}}`, `turn.completed{usage}`                   | probe                                                      | Thread ID and result come from the event stream                                                                                              |
| `--json` events do **not** name the model                                                                                                            | probe                                                      | Observed model must come from elsewhere                                                                                                      |
| The persisted rollout's `turn_context` line records `model`, `effort`, `sandbox_policy`, `approval_policy`                                           | `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` | **Observed model and applied sandbox are verifiable after every run** — read only `session_meta`/`turn_context` lines, never message content |
| The user's `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`, `approval_policy = "never"`                                            | config                                                     | ThreadLink must never inherit it: always pass `--ignore-user-config` **and** an explicit `-s`                                                |
| Codex model catalog is in `~/.codex/models_cache.json` with `visibility` (`list`/`hide`), descriptions and reasoning levels                          | file                                                       | Model discovery for Codex is real, not guessed                                                                                               |
| `claude auth status` returns JSON `{loggedIn, authMethod, subscriptionType}` (plus email/org, which ThreadLink must not store)                       | probe → `subscriptionType: "max"`                          | Claude plan discovery is official                                                                                                            |
| `claude -p --output-format json` returns `modelUsage` keyed by the model that actually ran, and `permission_denials`                                 | probe                                                      | Observed model and approval-blocked state are structured                                                                                     |
| **`--model haiku` silently ran `claude-sonnet-5`** with no error; the full ID `claude-haiku-4-5-20251001` was honoured; `sonnet` → `claude-sonnet-5` | three probes                                               | **Requested ≠ observed happens.** Every run compares them and fails closed on mismatch                                                       |
| **`claude --bare` reads auth strictly from `ANTHROPIC_API_KEY`**, never subscription OAuth                                                           | `claude --help`                                            | **Never use `--bare`**: it would force API billing                                                                                           |
| `claude --safe-mode` disables CLAUDE.md, skills, plugins, hooks, MCP; keeps auth, model selection and built-in tools                                 | `claude --help`                                            | Team runs use `--safe-mode`; project rules are passed in the prompt instead                                                                  |
| A child process that inherits `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` may switch the CLI to paid API billing                                          | research (docs/research/claudex-loop-review.md)            | **The environment is scrubbed** for every agent run                                                                                          |

## 1. Architecture

```
ChatGPT (controller)
   │  MCP: create_room / start_team_job / get_team_status / get_team_log
   ▼
ThreadLink server (Vercel + Supabase)          durable record, RLS, controller API
   │  a team job travels as an ordinary task (task_type = 'team') over the
   │  room's existing link, so claim/lease/ack/notifications all still apply
   ▼
ThreadLink Runtime (the user's PC)             where the repo and both CLIs live
   └─ TeamOrchestrator
        ├─ normalise → plan (bounded rounds) → DAG → assign owners
        ├─ worktrees → parallel builders → cross-review (bounded) → fixes
        ├─ integration worktree → tests → final independent inspection
        └─ writes structured state back through /api/team/* (claim-gated)
```

The orchestrator runs on the Runtime because that is where the git repository,
the CLIs and the user's subscription logins are. The server never runs an agent.

A team job is carried by a normal ThreadLink task. That reuses routing, the
lease, acknowledgement and notifications unchanged. **Every team-state write is
authorised by the carrier task's claim**: only the agent session that holds the
claim (and its `claim_ref`) may write that job's state. That is the same check
`complete_task` already makes, so no new trust path is invented.

## 2. Domain model (smallest clean schema)

Consolidated deliberately. Dependencies, ownership and worktree live on the node;
review rounds are counters plus a `round` column on findings and messages; plans
and model capabilities live on the provider profile. Nine concepts, seven tables.

All IDs are ThreadLink-owned (`threadlink_private.generate_id`), all tables are
owner-scoped with RLS enabled and **no direct client grants** beyond owner
`select` where the dashboard needs it. Every write goes through a `security
definer` RPC that re-checks ownership and fails closed.

| Table                | Prefix        | Purpose                                                                                              |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `rooms`              | `tlrom`       | A project: name, workspace, policy, status (`active`/`archived`/`deleted`)                           |
| `room_agents`        | — (composite) | Which providers take part in a room, their friendly name, default roles                              |
| `team_jobs`          | `tljob`       | One goal: normalised spec, status, round counters and budgets, final verdict, evidence               |
| `team_nodes`         | `tlnod`       | One unit of work in the job's DAG: owner, reviewer, deps, scope, files, worktree branch, authorship  |
| `team_messages`      | `tlamg`       | Agent-to-agent messages and the review log: sender, receiver, type, round, body                      |
| `team_findings`      | `tlfnd`       | Structured review findings: severity, category, status, raised/resolved round                        |
| `team_decisions`     | `tldec`       | Decision log with a human number (`TL-00042`), proposals, evidence, resolution                       |
| `model_usage_events` | `tlmue`       | Requested vs observed model, class, effort, role, the routing **reason**, outcome                    |
| `provider_profiles`  | `tlprv`       | Per owner+provider: declared plan, detected capabilities, usage policy, **paid usage (default off)** |

`team_decisions.number` is a per-owner sequence rendered as `TL-%05d`.

### Enumerations (shared by SQL checks, zod and TypeScript)

- room status: `active | archived | deleted`
- provider: `claude-code | codex`
- role: `coordinator | planner | builder | reviewer | security_reviewer | test_reviewer | integrator | investigator`
- job status: `queued | normalising | planning | building | reviewing | integrating | inspecting | completed | needs_fix | blocked | needs_user_decision | failed | cancelled`
- job verdict (final): `PASS | NEEDS_FIX | BLOCKED | NEEDS_USER_DECISION` (null until final)
- node status: `pending | ready | running | in_review | changes_requested | approved | integrated | failed | skipped`
- message type: `proposal | review | finding | response | handoff | question | decision | completion`
- finding severity: `blocking | important | non_blocking`
- finding category: `correctness | security | architecture | edge_case | tests | performance | requirements`
- finding status: `open | resolved | wont_fix`
- model class: `FAST | BALANCED | STRONG | FRONTIER`
- usage policy: `conservative | balanced | maximum_quality | manual`
- claude plan: `free | pro | max_5x | max_20x | team | enterprise | unknown`
- chatgpt plan: `free | go | plus | pro | business_standard | business_premium | enterprise | edu | unknown`

### Bounds (enforced in SQL, not just prompts)

`max_planning_rounds` 1–5 (default 2 per the phase brief's defaults section),
`max_review_rounds` 1–6 (default 3), `parallel_agents` 1–4 (default 2).
Round counters can never exceed their budget: the RPC that opens a new round
refuses past the budget, and the orchestrator must then record
`needs_user_decision` / `NEEDS_FIX` rather than a PASS.

## 3. Runtime interfaces

### 3.1 Agent runner (new) — `runtime/src/team/runner.ts`

Team work is not "resume a user's conversation"; it is "run an agent in a role,
in a directory, with a model and a sandbox, and tell me exactly what happened".

```ts
export type AgentProvider = "claude-code" | "codex";
export type RunAccess = "read-only" | "workspace-write";

export type AgentRunRequest = {
  provider: AgentProvider;
  role: TeamRole;
  cwd: string; // a worktree, never the user's main checkout for writes
  prompt: string;
  model: string; // exact model id, never an unverified alias
  effort?: string; // provider effort / reasoning level
  access: RunAccess;
  outputSchema?: object; // JSON schema for a structured final answer
  resumeThreadId?: string; // continue this agent's own thread
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentRunResult = {
  ok: boolean;
  text: string; // final message
  structured?: unknown; // parsed per outputSchema, if requested and valid
  threadId: string | null; // provider-native id: metadata only
  requestedModel: string;
  observedModel: string | null;
  observedEffort: string | null;
  accessVerified: boolean; // the provider confirmed the sandbox we asked for
  permissionDenials: number; // structured "needed approval" signal
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
  failure?:
    | "model_mismatch"
    | "access_mismatch"
    | "quota_exhausted"
    | "not_authenticated"
    | "not_installed"
    | "timeout"
    | "provider_error";
};

export interface AgentRunner {
  readonly provider: AgentProvider;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

Invariants every runner must satisfy and test:

1. **stdin closed.** 2. **Environment scrubbed** of `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `AZURE_OPENAI_*`,
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`
   and any other variable that would switch to API billing. 3. **Explicit access**:
   Codex always gets `--ignore-user-config -s <access> -c approval_policy="never"`;
   Claude read-only runs get `--permission-mode plan` plus disallowed write tools,
   write runs get `acceptEdits`; both get `--safe-mode`. 4. **Never** `--bare`,
   never `--fallback-model`, never `--dangerously-*`. 5. **Observed model compared
   to requested**; a mismatch returns `failure: "model_mismatch"` and `ok: false`.
2. **Observed access compared to requested** (Codex rollout `sandbox_policy`);
   mismatch → `access_mismatch`. 7. Only metadata lines of the Codex rollout are
   read, never message content. 8. Quota/rate-limit/usage-exhausted output maps to
   `quota_exhausted`, never to a silent retry on another provider.

### 3.2 Provider discovery — `runtime/src/team/discovery.ts`

```ts
export type ProviderDiscovery = {
  provider: AgentProvider;
  installed: boolean;
  executable: string | null; // not sent to the server
  version: string | null;
  authenticated: boolean;
  authMethod: string | null; // "claude.ai" / "chatgpt"; never a token
  detectedPlan: string | null; // e.g. "max"; null when not exposed
  models: DiscoveredModel[];
  currentModel: string | null;
  capabilities: TeamCapabilities;
  usage: { remaining: "unknown" }; // no CLI exposes a number today: never invent one
};

export type DiscoveredModel = {
  id: string;
  displayName: string;
  description: string | null;
  efforts: string[];
  defaultEffort: string | null;
  source: "catalog" | "observed" | "configured";
};

export type TeamCapabilities = {
  supportsBackgroundWorker: boolean;
  supportsExactResume: boolean;
  supportsOpenConversation: boolean;
  supportsFork: boolean;
  supportsModelSelection: boolean;
  supportsUsageStatus: boolean;
  supportsParallelWorker: boolean;
  supportsReadOnlyReview: boolean;
};
```

Claude has no programmatic model list. Its catalogue is therefore the models it
has actually been **observed** running plus the full IDs the user configures;
aliases are resolved only after a run confirms them. Email and org ID from
`claude auth status` are dropped at the boundary and never leave the machine.

### 3.3 Model router — `runtime/src/team/router.ts` (pure)

```ts
export type ModelClass = "FAST" | "BALANCED" | "STRONG" | "FRONTIER";

export type RouteInput = {
  provider: AgentProvider;
  role: TeamRole;
  complexity: "trivial" | "low" | "medium" | "high";
  risk: { security: boolean; database: boolean; architecture: boolean; deployment: boolean };
  contextLarge: boolean;
  previousFailures: number;
  disputedFindings: number;
  policy: UsagePolicy;
  overrides: RouteOverride[]; // per-room "always use X for Y" / "never use Z for W"
  available: ClassifiedModel[]; // discovered models with their class
  exhausted: Set<string>; // models/providers with no included usage left
};

export type RouteDecision =
  | {
      ok: true;
      model: string;
      effort: string | null;
      modelClass: ModelClass;
      reason: string;
      escalatedFrom?: ModelClass;
      escalationReason?: string;
    }
  | {
      ok: false;
      reason: string;
      options: ("wait_for_reset" | "use_other_provider" | "reduce_tier" | "ask_user")[];
    };
```

Class assignment is a **default policy table** keyed on model family and
description, overridable per model by the user — not a quality ranking and
never a permanent "Fable is strongest". Escalation is stepwise and recorded:
repeated failure → one class up; security/database/architecture/deployment risk
or disputed findings on review → FRONTIER reviewer; never above the policy's
ceiling unless the user's override allows it. Every decision returns a
human-readable `reason`, stored on `model_usage_events`.

### 3.4 Usage governor — `runtime/src/team/usage.ts` (pure + state)

`paidUsage` defaults to **off** and nothing in ThreadLink can turn it on except
an explicit user setting. When a provider reports exhaustion the governor marks
it exhausted until reset and the router returns `ok: false` with the options
above. **No automatic provider substitution**: the orchestrator surfaces the
options as a `needs_user_decision` unless the room's policy already chose one.

### 3.5 Task graph — `runtime/src/team/dag.ts` (pure)

Validate (unique keys, known deps, **acyclic**), compute ready nodes, and
**overlap analysis**: two nodes whose declared file globs or directories
intersect are serialised (an implicit dependency is added and recorded) rather
than run in parallel. Merge order for integration is a deterministic
topological order with key as tiebreak.

### 3.6 Worktrees — `runtime/src/team/worktrees.ts`

`.threadlink/worktrees/<job>-<node>` on branch `threadlink/<job>/<node>`,
created from the job's base commit. The user's own checkout is **never written
to**: no checkout, no stash, no reset. Uncommitted user changes are left exactly
where they are and the job's base is `HEAD`, stated in the job evidence. Cleanup
removes only worktrees and branches ThreadLink created and recorded. Worktrees
isolate git edits; **they are not a security sandbox** and the UI must not say so.

### 3.7 Orchestrator — `runtime/src/team/orchestrator.ts`

State machine, every loop bounded by the job's budgets:

1. **Normalise** the goal into the spec (goal, requirements, constraints,
   architecture/security constraints, files/systems, tests required, do-not-change,
   deployment rules, definition of done). Stored once; agents receive it verbatim
   and may not reinterpret it.
2. **Plan**: planner proposes a DAG with owners → the other provider reviews
   (structured) → respond … at most `max_planning_rounds`. Only `blocking` /
   `important` findings open another round. The agreed plan is hashed; any later
   edit invalidates approval (idea from claudex-loop, independently implemented).
3. **Assign** owners and reviewers. Rule: **the reviewer of a node is never the
   node's author provider**. Ownership is committed and can only change through a
   recorded `decision`.
4. **Build** ready nodes in parallel (≤ `parallel_agents`) in their worktrees.
5. **Review** each node by the other provider, read-only, structured findings.
   `blocking`/`important` → owner fixes → re-review, at most `max_review_rounds`.
   Exhausted → node `failed`, job heads to `NEEDS_FIX` / `needs_user_decision`.
   **A PASS is never manufactured.** A reviewer that wants to change code files a
   finding; if it does contribute, authorship becomes mixed and is recorded.
6. **Integrate** in `.threadlink/worktrees/<job>-integration` in deterministic
   order; stop on conflict (never auto-resolve non-trivial conflicts); run the
   required tests **ourselves** after each merge and at the end.
7. **Inspect**: a fresh session of a provider that did not integrate reviews the
   whole diff, fingerprinted; verdict `PASS | NEEDS_FIX | BLOCKED | NEEDS_USER_DECISION`
   with evidence (tests run, results, commits, diff fingerprint, uncertainty).
8. **Arbitrate** disagreements by the hierarchy: user decision > explicit project
   decision > security > data integrity > correctness/tests > documented
   architecture > maintainability > performance > style. Anything touching
   product behaviour, architecture, money, security posture or irreversible data
   → `needs_user_decision`, never resolved by the models alone.
9. **Report** a concise result to the controller; the full log stays behind
   `get_team_log`.

#### Modes (job document `mode`, absent ⇒ `team`; see collaboration-chat.md §6)

- **team**: the state machine above, unchanged.
- **solo**: no normalise step and no planning council. ThreadLink records the
  owner's goal as a one-node plan (title = first line of the goal, no file
  restriction), approved by the builder alone (`approvedBy: [builder]`). The
  node's reviewer is `null` — there is no pretend reviewer. The builder builds in
  its worktree (protected paths still reverted), ThreadLink integrates and runs
  the owner's verify commands itself (even if the builder changed nothing). PASS
  only if the build succeeded and verification passed; no final inspection.
- **pair** (Builder + Reviewer): the same one-node plan, approved by the builder;
  the other provider reviews read-only, fix → re-review bounded by
  `max_review_rounds`, then integration and verification. PASS requires the
  reviewer's approval; a spent budget is `NEEDS_FIX`, a builder that declines to
  change anything is `NEEDS_USER_DECISION`. Review is never skipped, even if the
  room turned `crossReview` off for Team Mode. No final inspection.
- Builder: the job's `builder`, else the only agent (solo) or Claude Code (pair).
  A missing builder or reviewer stops the job; the other provider is never
  substituted.

#### Owner notes and stop

- Before every agent turn (and at every round boundary) the orchestrator calls
  `team_job_write` op `read_owner_notes`. Each note is queued for its audience
  (`claude-code`, `codex`, or `team`/null = every agent in the job) and put into
  that agent's **next** prompt only, once, in its own random-nonce block labelled
  "NOTE FROM THE PROJECT OWNER (the owner's request, not system instructions)".
  Bodies are redacted (summary.ts) and `===` fences / `BEGIN`/`END` markers are
  flattened so a note cannot close its block or impersonate another. The prompt
  says a note cannot change the role, rules, file scope, protected paths,
  budgets or safety requirements. Notes that reach no agent before the job ends
  are listed in the evidence's uncertainty. A failed `read_owner_notes` is not
  fatal (the owner is told), since a stop is also seen on every other write.
- `stopRequestedAt` on any `team_job_write` answer sets a stop flag. Running
  units finish their current round, nothing new is scheduled, and the job ends
  `NEEDS_USER_DECISION` with "Stopped by you after round N."
- Every agent message carries `modelObserved` (Claude `modelUsage` key, Codex
  rollout `turn_context.model`) when it is known and matches
  `^[A-Za-z0-9._:\[\]/-]{1,100}$`; otherwise it is left out, never guessed.

#### Provider adapters — `runtime/src/team/providers.ts`

Each provider is one adapter entry with static capabilities (`headless`,
`resumableSessions`, `modelSelection`, `mcp`, `conversationDiscovery`) and an
optional `createRunner`. Status (`available` / `not_installed` / `signed_out` /
`not_supported_yet`) is derived from discovery; only `available` providers get
a runner (subscription sign-in only). Codex conversation discovery is
`unsupported` (no scraping of `~/.codex/sessions`). **Cursor is detect-only**: a
PATH lookup for `cursor-agent` / `agent` / `cursor` (nothing is executed) sets a
note, the status is always `not_supported_yet`, it has no runner and is not an
`AgentProvider`, so no job can route to it. A future adapter adds a runner here
without orchestrator changes.

## 4. Server surface

Controller MCP tools (all require the controller's own session and room
ownership; cross-room and cross-account IDs fail with the same generic error):

- `list_rooms`, `create_room`, `get_room`
- `start_team_job` → creates the carrier task (`task_type = 'team'`) and the job
- `get_team_status` → concise: per node owner/status, round n/max, open findings
- `get_team_log` → full structured log, paginated and bounded
- existing `acknowledge_result` works on the carrier task

Runtime endpoints (agent credential + carrier-task claim): `POST /api/team/jobs/[jobId]/state`
(one endpoint, a discriminated union of write operations: spec, plan, nodes,
node status, message, finding, finding status, decision, round, usage event,
final verdict). Owner (dashboard) server actions: rooms rename/archive/delete,
provider profiles (plan, policy, paid usage), devices rename/revoke/remove,
conversations "remove from ThreadLink".

## 5. Safety invariants (each has a test)

- Reviewer provider ≠ author provider for every reviewed node.
- Round counters never exceed budgets; exhausted budget never yields PASS.
- Cross-room, cross-account and cross-workspace IDs are rejected (generic error).
- A Runtime can write team state only for a job whose carrier task it has claimed.
- No child agent process sees an API-key or third-party-provider variable.
- No run uses `--bare`, `--fallback-model`, `danger-full-access` or a bypass flag.
- Requested ≠ observed model → run fails, recorded, never silently accepted.
- Provider failure never silently substitutes another provider.
- Paid usage is off by default and nothing flips it except the user.
- Messages, findings and logs pass through the same redaction as activity summaries
  before storage, and are length-bounded.
- Removing a conversation from ThreadLink never deletes the provider's native history.
- Deleting a room never deletes repository files.

## 6. Build ownership (who edits what, so parallel work cannot collide)

| Track                     | Owns (may create/edit)                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema & server           | `supabase/migrations/20260925*`, `supabase/tests/database/011_*`, `lib/team/**`, `lib/rooms/**`, `lib/providers/**`, `app/api/team/**`, MCP tool additions in `lib/mcp/**`, `tests/team-server*.test.ts`, `tests/integration/team*` |
| Agent runners & discovery | `runtime/src/team/runner.ts`, `runtime/src/team/runners/**`, `runtime/src/team/discovery.ts`, `runtime/src/team/env.ts`, `tests/runtime/team-runners*.test.ts`, `tests/runtime/fake-codex.mjs`                                      |
| Router, usage, DAG        | `runtime/src/team/router.ts`, `usage.ts`, `dag.ts`, `types.ts`, `tests/runtime/team-router*.test.ts`, `team-dag*.test.ts`, `team-usage*.test.ts`                                                                                    |
| Orchestrator & worktrees  | `runtime/src/team/orchestrator.ts`, `worktrees.ts`, `prompts.ts`, `api.ts`, engine wiring                                                                                                                                           |
| Web UX                    | `app/dashboard/**` pages, `components/**`, `lib/dashboard/**`                                                                                                                                                                       |
| Desktop UX                | `desktop/renderer/**`                                                                                                                                                                                                               |

`runtime/src/team/types.ts` holds the shared enums above and is created first.

## 7. What real runs with Claude Code and Codex changed

`tests/runtime/team-e2e.real.test.ts` runs the whole pipeline with the real CLIs
(skipped unless `THREADLINK_REAL_AGENTS=1`). Six real runs, each exposing
something the fakes could not, all now fixed and covered by ordinary tests:

| Run | What happened                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude answered a planning prompt in prose; ThreadLink refused to guess (BLOCKED)                                                                                                                                                       | Claude runs with `--json-schema`; it validates its own answer and returns `structured_output`                                                                                                                                                                                    |
| 2   | **Codex ran a `workspace-write` request as `read-only`** — caught by the rollout check                                                                                                                                                  | On Windows the sandbox needs a backend; the user's config names one but is ignored (it also sets full access), so `-c windows.sandbox="unelevated"` is passed explicitly. Verified: real `workspace-write`, network off                                                          |
| 2   | When one unit stopped the job, the other agent was still writing; cleanup failed on its worktree                                                                                                                                        | A stop aborts every in-flight run and waits for it before cleanup                                                                                                                                                                                                                |
| 3   | Claude's review of Codex's `mul.js` was **correct** (a real export bug), but a BLOCKED code review ended the unit with no fix round                                                                                                     | BLOCKED and REVISE both go back to the owner; the review budget still bounds it                                                                                                                                                                                                  |
| 5   | The loop ran three bounded rounds and ended at NEEDS_FIX honestly — but the reviewer demanded another unit's files, a builder strayed out of scope, the normaliser invented a requirement, and a genuine disagreement burned the budget | Reviewers are told about the other units; out-of-scope and agent-steering files are undone after every build; the normaliser may not decide implementation details; a builder that declines every finding makes it a decision for the owner (NEEDS_USER_DECISION), not NEEDS_FIX |
| 6   | **PASS.** Codex challenged the plan as over-split; Claude revised it; Claude built, Codex reviewed, ThreadLink ran the tests itself, Codex inspected                                                                                    | —                                                                                                                                                                                                                                                                                |

Every run recorded the requested and observed model for every call; they always matched.

## 8. Security review changes

An adversarial review (`supabase/tests/database/012_team_security.test.sql`,
`tests/runtime/team-security.test.ts`, `tests/team-security.test.ts`) found two
blocking and seven important issues. All are fixed; the tests that documented
them now pass as ordinary assertions.

- **Only subscription sign-ins are used.** Codex signed in with an API key, or
  Claude signed in any way but `claude.ai`, is not given a runner, and the server
  refuses to start a team job for it.
- **Agent-written code runs without secrets and without git hooks.** Test commands
  (which execute agent-written tests) and git get the same scrubbed environment as
  the agents, and every git call sets `core.hooksPath` to an empty directory. This
  removes secrets from reach; it is **not a sandbox**.
- **Only the project's owner sets the test commands.** A chat — possibly
  prompt-injected — cannot supply shell commands; `start_team_job` refuses them.
- **The Team Mode gate is per Runtime**: the room's own computer must run 0.7.0+,
  and both agents must be reported installed and signed in with a subscription.
- **The `team` task type is reserved**, in TypeScript and by a database trigger that
  only `start_team_job` can pass.
- **PASS cannot be reached around the rules**: a failed unit is final, an approved
  unit can only be integrated, a started unit's definition is fixed, PASS needs an
  approved plan and at least one unit, and a question for the owner stays open
  until the owner answers it.
- **Agents cannot steer their own reviewers**: `CLAUDE.md`, `AGENTS.md`, `.claude/`,
  `.codex/`, MCP config and hook folders are always undone after a build, and
  prompt delimiters carry a random id that repository text cannot forge.
- **More redaction**: prefixed secrets (`DB_PASSWORD=`), URL credentials, email
  addresses, Windows paths with either slash or spaces, and paths in stack traces;
  plans, specs and unit text are redacted before they leave the computer.
- A chat sees only the jobs it started; detection reports refuse identity-shaped
  keys and email values at any depth.
