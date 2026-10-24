/**
 * Manual smoke check: generate mock images and write them to disk so they can be
 * inspected by an independent decoder.
 *
 * Why this exists: the unit tests verify PNG *structure*. This verifies the bytes are
 * decodable by a completely separate implementation (Pillow), which is much stronger
 * evidence that the hand-rolled encoder is correct.
 *
 * Run:  node --experimental-strip-types packages/provider-sdk/scripts/smoke.ts <outdir>
 * Or via tsx/vitest tooling.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { MockImageAdapter } from "../src/mock-image.js";

const outDir = process.argv[2] ?? "./tmp/mock-smoke";
mkdirSync(outDir, { recursive: true });

const adapter = new MockImageAdapter();

const prompts = [
  { prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
  { prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
  { prompt: "a neon city skyline, 2D animation background", size: "640x384", seed: 7 },
];

const written: string[] = [];

for (const [index, request] of prompts.entries()) {
  const result = await adapter.submitJobAndResolve({
    modelId: "mock-image-v1",
    ...request,
  });

  const output = result.outputs[0];
  if (!output || !output.data) {
    throw new Error(`No output for prompt ${index}`);
  }

  const file = join(outDir, `mock-${index}.png`);
  writeFileSync(file, output.data);
  written.push(file);
  console.log(
    `wrote ${file}  ${output.width}x${output.height}  ${(output.data as Buffer).length} bytes`,
  );
}

// Determinism check performed on the real byte output, not in-memory equality alone.
const [a, b] = written;
if (a && b) {
  const { readFileSync } = await import("node:fs");
  const same = readFileSync(a).equals(readFileSync(b));
  console.log(`determinism (files 0 and 1 identical): ${same}`);
  if (!same) {
    process.exitCode = 1;
  }
}