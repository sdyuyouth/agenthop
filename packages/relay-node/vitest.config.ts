import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Real sockets against the rest of the workspace: a loaded machine needs the room.
    testTimeout: 40000,
  },
});
