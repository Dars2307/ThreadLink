# ThreadLink Claude Code Bridge

`bridge/` is a small, dependency-free TypeScript CLI that runs on your machine. It holds a
`claude-code` (agent) connection credential and polls ThreadLink for tasks routed to this
workspace. It delivers each task through official **headless Claude Code** (`claude -p`), then
reports progress and the result back.

By default the task **resumes the Claude Code session you attached** (`claude -p --resume <id>`),
so it continues that conversation's context. Otherwise it runs in a fresh session.

It never injects keystrokes into, or scrapes, an open terminal or Claude desktop window. While the
attached session is open elsewhere, tasks fail with a clear `session_busy` status rather than
writing into it (see [existing-claude-sessions.md](existing-claude-sessions.md)).

It requires Node 22.18 or later, which runs the `.ts` sources directly. Claude Code must be on
`PATH` for the `claude` executor.

## Setup (one command)

Install the command once from the ThreadLink repo:

```bash
npm link ./bridge
```

Or run `node bridge/src/cli.ts` instead of `threadlink-bridge`. Then, in your project folder:

```bash
threadlink-bridge setup --url https://<your-threadlink>
```

The guided setup:

1. **Signs in through your browser** (device authorization).
   - It prints a code like `BCDF-GHJK` and opens `/connect`.
   - You sign in with Clerk and approve the code.
   - The bridge then receives a new Claude Code (agent) credential, confirms which account approved
     it (masked email), and stores it in the OS credential store.
   - Nothing is copied by hand.
2. **Registers or reuses** this workspace's ThreadLink session.
3. **Lists your existing Claude Code sessions** for this folder (title, last used, masked ID,
   "open now"). You pick one, and future tasks resume it. You can also choose "fresh session per
   task". Details: [existing-claude-sessions.md](existing-claude-sessions.md).
4. **Confirms the ChatGPT link.**
   - In ChatGPT, say _"Link this chat to Claude Code"_. This uses the `link_to_claude` MCP tool.
     Alternatively, click **Link** in the dashboard.
   - The waiting setup shows the request, and you confirm it with `y`. Nothing is ever
     auto-linked.
5. Reports **Ready** and offers to start delivering tasks.

For non-interactive use:

```bash
threadlink-bridge setup --url … --session <id|fresh> --yes
```

Everyday commands:

- `threadlink-bridge run`: deliver tasks.
- `threadlink-bridge attach`: change the Claude session.
- `threadlink-bridge sessions`: list sessions.

## Low-level commands (debugging)

| Command                         | Purpose                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `login [--paste]`               | Browser sign-in; `--paste` accepts a credential created in the dashboard's Advanced panel |
| `status`                        | Connection, session, attachment and links                                                 |
| `pending` / `approve <tllnk_…>` | Pairing requests and explicit approval                                                    |
| `logout`                        | Remove the stored credential (revoke it in the dashboard to disable it everywhere)        |

Only the exact agent session can approve a link, so the owner (or the ChatGPT conversation)
requests it and the agent confirms it.

## Running

To poll until Ctrl+C:

```bash
node bridge/src/cli.ts run
```

To process at most one task:

```bash
node bridge/src/cli.ts run --once
```

To test the pipeline without Claude:

```bash
node bridge/src/cli.ts run --executor echo
```

| Option              | Default          | Notes                                                                                               |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `--workspace <dir>` | cwd              | Claude Code runs with this directory as `cwd`                                                       |
| `--executor`        | `claude`         | `claude` or `echo`                                                                                  |
| `--permission-mode` | `plan`           | Claude Code permission mode. `plan` is read-only; anything else lets remote tasks change your files |
| `--model`           | (Claude default) | Passed as `--model`                                                                                 |

**Execution** runs `claude -p [--resume <attached-id> | --continue] --output-format json
--permission-mode <mode> [--model m]` with no shell, in the workspace.

- The task goes on stdin, wrapped in `<task>` tags with a note that it came from ThreadLink.
- It has a 20-minute timeout, and the process is killed when the task is aborted.
- The result text becomes the task result, and the Claude Code session ID is recorded as an
  artifact reference (`claude-code-session:<id>`).

When a session is attached, the bridge refuses (`session_busy`) if that session is running
anywhere (`claude agents --json`) or another bridge process holds its lock. If the session no
longer exists, the task fails with `native_session_unavailable`. It never falls back to a new
session.

## Worker loop, leases and retries

The loop runs: `inbox` → claim the first queued task → `start` → progress note → heartbeat every
60 s → execute → `complete` or `fail`.

- **Claims are atomic.** A losing worker gets `409` and skips the task.
- **Leases:** a claim holds a 5-minute lease (`claimed_until`). Every step and heartbeat renews it.
- **Crash recovery:** if the lease expires, the next delivery-time sweep requeues the task, until
  `attempt_count` reaches `max_attempts` (3). After that the task fails with
  `failure_reason = lease_exhausted`.
- **Stale workers:** a worker whose lease has lapsed cannot start, report or complete; it gets
  `409`. If a heartbeat is rejected, the bridge aborts Claude and does not submit the result, so
  completion stays exactly once.
- **Polling back-off:** exponential from 2 s to 60 s with ±20% jitter while idle. The loop stops
  when the credential is rejected (`401`).
- **Result size:** results over 250 KB and errors over 60 KB are truncated.

## Workspace identity

Each workspace directory gets a random, stable `localBindingRef` (`cc-<uuid>`), stored in
`<config>/workspaces/<sha256(path)>.json`. It is never derived from names. The bridge re-registers
it on every start, so the same workspace always maps to the same `tlses_` session.

The config directory is:

- Windows: `%APPDATA%\ThreadLink\bridge`
- macOS: `~/Library/Application Support/ThreadLink/bridge`
- Otherwise: `$XDG_CONFIG_HOME/threadlink/bridge`

## Credential storage

| Platform | Store                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Windows  | DPAPI (current user) via PowerShell `ConvertFrom-SecureString`; only the encrypted blob is written (`credential.dpapi`) |
| macOS    | Keychain (`security -i` with the command on stdin, service `ThreadLink bridge credential`)                              |
| Linux    | Secret Service (`secret-tool`)                                                                                          |
| Fallback | `THREADLINK_BRIDGE_TOKEN` environment variable (warned about)                                                           |

How the credential is handled:

- It is passed to helper processes on **stdin**, never in arguments.
- It is sent only in the `Authorization` header, with redirects refused.
- It never appears in logs or error messages.
- It is never written to the repository, `CLAUDE.md` or config files.

`THREADLINK_URL` overrides the stored URL. The base URL must be https, unless it is localhost.

To stop using a machine, run `logout` to remove the local copy, and revoke the connection in the
dashboard to disable it everywhere.

## Code

- `bridge/src/cli.ts`: the commands.
- `bridge/src/worker.ts`: the task loop.
- `bridge/src/executor.ts`: the Claude Code and echo executors.
- `bridge/src/api.ts`: the HTTP client.
- `bridge/src/credentials.ts`, `bridge/src/state.ts`, `bridge/src/backoff.ts`: supporting modules.

Tests are in `tests/bridge/` (unit tests, a fake `claude`, and a real DPAPI round trip on Windows)
and `tests/e2e/mcp-bridge.e2e.test.ts`.
