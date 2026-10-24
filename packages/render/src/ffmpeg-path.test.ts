/**
 * FFmpeg/ffprobe discovery tests.
 *
 * These use the injectable `env`/`pathEnv` options rather than the real environment, so
 * they assert the precedence rules deterministically regardless of what happens to be
 * installed on the machine running them.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveFfmpegPath, resolveFfprobePath, requireFfmpegPath } from "./ffmpeg-path.js";
import { findFfmpegForTests } from "./test-helpers.js";

describe("resolveFfmpegPath", () => {
  it("prefers the explicit path over FFMPEG_PATH and PATH", () => {
    const real = findFfmpegForTests();
    const resolved = resolveFfmpegPath({
      explicitPath: real,
      env: { FFMPEG_PATH: "Z:\\nope\\ffmpeg.exe", PATH: "Z:\\nope" },
      pathEnv: "Z:\\nope",
    });
    expect(resolved).toBe(real);
  });

  it("reads FFMPEG_PATH when no explicit path is given", () => {
    const real = findFfmpegForTests();
    const resolved = resolveFfmpegPath({
      env: { FFMPEG_PATH: real, PATH: "Z:\\nope" },
      pathEnv: "Z:\\nope",
    });
    expect(resolved).toBe(real);
  });

  it("throws when FFMPEG_PATH is set but does not exist (no silent PATH fallthrough)", () => {
    expect(() =>
      resolveFfmpegPath({
        env: { FFMPEG_PATH: "Z:\\definitely\\missing\\ffmpeg.exe", PATH: "Z:\\nope" },
        pathEnv: "Z:\\nope",
      }),
    ).toThrow(/FFMPEG_PATH is set to .* but no such file exists/);
  });

  it("returns undefined when nothing is configured and PATH has no ffmpeg", () => {
    const resolved = resolveFfmpegPath({
      env: { PATH: "Z:\\definitely\\empty" },
      pathEnv: "Z:\\definitely\\empty",
    });
    expect(resolved).toBeUndefined();
  });

  it("finds ffmpeg via PATH as the last resort", () => {
    const real = findFfmpegForTests();
    // The directory containing the real binary, presented as a PATH entry.
    const dir = join(real, "..");
    const resolved = resolveFfmpegPath({ env: { PATH: dir }, pathEnv: dir });
    expect(resolved).toBeDefined();
    expect(resolved?.toLowerCase()).toContain("ffmpeg");
  });

  it("survives malformed PATH entries without throwing", () => {
    const real = findFfmpegForTests();
    const dir = join(real, "..");
    const messyPath = ["", "\0<>|", dir].join(";");
    expect(() => resolveFfmpegPath({ env: { PATH: messyPath }, pathEnv: messyPath })).not.toThrow();
  });
});

describe("resolveFfprobePath", () => {
  it("prefers the ffprobe sitting beside the resolved ffmpeg", () => {
    const real = findFfmpegForTests();
    const resolved = resolveFfprobePath({ env: { FFMPEG_PATH: real, PATH: "Z:\\nope" }, pathEnv: "Z:\\nope" });
    expect(resolved).toBeDefined();
    expect(resolved?.toLowerCase()).toContain("ffprobe");
    // Same directory as ffmpeg => the matching build.
    expect(join(resolved!, "..")).toBe(join(real, ".."));
  });

  it("throws when FFPROBE_PATH is set but missing", () => {
    expect(() =>
      resolveFfprobePath({
        env: { FFPROBE_PATH: "Z:\\missing\\ffprobe.exe", PATH: "Z:\\nope" },
        pathEnv: "Z:\\nope",
      }),
    ).toThrow(/FFPROBE_PATH is set to .* but no such file exists/);
  });
});

describe("requireFfmpegPath", () => {
  it("returns a path on this machine, or an actionable error", () => {
    try {
      const path = requireFfmpegPath();
      expect(path.toLowerCase()).toContain("ffmpeg");
    } catch (error) {
      // The error must be actionable rather than a bare ENOENT.
      expect((error as Error).message).toContain("Kinema");
      expect((error as Error).message).toContain("FFMPEG_PATH");
    }
  });
});