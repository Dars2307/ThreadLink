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

## Supabase keys

- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: safe for the browser; all access is subject to RLS.
- `SUPABASE_SECRET_KEY`: **bypasses RLS**. Server-only, via `createPrivilegedSupabaseClient()`.
  Every query made with it must be scoped by an owner ID from `requireIdentity()`.
- `DATABASE_URL`: server-only; intended for migrations and tests.

## Secrets handling

- Real values live in `.env.local` (local) and Vercel project settings (deployed).
- `.env.example` contains names and placeholders only.
- Never print, log or serialize secret values. `THREADLINK_LOG_REQUEST_BODIES` should stay `false`.
- If a secret is ever committed, rotate it immediately. Removing it from history alone is not enough.

## Planned controls (later phases)

- RLS policies on every tenant-owned table, with cross-user denial tests (Phase 2).
- Connection credentials and revocation (Phases 3–4, 8).
- Request freshness/replay controls for bridge and agent requests: timestamps, nonces, expiry, and
  possibly per-connection signing keys, using established libraries only.
- Content-Security-Policy tuned for Clerk.
- Audit events for significant state transitions.
