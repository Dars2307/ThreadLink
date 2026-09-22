import "server-only";

import { requireThreadLinkUser, type ThreadLinkUser } from "@/lib/auth/threadlink-user";
import type { Connection } from "@/lib/connections/model";
import { listMyConnections } from "@/lib/connections/repository";
import type { ThreadLinkView } from "@/lib/pairing/model";
import { listMyRuntimes, type OwnerRuntime, type OwnerWorkspace } from "@/lib/runtimes/queries";
import type { OwnerSession } from "@/lib/sessions/queries";
import { listMyRecentTasks, listMySessions, listMyThreadLinks } from "@/lib/sessions/repository";
import type { RecentTask } from "@/lib/tasks/queries";

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
