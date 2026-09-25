/**
 * The one place the Runtime reads what `team_job_write` answers beyond the
 * ids it creates: owner notes, the owner's stop request, and the rule for the
 * model name the Runtime reports. If the server's field names change, this
 * file changes and nothing else does.
 *
 * Everything here is network input. It is parsed field by field; anything
 * malformed is dropped (a note) or ignored (a stop flag that is not a string),
 * never guessed at.
 */

import type { AgentProvider } from "./types.ts";

/** Who an owner note is addressed to. `team` (or no audience) means every agent. */
export type NoteAudience = AgentProvider | "team";

export type OwnerNote = {
  id: string;
  audience: NoteAudience;
  body: string;
  createdAt: string | null;
};

/** The op the orchestrator sends to collect undelivered owner notes. */
export const READ_OWNER_NOTES_OP = "read_owner_notes";

const NOTE_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 4_000;

/** `modelObserved` as the server accepts it (collaboration-chat.md §3). */
export const MODEL_OBSERVED_PATTERN = /^[A-Za-z0-9._:[\]/-]{1,100}$/;

/** The model to report on a message, or undefined when it is unknown or unreportable. */
export function modelObserved(value: string | null | undefined): string | undefined {
  return typeof value === "string" && MODEL_OBSERVED_PATTERN.test(value) ? value : undefined;
}

/**
 * Notes from a `read_owner_notes` answer: `{ ownerNotes: [{ id, seq, audience,
 * body, createdAt }] }` (lib/team/client-api.ts; `notes` is accepted as the
 * same list). A note with a missing id or body, or an audience that is not a
 * known agent, `team` or null, is dropped.
 */
export function parseOwnerNotes(answer: unknown): OwnerNote[] {
  if (!answer || typeof answer !== "object") return [];
  const a = answer as Record<string, unknown>;
  const raw = a.ownerNotes ?? a.notes;
  if (!Array.isArray(raw)) return [];
  const notes: OwnerNote[] = [];
  for (const item of raw.slice(0, MAX_NOTES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== "string" || !NOTE_ID.test(n.id)) continue;
    if (typeof n.body !== "string" || !n.body.trim()) continue;
    let audience: NoteAudience;
    if (n.audience === null || n.audience === undefined || n.audience === "team") audience = "team";
    else if (n.audience === "claude-code" || n.audience === "codex") audience = n.audience;
    else continue;
    notes.push({
      id: n.id,
      audience,
      body: n.body.slice(0, MAX_NOTE_CHARS),
      createdAt: typeof n.createdAt === "string" ? n.createdAt.slice(0, 40) : null,
    });
  }
  return notes;
}

/**
 * True when a job state answer says the owner asked the job to stop. The
 * server sends `stopRequestedAt` as an ISO timestamp or null.
 */
export function stopRequested(answer: unknown): boolean {
  if (!answer || typeof answer !== "object") return false;
  const value = (answer as Record<string, unknown>).stopRequestedAt;
  return typeof value === "string" && value.trim().length > 0;
}
