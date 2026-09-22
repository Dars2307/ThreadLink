// Builds the ThreadLink Runtime package that this app embeds, so the desktop
// app and the CLI always run the same engine.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "..", "..", "runtime");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "-p", "tsconfig.build.json"],
  {
    cwd: runtime,
    stdio: "inherit",
    shell: false,
  },
);
process.exit(result.status ?? 1);
