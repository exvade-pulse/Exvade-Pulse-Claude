import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./src/test/globalSetup.ts",
    testTimeout: 20000,
    hookTimeout: 20000,
    // Test files share one Postgres database and each truncates tables in
    // beforeEach; running files in parallel workers causes deadlocking
    // concurrent TRUNCATE/INSERT statements, so keep the suite single-threaded.
    fileParallelism: false,
  },
});
