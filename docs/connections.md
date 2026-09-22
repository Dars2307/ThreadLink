# ThreadLink Connections and Client Credentials

Source of truth: [`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md) §7, §11, §18.

## Two kinds of identity

```text
Human:   Clerk user ──> ThreadLink user (tlusr_)          interactive sign-in, dashboard
Client:  connection (tlcon_) ──> credential (tlcrd_)      bearer token, no Clerk session
```

A **connection** is an authenticated installation of a client (the ChatGPT integration, a Claude
Code Runtime) owned by exactly one ThreadLink user. It is not a chat or a session. Session bindings
are described in [pairing.md](pairing.md). Clients authenticate with a **connection credential**, never with the user's
Clerk browser session.

| Platform      | Role (derived server-side) |
| ------------- | -------------------------- |
| `chatgpt`     | `controller`               |
| `claude-code` | `agent`                    |

## Credential format

```text
tlc_<43 base64url characters>        32 bytes from the Node CSPRNG = 256 bits
```

- Opaque: encodes no user, connection, email or name.
- Shown **once** at issuance. The dashboard keeps it only in React state; it is never stored in
  browser storage, placed in a URL, logged or sent to analytics.
- Fingerprint (`token_prefix`): the first 10 characters (`tlc_` + 6). It identifies a credential
  in the UI and leaves ≥220 bits secret.

## Storage and verification

```text
token_hash = HMAC-SHA256(key = THREADLINK_CONNECTION_SECRET,
                         msg = "threadlink:connection-token:v1:" + token)   → 64 hex
```

- Computed in the Next.js server with Node's `crypto`. **Postgres never receives the raw token**
  (so it cannot appear in DB logs, rows or backups).
- The HMAC is what clients' requests present to the database functions, so it is **not stored
  either** (Phase 4 hardening): `connection_credentials.token_hash = sha256(HMAC)`. A leaked
  database dump therefore contains nothing a caller could present.
- `token_hash` is `UNIQUE`, so authentication is a single indexed lookup.
- The hash column is excluded from every API grant; even the owner cannot read it.

**Why `THREADLINK_CONNECTION_SECRET` exists.** Tokens already carry 256 bits of entropy, so an
unkeyed SHA-256 would resist guessing. The key is defence in depth: a leaked database dump alone
cannot be used to test candidate tokens, and hashes are bound to one deployment. It is not used
for anything else. It must be ≥32 random bytes, differ per environment, and never reuse a
Clerk/Supabase key (validated at startup). **Rotating it invalidates every issued credential.**

## Data model

`connection_credentials` (separate from `connections`, to support rotation and history):

| Column                                     | Notes                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `id`                                       | `tlcrd_…`                                                                   |
| `connection_id`, `owner_user_id`           | composite FK to `connections (id, owner_user_id)`: owners can never diverge |
| `token_hash`                               | HMAC hex, unique, never selectable                                          |
| `token_prefix`                             | non-secret fingerprint                                                      |
| `created_at`, `last_used_at`, `revoked_at` | `revoked_at` is terminal (trigger)                                          |

At most one active credential per connection (partial unique index).

`audit_events` (minimal, append-only): `connection.created`, `connection.revoked`,
`connection.credential_rotated`, `connection.auth_failed` (use of a revoked/superseded
credential). Written only inside the functions below; owners can read their own. No tokens,
hashes or headers are ever recorded.

## Operations (database functions)

All are `SECURITY DEFINER`, `search_path = ''`, and derive the owner from the verified Clerk JWT.
Direct `INSERT`/`DELETE` and `status` updates on `connections` are not granted.

| Function                                                                      | Caller              | Behaviour                                                                  |
| ----------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `register_connection(platform, role, display_name, token_hash, token_prefix)` | authenticated       | cap check (10 active), creates connection + credential, audit              |
| `revoke_connection(connection_id)`                                            | authenticated       | idempotent; revokes connection and all credentials; audit once             |
| `rotate_connection_credential(connection_id, token_hash, token_prefix)`       | authenticated       | active connections only; old credential revoked, new issued                |
| `authenticate_connection(token_hash)`                                         | anon, authenticated | returns `{connection_id, owner_user_id, platform, role, status}` or `NULL` |

Another user's connection ID and a nonexistent one produce the **same** error (`P0002`).
`authenticate_connection` returns `NULL` for every failure (unknown, revoked, inactive), so it is
not an oracle. Guessing requires producing a valid 256-bit HMAC.

`authenticate_connection` is callable without a Clerk session because clients do not have one.
It runs with the publishable key (no privileged client) and can reveal nothing without a valid
hash.

## Server helpers

| Helper                                                                                            | Module                                  | Purpose                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `requireThreadLinkUser()`                                                                         | `lib/auth/threadlink-user.ts`           | human caller (dashboard, server actions)                                   |
| `registerMyConnection`, `revokeMyConnection`, `rotateMyConnectionCredential`, `listMyConnections` | `lib/connections/repository.ts`         | owner-scoped operations                                                    |
| `requireConnection(request)`                                                                      | `lib/connections/require-connection.ts` | non-human caller; returns `ConnectionIdentity` or throws one generic error |

`requireConnection()` parses `Authorization: Bearer tlc_…`, rejects malformed tokens before any
DB call, hashes, calls `authenticate_connection`, validates the result strictly, and fails closed.
Failure reasons (`missing`, `malformed`, `rejected`, `unavailable`) are logged server-side only;
clients always get `401 {"error":"unauthorized"}`.

## Routes

`/api/connection/*` is excluded from the Clerk session gate in `proxy.ts` because callers present
a connection token instead. **Every** handler there must `await requireConnection(request)`
(enforced by a static test). `GET /api/connection/whoami` returns the connection's own
`{connectionId, platform, role, status}`. Phase 4 adds `/api/session/*` and `/api/pairing*`
under the same rule (see [pairing.md](pairing.md)).

## Lifecycle

```text
register ──> active ──(rotate)──> active (new credential; old one fails immediately)
                  └──(revoke)───> revoked   terminal: credential fails immediately,
                                            row stays for history, cannot be reissued
```

`last_used_at` / `last_seen_at` are written only by `authenticate_connection`, at most once per
60 s per credential/connection. Users cannot set them.

## Abuse limit

Maximum **10 active** (`active`/`idle`) connections per user, enforced in `register_connection`
under a per-user advisory lock (race-safe). Revoked connections do not count. Alpha needs at most
two; 10 leaves room for several machines without allowing unbounded creation.

## Platforms

| Platform         | Role       | Created by                                                                                  |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `chatgpt`        | controller | OAuth (redirect on chatgpt.com) or dashboard Advanced                                       |
| `claude-desktop` | controller | OAuth (redirect on claude.ai / claude.com)                                                  |
| `generic-mcp`    | controller | OAuth (any other redirect)                                                                  |
| `claude-code`    | agent      | Bridge device sign-in (`/device/code` → `/connect` → `/device/token`) or dashboard Advanced |

## Alpha registration flows

- **Claude Code:** dashboard → _Create connection_ → Claude Code → copy the credential once →
  `npx threadlink setup --url …` ([runtime.md](runtime.md)).
- **ChatGPT (Phase 6):** created by the MCP OAuth flow ([mcp.md](mcp.md)). The token endpoint
  issues a `chatgpt`/`controller` connection credential as the access token and records the
  OAuth client (`connections.oauth_client_id`). Re-authorizing the same client reuses the
  connection and rotates its credential; at most 10 live ChatGPT connections per user. No
  ChatGPT conversation IDs are assumed.

## Verifying a credential manually

In your own terminal (never paste credentials into chats or tickets), with the dev server running:

```bash
curl -s -H "Authorization: Bearer $THREADLINK_TOKEN" http://localhost:3000/api/connection/whoami
```
