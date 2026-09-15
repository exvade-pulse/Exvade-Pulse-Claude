import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./src/test/globalSetup.ts",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
