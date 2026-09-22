import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// HTTP e2e: requires LOCAL Supabase and `node scripts/dev-local-supabase.mjs` (:3200).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
