/**
 * Task graph for a team job: validation, readiness, overlap serialisation,
 * scheduling and integration order. docs/design/team-mode.md §3.5.
 *
 * Overlap rule: two writing nodes whose declared files could touch the same
 * path must not run concurrently. The later node (in deterministic order)
 * gets an implicit dependency on the earlier one, and each such serialisation
 * is recorded with a reason. The analysis is deliberately conservative: when
 * it cannot prove two patterns are disjoint, it treats them as overlapping. A
 * writing node that declares no files overlaps everything; a `readOnly` node
 * overlaps nothing.
 *
 * Pure: no filesystem, no clock. Graphs are small (a handful of nodes), but
 * everything here is polynomial and memoised where it matters.
 */

import type { NodeStatus } from "./types.ts";

export type DagNode = {
  key: string;
  deps: readonly string[];
  /** Paths or globs the node may write, e.g. "lib/reports/**", "supabase/migrations/*.sql". */
  files?: readonly string[];
  /** Reads only: never conflicts with another node. */
  readOnly?: boolean;
};

export type GraphError =
  | { kind: "empty_key"; index: number }
  | { kind: "duplicate_key"; key: string }
  | { kind: "unknown_dep"; key: string; dep: string }
  | { kind: "self_dep"; key: string }
  | { kind: "cycle"; cycle: string[] };

export type GraphValidation = { ok: true } | { ok: false; errors: GraphError[] };

export type Serialisation = {
  /** Runs first. */
  before: string;
  /** Waits for `before`. */
  after: string;
  reason: string;
};

export type OverlapAnalysis = {
  /** Declared deps plus implicit overlap deps, per node key. */
  deps: Map<string, string[]>;
  serialisations: Serialisation[];
};

export type Statuses = ReadonlyMap<string, NodeStatus> | Readonly<Record<string, NodeStatus>>;

/** A dependency counts as done once its work is approved or integrated. */
const DONE: ReadonlySet<NodeStatus> = new Set(["approved", "integrated"]);
/** Not started yet, so it may be started. */
const STARTABLE: ReadonlySet<NodeStatus> = new Set(["pending", "ready"]);
/** Work in flight: occupies an agent slot and its files. */
const IN_FLIGHT: ReadonlySet<NodeStatus> = new Set(["running", "in_review", "changes_requested"]);

function statusOf(statuses: Statuses, key: string): NodeStatus {
  const s =
    statuses instanceof Map
      ? statuses.get(key)
      : (statuses as Readonly<Record<string, NodeStatus>>)[key];
  return s ?? "pending";
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateGraph(nodes: readonly DagNode[]): GraphValidation {
  const errors: GraphError[] = [];
  const keys = new Set<string>();
  nodes.forEach((n, index) => {
    if (typeof n.key !== "string" || n.key.trim() === "") errors.push({ kind: "empty_key", index });
    else if (keys.has(n.key)) errors.push({ kind: "duplicate_key", key: n.key });
    else keys.add(n.key);
  });
  for (const n of nodes) {
    for (const dep of n.deps) {
      if (dep === n.key) errors.push({ kind: "self_dep", key: n.key });
      else if (!keys.has(dep)) errors.push({ kind: "unknown_dep", key: n.key, dep });
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(nodes);
    if (cycle) errors.push({ kind: "cycle", cycle });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Returns one cycle as [a, b, …, a], or null. Deterministic (sorted keys). */
function findCycle(nodes: readonly DagNode[]): string[] | null {
  const deps = new Map(nodes.map((n) => [n.key, [...n.deps].sort()]));
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    state.set(key, 1);
    stack.push(key);
    for (const dep of deps.get(key) ?? []) {
      const s = state.get(dep);
      if (s === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (s === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };
  for (const key of [...deps.keys()].sort()) {
    if (state.get(key) === undefined) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}

function assertValid(nodes: readonly DagNode[]): void {
  const v = validateGraph(nodes);
  if (!v.ok) {
    throw new Error(`Invalid task graph: ${v.errors.map((e) => JSON.stringify(e)).join(", ")}`);
  }
}

// ── Ordering ──────────────────────────────────────────────────────────────────

function topoOrder(
  keys: readonly string[],
  deps: ReadonlyMap<string, readonly string[]>,
): string[] {
  const indegree = new Map(keys.map((k) => [k, (deps.get(k) ?? []).length]));
  const dependents = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const k of keys) for (const d of deps.get(k) ?? []) dependents.get(d)!.push(k);
  const ready = keys.filter((k) => indegree.get(k) === 0).sort();
  const out: string[] = [];
  while (ready.length) {
    const k = ready.shift()!;
    out.push(k);
    for (const next of dependents.get(k)!) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) {
        // Insert keeping `ready` sorted: key is the tiebreak.
        let i = 0;
        while (i < ready.length && ready[i]! < next) i++;
        ready.splice(i, 0, next);
      }
    }
  }
  if (out.length !== keys.length) throw new Error("Invalid task graph: cycle");
  return out;
}

/**
 * Deterministic merge order for integration: topological over declared and
 * overlap dependencies, smallest key first among equals.
 */
export function integrationOrder(nodes: readonly DagNode[]): string[] {
  const { deps } = analyseOverlap(nodes);
  return topoOrder(
    nodes.map((n) => n.key),
    deps,
  );
}

// ── Overlap ───────────────────────────────────────────────────────────────────

const GLOB_CHARS = /[*?[\]{}]/;
const MAX_BRACE_EXPANSION = 64;

/** Normalise a declared path/glob into segment lists (after brace expansion). */
function normalisePattern(raw: string): string[][] {
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+/g, "/").replace(/\/$/, "");
  // Empty, absolute or escaping paths: unknown scope → everything.
  if (p === "" || p === "." || p.startsWith("/") || /^[a-z]:/i.test(p)) return [["**"]];
  const expanded = expandBraces(p);
  if (!expanded) return [["**"]];
  return expanded.map((e) => {
    const segs = e.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.includes("..")) return ["**"];
    // A plain path names a file or a directory: it covers everything under it.
    if (!GLOB_CHARS.test(e)) segs.push("**");
    return segs;
  });
}

function expandBraces(p: string): string[] | null {
  const open = p.indexOf("{");
  if (open < 0) return [p];
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < p.length; i++) {
    if (p[i] === "{") depth++;
    else if (p[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (p[i] === "," && depth === 1) commas.push(i);
  }
  if (close < 0) return null; // unbalanced: be conservative
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const alt = p.slice(bounds[i]! + 1, bounds[i + 1]!);
    const rest = expandBraces(p.slice(0, open) + alt + p.slice(close + 1));
    if (!rest) return null;
    out.push(...rest);
    if (out.length > MAX_BRACE_EXPANSION) return null;
  }
  return out;
}

function segmentRegex(glob: string): RegExp | null {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) return null;
      let cls = glob.slice(i + 1, end);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  try {
    // Case-insensitive: a Windows checkout treats A.ts and a.ts as one file.
    return new RegExp(`^${re}$`, "i");
  } catch {
    return null;
  }
}

function literalAffixes(glob: string): { prefix: string; suffix: string } {
  const first = glob.search(GLOB_CHARS);
  let last = -1;
  for (let i = glob.length - 1; i >= 0; i--) {
    if (GLOB_CHARS.test(glob[i]!)) {
      last = i;
      break;
    }
  }
  return { prefix: glob.slice(0, first).toLowerCase(), suffix: glob.slice(last + 1).toLowerCase() };
}

/** Could one path segment match both? Unsure → true. */
function segmentsIntersect(a: string, b: string): boolean {
  const ga = GLOB_CHARS.test(a);
  const gb = GLOB_CHARS.test(b);
  if (!ga && !gb) return a.toLowerCase() === b.toLowerCase();
  if (ga && gb) {
    const x = literalAffixes(a);
    const y = literalAffixes(b);
    const prefixOk = x.prefix.startsWith(y.prefix) || y.prefix.startsWith(x.prefix);
    const suffixOk = x.suffix.endsWith(y.suffix) || y.suffix.endsWith(x.suffix);
    return prefixOk && suffixOk;
  }
  const [literal, glob] = ga ? [b, a] : [a, b];
  const re = segmentRegex(glob);
  return re ? re.test(literal) : true;
}

function segmentListsIntersect(a: readonly string[], b: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = `${i},${j}`;
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === "**") r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    else if (j < b.length && b[j] === "**") r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = segmentsIntersect(a[i]!, b[j]!) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

/** Could two declared path/glob patterns name a common file? Unsure → true. */
export function patternsOverlap(a: string, b: string): boolean {
  for (const x of normalisePattern(a)) {
    for (const y of normalisePattern(b)) {
      if (segmentListsIntersect(x, y)) return true;
    }
  }
  return false;
}

/** Why two nodes conflict, or null when they may run concurrently. */
export function conflictReason(a: DagNode, b: DagNode): string | null {
  if (a.readOnly || b.readOnly) return null;
  const af = a.files ?? [];
  const bf = b.files ?? [];
  if (af.length === 0 || bf.length === 0) {
    const vague = [af.length === 0 ? a.key : null, bf.length === 0 ? b.key : null]
      .filter(Boolean)
      .join(" and ");
    return `${vague} declare${vague.includes(" and ") ? "" : "s"} no files, so may touch anything`;
  }
  for (const x of af) {
    for (const y of bf) {
      if (patternsOverlap(x, y)) return `"${x}" (${a.key}) may overlap "${y}" (${b.key})`;
    }
  }
  return null;
}

/**
 * Add an implicit dependency between every pair of conflicting nodes that is
 * not already ordered. The earlier node is the one first in the declared
 * topological order (key tiebreak), so no cycle can be introduced.
 */
export function analyseOverlap(nodes: readonly DagNode[]): OverlapAnalysis {
  assertValid(nodes);
  const keys = nodes.map((n) => n.key);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const deps = new Map(nodes.map((n) => [n.key, [...n.deps]]));
  const order = topoOrder(keys, deps);

  // ancestors[k] = every node k (transitively) waits for.
  const ancestors = new Map<string, Set<string>>();
  for (const k of order) {
    const set = new Set<string>();
    for (const d of deps.get(k)!) {
      set.add(d);
      for (const a of ancestors.get(d)!) set.add(a);
    }
    ancestors.set(k, set);
  }

  const serialisations: Serialisation[] = [];
  for (let j = 0; j < order.length; j++) {
    const later = order[j]!;
    // Nearest first, so an edge already implied through a closer node is skipped.
    for (let i = j - 1; i >= 0; i--) {
      const earlier = order[i]!;
      if (ancestors.get(later)!.has(earlier)) continue; // already ordered
      const why = conflictReason(byKey.get(earlier)!, byKey.get(later)!);
      if (!why) continue;
      deps.get(later)!.push(earlier);
      const anc = ancestors.get(later)!;
      anc.add(earlier);
      for (const a of ancestors.get(earlier)!) anc.add(a);
      serialisations.push({
        before: earlier,
        after: later,
        reason: `Serialised ${later} after ${earlier}: ${why}.`,
      });
    }
    // Later nodes that depend on `later` inherit its new ancestors.
    for (let k = j + 1; k < order.length; k++) {
      const node = order[k]!;
      if (ancestors.get(node)!.has(later)) {
        for (const a of ancestors.get(later)!) ancestors.get(node)!.add(a);
      }
    }
  }
  return { deps, serialisations };
}

// ── Readiness and scheduling ──────────────────────────────────────────────────

/**
 * Nodes that may start now: not started, and every dependency (declared or
 * implicit overlap) approved or integrated. In integration order.
 */
export function readyNodes(nodes: readonly DagNode[], statuses: Statuses): string[] {
  const { deps } = analyseOverlap(nodes);
  const order = topoOrder(
    nodes.map((n) => n.key),
    deps,
  );
  return order.filter(
    (k) =>
      STARTABLE.has(statusOf(statuses, k)) &&
      deps.get(k)!.every((d) => DONE.has(statusOf(statuses, d))),
  );
}

/**
 * The next batch to start: ready nodes, in integration order, that do not
 * conflict with work in flight or with each other, within the parallel limit
 * (in-flight nodes count against it).
 */
export function schedule(
  nodes: readonly DagNode[],
  statuses: Statuses,
  parallelLimit: number,
): string[] {
  if (!Number.isInteger(parallelLimit) || parallelLimit < 1) {
    throw new RangeError("parallelLimit must be an integer ≥ 1");
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const inFlight = nodes.filter((n) => IN_FLIGHT.has(statusOf(statuses, n.key)));
  let slots = parallelLimit - inFlight.length;
  const batch: DagNode[] = [];
  for (const key of readyNodes(nodes, statuses)) {
    if (slots <= 0) break;
    const node = byKey.get(key)!;
    if ([...inFlight, ...batch].some((other) => conflictReason(other, node) !== null)) continue;
    batch.push(node);
    slots--;
  }
  return batch.map((n) => n.key);
}
