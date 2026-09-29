/**
 * ThreadLink 0.11 execution-lane classifier (docs/design/threadlink-0.11.md
 * section 2.4). PURE: no I/O, no imports beyond types, deterministic.
 *
 * Decides whether an owner message is a conversation (Fast Chat: the agents
 * answer read-only, concurrently) or a request for repository work (the full
 * engineering pipeline). The server re-checks nothing about the wording; it
 * only enforces what a lane may do. When unsure, the answer is CHAT: a chat
 * answer changes nothing, and an agent can offer to run it as work (2.5).
 *
 * Rules, in order:
 *   1. an explicit choice (composer toggle, or a leading /chat or /work that
 *      is stripped from the stored body)          -> explicit_chat / explicit_work
 *   2. a negation of acting ("don't change anything", "without editing",
 *      "do not run") forces chat                   -> negated
 *   3. greeting / thanks / acknowledgement only    -> small_talk (chat)
 *   4. a bare "continue" / "go on" / "resume"      -> continuation (chat)
 *   5. a clause that asks for a repository ACTION: an imperative (also polite:
 *      "can you fix", "please run", "go ahead and implement", "okay, inspect
 *      the repo and fix ...") whose object is code / repo / tests / files /
 *      a feature / a bug (strong verbs like fix, implement, refactor need no
 *      object)                                     -> edit_requested /
 *                                                     tests_requested /
 *                                                     repo_action
 *   6. "review / inspect / audit the whole repo / codebase / <project>"
 *                                                  -> repo_review (work)
 *   7. status questions                            -> status (chat)
 *   8. questions                                   -> question (chat)
 *   9. opinions, explanations, discussion          -> discussion (chat)
 *  10. anything else                               -> default_chat
 */
import type { ExecutionLane, IntentResult, JobMode, LaneReason } from "./types";

export type ClassifyInput = {
  body: string;
  /** The composer's setting: "chat" / "work" force the lane; null / "auto" classify. */
  explicit?: "chat" | "work" | "auto" | null;
  /** Whether engineering work is running in this chat now. */
  activeWorkJob: boolean;
  mode: JobMode;
};

const LANE_PREFIX = /^\s*\/(chat|work)(?=\s|$)\s*/i;

/** Removes a leading "/chat" or "/work" and says which it was. */
export function stripLanePrefix(body: string): { body: string; explicit: "chat" | "work" | null } {
  const m = LANE_PREFIX.exec(body);
  if (!m) return { body, explicit: null };
  return { body: body.slice(m[0].length), explicit: m[1]!.toLowerCase() as "chat" | "work" };
}

// A leading run of @mentions ("@Claude", "@team", "@claude-code,").
const LEADING_MENTIONS = /^(\s*@[a-z][a-z0-9-]*[\s,:;.!]*)+/i;

// Filler and politeness in front of the request ("okay, can you please ...").
const FILLER = new Set([
  "ok",
  "okay",
  "alright",
  "all",
  "right",
  "so",
  "well",
  "now",
  "then",
  "hey",
  "hi",
  "hello",
  "yo",
  "team",
  "guys",
  "folks",
  "please",
  "pls",
  "plz",
  "kindly",
  "just",
  "also",
  "and",
  "first",
  "next",
  "finally",
  "great",
  "cool",
  "thanks",
  "lets",
  "let's",
]);
const POLITE_PREFIXES = [
  "can you",
  "could you",
  "would you",
  "will you",
  "can u",
  "could u",
  "can we",
  "could we",
  "shall we",
  "would you mind",
  "do you mind",
  "i want you to",
  "i'd like you to",
  "i would like you to",
  "i need you to",
  "we need to",
  "i want to",
  "we should",
  "you should",
  "go ahead and",
  "go and",
  "try to",
  "please go ahead and",
  "make sure to",
  "be sure to",
  "remember to",
  "don't forget to",
  "dont forget to",
  "time to",
];

// Verbs that always mean changing the repository (no object needed).
const STRONG_EDIT = new Set([
  "fix",
  "implement",
  "refactor",
  "rename",
  "migrate",
  "upgrade",
  "patch",
  "rewrite",
  "debug",
  "resolve",
  "reimplement",
  "scaffold",
  "bootstrap",
  "port",
  "optimize",
  "optimise",
]);
// Verbs that change the repository when their object is code-shaped.
const WEAK_EDIT = new Set([
  "add",
  "build",
  "create",
  "write",
  "change",
  "edit",
  "remove",
  "delete",
  "update",
  "modify",
  "make",
  "bump",
  "install",
  "configure",
  "set",
  "setup",
  "clean",
  "move",
  "replace",
  "extract",
  "split",
  "wire",
  "hook",
  "enable",
  "disable",
  "introduce",
  "drop",
  "document",
  "improve",
  "harden",
  "apply",
]);
const TEST_VERBS = new Set(["run", "test", "lint", "typecheck", "execute", "rerun", "re-run"]);
const REPO_ACTION = new Set([
  "deploy",
  "release",
  "commit",
  "merge",
  "integrate",
  "push",
  "ship",
  "publish",
  "rebase",
  "tag",
]);
const REVIEW_VERBS = new Set([
  "review",
  "inspect",
  "audit",
  "analyze",
  "analyse",
  "scan",
  "check",
  "examine",
  "go",
]);

// Objects that are about code, the repository, tests, files, a feature or a bug.
const CODE_NOUNS = new Set([
  "bug",
  "bugs",
  "issue",
  "issues",
  "error",
  "errors",
  "crash",
  "crashes",
  "regression",
  "test",
  "tests",
  "spec",
  "specs",
  "suite",
  "code",
  "codebase",
  "repo",
  "repository",
  "project",
  "file",
  "files",
  "function",
  "functions",
  "method",
  "methods",
  "class",
  "classes",
  "module",
  "modules",
  "component",
  "components",
  "endpoint",
  "endpoints",
  "api",
  "route",
  "routes",
  "page",
  "pages",
  "screen",
  "button",
  "form",
  "feature",
  "features",
  "branch",
  "pr",
  "migration",
  "migrations",
  "schema",
  "database",
  "db",
  "table",
  "column",
  "index",
  "script",
  "scripts",
  "config",
  "configuration",
  "dependency",
  "dependencies",
  "deps",
  "package",
  "packages",
  "build",
  "ci",
  "pipeline",
  "lint",
  "linter",
  "types",
  "type",
  "login",
  "auth",
  "authentication",
  "authorization",
  "session",
  "sessions",
  "ui",
  "css",
  "style",
  "styles",
  "layout",
  "readme",
  "changelog",
  "docs",
  "handler",
  "service",
  "query",
  "queries",
  "model",
  "models",
  "controller",
  "middleware",
  "validation",
  "logging",
  "logs",
  "cache",
  "parser",
  "lexer",
  "tokenizer",
  "cli",
  "flag",
  "flags",
  "check",
  "checks",
  "hook",
  "hooks",
  "workflow",
  "dockerfile",
  "makefile",
  "version",
  "export",
  "import",
  "rate",
  "limit",
  "limiting",
  "security",
  "vulnerability",
  "vulnerabilities",
  "leak",
  "leaks",
  "it",
  "them",
  "this",
  "that",
  "these",
  "those",
]);
// Words that make a phrase about talk, not code ("the plan", "an idea").
const TALK_NOUNS = new Set([
  "plan",
  "idea",
  "ideas",
  "finding",
  "findings",
  "proposal",
  "opinion",
  "thoughts",
  "summary",
  "answer",
  "question",
  "questions",
  "explanation",
  "poem",
  "story",
  "joke",
  "message",
  "note",
  "point",
  "argument",
  "approach",
  "decision",
  "tradeoff",
  "tradeoffs",
  "options",
]);

const REPO_WORDS = new Set([
  "repo",
  "repository",
  "codebase",
  "project",
  "code",
  "monorepo",
  "app",
  "application",
]);

const QUESTION_START = new Set([
  "what",
  "whats",
  "what's",
  "why",
  "how",
  "hows",
  "how's",
  "when",
  "where",
  "wheres",
  "where's",
  "who",
  "whom",
  "which",
  "is",
  "are",
  "was",
  "were",
  "does",
  "do",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "have",
  "has",
  "any",
  "anything",
]);
const DISCUSSION_START = new Set([
  "explain",
  "describe",
  "summarize",
  "summarise",
  "tell",
  "think",
  "consider",
  "compare",
  "discuss",
  "suggest",
  "recommend",
  "propose",
  "brainstorm",
  "evaluate",
  "assess",
  "clarify",
  "elaborate",
  "walk",
  "show",
  "list",
  "outline",
  "thoughts",
  "opinion",
  "i",
  "we",
  "my",
  "our",
  "maybe",
  "perhaps",
  "imo",
  "i'm",
  "im",
  "it's",
  "its",
  "this",
  "that",
]);

const SMALL_TALK = new Set([
  "hi",
  "hello",
  "hey",
  "heya",
  "hiya",
  "yo",
  "sup",
  "morning",
  "evening",
  "afternoon",
  "good",
  "night",
  "gm",
  "gn",
  "thanks",
  "thank",
  "you",
  "thx",
  "ty",
  "cheers",
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "great",
  "nice",
  "awesome",
  "perfect",
  "sweet",
  "lol",
  "haha",
  "bye",
  "goodbye",
  "later",
  "see",
  "ya",
  "team",
  "all",
  "everyone",
  "guys",
  "folks",
  "there",
  "again",
  "so",
  "much",
  "a",
  "lot",
  "welcome",
  "got",
  "it",
  "understood",
  "noted",
  "sounds",
  "well",
  "done",
  "job",
  "yes",
  "yep",
  "yeah",
  "no",
  "nope",
  "sure",
  "how",
  "are",
  "doing",
  "whats",
  "what's",
  "up",
  "hows",
  "how's",
  "it",
  "going",
  "claude",
  "codex",
]);

const CONTINUATION =
  /^(continue|go on|keep going|carry on|resume|proceed|go ahead|next|and then|more|go)$/;
const STATUS =
  /^(status|progress|update|any updates?|how('s| is) it going|where are we( at)?|what('s| is) the status|what('s| is) happening|what are you (doing|working on)|are you (done|finished)|is it (done|finished)|how far (along )?are you|eta)\b/;

// "don't change anything", "without editing", "do not run", "no changes", "read-only".
const NEGATION =
  /\b(don'?t|do not|dont|never|without|no need to|not to|shouldn'?t|should not|must not|mustn'?t|avoid)\s+(?!forget\b)(\w+\s+){0,2}?(change|changing|edit|editing|modify|modifying|touch|touching|run|running|write|writing|commit|committing|fix|fixing|implement|implementing|apply|applying|push|pushing|deploy|deploying|make any|making any|alter|altering)\b|\bno (code )?changes\b|\bread[- ]only\b|\bjust (look|read|tell|explain|answer)\b/;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`"“”‘’()[\]{}<>*_~]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z0-9'@/-]+|[^a-z0-9'-]+$/g, ""))
    .filter((t) => t.length > 0);
}

function stripPolite(clause: string): string {
  let c = clause.trim();
  for (let guard = 0; guard < 6; guard++) {
    const before = c;
    const words = c.split(/\s+/);
    while (words.length > 1 && FILLER.has(words[0]!.replace(/[^a-z']/g, ""))) words.shift();
    c = words.join(" ");
    for (const p of POLITE_PREFIXES) {
      if (c === p) return "";
      if (c.startsWith(p + " ")) {
        c = c.slice(p.length + 1).trim();
        break;
      }
    }
    if (c === before) break;
  }
  return c;
}

type ClauseKind = "edit" | "tests" | "repo_action" | "repo_review" | null;

function hasCodeObject(words: string[]): boolean {
  let code = false;
  let talk = false;
  for (const w of words) {
    const bare = w.replace(/'s$/, "");
    if (TALK_NOUNS.has(bare)) talk = true;
    if (CODE_NOUNS.has(bare)) code = true;
    // A path, a file name or a code-ish identifier is code.
    if (
      /[/\\]|\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|sql|json|ya?ml|toml|md|css|html|sh)$/.test(w)
    )
      code = true;
    if (/^[a-z]+[A-Z]|[a-z]_[a-z]|\(\)$/.test(w)) code = true;
  }
  // "the plan", "this finding": talk wins over a generic pronoun.
  if (
    talk &&
    !words.some(
      (w) => CODE_NOUNS.has(w) && !["it", "them", "this", "that", "these", "those"].includes(w),
    )
  )
    return false;
  return code;
}

function mentionsWholeRepo(words: string[]): boolean {
  const text = words.join(" ");
  if (
    /\b(whole|entire|full|complete|all of the|all the)\b/.test(text) &&
    words.some((w) => REPO_WORDS.has(w))
  )
    return true;
  if (/\b(the|this|our|my|your) (repo|repository|codebase|monorepo)\b/.test(text)) return true;
  // "<Name> repo", "the Prism codebase"
  if (/\b[a-z0-9-]+ (repo|repository|codebase)\b/.test(text)) return true;
  if (/^(the )?(repo|repository|codebase)\b/.test(text)) return true;
  return false;
}

function classifyClause(raw: string): ClauseKind {
  const clause = stripPolite(raw.toLowerCase());
  if (!clause) return null;
  const words = tokens(clause);
  if (words.length === 0) return null;
  const verb = words[0]!;
  const rest = words.slice(1);

  // "make it pass", "make the tests pass / work / green"
  if (
    verb === "make" &&
    /\b(pass|passes|work|works|green|compile|compiles|build)\b/.test(rest.join(" "))
  ) {
    return /\btests?\b/.test(rest.join(" ")) ? "tests" : "edit";
  }
  // "set up X", "clean up X", "wire up X": the particle is not the object.
  const objectWords = ["up", "out", "in", "on", "off", "over"].includes(rest[0] ?? "")
    ? rest.slice(1)
    : rest;

  if (TEST_VERBS.has(verb)) {
    const obj = objectWords.join(" ");
    if (verb === "test" || verb === "lint" || verb === "typecheck") {
      return objectWords.length === 0 || hasCodeObject(objectWords) || /\bflow\b/.test(obj)
        ? "tests"
        : null;
    }
    if (
      /\b(tests?|specs?|suite|lint|linter|typecheck|type check|checks?|ci|e2e|build|migrations?|script|npm|pnpm|yarn|pytest|vitest|jest|cargo|make|go test)\b/.test(
        obj,
      )
    )
      return "tests";
    if (hasCodeObject(objectWords)) return "tests";
    return null;
  }
  if (REPO_ACTION.has(verb)) return "repo_action";
  if (STRONG_EDIT.has(verb)) {
    // "fix my understanding" is rare; a strong verb is work unless its object is talk.
    return objectWords.length > 0 &&
      !hasCodeObject(objectWords) &&
      objectWords.some((w) => TALK_NOUNS.has(w))
      ? null
      : "edit";
  }
  if (WEAK_EDIT.has(verb)) {
    return hasCodeObject(objectWords) ? "edit" : null;
  }
  if (REVIEW_VERBS.has(verb)) {
    // "go through the whole repo", "security review of the repo"
    const obj =
      verb === "go"
        ? rest[0] === "through" || rest[0] === "over"
          ? rest.slice(1)
          : []
        : objectWords;
    return obj.length > 0 && mentionsWholeRepo(obj) ? "repo_review" : null;
  }
  // Noun phrase: "a security review of the repo", "full audit of the codebase".
  if (/\b(review|audit|inspection|scan|pass)\s+of\s+/.test(clause) && mentionsWholeRepo(words))
    return "repo_review";
  return null;
}

function splitClauses(text: string): string[] {
  return text
    .split(
      /[,;\n]+|\.(?=\s|$)|\s+(?:and then|then|and also|and|after that|afterwards|also|plus)\s+/i,
    )
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

const WORK_PRIORITY: ClauseKind[] = ["edit", "tests", "repo_action", "repo_review"];
const WORK_REASON: Record<Exclude<ClauseKind, null>, LaneReason> = {
  edit: "edit_requested",
  tests: "tests_requested",
  repo_action: "repo_action",
  repo_review: "repo_review",
};

function result(
  lane: ExecutionLane,
  reason: LaneReason,
  body: string,
  smallTalk = false,
): IntentResult {
  return { lane, reason, smallTalk, body };
}

export function classifyIntent(input: ClassifyInput): IntentResult {
  const stripped = stripLanePrefix(input.body ?? "");
  const body = stripped.explicit ? stripped.body : (input.body ?? "");
  const explicit =
    stripped.explicit ??
    (input.explicit === "chat" || input.explicit === "work" ? input.explicit : null);

  const text = body.replace(LEADING_MENTIONS, "").trim();
  const lower = text.toLowerCase();
  const words = tokens(lower);
  const isSmallTalk =
    words.length > 0 &&
    words.length <= 6 &&
    words.every((w) => SMALL_TALK.has(w.replace(/[^a-z']/g, "")) || /^[^a-z0-9]+$/.test(w));

  if (explicit === "chat") return result("chat", "explicit_chat", body, isSmallTalk);
  if (explicit === "work") return result("work", "explicit_work", body);

  if (words.length === 0)
    return result("chat", isSmallTalk ? "small_talk" : "default_chat", body, isSmallTalk);
  if (NEGATION.test(lower)) return result("chat", "negated", body);
  if (isSmallTalk) return result("chat", "small_talk", body, true);

  const bare = lower.replace(/[.!?…]+$/g, "").trim();
  if (CONTINUATION.test(bare)) return result("chat", "continuation", body);

  // A repository action in any clause makes it work (polite forms included).
  const kinds = splitClauses(lower).map(classifyClause);
  for (const k of WORK_PRIORITY) {
    if (k && kinds.includes(k)) return result("work", WORK_REASON[k], body);
  }

  const first = words[0]!;
  if (STATUS.test(bare)) return result("chat", "status", body);
  if (/\?\s*$/.test(lower) || QUESTION_START.has(first)) return result("chat", "question", body);
  if (
    DISCUSSION_START.has(first) ||
    REVIEW_VERBS.has(first) ||
    /\b(what do you think|thoughts on|your opinion|pros and cons)\b/.test(lower)
  )
    return result("chat", "discussion", body);
  return result("chat", "default_chat", body);
}
