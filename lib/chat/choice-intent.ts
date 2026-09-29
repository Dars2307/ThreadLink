/**
 * ThreadLink 0.11 natural choice answers (docs/design/threadlink-0.11.md
 * section 6). PURE: no I/O, no imports beyond types, deterministic.
 *
 * When a chat has an open choice, an owner message (web / desktop / terminal;
 * never a controller) that CLEARLY answers it resolves it; the message is
 * stored normally and no new job starts. The server re-checks the choice
 * (pending, this chat, this owner, a real option, never an approval kind).
 *
 *   "@Claude continue", "use Claude", "continue with Claude", "switch to
 *   Claude", "let Claude do it"      -> the option naming Claude
 *                                       (use_other / retry_other / continue_other)
 *   "stop", "cancel", "stop the job" -> stop
 *   "retry", "retry Codex", "try again" -> retry if offered; for
 *                                       usage_exhausted -> check_again
 *   "wait", "wait for Codex"         -> wait
 *   "continue", "resume"             -> resume (interrupted)
 *   "run it", "go ahead", "do it"    -> run_work (start_work)
 *   "keep chatting", "no"            -> keep_chatting (start_work)
 * Approval kinds are never answered by typing. Anything ambiguous -> null (the
 * message routes normally and ThreadLink adds nothing).
 */
import type { ChoiceForMatch, ChoiceKind } from "./types";

export type ChoiceMatch = { choiceId: string; key: string; label: string };

const APPROVALS: ReadonlySet<ChoiceKind> = new Set<ChoiceKind>([
  "migration",
  "production_deploy",
  "destructive_action",
  "security_action",
  "paid_usage",
  "permission_expansion",
  "secret_change",
]);

/** Names people type for each provider (registry aliases + display names). */
const PROVIDER_NAMES: Record<string, string[]> = {
  "claude-code": ["claude code", "claude-code", "claudecode", "claude"],
  codex: ["codex", "openai codex"],
  cursor: ["cursor"],
  windsurf: ["windsurf"],
  "gemini-cli": ["gemini cli", "gemini-cli", "gemini"],
};

function namesOf(provider: string | null | undefined): string[] {
  if (!provider) return [];
  return PROVIDER_NAMES[provider] ?? [provider];
}

/** Lower-case, one line, no trailing punctuation, leading "@" kept as a word. */
function normalise(body: string): string {
  return body
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[\s ]+/g, " ")
    .replace(/^[\s,.;:!]+|[\s,.;:!?…]+$/g, "")
    .replace(/^(ok|okay|alright|please|pls|yes|sure),?\s+(?=\S)/, "")
    .replace(/\s+please$/, "")
    .trim();
}

/** Which provider a phrase names (longest alias first), or null. */
function providerIn(text: string, candidates: (string | null | undefined)[]): string | null {
  let best: { id: string; len: number } | null = null;
  for (const id of candidates) {
    if (!id) continue;
    for (const name of namesOf(id)) {
      const re = new RegExp(`(^|[^a-z0-9-])@?${name.replace(/[-]/g, "[- ]?")}($|[^a-z0-9-])`);
      if (re.test(text) && (!best || name.length > best.len)) best = { id, len: name.length };
    }
  }
  return best?.id ?? null;
}

function option(choice: ChoiceForMatch, ...keys: string[]): ChoiceMatch | null {
  for (const key of keys) {
    const o = choice.options.find((x) => x.key === key);
    if (o) return { choiceId: choice.choiceId, key: o.key, label: o.label };
  }
  return null;
}

// "{name}" is replaced by a provider-name group.
const USE_OTHER_PATTERNS = [
  "@?{name} continue",
  "@?{name},? (please )?(continue|take over|take it|do it|go ahead|go|finish( it)?)",
  "(use|try|pick|choose|go with|switch to|let|have|ask|give it to|hand it to|hand over to|continue with|carry on with|move to|fall back to) @?{name}( instead)?( do it| take over| continue| finish( it)?)?( instead)?( then)?",
  "@?{name} instead",
  "@?{name} (can|should) (do|take|finish) (it|this|over)",
  "(retry|try again) with @?{name}",
];

const WORD_LIMIT = 10;

export function matchChoiceAnswer(body: string, choice: ChoiceForMatch): ChoiceMatch | null {
  if (
    !choice ||
    APPROVALS.has(choice.kind) ||
    !Array.isArray(choice.options) ||
    choice.options.length === 0
  )
    return null;
  const text = normalise(body ?? "");
  if (!text || text.split(" ").length > WORD_LIMIT) return null;
  const kind = choice.kind;
  const exhausted = choice.providerHealth === "usage_exhausted";

  // A provider named in the answer: the alternative, or the one the choice is about.
  const named = providerIn(text, [choice.otherProvider, choice.provider]);
  if (named) {
    const nameGroup = `(${namesOf(named)
      .map((n) => n.replace(/[-]/g, "[- ]?"))
      .join("|")})`;
    const direct = USE_OTHER_PATTERNS.some((p) =>
      new RegExp(`^${p.replaceAll("{name}", nameGroup)}$`).test(text),
    );
    const retryNamed = new RegExp(
      `^(retry|try) @?${nameGroup}( again)?$|^@?${nameGroup},? (retry|try again)$`,
    ).test(text);
    const checkNamed = new RegExp(`^(check|recheck) @?${nameGroup}( again)?$`).test(text);
    const waitNamed = new RegExp(
      `^(let'?s |we can |i'?ll |just )?wait( for @?${nameGroup})?$|^wait for @?${nameGroup}( to (come back|reset|recover))?$`,
    ).test(text);
    const planNamed = new RegExp(`^(go with |use |accept |pick )?@?${nameGroup}'?s plan$`).test(
      text,
    );

    if (waitNamed) return option(choice, "wait");
    if (checkNamed) return option(choice, "check_again");
    if (planNamed && kind === "plan_disagreement") {
      return named === choice.otherProvider
        ? option(choice, "accept_other")
        : option(choice, "accept_proposal");
    }
    if (named === choice.otherProvider && choice.otherProvider !== choice.provider) {
      if (direct || retryNamed)
        return option(choice, "use_other", "retry_other", "continue_other", "accept_other");
      return null;
    }
    if (named === choice.provider) {
      // Retrying the same agent: never while its usage is exhausted.
      if (retryNamed || (direct && /continue|try|go|do it|take/.test(text))) {
        if (kind === "usage_exhausted") return option(choice, "check_again");
        if (exhausted) return null;
        return option(choice, "retry");
      }
      return null;
    }
    return null;
  }

  if (
    /^(stop|cancel|abort|stop (it|this|the job|the work|everything|now)|cancel (it|this|the job|the work)|(please )?stop (working|there))$/.test(
      text,
    )
  )
    return option(choice, "stop");
  if (
    /^(retry|try again|retry (it|that|this|the step)|try (it|that) again|one more try|again)$/.test(
      text,
    )
  ) {
    if (kind === "usage_exhausted") return option(choice, "check_again");
    if (exhausted) return null;
    return option(choice, "retry");
  }
  if (/^(check again|recheck|re-check|check (it|usage) again)$/.test(text))
    return option(choice, "check_again");
  if (/^(let'?s |we can |i'?ll |just )?wait( a bit| for it| for now)?$/.test(text))
    return option(choice, "wait");
  if (
    /^(give it more time|more time|wait longer|increase (the )?timeout|extend (the )?timeout)$/.test(
      text,
    )
  )
    return option(choice, "increase_timeout");
  if (
    /^(one more round|another round|(allow )?(one )?(more|another|extra) (planning )?round)$/.test(
      text,
    )
  )
    return option(choice, "extra_round");

  if (
    kind === "interrupted" &&
    /^(continue|resume|go on|carry on|pick (it )?up again|resume (it|the work))$/.test(text)
  )
    return option(choice, "resume");

  if (kind === "start_work") {
    if (
      /^(run it|run this|run it as work|run this as work|go ahead|go for it|do it|yes( do it)?|yep|yeah|start( it)?|start the work|make it so|ship it|let'?s do it)$/.test(
        text,
      )
    )
      return option(choice, "run_work");
    if (
      /^(keep chatting|just chat|no|nope|no thanks|not now|not yet|don'?t|let'?s keep chatting|keep talking)$/.test(
        text,
      )
    )
      return option(choice, "keep_chatting");
  }
  return null;
}

/**
 * The open choice a message answers: the chat's open choices are tried
 * newest first; the first clear match wins. Approval kinds never match.
 */
export function matchOpenChoices(body: string, choices: ChoiceForMatch[]): ChoiceMatch | null {
  for (const c of choices) {
    const m = matchChoiceAnswer(body, c);
    if (m) return m;
  }
  return null;
}
