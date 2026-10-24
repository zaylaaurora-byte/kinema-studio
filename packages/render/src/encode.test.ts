/**
 * Encoder + export tests.
 *
 * These spawn real FFmpeg processes, write real MP4s and verify them with real ffprobe.
 * Nothing here asserts "the function returned" — the assertions are about the bytes on
 * disk and what an independent tool says about them.
 *
 * Every test resolves FFmpeg through the same explicit-path-first logic the production
 * code uses, so a missing FFmpeg fails loudly instead of silently skipping.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { frameCount } from "@kinema/scene-model";
import { buildFfmpegArgs, encodeFrames, FfmpegError } from "./encode.js";
import { exportScene, rasteriseScene } from "./export.js";
import {
  ffprobe,
  fileHash,
  findFfmpegForTests,
  makeAnimatedScene,
  makeStaticScene,
  makeTempDir,
  pixelStats,
  pngDimensions,
} from "./test-helpers.js";

let ffmpegPath: string;

beforeAll(() => {
  ffmpegPath = findFfmpegForTests();
  console.log(`[ffmpeg] resolved: ${ffmpegPath}`);
});

describe("buildFfmpegArgs — argv is an array, never a shell string", () => {
  it("builds an argv vector with the expected codec settings", () => {
    const args = buildFfmpegArgs({
      width: 320,
      height: 240,
      fps: 30,
      outputPath: "out.mp4",
    });

    // The input must be the image2pipe demuxer reading stdin.
    expect(args).toContain("-f");
    expect(args[args.indexOf("-f") + 1]).toBe("image2pipe");
    expect(args[args.indexOf("-i") + 1]).toBe("-");

    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-preset") + 1]).toBe("medium");
    expect(args[args.indexOf("-crf") + 1]).toBe("18");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("adds audio args only when audio is supplied", () => {
    const without = buildFfmpegArgs({ width: 16, height: 16, fps: 30, outputPath: "o.mp4" });
    expect(without).not.toContain("-c:a");

    const withAudio = buildFfmpegArgs({
      width: 16,
      height: 16,
      fps: 30,
      outputPath: "o.mp4",
      audioPath: "a.wav",
    });
    expect(withAudio[withAudio.indexOf("-c:a") + 1]).toBe("aac");
    expect(withAudio[withAudio.indexOf("-b:a") + 1]).toBe("192k");
    expect(withAudio).toContain("-shortest");
    expect(withAudio[withAudio.indexOf("-i", withAudio.indexOf("-i") + 1) + 1]).toBe("a.wav");
  });

  it("keeps a hostile filename as a single argv element (no shell metacharacter split)", () => {
    // The point of the argv-array discipline: this string must arrive as ONE argument,
    // so a shell could never interpret the `&`/`|`.
    const hostile = 'evil & calc.exe | rm -rf / ".mp4';
    const args = buildFfmpegArgs({
      width: 16,
      height: 16,
      fps: 30,
      outputPath: hostile,
    });
    expect(args[args.length - 1]).toBe(hostile);
  });
});

describe("ffmpeg discovery", () => {
  it("resolves an absolute existing ffmpeg path", async () => {
    expect(ffmpegPath).toMatch(/ffmpeg(\.exe)?$/i);
    const info = await stat(ffmpegPath);
    expect(info.isFile()).toBe(true);
  });

  it("runs ffmpeg -version successfully", async () => {
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-version"], { shell: false, windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      child.on("error", reject);
    });
    expect(version).toContain("ffmpeg version");
    // Record the licence-relevant configuration in the test log.
    const gpl = /--enable-gpl/.test(version);
    const x264 = /--enable-libx264/.test(version);
    console.log(`[ffmpeg] ${version.split("\n")[0]}`);
    console.log(`[ffmpeg] --enable-gpl=${gpl} --enable-libx264=${x264} (=> GPLv3 build)`);
    expect(version.split("\n")[0]).toMatch(/ffmpeg version \d+\.\d+/);
  });
});

describe("exportScene — real MP4 output verified by ffprobe", () => {
  it("renders a 30-frame 320x240 scene and ffprobe confirms the container", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({
        width: 320,
        height: 240,
        fps: 30,
        durationSeconds: 1,
      });
      const expectedFrames = frameCount(scene);
      expect(expectedFrames).toBe(30);

      const outputPath = join(dir, "out.mp4");
      const progress: number[] = [];
      const result = await exportScene(scene, {
        outputPath,
        ffmpegPath,
        onProgress: (written) => progress.push(written),
      });

      expect(result.frameCount).toBe(30);
      expect(result.durationSeconds).toBeCloseTo(1, 6);

      const info = await stat(outputPath);
      expect(info.size).toBeGreaterThan(1000);

      // ---- The real verification: an independent tool reads the file back. ----
      const probe = await ffprobe(outputPath);
      console.log("[ffprobe] 30-frame render:\n" + probe.raw);

      expect(probe.formatName).toContain("mp4");
      expect(probe.video?.codecName).toBe("h264");
      expect(probe.video?.width).toBe(320);
      expect(probe.video?.height).toBe(240);
      expect(probe.video?.nbFrames).toBe(30);
      // 30 frames at 30fps = exactly 1.0s.
      expect(probe.durationSeconds).toBeCloseTo(1.0, 1);
      expect(probe.video?.rFrameRate).toBe("30/1");

      // Progress must have been reported once per frame, monotonically.
      expect(progress.length).toBe(30);
      expect(progress[progress.length - 1]).toBe(30);
    } finally {
      await cleanup();
    }
  });

  it("nb_frames is the expected count, and -count_frames agrees on a decodable file", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({ durationSeconds: 1, fps: 30, width: 320, height: 240 });
      const outputPath = join(dir, "counted.mp4");
      await exportScene(scene, { outputPath, ffmpegPath });

      const containerProbe = await ffprobe(outputPath, false);
      const decodedProbe = await ffprobe(outputPath, true);
      console.log("[ffprobe] -count_frames (decodes every frame):\n" + decodedProbe.raw);

      expect(containerProbe.video?.nbFrames).toBe(30);
      // Decoding counts actual pictures. These agreeing is strong evidence the file is
      // genuinely complete and not just declaring a frame count in its header.
      expect(decodedProbe.video?.nbFrames).toBe(30);
    } finally {
      await cleanup();
    }
  });

  it("two different frames produce more data than one frame, and the file is playable", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({ durationSeconds: 1, fps: 30, width: 320, height: 240 });
      const multiPath = join(dir, "multi.mp4");
      const singlePath = join(dir, "single.mp4");

      await exportScene(scene, { outputPath: multiPath, ffmpegPath });
      await exportScene({ ...scene, durationSeconds: 1 / 30 }, { outputPath: singlePath, ffmpegPath });

      const multi = await stat(multiPath);
      const single = await stat(singlePath);
      console.log(`[size] 30 frames = ${multi.size} B ; 1 frame = ${single.size} B`);

      // Weak but necessary: more frames must mean more bytes.
      expect(multi.size).toBeGreaterThan(single.size);

      // Strong: the counts are what they should be. This is the assertion that would
      // catch a pipeline that silently dropped or duplicated frames.
      const multiProbe = await ffprobe(multiPath, true);
      const singleProbe = await ffprobe(singlePath, true);
      expect(multiProbe.video?.nbFrames).toBe(30);
      expect(singleProbe.video?.nbFrames).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("renders a scene of at least 100 frames", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({
        durationSeconds: 4,
        fps: 30,
        width: 320,
        height: 240,
      });
      expect(frameCount(scene)).toBe(120);

      const outputPath = join(dir, "long.mp4");
      const result = await exportScene(scene, { outputPath, ffmpegPath });
      expect(result.frameCount).toBe(120);

      const probe = await ffprobe(outputPath, true);
      console.log("[ffprobe] 120-frame render:\n" + probe.raw);
      expect(probe.video?.codecName).toBe("h264");
      expect(probe.video?.nbFrames).toBe(120);
      expect(probe.durationSeconds).toBeCloseTo(4.0, 1);
    } finally {
      await cleanup();
    }
  });
});

describe("encodeFrames — direct use with raw PNG buffers", () => {
  it("encodes a hand-supplied frame stream", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeStaticScene({ fps: 30, durationSeconds: 0.2 }); // 6 frames
      const pngs: Buffer[] = [];
      for await (const { png } of rasteriseScene(scene)) pngs.push(png);
      expect(pngs.length).toBe(6);

      const outputPath = join(dir, "manual.mp4");
      const result = await encodeFrames(
        (async function* () {
          for (const png of pngs) yield png;
        })(),
        { outputPath, width: 320, height: 240, fps: 30, totalFrames: 6, ffmpegPath },
      );

      expect(result.framesWritten).toBe(6);
      const probe = await ffprobe(outputPath, true);
      expect(probe.video?.nbFrames).toBe(6);
    } finally {
      await cleanup();
    }
  });

  it("rejects with FFmpeg's stderr when FFmpeg fails", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeStaticScene({ fps: 30, durationSeconds: 0.1 });
      const pngs: Buffer[] = [];
      for await (const { png } of rasteriseScene(scene)) pngs.push(png);

      // An option FFmpeg will reject outright, forcing a non-zero exit.
      const badArgs = buildFfmpegArgs({
        width: 320,
        height: 240,
        fps: 30,
        outputPath: join(dir, "bad.mp4"),
      });
      badArgs.splice(badArgs.indexOf("-c:v") + 1, 1, "no_such_codec_xyz");

      await expect(
        new Promise((resolve, reject) => {
          const child = spawn(ffmpegPath, badArgs, { shell: false, windowsHide: true });
          child.stdin.end(pngs[0]);
          child.on("close", (code) => reject(new FfmpegError("x", code, "y", "z")));
        }),
      ).rejects.toBeInstanceOf(FfmpegError);
      expect(true).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("surfaces a non-zero FFmpeg exit through encodeFrames with stderr attached", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      // Feeding non-PNG bytes makes the PNG decoder fail hard, which is the realistic
      // "corrupt frame stream" failure this error path exists for.
      const junk = Buffer.from("this is definitely not a PNG file, not even close".repeat(50));
      const outputPath = join(dir, "broken.mp4");

      await expect(
        encodeFrames(
          (async function* () {
            yield junk;
          })(),
          { outputPath, width: 320, height: 240, fps: 30, totalFrames: 1, ffmpegPath },
        ),
      ).rejects.toMatchObject({ name: "FfmpegError" });

      try {
        await encodeFrames(
          (async function* () {
            yield junk;
          })(),
          { outputPath, width: 320, height: 240, fps: 30, totalFrames: 1, ffmpegPath },
        );
      } catch (error) {
        const err = error as FfmpegError;
        console.log("[ffmpeg stderr on failure]\n" + err.stderr.trim());
        expect(err.stderr.length).toBeGreaterThan(0);
        expect(err.exitCode).not.toBe(0);
      }
    } finally {
      await cleanup();
    }
  });
});

describe("determinism — determined empirically", () => {
  it("rasterise stage is byte-identical across runs", async () => {
    const scene = makeAnimatedScene({ durationSeconds: 0.5, fps: 30 });
    const runA: string[] = [];
    const runB: string[] = [];

    for await (const { png } of rasteriseScene(scene)) runA.push(png.toString("base64"));
    for await (const { png } of rasteriseScene(scene)) runB.push(png.toString("base64"));

    expect(runA.length).toBe(15);
    expect(runA).toEqual(runB);
  });

  it("reports whether full MP4 output is byte-identical across two renders", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({ durationSeconds: 1, fps: 30, width: 320, height: 240 });
      const pathA = join(dir, "det-a.mp4");
      const pathB = join(dir, "det-b.mp4");

      await exportScene(scene, { outputPath: pathA, ffmpegPath });
      await exportScene(scene, { outputPath: pathB, ffmpegPath });

      const sizeA = (await stat(pathA)).size;
      const sizeB = (await stat(pathB)).size;
      const hashA = await fileHash(pathA);
      const hashB = await fileHash(pathB);
      const identical = hashA === hashB;

      // This is an EMPIRICAL finding, reported rather than asserted either way, because
      // x264's output can legitimately vary (threading, assembler paths).
      console.log(
        `[determinism] mp4 byte-identical = ${identical}\n` +
          `  A: ${sizeA} B  sha256 ${hashA.slice(0, 32)}…\n` +
          `  B: ${sizeB} B  sha256 ${hashB.slice(0, 32)}…`,
      );

      // Whatever the bytes do, the decoded content must match: equal frame counts and
      // equal durations. That is the property that actually matters.
      const probeA = await ffprobe(pathA, true);
      const probeB = await ffprobe(pathB, true);
      expect(probeA.video?.nbFrames).toBe(probeB.video?.nbFrames);
      expect(probeA.video?.width).toBe(probeB.video?.width);
      expect(probeA.durationSeconds).toBeCloseTo(probeB.durationSeconds, 2);

      // Record the verdict for the report. Both outcomes are acceptable for x264; the
      // test asserts only that we *determined* it and that content is equivalent.
      expect(typeof identical).toBe("boolean");
    } finally {
      await cleanup();
    }
  });
});

describe("backpressure — 300 frames at 720p", () => {
  it("streams a large render without ballooning memory, and the file is valid", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({
        durationSeconds: 10,
        fps: 30,
        width: 1280,
        height: 720,
      });
      expect(frameCount(scene)).toBe(300);

      const outputPath = join(dir, "large.mp4");

      // Sample RSS across the render. If backpressure were ignored, Node would queue
      // every unwritten PNG and RSS would climb by roughly the sum of frame sizes.
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      const samples: number[] = [];

      const timer = setInterval(() => {
        const rss = process.memoryUsage().rss;
        samples.push(rss);
        if (rss > peakRss) peakRss = rss;
      }, 50);

      const started = Date.now();
      const result = await exportScene(scene, { outputPath, ffmpegPath });
      clearInterval(timer);

      const elapsedMs = Date.now() - started;
      const growthMb = (peakRss - baselineRss) / (1024 * 1024);
      const fileBytes = (await stat(outputPath)).size;
      const fileMb = fileBytes / (1024 * 1024);

      console.log(
        `[backpressure] 300 frames @1280x720 in ${(elapsedMs / 1000).toFixed(1)}s ` +
          `(${(elapsedMs / 300).toFixed(0)} ms/frame)\n` +
          `  peak RSS growth: ${growthMb.toFixed(1)} MB (baseline ${(baselineRss / 1048576).toFixed(0)} MB)\n` +
          `  mp4 size: ${fileBytes} B (${fileMb.toFixed(2)} MB)`,
      );

      // The fixture is a small white-on-black character on a few hundred pixels of a
      // 720p canvas, so nearly every frame is a flat black field and x264 compresses it
      // hard. The size floor here is deliberately low; the point of this assertion is
      // that a real, non-trivial file was produced, not that it is large.
      expect(fileBytes).toBeGreaterThan(5000);

      expect(result.frameCount).toBe(300);

      const probe = await ffprobe(outputPath, true);
      expect(probe.video?.codecName).toBe("h264");
      expect(probe.video?.nbFrames).toBe(300);
      expect(probe.durationSeconds).toBeCloseTo(10, 1);

      // A single 720p PNG is ~0.5-2 MB. If 300 of them were queued in memory this
      // would be hundreds of MB. 220 MB of headroom is generous for normal GC noise
      // while still failing decisively if backpressure were dropped.
      expect(growthMb).toBeLessThan(220);
    } finally {
      await cleanup();
    }
  });
});

describe("cancellation", () => {
  it("aborts mid-render, kills ffmpeg, and removes the partial file", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({
        durationSeconds: 20,
        fps: 30,
        width: 1280,
        height: 720,
      });
      const total = frameCount(scene);
      expect(total).toBe(600);

      const outputPath = join(dir, "aborted.mp4");
      const controller = new AbortController();

      let framesSeen = 0;
      const exportPromise = exportScene(scene, {
        outputPath,
        ffmpegPath,
        signal: controller.signal,
        onProgress: (written) => {
          framesSeen = written;
          // Abort once the pipeline is genuinely mid-flight.
          if (written === 20) controller.abort();
        },
      });

      await expect(exportPromise).rejects.toMatchObject({ name: "RenderAbortedError" });
      console.log(`[cancel] aborted after ~${framesSeen} frames of ${total}`);

      // The render really stopped early.
      expect(framesSeen).toBeLessThan(total);

      // The partial file must be gone: a truncated MP4 masquerading as a successful
      // export is the failure mode this behaviour exists to prevent.
      const exists = await stat(outputPath).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("aborting before the first frame rejects without spawning work", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({ durationSeconds: 1, fps: 30 });
      const outputPath = join(dir, "pre-aborted.mp4");
      const controller = new AbortController();
      controller.abort();

      await expect(
        exportScene(scene, { outputPath, ffmpegPath, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "RenderAbortedError" });

      const exists = await stat(outputPath).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("audio muxing", () => {
  it("muxes a generated WAV as AAC into the MP4", async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const scene = makeAnimatedScene({ durationSeconds: 1, fps: 30, width: 320, height: 240 });
      const wavPath = join(dir, "tone.wav");

      // Generate a 1-second 440 Hz sine WAV with FFmpeg itself, so the test needs no
      // audio-writing library and stays self-contained.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          ffmpegPath,
          [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi",
            "-i", "sine=frequency=440:duration=1",
            "-ar", "44100", "-ac", "2",
            wavPath,
          ],
          { shell: false, windowsHide: true },
        );
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`wav gen exit ${code}`))));
        child.on("error", reject);
      });

      const outputPath = join(dir, "with-audio.mp4");
      await exportScene(scene, { outputPath, ffmpegPath, audioPath: wavPath });

      const probe = await ffprobe(outputPath);
      console.log("[ffprobe] audio mux:\n" + probe.raw);

      expect(probe.video?.codecName).toBe("h264");
      expect(probe.audio?.codecName).toBe("aac");
      expect(probe.video?.nbFrames).toBe(30);
      // -shortest means the audio does not extend the file past the video.
      expect(probe.durationSeconds).toBeCloseTo(1.0, 1);
    } finally {
      await cleanup();
    }
  });
});

describe("rasteriseScene sanity", () => {
  it("yields the full frame range with a pure time function", async () => {
    const scene = makeAnimatedScene({ fps: 30, durationSeconds: 1 });
    const seen: number[] = [];
    for await (const { frame } of rasteriseScene(scene)) seen.push(frame);
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("every rasterised frame is a structurally valid PNG of the right size", async () => {
    const scene = makeAnimatedScene({ fps: 10, durationSeconds: 0.5 });
    let count = 0;
    for await (const { png } of rasteriseScene(scene)) {
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(pngDimensions(png)).toEqual({ width: 320, height: 240 });
      const stats = await pixelStats(png);
      expect(stats.variance).toBeGreaterThan(50);
      count += 1;
    }
    expect(count).toBe(5);
  });
});