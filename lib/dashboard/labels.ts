import type { AgentProvider, JobStatus, JobVerdict, UsagePolicy } from "@/lib/team/model";

/**
 * Plain-language labels for Team Mode concepts. Pure and dependency-free so the
 * page models (and their tests) can use them. Nothing here ever returns a raw
 * ThreadLink identifier.
 */

export type Tone = "success" | "warning" | "danger" | "neutral" | "accent";

// ---------------------------------------------------------------------------
// Providers, roles, models, effort
// ---------------------------------------------------------------------------

/** "claude-code" or the server's short name "Claude" → the product the user knows. */
export function providerProductName(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "claude-code" || p === "claude") return "Claude Code";
  if (p === "codex") return "Codex";
  if (p === "threadlink") return "ThreadLink";
  return "Agent";
}

/** Short name used in "Claude + Codex". */
export function providerShortName(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "claude-code" || p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  return "ThreadLink";
}

/** Canonical provider key for either spelling. */
export function providerKey(provider: string): AgentProvider | null {
  const p = provider.toLowerCase();
  if (p === "claude-code" || p === "claude") return "claude-code";
  if (p === "codex") return "codex";
  return null;
}

/** Providers in a stable order, joined the way people say it: "Claude + Codex". */
export function teamLabel(providers: Iterable<string>): string {
  const keys = new Set<AgentProvider>();
  for (const p of providers) {
    const k = providerKey(p);
    if (k) keys.add(k);
  }
  const ordered = (["claude-code", "codex"] as const).filter((k) => keys.has(k));
  return ordered.length ? ordered.map(providerShortName).join(" + ") : "No agents yet";
}

const ROLE_LABELS: Record<string, string> = {
  coordinator: "Coordinator",
  planner: "Planner",
  builder: "Builder",
  reviewer: "Reviewer",
  security_reviewer: "Security reviewer",
  test_reviewer: "Test reviewer",
  integrator: "Integrator",
  investigator: "Investigator",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? humanize(role);
}

/** Display names the Runtime's discovery already knows (runtime/src/team/discovery.ts). */
export const KNOWN_MODEL_NAMES: Readonly<Record<string, string>> = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
  haiku: "Claude Haiku",
  fable: "Claude Fable",
};

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * A model's human name. A catalogue name (from discovery) wins; then the known
 * table; then a conservative formatter for the two naming schemes we see
 * (claude-<family>-<major>[-<minor>][-<date>] and gpt-<version>[-<suffix>]).
 * Unknown shapes fall back to the id itself: better honest than invented.
 */
export function modelDisplayName(
  id: string | null | undefined,
  catalog?: Readonly<Record<string, string>>,
): string {
  if (!id) return "Model not reported yet";
  const fromCatalog = catalog?.[id];
  if (fromCatalog) return fromCatalog;
  const known = KNOWN_MODEL_NAMES[id] ?? KNOWN_MODEL_NAMES[id.toLowerCase()];
  if (known) return known;

  const bare = id.toLowerCase().replace(/-\d{8}$/, "");
  const claudeNew = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(bare);
  if (claudeNew) {
    const [, family, major, minor] = claudeNew;
    return `Claude ${cap(family!)} ${major}${minor ? `.${minor}` : ""}`;
  }
  const claudeOld = /^claude-(\d+)(?:-(\d+))?-([a-z]+)$/.exec(bare);
  if (claudeOld) {
    const [, major, minor, family] = claudeOld;
    return `Claude ${major}${minor ? `.${minor}` : ""} ${cap(family!)}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z0-9]+)*)$/.exec(bare);
  if (gpt) {
    const [, version, rest] = gpt;
    const words = (rest ?? "").split("-").filter(Boolean).map(cap);
    return [`GPT-${version}`, ...words].join(" ");
  }
  return id;
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal effort",
  low: "Low effort",
  medium: "Medium effort",
  high: "High effort",
  xhigh: "Extra-high effort",
  max: "Maximum effort",
};

export function effortLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  return EFFORT_LABELS[effort.toLowerCase()] ?? `${humanize(effort)} effort`;
}

// ---------------------------------------------------------------------------
// Jobs, verdicts, nodes, findings
// ---------------------------------------------------------------------------

export const VERDICT_LABELS: Record<JobVerdict, string> = {
  PASS: "Passed final review",
  NEEDS_FIX: "Needs fixes",
  BLOCKED: "Blocked",
  NEEDS_USER_DECISION: "Needs your decision",
};

export const VERDICT_TONES: Record<JobVerdict, Tone> = {
  PASS: "success",
  NEEDS_FIX: "warning",
  BLOCKED: "danger",
  NEEDS_USER_DECISION: "warning",
};

export function verdictLabel(verdict: JobVerdict | null | undefined): string | null {
  return verdict ? VERDICT_LABELS[verdict] : null;
}

const JOB_LABELS: Record<JobStatus, string> = {
  queued: "Waiting for your device",
  normalising: "Understanding the goal",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  integrating: "Putting it together",
  inspecting: "Final review",
  completed: "Passed final review",
  needs_fix: "Needs fixes",
  blocked: "Blocked",
  needs_user_decision: "Needs your decision",
  failed: "Stopped",
  cancelled: "Cancelled",
};

const JOB_TONES: Record<JobStatus, Tone> = {
  queued: "neutral",
  normalising: "accent",
  planning: "accent",
  building: "accent",
  reviewing: "accent",
  integrating: "accent",
  inspecting: "accent",
  completed: "success",
  needs_fix: "warning",
  blocked: "danger",
  needs_user_decision: "warning",
  failed: "danger",
  cancelled: "neutral",
};

/** One status for a job: the verdict wins once there is one. */
export function jobState(
  status: JobStatus,
  verdict: JobVerdict | null,
): {
  label: string;
  tone: Tone;
} {
  if (verdict) return { label: VERDICT_LABELS[verdict], tone: VERDICT_TONES[verdict] };
  return { label: JOB_LABELS[status], tone: JOB_TONES[status] };
}

export const FINDING_SEVERITY_LABELS: Record<string, string> = {
  blocking: "BLOCKING",
  important: "IMPORTANT",
  non_blocking: "NON-BLOCKING",
};

export const FINDING_SEVERITY_TONES: Record<string, Tone> = {
  blocking: "danger",
  important: "warning",
  non_blocking: "neutral",
};

export const FINDING_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  resolved: "Resolved",
  wont_fix: "Won't fix",
};

export const FINDING_CATEGORY_LABELS: Record<string, string> = {
  correctness: "Correctness",
  security: "Security",
  architecture: "Architecture",
  edge_case: "Edge case",
  tests: "Tests",
  performance: "Performance",
  requirements: "Requirements",
};

export const OUTCOME_LABELS: Record<string, string> = {
  ok: "Completed",
  model_mismatch: "Stopped: a different model ran than was asked for",
  access_mismatch: "Stopped: file access did not match",
  quota_exhausted: "Stopped: included usage ran out",
  not_authenticated: "Stopped: not signed in",
  not_installed: "Stopped: not installed",
  timeout: "Stopped: took too long",
  provider_error: "Stopped: provider error",
};

// ---------------------------------------------------------------------------
// Plans and usage policy
// ---------------------------------------------------------------------------

export const CLAUDE_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  team: "Team",
  enterprise: "Enterprise",
  unknown: "Other / Unknown",
};

/** ChatGPT's business tiers are "Business", never "Team". */
export const CHATGPT_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  business_standard: "Business Standard",
  business_premium: "Business Premium",
  enterprise: "Enterprise",
  edu: "Edu",
  unknown: "Other / Unknown",
};

export function planLabels(provider: AgentProvider): Record<string, string> {
  return provider === "claude-code" ? CLAUDE_PLAN_LABELS : CHATGPT_PLAN_LABELS;
}

/** What a CLI reported ("max", "plus", "team" …) in the same words as the plan list. */
export function detectedPlanLabel(provider: AgentProvider, raw: string | null): string | null {
  if (!raw) return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (provider === "codex") {
    // ChatGPT renamed its Team plan to Business: never show "Team" for ChatGPT.
    if (key === "team" || key === "business") return "Business";
    return CHATGPT_PLAN_LABELS[key] ?? humanize(raw);
  }
  if (key === "max") return "Max";
  return CLAUDE_PLAN_LABELS[key] ?? humanize(raw);
}

export const USAGE_POLICY_TEXT: Record<UsagePolicy, { label: string; description: string }> = {
  conservative: {
    label: "Conservative",
    description: "Starts with lighter models and steps up only when a task needs it.",
  },
  balanced: {
    label: "Balanced",
    description: "Matches the model to each task and steps up for risky or failing work.",
  },
  maximum_quality: {
    label: "Maximum quality",
    description: "Uses the strongest models your plan includes for planning and reviews.",
  },
  manual: {
    label: "Manual",
    description: "Uses only the models you choose; ThreadLink never steps up on its own.",
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, " ").trim();
  return cap(s.toLowerCase());
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Guard used by tests and pages: does a string look like a ThreadLink id? */
export const THREADLINK_ID_PATTERN = /\btl[a-z]{2,5}_[A-Za-z0-9]/;
