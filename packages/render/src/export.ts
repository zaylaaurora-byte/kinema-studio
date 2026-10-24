/**
 * High-level export entry point.
 *
 * `exportScene(scene, options)` walks frames `0 .. frameCount(scene)-1`, evaluates each
 * one, rasterises it and pipes it to FFmpeg.
 *
 * ## The purity rule, and why it is honoured structurally
 *
 * Every frame is produced by `evaluate(scene, frameToTime(frame, fps))` — a pure call
 * with the time derived from the frame index. Nothing is accumulated across iterations:
 * there is no "previous frame" variable, no time accumulator, no delta. `frame * (1/fps)`
 * is computed fresh each time, so floating-point drift cannot accumulate and frame 2500
 * is exactly as reproducible as frame 0.
 *
 * This is why the export loop is a generator over indices rather than a `for` loop that
 * mutates a running clock. The structure makes the rule hard to violate accidentally.
 */

import { unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import process from "node:process";
import {
  evaluate,
  frameCount,
  frameToTime,
  type SceneDocument,
} from "@kinema/scene-model";
import { encodeFrames, RenderAbortedError, type EncodeResult } from "./encode.js";
import { rasteriseFrame, type RasteriseOptions } from "./rasterise.js";

/** Options for a full scene export. */
export interface ExportSceneOptions {
  /** Absolute path of the MP4 to write. */
  readonly outputPath: string;
  /** Optional audio file muxed as AAC. */
  readonly audioPath?: string | undefined;
  /** x264 CRF (default 18). */
  readonly crf?: number | undefined;
  /** x264 preset (default `medium`). */
  readonly preset?: string | undefined;
  /** Explicit ffmpeg binary. */
  readonly ffmpegPath?: string | undefined;
  /** Rasterisation options (asset resolver, supersampling). */
  readonly rasterise?: RasteriseOptions | undefined;
  /** Progress: frames encoded out of the total. */
  readonly onProgress?: ((framesWritten: number, totalFrames: number) => void) | undefined;
  /** Cancellation. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Also write a sidecar `.progress.json` log of per-frame PNG byte sizes.
   *
   * Off by default. The determinism test uses it to compare frame data at the
   * rasterise stage, which is the only place a byte-exact comparison is meaningful
   * (see the report on x264 determinism).
   */
  readonly frameDigestPath?: string | undefined;
}

/** What an export produced. */
export interface ExportResult {
  readonly outputPath: string;
  readonly frameCount: number;
  /** Container duration as `frameCount / fps`, in seconds. */
  readonly durationSeconds: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly elapsedMs: number;
  /** Per-frame PNG sizes, when `frameDigestPath` was requested. */
  readonly frameByteSizes?: readonly number[] | undefined;
}

/**
 * Lazily generate rasterised PNG frames for a scene.
 *
 * Exported separately from `exportScene` because the determinism tests want to compare
 * raster output *without* invoking the encoder.
 */
export async function* rasteriseScene(
  scene: SceneDocument,
  options: { rasterise?: RasteriseOptions | undefined; signal?: AbortSignal | undefined } = {},
): AsyncGenerator<{ frame: number; png: Buffer }> {
  const total = frameCount(scene);
  for (let frame = 0; frame < total; frame++) {
    if (options.signal?.aborted) throw new RenderAbortedError(0);

    // PURE: computed from the index, never accumulated. See module header.
    const time = frameToTime(frame, scene.fps);
    const evaluated = evaluate(scene, time);
    const png = await rasteriseFrame(evaluated, options.rasterise ?? {});
    yield { frame, png };
  }
}

/**
 * Render a scene to an MP4.
 *
 * On abort the partial output file is deleted, because a truncated MP4 is not a useful
 * artefact and leaving one behind invites a later "why is my export broken" bug. If a
 * partial file is wanted (for resume semantics later), that is a deliberate feature and
 * not a default.
 */
export async function exportScene(
  scene: SceneDocument,
  options: ExportSceneOptions,
): Promise<ExportResult> {
  const started = Date.now();
  const total = frameCount(scene);

  if (total <= 0) {
    throw new Error(
      `Scene "${scene.id}" has zero frames (durationSeconds=${scene.durationSeconds}, fps=${scene.fps}).`,
    );
  }

  const frameByteSizes: number[] = [];
  const wantDigest = Boolean(options.frameDigestPath);

  // A generator, so a frame's PNG is created only when FFmpeg has drained the previous
  // one. Rasterising ahead of the encoder would reintroduce the memory growth that
  // piping is meant to avoid — just in RAM instead of on disk.
  async function* pngStream(): AsyncGenerator<Buffer> {
    const source = rasteriseScene(scene, {
      ...(options.rasterise ? { rasterise: options.rasterise } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for await (const { png } of source) {
      if (wantDigest) frameByteSizes.push(png.length);
      yield png;
    }
  }

  let encoded: EncodeResult;
  try {
    encoded = await encodeFrames(pngStream(), {
      outputPath: options.outputPath,
      width: scene.width,
      height: scene.height,
      fps: scene.fps,
      totalFrames: total,
      ...(options.audioPath ? { audioPath: options.audioPath } : {}),
      ...(options.crf !== undefined ? { crf: options.crf } : {}),
      ...(options.preset !== undefined ? { preset: options.preset } : {}),
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // A partial file is worse than no file: it looks like a successful render.
    if (error instanceof RenderAbortedError && !options.signal?.aborted) throw error;
    await unlink(options.outputPath).catch(() => undefined);
    throw error;
  }

  // Sanity check: FFmpeg must have received exactly the frames we intended to send.
  // A mismatch means a silent truncation, which is the failure mode most likely to go
  // unnoticed in a long unattended render.
  if (encoded.framesWritten !== total) {
    throw new Error(
      `Frame count mismatch: expected ${total}, sent ${encoded.framesWritten}. ` +
        `Output at ${options.outputPath} is likely truncated.`,
    );
  }

  if (wantDigest && options.frameDigestPath) {
    const body = JSON.stringify({ sceneId: scene.id, frameByteSizes }, null, 2);
    await writeFileText(options.frameDigestPath, body);
  }

  return {
    outputPath: options.outputPath,
    frameCount: total,
    durationSeconds: total / scene.fps,
    fps: scene.fps,
    width: scene.width,
    height: scene.height,
    elapsedMs: Date.now() - started,
    ...(wantDigest ? { frameByteSizes } : {}),
  };
}

/** Small local helper so `exportScene` has no dependency on a fs-promises import chain. */
async function writeFileText(path: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path, { encoding: "utf8" });
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(text);
  });
}

/** True when the current process is on Windows (used by tests for path assertions). */
export const IS_WINDOWS = process.platform === "win32";