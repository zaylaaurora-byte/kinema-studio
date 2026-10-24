import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MockImageAdapter } from "../src/mock-image.js";

/**
 * Generates mock images to disk for independent verification.
 *
 * Output is consumed by tools/verify_pngs.py (Pillow), which is a completely separate
 * decoder. That cross-check is what catches encoder defects that internal tests cannot:
 * the original Adler-32 bug passed every self-referential test and was only found when
 * an outside implementation disagreed.
 *
 * Usage: vitest run generate-fixtures
 */

const outDir = process.env["KINEMA_FIXTURE_DIR"] ?? "tmp/mock-fixtures";

export async function generateFixtures(): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });

  const adapter = new MockImageAdapter();
  const written: string[] = [];

  const cases: { name: string; prompt: string; size: string; seed?: number; count?: number }[] = [
    { name: "base-512", prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
    // Duplicate of the above, to verify determinism at the byte level on disk.
    { name: "base-512-repeat", prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
    { name: "wide-1536x1024", prompt: "a neon city skyline", size: "1536x1024", seed: 7 },
    { name: "tall-1024x1536", prompt: "a tall radio tower", size: "1024x1536", seed: 9 },
    // Large: exercises the multi-block deflate path (~4MB of scanline data).
    { name: "big-1024", prompt: "a dense forest canopy", size: "1024x1024", seed: 3 },
    { name: "batch", prompt: "three candidate variants", size: "512x512", count: 3 },
    { name: "long-prompt", prompt: "an extremely detailed description ".repeat(40), size: "512x512" },
  ];

  for (const testCase of cases) {
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: testCase.prompt,
      size: testCase.size,
      ...(testCase.seed !== undefined ? { seed: testCase.seed } : {}),
      ...(testCase.count !== undefined ? { count: testCase.count } : {}),
    });

    for (const [index, output] of result.outputs.entries()) {
      if (!output.data) continue;
      const suffix = result.outputs.length > 1 ? `-${index}` : "";
      const file = join(outDir, `${testCase.name}${suffix}.png`);
      writeFileSync(file, output.data as Buffer);
      written.push(file);
    }
  }

  return written;
}