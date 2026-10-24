/**
 * Shared test fixtures and helpers.
 *
 * The scenes here are built to be *visibly different frame to frame* — a static scene
 * would let a broken renderer pass a "file has frames" check while producing garbage.
 * Each fixture animates position, rotation and scale so consecutive frames differ in
 * both pixel content and PNG size.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { requireFfprobePath, resolveFfmpegPath } from "./ffmpeg-path.js";
import type { SceneDocument, Shape } from "@kinema/scene-model";

const execFileAsync = promisify(execFile);

/**
 * Locate FFmpeg for the test suite.
 *
 * Production resolves FFmpeg through `FFMPEG_PATH` then PATH. Neither works on the
 * development machine this package was written on: the winget install placed the binary
 * under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\...` and did NOT create a PATH shim
 * (the `WinGet\Links` directory is empty), so a fresh shell cannot find `ffmpeg` at all.
 *
 * Tests must therefore be able to find it without a manually-exported environment
 * variable, or they would be unrunnable as written. The fallback below scans the winget
 * package directory for a real build.
 *
 * This is test-only discovery. Production code deliberately does not do this, because
 * guessing at installer-specific paths in shipped code is fragile and would obscure the
 * licensing decision documented in `ffmpeg-path.ts`.
 */
export function findFfmpegForTests(): string {
  // 1. Everything production would try.
  const viaProduction = resolveFfmpegPath();
  if (viaProduction) return viaProduction;

  // 2. winget's per-package install location, newest build first.
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData) {
    const packagesDir = join(localAppData, "Microsoft", "WinGet", "Packages");
    if (existsSync(packagesDir)) {
      for (const pkg of readdirSync(packagesDir)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const pkgDir = join(packagesDir, pkg);
        for (const build of readdirSync(pkgDir)) {
          const candidate = join(pkgDir, build, "bin", `ffmpeg${process.platform === "win32" ? ".exe" : ""}`);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }

  throw new Error(
    "FFmpeg could not be found for the test suite. Install it (winget install Gyan.FFmpeg) " +
      "or set FFMPEG_PATH to the absolute path of the ffmpeg executable.",
  );
}

/** Probe with the test-discovered ffprobe, which sits beside the test-discovered ffmpeg. */
export function findFfprobeForTests(): string {
  const ffmpeg = findFfmpegForTests();
  const sibling = join(
    dirname(ffmpeg),
    `ffprobe${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (existsSync(sibling)) return sibling;
  return requireFfprobePath();
}

/** A temporary directory removed when `cleanup` is called. */
export async function makeTempDir(prefix = "kinema-render-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * A minimal "character": a circle head and a capsule body, both procedural, so no
 * asset files are needed. Motion is applied on multiple channels so every frame differs.
 */
export function makeAnimatedScene(overrides: Partial<SceneDocument> = {}): SceneDocument {
  const headShapes: Shape[] = [
    { kind: "circle", radius: 22 },
    { kind: "path", d: "M -8 -4 L 8 -4 L 0 6 Z" },
  ];
  const bodyShapes: Shape[] = [{ kind: "capsule", from: { x: 0, y: -30 }, to: { x: 0, y: 30 }, radius: 14 }];

  const scene: SceneDocument = {
    id: "fixture-animated",
    name: "Animated fixture",
    width: 320,
    height: 240,
    fps: 30,
    durationSeconds: 1,
    background: "#101020",
    layers: [
      {
        id: "layer-actor",
        name: "Actor",
        zIndex: 10,
        visible: true,
        opacity: 1,
        rig: {
          id: "rig-actor",
          name: "Actor",
          styleRef: "ink",
          styles: {
            ink: { fill: "#ffffff", stroke: "#000000", strokeWidth: 6 },
            accent: { fill: "#e8483f", stroke: "#000000", strokeWidth: 4 },
          },
          parts: [
            {
              id: "body",
              zIndex: 0,
              localPosition: { x: 160, y: 130 },
              shapes: bodyShapes,
              channels: {
                // Continuous rotation: consecutive frames differ by a visible amount.
                rotation: {
                  kind: "number",
                  keyframes: [
                    { time: 0, value: 0 },
                    { time: 1, value: Math.PI },
                  ],
                },
                x: {
                  kind: "number",
                  keyframes: [
                    { time: 0, value: 120, easing: "easeInOut" },
                    { time: 1, value: 200 },
                  ],
                },
              },
            },
            {
              id: "head",
              parentId: "body",
              zIndex: 1,
              // Parented to the body, so it inherits the body's motion — exercising the
              // rig hierarchy, not just a flat transform.
              localPosition: { x: 0, y: -52 },
              shapes: headShapes,
              channels: {
                scaleX: {
                  kind: "number",
                  keyframes: [
                    { time: 0, value: 1 },
                    { time: 0.5, value: 1.4 },
                    { time: 1, value: 1 },
                  ],
                },
                scaleY: {
                  kind: "number",
                  keyframes: [
                    { time: 0, value: 1 },
                    { time: 0.5, value: 1.4 },
                    { time: 1, value: 1 },
                  ],
                },
              },
            },
          ],
        },
      },
      {
        id: "layer-marker",
        name: "Marker",
        zIndex: 20,
        visible: true,
        opacity: 1,
        rig: {
          id: "rig-marker",
          name: "Marker",
          styleRef: "accent",
          styles: { accent: { fill: "#e8483f", stroke: "#000000", strokeWidth: 4 } },
          parts: [
            {
              id: "marker",
              zIndex: 0,
              localPosition: { x: 40, y: 40 },
              shapes: [{ kind: "ellipse", rx: 18, ry: 12 }],
              channels: {
                y: {
                  kind: "number",
                  keyframes: [
                    { time: 0, value: 40 },
                    { time: 1, value: 200 },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
    camera: {
      channels: {
        // A zoom, so the camera transform is non-identity and is genuinely exercised.
        zoom: {
          kind: "number",
          keyframes: [
            { time: 0, value: 1 },
            { time: 1, value: 1.3 },
          ],
        },
      },
    },
    ...overrides,
  };
  return scene;
}

/** A deliberately static scene, used to check that identical frames encode sanely. */
export function makeStaticScene(overrides: Partial<SceneDocument> = {}): SceneDocument {
  return {
    id: "fixture-static",
    name: "Static fixture",
    width: 320,
    height: 240,
    fps: 30,
    durationSeconds: 0.5,
    layers: [
      {
        id: "layer-static",
        name: "Static",
        zIndex: 1,
        visible: true,
        opacity: 1,
        rig: {
          id: "rig-static",
          name: "Static",
          styleRef: "ink",
          styles: { ink: { fill: "#ffffff", stroke: "#000000", strokeWidth: 6 } },
          parts: [
            {
              id: "blob",
              zIndex: 0,
              localPosition: { x: 160, y: 120 },
              shapes: [{ kind: "rect", width: 80, height: 60, rx: 10 }],
              channels: {},
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

/** Machine-readable ffprobe output. */
export interface ProbeResult {
  readonly raw: string;
  readonly formatName: string;
  readonly formatLongName: string;
  readonly durationSeconds: number;
  readonly streams: readonly {
    codecType: string;
    codecName: string;
    width?: number;
    height?: number;
    nbFrames?: number;
    rFrameRate?: string;
    sampleRate?: string;
    channels?: number;
  }[];
  readonly video?: {
    codecName: string;
    width: number;
    height: number;
    nbFrames?: number;
    rFrameRate?: string;
  };
  readonly audio?: { codecName: string; sampleRate?: string; channels?: number };
}

/**
 * Run ffprobe and parse the result.
 *
 * Uses `spawn`-backed `execFile` with an argv array (no shell), matching the encoder's
 * own discipline. `-count_frames` is deliberately NOT used by default: it decodes the
 * whole file, which is slow. `nb_frames` from the container is enough to assert the
 * frame count for a file we just wrote, and the report notes where the two differ.
 */
export async function ffprobe(filePath: string, countFrames = false): Promise<ProbeResult> {
  const ffprobePath = requireFfprobePath();
  const args = [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-print_format", "json",
    ...(countFrames ? ["-count_frames"] : []),
    filePath,
  ];
  const { stdout } = await execFileAsync(ffprobePath, args, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });

  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; format_long_name?: string; duration?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      nb_frames?: string;
      nb_read_frames?: string;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }[];
  };

  const streams = (parsed.streams ?? []).map((s) => {
    const nbRaw = s.nb_read_frames ?? s.nb_frames;
    return {
      codecType: s.codec_type ?? "",
      codecName: s.codec_name ?? "",
      ...(s.width !== undefined ? { width: s.width } : {}),
      ...(s.height !== undefined ? { height: s.height } : {}),
      ...(nbRaw !== undefined ? { nbFrames: Number(nbRaw) } : {}),
      ...(s.r_frame_rate !== undefined ? { rFrameRate: s.r_frame_rate } : {}),
      ...(s.sample_rate !== undefined ? { sampleRate: s.sample_rate } : {}),
      ...(s.channels !== undefined ? { channels: s.channels } : {}),
    };
  });

  const v = streams.find((s) => s.codecType === "video");
  const a = streams.find((s) => s.codecType === "audio");

  return {
    raw: stdout,
    formatName: parsed.format?.format_name ?? "",
    formatLongName: parsed.format?.format_long_name ?? "",
    durationSeconds: Number(parsed.format?.duration ?? "0"),
    streams,
    ...(v
      ? {
          video: {
            codecName: v.codecName,
            width: v.width ?? 0,
            height: v.height ?? 0,
            ...(v.nbFrames !== undefined ? { nbFrames: v.nbFrames } : {}),
            ...(v.rFrameRate !== undefined ? { rFrameRate: v.rFrameRate } : {}),
          },
        }
      : {}),
    ...(a
      ? {
          audio: {
            codecName: a.codecName,
            ...(a.sampleRate !== undefined ? { sampleRate: a.sampleRate } : {}),
            ...(a.channels !== undefined ? { channels: a.channels } : {}),
          },
        }
      : {}),
  };
}

/**
 * Mean and variance of pixel luminance, for asserting a render is not blank.
 *
 * Decodes the PNG with `@napi-rs/canvas` rather than ffmpeg so the check is independent
 * of the pipeline under test.
 */
export async function pixelStats(png: Buffer): Promise<{
  mean: number;
  variance: number;
  min: number;
  max: number;
  distinctColors: number;
}> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;

  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  const colors = new Set<number>();
  const n = image.width * image.height;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    // Rec. 601 luma; the exact weights do not matter, only that the measure is
    // sensitive to any visible content.
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma;
    sumSq += luma * luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    if (colors.size < 100_000) colors.add((r << 16) | (g << 8) | b);
  }

  const mean = sum / n;
  return {
    mean,
    variance: sumSq / n - mean * mean,
    min,
    max,
    distinctColors: colors.size,
  };
}

/** Read PNG IHDR dimensions without decoding the whole image. */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  // 8-byte signature, then a 4-byte length, "IHDR", then width and height as big-endian
  // uint32 at offsets 16 and 20.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** SHA-256 of a file, as hex. */
export async function fileHash(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}