# ThreadLink Claude Code Bridge

`bridge/` is a small, dependency-free TypeScript CLI that runs on your machine. It holds a
`claude-code` (agent) connection credential, polls ThreadLink for tasks routed to this workspace,
and runs each one with official **headless Claude Code** (`claude -p`). It then reports progress
and the result back.

It does **not** inject input into an existing interactive Claude Code session, and it does not
scrape or drive any UI.

It requires Node 22.18 or later, which runs the `.ts` sources directly. Claude Code must be on
`PATH` for the `claude` executor.

## Setup

1. In the dashboard, register a **Claude Code** connection and copy the credential (it is shown
   once).
2. Log in:

   ```bash
   node bridge/src/cli.ts login --url https://<your-threadlink>
   ```

   Paste the credential when prompted; input is hidden. The bridge then:
   - checks that the credential is an **agent** connection;
   - stores it in the OS credential store (see [Credential storage](#credential-storage));
   - saves the URL in the bridge config directory.

3. From the workspace directory, run:

   ```bash
   node bridge/src/cli.ts status
   ```

   This registers (or reuses) the workspace's session and prints its `tlses_` ID.

## Pairing (never automatic)

1. In the dashboard, under **Pair sessions**, choose the ChatGPT session and this workspace's
   Claude Code session, then click **Request pairing**.
2. On the machine, list the pending requests:

   ```bash
   node bridge/src/cli.ts pending
   ```

3. Approve the request:

   ```bash
   node bridge/src/cli.ts approve tllnk_…
   ```

Only the exact agent session can approve, so the owner starts the pairing and the agent confirms
it.

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

**Execution** runs `claude -p --output-format json --permission-mode <mode> [--model m]` with no
shell. The task goes on stdin, wrapped in `<task>` tags with a note that it came from ThreadLink.
It has a 20-minute timeout, and the process is killed when the task is aborted. The result text
becomes the task result, and the Claude Code session ID is recorded as an artifact reference
(`claude-code-session:<id>`).

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
