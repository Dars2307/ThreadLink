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

## Scripts

| Script              | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Development server                             |
| `npm run build`     | Production build                               |
| `npm run lint`      | ESLint                                         |
| `npm run typecheck` | Generate Next route types, then `tsc --noEmit` |
| `npm test`          | Vitest security/unit tests                     |
| `npm run format`    | Prettier write                                 |
| `npm run check`     | lint + typecheck + test + build                |

## Project layout

```text
app/                      Routes (landing, sign-in, sign-up, dashboard)
components/               Shared UI
lib/auth/                 Server-side identity resolution (Clerk)
lib/env/                  Validated environment (server + public)
lib/security/             Security helpers (masking, public-env guard)
lib/supabase/             Supabase clients (user-scoped, privileged, browser)
proxy.ts                  Route protection (deny by default)
tests/                    Security boundary tests
docs/                     Architecture, security, roadmap
```

## Documentation

- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)
- [docs/roadmap.md](docs/roadmap.md)
