// tsc emits preload.cts -> preload.cjs; nothing else to do, but verify it exists.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(join(dist, "preload.cjs"))) {
  console.error("preload.cjs missing from dist");
  process.exit(1);
}
