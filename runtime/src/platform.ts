import { hostname } from "node:os";

/**
 * What kind of environment this Runtime runs in. Self-description only: the
 * server never derives ownership or permissions from it.
 */
export type RuntimePlatform = "windows" | "macos" | "linux" | "other";
export type RuntimeKind = "desktop" | "cli" | "remote";

export type RuntimeIdentity = { label: string; platform: RuntimePlatform; kind: RuntimeKind };

export function runtimePlatform(p: NodeJS.Platform = process.platform): RuntimePlatform {
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return "other";
}

/** Remote dev environments (Codespaces, dev containers, SSH, Gitpod, cloud shells). */
export function remoteEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CODESPACES === "true") return `Codespace ${env.CODESPACE_NAME ?? ""}`.trim();
  if (env.GITPOD_WORKSPACE_ID) return "Gitpod workspace";
  if (env.REMOTE_CONTAINERS === "true" || env.DEVCONTAINER === "true") return "Dev container";
  if (env.CLOUD_SHELL === "true") return "Cloud Shell";
  if (env.SSH_CONNECTION || env.SSH_TTY) return `SSH host ${hostname()}`;
  return null;
}

export function detectIdentity(
  options: { kind?: RuntimeKind; label?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
  p: NodeJS.Platform = process.platform,
): RuntimeIdentity {
  const remote = remoteEnvironment(env);
  const kind = options.kind === "desktop" ? "desktop" : remote ? "remote" : (options.kind ?? "cli");
  const label = (options.label ?? remote ?? hostname() ?? "ThreadLink Runtime").slice(0, 100);
  return { label: label || "ThreadLink Runtime", platform: runtimePlatform(p), kind };
}
