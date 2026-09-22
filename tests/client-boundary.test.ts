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
  "@/lib/auth/threadlink-user",
  "@/lib/connections/repository",
  "@/lib/connections/require-connection",
];

/** Pure modules that must still never be bundled for the browser (node:crypto, token logic). */
const SERVER_SIDE_MODULES = [
  "@/lib/connections/credentials",
  "@/lib/connections/authenticate",
  "@/lib/connections/registration",
];

/**
 * Files allowed to import the privileged (RLS-bypassing) Supabase client.
 * Deliberately empty in Phase 2: all application data goes through the
 * user-scoped client. Adding an entry requires review (see docs/security.md).
 */
const PRIVILEGED_CLIENT_ALLOWLIST: string[] = [];

describe("client/server boundary", () => {
  it("finds client components to check", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it.each(clientFiles.map((file) => [file.path, file.source]))(
    "%s does not reference server secrets or server-only modules",
    (_path, source) => {
      expect(source).not.toMatch(
        /CLERK_SECRET_KEY|SUPABASE_SECRET_KEY|DATABASE_URL|THREADLINK_CONNECTION_SECRET/,
      );
      for (const mod of [...SERVER_ONLY_MODULES, ...SERVER_SIDE_MODULES]) {
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

  it("the privileged Supabase client is imported only from allowlisted files", () => {
    const importers = files
      .filter(({ path }) => path !== "lib/supabase/admin.ts")
      .filter(({ source }) => /["']@\/lib\/supabase\/admin["']|supabase\/admin["']/.test(source))
      .map(({ path }) => path);
    expect(importers).toEqual(PRIVILEGED_CLIENT_ALLOWLIST);
  });

  it("the privileged Supabase client factory takes no caller-supplied input", () => {
    const admin = files.find(({ path }) => path === "lib/supabase/admin.ts")!;
    expect(admin.source).toMatch(/export function createPrivilegedSupabaseClient\(\)/);
  });

  it("SUPABASE_SECRET_KEY is referenced only by the env schema and the privileged client", () => {
    const users = files
      .filter(({ source }) => source.includes("SUPABASE_SECRET_KEY"))
      .map(({ path }) => path)
      .sort();
    expect(users).toEqual(["lib/env/schema.ts", "lib/supabase/admin.ts"]);
  });

  it("server code never selects rows by email or display name", () => {
    const offenders = files
      .filter(({ source }) =>
        /\.(eq|match|filter)\(\s*["'](primary_email|display_name)["']/.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("only lib/env/server.ts reads secret variables from process.env", () => {
    const offenders = files
      .filter(({ source }) =>
        /process\.env\.(CLERK_SECRET_KEY|SUPABASE_SECRET_KEY|DATABASE_URL)/.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("THREADLINK_CONNECTION_SECRET is read only via the validated server env", () => {
    const users = files
      .filter(({ source }) => /process\.env\.THREADLINK_CONNECTION_SECRET/.test(source))
      .map(({ path }) => path);
    expect(users).toEqual([]);
  });

  it("every connection-token route handler calls requireConnection()", () => {
    const routes = files.filter(({ path }) => /^app\/api\/connection\/.+\/route\.ts$/.test(path));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.source, route.path).toMatch(/await requireConnection\(request\)/);
    }
  });
});

describe("committed files contain no real-looking connection tokens", () => {
  const SCAN_DIRS = ["app", "components", "lib", "tests", "docs", "supabase"];
  const scanned = SCAN_DIRS.flatMap((dir) => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((name) => {
        const p = join(d, name);
        if (name === ".temp" || name === "node_modules") return [];
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    return walk(join(ROOT, dir));
  });

  it("scans a meaningful number of files", () => {
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("no file contains a full tlc_ token (tests generate tokens at runtime)", () => {
    const offenders = scanned
      .filter((path) => /tlc_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
