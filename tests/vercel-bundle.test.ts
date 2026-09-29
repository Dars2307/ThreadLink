import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Vercel build uploads only what .vercelignore lets through. A value
 * import from runtime/ in the web app must name a file that is let through,
 * or Production fails to build (0.11 first deploy: "Can't resolve
 * '@/runtime/src/chat-presentation'"). Type-only imports are erased and fine.
 */
const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function shipped(path: string): boolean {
  // The .vercelignore rules for runtime/, evaluated like gitignore.
  const rules = readFileSync(join(ROOT, ".vercelignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  let ignored = false;
  for (const rule of rules) {
    const negate = rule.startsWith("!");
    const pattern = (negate ? rule.slice(1) : rule).replace(/^\//, "");
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "(/|$)",
    );
    if (re.test(path)) ignored = !negate;
  }
  return !ignored;
}

describe("the Vercel bundle", () => {
  it("contains every runtime/ module the web app imports as a value", () => {
    const imports = new Set<string>();
    for (const dir of ["app", "components", "lib"]) {
      for (const file of files(join(ROOT, dir))) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(@\/runtime\/[^"]+)"/gm)) {
          imports.add(`${m[1]!.replace("@/", "")}.ts`);
        }
      }
    }
    expect(imports.size).toBeGreaterThan(0);
    for (const path of imports) {
      expect(shipped(path), `${path} is excluded by .vercelignore`).toBe(true);
      // And that module must not pull in the rest of runtime/.
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(/^import\s+(?!type\b)/m.test(text), `${path} has value imports`).toBe(false);
    }
    expect(shipped("runtime/src/engine.ts")).toBe(false);
    expect(shipped("desktop/src/main.ts")).toBe(false);
    expect(relative(ROOT, ROOT)).toBe("");
  });
});
