import type { Tone } from "./labels";
import { KNOWN_PROVIDER_IDS, providerDisplay } from "./providers-display";

/**
 * The provider registry as the web UI uses it (docs/design/threadlink-0.10.md
 * §1). The server's `public.agent_providers` rows win; the local table in
 * providers-display is only a fallback while the server list is unavailable.
 * Everything that names, colours or @mentions a provider goes through here —
 * there is no `switch (provider)` anywhere in the chat UI. Pure.
 */

export type RegistryEntry = {
  id: string;
  name: string;
  shortName: string;
  /** Lowercase @mention aliases, e.g. ["claude", "claudecode"]. */
  aliases: string[];
  supported: boolean;
  sort: number;
  /** Identity colour for bubbles and chips. Assigned from the palette by order. */
  tone: Tone;
};

export type Registry = {
  entries: RegistryEntry[];
  byId: Map<string, RegistryEntry>;
  /** alias → provider id */
  byAlias: Map<string, string>;
  /** True when built from the server's list (false: local fallback). */
  fromServer: boolean;
};

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,29}$/;
/** Agent identity palette. Controller/owner/ThreadLink never use these. */
const PALETTE: Tone[] = ["accent", "success", "warning", "danger"];

const LOCAL_ALIASES: Record<string, string[]> = {
  "claude-code": ["claude", "claudecode"],
  codex: ["codex"],
};
const LOCAL_EXTRA: { id: string; name: string }[] = [
  { id: "windsurf", name: "Windsurf" },
  { id: "gemini-cli", name: "Gemini CLI" },
];

const str = (v: unknown, max = 60): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function entryFrom(raw: unknown, index: number): Omit<RegistryEntry, "tone"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40);
  if (!id || !ID.test(id)) return null;
  const name = str(r.displayName) ?? str(r.display_name) ?? str(r.name) ?? providerDisplay(id).name;
  const shortName = str(r.shortName) ?? str(r.short_name) ?? name;
  const rawAliases = r.mentionAliases ?? r.mention_aliases ?? r.aliases;
  const aliases = Array.isArray(rawAliases)
    ? rawAliases
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim().toLowerCase().replace(/^@/, ""))
        .filter((a) => ALIAS.test(a))
        .slice(0, 8)
    : [];
  const sort = typeof r.sort === "number" && Number.isFinite(r.sort) ? r.sort : index;
  return { id, name, shortName, aliases, supported: r.supported === true, sort };
}

/**
 * Builds the registry. `rows` null (server list unavailable) → local fallback.
 * Tones are assigned in sort order among supported providers so two agents
 * never share a colour by accident; unsupported ones stay neutral.
 */
export function buildRegistry(rows: unknown[] | null): Registry {
  let base: Omit<RegistryEntry, "tone">[];
  const fromServer = Array.isArray(rows) && rows.length > 0;
  if (fromServer) {
    const seen = new Set<string>();
    base = rows!
      .map(entryFrom)
      .filter(
        (e): e is Omit<RegistryEntry, "tone"> =>
          e !== null && !seen.has(e.id) && Boolean(seen.add(e.id)),
      );
  } else {
    base = [
      ...KNOWN_PROVIDER_IDS.map((id, i) => {
        const d = providerDisplay(id);
        return {
          id: d.id,
          name: d.name,
          shortName: d.shortName,
          aliases: LOCAL_ALIASES[d.id] ?? [],
          supported: d.supported,
          sort: i,
        };
      }),
      ...LOCAL_EXTRA.map((x, i) => ({
        id: x.id,
        name: x.name,
        shortName: x.name,
        aliases: [],
        supported: false,
        sort: 100 + i,
      })),
    ];
  }
  base.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  let colour = 0;
  const entries: RegistryEntry[] = base.map((e) => ({
    ...e,
    tone: e.supported ? PALETTE[colour++ % PALETTE.length]! : "neutral",
  }));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byAlias = new Map<string, string>();
  for (const e of entries) {
    if (!e.supported) continue;
    for (const a of [...e.aliases, e.id]) if (!byAlias.has(a)) byAlias.set(a, e.id);
  }
  return { entries, byId, byAlias, fromServer };
}

/**
 * Display metadata for any provider id, including ids the registry has never
 * seen: a generic entry built from the id (or a server label), neutral colour.
 */
export function registryEntry(
  registry: Registry,
  id: string | null | undefined,
  fallbackName?: string | null,
): RegistryEntry {
  const known = id
    ? (registry.byId.get(id) ?? registry.byId.get(providerDisplay(id).id))
    : undefined;
  if (known) return known;
  const d = providerDisplay(id, fallbackName);
  return {
    id: d.id,
    name: d.name,
    shortName: d.shortName,
    aliases: [],
    supported: false,
    sort: 999,
    tone: "neutral",
  };
}

export type MentionOption = {
  /** Inserted text, e.g. "@claude ". */
  insert: string;
  label: string;
  description: string;
  providerId: string | null;
};

/**
 * @mention options for a chat: each agent in the chat (its first alias, else
 * its id) plus @team when two or more agents are present. From the registry.
 */
export function mentionOptions(registry: Registry, agentIds: string[]): MentionOption[] {
  const ids = [...new Set(agentIds.map((id) => registryEntry(registry, id).id))];
  const out: MentionOption[] = [];
  for (const id of ids) {
    const e = registryEntry(registry, id);
    if (!e.supported) continue;
    const alias = e.aliases[0] ?? e.id;
    out.push({
      insert: `@${alias} `,
      label: `@${alias}`,
      description: `Ask ${e.name}`,
      providerId: e.id,
    });
  }
  if (ids.length >= 2) {
    out.push({
      insert: "@team ",
      label: "@team",
      description: "Ask every agent",
      providerId: null,
    });
  }
  return out;
}

/** Filters mention options by what the user typed after "@". */
export function filterMentions(options: MentionOption[], typed: string): MentionOption[] {
  const q = typed.toLowerCase();
  return options.filter((o) => o.label.slice(1).startsWith(q));
}

/** The provider a leading @mention names (via aliases), "team", or null. Hint only: the server decides. */
export function mentionTarget(registry: Registry, body: string): string | null {
  const m = /^\s*@([a-z][a-z0-9_-]{0,29})\b/i.exec(body);
  if (!m) return null;
  const alias = m[1]!.toLowerCase();
  if (alias === "team") return "team";
  return registry.byAlias.get(alias) ?? null;
}

/** The "@word" being typed at the caret, for the mention menu; null when not in a mention. */
export function mentionAtCaret(
  text: string,
  caret: number,
): { start: number; typed: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([a-z0-9_-]{0,30})$/i.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, typed: m[2]! };
}
