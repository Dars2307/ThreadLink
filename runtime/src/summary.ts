/**
 * Safe, short summaries of a task result, for the mirrored activity feed.
 *
 * The feed exists because a background worker runs in a Claude conversation
 * the user cannot see. It is a status mirror, not a second copy of the work:
 * the full result stays in the ThreadLink task, behind the same authorization
 * as everything else, and only a short line comes here.
 *
 * "Short" is not the same as "safe", so the line is built by removing rather
 * than by selecting: code blocks go first (that is where keys and diffs live),
 * then anything that looks like a credential, then control characters, and
 * only what survives is used. If nothing survives, there is no summary -- an
 * empty line is a better outcome than a leaked one.
 */

/** How long a mirrored summary may be. Roughly one line in the app. */
export const SUMMARY_MAX_CHARS = 160;

/**
 * Things that must never be mirrored, matched on shape rather than on name so
 * an unknown provider's key is still caught. Deliberately broad: a false
 * positive costs a few redacted characters, a false negative costs a secret.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Provider keys: sk-..., sk-ant-..., ghp_..., xoxb-..., AKIA..., tlc_...
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9-_]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gi,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\btl[a-z]{1,4}_[0-9a-f]{16,}/gi,
  // JWTs and other dotted base64 triples.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bare high-entropy runs: long hex, or base64-ish blobs that actually mix
  // character classes. A long ordinary word is not a secret, and redacting it
  // would leave the user reading "[redacted]" for no reason.
  /\b[0-9a-f]{32,}\b/gi,
  /\b(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40,}={0,2}\b/g,
  // Credentials inside a URL: scheme://user:password@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  // key = value / key: value where the key names a secret, including prefixed
  // names such as DB_PASSWORD or MY_API_KEY (an underscore is a word character,
  // so a plain \b would miss them). The value runs to the end of the line:
  // "Authorization: Bearer <token>" is two words, and stopping at the first
  // would leave the token sitting there.
  /[A-Za-z0-9_]*(?:api[-_ ]?key|secret|token|password|passwd|pwd|bearer|authorization|credential)[A-Za-z0-9_]*\s*[:=]?\s*\S.*/gi,
  // Email addresses identify a person.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/**
 * Absolute paths can name a person and their machine; they are not summary
 * material. Windows paths with either slash, including folder names with
 * spaces (up to the end of the path's last segment), and home directories on
 * Unix-like systems wherever they appear -- a stack trace puts them in
 * brackets, not after a space.
 */
const PATH_PATTERNS: RegExp[] = [
  /\b[A-Za-z]:[\\/](?:[^\\/\r\n"'<>|?*()]+[\\/])*[^\\/\s"'<>|?*():]*/g,
  /(?<![A-Za-z0-9])\/(?:home|Users|root)\/[^\s"'()]+/g,
];

const REDACTED = "[redacted]";

/** Removes fenced and indented code, which is where results hide their payload. */
function withoutCode(text: string): string {
  const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  return withoutFences
    .split("\n")
    .filter((line) => !/^\s{4,}\S/.test(line) && !/^\s*[+-]{3}\s/.test(line))
    .join("\n");
}

/**
 * Source code, even one unfenced line of it, is not summary material: it is
 * where names, paths and secrets live, and a redacted fragment of it tells the
 * user nothing they can act on. Keywords are matched case-sensitively so
 * ordinary prose ("Export the report") is not mistaken for a declaration.
 */
function looksLikeCode(line: string): boolean {
  if (/\b(?:import|export|const|let|var|function|class|return|def|async|await)\b/.test(line)) {
    return true;
  }
  if (/[;{}]\s*$/.test(line) || /=>/.test(line)) return true;
  // A diff or a shell transcript.
  return /^[+-]\s|^\$\s|^>\s/.test(line);
}

function redact(text: string): string {
  let out = text;
  for (const pattern of [...SECRET_PATTERNS, ...PATH_PATTERNS])
    out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * A one-line summary of a result, or null when nothing safe is left.
 *
 * Only the first surviving line is used. A result's opening line is where an
 * agent says what it did; later lines are where it pastes what it did it to.
 */
export function summarize(result: string | null | undefined): string | null {
  if (!result) return null;
  const line = withoutCode(result)
    .split("\n")
    .map((l) =>
      redact(l)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim(),
    )
    // A markdown heading labels the result rather than describing it, so it
    // is skipped entirely; a list bullet just loses its marker.
    .filter((l) => !/^#{1,6}\s/.test(l))
    // The bullet goes before the code check: "- Renamed the binding" is a list
    // item, and a leading "-" would otherwise read as a diff line.
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .filter((l) => !looksLikeCode(l))
    .find((l) => l.length > 0 && l !== REDACTED);
  if (!line) return null;

  const collapsed = line.replace(/\s+/g, " ").trim();
  // A line that is mostly redaction is not telling the user anything, and the
  // little it does say is next to something we just decided to hide.
  if (collapsed.replace(/\[redacted\]/g, "").trim().length < 3) return null;
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd() + "…";
}

/** Longest body a team message or finding may carry after redaction. */
export const REDACTED_TEXT_MAX_CHARS = 8_000;

/**
 * Redacts a whole block of text for storage in the team log.
 *
 * Unlike `summarize`, this keeps the text's shape -- a review has to stay
 * readable -- but applies the same credential and path redaction line by line,
 * strips control characters other than newlines and tabs, and caps the length.
 * Code is kept, because a review that cannot quote code is useless; secrets in
 * it are still redacted.
 */
export function redactText(
  text: string | null | undefined,
  maxChars = REDACTED_TEXT_MAX_CHARS,
): string {
  if (!text) return "";
  const cleaned = text
    .split("\n")
    .map((line) => redact(line).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "))
    .join("\n");
  const capped = cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
  // The server limits bytes, not characters; text heavy in multi-byte
  // characters would otherwise pass here and be refused there.
  return capBytes(capped, maxChars);
}

function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = maxBytes - Buffer.byteLength("…", "utf8");
  let out = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  // A cut through a multi-byte character decodes as U+FFFD; drop it.
  out = out.replace(/�$/, "");
  return `${out}…`;
}
