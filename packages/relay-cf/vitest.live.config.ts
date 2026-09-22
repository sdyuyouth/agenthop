import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
