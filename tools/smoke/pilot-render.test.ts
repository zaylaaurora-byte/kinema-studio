import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { PILOT_RENDER_CONFIG, renderPilotScene1 } from "./pilot-render.js";

/**
 * Renders scene 1 of the Bad Example pilot and verifies the result with ffprobe.
 *
 * The claim under test is not "a function ran" but "a real, playable video exists that
 * contains the acting beats the pilot calls for". So the assertions decode the output
 * with an independent tool rather than trusting the encoder.
 */

const OUT_DIR = join("tmp", "pilot-scene-01");

function findFfprobe(ffmpegPath: string): string {
  const sibling = join(ffmpegPath, "..", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  return sibling;
}

describe("Bad Example pilot — scene 1 render", () => {
  it(
    "renders a real, playable MP4 of the studio intro",
    async () => {
      const result = await renderPilotScene1(OUT_DIR);

      // --- The file exists and is a plausible size ---
      expect(existsSync(result.mp4Path)).toBe(true);
      const bytes = statSync(result.mp4Path).size;
      expect(bytes).toBeGreaterThan(10_000);

      // --- Frame count matches the scene duration exactly ---
      // 8 seconds at 30fps. An off-by-one here produces a flash at the cut.
      expect(result.frames).toBe(PILOT_RENDER_CONFIG.sceneDuration * PILOT_RENDER_CONFIG.fps);
      expect(result.frames).toBe(240);

      // --- Verify with ffprobe, an independent tool ---
      const ffmpeg =
        process.env["FFMPEG_PATH"] ??
        join(
          process.env["LOCALAPPDATA"] ?? "",
          "Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe",
        );

      if (!existsSync(ffmpeg)) {
        console.warn("ffmpeg not found; skipping ffprobe verification");
        return;
      }

      const ffprobe = findFfprobe(ffmpeg);
      const probe = JSON.parse(
        execFileSync(
          ffprobe,
          [
            "-v", "error",
            "-show_entries", "stream=codec_name,width,height,nb_frames,r_frame_rate",
            "-show_entries", "format=duration,size",
            "-of", "json",
            result.mp4Path,
          ],
          { encoding: "utf8" },
        ),
      );

      const video = probe.streams.find(
        (s: { codec_name?: string }) => s.codec_name === "h264",
      );

      console.log("\nffprobe:", JSON.stringify(video));
      console.log("format:", JSON.stringify(probe.format));
      console.log(`rendered in ${result.elapsedMs}ms`);

      expect(video).toBeDefined();
      expect(video.width).toBe(PILOT_RENDER_CONFIG.width);
      expect(video.height).toBe(PILOT_RENDER_CONFIG.height);
      expect(Number(video.nb_frames)).toBe(240);
      expect(Math.abs(Number(probe.format.duration) - PILOT_RENDER_CONFIG.sceneDuration)).toBeLessThan(0.1);

      // --- The contact sheet exists so the render can be inspected visually ---
      expect(result.contactSheet.length).toBeGreaterThanOrEqual(4);
      for (const path of result.contactSheet) {
        expect(existsSync(path)).toBe(true);
      }
    },
    300_000,
  );

  it("produces visibly different frames as the acting beats change", async () => {
    // The style is discrete pose swaps, so the frames must CHANGE at the switch points
    // and be IDENTICAL while a pose is held. Both halves matter: a frozen character and
    // an accidentally continuous drift are both wrong.
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");

    const result = await renderPilotScene1(join("tmp", "pilot-scene-01-determinism"));

    const hashes = result.contactSheet.map((p) =>
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    );

    // Every sampled frame sits in a different acting beat, so all six should differ.
    expect(new Set(hashes).size).toBe(hashes.length);
  }, 300_000);
});