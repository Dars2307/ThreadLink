import "server-only";

import { z } from "zod";

import { requireThreadLinkUser } from "@/lib/auth/threadlink-user";
import { OwnershipViolationError } from "@/lib/connections/model";
import { createUserSupabaseClient } from "@/lib/supabase/server";

/**
 * Dashboard reads of Runtimes (devices/environments) and their workspaces.
 * USER-SCOPED client (RLS) plus an owner re-check on every row.
 */

export const RUNTIME_ONLINE_WINDOW_MS = 3 * 60_000;

const runtimeSchema = z.object({
  id: z.string().regex(/^tlrun_[0-9a-f]{32}$/),
  owner_user_id: z.string(),
  label: z.string(),
  platform: z.enum(["windows", "macos", "linux", "other"]),
  kind: z.enum(["desktop", "cli", "remote"]),
  version: z.string().nullable(),
  capabilities: z.record(z.string(), z.string()),
  settings: z.record(z.string(), z.boolean()),
  paused: z.boolean(),
  status: z.enum(["active", "revoked"]),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
});

const workspaceSchema = z.object({
  id: z.string().regex(/^tlwsp_[0-9a-f]{32}$/),
  owner_user_id: z.string(),
  runtime_id: z.string(),
  display_name: z.string(),
  path: z.string().nullable(),
  repo_remote: z.string().nullable(),
  branch: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

export type OwnerRuntime = {
  runtimeId: string;
  label: string;
  platform: "windows" | "macos" | "linux" | "other";
  kind: "desktop" | "cli" | "remote";
  version: string | null;
  capabilities: Record<string, string>;
  settings: Record<string, boolean>;
  paused: boolean;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
};

export type OwnerWorkspace = {
  workspaceId: string;
  runtimeId: string;
  name: string;
  path: string | null;
  repoRemote: string | null;
  branch: string | null;
};

export async function listMyRuntimes(): Promise<{
  runtimes: OwnerRuntime[];
  workspaces: OwnerWorkspace[];
}> {
  const user = await requireThreadLinkUser();
  const db = createUserSupabaseClient();
  const [runtimes, workspaces] = await Promise.all([
    db
      .from("runtimes")
      .select(
        "id, owner_user_id, label, platform, kind, version, capabilities, settings, paused, status, created_at, last_seen_at",
      )
      .order("created_at", { ascending: true })
      .limit(100),
    db
      .from("runtime_workspaces")
      .select(
        "id, owner_user_id, runtime_id, display_name, path, repo_remote, branch, last_seen_at",
      )
      .order("last_seen_at", { ascending: false })
      .limit(500),
  ]);
  if (runtimes.error || workspaces.error) throw new Error("Failed to load runtimes");
  const rRows = z.array(runtimeSchema).parse(runtimes.data);
  const wRows = z.array(workspaceSchema).parse(workspaces.data);
  if ([...rRows, ...wRows].some((row) => row.owner_user_id !== user.id)) {
    throw new OwnershipViolationError();
  }
  return {
    runtimes: rRows.map((r) => ({
      runtimeId: r.id,
      label: r.label,
      platform: r.platform,
      kind: r.kind,
      version: r.version,
      capabilities: r.capabilities,
      settings: r.settings,
      paused: r.paused,
      status: r.status,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    })),
    workspaces: wRows.map((w) => ({
      workspaceId: w.id,
      runtimeId: w.runtime_id,
      name: w.display_name,
      path: w.path,
      repoRemote: w.repo_remote,
      branch: w.branch,
    })),
  };
}

export function runtimeOnline(runtime: OwnerRuntime | undefined, now: number): boolean {
  if (!runtime?.lastSeenAt || runtime.status !== "active") return false;
  return now - new Date(runtime.lastSeenAt).getTime() < RUNTIME_ONLINE_WINDOW_MS;
}

export const PLATFORM_NAMES: Record<OwnerRuntime["platform"], string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  other: "Other",
};

export const KIND_NAMES: Record<OwnerRuntime["kind"], string> = {
  desktop: "Desktop app",
  cli: "Command line",
  remote: "Remote environment",
};
