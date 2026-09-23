# Notifications, acknowledgement and blocked states

ChatGPT cannot wake itself when Claude finishes, so ThreadLink has to tell the
user. Three pieces fit together.

## Acknowledgement

A result is **unacknowledged** until a controller says it has read it.

```
Claude finishes -> result stored -> unacknowledged
                -> controller reads it -> acknowledge_result -> acknowledged
                -> any pending fallback is cancelled
```

- `acknowledge_result` (MCP) and `POST /api/tasks/<id>/acknowledge`.
- Only the session the task came **from** may acknowledge it. Another chat of
  the same user cannot, and another account gets "not found".
- **Polling is not acknowledgement.** Neither `get_task_status` nor even
  `get_task_result` sets it: fetching bytes is not a client having read them.
- Idempotent: acknowledging twice does not move `acknowledged_at`.
- Nothing about it reaches Claude Code. It is ThreadLink-internal.
- `acknowledged_actor_type` is stored, and already allows `user`, `runtime` and
  `automation` so adding those later is not another migration.

## Blocked: alive, but not progressing

A task that cannot proceed says so instead of sitting at `working` looking
productive. It keeps its claim and lease - it has not died.

| Reason                | Meaning                                | Notifies                                    |
| --------------------- | -------------------------------------- | ------------------------------------------- |
| `plan_mode`           | The Claude session cannot make changes | No - fixed by changing mode, not by a nudge |
| `approval_required`   | Waiting for a person                   | Yes                                         |
| `user_input_required` | Waiting for an answer                  | Yes                                         |

The case that prompted this: a delegated task ran in Claude's **Plan Mode** and
researched forever without implementing anything. The root cause was ours - the
Runtime defaulted every task to `plan`. A background worker now starts in a mode
that can actually act, while the user's own conversation keeps the configured
mode, because ThreadLink must not quietly hand itself more permission in a
conversation they can see.

## Notifications

One notification per meaningful state, one delivery row per channel.

- Meaningful: task completed, task failed, approval required, user input
  required. **Never** progress, polling or tool chatter.
- `notifications_task_event_key` makes a repeated state report a no-op;
  `notification_deliveries_channel_key` means a channel delivers once.
- The desktop router additionally dedupes identical events within 60 seconds,
  and events of one kind within a minute share a `coalesce_key` so a burst can
  be shown as one message.

### Safe metadata only

A notification can appear on a lock screen, so it carries the task title, the
workspace and the state - and never the prompt, the result body, a diff, a
token or a key. Titles are control-stripped and length-capped.

## Channels

| Channel  | State                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Desktop  | **Working.** The default free channel, in the ThreadLink desktop app. Clicking opens the relevant dashboard page. |
| Email    | Data model and scheduling complete; **sending is blocked** (below).                                               |
| Web Push | Subscription model and capability present; **delivery disabled** - no VAPID key pair is configured.               |

### Email fallback

Email is a fallback, not a notification for every task:

```
task completes -> send_after = completed_at + grace (default 10 minutes)
               -> acknowledged before then?  -> suppressed
               -> still unacknowledged?      -> due
```

`run_notification_sweep()` handles due rows. It is race-safe by construction:
rows are taken `FOR UPDATE SKIP LOCKED`, acknowledgement is re-checked **inside**
that lock, and the unique channel constraint means a row cannot be sent twice.
It is safe to run by hand and safe to run twice.

Scheduling uses **Supabase Cron (pg_cron)**, because the desktop Runtime is
exactly what is not running when the user is away - which is when the fallback
matters. The migration schedules `threadlink-notification-sweep` (every minute)
when `pg_cron` is present, and says so in a notice when it is not.

**Owner step for hosted:** enable the `pg_cron` extension (Dashboard → Database
→ Extensions), then re-run the scheduling block. ThreadLink does not invent a
scheduler and does not enable extensions on your behalf.

## BYO Resend: blocked, deliberately

ThreadLink will not depend on one shared email account for all users, so email
needs the user's own provider key. **That is not possible safely today.**

ThreadLink has no secure per-user secret storage: secrets are operator-level
environment variables, and `THREADLINK_ENCRYPTION_KEY` is reserved and unread.
So:

- there is **no column** for an API key - a plaintext one would be worse than
  the feature is worth;
- `notification_settings` tracks only `email_provider` and
  `email_credential_state`;
- `email_credential_state` stays `unavailable`, and a due fallback is recorded
  as `unavailable` with a reason rather than silently dropped.

Unblocking it needs a reviewed design: envelope encryption with a managed key,
write-only from the browser, never returned after saving, never logged, and
redacted from errors. Until then the channel is honest about being unavailable.

Email is no-reply by design. There is no inbound handling and none is planned:
email must not become a second controller.
