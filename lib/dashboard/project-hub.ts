import { oneLine } from "./safe-text";
import { hostView, type HostView } from "./timeline";

/**
 * Project hub (brief §61, §90–91): repository and execution host, verification
 * commands, routing and artifacts. Pure. Verification commands are shown as
 * configured by the owner; suggestions come ONLY from tooling the ThreadLink
 * app detected and are never run automatically.
 */

export type ProjectHubView = {
  host: HostView | null;
  repository: { branch: string | null; remote: string | null; folder: string | null } | null;
  verification: {
    commands: string[];
    empty: string | null;
    howTo: string;
    suggestions: string[];
    suggestionNote: string | null;
  };
  artifacts: { key: string; title: string; kind: string; chatId: string; artifactId: string }[];
};

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Tool → the conventional check command. Only tools the app detected are ever suggested. */
const TOOL_COMMANDS: Record<string, string[]> = {
  npm: ["npm test"],
  pnpm: ["pnpm test"],
  yarn: ["yarn test"],
  bun: ["bun test"],
  vitest: ["npx vitest run"],
  jest: ["npx jest"],
  typescript: ["npx tsc --noEmit"],
  eslint: ["npx eslint ."],
  pytest: ["pytest"],
  ruff: ["ruff check ."],
  mypy: ["mypy ."],
  cargo: ["cargo test"],
  go: ["go test ./..."],
  dotnet: ["dotnet test"],
  gradle: ["./gradlew test"],
  maven: ["mvn test"],
};

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => oneLine(x, 200))
        .filter(Boolean)
        .slice(0, max)
    : [];

export function projectHub(
  hub: Record<string, unknown> | null,
  opts: { projectName: string; controller: string; now: number },
): ProjectHubView {
  const h = hub ?? {};
  const hostRaw = (h.executionHost ?? h.runtime) as Record<string, unknown> | undefined;
  const host =
    hostRaw && typeof hostRaw === "object" && typeof hostRaw.label === "string"
      ? hostView(
          {
            label: hostRaw.label,
            online: typeof hostRaw.online === "boolean" ? hostRaw.online : null,
            lastSeenAt: typeof hostRaw.lastSeenAt === "string" ? hostRaw.lastSeenAt : null,
            working: hostRaw.working === true,
            protocolOutdated: hostRaw.protocolOutdated === true,
          },
          opts.now,
        )
      : null;
  const repo = (h.repository && typeof h.repository === "object" ? h.repository : null) as Record<
    string,
    unknown
  > | null;
  const commands = strings(h.verificationCommands, 20);
  const detected = strings(h.detectedTooling, 30).map((t) => t.toLowerCase());
  const suggestions = commands.length
    ? []
    : [...new Set(detected.flatMap((t) => TOOL_COMMANDS[t] ?? []))].slice(0, 6);
  const artifacts = (Array.isArray(h.artifacts) ? h.artifacts : [])
    .map((a, i) => {
      const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      const chatId = typeof r.chatId === "string" && ID.test(r.chatId) ? r.chatId : null;
      const artifactId =
        typeof r.artifactId === "string" && ID.test(r.artifactId) ? r.artifactId : null;
      if (!chatId || !artifactId) return null;
      return {
        key: `pa${i}`,
        title: oneLine(r.title ?? "Artifact", 120),
        kind: oneLine(r.kind ?? "notes", 30),
        chatId,
        artifactId,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .slice(0, 20);
  return {
    host,
    repository: repo
      ? {
          branch: typeof repo.branch === "string" ? oneLine(repo.branch, 120) : null,
          remote: typeof repo.remote === "string" ? oneLine(repo.remote, 200) : null,
          folder: typeof repo.folder === "string" ? oneLine(repo.folder, 200) : null,
        }
      : null,
    verification: {
      commands,
      empty: commands.length ? null : "No project verification commands configured.",
      howTo: `Ask ${opts.controller} to “set the verification commands for ${opts.projectName}”, or add them in the ThreadLink app on your computer. Until then, agents run only the checks each request asks for.`,
      suggestions,
      suggestionNote: suggestions.length
        ? "Suggested from the tooling ThreadLink found in this folder. Nothing runs until you add it."
        : null,
    },
    artifacts,
  };
}
