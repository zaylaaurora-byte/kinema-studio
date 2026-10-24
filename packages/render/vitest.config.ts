import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Render tests spawn real FFmpeg processes and push real pixels through a real
    // encoder. The default 5s timeout is nowhere near enough for the 300-frame
    // backpressure test, so this is raised deliberately rather than per-test.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // FFmpeg saturates every core. Running test files in parallel makes the timing
    // assertions (memory, backpressure) noisy, so files run one at a time.
    fileParallelism: false,
  },
});