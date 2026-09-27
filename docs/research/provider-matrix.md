# Provider support matrix (research, 2026-09-26)

Scope: which coding agents besides Claude Code and Codex could be run by the
ThreadLink runtime headlessly, on the user's **subscription**, in a git
worktree, with read-only vs workspace-write enforcement, structured output,
observed-model verification, native session id and resume
(`docs/design/threadlink-0.10.md` §10).

Method: official docs only, plus harmless local checks on this Windows 11
machine (`where`, `--version`, `--help`). No agent task was run, no login or
logout was done. "Not documented" means we did not find it in official docs; it
does **not** mean the feature is absent. Nothing here is "Supported" until it
passes the certification harness.

## Local install check (this machine)

| Command                                                           | Result                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `where cursor-agent`, `where agent`                               | not found                                                                                                                                                                                                         |
| `cursor --version`                                                | `3.17.8` (Cursor editor). `cursor --help` lists subcommand `agent  Start the Cursor agent in your terminal.` `%LOCALAPPDATA%\cursor-agent\` holds only `worker.lock`; the standalone CLI binary is not installed. |
| `where gemini / copilot / amp / aider / opencode / devin / droid` | not found                                                                                                                                                                                                         |
| `pi --version` (npm `@earendil-works/pi-coding-agent`)            | `0.84.2` installed; `--help` shows `-p`, `--mode json\|rpc`, `--session-id`, `--tools`                                                                                                                            |
| `qodo --version`                                                  | `0.31.1` installed; needs Qodo login or `QODO_API_KEY` (own credits, not researched further)                                                                                                                      |

## Matrix

Legend: Y = documented, N = documented absent, ? = not documented / unverified.

|                       | Cursor CLI                                                                           | Gemini CLI                                                                                  | Copilot CLI                                                                                      | Devin CLI (ex-Windsurf)                                           | Amp                                       | OpenCode                                                                      | Aider                       | Factory Droid                               | Pi                                                                             |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Headless              | Y `agent -p` [C1]                                                                    | Y `-p` [G1]                                                                                 | Y `-p` [P1]                                                                                      | Y `-p` [D1]                                                       | Y `-x` [A1]                               | Y `opencode run` [O1]                                                         | Y `--message` [R1]          | Y `droid exec` [F1]                         | Y `-p` (local help)                                                            |
| JSON / stream         | Y `json`, `stream-json` [C2]                                                         | Y `json`, `stream-json` [G1]                                                                | Y `--output-format json` (JSONL) [P1]; event schema ?                                            | ? (only `--export` ATIF; ACP JSON-RPC) [D1]                       | Y `--stream-json` [A1]                    | Y `--format json` [O1]                                                        | N [R2]                      | Y `json`, `stream-jsonrpc` [F1]             | Y `--mode json\|rpc` (local help)                                              |
| Native session id     | Y `session_id` on every event [C2]                                                   | Y `session_id` in `init` [G2]                                                               | Y; exit summary prints `--resume=ID` [P1]                                                        | Y `--resume <SESSION_ID>` [D1]                                    | Y thread ids [A2]                         | Y `--session` [O1]                                                            | N (history file only) [R2]  | Y `session_id` in json [F1]                 | Y `--session-id` (local help)                                                  |
| Resume by id          | Y `--resume [chatId]` [C3]                                                           | Y `--resume <id>` [G3]                                                                      | Y `--resume=ID`, `--session-id ID` (creates if valid UUID) [P1]                                  | Y [D1]                                                            | Y `threads continue` [A2]                 | Y `-s` [O1]                                                                   | N                           | Y `-s` [F1]                                 | Y                                                                              |
| Model select          | Y `--model` [C3]                                                                     | Y `-m` incl. `auto` [G3]                                                                    | Y `--model`, `auto` [P1]                                                                         | Y `--model` [D1]                                                  | Modes, not free choice [A2]               | Y `provider/model` [O1]                                                       | Y [R2]                      | Y `-m` [F1]                                 | Y                                                                              |
| Actual model reported | Display name in init event only [C2]                                                 | `init.model` + per-model `stats.models` in result [G2]                                      | ?                                                                                                | ?                                                                 | ?                                         | ?                                                                             | ?                           | ?                                           | ?                                                                              |
| MCP                   | Y [C3]                                                                               | Y [G3]                                                                                      | Y [P2]                                                                                           | Y `devin mcp` [D1]                                                | Y [A2]                                    | Y                                                                             | ?                           | Y                                           | via extensions                                                                 |
| Subscription auth     | Browser login (`agent login`) or API key [C4]; billing of CLI use vs plan not stated | Google login incl. AI Pro/Ultra and free tier [G4]; headless docs say pre-set env vars [G4] | Copilot plan; "AI credits are consumed" also for programmatic use [P2]; BYOK env vars exist [P2] | ACUs/credits of Devin/Windsurf plan [D1]                          | Execute mode "paid credits only" [A1]     | ChatGPT Plus, Copilot, GitLab Duo; Claude Pro/Max explicitly not allowed [O2] | API keys only [R2]          | `FACTORY_API_KEY`, Factory plan tokens [F1] | Claude/ChatGPT OAuth (README); Claude use conflicts with Anthropic policy [O2] |
| Read-only enforceable | `--mode ask\|plan`; permission allow/deny for Read/Write/Shell [C3][C5]              | `--approval-mode plan` = read-only, enforced by policy engine, works headless [G5]          | `--available-tools` / `--deny-tool`; `--plan` [P1]                                               | `--permission-mode normal` default; no read-only mode listed [D1] | allowlist; `--dangerously-allow-all` [A1] | `edit: deny` per agent; `--auto` keeps denies [O3]                            | `--read` per file only [R2] | Y, read-only is the default [F1]            | `--tools` allowlist; "No permission popups" (README)                           |
| OS sandbox            | `--sandbox enabled`; Windows runs it in WSL2 [C6]                                    | Seatbelt, containers, **Windows native** (icacls) [G6]                                      | `--sandbox` experimental only [P1]                                                               | Linux/macOS only; Windows needs WSL2 [D1]                         | ?                                         | N [O3]                                                                        | N                           | ?                                           | N (README)                                                                     |
| Windows               | Native PowerShell installer [C7]                                                     | Y [G4]                                                                                      | PowerShell + WSL [P2]                                                                            | PowerShell installer [D2]                                         | ?                                         | ?                                                                             | Y                           | npm [F1]                                    | Y (docs/windows.md)                                                            |
| Cancellation          | ?                                                                                    | ? (exit codes 0/1/42/53 only) [G1]                                                          | ?                                                                                                | ?                                                                 | ?                                         | ?                                                                             | ?                           | ?                                           | ?                                                                              |
| Stability             | Auto-updates by default [C7]; schema adds fields only [C2]                           | Weekly stable/preview/nightly channels [G7]; open source                                    | Frequent changelog; `--sandbox` experimental [P1]                                                | ?                                                                 | ?                                         | ?                                                                             | Python API unsupported [R1] | ?                                           | pre-1.0                                                                        |
| **Verdict**           | **Candidate — adapter feasible**                                                     | **Candidate — adapter feasible**                                                            | **Candidate — adapter feasible**                                                                 | Not suitable now                                                  | Not suitable now                          | Not suitable now                                                              | Not suitable now            | Not suitable now                            | Not suitable now                                                               |

## Gaps per provider

- **Cursor CLI.** Binary not installed here (only the editor's `cursor agent`
  launcher). Model is reported as a _display name_, not an id, so observed-model
  verification needs a name map. The docs do not say whether CLI use draws on the
  plan or on separate billing. `CURSOR_API_KEY` must be treated as API-key mode
  and refused. Auto-update defeats version pinning. The Windows sandbox depends
  on WSL2.
- **Gemini CLI.** It is not documented that a cached Google login works for `-p`:
  the auth page tells headless users to set env vars (`GEMINI_API_KEY` / Vertex),
  and that would be API billing. That must be certified on a real machine before
  anything else. `init.model` may be the requested alias (`auto`), so the true
  model has to come from `result.stats.models`, which can list more than one model
  per run. Sessions are listed per project, so resume must run in the same
  worktree cwd. Cancellation is not documented.
- **Copilot CLI.** Needs `--allow-all-tools` for `-p` [P1], so read-only has to
  come from `--available-tools`, not from approval prompts. The JSONL event schema
  and model reporting are not documented. BYOK variables (`COPILOT_PROVIDER_*`)
  and token env vars change billing and identity, so they must be stripped. Usage
  consumes plan "AI credits", which can go into overage if the user enabled a
  budget. `--session-id <uuid>` lets ThreadLink choose the native id up front,
  which fits the binding model well.
- **Devin CLI / Windsurf.** No documented JSON output for `-p`. The only
  structured interface is ACP, which is meant for an IDE. No read-only permission
  mode is documented. Billing is in ACUs.
- **Amp.** Headless execute mode uses paid credits only, which conflicts with the
  subscription-only rule. Most of the manual is now behind sign-in.
- **OpenCode.** It is a multi-provider harness, so it has no first-party
  subscription of its own. Claude subscription use is explicitly not permitted.
  It has no OS sandbox. It could be reconsidered later for ChatGPT or Copilot
  subscriptions.
- **Aider.** API keys only, no JSON output, no native session.
- **Factory Droid.** It has the cleanest headless design (read-only by default,
  `session_id` in JSON), but it authenticates by API key against a Factory plan.
  It is not a user subscription in ThreadLink's sense.
- **Pi.** It is installed, and its CLI surface fits well (`--session-id`,
  `--mode json`). But subscription use of Claude through a third-party harness
  conflicts with Anthropic policy [O2], and it has no permission system or
  sandbox. Not suitable.

## Recommendation

**Next adapter: Gemini CLI**, with Copilot CLI as a close second.

Reasons:

- It is the only candidate whose read-only mode is documented as enforced by a
  policy engine in headless runs [G5].
- It has a documented native Windows sandbox [G6].
- Its JSON event types are in the open-source code (`InitEvent.session_id`,
  `model`, and `ResultEvent.stats.models`, in
  `packages/core/src/output/types.ts` [G2]).
- It has versioned release channels that can be pinned [G7].

Everything depends on one item: proving that a Google-login (AI Pro/Ultra or free)
session works for `gemini -p` **without** any API-key environment variable. If it
does not, Gemini CLI drops to "Not suitable now" and Copilot CLI becomes next.

Cursor stays "Not available yet" until the standalone `agent` binary is
installed and its billing and auto-update behaviour are certified.

## Harness additions for Gemini CLI (§10)

1. **Fake CLI fixtures.** Emit `stream-json` lines for `init`, `message`,
   `tool_use`, `tool_result`, `error` and `result`. Cover exit codes 0, 1, 42
   (input) and 53 (turn limit), each mapped to a ThreadLink failure reason.
2. **API-key detection / fail closed.** Refuse to run, or strip, when any of
   these is set: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`,
   `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`. Also verify that the
   selected auth type in `~/.gemini/settings.json` is the Google login. The exact
   key name must be confirmed against the installed version.
3. **Observed model.** Compare the requested `-m` against the `stats.models`
   keys. Define a policy for `auto` routing and for multi-model runs
   (fail, or record all models).
4. **Read-only.** Run with `--approval-mode plan`, attempt a write and a shell
   mutation, and assert the worktree is unchanged (`git status` clean), apart
   from files in the plans directory.
5. **Workspace-write.** Use `auto_edit` plus a policy file that allows shell only
   inside the worktree. Assert no writes outside it. Check folder trust:
   `--skip-trust` must be allowed only for ThreadLink-created worktrees.
6. **Session.** Capture `session_id` from `init`. Resume with `--resume <id>`
   from the same cwd. Detect a wrong session when the id is replayed from a
   different worktree (project-scoped sessions).
7. **Cancellation on Windows.** Cancellation is undocumented, so the harness
   must prove that a process-tree kill of the npm `.cmd` shim leaves no orphan
   `node` process.
8. **Terminal-safe argv.** Pass the prompt via stdin or a file, not the command
   line, so the `.cmd` shim cannot mis-quote it.
9. **Quota.** Map Google quota and rate-limit errors (free and Pro tiers) to the
   `quota` check, and never fall back to an API key.

## Sources

- [C1] https://cursor.com/docs/cli/headless
- [C2] https://cursor.com/docs/cli/reference/output-format
- [C3] https://cursor.com/docs/cli/reference/parameters
- [C4] https://cursor.com/docs/cli/reference/authentication
- [C5] https://cursor.com/docs/cli/reference/permissions
- [C6] https://cursor.com/blog/agent-sandboxing , https://cursor.com/docs/reference/sandbox
- [C7] https://cursor.com/docs/cli/installation
- [G1] https://geminicli.com/docs/cli/headless/
- [G2] https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts
- [G3] https://geminicli.com/docs/cli/cli-reference/
- [G4] https://geminicli.com/docs/get-started/authentication/
- [G5] https://geminicli.com/docs/cli/plan-mode/
- [G6] https://geminicli.com/docs/cli/sandbox/
- [G7] https://github.com/google-gemini/gemini-cli#release-channels
- [P1] https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- [P2] https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli
- [D1] https://docs.devin.ai/cli/reference/commands
- [D2] https://docs.devin.ai/cli
- [A1] https://ampcode.com/manual (execute-mode section; full page now behind sign-in) , https://ampcode.com/news/streaming-json
- [A2] https://ampcode.com/manual
- [O1] https://opencode.ai/docs/cli/
- [O2] https://opencode.ai/docs/providers/
- [O3] https://opencode.ai/docs/permissions/
- [R1] https://aider.chat/docs/scripting.html
- [R2] https://aider.chat/docs/config/options.html
- [F1] https://docs.factory.ai/cli/droid-exec/overview
- Pi: local `pi --help` and the package README (`@earendil-works/pi-coding-agent` 0.84.2), https://github.com/earendil-works/pi
