import { describe, expect, it } from "vitest";

import {
  analyseOverlap,
  conflictReason,
  integrationOrder,
  patternsOverlap,
  readyNodes,
  schedule,
  validateGraph,
  type DagNode,
} from "../../runtime/src/team/dag.ts";
import type { NodeStatus } from "../../runtime/src/team/types.ts";

const n = (key: string, deps: string[] = [], files?: string[], readOnly?: boolean): DagNode => ({
  key,
  deps,
  ...(files ? { files } : {}),
  ...(readOnly ? { readOnly } : {}),
});

describe("validateGraph", () => {
  it("accepts a valid DAG", () => {
    expect(validateGraph([n("a"), n("b", ["a"]), n("c", ["a", "b"])])).toEqual({ ok: true });
    expect(validateGraph([])).toEqual({ ok: true });
  });

  it("detects a cycle and reports it", () => {
    const v = validateGraph([n("a", ["c"]), n("b", ["a"]), n("c", ["b"]), n("d")]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const cycle = v.errors.find((e) => e.kind === "cycle");
    expect(cycle).toEqual({ kind: "cycle", cycle: ["a", "c", "b", "a"] });
  });

  it("detects a two-node cycle", () => {
    const v = validateGraph([n("x", ["y"]), n("y", ["x"])]);
    expect(v.ok ? null : v.errors).toEqual([{ kind: "cycle", cycle: ["x", "y", "x"] }]);
  });

  it("rejects unknown deps, duplicates, self deps and empty keys", () => {
    const v = validateGraph([n("a", ["ghost"]), n("a"), n("b", ["b"]), n("  ")]);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toEqual(
      expect.arrayContaining([
        { kind: "unknown_dep", key: "a", dep: "ghost" },
        { kind: "duplicate_key", key: "a" },
        { kind: "self_dep", key: "b" },
        { kind: "empty_key", index: 3 },
      ]),
    );
  });

  it("other functions refuse an invalid graph", () => {
    const bad = [n("a", ["b"]), n("b", ["a"])];
    expect(() => integrationOrder(bad)).toThrow(/Invalid task graph/);
    expect(() => readyNodes(bad, {})).toThrow();
    expect(() => schedule(bad, {}, 2)).toThrow();
  });
});

describe("patternsOverlap", () => {
  it.each([
    ["lib/reports/**", "lib/reports/export.ts", true],
    ["lib/reports", "lib/reports/export.ts", true],
    ["lib/reports/", "lib/reports/pdf/render.ts", true],
    ["supabase/migrations/*.sql", "supabase/migrations/2026_team.sql", true],
    ["supabase/migrations/*.sql", "supabase/migrations/readme.md", false],
    ["supabase/migrations/*.sql", "supabase/migrations/nested/x.sql", false],
    ["lib/reports/**", "lib/auth/**", false],
    ["lib/**/*.ts", "lib/auth/session.ts", true],
    ["**/*.test.ts", "tests/runtime/x.test.ts", true],
    ["app/*.tsx", "app/*.css", false],
    ["app/page*", "app/*.tsx", true],
    ["lib/{auth,rooms}/**", "lib/rooms/x.ts", true],
    ["lib/{auth,rooms}/**", "lib/team/x.ts", false],
    ["./lib\\auth\\x.ts", "lib/auth/x.ts", true],
    ["LIB/Auth.ts", "lib/auth.ts", true],
    ["README.md", "docs/README.md", false],
  ] as const)("%s vs %s → %s", (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });

  it.each(["", ".", "/etc/passwd", "C:/Users/x", "../outside/**", "lib/{unbalanced"])(
    "an unclear pattern %j is treated as touching everything",
    (p) => {
      expect(patternsOverlap(p, "anything/at/all.ts")).toBe(true);
    },
  );
});

describe("overlap serialisation", () => {
  it("overlapping nodes are serialised with a recorded reason", () => {
    const nodes = [
      n("reports-api", [], ["lib/reports/**"]),
      n("reports-pdf", [], ["lib/reports/pdf/render.ts"]),
    ];
    const { deps, serialisations } = analyseOverlap(nodes);
    expect(deps.get("reports-pdf")).toEqual(["reports-api"]);
    expect(serialisations).toEqual([
      {
        before: "reports-api",
        after: "reports-pdf",
        reason: expect.stringMatching(
          /Serialised reports-pdf after reports-api: "lib\/reports\/\*\*" \(reports-api\) may overlap "lib\/reports\/pdf\/render.ts" \(reports-pdf\)/,
        ),
      },
    ]);
    expect(schedule(nodes, {}, 4)).toEqual(["reports-api"]);
  });

  it("disjoint nodes run in parallel", () => {
    const nodes = [
      n("auth", [], ["lib/auth/**"]),
      n("migration", [], ["supabase/migrations/*.sql"]),
      n("ui", [], ["app/dashboard/**", "components/**"]),
    ];
    expect(analyseOverlap(nodes).serialisations).toEqual([]);
    expect(schedule(nodes, {}, 4)).toEqual(["auth", "migration", "ui"]);
  });

  it("a node with no declared files overlaps everything", () => {
    const nodes = [n("a", [], ["lib/a/**"]), n("b", [], []), n("c")];
    const { serialisations } = analyseOverlap(nodes);
    expect(serialisations.map((s) => [s.before, s.after])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(serialisations[0]!.reason).toMatch(/b declares no files/);
    expect(schedule(nodes, {}, 4)).toEqual(["a"]);
  });

  it("a readOnly node overlaps nothing", () => {
    const nodes = [n("build", [], ["lib/**"]), n("audit", [], [], true)];
    expect(conflictReason(nodes[0]!, nodes[1]!)).toBeNull();
    expect(schedule(nodes, {}, 4)).toEqual(["audit", "build"]);
  });

  it("does not add a dependency that is already implied", () => {
    const nodes = [
      n("a", [], ["lib/x/**"]),
      n("b", ["a"], ["lib/x/y.ts"]),
      n("c", ["b"], ["lib/x/z.ts"]),
    ];
    expect(analyseOverlap(nodes).serialisations).toEqual([]);
  });

  it("orders overlap by declared topology, so no cycle is introduced", () => {
    // "a" sorts first but depends on "z"; overlap must put z before a, not a before z.
    const nodes = [
      n("a", ["z"], ["lib/shared/**"]),
      n("m", [], ["lib/shared/x.ts"]),
      n("z", [], ["docs/**"]),
    ];
    const { deps } = analyseOverlap(nodes);
    expect(validateGraph(nodes.map((node) => ({ ...node, deps: deps.get(node.key)! }))).ok).toBe(
      true,
    );
    const order = integrationOrder(nodes);
    expect(order.indexOf("z")).toBeLessThan(order.indexOf("a"));
  });

  it("serialises a chain of three overlapping nodes transitively without redundant edges", () => {
    const nodes = [n("a", [], ["lib/**"]), n("b", [], ["lib/x.ts"]), n("c", [], ["lib/y.ts"])];
    const { serialisations } = analyseOverlap(nodes);
    // a→b (overlap), a→c (overlap); b and c are disjoint, so they may run together after a.
    expect(serialisations.map((s) => `${s.before}>${s.after}`)).toEqual(["a>b", "a>c"]);
    expect(schedule(nodes, { a: "approved" }, 4)).toEqual(["b", "c"]);
  });
});

describe("readyNodes", () => {
  const nodes = [
    n("a", [], ["lib/a/**"]),
    n("b", ["a"], ["lib/b/**"]),
    n("c", [], ["lib/c/**"]),
    n("d", ["b", "c"], ["lib/d/**"]),
  ];

  it("returns roots when nothing has run", () => {
    expect(readyNodes(nodes, {})).toEqual(["a", "c"]);
  });

  it("releases dependents once deps are approved or integrated", () => {
    expect(readyNodes(nodes, { a: "approved", c: "running" })).toEqual(["b"]);
    expect(
      readyNodes(
        nodes,
        new Map<string, NodeStatus>([
          ["a", "integrated"],
          ["b", "approved"],
          ["c", "approved"],
        ]),
      ),
    ).toEqual(["d"]);
  });

  it("does not release on running, in_review, failed or skipped deps", () => {
    for (const s of ["running", "in_review", "changes_requested", "failed", "skipped"] as const) {
      expect(readyNodes(nodes, { a: s, c: "running" })).not.toContain("b");
    }
  });

  it("does not return nodes that already started or finished", () => {
    expect(readyNodes(nodes, { a: "running", c: "failed" })).toEqual([]);
  });
});

describe("schedule", () => {
  const wide = ["a", "b", "c", "d", "e"].map((k) => n(k, [], [`lib/${k}/**`]));

  it("respects the parallel limit", () => {
    expect(schedule(wide, {}, 2)).toEqual(["a", "b"]);
    expect(schedule(wide, {}, 1)).toEqual(["a"]);
  });

  it("counts in-flight work against the limit", () => {
    expect(schedule(wide, { a: "running", b: "in_review" }, 3)).toEqual(["c"]);
    expect(schedule(wide, { a: "running", b: "changes_requested" }, 2)).toEqual([]);
  });

  it("never starts a node that conflicts with in-flight work", () => {
    // Statuses supplied out of order: the later node is already running.
    const nodes = [n("a", [], ["lib/x/**"]), n("b", [], ["lib/x/y.ts"])];
    // Overlap makes b wait for a, so a is the only candidate; a must still not start while b writes lib/x.
    expect(schedule(nodes, { b: "running" }, 4)).toEqual([]);
  });

  it("rejects a bad parallel limit", () => {
    expect(() => schedule(wide, {}, 0)).toThrow(RangeError);
    expect(() => schedule(wide, {}, 1.5)).toThrow(RangeError);
  });
});

describe("integrationOrder", () => {
  it("is topological with key as tiebreak", () => {
    const nodes = [n("zeta"), n("alpha", ["zeta"]), n("beta"), n("gamma", ["beta"])];
    expect(integrationOrder(nodes)).toEqual(["beta", "gamma", "zeta", "alpha"]);
  });

  it("is deterministic regardless of input order", () => {
    const nodes = [
      n("ui", ["api"], ["app/**"]),
      n("api", ["schema"], ["lib/api/**"]),
      n("schema", [], ["supabase/**"]),
      n("docs", [], ["docs/**"]),
      n("tests", ["api"], ["tests/**"]),
    ];
    const expected = integrationOrder(nodes);
    for (let i = 0; i < 10; i++) {
      const shuffled = [...nodes].sort(() => (i % 2 ? 1 : -1) * ((i * 7) % 3) - 1);
      expect(integrationOrder(shuffled)).toEqual(expected);
    }
    expect(expected).toEqual(["docs", "schema", "api", "tests", "ui"]);
  });

  it("includes overlap serialisations", () => {
    const nodes = [n("b", [], ["lib/**"]), n("a", [], [])];
    // No declared deps, so key order decides who goes first; the overlap edge follows it.
    expect(integrationOrder(nodes)).toEqual(["a", "b"]);
    expect(analyseOverlap(nodes).serialisations[0]).toMatchObject({ before: "a", after: "b" });
  });

  it("is fast on a larger graph", () => {
    const nodes = Array.from({ length: 60 }, (_, i) =>
      n(`n${String(i).padStart(2, "0")}`, i > 0 ? [`n${String(i - 1).padStart(2, "0")}`] : [], [
        `lib/m${i % 7}/**`,
      ]),
    );
    const start = performance.now();
    integrationOrder(nodes);
    schedule(nodes, {}, 4);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
