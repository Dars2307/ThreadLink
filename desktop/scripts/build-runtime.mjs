// Builds the ThreadLink Runtime package that this app embeds, so the desktop
// app and the CLI always run the same engine.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "..", "..", "runtime");
// Windows: a .cmd shim cannot be executed directly (Node refuses it without a
// shell), so ask for a shell there and quote nothing ourselves.
const windows = process.platform === "win32";
const result = spawnSync(windows ? "npx.cmd" : "npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: runtime,
  stdio: "inherit",
  shell: windows,
});
if (result.error) {
  console.error(`Could not build the ThreadLink Runtime: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
