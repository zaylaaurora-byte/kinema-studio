/**
 * End-to-end round-trip verification.
 *
 * The other tests ask ffprobe what the container *claims*. This one decodes the video
 * back to raw pixels and inspects them, which is the only way to prove the MP4 contains
 * the picture we rendered rather than a valid but empty stream.
 *
 * It also checks that the first and last decoded frames differ — i.e. the motion
 * survived encoding — which no metadata assertion can establish.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { exportScene } from "./export.js";
import { findFfmpegForTests, makeAnimatedScene, makeTempDir } from "./test-helpers.js";

/** Decode a specific frame of an MP4 to a PNG buffer, using ffmpeg as the decoder. */
async function extractFrame(
  ffmpegPath: string,
  videoPath: string,
  frameIndex: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error",
        // -i, then select the exact frame, then emit a single PNG to stdout.
        "-i", videoPath,
        "-vf", `select=eq(n\\,${frameIndex})`,
        "-frames:v", "1",
        "-f", "image2pipe", "-vcodec", "png",
        "-",
      ],
      { shell: false, windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", () => undefined);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`frame extraction failed (exit ${code})`)),
    );
  });
}

async function stats(png: Buffer): Promise<{ mean: number; variance: number; distinct: number }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let sum = 0;
  let sumSq = 0;
  const colors = new Set<number>();
  const n = image.width * image.height;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    sum += luma;
    sumSq += luma * luma;
    if (colors.size < 200000) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
  }
  const mean = sum / n;
  return { mean, variance: sumSq / n - mean * mean, distinct: colors.size };
}

describe("decoded output really contains the rendered picture", () => {
  it("decodes the MP4 back and finds non-blank, moving content", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const ffmpegPath = findFfmpegForTests();
      // Full 720p, 300 frames — the same shape as the backpressure test.
      const scene = makeAnimatedScene({
        durationSeconds: 10,
        fps: 30,
        width: 1280,
        height: 720,
      });
      const outputPath = join(dir, "roundtrip.mp4");
      await exportScene(scene, { outputPath, ffmpegPath });

      const first = await extractFrame(ffmpegPath, outputPath, 0);
      const middle = await extractFrame(ffmpegPath, outputPath, 150);
      const last = await extractFrame(ffmpegPath, outputPath, 299);

      const sFirst = await stats(first);
      const sMiddle = await stats(middle);
      const sLast = await stats(last);

      console.log(
        `[roundtrip] decoded frame stats @1280x720\n` +
          `  frame 0:   mean=${sFirst.mean.toFixed(2)} variance=${sFirst.variance.toFixed(1)} colors=${sFirst.distinct}\n` +
          `  frame 150: mean=${sMiddle.mean.toFixed(2)} variance=${sMiddle.variance.toFixed(1)} colors=${sMiddle.distinct}\n` +
          `  frame 299: mean=${sLast.mean.toFixed(2)} variance=${sLast.variance.toFixed(1)} colors=${sLast.distinct}`,
      );

      // Decoded content is NOT a blank field.
      expect(sFirst.variance).toBeGreaterThan(50);
      expect(sLast.variance).toBeGreaterThan(50);

      // Motion survived: frames at different times are genuinely different pictures.
      expect(first.equals(last)).toBe(false);
      expect(first.equals(middle)).toBe(false);

      // The decoded picture is 1280x720.
      const img = await loadImage(first);
      expect(img.width).toBe(1280);
      expect(img.height).toBe(720);
    } finally {
      await cleanup();
    }
  });
});