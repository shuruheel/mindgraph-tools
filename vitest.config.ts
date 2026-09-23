import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Workspace packages resolve to their sources so tests never need a build.
    alias: {
      "mindgraph-agent-core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "mindgraph-tools": path.resolve(__dirname, "packages/tools/src/index.ts"),
      "mindgraph-eve": path.resolve(__dirname, "packages/eve/src/index.ts"),
    },
  },
});
