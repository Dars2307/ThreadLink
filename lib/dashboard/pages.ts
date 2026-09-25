import { PLATFORM_LABELS, type Connection } from "@/lib/connections/model";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerProviderProfile } from "@/lib/providers/queries";
import type { OwnerRoom } from "@/lib/rooms/queries";
import { runtimeOnline, type OwnerRuntime, type OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import type { RecentTask } from "@/lib/tasks/queries";
import type { OwnerJobDetail, OwnerJobSummary } from "@/lib/team/queries";
import {
  TEAM_LIMITS,
  USAGE_POLICIES,
  type AgentProvider,
  type UsagePolicy,
} from "@/lib/team/model";

import {
  CHATGPT_PLAN_LABELS,
  CLAUDE_PLAN_LABELS,
  detectedPlanLabel,
  effortLabel,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_SEVERITY_TONES,
  FINDING_STATUS_LABELS,
  humanize,
  jobState,
  modelDisplayName,
  OUTCOME_LABELS,
  plural,
  providerKey,
  providerProductName,
  roleLabel,
  teamLabel,
  USAGE_POLICY_TEXT,
  verdictLabel,
  type Tone,
} from "./labels";
import {
  conversationMode,
  conversationName,
  deriveDashboard,
  executionModeLabel,
  folderName,
  relativeTime,
  taskStatus,
} from "./view-model";

/**
 * Page models for the redesigned dashboard. Pure (no I/O).
 *
 * Every page model is `{ view, handles }`:
 *  - `view` is everything a normal page renders. It never contains a raw
 *    ThreadLink identifier (tests assert this on the JSON of every view).
 *  - `handles` maps each item's opaque `key` to the identifiers an action form
 *    needs (hidden inputs only). Keys are positional ("p0", "c1") and carry no
 *    identifier themselves.
 * Only Settings → Advanced renders raw identifiers.
 */

export type Handles = Record<string, Record<string, string>>;
export type PageModel<V> = { view: V; handles: Handles };

class HandleBag {
  readonly handles: Handles = {};
  #n: Record<string, number> = {};
  add(prefix: string, ids: Record<string, string>): string {
    const n = (this.#n[prefix] = (this.#n[prefix] ?? -1) + 1);
    const key = `${prefix}${n}`;
    this.handles[key] = ids;
    return key;
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type AccountData = {
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  tasks: RecentTask[];
  runtimes: OwnerRuntime[];
  workspaces: OwnerWorkspace[];
  now: number;
};

/** A model run as the dashboard reads it. `effort` is shown when the server provides it. */
export type ModelRun = OwnerJobDetail["modelRuns"][number] & { effort?: string | null };
export type JobDetail = Omit<OwnerJobDetail, "modelRuns"> & { modelRuns: ModelRun[] };

export type TeamData = {
  rooms: OwnerRoom[];
  /** Jobs per room, newest first (lib/team listRoomJobsFor). */
  jobsByRoom: Record<string, OwnerJobSummary[]>;
  /** Details for the most relevant jobs (active and recent). */
  details: JobDetail[];
  profiles: OwnerProviderProfile[];
};

export const EMPTY_TEAM: TeamData = { rooms: [], jobsByRoom: {}, details: [], profiles: [] };

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "expired"]);
const DEFAULT_TEAM = "Claude + Codex";

type Job = OwnerJobSummary & { roomId: string; roomName: string };

function allJobs(team: TeamData): Job[] {
  const names = new Map(team.rooms.map((r) => [r.roomId, r.name]));
  return Object.entries(team.jobsByRoom)
    .flatMap(([roomId, jobs]) =>
      jobs.map((j) => ({ ...j, roomId, roomName: names.get(roomId) ?? "Project" })),
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

function detailsById(team: TeamData): Map<string, JobDetail> {
  return new Map(team.details.map((d) => [d.jobId, d]));
}

/** Which providers took part in a room, from its jobs; a new room has the default team. */
function roomTeam(roomId: string, team: TeamData, details: Map<string, JobDetail>): string {
  const providers = new Set<string>();
  for (const job of team.jobsByRoom[roomId] ?? []) {
    const d = details.get(job.jobId);
    if (!d) continue;
    for (const n of d.nodes) {
      providers.add(n.owner);
      if (n.reviewer) providers.add(n.reviewer);
    }
    for (const r of d.modelRuns) providers.add(r.provider);
  }
  // create_room always enrols Claude Code and Codex (room_agents); the list
  // read does not return them, so a room with no job detail shows that default.
  return providers.size ? teamLabel(providers) : DEFAULT_TEAM;
}

function reviewsPendingFor(detail: JobDetail | undefined, job: OwnerJobSummary): number {
  if (job.finished) return 0;
  const inReview = detail ? detail.nodes.filter((n) => n.status === "in_review").length : 0;
  return inReview + (job.status === "inspecting" ? 1 : 0);
}

function decisionsNeedingYou(detail: JobDetail | undefined): JobDetail["decisions"] {
  return detail ? detail.decisions.filter((d) => d.needsYou) : [];
}

function trim(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Agents online (Home)
// ---------------------------------------------------------------------------

export function agentsOnline(account: AccountData, profiles: OwnerProviderProfile[]): string[] {
  const online = account.runtimes.filter(
    (r) => r.status === "active" && !r.paused && runtimeOnline(r, account.now),
  );
  if (online.length === 0) return [];
  const ready = new Set<AgentProvider>();
  for (const r of online) {
    if (r.capabilities["claude-code"] === "available") ready.add("claude-code");
    if (r.capabilities["codex"] === "available") ready.add("codex");
  }
  for (const p of profiles) {
    if (p.detected.installed && p.detected.authenticated) ready.add(p.provider);
  }
  return (["claude-code", "codex"] as const).filter((p) => ready.has(p)).map(providerProductName);
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export type AttentionItem = {
  key: string;
  title: string;
  detail: string;
  tone: Tone;
  href: string;
  when: string | null;
};

export type HomeView = {
  headline: { text: string; tone: Tone };
  setupComplete: boolean;
  counts: { key: string; label: string; value: number }[];
  active: {
    key: string;
    name: string;
    team: string;
    status: string;
    tone: Tone;
    summary: string;
  }[];
  needsYou: AttentionItem[];
};

function projectActivity(
  room: OwnerRoom,
  team: TeamData,
  details: Map<string, JobDetail>,
): { status: string; tone: Tone; running: number; reviews: number; summary: string } {
  const jobs = team.jobsByRoom[room.roomId] ?? [];
  const open = jobs.filter((j) => !j.finished);
  const reviews = open.reduce((n, j) => n + reviewsPendingFor(details.get(j.jobId), j), 0);
  const parts: string[] = [];
  if (open.length) parts.push(`${plural(open.length, "task")} running`);
  if (reviews) parts.push(`${plural(reviews, "review")} pending`);
  const needs = jobs.some(
    (j) => j.status === "needs_user_decision" || decisionsNeedingYou(details.get(j.jobId)).length,
  );
  if (needs) parts.push("needs your decision");

  let status = "Ready";
  let tone: Tone = "success";
  const current = open[0];
  const last = jobs[0];
  if (room.status === "archived") {
    status = "Archived";
    tone = "neutral";
  } else if (current) {
    const s = jobState(current.status, current.verdict);
    status = current.line ? trim(current.line) : trim(`${s.label}: ${current.goal}`);
    tone = "accent";
  } else if (last && last.verdict && last.verdict !== "PASS") {
    const s = jobState(last.status, last.verdict);
    status = s.label;
    tone = s.tone;
  }
  return {
    status,
    tone,
    running: open.length,
    reviews,
    summary: parts.length
      ? parts.join(" · ")
      : jobs.length
        ? "No work running"
        : "No team work yet",
  };
}

export function deriveHome(account: AccountData, team: TeamData): PageModel<HomeView> {
  const bag = new HandleBag();
  const base = deriveDashboard(account);
  const details = detailsById(team);
  const activeRooms = team.rooms.filter((r) => r.status === "active");
  const jobs = allJobs(team);

  const tasksRunning = account.tasks.filter((t) => !TERMINAL_TASK.has(t.status)).length;
  const reviewsPending = jobs.reduce((n, j) => n + reviewsPendingFor(details.get(j.jobId), j), 0);

  const active = activeRooms
    .map((room) => ({ room, a: projectActivity(room, team, details) }))
    .sort(
      (x, y) =>
        y.a.running - x.a.running || Date.parse(y.room.updatedAt) - Date.parse(x.room.updatedAt),
    )
    .slice(0, 6)
    .map(({ room, a }) => ({
      key: bag.add("p", { roomId: room.roomId }),
      name: room.name,
      team: roomTeam(room.roomId, team, details),
      status: a.status,
      tone: a.tone,
      summary: a.summary,
    }));

  return {
    view: {
      headline: base.headline,
      setupComplete: base.setupComplete,
      counts: [
        { key: "projects", label: "Projects", value: activeRooms.length },
        {
          key: "agents",
          label: "Agents online",
          value: agentsOnline(account, team.profiles).length,
        },
        { key: "tasks", label: "Tasks running", value: tasksRunning },
        { key: "reviews", label: "Reviews pending", value: reviewsPending },
      ],
      active,
      needsYou: attentionItems(account, team, bag).filter((i) => i.tone !== "neutral"),
    },
    handles: bag.handles,
  };
}

/** Things that need the user, newest first. Shared by Home and Notifications. */
function attentionItems(account: AccountData, team: TeamData, bag: HandleBag): AttentionItem[] {
  const details = detailsById(team);
  const items: (AttentionItem & { at: number })[] = [];
  const sessions = new Map(account.sessions.map((s) => [s.sessionId, s]));

  for (const j of allJobs(team)) {
    const d = details.get(j.jobId);
    const pending = decisionsNeedingYou(d);
    const key = bag.add("j", { jobId: j.jobId });
    const at = Date.parse(j.finishedAt ?? j.startedAt);
    if (j.status === "needs_user_decision" || pending.length) {
      items.push({
        key,
        title: `${j.roomName} needs your decision`,
        detail: pending[0] ? `${pending[0].label} · ${trim(pending[0].title)}` : trim(j.goal),
        tone: "warning",
        href: "/dashboard/team",
        when: relativeTime(j.finishedAt ?? j.startedAt, account.now),
        at,
      });
    } else if (j.status === "blocked" || j.verdict === "BLOCKED") {
      items.push({
        key,
        title: `${j.roomName} is blocked`,
        detail: trim(j.line ?? j.goal),
        tone: "danger",
        href: "/dashboard/team",
        when: relativeTime(j.finishedAt ?? j.startedAt, account.now),
        at,
      });
    } else if (j.status === "needs_fix" || j.verdict === "NEEDS_FIX") {
      items.push({
        key,
        title: `${j.roomName} needs fixes`,
        detail: trim(j.goal),
        tone: "warning",
        href: "/dashboard/team",
        when: relativeTime(j.finishedAt ?? j.startedAt, account.now),
        at,
      });
    } else if (j.verdict === "PASS") {
      items.push({
        key,
        title: `${j.roomName} passed final review`,
        detail: trim(j.goal),
        tone: "neutral",
        href: "/dashboard/team",
        when: relativeTime(j.finishedAt ?? j.startedAt, account.now),
        at,
      });
    }
  }

  for (const l of account.links.filter((x) => x.status === "pending")) {
    const chat = sessions.get(l.controllerSessionId)?.displayName ?? l.controllerDisplayName;
    items.push({
      key: bag.add("l", { linkId: l.linkId }),
      title: "A link is waiting for your approval",
      detail: `${chat ?? "A chat"} → ${conversationName(sessions.get(l.agentSessionId), l.agentDisplayName)}. Approve it in the ThreadLink app.`,
      tone: "warning",
      href: "/dashboard/conversations",
      when: relativeTime(l.requestedAt, account.now),
      at: Date.parse(l.requestedAt),
    });
  }

  for (const t of account.tasks.filter((x) => x.status === "failed").slice(0, 5)) {
    items.push({
      key: bag.add("t", { taskId: t.taskId }),
      title: `Task stopped: ${trim(t.title, 60)}`,
      detail: taskStatus(t.status, t.failureReason).statusLabel,
      tone: "neutral",
      href: "/dashboard/tasks",
      when: relativeTime(t.finishedAt ?? t.createdAt, account.now),
      at: Date.parse(t.finishedAt ?? t.createdAt),
    });
  }

  return items
    .sort((a, b) => b.at - a.at)
    .map((item) => {
      const { at, ...rest } = item;
      void at;
      return rest;
    });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationsView = { items: AttentionItem[]; needsYou: number };

export function deriveNotifications(
  account: AccountData,
  team: TeamData,
): PageModel<NotificationsView> {
  const bag = new HandleBag();
  const items = attentionItems(account, team, bag);
  for (const r of account.runtimes) {
    if (r.status !== "active" || r.paused || runtimeOnline(r, account.now)) continue;
    items.push({
      key: bag.add("d", { runtimeId: r.runtimeId }),
      title: `${r.label} is offline`,
      detail: "Work sent to it waits until the ThreadLink app is running there again.",
      tone: "neutral",
      href: "/dashboard/devices",
      when: r.lastSeenAt ? `Last seen ${relativeTime(r.lastSeenAt, account.now)}` : null,
    });
  }
  return {
    view: { items, needsYou: items.filter((i) => i.tone !== "neutral").length },
    handles: bag.handles,
  };
}

// ---------------------------------------------------------------------------
// Projects (rooms)
// ---------------------------------------------------------------------------

export type ProjectCard = {
  key: string;
  name: string;
  team: string;
  archived: boolean;
  status: string;
  tone: Tone;
  summary: string;
  lastActivity: string;
  folder: string;
  conversation: string | null;
  policy: {
    parallelAgents: number;
    maxPlanningRounds: number;
    maxReviewRounds: number;
    usagePolicy: UsagePolicy;
    text: string;
  };
  recentJobs: { key: string; goal: string; status: string; tone: Tone; when: string }[];
};

export type ProjectsView = {
  projects: ProjectCard[];
  archivedCount: number;
  showingArchived: boolean;
  limits: typeof TEAM_LIMITS;
  usagePolicies: { value: UsagePolicy; label: string; description: string }[];
};

export function usagePolicyOptions() {
  return USAGE_POLICIES.map((value) => ({ value, ...USAGE_POLICY_TEXT[value] }));
}

export function deriveProjects(
  team: TeamData,
  now: number,
  opts: { showArchived?: boolean } = {},
): PageModel<ProjectsView> {
  const bag = new HandleBag();
  const details = detailsById(team);
  const live = team.rooms.filter((r) => r.status !== "deleted");
  const archivedCount = live.filter((r) => r.status === "archived").length;
  const visible = live.filter((r) => r.status === "active" || opts.showArchived === true);

  const projects = visible
    .slice()
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    })
    .map((room): ProjectCard => {
      const a = projectActivity(room, team, details);
      const jobs = team.jobsByRoom[room.roomId] ?? [];
      const lastAt = [room.updatedAt, jobs[0]?.startedAt, jobs[0]?.finishedAt ?? undefined]
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1)!;
      const policyName = USAGE_POLICY_TEXT[room.usagePolicy].label;
      return {
        key: bag.add("p", { roomId: room.roomId }),
        name: room.name,
        team: roomTeam(room.roomId, team, details),
        archived: room.status === "archived",
        status: a.status,
        tone: a.tone,
        summary: a.summary,
        lastActivity: `Last activity ${relativeTime(lastAt, now)}`,
        folder: folderName(room.workspaceName),
        conversation: room.agentName ? conversationName(undefined, room.agentName) : null,
        policy: {
          ...room.budgets,
          usagePolicy: room.usagePolicy,
          text: [
            `Up to ${plural(room.budgets.parallelAgents, "agent")} at once`,
            `${plural(room.budgets.maxPlanningRounds, "planning round")}`,
            `${plural(room.budgets.maxReviewRounds, "review round")}`,
            policyName,
          ].join(" · "),
        },
        recentJobs: jobs.slice(0, 3).map((j) => {
          const s = jobState(j.status, j.verdict);
          return {
            key: bag.add("j", { jobId: j.jobId }),
            goal: trim(j.goal),
            status: s.label,
            tone: s.tone,
            when: relativeTime(j.finishedAt ?? j.startedAt, now),
          };
        }),
      };
    });

  return {
    view: {
      projects,
      archivedCount,
      showingArchived: opts.showArchived === true,
      limits: TEAM_LIMITS,
      usagePolicies: usagePolicyOptions(),
    },
    handles: bag.handles,
  };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export type GraphSymbol = "✓" | "●" | "○" | "✕" | "–";
export type GraphLine = {
  key: string;
  branch: "" | "├─" | "└─";
  symbol: GraphSymbol;
  label: string;
  detail: string | null;
  state: "done" | "active" | "waiting" | "failed" | "skipped";
  /** The whole line as text, e.g. "├─ ✓ Backend — Claude Code, reviewed by Codex". */
  text: string;
};

const NODE_SYMBOL: Record<string, { symbol: GraphSymbol; state: GraphLine["state"] }> = {
  pending: { symbol: "○", state: "waiting" },
  ready: { symbol: "○", state: "waiting" },
  running: { symbol: "●", state: "active" },
  in_review: { symbol: "●", state: "active" },
  changes_requested: { symbol: "●", state: "active" },
  approved: { symbol: "✓", state: "done" },
  integrated: { symbol: "✓", state: "done" },
  failed: { symbol: "✕", state: "failed" },
  skipped: { symbol: "–", state: "skipped" },
};

const PLANNING = new Set(["queued", "normalising", "planning"]);

/** Dependencies first, input order as the tiebreak; a cycle can't hide a node. */
function orderNodes(nodes: JobDetail["nodes"]): JobDetail["nodes"] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const out: JobDetail["nodes"] = [];
  const seen = new Set<string>();
  const visit = (n: JobDetail["nodes"][number], stack: Set<string>) => {
    if (seen.has(n.key) || stack.has(n.key)) return;
    stack.add(n.key);
    for (const dep of n.dependsOn) {
      const d = byKey.get(dep);
      if (d) visit(d, stack);
    }
    seen.add(n.key);
    out.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return out;
}

/**
 * The job's plan as a short tree, without graph words:
 *   ✓ Plan
 *   ├─ ✓ Backend — Claude Code, reviewed by Codex
 *   ├─ ● UI — Codex
 *   └─ ○ Integration → Final review
 */
export function taskGraph(job: Pick<JobDetail, "status" | "verdict" | "nodes">): GraphLine[] {
  const lines: Omit<GraphLine, "branch" | "text" | "key">[] = [];
  const planning = PLANNING.has(job.status);
  lines.push({
    symbol: planning ? (job.status === "queued" ? "○" : "●") : "✓",
    state: planning ? (job.status === "queued" ? "waiting" : "active") : "done",
    label: "Plan",
    detail: null,
  });
  for (const n of orderNodes(job.nodes)) {
    const s = NODE_SYMBOL[n.status] ?? NODE_SYMBOL.pending!;
    const who = providerProductName(n.owner);
    const detail = n.reviewer
      ? `${who}, reviewed by ${providerProductName(n.reviewer)}`
      : n.mixedAuthorship
        ? `${who}, with help from the reviewer`
        : who;
    lines.push({ symbol: s.symbol, state: s.state, label: n.title, detail });
  }
  const final =
    job.verdict === "PASS" || job.status === "completed"
      ? { symbol: "✓" as const, state: "done" as const }
      : job.status === "integrating" || job.status === "inspecting"
        ? { symbol: "●" as const, state: "active" as const }
        : job.verdict || job.status === "failed"
          ? { symbol: "✕" as const, state: "failed" as const }
          : job.status === "cancelled"
            ? { symbol: "–" as const, state: "skipped" as const }
            : { symbol: "○" as const, state: "waiting" as const };
  lines.push({ ...final, label: "Integration → Final review", detail: null });

  return lines.map((l, i) => {
    const branch: GraphLine["branch"] = i === 0 ? "" : i === lines.length - 1 ? "└─" : "├─";
    const body = `${l.symbol} ${l.label}${l.detail ? ` — ${l.detail}` : ""}`;
    return { ...l, key: `g${i}`, branch, text: branch ? `${branch} ${body}` : body };
  });
}

export type AgentLine = {
  key: string;
  /** "Builder · Claude Code · Claude Sonnet 5 · Medium effort" */
  line: string;
  role: string;
  provider: string;
  model: string;
  effort: string | null;
  doing: string;
  mismatch: string | null;
};

function whatIsDoing(provider: string, job: JobDetail): string {
  const key = providerKey(provider);
  const mine = (p: string | null) => p !== null && providerKey(p) === key;
  const building = job.nodes.filter((n) => mine(n.owner) && n.status === "running");
  const fixing = job.nodes.filter((n) => mine(n.owner) && n.status === "changes_requested");
  const reviewing = job.nodes.filter((n) => mine(n.reviewer) && n.status === "in_review");
  const awaiting = job.nodes.filter((n) => mine(n.owner) && n.status === "in_review");
  const list = (ns: typeof building) => ns.map((n) => n.title).join(", ");
  if (job.finished) return "Done";
  const doing = [
    building.length ? `Building ${list(building)}` : null,
    fixing.length ? `Fixing ${list(fixing)}` : null,
    reviewing.length ? `Reviewing ${list(reviewing)}` : null,
  ].filter(Boolean);
  if (doing.length) return doing.join(" · ");
  if (awaiting.length) return `Waiting for review of ${list(awaiting)}`;
  if (job.status === "planning") return "Planning";
  if (job.status === "inspecting") return "Final review";
  if (job.status === "integrating") return "Putting it together";
  return "Waiting";
}

/** One line per agent and role, from the model runs that actually happened. */
export function agentLines(job: JobDetail): AgentLine[] {
  const seen = new Set<string>();
  const out: AgentLine[] = [];
  const runs = job.modelRuns.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const r of runs) {
    const id = `${providerKey(r.provider)}:${r.role}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const ran = r.observed ?? r.requested;
    const model = modelDisplayName(ran);
    const effort = effortLabel(r.effort);
    const provider = providerProductName(r.provider);
    const role = roleLabel(r.role);
    out.push({
      key: `a${out.length}`,
      line: [role, provider, r.observed ? model : `${model} (requested)`, effort]
        .filter(Boolean)
        .join(" · "),
      role,
      provider,
      model,
      effort,
      doing: whatIsDoing(r.provider, job),
      mismatch:
        r.observed && !r.matched
          ? `Asked for ${modelDisplayName(r.requested)}, but ${modelDisplayName(r.observed)} ran. ThreadLink stopped this run.`
          : null,
    });
  }
  if (out.length === 0) {
    // No run recorded yet: the owners and reviewers from the plan.
    const providers = new Map<string, string>();
    for (const n of job.nodes) {
      if (!providers.has(n.owner)) providers.set(n.owner, "builder");
      if (n.reviewer && !providers.has(n.reviewer)) providers.set(n.reviewer, "reviewer");
    }
    for (const [p, role] of providers) {
      out.push({
        key: `a${out.length}`,
        line: `${roleLabel(role)} · ${providerProductName(p)}`,
        role: roleLabel(role),
        provider: providerProductName(p),
        model: modelDisplayName(null),
        effort: null,
        doing: whatIsDoing(p, job),
        mismatch: null,
      });
    }
  }
  return out.slice(0, 6);
}

export type TeamJobCard = {
  key: string;
  project: string;
  goal: string;
  status: string;
  tone: Tone;
  verdict: string | null;
  finished: boolean;
  statusLine: string | null;
  planning: string;
  review: string;
  findings: string;
  findingsRemaining: number;
  decisionsNeedingYou: number;
  agents: AgentLine[];
  graph: GraphLine[];
  started: string;
  summary: string | null;
  hasDetail: boolean;
};

export type TeamView = { active: TeamJobCard[]; recent: TeamJobCard[]; empty: boolean };

function findingsText(d: JobDetail | undefined): { text: string; remaining: number } {
  if (!d) return { text: "Findings not loaded", remaining: 0 };
  const o = d.findings.open;
  const remaining = o.blocking + o.important + o.nonBlocking;
  if (remaining === 0) return { text: "No findings remaining", remaining };
  const parts = [
    o.blocking ? `${o.blocking} blocking` : null,
    o.important ? `${o.important} important` : null,
    o.nonBlocking ? `${o.nonBlocking} non-blocking` : null,
  ].filter(Boolean);
  return { text: `${plural(remaining, "finding")} remaining (${parts.join(", ")})`, remaining };
}

function jobCard(j: Job, d: JobDetail | undefined, now: number, bag: HandleBag): TeamJobCard {
  const s = jobState(j.status, j.verdict);
  const f = findingsText(d);
  return {
    key: bag.add("j", { jobId: j.jobId }),
    project: j.roomName,
    goal: trim(j.goal, 200),
    status: s.label,
    tone: s.tone,
    verdict: verdictLabel(j.verdict),
    finished: j.finished,
    statusLine: j.line,
    planning: `Planning: ${j.planning.toLowerCase()}`,
    review: `Review: ${j.review.toLowerCase()}`,
    findings: f.text,
    findingsRemaining: f.remaining,
    decisionsNeedingYou: decisionsNeedingYou(d).length,
    agents: d ? agentLines(d) : [],
    graph: d ? taskGraph(d) : taskGraph({ status: j.status, verdict: j.verdict, nodes: [] }),
    started: `Started ${relativeTime(j.startedAt, now)}`,
    summary: d?.summary ?? null,
    hasDetail: Boolean(d),
  };
}

export function deriveTeam(team: TeamData, now: number): PageModel<TeamView> {
  const bag = new HandleBag();
  const details = detailsById(team);
  const jobs = allJobs(team);
  const active = jobs.filter((j) => !j.finished).slice(0, 10);
  const recent = jobs.filter((j) => j.finished).slice(0, 10);
  return {
    view: {
      active: active.map((j) => jobCard(j, details.get(j.jobId), now, bag)),
      recent: recent.map((j) => jobCard(j, details.get(j.jobId), now, bag)),
      empty: jobs.length === 0,
    },
    handles: bag.handles,
  };
}

// ---------------------------------------------------------------------------
// Full team log (one job)
// ---------------------------------------------------------------------------

export const LOG_PAGE_SIZE = 20;

export type Page<T> = { items: T[]; page: number; pageCount: number; total: number };

export function paginate<T>(items: T[], page: number, size = LOG_PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)), pageCount);
  return { items: items.slice((p - 1) * size, p * size), page: p, pageCount, total: items.length };
}

export type TeamLogView = {
  project: string;
  goal: string;
  status: string;
  tone: Tone;
  summary: string | null;
  planning: string;
  review: string;
  graph: GraphLine[];
  agents: AgentLine[];
  messages: { available: false; note: string };
  findings: Page<{
    key: string;
    severity: string;
    severityTone: Tone;
    title: string;
    category: string;
    status: string;
    open: boolean;
    raisedBy: string;
  }>;
  findingCounts: string;
  decisions: Page<{
    key: string;
    number: string;
    topic: string;
    resolution: string;
    evidence: string | null;
    needsYou: boolean;
  }>;
  models: Page<{
    key: string;
    selected: string;
    who: string;
    effort: string | null;
    outcome: string;
    ok: boolean;
    mismatch: string | null;
    when: string;
  }>;
};

export function deriveTeamLog(
  detail: JobDetail & { evidenceByDecision?: Record<string, string> },
  project: string,
  now: number,
  pages: { findings?: number; decisions?: number; models?: number } = {},
): PageModel<TeamLogView> {
  const s = jobState(detail.status, detail.verdict);
  const f = findingsText(detail);
  return {
    view: {
      project,
      goal: detail.goal,
      status: s.label,
      tone: s.tone,
      summary: detail.summary,
      planning: `Planning: ${detail.planning.toLowerCase()}`,
      review: `Review: ${detail.review.toLowerCase()}`,
      graph: taskGraph(detail),
      agents: agentLines(detail),
      messages: {
        available: false,
        note: "Agent-to-agent messages are kept with the job. ChatGPT can show them with “show the full team log”.",
      },
      findings: paginate(
        detail.findings.recent.map((x, i) => ({
          key: `f${i}`,
          severity: FINDING_SEVERITY_LABELS[x.severity] ?? humanize(x.severity),
          severityTone: FINDING_SEVERITY_TONES[x.severity] ?? "neutral",
          title: x.title,
          category: FINDING_CATEGORY_LABELS[x.category] ?? humanize(x.category),
          status: FINDING_STATUS_LABELS[x.status] ?? humanize(x.status),
          open: x.status === "open",
          raisedBy: `Raised by ${providerProductName(x.raisedBy)}`,
        })),
        pages.findings ?? 1,
      ),
      findingCounts: f.text,
      decisions: paginate(
        detail.decisions.map((x, i) => ({
          key: `d${i}`,
          number: x.label,
          topic: x.title,
          resolution: x.resolution ?? (x.needsYou ? "Waiting for you" : "Not resolved yet"),
          evidence: detail.evidenceByDecision?.[x.label] ?? null,
          needsYou: x.needsYou,
        })),
        pages.decisions ?? 1,
      ),
      models: paginate(
        detail.modelRuns.map((r, i) => {
          const ran = r.observed ?? r.requested;
          return {
            key: `m${i}`,
            selected: `Selected: ${modelDisplayName(ran)} — ${r.reason}`,
            who: `${roleLabel(r.role)} · ${providerProductName(r.provider)}`,
            effort: effortLabel(r.effort),
            outcome: OUTCOME_LABELS[r.outcome] ?? humanize(r.outcome),
            ok: r.outcome === "ok",
            mismatch:
              r.observed && !r.matched
                ? `Asked for ${modelDisplayName(r.requested)}, ${modelDisplayName(r.observed)} ran`
                : null,
            when: relativeTime(r.at, now),
          };
        }),
        pages.models ?? 1,
      ),
    },
    handles: {},
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskRow = {
  key: string;
  title: string;
  route: string;
  status: string;
  tone: Tone;
  when: string;
};

export type TasksView = {
  running: number;
  tasks: TaskRow[];
  teamJobs: {
    key: string;
    project: string;
    goal: string;
    status: string;
    tone: Tone;
    when: string;
  }[];
  byConversation: {
    key: string;
    conversation: string;
    attribution: string;
    mode: string;
    status: string;
    tasks: TaskRow[];
    more: number;
    emptyHint: string;
  }[];
};

export function deriveTasks(account: AccountData, team: TeamData): PageModel<TasksView> {
  const bag = new HandleBag();
  const base = deriveDashboard(account);
  const tasks: TaskRow[] = base.activity.map((a) => ({
    key: bag.add("t", { taskId: a.taskId }),
    title: a.title,
    route: a.route,
    status: a.statusLabel,
    tone: a.tone,
    when: a.when,
  }));
  const teamJobs = allJobs(team)
    .slice(0, 20)
    .map((j) => {
      const s = jobState(j.status, j.verdict);
      return {
        key: bag.add("j", { jobId: j.jobId }),
        project: j.roomName,
        goal: trim(j.goal),
        status: s.label,
        tone: s.tone,
        when: relativeTime(j.finishedAt ?? j.startedAt, account.now),
      };
    });
  const byConversation = base.linkActivity.map((g) => ({
    key: bag.add("c", { linkId: g.linkId }),
    conversation: g.conversation,
    attribution: g.attribution,
    mode: g.modeLabel,
    status: g.statusLabel,
    tasks: g.tasks.slice(0, 5).map((t) => ({
      key: bag.add("t", { taskId: t.taskId }),
      title: t.title,
      route: g.chatApp,
      status: t.statusLabel,
      tone: t.tone,
      when: t.when,
    })),
    more: Math.max(0, g.taskCount - 5),
    emptyHint: g.emptyHint,
  }));
  return {
    view: {
      running: account.tasks.filter((t) => !TERMINAL_TASK.has(t.status)).length,
      tasks,
      teamJobs,
      byConversation,
    },
    handles: bag.handles,
  };
}

// ---------------------------------------------------------------------------
// Conversations (merges the old Links and Sessions pages)
// ---------------------------------------------------------------------------

export type ConversationCard = {
  key: string;
  name: string;
  mode: string;
  modeDetail: string;
  folder: string | null;
  device: string | null;
  projects: string[];
  status: string;
  tone: Tone;
  lastUsed: string;
  chats: {
    key: string;
    chat: string;
    chatApp: string;
    status: string;
    tone: Tone;
    paused: boolean;
  }[];
};

export type ConversationsView = {
  conversations: ConversationCard[];
  pending: { key: string; text: string; when: string }[];
  chats: { key: string; name: string; app: string; lastUsed: string }[];
  /** Choices for "Change Claude conversation" (keys resolve to sessions in handles). */
  choices: { key: string; name: string }[];
};

const LINK_TONE: Record<string, Tone> = {
  ready: "success",
  busy: "warning",
  paused: "neutral",
  offline: "warning",
};

export function deriveConversations(
  account: AccountData,
  team: TeamData,
): PageModel<ConversationsView> {
  const bag = new HandleBag();
  const base = deriveDashboard(account);
  const runtimeById = new Map(account.runtimes.map((r) => [r.runtimeId, r]));
  const workspaceById = new Map(account.workspaces.map((w) => [w.workspaceId, w]));

  const conversations = base.agentSessions.map((s): ConversationCard => {
    const name = conversationName(s, null);
    const cards = base.links.filter((l) => l.agentSessionId === s.sessionId);
    const runtime = s.runtimeId ? runtimeById.get(s.runtimeId) : undefined;
    const workspace = s.workspaceId ? workspaceById.get(s.workspaceId) : undefined;
    const online = runtime ? runtimeOnline(runtime, account.now) : false;
    // Display only: which projects use this conversation, matched by the names
    // the room list returns. Never used to route or authorise anything.
    const projects = team.rooms
      .filter(
        (r) =>
          r.status !== "deleted" &&
          r.agentName !== null &&
          conversationName(undefined, r.agentName) === name &&
          (!workspace || r.workspaceName === workspace.name),
      )
      .map((r) => r.name);
    const status = cards.some((c) => c.status === "ready")
      ? { status: "Linked · Ready", tone: "success" as Tone }
      : s.busy && s.nativeSessionMode === "resume"
        ? { status: "Open in Claude right now", tone: "warning" as Tone }
        : cards.length
          ? { status: cards[0]!.statusLabel, tone: LINK_TONE[cards[0]!.status] ?? "neutral" }
          : runtime && !online
            ? { status: "Device offline", tone: "warning" as Tone }
            : { status: "Not linked to a chat", tone: "neutral" as Tone };
    return {
      key: bag.add("c", { sessionId: s.sessionId }),
      name,
      mode: executionModeLabel(s),
      modeDetail: conversationMode(s),
      folder: workspace?.name ?? (s.workspacePath ? folderName(s.workspacePath) : null),
      device: runtime?.label ?? null,
      projects,
      status: status.status,
      tone: status.tone,
      lastUsed: `Last active ${relativeTime(s.lastSeenAt, account.now)}`,
      chats: cards.map((c) => ({
        key: bag.add("l", {
          linkId: c.linkId,
          controllerSessionId: c.controllerSessionId,
        }),
        chat: c.chat,
        chatApp: c.chatApp,
        status: c.statusLabel,
        tone: LINK_TONE[c.status] ?? "neutral",
        paused: c.paused,
      })),
    };
  });

  const sessions = new Map(account.sessions.map((s) => [s.sessionId, s]));
  const pending = base.pendingLinks.map((l) => ({
    key: bag.add("pl", { linkId: l.linkId }),
    text: `${sessions.get(l.controllerSessionId)?.displayName ?? l.controllerDisplayName ?? "A chat"} → ${conversationName(sessions.get(l.agentSessionId), l.agentDisplayName)}`,
    when: `Requested ${relativeTime(l.requestedAt, account.now)}`,
  }));

  const chats = base.controllerSessions.map((s) => ({
    key: bag.add("h", { sessionId: s.sessionId }),
    name: s.displayName ?? "Conversation",
    app: PLATFORM_LABELS[s.platform],
    lastUsed: `Last used ${relativeTime(s.lastSeenAt, account.now)}`,
  }));

  const choices = base.agentSessions.map((s) => ({
    key: bag.add("o", { sessionId: s.sessionId }),
    name: conversationName(s, null),
  }));

  return { view: { conversations, pending, chats, choices }, handles: bag.handles };
}

// ---------------------------------------------------------------------------
// Devices (Runtimes)
// ---------------------------------------------------------------------------

const PLATFORM_NAMES: Record<OwnerRuntime["platform"], string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  other: "Other",
};
const KIND_NAMES: Record<OwnerRuntime["kind"], string> = {
  desktop: "Desktop app",
  cli: "Command line",
  remote: "Remote environment",
};
const AGENT_CAPABILITIES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export type DeviceCard = {
  key: string;
  name: string;
  platform: string;
  kind: string;
  version: string | null;
  status: "online" | "offline" | "paused" | "disconnected";
  statusLabel: string;
  tone: Tone;
  lastSeen: string;
  agents: { name: string; available: boolean }[];
  folders: { key: string; name: string; conversations: number }[];
  paused: boolean;
  settings: { autoStart: boolean; autoReconnect: boolean; notifications: boolean };
};

export type DevicesView = {
  devices: DeviceCard[];
  disconnected: DeviceCard[];
  disconnectedCount: number;
  showingDisconnected: boolean;
  onlineCount: number;
};

export function lastSeenText(iso: string | null, now: number): string {
  if (!iso) return "Never seen";
  return `Last seen ${relativeTime(iso, now)}`;
}

export function deriveDevices(
  account: AccountData,
  opts: { showDisconnected?: boolean } = {},
): PageModel<DevicesView> {
  const bag = new HandleBag();
  const agentSessions = account.sessions.filter(
    (s) => s.role === "agent" && (s.status === "active" || s.status === "idle"),
  );
  const card = (r: OwnerRuntime): DeviceCard => {
    const online = runtimeOnline(r, account.now);
    const status: DeviceCard["status"] =
      r.status === "revoked" ? "disconnected" : r.paused ? "paused" : online ? "online" : "offline";
    return {
      key: bag.add("d", { runtimeId: r.runtimeId }),
      name: r.label,
      platform: PLATFORM_NAMES[r.platform],
      kind: KIND_NAMES[r.kind],
      version: r.version ? `v${r.version}` : null,
      status,
      statusLabel:
        status === "online"
          ? "Online"
          : status === "paused"
            ? "Paused"
            : status === "disconnected"
              ? "Disconnected"
              : "Offline",
      tone:
        status === "online"
          ? "success"
          : status === "offline"
            ? "warning"
            : status === "disconnected"
              ? "neutral"
              : "neutral",
      lastSeen: online ? "Last seen just now" : lastSeenText(r.lastSeenAt, account.now),
      agents: Object.entries(r.capabilities)
        .filter(([k]) => k in AGENT_CAPABILITIES)
        .map(([k, v]) => ({ name: AGENT_CAPABILITIES[k]!, available: v === "available" })),
      folders: account.workspaces
        .filter((w) => w.runtimeId === r.runtimeId)
        .map((w) => ({
          key: bag.add("w", { workspaceId: w.workspaceId }),
          name: w.name,
          conversations: agentSessions.filter((s) => s.workspaceId === w.workspaceId).length,
        })),
      paused: r.paused,
      settings: {
        autoStart: r.settings.autoStart !== false,
        autoReconnect: r.settings.autoReconnect !== false,
        notifications: r.settings.notifications !== false,
      },
    };
  };
  const active = account.runtimes.filter((r) => r.status === "active");
  const revoked = account.runtimes.filter((r) => r.status === "revoked");
  const devices = active.map(card);
  return {
    view: {
      devices,
      disconnected: opts.showDisconnected ? revoked.map(card) : [],
      disconnectedCount: revoked.length,
      showingDisconnected: opts.showDisconnected === true,
      onlineCount: devices.filter((d) => d.status === "online").length,
    },
    handles: bag.handles,
  };
}

// ---------------------------------------------------------------------------
// Settings → Providers & plans
// ---------------------------------------------------------------------------

export type ProviderCard = {
  provider: AgentProvider;
  title: string;
  declared: { value: string; label: string; options: { value: string; label: string }[] };
  detected: {
    seen: boolean;
    when: string;
    rows: { label: string; value: string }[];
  };
  note: string;
  planWarning: string | null;
  usagePolicy: {
    value: UsagePolicy;
    options: { value: UsagePolicy; label: string; description: string }[];
  };
  paidUsage: { enabled: boolean; label: string };
  remaining: string;
};

export type ProvidersView = { providers: ProviderCard[]; teamModeNote: string };

const PROVIDER_TITLES: Record<AgentProvider, string> = {
  "claude-code": "Claude",
  codex: "ChatGPT / Codex",
};
const PROVIDER_VENDOR: Record<AgentProvider, string> = {
  "claude-code": "Claude",
  codex: "ChatGPT",
};

const yesNo = (v: boolean | null, yes: string, no: string) =>
  v === null ? "Not reported" : v ? yes : no;

export function deriveProviders(
  profiles: OwnerProviderProfile[],
  now: number,
): PageModel<ProvidersView> {
  const providers = (["claude-code", "codex"] as const).map((provider): ProviderCard => {
    const p =
      profiles.find((x) => x.provider === provider) ??
      ({
        provider,
        providerName: providerProductName(provider),
        declaredPlan: "unknown",
        usagePolicy: "balanced",
        paidUsageEnabled: false,
        detected: {
          installed: null,
          authenticated: null,
          version: null,
          plan: null,
          currentModel: null,
        },
        detectedAt: null,
      } satisfies OwnerProviderProfile);
    const labels = provider === "claude-code" ? CLAUDE_PLAN_LABELS : CHATGPT_PLAN_LABELS;
    const d = p.detected;
    const seen = p.detectedAt !== null;
    const working = d.installed === true && d.authenticated === true;
    const product = providerProductName(provider);
    return {
      provider,
      title: PROVIDER_TITLES[provider],
      declared: {
        value: p.declaredPlan in labels ? p.declaredPlan : "unknown",
        label: labels[p.declaredPlan] ?? labels.unknown!,
        options: Object.entries(labels).map(([value, label]) => ({ value, label })),
      },
      detected: {
        seen,
        when: seen
          ? `Checked by your device ${relativeTime(p.detectedAt, now)}`
          : "Not checked yet. Open the ThreadLink app on your computer.",
        rows: [
          { label: `${product} installed`, value: yesNo(d.installed, "Yes", "No") },
          { label: "Signed in", value: yesNo(d.authenticated, "Yes", "No") },
          {
            label: "Reported plan",
            value: detectedPlanLabel(provider, d.plan) ?? "Not reported",
          },
          {
            label: "Current model",
            value: d.currentModel ? modelDisplayName(d.currentModel) : "Not reported",
          },
          ...(d.version ? [{ label: "Version", value: d.version }] : []),
        ],
      },
      note: "What your device detects is what counts. The plan you choose here is only a hint for how ThreadLink plans work.",
      planWarning:
        provider === "claude-code" && p.declaredPlan === "free" && !working
          ? "Claude Code is not included on the Free plan."
          : null,
      usagePolicy: { value: p.usagePolicy, options: usagePolicyOptions() },
      paidUsage: {
        enabled: p.paidUsageEnabled === true,
        label: p.paidUsageEnabled === true ? "On" : "Off",
      },
      remaining: `Not reported by ${PROVIDER_VENDOR[provider]}`,
    };
  });
  return {
    view: {
      providers,
      teamModeNote:
        "Team Mode only runs on the usage your subscriptions already include. When it runs out, ThreadLink stops and asks you.",
    },
    handles: {},
  };
}

// ---------------------------------------------------------------------------
// Settings → Cleanup
// ---------------------------------------------------------------------------

export const INACTIVE_PROJECT_DAYS = 30;
export const OFFLINE_DEVICE_DAYS = 14;
const DAY = 86_400_000;

/**
 * Cleanup candidates. The server action recomputes these from fresh data (it
 * never trusts a list posted by the browser), so this is the single rule.
 */
export function cleanupCandidates(account: AccountData, team: TeamData) {
  const inactiveProjects = team.rooms.filter((r) => {
    if (r.status !== "active" || r.jobs.open > 0) return false;
    const last = [r.updatedAt, r.lastJob?.at]
      .filter((v): v is string => Boolean(v))
      .map((v) => Date.parse(v));
    return account.now - Math.max(...last) > INACTIVE_PROJECT_DAYS * DAY;
  });
  const offlineDevices = account.runtimes.filter((r) => {
    if (r.status !== "active" || runtimeOnline(r, account.now)) return false;
    const last = Date.parse(r.lastSeenAt ?? r.createdAt);
    return account.now - last > OFFLINE_DEVICE_DAYS * DAY;
  });
  return { inactiveProjects, offlineDevices };
}

export type CleanupView = {
  projects: { count: number; names: string[]; text: string };
  devices: { count: number; names: string[]; text: string };
};

export function deriveCleanup(account: AccountData, team: TeamData): PageModel<CleanupView> {
  const c = cleanupCandidates(account, team);
  const names = (xs: string[]) => xs.slice(0, 5);
  return {
    view: {
      projects: {
        count: c.inactiveProjects.length,
        names: names(c.inactiveProjects.map((r) => r.name)),
        text: `Projects with no running work and no activity for ${INACTIVE_PROJECT_DAYS} days. Archiving keeps their history.`,
      },
      devices: {
        count: c.offlineDevices.length,
        names: names(c.offlineDevices.map((r) => r.label)),
        text: `Devices not seen for ${OFFLINE_DEVICE_DAYS} days. Each must sign in again to reconnect.`,
      },
    },
    handles: {},
  };
}

/** Provider name used in paid-usage copy. */
export function providerVendor(provider: AgentProvider): string {
  return PROVIDER_VENDOR[provider];
}
