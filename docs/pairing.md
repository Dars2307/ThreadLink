# ThreadLink Sessions and Pairing

Source of truth: [`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md) §8, §9, §12, §18.
Phase 4 establishes **identity and relationship only**. There are no messages, tasks, routing or
delivery yet.

## Session identity

A **session binding** (`tlses_…`) is ThreadLink's identity for one logical client session: one
ChatGPT conversation context or one Claude Code working session. It belongs to exactly one
connection and therefore to exactly one ThreadLink user.

```text
ThreadLink user (tlusr_)
  └─ connection (tlcon_, platform + role)       authenticated by its credential
       └─ session binding (tlses_)              canonical session identity
```

| Field                            | Meaning                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `id` (`tlses_`)                  | **Canonical.** Generated in the database from `gen_random_uuid()`; no personal data |
| `connection_id`, `owner_user_id` | Derived from the authenticated credential; composite FK keeps owners consistent     |
| `local_binding_ref`              | Optional client-chosen stable handle, unique per connection (idempotency key)       |
| `provider_session_ref`           | Optional, opaque provider metadata. **Never** an identity or lookup key             |
| `display_name`                   | Cosmetic. Renaming never affects identity                                           |
| `status`                         | `active` / `idle` / `retired` / `revoked`; retired and revoked are terminal         |

### Canonical vs provider-native IDs

ThreadLink does **not** assume ChatGPT exposes a conversation ID, nor that Claude Code exposes a
universally stable session ID. ThreadLink never invents, scrapes or derives one. If a provider
offers an identifier through a supported mechanism, a client may store it in
`provider_session_ref` as metadata. The `tlses_` ID remains the only identity used for ownership,
pairing and (later) routing.

### Local binding refs and idempotency

Clients persist their own stable handle (for example a random value stored beside the bridge's
config, or a value kept in MCP conversation state) and send it as `localBindingRef`:

| Request                                                       | Result                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| new `(connection, localBindingRef)`                           | new `tlses_` created (`created: true`)                                                         |
| same `(connection, localBindingRef)`, binding active/idle     | **same** `tlses_` returned (`created: false`); display name / provider ref updated as metadata |
| same `(connection, localBindingRef)`, binding retired/revoked | `409 conflict`: a retired identity is never silently revived; use a new ref                    |
| no `localBindingRef`                                          | always a new `tlses_`                                                                          |
| another connection sends the same ref                         | its own, different `tlses_` (refs are scoped per connection)                                   |

Concurrent registrations with the same ref converge on one row (unique constraint + `ON CONFLICT`).
Names and provider refs are never used for deduplication. Alpha limit: 50 active sessions per
connection.

## Pairing (`thread_links`, `tllnk_`)

A ThreadLink joins **one exact controller session** to **one exact agent session**. It does not
merge conversations or copy history; it is the authorized routing relationship future phases use.

| Rule                                                      | Enforcement                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Same owner                                                | functions compare owners; composite FKs make cross-owner links unrepresentable |
| Controller side has role `controller`, agent side `agent` | functions + insert trigger (also for privileged writers)                       |
| Both sessions and both connections active                 | checked at request **and** at approval                                         |
| Distinct sessions                                         | `CHECK`                                                                        |
| One live link per exact pair                              | partial unique index on `(controller, agent)` where `pending`/`active`         |
| History kept                                              | no `DELETE`; revoked links remain; re-pairing creates a new `tllnk_`           |

A controller session may hold links to several agents (and vice versa); Phase 4 does not assume
one-to-one.

### Lifecycle

```text
controller: request ──> pending ──(exact agent session approves)──> active
                           │                                          │
                           └──────────── revoke / cascade ────────────┴──> revoked (terminal)
```

- **Request**: controller connection only, using one of its own sessions. Duplicate requests
  for a pending or active pair return the existing link.
- **Approve**: agent connection only; the approving session must be the link's exact
  `agent_session_id` and belong to the calling connection. A controller can never approve, so
  both sides must deliberately participate. Pairing is never auto-activated, even for one owner.
- **Revoke**: either participant session, or the owner from the dashboard. Idempotent. Reason
  recorded (`revoked_by_controller`, `revoked_by_agent`, `revoked_by_owner`,
  `controller_session_ended`, `agent_session_ended`).

### Revocation cascade

Both explicit historical state and use-time checks are applied:

1. **Explicit state (triggers):** connection `revoked`/`retired` → its sessions `revoked` →
   their `pending`/`active` links `revoked` with `*_session_ended`.
2. **Use-time checks:** every client function re-authenticates the credential inside the
   database, and approval re-validates both sessions and both connections. A revoked connection
   cannot call anything.

## Client API (connection-authenticated)

All routes require `Authorization: Bearer tlc_…`, run `requireConnectionContext()` first, and use
no Clerk session and no privileged client. The server passes the credential HMAC to the database,
which re-verifies it and derives owner, connection, role and platform itself.

| Route                            | Who               | Body / query                                                               |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `POST /api/session/register`     | any connection    | `{ displayName?, providerSessionRef?, localBindingRef? }`                  |
| `GET /api/session/me?sessionId=` | owning connection | returns `{ sessionId, connectionId, platform, role, displayName, status }` |
| `POST /api/session/retire`       | owning connection | `{ sessionId }`                                                            |
| `POST /api/pairing/request`      | controller        | `{ controllerSessionId, agentSessionId }`                                  |
| `GET /api/pairing?sessionId=`    | participant       | pending requests, active pairing, history                                  |
| `POST /api/pairing/approve`      | exact agent       | `{ sessionId, linkId }`                                                    |
| `POST /api/pairing/revoke`       | participant       | `{ sessionId, linkId }`                                                    |

Errors are generic: `401 unauthorized`, `403 forbidden` (your own connection has the wrong
role), `404 not_found` (nonexistent **or** not yours: indistinguishable), `409 conflict`
(terminal state), `400 invalid`, `429 limit`. Bodies are capped at 8 KB and parsed with strict
schemas that reject `owner_user_id`, `connectionId`, `role`, `platform` and similar fields.

## Database functions

| Function                                                                     | Caller                 | Purpose                                                          |
| ---------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `register_session`, `get_session`, `retire_session`                          | anon (credential HMAC) | session lifecycle                                                |
| `request_pairing`, `approve_pairing`, `revoke_pairing`, `list_session_links` | anon (credential HMAC) | pairing lifecycle                                                |
| `revoke_thread_link`                                                         | authenticated (Clerk)  | owner revocation from the dashboard                              |
| `threadlink_private.resolve_connection` / `require_connection`               | internal               | credential → active connection, usage metadata, failed-use audit |
| `threadlink_private.require_own_session`, `session_is_usable`                | internal               | ownership and validity checks                                    |

All are `SECURITY DEFINER` with `search_path = ''`, have explicit grants, take no owner input and
expose no generic update. Tables grant `SELECT` to `authenticated` under owner RLS and no writes
to anyone.

## Future routing relationship

Phase 5 routing will resolve `origin session → active thread_link → target session → target
connection`, re-checking at send time that the link is `active` and both sessions/connections are
usable. Messages and tasks will reference `tllnk_`/`tlses_` IDs, never provider IDs or names.
