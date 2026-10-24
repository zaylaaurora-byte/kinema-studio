import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { generateFixtures } from "./generate-fixtures.js";

/**
 * Writes real PNG files to disk so an independent decoder can inspect them.
 *
 * The assertion here is deliberately narrow; the real verification happens in
 * tools/verify_pngs.py using Pillow. This test only guarantees the fixtures exist and
 * that determinism holds at the byte level on disk.
 */

const outDir = process.env["KINEMA_FIXTURE_DIR"] ?? "tmp/mock-fixtures";

describe("image fixtures for independent verification", () => {
  it("generates PNGs on disk", async () => {
    const written = await generateFixtures();

    expect(written.length).toBeGreaterThanOrEqual(8);

    for (const file of written) {
      const bytes = readFileSync(file);
      // PNG signature.
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(bytes.length).toBeGreaterThan(100);
    }
  });

  it("produces byte-identical files for identical inputs", async () => {
    await generateFixtures();

    const a = readFileSync(`${outDir}/base-512.png`);
    const b = readFileSync(`${outDir}/base-512-repeat.png`);

    expect(a.equals(b)).toBe(true);
  });
});