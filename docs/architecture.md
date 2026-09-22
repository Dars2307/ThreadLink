# ThreadLink Architecture

Source of truth: [`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md). This document
describes how the codebase implements it and is updated per phase.

## What ThreadLink is

An authenticated coordination and routing layer between AI/client sessions. A controller session
(alpha: ChatGPT) sends tasks through an explicit, user-approved ThreadLink to an execution agent
(alpha: Claude Code), and results return to the originating context.

```text
ChatGPT (controller)                              Claude Code (execution agent)
   |  remote MCP                                         ^  local TypeScript bridge
   v                                                     |
+------------------------------------------------------------------+
| ThreadLink (Next.js on Vercel)                                    |
|   Clerk identity -> authorization -> binding/link resolution      |
|   -> task + message persistence -> delivery -> return routing     |
+------------------------------------------------------------------+
                              |
                    Supabase Postgres (+ RLS)
```

## Components

| Component           | Responsibility                                        | Status                       |
| ------------------- | ----------------------------------------------------- | ---------------------------- |
| Clerk               | Human authentication; canonical external identity     | Phase 1                      |
| Next.js app         | Web UI, API routes, (later) remote MCP endpoint       | Phase 1                      |
| Supabase Postgres   | Persistent state, RLS as second enforcement layer     | Phase 2 (users, connections) |
| Connection registry | Per-platform connections + revocable credentials      | Phase 3                      |
| Session bindings    | ThreadLink-owned canonical IDs for logical sessions   | Phase 4                      |
| ThreadLink pairing  | Approved controller-session ↔ agent-session links     | Phase 4                      |
| MCP routing         | `send_to_agent` and related tools                     | Phase 5                      |
| Claude Code bridge  | Local process that receives tasks and returns results | Phase 6                      |
| Vercel              | Planned first cloud deployment target                 | Phase 8                      |

## Identity model

- **Clerk user ID** (`user_...`) is the canonical external human identity.
- ThreadLink mints its own immutable IDs in the database (`tlusr_…` users, `tlcon_…` connections)
  and maps exactly one `users` row to each Clerk user ID. See [database.md](database.md).
- **Display names and emails are never authorization identifiers.** They are display-only: they
  change, are not unique, and are user-controlled, so they cannot prove ownership.
- **Authentication** ("who is this?") is persistent via Clerk sessions. **Authorization** ("may this
  identity do this to this resource?") is checked on every protected operation.

### Server-side identity resolution

`lib/auth/identity.ts` is the single entry point for "who is calling?":

- `getIdentity()` returns `{ clerkUserId, sessionId }` or `null`.
- `requireIdentity()` throws `AuthenticationRequiredError` (fail closed).

Both read only Clerk's verified server-side session (`auth()`), and reject anything that is not a
fully authenticated session with well-formed `user_` / `sess_` identifiers. The pure rules live in
`lib/auth/resolve-identity.ts` and are unit tested.

No route may accept a user ID from the client (body, query, header, route param) and trust it for
ownership. Owner IDs always come from `requireIdentity()`.

### ThreadLink user resolution

`lib/auth/threadlink-user.ts` exports `requireThreadLinkUser()`, the entry point for any code that
needs ThreadLink ownership:

```text
requireIdentity()                         verified Clerk session (fail closed)
  -> provision_current_user() via user-scoped Supabase client (Clerk token)
       DB reads sub from the verified JWT, finds or creates users row (idempotent, race-safe)
  -> verify returned clerk_user_id == verified identity
  -> ThreadLinkUser { id: tlusr_…, … }
```

It takes no arguments, so callers cannot inject an identity. It is deduplicated per request.

### Connections and client identity

Humans authenticate with Clerk; clients (ChatGPT integration, Claude Code bridge) authenticate
with a revocable ThreadLink connection credential. See [connections.md](connections.md).

`lib/connections/`:

| Module                  | Role                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `model.ts`              | platforms/roles/statuses, strict registration input (role derived from platform) |
| `credentials.ts`        | token generation, HMAC hashing, bearer parsing                                   |
| `registration.ts`       | register / revoke / rotate via DB functions                                      |
| `queries.ts`            | owner-scoped reads with non-secret credential metadata                           |
| `authenticate.ts`       | pure connection-token verification core                                          |
| `repository.ts`         | server-only wrappers bound to `requireThreadLinkUser()`                          |
| `require-connection.ts` | server-only `requireConnection(request)` for client routes                       |

Writes never send `owner_user_id`; the database derives it. Results are re-checked against the
caller's `tlusr_` ID.

### Sessions and pairing

See [pairing.md](pairing.md).

| Module                                          | Role                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `lib/sessions/model.ts`, `lib/pairing/model.ts` | strict client input schemas, row schemas, safe views                                 |
| `lib/client-api/operations.ts`                  | connection-authenticated session/pairing operations (credential HMAC → DB functions) |
| `lib/client-api/handler.ts`                     | server-only route wrapper: `requireConnectionContext()`, body cap, generic errors    |
| `lib/sessions/queries.ts`, `repository.ts`      | dashboard reads (RLS) and owner link revocation                                      |
| `app/api/session/*`, `app/api/pairing*`         | client routes                                                                        |

```text
client (tlc_ token) ─> route ─> requireConnectionContext() ─> HMAC ─> DB function(anon)
                                                                  └─ re-verifies credential,
                                                                     derives owner/role, enforces rules
```

## Request protection

1. **`proxy.ts`** (Next.js 16's replacement for `middleware.ts`) runs Clerk and **denies by
   default**: only `/`, `/sign-in*` and `/sign-up*` are public. New routes are protected
   automatically. `/api/connection/*`, `/api/session/*` and `/api/pairing*` skip the Clerk gate because their
   callers present a connection credential; every handler there must authenticate it.
2. **Per-handler check**: protected pages/handlers call `getIdentity()` / `requireIdentity()` again
   (defence in depth), then perform resource authorization.
3. **Postgres RLS** enforces ownership again at the database (Phase 2).

## Supabase access

Supabase is used purely as Postgres. Supabase Auth is not used. Clerk session tokens are passed to
Supabase via third-party auth so RLS can read the Clerk user ID from `auth.jwt()->>'sub'`.

| Module                    | Key                       | RLS      | Where       | Use for                                 |
| ------------------------- | ------------------------- | -------- | ----------- | --------------------------------------- |
| `lib/supabase/server.ts`  | publishable + Clerk token | enforced | server only | default tenant data access              |
| `lib/supabase/browser.ts` | publishable + Clerk token | enforced | browser     | client reads, if ever needed            |
| `lib/supabase/admin.ts`   | secret                    | bypassed | server only | trusted system ops, always owner-scoped |

The user-scoped server client is the normal data path. `createAnonymousSupabaseClient()` (publishable
key, no identity) is used only to call `authenticate_connection`. The privileged client currently
has **no importers**; see [security.md](security.md#privileged-client-exception).

## Environment

- `lib/env/schema.ts`: zod schemas (pure, tested).
- `lib/env/server.ts`: `getServerEnv()`, server-only, lazy, fails closed; also refuses to start if a
  secret-looking name is exposed as `NEXT_PUBLIC_*`.
- `lib/env/client.ts`: `getPublicEnv()`, `NEXT_PUBLIC_*` only.

## Provider adapters

Provider-specific logic (ChatGPT, Claude Code, later Codex/Nova/Claude chat) will live behind
adapters/bridges so adding a provider does not require core redesign. Controller and execution
agent are roles, not hard-coded providers. Provider-native session IDs are optional metadata; the
ThreadLink binding ID is canonical.
