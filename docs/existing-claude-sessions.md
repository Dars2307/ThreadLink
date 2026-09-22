# Existing Claude Code Session Attachment (Phase 6.5)

ThreadLink can deliver tasks into an **existing** Claude Code session instead of starting a fresh
headless run for every task. This page records what was verified, how the attachment works, and
exactly what ThreadLink promises.

## What we verified (Claude Code 2.1.266, Windows)

| Behaviour                                                       | Result                                                                                                                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude -p --resume <id> --output-format json`, prompt on stdin | Works; the reply uses the prior context (a codeword given earlier was recalled)                                                                                                                |
| Session ID after resume                                         | **Unchanged** (Claude Code only forks with `--fork-session`)                                                                                                                                   |
| Transcript                                                      | The new turn is appended to the same `<id>.jsonl`                                                                                                                                              |
| Second resume                                                   | Same ID, context still retained                                                                                                                                                                |
| Unknown ID                                                      | Exit 1, `No conversation found with session ID: …`; nothing created                                                                                                                            |
| Resume from a **different** folder                              | Claude Code accepts it and runs tools in the wrong folder, so the bridge always runs in the session's recorded workspace and only attaches sessions recorded there                             |
| Session running as a background session (`claude --bg`)         | Claude Code itself refuses: `Session … is running as a background session … claude stop … or --fork-session`                                                                                   |
| Running sessions                                                | Listed by the official `claude agents --json` (`sessionId`, `pid`, `kind`, `status`, `cwd`, `name`), including interactive terminal and Claude desktop sessions and in-flight `claude -p` runs |
| Interactive session open in a terminal                          | Not reliably testable headlessly. ThreadLink does not rely on Claude Code's behaviour here: it refuses on its own (see below)                                                                  |

`tests/bridge/claude-real.test.ts` reproduces these checks against the real CLI:

```bash
THREADLINK_REAL_CLAUDE=1 npx vitest run tests/bridge/claude-real.test.ts
```

## Model

- The canonical identity stays the ThreadLink `tlses_`.
- The Claude Code session UUID is **adapter metadata** on that session:
  - `native_provider_session_id`
  - `native_session_mode` (`fresh` | `resume` | `continue`)
  - `workspace_path`
  - `native_attached_at`
- Nothing routes, authorizes or looks anything up by the native ID.
- Only the owning agent connection can set it (`set_native_session`).
- Controllers never see it. `list_agent_sessions` returns only the workspace folder name and
  whether an existing session is attached.
- `resume` requires a native ID, and only `resume` carries one (enforced by a database `CHECK`).

## Discovery (local, metadata only)

The bridge lists sessions for a workspace from Claude Code's persisted state. It does not scrape
UI, automate keystrokes or guess IDs.

- **Where it looks:** `<claude home>/projects/<cwd with non-alphanumerics replaced by "-">/<uuid>.jsonl`.
  The directory encoding is lossy, so a transcript counts only if its recorded `cwd` equals the
  workspace.
- **Titles:** the most recent `custom-title`, then `agent-name`, then `ai-title` record.
- **Last used:** the transcript's modification time.
- **Open now:** the session appears in `claude agents --json`.
- **What it reads:** only file names, times, `cwd` and title records. Conversation content is
  never parsed, uploaded or logged.

## Attach flow

`threadlink-bridge setup` does the following:

1. Browser sign-in (device authorization).
2. Registers or reuses the workspace `tlses_`.
3. Lists the sessions as `N) title · last used · 04158991… · open now`.
4. You pick one. If discovery finds nothing, you can type an ID, which is verified to exist in
   this workspace.
5. The bridge stores the attachment locally and reports it to ThreadLink.

To change the session later, run `threadlink-bridge attach` (or `attach --fresh`).

## Execution

Each task runs:

```bash
claude -p --resume <id> --output-format json --permission-mode plan
```

- It runs in the workspace, with no shell, and the prompt goes on stdin.
- Lease, claim and heartbeat rules are unchanged.
- The reply is accepted only if Claude Code reports the **same** session ID. Anything else is
  discarded as `native_session_unavailable`.

## Concurrency: fail closed

Before every resume, the bridge:

1. Takes a per-session lock file (`<config>/locks/<id>.lock`, stale locks from dead PIDs are
   reclaimed). This serialises bridge processes on the machine.
2. Asks `claude agents --json`. If the session is listed anywhere (interactive, desktop,
   background or another `-p` run), or the listing cannot be obtained, the task fails with
   `failure_reason = session_busy` and a clear message. ChatGPT sees _"Claude session was open
   elsewhere"_.
3. Treats Claude Code's own "already running" refusal as `session_busy` too.

ThreadLink **never** falls back to a new or forked session silently.

There is a small window between the check and the start of the process. Closing that window would
need Claude Code to provide a lock, which it does not expose.

## What ThreadLink promises (UI expectation)

ThreadLink promises:

- **Same Claude session and context.** The task becomes a new turn in the attached session's
  history, with its prior context available.

ThreadLink does **not** promise:

- **Live insertion into an already-open terminal or Claude desktop window.** An open UI does not
  live-refresh with turns added from outside. That is exactly why ThreadLink refuses to write
  while the session is open.

After a ThreadLink turn, reopening the session (`claude --resume <id>`) shows it. Close the
session in Claude Code (or stop the background agent) while you want ThreadLink to deliver to it.
