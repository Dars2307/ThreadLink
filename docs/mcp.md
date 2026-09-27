# ThreadLink MCP Server (ChatGPT side)

ThreadLink exposes a remote MCP server at **`/mcp`** (Streamable HTTP, stateless, JSON responses).
ChatGPT, or any MCP client that supports OAuth, connects to it as a **controller**.

## Tools (narrow by design)

| Tool                | Purpose                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threadlink_status` | Who is connected (connection ID, platform, role) plus usage guidance                                                                                       |
| `ensure_session`    | Create or reuse this conversation's ThreadLink session; returns `sessionId` (`tlses_`) and `sessionRef`                                                    |
| `list_links`        | Links of a session (pending, active or revoked) with the agent's display name                                                                              |
| `link_to_claude`    | One-time: list the owner's Claude conversations (with Runtime, workspace and busy state), then request a link to the chosen one (the Runtime must approve) |
| `send_to_agent`     | Queue a task to the linked Claude Code session                                                                                                             |
| `get_task_status`   | Status of a task this session sent                                                                                                                         |
| `get_task_result`   | Result, error, progress and artifacts of a task this session sent                                                                                          |
| `list_recent_tasks` | Recent tasks sent from this session                                                                                                                        |

There is **no** generic "call any API" tool. Every tool takes an explicit `sessionId`, which the
database checks belongs to the calling connection. Agent-side operations (claim, complete) are not
exposed over MCP. An agent credential gets `403` on `/mcp`.

### Default link resolution (`send_to_agent`)

- **0 active links:** returns `status: "setup_required"` and creates no task.
- **1 active link:** used automatically.
- **More than 1 active link:** returns `status: "choose_link"` with the options; the model must ask
  the user and retry with `linkId`.

ThreadLink never guesses a destination, and pending links never route.

### Chat-first tools (0.10)

The Team Mode tools (`list_rooms`, `create_room`, `get_room`, `start_team_job`, `get_team_status`,
`get_team_log`) are unchanged. 0.10 adds the chat-first tools. Responses use names (chat, project,
computer, agents); `chatId`, `projectId` and `jobId` are opaque handles.

| Tool              | Purpose                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `list_chats`      | The chats this conversation can reach, plus the projects it can create chats in                                          |
| `get_chat`        | A chat's agents (with readiness), what is running, and its recent messages (`after` = a cursor from a previous call)     |
| `create_chat`     | A new chat in a reachable project (`projectId`, `name`, optional `mode`)                                                 |
| `send_message`    | Give the chat's agents work, as this conversation: routed by the chat's mode or a leading `@claude` / `@codex` / `@team` |
| `get_chat_status` | The running job in a chat (or its latest one): phase, rounds, open findings                                              |
| `get_job_result`  | A job's outcome: verdict, summary, open findings                                                                         |

**Reachability.** A controller may only address a chat whose project (room) is active and whose
agent session is the target of one of **this session's own active links**. Another account's chat,
the same owner's chat in a project this conversation has no link to, a chat with no project, and a
deleted chat are all answered exactly like a chat that does not exist ("This chat wasn't found.").

**`send_message` is the controller's request, not the owner's.** The job is started over the
caller's own link and its request row is authored by the controller with the controller's label
(e.g. "ChatGPT"), never "You". It follows the owner composer's rules (chat mode, `@mention`, health
gate, per-link task caps, idempotency by `idempotencyKey` per session) with three fail-closed
differences: it cannot add notes to, or stop, work already running in the chat (`job_active`); a
failed health gate stores nothing and names who is not ready; solo work in a project that requires
review is refused.

A Runtime (agent) credential gets `403` on `/mcp`, and the database refuses it on every controller
function as well.

## Session binding: no ChatGPT conversation ID

ChatGPT does not give MCP servers a verified, stable conversation ID, so ThreadLink does not invent
or scrape one:

1. On the first ThreadLink call in a conversation, the model calls `ensure_session` with no
   arguments.
2. ThreadLink creates a random `sessionRef` (`chat-<uuid>`), which acts as the session's
   `local_binding_ref`, and returns it together with the canonical `tlses_` `sessionId`.
3. The model keeps both IDs in the conversation and passes `sessionId` to every later tool. Calling
   `ensure_session` again with the same `sessionRef` is idempotent.

**Fallback:** if the model loses the IDs (for example, the context is truncated), it calls
`ensure_session` again. That creates a new, unpaired session, so `send_to_agent` answers
`setup_required` until the user pairs it in the dashboard. It fails closed: a conversation can never
silently borrow another conversation's session.

## Authentication: OAuth 2.1

ThreadLink is the OAuth authorization server. Clerk is only the human sign-in step at consent.

| Endpoint                                    | Spec                                                  |
| ------------------------------------------- | ----------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata                  |
| `/.well-known/oauth-authorization-server`   | RFC 8414 AS metadata                                  |
| `POST /oauth/register`                      | RFC 7591 dynamic client registration (public clients) |
| `GET /oauth/authorize`                      | Consent page (Clerk-protected), PKCE S256 required    |
| `POST /oauth/token`                         | `authorization_code` grant                            |

The flow works like this:

1. An unauthenticated `POST /mcp` returns `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
2. The client discovers the endpoints, registers dynamically, and sends the user to
   `/oauth/authorize`.
3. The user signs in with Clerk and clicks **Allow**. ThreadLink stores the sha256 of a random,
   single-use, 5-minute code, bound to the client, the exact registered `redirect_uri`, the PKCE
   challenge, the resource, and the ThreadLink user resolved server-side.
4. `/oauth/token` checks the PKCE verifier, client, redirect and resource inside Postgres. It then
   issues a **ThreadLink connection credential** (`tlc_…`) as the access token.

Details:

- The first grant creates a `chatgpt` / `controller` connection. Re-authorizing the same client
  **reuses that connection and rotates its credential**, which invalidates the old token.
- A wrong verifier is rejected. Codes are single-use, and a replayed code gets `invalid_grant`.
- Revoking the connection in the dashboard makes `/mcp` return `401` immediately.

Why ThreadLink runs its own authorization server: RLS is driven by ThreadLink credentials, and
Clerk-issued OAuth tokens would need a privileged database client on every MCP call. Clerk secrets
are never exposed to ChatGPT.

**Alpha limitations:**

- There are no refresh tokens, and access tokens do not expire until they are revoked or rotated.
- There is one scope, `threadlink`.

## Which platform is this client?

OAuth clients are classified from their **registered redirect URIs**, never from `client_name`.
An authorization code can only be delivered to a registered redirect, so only the real provider
can finish the flow.

| All redirects on                 | Stored as        |
| -------------------------------- | ---------------- |
| `chatgpt.com`, `chat.openai.com` | `chatgpt`        |
| `claude.ai`, `claude.com`        | `claude-desktop` |
| anything else (or mixed)         | `generic-mcp`    |

Every OAuth client is a `controller`. Only ThreadLink Runtimes (device sign-in) are `agent`s,
and a database `CHECK` enforces this. Phase 6 connections created by Claude were stored as
`chatgpt`; migration `…000800` reclassifies them and records an audit event.

## Daily flow

1. Once per conversation: the model calls `ensure_session`.
2. One-time link: the user says "Link this chat to Claude Code".
   - The model calls `link_to_claude`, which lists the Claude sessions.
   - The user picks one, and `link_to_claude` is called again with `agentSessionId`. This creates
     a pending link.
   - The user confirms it on their machine in the Runtime setup.
3. From then on, the user says "send this to Claude". `send_to_agent` resolves the single active
   link automatically, and the answer arrives via `get_task_status` / `get_task_result`.
4. If the attached Claude session is open elsewhere, the task fails with
   `failureReason: "session_busy"` and a plain-language message.

## Limits

| Limit                        | Value                                |
| ---------------------------- | ------------------------------------ |
| MCP request body             | 128 KB                               |
| Client registration          | 100 per hour (global)                |
| Consent grants               | 20 per 10 minutes per user           |
| ChatGPT connections per user | 10 live                              |
| Tasks                        | 30 per 10 minutes per origin session |
| Pending pairings             | 10 per controller session            |

## Connecting ChatGPT (manual, once a preview is deployed)

1. Deploy a Vercel preview with the Phase 6 migration applied (see
   [database.md](database.md#applying-to-the-hosted-project)).
2. In ChatGPT, go to Settings → Connectors (developer mode) → Add, and enter the MCP URL
   `https://<preview-host>/mcp`. Choose OAuth.
3. Sign in to ThreadLink when redirected, then click **Allow**.
4. In a chat, ask ChatGPT to call `ensure_session`. Then pair the session in the dashboard (see
   [runtime.md](runtime.md)).

## Code

- `app/mcp/route.ts`: authentication and a fresh MCP server and transport per request.
- `lib/mcp/server.ts`: tool registration.
- `lib/mcp/tools.ts`: pure tool logic.
- `lib/oauth/*` and `app/oauth/*`: the authorization server.
- `app/.well-known/*`: metadata.
