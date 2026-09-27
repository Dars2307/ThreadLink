/**
 * Terminal-safe text. Everything the server sends (chat names, message bodies,
 * provider names) is untrusted: an agent's output could carry ANSI escapes
 * that move the cursor, rewrite earlier lines, change the window title or
 * hide text. It is reduced to printable text before it reaches the terminal.
 */

// CSI; OSC (BEL or ST terminated, or cut off); DCS/PM/APC strings; other
// two-byte ESC sequences; 8-bit CSI.
const ANSI = new RegExp(
  [
    "\\u001b\\[[0-?]*[ -\\/]*[@-~]",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?",
    "\\u001b[P^_][^\\u001b]*(?:\\u001b\\\\)?",
    "\\u001b[@-Z\\\\-_]",
    "\\u009b[0-?]*[ -\\/]*[@-~]",
  ].join("|"),
  "g",
);
// C0/C1 controls except \n and \t, plus DEL (ESC included: a stray one is dropped).
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
/** Bidi overrides/isolates and marks (Trojan Source): text must not reorder itself. */
const BIDI = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200e\\u200f\\u061c]", "g");

/** Printable text: no escape sequences, no control characters, "\n" newlines. */
export function safeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "").replace(BIDI, "");
}

/** One line: safeText with newlines and tabs folded to spaces, cut to `max`. */
export function safeLine(input: unknown, max = 120): string {
  const flat = safeText(input)
    .replace(/[\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** Bodies longer than this are collapsed in the terminal (the full text is in the web). */
export const BODY_MAX_LINES = 40;
export const BODY_MAX_CHARS = 4000;

/** A message body for the terminal: safe, indented, long ones collapsed with a note. */
export function safeBody(input: unknown, indent = "  "): string {
  let text = safeText(input).replace(/\t/g, "  ").trimEnd();
  let cut = false;
  if (text.length > BODY_MAX_CHARS) {
    text = text.slice(0, BODY_MAX_CHARS);
    cut = true;
  }
  let lines = text.split("\n");
  if (lines.length > BODY_MAX_LINES) {
    lines = lines.slice(0, BODY_MAX_LINES);
    cut = true;
  }
  const out = lines.map((l) => `${indent}${l}`);
  if (cut) out.push(`${indent}… (message shortened — open the chat on the web for the rest)`);
  return out.join("\n");
}
