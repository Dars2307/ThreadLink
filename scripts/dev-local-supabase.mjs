// Starts `next dev` on :3200 against the LOCAL Supabase stack for HTTP e2e tests.
// Env overrides beat .env.local, so hosted Supabase is never touched. Test-only secret.
import { execFileSync, spawn } from "node:child_process";

const raw = execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8",
  shell: true,
  stdio: ["ignore", "pipe", "ignore"],
});
const status = JSON.parse(raw.slice(raw.indexOf("{")));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(status.API_URL)) {
  throw new Error("Refusing to start: Supabase API is not local.");
}

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: status.SECRET_KEY,
  DATABASE_URL: status.DB_URL,
  // Must match TEST_CONNECTION_SECRET in tests/integration/helpers.ts. Test-only.
  THREADLINK_CONNECTION_SECRET: "integration-test-connection-secret-0123456789abcdef",
};

const child = spawn("npx", ["next", "dev", "-p", "3200"], { env, shell: true, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
