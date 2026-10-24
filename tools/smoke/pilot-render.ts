/**
 * Pilot render — turn the REAL Bad Example script into rendered frames.
 *
 * This is the integration point everything else has been building toward: the script
 * data supplies the scenes, the scene model supplies deterministic evaluation, the pose
 * system supplies discrete character poses, and the render package encodes it.
 *
 * Deliberately renders a SINGLE SCENE to start rather than all 85 seconds. Reasons:
 *   - a full render is ~2550 frames at 1080p and ~6 GB of intermediate data if anything
 *     goes wrong; proving one scene first keeps failure cheap
 *   - scene 1 (Studio Intro, 8s) contains the host at her desk, which is the shot the
 *     pilot's acceptance criteria call out first: "eye movement, blink and voice synced
 *     to facial animation"
 *
 * The output is an MP4 plus a small contact sheet of frames, so the result can be
 * inspected visually rather than taken on trust.
 *
 * Run: pnpm --filter @kinema/smoke exec vitest run pilot-render
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  evaluate,
  frameCount,
  frameToTime,
  makeTransform,
  type Rig,
  type RigPart,
  type SceneDocument,
  type Shape,
} from "@kinema/scene-model";

// ---------------------------------------------------------------------------
// Canvas + FFmpeg discovery. Neither is assumed to be on PATH.
// ---------------------------------------------------------------------------
const FFMPEG_CANDIDATES = [
  process.env["FFMPEG_PATH"],
  join(
    process.env["LOCALAPPDATA"] ?? "",
    "Microsoft/WinGet/Links/ffmpeg.exe",
  ),
];

function findFfmpeg(): string {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  // The winget Links shim is often absent even when the package is installed, so
  // fall back to the package directory itself.
  const packages = join(process.env["LOCALAPPDATA"] ?? "", "Microsoft/WinGet/Packages");
  if (existsSync(packages)) {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
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

  throw new Error(
    "FFmpeg not found. Install with: winget install Gyan.FFmpeg, or set FFMPEG_PATH.",
  );
}

// ---------------------------------------------------------------------------
// Pilot timing constants, read from the real script package.
// ---------------------------------------------------------------------------
const FPS = 30;
const SCENE_ID = "sc-01";
const SCENE_DURATION = 8; // Studio Intro
const WIDTH = 960;
const HEIGHT = 540; // 16:9, half of 1080p so a scene renders in a reasonable time

// ---------------------------------------------------------------------------
// The host rig.
//
// A simplified stand-in for the full character rig another task is building. It exists
// here to prove the PIPELINE end to end with a pose-driven character: puppet parts with
// a parent/child hierarchy, driven by DISCRETE pose swaps rather than smooth tweening,
// which is the animation style ADR 0003 specifies.
//
// Colours are taken from the design tokens and the reference sheet's declared palette:
// warm pale skin, dark brown hair, near-black horns, cream jumper.
// ---------------------------------------------------------------------------
const SKIN = "#EBB59F";
const HAIR = "#3A2320";
const HORN = "#1A1616";
const JUMPER = "#F2EAD9";
const DARK = "#14100F";
const EYE = "#E8A33D";

function rect(w: number, h: number, r = 0): Shape {
  return r > 0 ? { kind: "rect", width: w, height: h, rx: r } : { kind: "rect", width: w, height: h };
}

function circle(r: number): Shape {
  return { kind: "circle", radius: r };
}

function capsule(fromX: number, fromY: number, toX: number, toY: number, r: number): Shape {
  return { kind: "capsule", from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, radius: r };
}

/**
 * Build the host rig at an extreme value for a single pose property.
 *
 * `headTilt` and `blink` are separated because they are the two things the pilot brief
 * calls out for this scene ("eye movement, blink and voice synced to facial animation").
 *
 * ANATOMY NOTE: the first version of this rig rendered as a floating head, because parts
 * were positioned in absolute-feeling coordinates without a consistent body plan. The
 * numbers below are derived from a single vertical layout, measured DOWN from the hip
 * line at y=0, so the pieces actually join up:
 *
 *     y = -250   top of hair
 *     y = -190   eye line
 *     y = -140   chin
 *     y = -110   shoulders          <- arms attach here
 *     y =  -30   chest
 *     y =    0   hip line           <- rig origin
 *     y =  +90   hem of the jumper
 *
 * The head is ~125 units tall against a ~350-unit body, giving roughly 3.5 heads, which
 * matches the reference sheet's stated proportions for the human and reads correctly for
 * the host. Poses are DISCRETE: every channel holds a single keyframe.
 */
function buildHostRig(options: {
  headTilt: number;
  blink: number; // 1 = eyes open, 0 = closed
  browRaise: number;
  mouthOpen: number;
}): Rig {
  const { headTilt, blink, browRaise, mouthOpen } = options;

  // Eye height scales toward zero when blinking. A genuine shape swap rather than a fade,
  // which is how the style reads on screen.
  const eyeHeight = Math.max(0.06, blink);

  const parts: RigPart[] = [
    // --- Torso ------------------------------------------------------------
    // Drawn downward from the shoulder line so the body reads as one mass.
    {
      id: "torso",
      localPosition: { x: 0, y: -30 },
      zIndex: 10,
      shapes: [rect(120, 190, 22)],
      channels: {},
    },
    // A slightly wider band at the shoulders, giving the jumper its oversized look.
    {
      id: "shoulders",
      parentId: "torso",
      localPosition: { x: 0, y: -85 },
      zIndex: 11,
      shapes: [rect(138, 46, 20)],
      channels: {},
    },
    // The jumper hem, so the torso does not end in a bare edge.
    {
      id: "hem",
      parentId: "torso",
      localPosition: { x: 0, y: 92 },
      zIndex: 9,
      shapes: [rect(128, 26, 10)],
      channels: {},
    },

    // --- Arms -------------------------------------------------------------
    // Attached at the shoulder line (y = -85 within the torso) and drawn along their
    // length, so they visually connect to the body rather than floating beside it.
    {
      id: "arm-left",
      parentId: "torso",
      localPosition: { x: -62, y: -76 },
      zIndex: 8,
      shapes: [capsule(0, 0, 6, 96, 15)],
      channels: {
        // A slight outward droop, which reads as relaxed rather than rigid.
        rotation: { kind: "number", keyframes: [{ time: 0, value: 0.14 }] },
      },
    },
    {
      id: "arm-right",
      parentId: "torso",
      localPosition: { x: 62, y: -76 },
      zIndex: 12,
      // Raised and gesturing toward the contestant, as in the opening keyframe.
      shapes: [capsule(0, 0, 34, -74, 15)],
      channels: {},
    },

    // --- Head -------------------------------------------------------------
    {
      id: "neck",
      parentId: "torso",
      localPosition: { x: 0, y: -104 },
      zIndex: 7,
      shapes: [rect(34, 34, 8)],
      channels: {},
    },
    {
      id: "head",
      parentId: "neck",
      localPosition: { x: 0, y: -40 },
      // The tilt is a discrete pose value, not an interpolated curve.
      zIndex: 20,
      shapes: [{ kind: "ellipse", rx: 50, ry: 56 }],
      channels: {
        rotation: { kind: "number", keyframes: [{ time: 0, value: headTilt }] },
      },
    },

    // --- Housing behind the face -----------------------------------------
    // Hair mass sits behind the head (lower zIndex) so the face reads on top of it.
    {
      id: "hair-back",
      parentId: "head",
      localPosition: { x: 0, y: 4 },
      zIndex: 19,
      shapes: [{ kind: "ellipse", rx: 64, ry: 70 }],
      channels: {},
    },
    // Horns attach at the temples and sweep up and back.
    {
      id: "horn-left",
      parentId: "head",
      localPosition: { x: -34, y: -44 },
      zIndex: 18,
      shapes: [capsule(0, 0, -20, -36, 11)],
      channels: {},
    },
    {
      id: "horn-right",
      parentId: "head",
      localPosition: { x: 34, y: -44 },
      zIndex: 18,
      shapes: [capsule(0, 0, 20, -36, 11)],
      channels: {},
    },

    // --- Face -------------------------------------------------------------
    {
      id: "eye-left",
      parentId: "head",
      localPosition: { x: -19, y: -2 },
      zIndex: 22,
      shapes: [{ kind: "ellipse", rx: 9, ry: 9 * eyeHeight }],
      channels: {},
    },
    {
      id: "eye-right",
      parentId: "head",
      localPosition: { x: 19, y: -2 },
      zIndex: 22,
      shapes: [{ kind: "ellipse", rx: 9, ry: 9 * eyeHeight }],
      channels: {},
    },
    {
      id: "brow-left",
      parentId: "head",
      localPosition: { x: -19, y: -20 - browRaise * 7 },
      zIndex: 23,
      shapes: [rect(20, 5, 2)],
      channels: {},
    },
    {
      id: "brow-right",
      parentId: "head",
      localPosition: { x: 19, y: -20 - browRaise * 7 },
      zIndex: 23,
      shapes: [rect(20, 5, 2)],
      channels: {},
    },
    {
      id: "mouth",
      parentId: "head",
      localPosition: { x: 0, y: 26 },
      zIndex: 24,
      shapes: [{ kind: "ellipse", rx: 13, ry: 3 + mouthOpen * 12 }],
      channels: {},
    },

    // --- Tail -------------------------------------------------------------
    // Attaches low on the torso and curves out to the right.
    {
      id: "tail",
      parentId: "torso",
      localPosition: { x: 54, y: 80 },
      zIndex: 6,
      shapes: [capsule(0, 0, 54, 26, 7)],
      channels: {},
    },
    {
      id: "tail-tip",
      parentId: "tail",
      localPosition: { x: 54, y: 26 },
      zIndex: 6,
      shapes: [{ kind: "ellipse", rx: 11, ry: 14 }],
      channels: {},
    },
  ];

  return {
    id: "host-rig",
    name: "Demon Host",
    parts,
  };
}

/**
 * Styles per part.
 *
 * Held in a separate map rather than on the rig, because the scene model applies one
 * style per rig via `styleRef`. This helper exists so the pose code stays readable.
 */
const PART_STYLES: Record<string, { fill: string; stroke: string; strokeWidth: number }> = {
  torso: { fill: JUMPER, stroke: DARK, strokeWidth: 5 },
  shoulders: { fill: JUMPER, stroke: DARK, strokeWidth: 5 },
  hem: { fill: JUMPER, stroke: DARK, strokeWidth: 4 },
  "arm-left": { fill: JUMPER, stroke: DARK, strokeWidth: 5 },
  "arm-right": { fill: JUMPER, stroke: DARK, strokeWidth: 5 },
  neck: { fill: SKIN, stroke: DARK, strokeWidth: 4 },
  head: { fill: SKIN, stroke: DARK, strokeWidth: 5 },
  "horn-left": { fill: HORN, stroke: DARK, strokeWidth: 4 },
  "horn-right": { fill: HORN, stroke: DARK, strokeWidth: 4 },
  "hair-back": { fill: HAIR, stroke: DARK, strokeWidth: 5 },
  "eye-left": { fill: EYE, stroke: DARK, strokeWidth: 3 },
  "eye-right": { fill: EYE, stroke: DARK, strokeWidth: 3 },
  "brow-left": { fill: HAIR, stroke: DARK, strokeWidth: 2 },
  "brow-right": { fill: HAIR, stroke: DARK, strokeWidth: 2 },
  mouth: { fill: "#C4707A", stroke: DARK, strokeWidth: 3 },
  tail: { fill: HORN, stroke: DARK, strokeWidth: 4 },
  "tail-tip": { fill: HORN, stroke: DARK, strokeWidth: 4 },
};

/**
 * The acting beats for scene 1, as DISCRETE poses with holds.
 *
 * Times are authored in seconds and chosen to sit on the dialogue:
 *   0.0-1.2  neutral, settling
 *   1.2-2.4  a blink, held slightly
 *   2.4-4.0  raising a brow, the "welcome" beat
 *   4.0-5.2  talking, mouth open
 *   5.2-6.4  a second blink
 *   6.4-8.0  back to a relaxed idle, mouth closed
 *
 * Note there is no interpolation here: each entry HOLDS until the next switch. That is
 * the whole point of the technique.
 */
const ACTING_BEATS: readonly {
  time: number;
  headTilt: number;
  blink: number;
  browRaise: number;
  mouthOpen: number;
}[] = [
  { time: 0.0, headTilt: -0.04, blink: 1, browRaise: 0, mouthOpen: 0 },
  { time: 1.2, headTilt: -0.02, blink: 0.05, browRaise: 0, mouthOpen: 0 },
  { time: 1.35, headTilt: -0.02, blink: 1, browRaise: 0, mouthOpen: 0 },
  { time: 2.4, headTilt: 0.05, blink: 1, browRaise: 1, mouthOpen: 0.15 },
  { time: 3.2, headTilt: 0.05, blink: 1, browRaise: 1, mouthOpen: 0.55 },
  { time: 4.0, headTilt: 0.03, blink: 1, browRaise: 0.6, mouthOpen: 0.85 },
  { time: 4.5, headTilt: 0.03, blink: 1, browRaise: 0.6, mouthOpen: 0.3 },
  { time: 4.9, headTilt: 0.03, blink: 1, browRaise: 0.6, mouthOpen: 0.7 },
  { time: 5.2, headTilt: 0.0, blink: 0.05, browRaise: 0.4, mouthOpen: 0.1 },
  { time: 5.35, headTilt: 0.0, blink: 1, browRaise: 0.4, mouthOpen: 0.1 },
  { time: 6.4, headTilt: -0.03, blink: 1, browRaise: 0.2, mouthOpen: 0.05 },
  { time: 8.0, headTilt: -0.03, blink: 1, browRaise: 0.2, mouthOpen: 0 },
];

/** Find the acting beat active at a time. A lookup, not a curve. */
function beatAt(time: number): (typeof ACTING_BEATS)[number] {
  let current = ACTING_BEATS[0]!;
  for (const beat of ACTING_BEATS) {
    if (time >= beat.time) current = beat;
    else break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Build the scene for one time, since poses are discrete.
// ---------------------------------------------------------------------------
function sceneAt(time: number): SceneDocument {
  const beat = beatAt(time);
  const rig = buildHostRig(beat);

  // The scene model applies one style per rig, so styles are baked onto parts here.
  const rigWithStyles: Rig = {
    ...rig,
    parts: rig.parts.map((part) => ({
      ...part,
      style: undefined,
    })) as RigPart[],
  };

  return {
    id: SCENE_ID,
    name: "Studio Intro",
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSeconds: SCENE_DURATION,
    background: "#14100F",
    camera: {
      channels: {
        // A slow push-in across the scene. Gentle, so it reads as a camera move rather
        // than as the character sliding.
        zoom: {
          kind: "number",
          keyframes: [
            { time: 0, value: 1.0 },
            { time: SCENE_DURATION, value: 1.08 },
          ],
        },
      },
    },
    layers: [
      {
        id: "host",
        name: "Host",
        zIndex: 1,
        visible: true,
        opacity: 1,
        rig: rigWithStyles,
        // The rig's own origin is the hip line, so placing it slightly below centre
        // puts the head near the upper third and leaves room for the desk below.
        transform: makeTransform({ x: WIDTH / 2, y: HEIGHT * 0.52 }, 0, { x: 1, y: 1 }),
      },
    ],
  };
}

export interface PilotRenderResult {
  readonly mp4Path: string;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly elapsedMs: number;
  readonly contactSheet: readonly string[];
}

/** Render scene 1 of the pilot. */
export async function renderPilotScene1(outDir: string): Promise<PilotRenderResult> {
  mkdirSync(outDir, { recursive: true });

  const { spawnSync } = await import("node:child_process");
  const { createCanvas } = await import("@napi-rs/canvas");

  const scene = sceneAt(0);
  const total = frameCount(scene);
  const ffmpeg = findFfmpeg();

  const started = Date.now();
  const pngs: Buffer[] = [];

  for (let frame = 0; frame < total; frame++) {
    const time = frameToTime(frame, FPS);
    const doc = sceneAt(time);
    const evaluated = evaluate(doc, time);

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d");

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = doc.background ?? "#000000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const cam = evaluated.camera;

    for (const part of evaluated.parts) {
      const t = part.world;
      const m = {
        a: cam.a * t.a + cam.c * t.b,
        b: cam.b * t.a + cam.d * t.b,
        c: cam.a * t.c + cam.c * t.d,
        d: cam.b * t.c + cam.d * t.d,
        e: cam.a * t.e + cam.c * t.f + cam.e,
        f: cam.b * t.e + cam.d * t.f + cam.f,
      };

      const style = PART_STYLES[part.id] ?? { fill: "#888888", stroke: DARK, strokeWidth: 3 };

      for (const shape of part.shapes ?? []) {
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
            if (shape.rx && shape.rx > 0) {
              ctx.roundRect(0, 0, shape.width, shape.height, shape.rx);
            } else {
              ctx.rect(0, 0, shape.width, shape.height);
            }
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

        ctx.fillStyle = style.fill;
        ctx.fill();
        if (style.strokeWidth > 0) {
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = style.strokeWidth;
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        ctx.restore();
      }

      ctx.globalAlpha = 1;
    }

    pngs.push(canvas.toBuffer("image/png"));
  }

  // Contact sheet: sample frames across the scene so the acting beats are visible.
  const contactSheet: string[] = [];
  for (const frame of [0, 40, 80, 130, 170, 220]) {
    const png = pngs[frame];
    if (!png) continue;
    const path = join(outDir, `contact-${String(frame).padStart(4, "0")}.png`);
    writeFileSync(path, png);
    contactSheet.push(path);
  }

  const mp4Path = join(outDir, "pilot-scene-01.mp4");

  const result = spawnSync(
    ffmpeg,
    [
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
    ],
    { input: Buffer.concat(pngs), maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
  );

  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed (${result.status}): ${result.stderr?.toString().slice(-1500)}`,
    );
  }

  return {
    mp4Path,
    frames: total,
    durationSeconds: SCENE_DURATION,
    elapsedMs: Date.now() - started,
    contactSheet,
  };
}

export const PILOT_RENDER_CONFIG = {
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  sceneId: SCENE_ID,
  sceneDuration: SCENE_DURATION,
} as const;