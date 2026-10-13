import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["legacy/**", "node_modules/**"],
    testTimeout: 15_000,
  },
});
