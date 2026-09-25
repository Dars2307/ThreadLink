import type { OwnerRoom } from "@/lib/rooms/queries";
import type { OwnerJobSummary } from "@/lib/team/queries";

import { jobState, type Tone } from "./labels";
import {
  detailsById,
  projectActivity,
  roomTeam,
  trim,
  type JobDetail,
  type PageModel,
} from "./pages";
import { conversationName, folderName, relativeTime } from "./view-model";

/**
 * The project page (one room): Chat, Progress and Details tabs. Pure.
 *
 * Like every page model, `view` carries no raw identifier; the Details tab
 * reads `technical`, which is the only place IDs are rendered outside
 * Settings → Advanced.
 */

export const PROJECT_TABS = ["chat", "progress", "details"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export const TAB_LABELS: Record<ProjectTab, string> = {
  chat: "Chat",
  progress: "Progress",
  details: "Details",
};

type Search = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseTab(v: string | string[] | undefined): ProjectTab {
  const t = first(v);
  return (PROJECT_TABS as readonly string[]).includes(t ?? "") ? (t as ProjectTab) : "chat";
}

/** A job id from the query string, shape-checked only; ownership is checked against the room's jobs. */
export function parseJobParam(v: string | string[] | undefined): string | null {
  const j = first(v);
  return j && /^[A-Za-z0-9_-]{1,80}$/.test(j) ? j : null;
}

/** Link to a project page; `tab` defaults to chat and is left out then. */
export function projectHref(
  roomId: string,
  opts: { tab?: ProjectTab; job?: string | null; extra?: Search } = {},
): string {
  const q = new URLSearchParams();
  if (opts.tab && opts.tab !== "chat") q.set("tab", opts.tab);
  else if (opts.tab === "chat" && opts.job) q.set("tab", "chat");
  if (opts.job) q.set("job", opts.job);
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  return `/dashboard/projects/${encodeURIComponent(roomId)}${s ? `?${s}` : ""}`;
}

export type ProjectJobLine = {
  key: string;
  goal: string;
  status: string;
  tone: Tone;
  when: string;
  selected: boolean;
  running: boolean;
};

export type ProjectView = {
  name: string;
  team: string;
  folder: string;
  conversation: string | null;
  status: string;
  tone: Tone;
  archived: boolean;
  summary: string;
  jobs: ProjectJobLine[];
  /** The job the Progress tab shows: the one asked for (if it is in this project), else the latest. */
  selectedJobKey: string | null;
  /** True when `?job=` named a job that is not in this project (it is ignored). */
  jobNotFound: boolean;
  /** Two agents are enrolled unless job history shows otherwise. */
  twoAgents: boolean;
};

export type ProjectTechnical = {
  roomId: string;
  jobs: { goal: string; jobId: string; selected: boolean }[];
  units: { title: string; key: string }[];
};

export function deriveProject(
  room: OwnerRoom,
  jobs: OwnerJobSummary[],
  detail: JobDetail | null,
  now: number,
  opts: { job?: string | null } = {},
): PageModel<ProjectView> & { technical: ProjectTechnical; selectedJobId: string | null } {
  const handles: PageModel<ProjectView>["handles"] = { room: { roomId: room.roomId } };
  const team = {
    rooms: [room],
    jobsByRoom: { [room.roomId]: jobs },
    details: detail ? [detail] : [],
    profiles: [],
  };
  const details = detailsById(team);
  const a = projectActivity(room, team, details);
  const teamName = roomTeam(room.roomId, team, details);

  const asked = opts.job ? jobs.find((j) => j.jobId === opts.job) : undefined;
  const selected = asked ?? jobs[0] ?? null;

  const lines = jobs.slice(0, 20).map((j, i): ProjectJobLine => {
    const key = `j${i}`;
    handles[key] = { jobId: j.jobId };
    const s = jobState(j.status, j.verdict);
    return {
      key,
      goal: trim(j.goal),
      status: s.label,
      tone: s.tone,
      when: relativeTime(j.finishedAt ?? j.startedAt, now),
      selected: selected?.jobId === j.jobId,
      running: !j.finished,
    };
  });

  return {
    view: {
      name: room.name,
      team: teamName,
      folder: folderName(room.workspaceName),
      conversation: room.agentName ? conversationName(undefined, room.agentName) : null,
      status: a.status,
      tone: a.tone,
      archived: room.status === "archived",
      summary: a.summary,
      jobs: lines,
      selectedJobKey: lines.find((l) => l.selected)?.key ?? null,
      jobNotFound: Boolean(opts.job) && !asked,
      twoAgents: teamName.includes("+"),
    },
    handles,
    selectedJobId: selected?.jobId ?? null,
    technical: {
      roomId: room.roomId,
      jobs: jobs.slice(0, 20).map((j) => ({
        goal: trim(j.goal, 60),
        jobId: j.jobId,
        selected: selected?.jobId === j.jobId,
      })),
      units: detail ? detail.nodes.map((n) => ({ title: n.title, key: n.key })) : [],
    },
  };
}
