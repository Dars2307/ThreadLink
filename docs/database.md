# ThreadLink Database

Supabase is used as **Postgres only**. Supabase Auth is not used and no Supabase Auth users are
created. Clerk is the identity authority; Supabase trusts Clerk-issued session tokens through its
Clerk **third-party auth** integration.

## Migrations

Schema lives in version-controlled SQL under `supabase/migrations/` (Supabase CLI conventions). The
database is reconstructable from these files alone (`supabase db reset --local`).

| File                                               | Contents                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `20260922000100_threadlink_private_foundation.sql` | `threadlink_private` schema, ID generator, verified-subject helper                                      |
| `20260922000200_users.sql`                         | `public.users`, `current_user_id()`, `provision_current_user()`, RLS                                    |
| `20260922000300_connections.sql`                   | `public.connections`, lifecycle guard, column grants, RLS                                               |
| `20260922000400_connection_credentials.sql`        | credentials, audit events, register/revoke/rotate/authenticate functions; tightens `connections` grants |

Rules:

- Never edit an applied migration; add a new one.
- Never create or alter schema through the Supabase dashboard (the Clerk third-party auth setting is
  the only dashboard configuration).
- Never `db reset` or run tests against a hosted project.

## Identifiers

ThreadLink IDs are `<prefix>_<32 lowercase hex>`, e.g. `tlusr_3f9c…`.

| Prefix   | Entity                | Phase    |
| -------- | --------------------- | -------- |
| `tlusr_` | ThreadLink user       | 2        |
| `tlcon_` | Connection            | 2        |
| `tlcrd_` | Connection credential | 3        |
| `tlevt_` | Audit event           | 3        |
| `tlses_` | Session binding       | reserved |
| `tllnk_` | ThreadLink            | reserved |

- Generated only in the database by `threadlink_private.generate_id()` from `gen_random_uuid()`
  (UUIDv4, 122 bits from the server CSPRNG). No custom cryptography.
- Not sequential or time-ordered (UUIDv7 was rejected because its leading bits are a timestamp).
- Encode no personal data; unaffected by name/email changes.
- Enforced by `CHECK` constraints and validated again in `lib/ids.ts`.
- Stored as `text` primary keys so the prefix is part of the value everywhere (logs, APIs, FKs).

Clerk IDs (`user_…`) are never used as ThreadLink object IDs.

## Tables

### `public.users`

| Column                          | Notes                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `id`                            | `tlusr_…`, immutable ThreadLink identity; ownership root                         |
| `clerk_user_id`                 | `UNIQUE`, immutable; equals the verified JWT `sub`                               |
| `display_name`, `primary_email` | Profile metadata copied from Clerk. **Never** used for authorization; not unique |
| `created_at`, `updated_at`      | Timestamps                                                                       |

A trigger forbids changing `id`, `clerk_user_id` or `created_at`, even for privileged roles.

### `public.connections`

| Column                                                   | Notes                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `id`                                                     | `tlcon_…`                                                                         |
| `owner_user_id`                                          | FK → `users.id`; set from the verified caller by `register_connection`; immutable |
| `platform`                                               | `chatgpt` \| `claude-code`                                                        |
| `role`                                                   | `controller` \| `agent`                                                           |
| `status`                                                 | `active` \| `idle` \| `revoked` \| `retired`; `revoked`/`retired` are terminal    |
| `display_name`                                           | Cosmetic label, ≤100 chars                                                        |
| `created_at`, `updated_at`, `last_seen_at`, `revoked_at` | `revoked_at` is set by trigger and must be present iff status is `revoked`        |

Since Phase 3, connections are created, revoked and rotated only through database functions, and
carry credentials in `connection_credentials`. See [connections.md](connections.md) for the
credential model, `connection_credentials` and `audit_events`.

## Identity mapping and provisioning

```text
Clerk session token (verified by Supabase: signature + trusted issuer)
   -> auth.jwt()->>'sub'                      threadlink_private.current_clerk_user_id()
   -> users.clerk_user_id                     (must match ^user_[A-Za-z0-9]+$ or NULL)
   -> users.id                                threadlink_private.current_user_id()
   -> row.owner_user_id                       RLS policies
```

`public.provision_current_user(p_display_name, p_primary_email)`:

- takes **no identity parameter**; the Clerk user ID comes only from the verified JWT;
- raises `28000` if there is no valid subject;
- `INSERT … ON CONFLICT (clerk_user_id)`: idempotent and race-safe (unique constraint);
- refreshes profile metadata when it changes; never changes `id`.

App side, `requireThreadLinkUser()` (`lib/auth/threadlink-user.ts`) calls it with the user-scoped
client and verifies the returned `clerk_user_id` equals the server-verified identity.

## RLS and grants

RLS is enabled on every `public` table. Supabase's broad default table grants are revoked and
replaced with least-privilege grants:

| Role            | `users`                         | `connections`                                                               |
| --------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `anon`          | none                            | none                                                                        |
| `authenticated` | `SELECT`                        | `SELECT`; `UPDATE (display_name)` (create/revoke/rotate via functions only) |
| `service_role`  | Supabase default (bypasses RLS) | Supabase default (bypasses RLS)                                             |

Policies (all `TO authenticated`, none `USING (true)`):

| Policy                                                         | Rule                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| `users_select_own`                                             | `clerk_user_id = current_clerk_user_id()` |
| `connections_{select,update}_own` (+ update `WITH CHECK`)      | `owner_user_id = current_user_id()`       |
| `connection_credentials_select_own`, `audit_events_select_own` | `owner_user_id = current_user_id()`       |

A missing or malformed `sub` makes the helpers return `NULL`, so every comparison is false: deny.
Other users' rows are indistinguishable from nonexistent rows (empty result / 0 rows affected).

`current_user_id()` is `SECURITY DEFINER` with `search_path = ''` so policies can resolve ownership
without recursive RLS; it can only return the caller's own ID. Helpers live in the
`threadlink_private` schema, which is not exposed through the Data API.

## Testing

HTTP e2e: `npm run dev:local-db` (Next.js on :3200 against the local stack with a test-only
secret), then `npm run test:e2e`.

| Command                    | What it proves                                                                                               | Target                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `npm run test:db`          | pgTAP: RLS/grants/policies/credentials as `anon`/`authenticated` roles with JWT claims (115 assertions)      | local only                          |
| `npm run test:integration` | App code → supabase-js → PostgREST → RLS with signed tokens, incl. forged tokens and concurrent provisioning | local only (refuses non-local URLs) |
| `npm test`                 | Unit tests (no database)                                                                                     | none                                |

The pgTAP suite runs in one rolled-back transaction. Integration tests use random per-run Clerk IDs
and delete their fixtures. A deliberately injected `USING (true)` policy makes the suite fail
(verified during Phase 2), so the tests do detect broken isolation.

Local stack: `npm run db:start` (Docker required), `npm run db:reset:local` to rebuild from
migrations.

## Applying to the hosted project

1. Confirm the target: `DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` refer to the same project,
   and it is not production.
2. Inspect read-only for existing/conflicting objects.
3. `supabase db push --db-url "$DATABASE_URL"` (additive; applies only unapplied migrations).

The direct database host (`db.<ref>.supabase.co`) is IPv6-only. From IPv4-only networks (and
Vercel) use the **session pooler** connection string (port 5432) for `DATABASE_URL`.
