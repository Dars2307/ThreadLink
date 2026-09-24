# Mirrored activity

## Why there is a mirror at all

A background worker runs in a Claude Code conversation that ThreadLink creates
and the user never opens. That is the whole point: their own conversation stays
open and untouched while work happens beside it.

The obvious thing to want next is for the work to appear *in* the conversation
they are looking at. That is not possible safely:

- Claude Code has no supported way to write into a session that is open. There
  is no API, no IPC and no documented command for it.
- The only mechanism that would work is editing the session's `.jsonl`
  transcript on disk while Claude Code owns it. ThreadLink does not do this and
  should not: the format is internal and undocumented, the file is being written
  concurrently, and a malformed line corrupts a conversation the user cannot get
  back. **No transcript file is ever mutated.**

So ThreadLink mirrors the work instead. The feed answers "what is ThreadLink
doing for this conversation?" next to the conversation it belongs to. It is a
status mirror, not a second copy of the conversation.

## What is mirrored

Milestones only, at most once each:

| Event | When |
| --- | --- |
| `task_started` | the claim and lease are real and execution has begun |
| `task_completed` | the result was accepted by ThreadLink |
| `task_failed` | the run failed, with a safe reason |
| `task_blocked` | alive, but waiting on a person |
| `task_lost` | the lease was lost before the task finished |

Tool calls, progress messages and polling are never mirrored. Each
`taskId:event` pair is recorded once, so a retry or a repeated snapshot cannot
post it twice, and the buffer is capped at `ACTIVITY_LIMIT` (100) entries.

## What a mirrored line may contain

The task's own title, the conversation and workspace it belongs to, the
execution mode, a timestamp, and — for a completion — one short summary line.

Everything else is deliberately absent. The summary is built by **removing**
rather than by selecting (`runtime/src/summary.ts`):

1. fenced and indented code goes first, because that is where diffs and keys live;
2. lines that look like source code are dropped entirely;
3. credentials are redacted by shape, not by name, so an unknown provider's key
   is still caught;
4. absolute paths are redacted, because they name a person and their machine;
5. control characters are stripped, so a summary cannot rewrite the display;
6. what is left is capped at one line.

If nothing safe survives, there is **no summary**. An empty line is a better
outcome than a leaked one. The full result stays in the ThreadLink task, behind
the same authorization as everything else, and the app links to it rather than
reproducing it.

## Blocked states

`report_task_blocked` records that a claimed task is alive but not progressing:
`approval_required`, `user_input_required` or `plan_mode`. The task keeps its
claim and lease — it simply stops claiming to be working.

Detection is deliberately narrow (`blockedReason` in `runtime/src/executor.ts`)
and applies **only to a run that failed**. This matters: exact-conversation mode
runs Claude in Plan Mode on purpose, and a plan is its result, not a blockage. A
successful run is never reported as blocked, so exact-conversation behaviour is
unchanged.

A false positive costs something real — a task stays claimed until its lease
expires — so the patterns match Claude Code asking for permission or an answer,
not any error containing the word "permission".

## What this does not do

- It does not stream. The executor is buffered (`--output-format json`), and
  nothing here needs token-by-token output.
- It does not write into the user's conversation, now or by any other route.
- It does not persist across a Runtime restart: the feed is in memory on the
  machine that did the work. The durable record is the task itself.
