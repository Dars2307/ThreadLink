import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static checks that server-only credentials and modules cannot reach browser code.
 * The `server-only` package enforces this at build time; these tests make the
 * rule explicit and catch regressions (e.g. someone removing the import).
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
  path: relative(ROOT, path).replace(/\\/g, "/"),
  source: readFileSync(path, "utf8"),
}));

const clientFiles = files.filter(({ source }) => /^\s*["']use client["']/.test(source));

const SERVER_ONLY_MODULES = [
  "@/lib/env/server",
  "@/lib/supabase/admin",
  "@/lib/supabase/server",
  "@/lib/auth/identity",
];

describe("client/server boundary", () => {
  it("finds client components to check", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it.each(clientFiles.map((file) => [file.path, file.source]))(
    "%s does not reference server secrets or server-only modules",
    (_path, source) => {
      expect(source).not.toMatch(/CLERK_SECRET_KEY|SUPABASE_SECRET_KEY|DATABASE_URL/);
      for (const mod of SERVER_ONLY_MODULES) {
        expect(source).not.toContain(`"${mod}"`);
      }
    },
  );

  it.each(SERVER_ONLY_MODULES)("%s is marked server-only", (mod) => {
    const path = `${mod.replace("@/", "")}.ts`;
    const file = files.find((candidate) => candidate.path === path);
    expect(file, `${path} should exist`).toBeDefined();
    expect(file!.source).toMatch(/^import "server-only";/m);
  });

  it("only lib/env/server.ts reads secret variables from process.env", () => {
    const offenders = files
      .filter(({ source }) =>
        /process\.env\.(CLERK_SECRET_KEY|SUPABASE_SECRET_KEY|DATABASE_URL)/.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
