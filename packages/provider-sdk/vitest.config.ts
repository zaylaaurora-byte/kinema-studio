import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The mock provider must not touch the network; if a test needs it, that is a bug.
    testTimeout: 10_000,
  },
});