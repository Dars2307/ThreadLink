import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Integration tests: require the LOCAL Supabase stack (`supabase start`).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.int.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
