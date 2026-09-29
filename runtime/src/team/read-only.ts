/**
 * ThreadLink 0.11.1: the owner's explicit "do not change any files".
 *
 * A work job whose request says, in so many words, that nothing may be
 * changed is a READ-ONLY job (orchestrator.ts #runReadOnly): every agent runs
 * read-only, findings are reported but never fixed, nothing is committed,
 * recorded as a code change or integrated.
 *
 * The detector is deliberately conservative and table-driven. It triggers only
 * on an instruction addressed to the agents -- at the start of a sentence or
 * clause, or after "please/and/but/just/also" -- whose object is files, code,
 * the repository or "anything". A negation about something else ("do not
 * change the public API", "make sure users do not modify files") or a scoped
 * one ("don't change anything else", "no files outside src/") does not
 * trigger it: that is an ordinary work request with a constraint.
 */

/** Where an instruction to the agents can start: a sentence/clause start, or a joining word. */
const LEAD = String.raw`(?:^|[.!?;:,\n(]\s*|\b(?:please|and|but|just|also|so|then|however)\s+)`;
const NEG = String.raw`(?:do\s+not|don['’]t|never|you\s+must\s+not|must\s+not|you\s+may\s+not)`;
const VERB = String.raw`(?:make\s+any\s+changes\s+to|make\s+changes\s+to|change|edit|modify|touch|write\s+to|write|alter|commit\s+to|commit)`;
const OBJECT = String.raw`(?:(?:any|the|a\s+single|my|our|these|those|project|repo)\s+)?(?:files?|code|source(?:\s+code)?|repo(?:sitory)?|codebase|anything|a\s+thing)`;
/**
 * A scoped constraint ("anything else", "files outside src/", "the code in
 * auth.ts") is not a read-only request: the owner wants a change, a limited one.
 */
const TAIL = String.raw`(?!\s*(?:else|other|outside|except|besides|apart|beyond|unrelated|in|under|within|inside|for|of|that|which|related|but|than)\b)`;
const GERUND = String.raw`(?:changing|editing|modifying|touching|writing(?:\s+to)?|altering)`;

export type ReadOnlyRule = { id: string; pattern: RegExp };

export const READ_ONLY_RULES: readonly ReadOnlyRule[] = [
  // "Do not change any files." / "…, but don't edit the code." / "Never touch the repo."
  {
    id: "negated_change",
    pattern: new RegExp(`${LEAD}${NEG}\\s+${VERB}\\s+${OBJECT}\\b${TAIL}`, "i"),
  },
  // "Don't make any changes." / "Do not make changes."
  {
    id: "negated_make_changes",
    pattern: new RegExp(
      `${LEAD}${NEG}\\s+make\\s+(?:any\\s+)?(?:code\\s+|file\\s+)?changes\\b${TAIL}`,
      "i",
    ),
  },
  // "Review the auth code without changing any files / anything."
  {
    id: "without_changing",
    pattern: new RegExp(
      `\\bwithout\\s+(?:making\\s+any\\s+changes|${GERUND}\\s+${OBJECT})\\b${TAIL}`,
      "i",
    ),
  },
  // "Read-only review of …", "This is read-only.", "Keep it read-only", "Read-only:"
  {
    id: "read_only_mode",
    pattern: new RegExp(
      String.raw`(?:${LEAD}read[- ]only\s*[:.,!]|\b(?:keep\s+it|stay|remain|work|this\s+is|it\s+is|be|do\s+(?:this|it))\s+read[- ]only\b(?!\s+(?:file|files|flag|property|attribute|field|access|mode\s+bug))|\bread[- ]only\s+(?:review|pass|audit|analysis|check|investigation|run|job|task)\b)`,
      "i",
    ),
  },
  // "No changes." / "No code changes, please." as its own sentence; "make no changes".
  {
    id: "no_changes",
    pattern: new RegExp(
      String.raw`(?:(?:^|[.!?;\n]\s*)no\s+(?:code\s+|file\s+)?changes(?:\s*,?\s*please)?\s*(?:[.!]|$)|\bmake\s+no\s+(?:code\s+|file\s+)?changes\b)`,
      "i",
    ),
  },
];

/** The rule that matched, or null. For tests and the job's evidence. */
export function readOnlyRule(goal: string): string | null {
  const text = goal.replace(/\s+/g, " ").trim();
  for (const rule of READ_ONLY_RULES) if (rule.pattern.test(text)) return rule.id;
  return null;
}

/** True when the owner's request explicitly forbids changing files (0.11.1). */
export function isReadOnlyRequest(goal: string): boolean {
  return readOnlyRule(goal) !== null;
}
