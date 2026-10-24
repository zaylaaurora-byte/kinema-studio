/**
 * Smoke test for the render pipeline.
 *
 * The claim under test: the scene model can produce frames, and FFmpeg can turn them
 * into a real, playable MP4.
 *
 * This is a deliberately SMALL, self-contained check that does not depend on the
 * @kinema/render package, the rig builder, or any asset. If it passes, the fundamental
 * chain (evaluate -> rasterise -> encode -> probe) is proven to work on this machine,
 * and any later failure is in the layer above rather than the foundation.
 *
 * Run: python tools/pipeline_smoke.py
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluate, frameCount, frameToTime, type Rig, type SceneDocument } from "@kinema/scene-model";
import { createCanvas } from "@napi-rs/canvas";

// ---------------------------------------------------------------------------
// Locate FFmpeg. Do not assume PATH: the winget install updates PATH only for new
// shells, so a long-running process may not see it.
// ---------------------------------------------------------------------------
function findFfmpeg(): string {
  const candidates = [
    process.env["FFMPEG_PATH"],
    join(
      process.env["LOCALAPPDATA"] ?? "",
      "Microsoft/WinGet/Links/ffmpeg.exe",
    ),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to searching the winget package directory.
  const packages = join(process.env["LOCALAPPDATA"] ?? "", "Microsoft/WinGet/Packages");
  if (existsSync(packages)) {
    const found = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-ChildItem '${packages}' -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    if (found && existsSync(found)) return found;
  }

  throw new Error("FFmpeg not found. Install with: winget install Gyan.FFmpeg");
}

const FFMPEG = findFfmpeg();
const FFPROBE = join(FFMPEG, "..", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

console.log("=".repeat(78));
console.log("PIPELINE SMOKE TEST");
console.log("=".repeat(78));
console.log(`\nffmpeg: ${FFMPEG}`);
console.log(`ffprobe: ${existsSync(FFPROBE) ? FFPROBE : "NOT FOUND"}`);

// ---------------------------------------------------------------------------
// Build a scene that produces VISIBLY DIFFERENT frames over time.
//
// A scene that looks the same at every frame would let a broken renderer pass, so the
// rig below moves a part substantially across the duration, and changes colour too.
// ---------------------------------------------------------------------------
const WIDTH = 320;
const HEIGHT = 240;
const FPS = 24;
const DURATION = 2; // seconds -> 48 frames

const rig: Rig = {
  id: "smoke-rig",
  name: "Smoke rig",
  styleRef: "main",
  styles: {
    main: { fill: "#E6F55A", stroke: "#0B0D0E", strokeWidth: 4 },
  },
  parts: [
    {
      id: "ball",
      localPosition: { x: 60, y: 120 },
      zIndex: 1,
      shapes: [{ kind: "circle", radius: 40 }],
      channels: {
        // Travels most of the way across the canvas.
        x: {
          kind: "number",
          keyframes: [
            { time: 0, value: 60 },
            { time: DURATION, value: WIDTH - 60, easing: "easeInOut" },
          ],
        },
        // And bounces vertically, so no two frames are identical.
        y: {
          kind: "number",
          keyframes: [
            { time: 0, value: 120 },
            { time: 0.5, value: 60 },
            { time: 1.0, value: 120 },
            { time: 1.5, value: 60 },
            { time: 2.0, value: 120 },
          ],
        },
        rotation: {
          kind: "number",
          keyframes: [
            { time: 0, value: 0 },
            { time: DURATION, value: Math.PI * 2 },
          ],
        },
        scaleX: {
          kind: "number",
          keyframes: [
            { time: 0, value: 1 },
            { time: 1, value: 1.4 },
            { time: 2, value: 1 },
          ],
        },
        scaleY: {
          kind: "number",
          keyframes: [
            { time: 0, value: 1 },
            { time: 1, value: 0.7 },
            { time: 2, value: 1 },
          ],
        },
      },
    },
  ],
};

const scene: SceneDocument = {
  id: "smoke",
  name: "Smoke test scene",
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  durationSeconds: DURATION,
  background: "#101315",
  layers: [{ id: "main", name: "Main", zIndex: 0, visible: true, opacity: 1, rig }],
};

const totalFrames = frameCount(scene);
console.log(`\nscene: ${WIDTH}x${HEIGHT} @ ${FPS}fps for ${DURATION}s = ${totalFrames} frames`);

// ---------------------------------------------------------------------------
// Rasterise one frame.
// ---------------------------------------------------------------------------
function rasterise(timeSeconds: number): Buffer {
  const frame = evaluate(scene, timeSeconds);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // Reset to a known state. Canvas contexts are stateful, and an unbalanced
  // save/restore silently poisons every subsequent draw.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  ctx.fillStyle = scene.background ?? "#000000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const cam = frame.camera;

  for (const part of frame.parts) {
    const t = part.world;

    // Compose camera * part explicitly rather than nesting setTransform calls, so the
    // maths is visible and the state cannot leak between parts.
    const m = {
      a: cam.a * t.a + cam.c * t.b,
      b: cam.b * t.a + cam.d * t.b,
      c: cam.a * t.c + cam.c * t.d,
      d: cam.b * t.c + cam.d * t.d,
      e: cam.a * t.e + cam.c * t.f + cam.e,
      f: cam.b * t.e + cam.d * t.f + cam.f,
    };

    const style = part.style ?? {};
    ctx.globalAlpha = style.opacity ?? 1;

    for (const shape of part.shapes ?? []) {
      // Apply the absolute transform for THIS part, inside a save/restore pair so the
      // state cannot leak to the next part.
      ctx.save();
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);

      ctx.beginPath();
      switch (shape.kind) {
        case "circle":
          ctx.arc(shape.cx ?? 0, shape.cy ?? 0, shape.radius, 0, Math.PI * 2);
          break;
        case "ellipse":
          ctx.ellipse(shape.cx ?? 0, shape.cy ?? 0, shape.rx, shape.ry, 0, 0, Math.PI * 2);
          break;
        case "rect":
          // Draw from the local origin; the transform places it.
          ctx.rect(0, 0, shape.width, shape.height);
          break;
        case "capsule": {
          const dx = shape.to.x - shape.from.x;
          const dy = shape.to.y - shape.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = (-dy / len) * shape.radius;
          const ny = (dx / len) * shape.radius;
          ctx.moveTo(shape.from.x + nx, shape.from.y + ny);
          ctx.lineTo(shape.to.x + nx, shape.to.y + ny);
          ctx.lineTo(shape.to.x - nx, shape.to.y - ny);
          ctx.lineTo(shape.from.x - nx, shape.from.y - ny);
          ctx.closePath();
          break;
        }
        default:
          break;
      }

      if (style.fill) {
        ctx.fillStyle = style.fill;
        ctx.fill();
      }
      if (style.stroke && (style.strokeWidth ?? 0) > 0) {
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.strokeWidth!;
        ctx.stroke();
      }

      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  return canvas.toBuffer("image/png");
}

// ---------------------------------------------------------------------------
// Rasterise every frame, checking that they actually DIFFER.
// ---------------------------------------------------------------------------
const outDir = join(tmpdir(), "kinema-smoke");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log("\n--- rasterising frames ---");
const frameHashes = new Set<string>();
const frameSizes: number[] = [];
const firstFew: Buffer[] = [];

for (let i = 0; i < totalFrames; i++) {
  const time = frameToTime(i, FPS);
  const png = rasterise(time);

  // PNG signature check, so a silently-broken canvas is caught immediately.
  if (i === 0) {
    const sig = png.subarray(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!sig.equals(expected)) throw new Error("rasterise() did not produce a PNG");
    console.log(`  frame 0 PNG signature OK (${png.length} bytes)`);
  }

  // Hash the WHOLE image. Hashing only the first bytes hashes the PNG header, which is
  // identical for every image - a check that can never fail is worse than no check.
  frameHashes.add(createHash("sha256").update(png).digest("hex"));
  frameSizes.push(png.length);
  if (i < 3) firstFew.push(png);
}

console.log(`  ${totalFrames} frames rasterised`);
console.log(`  distinct frame hashes: ${frameHashes.size} / ${totalFrames}`);
console.log(
  `  byte sizes: min=${Math.min(...frameSizes)} max=${Math.max(...frameSizes)}`,
);

if (frameHashes.size < totalFrames * 0.8) {
  throw new Error(
    `Frames are not sufficiently distinct (${frameHashes.size}/${totalFrames}). ` +
      `The animation may not actually be moving.`,
  );
}

// Save a few frames for independent inspection.
for (const [i, png] of firstFew.entries()) {
  writeFileSync(join(outDir, `frame-${String(i).padStart(4, "0")}.png`), png);
}

// ---------------------------------------------------------------------------
// Encode to MP4 by streaming frames into FFmpeg's stdin.
//
// Streaming matters: writing 48 PNGs here is trivial, but the same code path is used
// for a 2550-frame pilot, which would be ~6 GB on disk.
// ---------------------------------------------------------------------------
console.log("\n--- encoding to MP4 ---");
const mp4Path = join(outDir, "smoke.mp4");

const args = [
  "-y",
  "-f", "image2pipe",
  "-framerate", String(FPS),
  "-i", "-",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  mp4Path,
];

const ffmpeg = spawnSync(FFMPEG, args, {
  input: Buffer.concat(
    Array.from({ length: totalFrames }, (_, i) => rasterise(frameToTime(i, FPS))),
  ),
  maxBuffer: 1024 * 1024 * 512,
  encoding: "buffer",
});

if (ffmpeg.status !== 0) {
  console.error("ffmpeg stderr:", ffmpeg.stderr?.toString().slice(-2000));
  throw new Error(`ffmpeg exited with code ${ffmpeg.status}`);
}

const size = statSync(mp4Path).size;
console.log(`  wrote ${mp4Path}`);
console.log(`  size: ${(size / 1024).toFixed(1)} KB`);

if (size < 1000) {
  throw new Error(`Output MP4 is implausibly small (${size} bytes)`);
}

// ---------------------------------------------------------------------------
// Verify with ffprobe — an independent tool, not our own code.
// ---------------------------------------------------------------------------
console.log("\n--- verifying with ffprobe ---");
const probe = JSON.parse(
  execFileSync(
    FFPROBE,
    [
      "-v", "error",
      "-show_entries", "stream=codec_name,width,height,nb_frames,r_frame_rate,duration",
      "-show_entries", "format=format_name,duration,size",
      "-of", "json",
      mp4Path,
    ],
    { encoding: "utf8" },
  ),
);

const video = probe.streams.find((s: { codec_name?: string }) => s.codec_name === "h264");
const format = probe.format;

console.log(`  container: ${format.format_name}`);
console.log(`  duration:  ${format.duration}s`);
console.log(`  video:     ${video.codec_name} ${video.width}x${video.height} @ ${video.r_frame_rate}`);
console.log(`  frames:    ${video.nb_frames}`);

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

check(video.codec_name === "h264", "codec is h264");
check(video.width === WIDTH && video.height === HEIGHT, `dimensions are ${WIDTH}x${HEIGHT}`);
check(Number(video.nb_frames) === totalFrames, `frame count is ${totalFrames}`);
check(
  Math.abs(Number(format.duration) - DURATION) < 0.2,
  `duration is ~${DURATION}s`,
);

console.log("\n" + "=".repeat(78));
if (failures === 0) {
  console.log("PIPELINE VERIFIED: scene model -> rasterise -> FFmpeg -> playable MP4");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
}
console.log("=".repeat(78));
console.log(`\nArtifacts in: ${outDir}`);
console.log("Inspect a frame and the video to confirm visually.\n");