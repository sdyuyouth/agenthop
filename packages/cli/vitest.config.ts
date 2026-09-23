import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // These drive real processes through a real relay. Running the files against each other
    // starves them of CPU and turns waiting for a line into a timeout.
    fileParallelism: false,
    testTimeout: 40000,
  },
});
