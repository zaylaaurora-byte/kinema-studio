import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // This package must never reach the network: the mock planner and all local tools are
    // offline by construction, and the provider-backed planner is exercised only through a
    // fake adapter. If a test needs a socket, that is a bug.
    testTimeout: 10_000,
  },
});