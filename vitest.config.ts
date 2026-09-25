import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "packages/adapters/*/test/**/*.test.ts", "apps/*/test/**/*.unit.test.ts", "test/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/*.live.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["apps/*/test/**/*.int.test.ts", "packages/*/test/**/*.int.test.ts", "packages/adapters/*/test/**/*.int.test.ts"],
          environment: "node",
          // One PostgreSQL test database shared by all files: run files serially.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["apps/*/test/**/*.live.test.ts"],
          environment: "node",
          testTimeout: 120_000,
        },
      },
    ],
  },
});
