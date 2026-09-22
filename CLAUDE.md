# Claude Code Instructions - ThreadLink

Read `THREADLINK_MASTER_GUIDE.md` before making architectural or product decisions.

## Mission
Build ThreadLink Alpha v0.1 as a secure, minimal ChatGPT-to-Claude Code routing system. Do not broaden scope unless explicitly instructed.

## Current Alpha Stack
- Next.js + TypeScript
- Clerk for human authentication
- Supabase Postgres for persistence
- Postgres RLS for tenant isolation
- Vercel for web/API/MCP deployment
- Local TypeScript Claude Code bridge
- GitHub repository

## Non-negotiable rules
1. Security is part of the initial architecture, not a later patch.
2. Every protected operation must resolve authenticated identity and verify authorization.
3. Never rely on display names for ownership or routing.
4. Never assume ChatGPT or Claude exposes a stable native conversation ID.
5. ThreadLink-owned binding IDs are canonical.
6. User A must not be able to read, enumerate, infer, route to, or mutate User B's private resources.
7. Use Postgres RLS as a second enforcement layer.
8. Fail closed on auth, ownership, membership, permission, or destination validation failures.
9. Do not invent custom cryptography. Use established libraries/standards.
10. Never commit real secrets.
11. Do not add Railway, Cloudflare Workers, Redis, queues, or other infrastructure unless the current phase proves they are necessary.
12. Do not build a polished dashboard before the real end-to-end round trip works.
13. Keep provider-specific logic behind adapters/bridges so future Codex/Nova/Claude-chat support does not require core redesign.
14. Stop after each assigned phase. Report before proceeding.

## Required phase report format
At the end of every phase report:
- Objective
- What changed
- Files changed
- Tests run
- Test results
- Security checks performed
- Known limitations
- Blockers
- Recommended next step

Do not begin the next phase until instructed.
