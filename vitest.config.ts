import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // Loading the LangChain provider packages on first import can exceed the
    // 5s default on a cold start.
    testTimeout: 30000,
  },
});
