/**
 * VERIFICATION-ONLY test file (added by reviewer). Generates real PNG bytes to disk so an
 * independent decoder (Pillow) can inspect them. Not a product test.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it } from "vitest";

import { MockImageAdapter } from "./mock-image.js";

const OUT = "X:/Project Kinema/tmp/verify-pngs";

describe("verification generator", () => {
  it("writes PNGs for independent decoding", async () => {
    mkdirSync(OUT, { recursive: true });
    const adapter = new MockImageAdapter();

    const cases: Array<{ name: string; prompt: string; size?: string; seed?: number; count?: number }> = [
      { name: "base-512", prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
      { name: "base-512-again", prompt: "a lighthouse at dusk, flat vector style", size: "512x512", seed: 1 },
      { name: "city-640x384", prompt: "a neon city skyline, 2D animation background", size: "640x384", seed: 7 },
      { name: "one-by-one", prompt: "tiny", size: "1x1", seed: 3 },
      { name: "odd-7x3", prompt: "odd", size: "7x3", seed: 5 },
      { name: "odd-13x9", prompt: "odd2", size: "13x9", seed: 6 },
      { name: "wide-1536x1024", prompt: "wide scene", size: "1536x1024", seed: 11 },
      { name: "tall-1024x1536", prompt: "tall scene", size: "1024x1536", seed: 12 },
      { name: "big-1024", prompt: "big", size: "1024x1024", seed: 13 },
      { name: "empty-prompt-fallback", prompt: "", size: "512x512", seed: 14 },
      { name: "long-prompt", prompt: "x".repeat(3900), size: "512x512", seed: 15 },
      { name: "zero-width", prompt: "zerow", size: "0x10", seed: 16 },
      { name: "zero-height", prompt: "zeroh", size: "10x0", seed: 17 },
      { name: "huge-5000", prompt: "huge", size: "5000x5000", seed: 18 },
      { name: "batch", prompt: "three candidates", size: "512x512", count: 3 },
    ];

    const manifest: string[] = [];
    for (const c of cases) {
      try {
        const result = await adapter.submitJobAndResolve({
          modelId: "mock-image-v1",
          prompt: c.prompt,
          ...(c.size !== undefined ? { size: c.size } : {}),
          ...(c.seed !== undefined ? { seed: c.seed } : {}),
          ...(c.count !== undefined ? { count: c.count } : {}),
        });
        result.outputs.forEach((o, i) => {
          const file = join(OUT, `${c.name}${c.count && c.count > 1 ? "-" + i : ""}.png`);
          writeFileSync(file, o.data as Buffer);
          manifest.push(`OK ${c.name}#${i} declared=${o.width}x${o.height} bytes=${(o.data as Buffer).length}`);
        });
      } catch (err) {
        manifest.push(`THREW ${c.name}: ${(err as Error).message}`);
      }
    }
    writeFileSync(join(OUT, "manifest.txt"), manifest.join("\n"));
    console.log("\n===MANIFEST===\n" + manifest.join("\n") + "\n===END===");
  }, 120_000);
});