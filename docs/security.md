# ThreadLink Security

Security is part of the initial architecture, not a later patch. See §18 of
[`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md).

## Principles (enforced from Phase 1)

1. **Clerk user ID is the canonical external human identity.**
2. **Display names and email addresses are never authorization identifiers.**
3. **Authentication and authorization are separate.** Sessions persist; authorization is checked on
   every protected operation.
4. **Every ThreadLink-owned resource is scoped** to an authenticated user (alpha) or, later, an
   authorized workspace.
5. **Identity comes only from verified server-side authentication context.** No route may accept a
   user ID from the client and trust it for ownership.
6. **Fail closed.** If identity, ownership, membership, permission or destination validation cannot
   be established, deny.
7. **Privileged Supabase credentials never reach browser code.**
8. **Postgres RLS is a second enforcement layer**, not a replacement for application checks.
9. **No custom cryptography.** Use established libraries and standards.
10. **No real secrets in source control**, examples or docs.

## Tenant isolation

User A must not be able to read, enumerate, infer, route to, or mutate User B's private resources.
Unauthorized access to a specific resource should return a generic not-found/denied response that
does not leak whether the resource exists.

## How Phase 1 enforces this

| Control                  | Implementation                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Deny-by-default routing  | `proxy.ts` protects every route except `/`, `/sign-in*`, `/sign-up*`                                                                        |
| Defence in depth         | `/dashboard` re-resolves identity server-side before rendering                                                                              |
| Canonical identity       | `lib/auth/identity.ts` (`getIdentity` / `requireIdentity`), Clerk `auth()` only                                                             |
| Fail-closed identity     | Any non-authenticated state, malformed ID or Clerk error resolves to `null` / throws                                                        |
| Minimal identity display | Dashboard shows name/email (display only) and a **masked** user ID                                                                          |
| Server-only modules      | `lib/env/server.ts`, `lib/auth/identity.ts`, `lib/supabase/{server,admin}.ts` import `server-only`; a client import fails the build         |
| Secret isolation         | Only `lib/env/server.ts` reads secrets; ESLint forbids direct `process.env.*SECRET*`/`DATABASE_URL` access elsewhere                        |
| Public env guard         | Startup refuses secret-looking `NEXT_PUBLIC_*` names; schema rejects `sk_`, `sb_secret_` and legacy `service_role` JWTs in public key slots |
| Error hygiene            | Env validation errors name the variable and rule, never the value                                                                           |
| Insecure dev flag        | `THREADLINK_ALLOW_INSECURE_DEV=true` is rejected when `NODE_ENV=production`                                                                 |
| Security headers         | `nosniff`, `X-Frame-Options: DENY`, strict referrer policy, permissions policy, HSTS; `X-Powered-By` removed                                |
| Git hygiene              | `.gitignore` ignores `.env*` (except `.env.example`), `*.env.txt`, keys and certificates                                                    |

Tests in `tests/` cover identity fail-closed behaviour, env validation and secret-slot rejection,
ID masking, and the client/server module boundary.

## Tenant boundary (Phase 2)

The tenant boundary is the **ThreadLink user** (`users.id`, `tlusr_…`). Every tenant-owned row
carries `owner_user_id`. The chain from request to row is:

```text
Clerk JWT (verified by Supabase) -> sub -> users.clerk_user_id -> users.id -> row.owner_user_id
```

| Layer       | Control                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application | `requireThreadLinkUser()` resolves the owner from the verified session only; inputs are parsed with `.strict()` schemas that reject `owner_user_id`, `clerkUserId`, `id`, `status`; results are re-checked against the caller and a mismatch throws (fail closed) |
| Grants      | `anon` has nothing. `authenticated` cannot write `users` at all and cannot write `connections.owner_user_id`, `id`, `status` on insert or any identity column on update                                                                                           |
| RLS         | Every `public` table has RLS; all policies are `TO authenticated` and compare against the verified caller; no `USING (true)`                                                                                                                                      |
| Triggers    | Identity/ownership columns immutable; `revoked`/`retired` terminal                                                                                                                                                                                                |

### Why email and display name are not authorization identifiers

They are mutable, user-controlled, not unique (two ThreadLink users may share an email; the pgTAP
suite verifies that claiming another user's email changes nothing), and may be reassigned by the
identity provider. Only the verified Clerk subject and ThreadLink IDs derived from it are used for
ownership. A static test forbids filtering by `primary_email`/`display_name` in application code.

### Denial semantics

Another user's resource behaves exactly like a nonexistent one: reads return empty results and
updates/deletes affect zero rows. Errors shown to users are generic.

## Client credentials (Phase 3)

Non-human clients (ChatGPT integration, Claude Code bridge) authenticate with a ThreadLink
connection credential, not a Clerk session. Full design: [connections.md](connections.md).

| Control          | Implementation                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token entropy    | `tlc_` + 32 CSPRNG bytes (256 bits); opaque, no identity encoded                                                                                                                                 |
| Storage          | HMAC-SHA256 with `THREADLINK_CONNECTION_SECRET` computed in the app; Postgres never sees the raw token; hash column not granted to any API role                                                  |
| One-time display | Raw token returned once from the server action and held only in React state                                                                                                                      |
| Verification     | `requireConnection()` → strict format check → HMAC → `authenticate_connection` → strict result parsing; one generic 401 for every failure                                                        |
| No oracle        | Unknown, revoked and inactive credentials are indistinguishable; other users' connection IDs behave like nonexistent ones (`P0002`)                                                              |
| Revocation       | Immediate, idempotent, terminal; history retained; direct status changes and deletes are not granted                                                                                             |
| Rotation         | Replaces the single active credential atomically                                                                                                                                                 |
| Usage metadata   | `last_used_at`/`last_seen_at` written only by `authenticate_connection`, throttled to once per 60 s                                                                                              |
| Abuse limit      | 10 active connections per user, race-safe                                                                                                                                                        |
| Route boundary   | `/api/connection/*` bypasses the Clerk gate; a static test requires `requireConnection(request)` in every handler there                                                                          |
| Logging          | Failure reasons only (`missing`/`malformed`/`rejected`/`unavailable`); never tokens, hashes, headers or Clerk tokens. Tests assert tokens never reach console output, DB rows or committed files |
| Audit            | Append-only `audit_events` for create/revoke/rotate/failed use of revoked credentials                                                                                                            |

Failed authentications with _unknown_ tokens are logged to the server console but not written to
the database, so anonymous callers cannot grow the audit table.

## Sessions and pairing (Phase 4)

Full design: [pairing.md](pairing.md).

| Control                     | Implementation                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical identity          | `tlses_`/`tllnk_` generated in the database; provider refs and names are metadata only; no provider IDs invented or scraped                               |
| No caller-supplied identity | client functions take the credential HMAC and derive connection, owner, role, platform in the database; strict input schemas reject ownership/role fields |
| Credential at rest          | only `sha256(HMAC)` stored, so a DB dump cannot be replayed against client functions                                                                      |
| Same-owner pairing          | composite FKs make cross-owner links unrepresentable; functions return a generic `not_found`                                                              |
| Role enforcement            | only controllers request; only the exact target agent session approves; insert trigger enforces controller/agent even for privileged writers              |
| Explicit approval           | links start `pending`; never auto-activated                                                                                                               |
| Duplicates                  | one live link per exact pair (partial unique index); duplicate requests reuse it                                                                          |
| Terminal states             | retired/revoked sessions and revoked links cannot be reactivated (triggers)                                                                               |
| Cascade                     | connection end → sessions revoked → links revoked (explicit state) + use-time re-validation                                                               |
| No enumeration              | other users' or nonexistent sessions/links produce the same `404 not_found`                                                                               |
| Limits                      | 50 active sessions per connection; 8 KB request bodies                                                                                                    |

Tests prove cross-user, wrong-role, impersonation, revoked-connection and retired-session denial
(pgTAP, PostgREST integration and HTTP e2e). A deliberately weakened `approve_pairing` makes 8
tests fail.

## Routing (Phase 5)

Full design: [routing.md](routing.md).

| Control                  | Implementation                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical routing        | origin `tlses_` → active `tllnk_` → target `tlses_` → target connection, resolved in the database; callers cannot supply target/owner/connection          |
| Send-time validation     | connection, origin session, role, link, target session and target connection all re-checked on create                                                     |
| Delivery-time validation | every inbox/claim/start/progress/complete/fail/get re-checks the route; invalid → `cancelled` (`route_invalid`), proven with the cascade trigger disabled |
| Exact target             | only the link's agent session sees or claims the task; others get `404`                                                                                   |
| Exact origin             | only the originating controller session reads the result                                                                                                  |
| Atomic claim             | row lock + state guard; one owner per task; `claimRef` binds later steps to that worker                                                                   |
| Integrity                | composite FKs (one owner) + triggers (task route = link sides; message route = task sides) + state-machine trigger (no reactivation)                      |
| Revocation               | link revoked → open tasks cancelled (`link_revoked`); history kept                                                                                        |
| Limits                   | 64 KB tasks, 256 KB results, 100 open tasks per link, body caps checked before reading (`413`)                                                            |
| Logs                     | no task content, tokens or HMACs in server logs (scanned after e2e)                                                                                       |

A deliberately weakened exact-target check makes both the pgTAP and integration suites fail.

## Privileged client exception

`createPrivilegedSupabaseClient()` (`lib/supabase/admin.ts`) uses `SUPABASE_SECRET_KEY` and
**bypasses RLS**. Rules:

- server-only (`server-only` import; a client import fails the build);
- takes no parameters: it cannot be handed a caller-chosen identity;
- never the normal data path. Tenant data goes through the user-scoped client so RLS applies;
- any use must be owner-scoped with an ID from `requireThreadLinkUser()`;
- **centralized and auditable**: ESLint `no-restricted-imports` flags every import, and
  `tests/client-boundary.test.ts` fails unless the importer is in `PRIVILEGED_CLIENT_ALLOWLIST`.
  The allowlist is **empty** in Phase 2: no application code uses the privileged client.

## Database test safety

RLS and integration tests run only against the local disposable Supabase stack. The integration
harness refuses any non-local API URL. Hosted projects receive only additive migrations after a
read-only target check. See [database.md](database.md).

## Connection secret

`THREADLINK_CONNECTION_SECRET` is the HMAC key for credential hashes: server-only, validated
(≥43 base64url chars, must not equal a Clerk/Supabase key), read only through `getServerEnv()`.
It must be set separately in every environment (local, Vercel). Rotating it invalidates all issued
connection credentials. `THREADLINK_ENCRYPTION_KEY` and `THREADLINK_HMAC_SECRET` remain unused.

## Supabase keys

- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: safe for the browser; all access is subject to RLS.
- `SUPABASE_SECRET_KEY`: **bypasses RLS**. Server-only, via `createPrivilegedSupabaseClient()`.
  Every query made with it must be scoped by an owner ID from `requireThreadLinkUser()`.
- `DATABASE_URL`: server-only; used for migrations (`supabase db push`), not by the app at runtime.

## Secrets handling

- Real values live in `.env.local` (local) and Vercel project settings (deployed).
- `.env.example` contains names and placeholders only.
- Never print, log or serialize secret values. `THREADLINK_LOG_REQUEST_BODIES` should stay `false`.
- If a secret is ever committed, rotate it immediately. Removing it from history alone is not enough.

## Planned controls (later phases)

- RLS + cross-user denial tests for every new tenant-owned table (bindings, links, tasks, messages).
- Revocation enforcement in routing and MCP (Phases 4–5); signed requests/replay protection for bridge traffic if needed.
- Disable Supabase Auth sign-ups on the hosted project so no parallel Supabase users can exist.
- Per-IP rate limiting for `/api/connection/*` at deployment (Phase 8).
- Request freshness/replay controls for bridge and agent requests: timestamps, nonces, expiry, and
  possibly per-connection signing keys, using established libraries only.
- Content-Security-Policy tuned for Clerk.
- Audit events for significant state transitions.
