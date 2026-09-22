# ThreadLink Runtime

A **Runtime** is any machine or environment where ThreadLink can reach local agent tooling: your
laptop, an SSH host, a cloud VM, a container or a Codespace. It holds one agent credential, runs
quietly in the background, and delivers requests from your chats into the exact provider
conversation you chose.

```
Account
 └── Runtime (tlrun_)            Joel's Laptop · Windows · desktop
      └── Workspace (tlwsp_)     ThreadLink  (github.com/dars2307/threadlink#main)
           └── Conversation      Claude Code session (native id, metadata)
                └── ThreadLink session (tlses_, canonical)
                     └── Link (tllnk_) to one chat conversation
```

- One account can have many Runtimes; one Runtime can manage many workspaces; one workspace can
  hold many Claude conversations, each with its own `tlses_` and its own links.
- The Runtime engine is one TypeScript package (`runtime/`). The desktop app and the CLI both use
  it, so they behave identically.

## Two ways to run it

### Desktop app (recommended, no terminal)

`desktop/` is an Electron app, Windows first and cross-platform by construction.

```bash
cd desktop && npm install && npm start     # development
npm run dist:win                           # Windows installer (NSIS)
npm run dist:mac                           # macOS dmg
npm run dist:linux                         # AppImage + deb
```

It signs in through your browser, detects Claude Code, finds your project folders and
conversations, and then stays in the tray/menu bar:

- status (Ready / in use / paused / offline / sign-in needed);
- the current workspace and attached conversations;
- pending link requests with **Approve** / **Decline**;
- Open ThreadLink, Open dashboard, Pause, Restart, Quit;
- optional notifications (completed, failed, conversation busy, disconnected);
- start at login (Windows/macOS login item, XDG autostart on Linux).

Installers are unsigned in this phase; code signing and notarization are a later hardening step.
Auto-update is not wired up yet.

### CLI (developers, servers, CI)

```bash
npx threadlink setup --url https://<your-threadlink>   # sign in, choose a conversation, link
npx threadlink run                                     # deliver requests
npx threadlink status | sessions | attach | detach | links | approve | rotate | logout
```

`npx threadlink` alone runs setup on a new machine and shows status afterwards. On a headless host
the sign-in URL and code are printed instead of opening a browser.

## Remote and cloud Runtimes

Nothing in the Runtime assumes localhost or a desktop:

- The ThreadLink address is configuration; the Runtime dials out over HTTPS and needs no inbound
  ports.
- Codespaces, dev containers, Gitpod, cloud shells and SSH sessions are detected and registered as
  `kind: remote`.
- Settings, pause and restart are delivered on the heartbeat, so a remote Runtime is managed from
  the dashboard without any local UI.
- `filesystem: remote` is reported so ThreadLink knows the files are not on your laptop.

Verified: a Linux container with no keyring and no Claude Code installs the CLI, signs in with a
device code and registers as `linux`/`cli`, reporting `claude-code: unavailable` so nothing is
routed to it (`tests/e2e/linux-runtime.e2e.test.ts`).

## Identity, capabilities and trust

Each Runtime registers itself and then heartbeats every 30 seconds:

| Reported                                                                                                                  | Used for                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| label, platform, kind, version                                                                                            | display only                                                                                          |
| capabilities (`claude-code`, `claude-resume`, `interactive-session-discovery`, `codex`, `nova`, `filesystem`, `platform`) | routing: ThreadLink only creates a task for a Runtime that reports the target provider as `available` |
| busy conversations                                                                                                        | dashboard state and the "conversation in use" message                                                 |
| workspace key, folder name, path, git remote/branch                                                                       | grouping and display                                                                                  |

Everything above is **self-description**: the owner and the connection always come from the verified
credential, capability keys and values are allow-listed by the database, and a Runtime can only ever
touch its own sessions. Git remotes are normalised to `host/owner/repo`, so no credentials embedded
in a remote URL are ever sent.

Workspace identity is `(runtime, workspace key)`, never a bare path: the same repository on two
machines (`C:\work\ThreadLink` and `/workspaces/ThreadLink`) is two workspaces that the dashboard
can group by repo fingerprint.

## Control from the dashboard

| Action            | Effect                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| Rename            | label only                                                                             |
| Pause / Resume    | the Runtime stops claiming work; the database also refuses claims while paused         |
| Restart           | the next heartbeat asks the Runtime to restart its engine                              |
| Settings          | start at login, reconnect automatically, notifications - applied on the next heartbeat |
| Disconnect device | revokes the Runtime's connection, which cascades to its sessions, links and open tasks |
| Pause link        | that one chat-to-conversation link accepts no new requests                             |

## Background behaviour

- Polls with exponential back-off (2 s to 60 s) while idle; wakes immediately after a delivery.
- Reconnects after network loss, sleep or reboot; re-registers if several attempts fail.
- `401` stops the loop and asks for sign-in; `403` means the Runtime was disconnected.
- One engine per machine: a lock file keeps the CLI and the desktop app from running two.
- Leases, claims, heartbeats and exactly-once completion are unchanged from Phase 6.

## Credential storage

| Platform                      | Store                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| Windows                       | DPAPI (current user)                                                 |
| macOS                         | Keychain (`security -i`, command on stdin)                           |
| Linux with a keyring          | Secret Service (`secret-tool`)                                       |
| Headless (container, SSH, CI) | `0600` file in the private config directory, and the Runtime says so |
| Any                           | `THREADLINK_BRIDGE_TOKEN` environment variable (warned about)        |

The credential never appears in logs, arguments or the desktop renderer. `threadlink rotate`
replaces it; the old one stops working immediately. Config lives in `%APPDATA%\ThreadLink\runtime`,
`~/Library/Application Support/ThreadLink/runtime` or `$XDG_CONFIG_HOME/threadlink/runtime`
(the Phase 6 `bridge` directory is reused if present, so existing sign-ins keep working).

## Provider adapters

```
ThreadLink Runtime
├── Claude Code adapter   (implemented)
├── Codex adapter         (reports unavailable)
└── Nova adapter          (reports unavailable)
```

An adapter detects its tool, discovers workspaces and conversations, reports which conversations are
in use, and executes one task in exactly one conversation. Adding a provider does not touch the
engine, the API or the database.

See [existing-claude-sessions.md](existing-claude-sessions.md) for how Claude conversations are
discovered and resumed, and why ThreadLink refuses to write into an open one.
