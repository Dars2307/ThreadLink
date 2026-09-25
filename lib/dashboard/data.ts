import "server-only";

import { requireThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { Connection } from "@/lib/connections/model";
import { listMyConnections } from "@/lib/connections/repository";
import type { ThreadLinkView } from "@/lib/pairing/model";
import type { OwnerProviderProfile } from "@/lib/providers/queries";
import { listMyProviderProfiles } from "@/lib/providers/repository";
import { listMyRooms } from "@/lib/rooms/repository";
import { listMyRuntimes, type OwnerRuntime, type OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import { listMyRecentTasks, listMySessions, listMyThreadLinks } from "@/lib/sessions/repository";
import type { RecentTask } from "@/lib/tasks/queries";
import { getMyJobDetail, listMyRoomJobs } from "@/lib/team/owner";

import type { JobDetail, TeamData } from "./pages";

/** Everything the dashboard pages read, loaded once per request. */
export type DashboardAccount = {
  user: ThreadLinkUser;
  connections: Connection[];
  sessions: OwnerSession[];
  links: ThreadLinkView[];
  tasks: RecentTask[];
  runtimes: OwnerRuntime[];
  workspaces: OwnerWorkspace[];
  now: number;
};

export async function loadAccount(): Promise<DashboardAccount | null> {
  try {
    const user = await requireThreadLinkUser();
    const [connections, sessions, links, tasks, runtimeData] = await Promise.all([
      listMyConnections(),
      listMySessions(),
      listMyThreadLinks(),
      listMyRecentTasks(),
      listMyRuntimes(),
    ]);
    return {
      user,
      connections,
      sessions,
      links,
      tasks,
      runtimes: runtimeData.runtimes,
      workspaces: runtimeData.workspaces,
      now: Date.now(),
    };
  } catch {
    // Fail closed without leaking why (auth, database or mapping failure).
    return null;
  }
}

/** Bounds on how much Team Mode data one page load reads. */
const ROOMS_WITH_JOBS = 12;
const DETAILED_JOBS = 8;

/**
 * Projects, their team jobs and provider profiles, through the owner read
 * functions in lib/rooms, lib/team and lib/providers (RLS + owner re-check).
 * Bounded: jobs for at most 12 rooms and full detail for at most 8 jobs
 * (running ones first). Returns null on any failure: pages then say the team
 * data could not be loaded instead of showing a partial picture.
 */
export async function loadTeam(
  opts: { details?: boolean } = {},
): Promise<(TeamData & { now: number }) | null> {
  try {
    const [rooms, profiles] = await Promise.all([listMyRooms(), listMyProviderProfiles()]);
    const withJobs = rooms.filter((r) => r.jobs.total > 0).slice(0, ROOMS_WITH_JOBS);
    const lists = await Promise.all(withJobs.map((r) => listMyRoomJobs(r.roomId)));
    const jobsByRoom: TeamData["jobsByRoom"] = {};
    withJobs.forEach((r, i) => (jobsByRoom[r.roomId] = lists[i]!));

    let details: JobDetail[] = [];
    if (opts.details !== false) {
      const all = Object.values(jobsByRoom)
        .flat()
        .sort(
          (a, b) =>
            Number(a.finished) - Number(b.finished) ||
            Date.parse(b.startedAt) - Date.parse(a.startedAt),
        )
        .slice(0, DETAILED_JOBS);
      const loaded = await Promise.all(all.map((j) => getMyJobDetail(j.jobId)));
      details = loaded.filter((d): d is NonNullable<typeof d> => d !== null);
    }
    return { rooms, jobsByRoom, details, profiles, now: Date.now() };
  } catch {
    return null;
  }
}

/** One job's full detail plus its project name, or null (not found / not yours / failure). */
export async function loadJob(
  jobId: string,
): Promise<{ detail: JobDetail; project: string; now: number } | null> {
  try {
    const detail = await getMyJobDetail(jobId);
    if (!detail) return null;
    const rooms = await listMyRooms();
    // The job belongs to one of the owner's rooms; find its name by listing
    // that room's jobs (the detail itself carries no room name).
    const candidates = rooms.filter((r) => r.jobs.total > 0).slice(0, ROOMS_WITH_JOBS * 2);
    const lists = await Promise.all(candidates.map((r) => listMyRoomJobs(r.roomId)));
    const index = lists.findIndex((jobs) => jobs.some((j) => j.jobId === detail.jobId));
    return {
      detail,
      project: index >= 0 ? candidates[index]!.name : "Project",
      now: Date.now(),
    };
  } catch {
    return null;
  }
}

/** The owner's provider profiles (plan, policy, paid usage, detection), or null. */
export async function loadProviders(): Promise<{
  profiles: OwnerProviderProfile[];
  now: number;
} | null> {
  try {
    return { profiles: await listMyProviderProfiles(), now: Date.now() };
  } catch {
    return null;
  }
}
