# ThreadLink Master Guide v0.1

## 1. Purpose
ThreadLink is a secure cross-agent coordination and routing platform. Its purpose is to let a user remain in one primary conversational interface, such as ChatGPT, while securely sending work to another connected agent, such as Claude Code, and receiving the result back in the correct originating conversation without repeatedly naming or manually locating the target session.

The alpha scope is deliberately narrow: ChatGPT as the primary controller and Claude Code as the execution agent.

ThreadLink is not a giant shared chat. It is not transcript mirroring. It is not a generic memory dump. It is a secure identity, session-binding, routing, task, message, and return-path layer between independently operating AI clients.

---

## 2. Core Product Promise
A user should be able to say, from an already-linked ChatGPT conversation:

> Send this to Claude.

ThreadLink should already know:
- who the user is;
- which ThreadLink account owns the connection;
- which ChatGPT-side binding originated the request;
- which Claude Code connection is paired with that binding;
- what permissions apply;
- where the reply must return;
- how to record the task, result, artifacts, and audit trail.

The user should not need to remember chat names, provider-native session IDs, or routing codes after the initial secure connection is established.

---

## 3. Product Principles

### 3.1 Identity before routing
Every route must originate from an authenticated ThreadLink identity.

### 3.2 Names are cosmetic; IDs are authoritative
Display names may change at any time. Routing and authorization must depend on immutable ThreadLink IDs and verified ownership relationships.

### 3.3 Default point-to-point routing
Messages and tasks should go to one exact linked destination unless the user explicitly chooses a broader target.

### 3.4 No implicit cross-user access
User A must not be able to read, infer, enumerate, address, or control User B's private ThreadLink resources.

### 3.5 Explicit linking
A controller and execution agent should be linked only through a user-approved connection flow.

### 3.6 Persistent authentication, per-request authorization
The user should not repeatedly log in for each message, but every operation must still pass authorization checks.

### 3.7 Fail closed
If identity, ownership, membership, permission, or destination validation fails, deny the operation.

### 3.8 Provider-native IDs are optional metadata
ThreadLink must not depend on ChatGPT, Claude Code, or any future provider exposing a stable native conversation ID. ThreadLink creates its own canonical bindings.

### 3.9 Evidence-aware execution
Execution results should be able to return evidence such as commit SHA, file path, test result, deployment ID, or other artifact references.

### 3.10 Build the alpha around one proven route
The first success criterion is one secure round trip between ChatGPT and Claude Code.

---

## 4. Alpha Scope

### Included
- one ThreadLink user account;
- Clerk authentication;
- one ChatGPT controller connection;
- one Claude Code execution-agent connection;
- one ThreadLink pairing between them;
- secure task/message dispatch;
- return routing;
- task state;
- audit log;
- artifact references;
- Supabase Postgres persistence;
- Postgres row-level security;
- remote MCP endpoint;
- local Claude Code bridge;
- Vercel deployment for the ThreadLink web/API/MCP application.

### Excluded from Alpha
- multiple Claude Code accounts per user;
- teams and organisations;
- shared cross-user workspaces;
- Codex;
- Nova;
- Claude chat;
- multi-agent orchestration chains;
- public marketplace;
- billing;
- embeddings/vector memory;
- transcript mirroring;
- mobile app;
- complex dashboard;
- automatic import of old chats;
- production-grade global edge routing;
- Redis unless proven necessary.

---

## 5. Recommended Alpha Stack

### Development machine
User laptop.

### Repository
GitHub.

### Application
Next.js + TypeScript.

### Hosting
Vercel.

### Authentication
Clerk.

### Database
Supabase Postgres.

### Database isolation
Postgres Row Level Security.

### MCP
Remote MCP endpoint served by the ThreadLink application.

### Claude Code side
Local TypeScript bridge/process running beside Claude Code.

### Optional later infrastructure
Railway for durable workers, persistent queues, WebSocket services, Redis, or always-on orchestration if the alpha proves those are needed.

### Not required for Alpha
Cloudflare Workers, Railway, Redis, Kafka, vector DB, separate microservices.

---

## 6. Identity Model

ThreadLink uses Clerk for human identity.

A user's Clerk user ID is the root authenticated identity. ThreadLink stores its own resource IDs around that identity.

Example conceptual structure:

```text
User
  clerk_user_id: user_...
  threadlink_user_id: tlusr_...
  display_name: Joel Ogunniyi
```

The display name is never used as an authorization key.

Authentication answers:
> Who is this user or client?

Authorization answers:
> Is this authenticated identity allowed to perform this action on this resource?

Authentication may persist. Authorization must be checked on every protected operation.

---

## 7. Connection Model

A Connection represents an authenticated installation or client relationship between ThreadLink and a platform/client.

Examples:
- ChatGPT connection;
- Claude Code connection.

Conceptual fields:

```text
Connection
- id
- owner_user_id
- platform
- connection_type
- status
- created_at
- last_seen_at
- revoked_at
- metadata
```

Possible `platform` values initially:
- chatgpt
- claude_code

Possible `status` values:
- active
- idle
- revoked
- retired
- unknown

A connection must belong to exactly one authenticated ThreadLink user in the alpha.

---

## 8. Session Binding Model

ThreadLink creates its own stable binding for the current logical conversation/session context.

Conceptual fields:

```text
SessionBinding
- id
- owner_user_id
- connection_id
- provider_session_ref (nullable)
- display_name (nullable)
- project_id (nullable)
- status
- created_at
- last_seen_at
```

`provider_session_ref` is optional. ThreadLink must work even when the provider does not expose a stable native session ID.

The ThreadLink binding ID is canonical.

---

## 9. ThreadLink Object

A ThreadLink joins exact session bindings together.

For alpha:

```text
ThreadLink
- id
- owner_user_id
- controller_binding_id
- execution_binding_id
- status
- created_at
- revoked_at
```

The initial topology is:

```text
ChatGPT controller binding
        |
        | secure ThreadLink
        v
Claude Code execution binding
```

The ThreadLink object is the routing relationship.

Renaming either chat or session must not break the link.

---

## 10. Controller and Execution Agent

### Controller
The user's primary conversational interface.

Alpha default:
- ChatGPT

### Execution Agent
The connected agent that receives delegated work.

Alpha default:
- Claude Code

These are roles, not hard-coded provider assumptions. Future versions may allow users to change defaults.

---

## 11. Initial Connection and Authentication Flow

### ChatGPT side
1. User adds ThreadLink MCP/app to ChatGPT.
2. ThreadLink requires authentication.
3. User is redirected to Clerk-hosted sign-in.
4. User signs in with email, Google, or another enabled provider.
5. ThreadLink validates the Clerk identity.
6. A ChatGPT Connection is registered under that ThreadLink user.
7. The current logical chat/session receives a ThreadLink SessionBinding.
8. The connection remains authenticated until revoked, expired, or disconnected.

### Claude Code side
1. User configures/starts ThreadLink for Claude Code.
2. The bridge opens or presents a Clerk authentication flow.
3. User signs in to the same ThreadLink account.
4. A Claude Code Connection is registered under that user.
5. A Claude Code SessionBinding is created.
6. The local bridge keeps only the minimum local credentials necessary and protects them using OS-appropriate secure storage where practical.

---

## 12. Pairing Flow

The alpha should require explicit approval before creating the first ThreadLink relationship.

Example:
1. From ChatGPT, user requests: `Connect this chat to Claude Code.`
2. ThreadLink resolves the authenticated user.
3. ThreadLink lists only eligible Claude Code connections belonging to that same user.
4. If exactly one active Claude Code target exists, ThreadLink may propose it.
5. User approves.
6. Claude-side bridge may also require approval for first-time pairing.
7. ThreadLink creates the ThreadLink relationship.
8. Subsequent routing uses that relationship automatically until revoked or changed.

No other user's connection may ever be offered as an eligible destination in the private alpha model.

---

## 13. Routing Flow

Example user command:

> Send this to Claude.

Conceptual flow:

```text
ChatGPT request
  -> authenticate connection
  -> resolve owner user
  -> resolve origin binding
  -> resolve active ThreadLink
  -> authorize membership
  -> resolve paired Claude Code binding
  -> verify destination ownership
  -> create signed/validated message envelope
  -> persist task + message
  -> deliver to Claude Code bridge
  -> Claude works
  -> Claude posts result
  -> ThreadLink validates result
  -> result is attached to originating task/message
  -> origin receives or can fetch the result
```

---

## 14. Message Envelope

Illustrative only; final schema may evolve.

```json
{
  "message_id": "msg_...",
  "thread_link_id": "tl_...",
  "task_id": "task_...",
  "owner_user_id": "tlusr_...",
  "origin_binding_id": "bind_chatgpt_...",
  "target_binding_id": "bind_claude_...",
  "type": "task",
  "priority": "A1",
  "content": "...",
  "reply_to_binding_id": "bind_chatgpt_...",
  "created_at": "...",
  "expires_at": "..."
}
```

The user-facing system should not expose internal ownership IDs unless needed for debugging/admin purposes.

---

## 15. Return Routing

Every outbound task must carry enough server-side metadata to return a result to the origin without user intervention.

Conceptual return envelope:

```json
{
  "message_id": "msg_result_...",
  "in_reply_to": "msg_...",
  "task_id": "task_...",
  "thread_link_id": "tl_...",
  "origin_binding_id": "bind_claude_...",
  "target_binding_id": "bind_chatgpt_...",
  "status": "completed",
  "content": "...",
  "artifacts": [
    {
      "type": "git_commit",
      "value": "abc123"
    }
  ]
}
```

---

## 16. Task States

Alpha task states:
- queued
- delivered
- working
- blocked
- completed
- failed
- cancelled

A task must have an audit trail of significant state transitions.

---

## 17. Priority Model

ThreadLink should support the user's A-E priority model, but alpha implementation can begin with a lightweight field.

Possible values:
- A1
- A2
- A3
- B
- C
- D
- E

A1 is the frog / highest-priority execution item.

---

## 18. Security Architecture

Security is a product requirement, not a later hardening step.

### 18.1 Core request chain
Every protected request should conceptually pass:

```text
1. Verify authentication token
2. Resolve authenticated user
3. Resolve connection
4. Verify connection ownership
5. Resolve resource / ThreadLink
6. Verify membership
7. Verify requested permission
8. Verify destination ownership/eligibility
9. Validate request freshness/replay controls where applicable
10. Perform action
11. Write audit event
```

If any mandatory check fails: deny.

### 18.2 Tenant isolation
User A must not be able to:
- list User B's sessions;
- query User B's messages;
- guess User B's task IDs and receive metadata;
- address User B's connections;
- infer whether a private resource exists;
- read audit data belonging to User B.

Where possible, unauthorized resource access should return a generic not-found/denied response without leaking metadata.

### 18.3 Database RLS
Use Supabase/Postgres RLS as a second enforcement layer.

Every tenant-owned table should carry an owner or workspace boundary and have explicit RLS policies.

Do not rely solely on application-layer filters.

### 18.4 Secrets
- never commit Clerk secret keys;
- never commit Supabase service-role keys;
- never expose server-only credentials to the browser;
- provide `.env.example` with placeholders only;
- keep real secrets in local environment/Vercel project settings;
- use least-privilege credentials where possible.

### 18.5 Cryptography
Do not invent custom cryptographic algorithms.

Use established libraries and platform standards.

Potential later controls for agent/bridge requests:
- signed request bodies;
- per-connection keypair;
- nonce;
- timestamp;
- expiry;
- request hash;
- replay cache.

The alpha may begin with short-lived authenticated tokens if that is sufficient, provided the design leaves room for stronger device/connection signing.

### 18.6 Revocation
A user must be able to revoke:
- a platform connection;
- a session binding;
- a ThreadLink pairing;
- a device/agent credential.

Revocation must take effect promptly.

---

## 19. Performance Targets

Do not promise impossible end-to-end latency across providers and the public internet.

Target ThreadLink's own internal overhead to be negligible relative to AI execution.

Initial engineering goals:
- p50 internal auth + route resolution: <10 ms where practical;
- p95 internal auth + route resolution: <30 ms where practical;
- database and network timings instrumented separately;
- provider latency excluded from ThreadLink internal routing SLOs.

Do not prematurely optimize before correctness and security.

---

## 20. Data Model: Alpha

Likely tables/entities:

### users
- id
- clerk_user_id
- display_name
- created_at

### connections
- id
- owner_user_id
- platform
- connection_type
- status
- metadata
- last_seen_at
- created_at
- revoked_at

### session_bindings
- id
- owner_user_id
- connection_id
- provider_session_ref
- display_name
- status
- metadata
- created_at
- last_seen_at

### thread_links
- id
- owner_user_id
- controller_binding_id
- execution_binding_id
- status
- created_at
- revoked_at

### tasks
- id
- owner_user_id
- thread_link_id
- origin_binding_id
- target_binding_id
- priority
- status
- title
- content
- created_at
- updated_at

### messages
- id
- owner_user_id
- thread_link_id
- task_id
- origin_binding_id
- target_binding_id
- type
- content
- in_reply_to
- created_at
- expires_at

### artifacts
- id
- owner_user_id
- task_id
- type
- value
- metadata
- created_at

### audit_events
- id
- owner_user_id
- actor_connection_id
- resource_type
- resource_id
- action
- outcome
- metadata
- created_at

The schema should be normalized enough for correctness but must remain simple for the alpha.

---

## 21. MCP Surface: Alpha

The final names may evolve, but the alpha likely needs tools conceptually similar to:

- `whoami`
- `register_connection`
- `register_binding`
- `list_my_connections`
- `create_thread_link`
- `get_current_thread_link`
- `send_to_agent`
- `get_task_status`
- `get_updates`
- `complete_task`
- `revoke_thread_link`

Do not expose administrative cross-user lookup tools to ordinary users.

---

## 22. Claude Code Bridge

The Claude Code side should begin as a small local TypeScript process.

Responsibilities:
- authenticate the user/connection;
- register itself with ThreadLink;
- maintain its binding;
- poll or subscribe for tasks;
- hand eligible work to the Claude Code execution environment;
- post task state changes;
- return results and artifact references;
- preserve the ThreadLink task ID through the full lifecycle;
- never accept work for another user's private connection;
- fail safely when authentication expires or is revoked.

The bridge should be replaceable later without changing the central ThreadLink protocol.

---

## 23. ChatGPT Integration

ThreadLink must not assume ChatGPT exposes a stable internal conversation ID.

The integration should prefer any stable provider context that is officially available, but the canonical routing identity remains the ThreadLink SessionBinding.

If additional conversation-scoped state is required, design it through supported MCP/app mechanisms rather than undocumented scraping or brittle UI automation.

---

## 24. UI: Alpha

The UI is secondary to end-to-end routing.

Minimum useful UI after the routing path works:
- sign in / sign out;
- current account;
- connected platforms;
- connection status;
- active ThreadLink;
- revoke connection;
- recent tasks;
- task status.

Do not spend early alpha time on visual polish before a real round trip succeeds.

---

## 25. Future Architecture

Potential expansion after alpha validation:

### Multi-agent providers
- Codex
- Nova
- Claude chat
- other MCP-capable clients

### Workspaces / organisations
- shared projects;
- role-based permissions;
- explicit cross-user collaboration;
- team-owned agents.

### Orchestration
Example:

```text
ChatGPT
  -> Claude Code implementation
  -> Codex review
  -> Claude Code fix
  -> ChatGPT summary
```

### Event stream
Important project-level events, not full transcript mirroring.

Example event types:
- task_created
- task_completed
- approval_required
- approval_granted
- deployment_completed
- review_failed
- artifact_created

### Capability model
Potential capabilities:
- read
- message
- create_task
- execute
- write_repo
- deploy
- approve

### Production approvals
Sensitive actions such as production deployment should be separately permissioned and may require explicit human approval.

---

## 26. Non-Goals

ThreadLink is not intended to:
- merge all chats into one giant conversation;
- trust agent claims without evidence;
- bypass provider security models;
- scrape proprietary interfaces as the architectural foundation;
- use display names as security identifiers;
- grant broad access merely because two clients belong to the same user;
- expose one user's resources to another user by default;
- require users to memorize IDs or chat names for normal operation.

---

## 27. Alpha Definition of Done

ThreadLink Alpha v0.1 is considered real when all of the following are demonstrated:

1. User signs into ThreadLink through Clerk.
2. ChatGPT-side connection is registered to that user.
3. Claude Code-side connection is registered to the same user.
4. A secure ThreadLink relationship is created between the two bindings.
5. From the ChatGPT-side workflow, a real task is sent without manually entering the Claude session name each time.
6. The correct Claude Code agent receives the task.
7. Claude Code reports working/completed state.
8. The result is routed back to the originating ThreadLink task/context.
9. Another user cannot read or address the first user's private resources.
10. Revoking a connection prevents future routing through it.
11. Core security and RLS tests pass.
12. The end-to-end path is documented and reproducible.

---

## 28. Build Order

### Phase 0 - Repository and architecture
- initialize repo;
- install core dependencies;
- add environment template;
- add this master guide;
- add CLAUDE.md;
- define folder structure;
- no unnecessary features.

### Phase 1 - Clerk identity
Win: a user can authenticate and the backend can resolve the correct Clerk user identity.

### Phase 2 - Supabase schema + RLS
Win: user-owned resources are persisted and cross-user access tests are denied.

### Phase 3 - Connection registry
Win: ChatGPT-side and Claude Code-side connections can register under the authenticated user.

### Phase 4 - Session bindings + pairing
Win: one ChatGPT binding securely links to one Claude Code binding.

### Phase 5 - MCP routing
Win: `send_to_agent` creates and routes a task to the linked Claude Code destination.

### Phase 6 - Claude Code bridge
Win: local bridge receives the task and can return status/results.

### Phase 7 - End-to-end proof
Win: one real task completes round-trip.

### Phase 8 - Deployment and hardening
Win: Vercel deployment is reproducible, secrets are correct, security tests pass, and revocation works.

---

## 29. Claude Code Working Rules

Claude Code must:
- read this file before architecture work;
- treat this file as the current product source of truth;
- not silently change the product model;
- not add infrastructure that is not required by the current phase;
- not weaken authentication, authorization, RLS, or ownership checks for convenience;
- not put secrets in source control;
- write tests for security boundaries;
- stop after each assigned phase and report what changed;
- include changed files, tests run, failures, risks, and next recommended step;
- ask before major architecture deviations;
- preserve the ability to add more providers later through adapters rather than provider-specific core logic.

---

## 30. The Frog

The most important result is not a dashboard, branding, or a perfect schema.

The frog is:

> A real authenticated task travels from the ChatGPT-side ThreadLink connection to the correct Claude Code execution agent and the real result returns through ThreadLink to the correct origin, with ownership isolation intact.

Until that works, secondary polish is not the priority.

