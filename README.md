# ThreadLink

ThreadLink is an authenticated coordination and routing layer between AI/client sessions. It lets
a user stay in one primary conversation (the controller) and securely send work to a linked
execution agent, with the result returned to the correct originating context. The user does not
need to re-name or re-locate the target session each time.

**Alpha v0.1** starts with **ChatGPT as the primary controller** and **Claude Code as the execution
agent**. Later adapters may include Codex, Nova, Claude chat, and other MCP-capable clients.

ThreadLink is not transcript mirroring, a shared giant chat, or a memory dump. It is an identity,
session-binding, routing, task, message and return-path layer.

> The authoritative product and architecture source is
> [`THREADLINK_MASTER_GUIDE.md`](THREADLINK_MASTER_GUIDE.md). Operating rules for coding agents are in
> [`CLAUDE.md`](CLAUDE.md).

## Stack

| Concern            | Choice                                            |
| ------------------ | ------------------------------------------------- |
| App / API / MCP    | Next.js (App Router) + TypeScript (strict)        |
| Human identity     | Clerk (canonical identity authority)              |
| Persistent state   | Supabase Postgres (Supabase Auth is **not** used) |
| Tenant isolation   | Application authorization + Postgres RLS          |
| Planned cloud host | Vercel                                            |
| Claude Code side   | Local TypeScript bridge (later phase)             |

## Getting started

Requires Node.js 20.9+ (22 recommended).

```bash
npm install
cp .env.example .env.local   # then fill in real values; never commit .env.local
npm run dev
```

Open http://localhost:3000. `/` is public; `/dashboard` requires sign-in.

### Database

Schema is defined by SQL migrations in `supabase/migrations/`. The hosted project also needs the
Clerk third-party auth integration enabled (see [docs/database.md](docs/database.md)).

Database and RLS tests run against a **local** disposable Supabase stack (Docker + Supabase CLI):

```bash
npm run db:start           # supabase start
npm run test:db            # pgTAP RLS suite
npm run test:integration   # app -> PostgREST -> RLS
npm run dev:local-db       # Next.js on :3200 against local Supabase (separate terminal)
npm run test:e2e           # HTTP connection-credential e2e against :3200
```

`THREADLINK_CONNECTION_SECRET` must be set (see `.env.example`) or the server refuses to start.

## Scripts

| Script                     | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `npm run dev`              | Development server                               |
| `npm run build`            | Production build                                 |
| `npm run lint`             | ESLint                                           |
| `npm run typecheck`        | Generate Next route types, then `tsc --noEmit`   |
| `npm test`                 | Vitest security/unit tests (no database)         |
| `npm run test:db`          | pgTAP RLS tests (local Supabase)                 |
| `npm run test:integration` | PostgREST/RLS integration tests (local Supabase) |
| `npm run test:all`         | Unit + database + integration                    |
| `npm run format`           | Prettier write                                   |
| `npm run check`            | lint + typecheck + test + build                  |

## Project layout

```text
app/                      Routes (landing, sign-in, sign-up, dashboard)
components/               Shared UI
lib/auth/                 Identity resolution (Clerk) + ThreadLink user provisioning
lib/connections/          Connection model, queries, repository
lib/ids.ts                ThreadLink ID formats (tlusr_, tlcon_, ...)
lib/env/                  Validated environment (server + public)
lib/security/             Security helpers (masking, public-env guard)
lib/supabase/             Supabase clients (user-scoped, privileged, browser)
proxy.ts                  Route protection (deny by default)
supabase/migrations/      Version-controlled schema
supabase/tests/database/  pgTAP RLS tests
tests/                    Unit tests; tests/integration/ needs local Supabase
docs/                     Architecture, security, roadmap
```

## Documentation

- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)
- [docs/database.md](docs/database.md)
- [docs/connections.md](docs/connections.md)
- [docs/roadmap.md](docs/roadmap.md)
