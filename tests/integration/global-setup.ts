import { execFileSync } from "node:child_process";

import type { TestProject } from "vitest/node";

/**
 * Resolves the LOCAL Supabase stack for integration tests and refuses to run
 * against anything else. Hosted databases are never targeted by these tests.
 */
export default function setup(project: TestProject) {
  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch {
    throw new Error("Local Supabase is not running. Start it with `supabase start`.");
  }

  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  const apiUrl = new URL(status.API_URL);
  if (!["127.0.0.1", "localhost"].includes(apiUrl.hostname)) {
    throw new Error("Refusing to run integration tests against a non-local Supabase API.");
  }

  project.provide("supabase", {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
    secretKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
    jwtSecret: status.JWT_SECRET,
  });
}

declare module "vitest" {
  export interface ProvidedContext {
    supabase: { url: string; publishableKey: string; secretKey: string; jwtSecret: string };
  }
}
