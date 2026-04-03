import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/benchmark-llm-context/**"], // Broken imports — scripts not compiled
    testTimeout: 30_000,
  },
});
