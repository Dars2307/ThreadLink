# ThreadLink Roadmap

Mirrors §28 of [`THREADLINK_MASTER_GUIDE.md`](../THREADLINK_MASTER_GUIDE.md). Each phase stops for
review before the next begins.

The frog: a real authenticated task travels from the ChatGPT-side connection to the correct Claude
Code execution agent, and the real result returns through ThreadLink to the correct origin, with
ownership isolation intact.

| Phase | Name                                    | Win condition                                                                                               | Status   |
| ----- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| 0 + 1 | Repository bootstrap + Clerk identity   | App scaffolded; a user can authenticate and the backend resolves the correct Clerk identity                 | **Done** |
| 2     | Database foundation + tenant isolation  | Users + connections persist with ThreadLink IDs; RLS cross-user and anonymous denial proven                 | **Done** |
| 3     | Connection registry + client identity   | ChatGPT and Claude Code connections register under the user with revocable, hashed credentials              | **Done** |
| 4     | Session bindings + pairing              | One ChatGPT binding securely links to one Claude Code binding                                               | **Done** |
| 5     | Tasks, messages + routing core          | A controller session's task reaches only the paired agent session and the result returns only to the origin | **Done** |
| 6     | Real clients (MCP + Claude Code bridge) | Local bridge receives the task and returns status/results                                                   | Next     |
| 7     | End-to-end proof                        | One real task completes the round trip                                                                      | Planned  |
| 8     | Deployment + hardening                  | Reproducible Vercel deploy, correct secrets, security tests pass, revocation works                          | Planned  |

## Alpha scope

One user account, Clerk auth, one ChatGPT connection, one Claude Code connection, one ThreadLink
pairing, task/message dispatch, return routing, task state, audit log, artifact references,
Supabase Postgres + RLS, remote MCP endpoint, local Claude Code bridge, Vercel deployment.

## After alpha (not in scope now)

- Additional adapters: Codex, Nova, Claude chat, other MCP-capable clients
- Workspaces/organisations, role-based permissions, explicit cross-user collaboration
- Multi-step orchestration chains
- Project-level event stream, capability model, production approvals
- Railway/Redis/queues only if the alpha proves them necessary
