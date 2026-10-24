import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Every test here is offline and deterministic by construction; if one needs the
    // network or takes longer than this, that is a bug rather than a slow machine.
    testTimeout: 20_000,
  },
});