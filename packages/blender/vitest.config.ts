import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The real-render test launches Blender, builds a scene and encodes a PNG. On this
    // machine that takes ~5s; the budget below is deliberately generous so a loaded
    // machine slows the test down rather than failing it. Anything approaching this
    // figure is a hang, not slowness, and the timeout test proves the runner notices.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});