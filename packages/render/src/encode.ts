/**
 * Encoder: a stream of rasterised frames → a playable MP4.
 *
 * ## Why frames go through stdin
 *
 * The obvious implementation writes `frame-00001.png` … `frame-02550.png` to a temp
 * directory and passes `-i frame-%05d.png` to FFmpeg. It is also the wrong one here: a
 * 1080p 85-second render is ~2550 frames totalling roughly **6 GB** of PNGs, and the
 * target machine has about **48 GB** free. That is a meaningful fraction of the disk for
 * one export, and it scales linearly with length and resolution.
 *
 * Instead FFmpeg is given `-f image2pipe -framerate <fps> -i -` and reads PNGs from
 * stdin as they are produced. Peak disk usage becomes the output file alone; peak memory
 * becomes one frame.
 *
 * ## Backpressure is the load-bearing detail
 *
 * `stdin.write()` returns `false` when the kernel pipe buffer is full. A loop that
 * ignores that return value still *works* — Node queues the unwritten chunks in memory —
 * but nothing bounds the queue. Against a slow encoder, or with large frames, the queue
 * grows to the size of the entire render: hundreds of MB to multiple GB resident, and in
 * the worst case an OOM kill partway through a long export.
 *
 * So every write here awaits `'drain'` before the next frame. That keeps at most a
 * couple of frames in flight and makes memory flat with respect to render length. This
 * is the single most important correctness property in this file.
 *
 * ## Safety
 *
 * FFmpeg is spawned with `spawn(file, argvArray)` — never `exec` and never a shell
 * string. Filenames, output paths and codec options therefore cannot inject shell
 * metacharacters. `shell: false` is Node's default and is left explicit for clarity.
 *
 * See `ffmpeg-path.ts` for the GPL / libx264 licensing situation. In short: this build
 * is GPLv3, fine for local use, not for redistribution as a hard dependency.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import { requireFfmpegPath } from "./ffmpeg-path.js";

/** Everything the encoder needs to produce a file. */
export interface EncodeOptions {
  /** Absolute path of the MP4 to write. */
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Total frames that will be fed. Used for progress reporting and validation. */
  readonly totalFrames: number;
  /** Optional WAV (or any FFmpeg-readable audio) muxed as AAC. */
  readonly audioPath?: string | undefined;
  /** x264 CRF. 18 is visually near-lossless; lower is bigger. */
  readonly crf?: number | undefined;
  /** x264 preset. `medium` balances speed and size. */
  readonly preset?: string | undefined;
  /** Override FFmpeg discovery. */
  readonly ffmpegPath?: string | undefined;
  /** Called after each frame is accepted by FFmpeg. */
  readonly onProgress?: ((framesWritten: number, totalFrames: number) => void) | undefined;
  /** Cancellation. On abort FFmpeg is killed and the export rejects with an AbortError. */
  readonly signal?: AbortSignal | undefined;
  /** Keep the partial output file on abort. Default false (deleted). */
  readonly keepPartialOnAbort?: boolean | undefined;
}

/** Result of a completed encode. */
export interface EncodeResult {
  readonly outputPath: string;
  readonly framesWritten: number;
  readonly elapsedMs: number;
  /** FFmpeg's stderr, always captured for diagnostics. */
  readonly stderr: string;
}

/** Raised when FFmpeg exits non-zero. Carries the real stderr for diagnosis. */
export class FfmpegError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly outputPath: string;

  constructor(message: string, exitCode: number | null, stderr: string, outputPath: string) {
    super(message);
    this.name = "FfmpegError";
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.outputPath = outputPath;
  }
}

/** Raised when the caller aborts mid-render. */
export class RenderAbortedError extends Error {
  readonly framesWritten: number;
  constructor(framesWritten: number) {
    super(`Render aborted after ${framesWritten} frame(s).`);
    this.name = "RenderAbortedError";
    this.framesWritten = framesWritten;
  }
}

/**
 * Build the FFmpeg argument vector.
 *
 * Exported for testing: the argv is a security-relevant surface (it is the thing that
 * must never be a shell string), so it is asserted directly rather than only observed
 * through its effects.
 */
export function buildFfmpegArgs(options: {
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  audioPath?: string | undefined;
  crf?: number | undefined;
  preset?: string | undefined;
}): string[] {
  const crf = options.crf ?? 18;
  const preset = options.preset ?? "medium";

  // A note on -r vs -framerate: for image2pipe the *input* rate is -framerate, and the
  // output rate is set with -r. Passing both makes the intent explicit and avoids
  // FFmpeg's default 25fps guess for raw image pipes.
  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    // Overwrite without prompting; a prompt would hang a headless render forever.
    "-y",
    "-f", "image2pipe",
    "-framerate", String(options.fps),
    "-vcodec", "png",
    "-i", "-",
  ];

  if (options.audioPath) {
    // Input index 1. -shortest below trims whichever stream is longer.
    args.push("-i", options.audioPath);
  }

  args.push(
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    // yuv420p is required for the file to play in browsers, QuickTime and most TVs.
    // libx264's default (yuv444p for RGB input) produces files that silently fail to
    // play in Safari and on hardware decoders.
    "-pix_fmt", "yuv420p",
    // Even dimensions are mandatory for yuv420p; odd sizes are rejected by the encoder.
    "-vf", `scale=${options.width}:${options.height}:flags=lanczos`,
    "-r", String(options.fps),
  );

  if (options.audioPath) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  // faststart moves the moov atom to the front so the file can stream/scrub before it
  // has fully downloaded.
  args.push("-movflags", "+faststart", options.outputPath);
  return args;
}

/**
 * Encode a sequence of PNG buffers into an MP4.
 *
 * Consumes an async iterable of already-rasterised PNG frames. The iterable is pulled
 * lazily, so rasterisation of frame N+1 overlaps with FFmpeg encoding frame N — a
 * useful pipelining effect that costs nothing to get.
 *
 * Frames are written with strict backpressure: the next frame is only pulled after the
 * previous write has drained.
 */
export async function encodeFrames(
  frames: AsyncIterable<Buffer>,
  options: EncodeOptions,
): Promise<EncodeResult> {
  const started = Date.now();
  const ffmpegPath = options.ffmpegPath ?? requireFfmpegPath();
  const args = buildFfmpegArgs(options);

  if (options.signal?.aborted) {
    throw new RenderAbortedError(0);
  }

  const child: ChildProcessWithoutNullStreams = spawn(ffmpegPath, args, {
    // Explicit: never go through a shell. This is what makes the argv array safe.
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // FFmpeg writes its progress to stderr; capture a bounded amount so a pathological
  // run cannot exhaust memory while still giving us the real error text.
  let stderr = "";
  const MAX_STDERR = 256 * 1024;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR) stderr += chunk;
  });
  // stdout is unused (output goes to a file) but must be drained or the pipe can fill.
  child.stdout.resume();

  let framesWritten = 0;

  // The process exit is awaited exactly once, as a promise, so it can be raced against
  // write errors and aborts.
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    // SIGKILL rather than SIGTERM: on Windows libuv emulates signals by terminating the
    // process outright anyway, and a half-written MP4 is being discarded regardless.
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  /** Write one buffer, resolving when it is safe to write the next. */
  const writeFrame = (buf: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (aborted) {
        reject(new RenderAbortedError(framesWritten));
        return;
      }
      // `write` returning false means "do not write more yet". We honour it by waiting
      // for 'drain'. This is what keeps memory flat across thousands of frames.
      const flushed = child.stdin.write(buf, (err) => {
        if (err) reject(err);
      });
      if (flushed) {
        resolve();
        return;
      }
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        child.stdin.off("drain", onDrain);
        child.stdin.off("error", onError);
      };
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", onError);
    });

  try {
    for await (const frame of frames) {
      if (aborted) throw new RenderAbortedError(framesWritten);
      await writeFrame(frame);
      framesWritten += 1;
      options.onProgress?.(framesWritten, options.totalFrames);
    }

    // Closing stdin sends EOF, which is how FFmpeg knows the image sequence ended.
    await new Promise<void>((resolve) => child.stdin.end(resolve));

    const { code } = await exit;
    if (aborted) throw new RenderAbortedError(framesWritten);
    if (code !== 0) {
      throw new FfmpegError(
        `FFmpeg exited with code ${code} while writing ${options.outputPath}.\n` +
          `--- ffmpeg stderr ---\n${stderr.trim() || "(no stderr captured)"}`,
        code,
        stderr,
        options.outputPath,
      );
    }
  } catch (error) {
    // Ensure the child dies if anything threw, so no orphan keeps the file locked.
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  return {
    outputPath: options.outputPath,
    framesWritten,
    elapsedMs: Date.now() - started,
    stderr,
  };
}